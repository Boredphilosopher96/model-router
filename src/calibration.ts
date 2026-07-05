import { Database } from "bun:sqlite";

/**
 * Quality calibration: the router's misjudgments should be measured, not
 * guessed. A small sample of downgraded, non-streaming responses is stored;
 * a frontier model periodically grades whether the cheap model's answer was
 * adequate for the request; per-task adequacy rates below threshold produce
 * a +1 tier recommendation for that task type — advisory by default, applied
 * automatically only when configured. RouteLLM-style offline tuning, cheap.
 */

export interface CalibrationOptions {
  sampleRate: number;
  gradeIntervalMs: number;
  apply: boolean;
  /** Adequacy below this (with >= minSamples graded) recommends a tier bump. */
  adequacyThreshold: number;
  minSamples: number;
  /** Grade this many pending samples per pass. */
  batchSize: number;
}

export const DEFAULT_CALIBRATION: CalibrationOptions = {
  sampleRate: 0.05,
  gradeIntervalMs: 6 * 60 * 60 * 1000,
  apply: false,
  adequacyThreshold: 0.8,
  minSamples: 5,
  batchSize: 10,
};

export interface CalibrationRecommendation {
  taskType: string;
  graded: number;
  adequate: number;
  adequacyRate: number;
  recommendTierBump: boolean;
  applied: boolean;
}

export class Calibrator {
  private db: Database;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    dbPath: string,
    private grader: (prompt: string) => Promise<string>,
    private options: CalibrationOptions = DEFAULT_CALIBRATION,
  ) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calibration_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        required_tier INTEGER NOT NULL,
        routed_model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        grade INTEGER -- NULL = pending, 1 = adequate, 0 = inadequate
      )
    `);
    if (options.gradeIntervalMs > 0) {
      this.timer = setInterval(() => void this.gradePending(), options.gradeIntervalMs);
      if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    }
  }

  /** Sample a downgraded response for later grading (probability = sampleRate). */
  maybeSample(input: { taskType: string; requiredTier: number; routedModel: string; prompt: string; response: string }): void {
    if (Math.random() >= this.options.sampleRate) return;
    if (!input.prompt.trim() || !input.response.trim()) return;
    try {
      this.db
        .prepare(
          `INSERT INTO calibration_samples (ts, task_type, required_tier, routed_model, prompt, response, grade)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(Date.now(), input.taskType, input.requiredTier, input.routedModel, input.prompt.slice(0, 2000), input.response.slice(0, 2000));
    } catch (err) {
      console.error("[calibration] sample failed:", err);
    }
  }

  /** Grade pending samples with the frontier model. Returns number graded. */
  async gradePending(limit = this.options.batchSize): Promise<number> {
    const pending = this.db
      .prepare(`SELECT id, prompt, response FROM calibration_samples WHERE grade IS NULL ORDER BY id LIMIT ?`)
      .all(limit) as Array<{ id: number; prompt: string; response: string }>;
    let graded = 0;
    for (const sample of pending) {
      try {
        const raw = await this.grader(
          `A cost-saving router sent this request to a cheaper model. Grade the response.\n` +
            `Was the response ADEQUATE for the request (correct, complete enough, usable)?\n` +
            `Respond with ONLY JSON: {"adequate": true|false}\n\n` +
            `REQUEST:\n${sample.prompt}\n\nRESPONSE:\n${sample.response}`,
        );
        const parsed = JSON.parse(raw.match(/\{[^}]*\}/)?.[0] ?? "{}");
        if (typeof parsed.adequate !== "boolean") continue;
        this.db.prepare(`UPDATE calibration_samples SET grade = ? WHERE id = ?`).run(parsed.adequate ? 1 : 0, sample.id);
        graded++;
      } catch (err) {
        console.error(`[calibration] grading sample ${sample.id} failed:`, err);
        break; // grader unavailable — try again next pass
      }
    }
    if (graded > 0) console.log(`[calibration] graded ${graded} samples`);
    return graded;
  }

  recommendations(): CalibrationRecommendation[] {
    const rows = this.db
      .prepare(
        `SELECT task_type AS taskType, COUNT(*) AS graded, SUM(grade) AS adequate
         FROM calibration_samples WHERE grade IS NOT NULL GROUP BY task_type`,
      )
      .all() as Array<{ taskType: string; graded: number; adequate: number | null }>;
    return rows.map((r) => {
      const adequacyRate = r.graded > 0 ? (r.adequate ?? 0) / r.graded : 1;
      const recommendTierBump = r.graded >= this.options.minSamples && adequacyRate < this.options.adequacyThreshold;
      return {
        taskType: r.taskType,
        graded: r.graded,
        adequate: r.adequate ?? 0,
        adequacyRate,
        recommendTierBump,
        applied: recommendTierBump && this.options.apply,
      };
    });
  }

  /** Tier correction the strategy should apply for this task type (0 or 1). */
  tierBoost(taskType: string): number {
    if (!this.options.apply) return 0;
    const rec = this.recommendations().find((r) => r.taskType === taskType);
    return rec?.recommendTierBump ? 1 : 0;
  }

  snapshot(): { pending: number; recommendations: CalibrationRecommendation[]; apply: boolean; sampleRate: number } {
    const pending = (this.db.prepare(`SELECT COUNT(*) AS n FROM calibration_samples WHERE grade IS NULL`).get() as { n: number }).n;
    return { pending, recommendations: this.recommendations(), apply: this.options.apply, sampleRate: this.options.sampleRate };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
