import { Database } from "bun:sqlite";
import type { RequestRecord, StatsSummary, StatsStore } from "./types.ts";

export function createStats(dbPath: string): StatsStore {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");

  // Initialize table
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      upstream TEXT NOT NULL DEFAULT '',
      requested_model TEXT NOT NULL,
      routed_model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_actual REAL NOT NULL,
      cost_baseline REAL NOT NULL,
      saved_usd REAL NOT NULL,
      cache_hit INTEGER NOT NULL,
      downgraded INTEGER NOT NULL,
      latency_ms REAL NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts)");

  // Prepare statements
  const recordStmt = db.prepare(`
    INSERT INTO requests (
      ts, provider, upstream, requested_model, routed_model, input_tokens, output_tokens,
      cost_actual, cost_baseline, saved_usd, cache_hit, downgraded, latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    record(rec: RequestRecord): void {
      recordStmt.run(
        rec.ts,
        rec.provider,
        rec.upstream,
        rec.requestedModel,
        rec.routedModel,
        rec.inputTokens,
        rec.outputTokens,
        rec.costActual,
        rec.costBaseline,
        rec.savedUsd,
        rec.cacheHit ? 1 : 0,
        rec.downgraded ? 1 : 0,
        rec.latencyMs
      );
    },

    summary(): StatsSummary {
      // Get aggregate totals
      const totalsResult = db.query(
        `
        SELECT
          COUNT(*) as totalRequests,
          SUM(CASE WHEN downgraded = 1 THEN 1 ELSE 0 END) as downgradedRequests,
          SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cacheHits,
          SUM(input_tokens) as totalInputTokens,
          SUM(output_tokens) as totalOutputTokens,
          SUM(cost_actual) as totalCostActualUsd,
          SUM(cost_baseline) as totalCostBaselineUsd,
          SUM(saved_usd) as totalSavedUsd
        FROM requests
        `
      ).all() as Array<{
        totalRequests: number;
        downgradedRequests: number | null;
        cacheHits: number | null;
        totalInputTokens: number | null;
        totalOutputTokens: number | null;
        totalCostActualUsd: number | null;
        totalCostBaselineUsd: number | null;
        totalSavedUsd: number | null;
      }>;

      const totals = totalsResult[0] ?? {
        totalRequests: 0,
        downgradedRequests: 0,
        cacheHits: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostActualUsd: 0,
        totalCostBaselineUsd: 0,
        totalSavedUsd: 0,
      };

      const totalRequests = totals.totalRequests;
      const downgradedRequests = totals.downgradedRequests ?? 0;
      const cacheHits = totals.cacheHits ?? 0;
      const cacheHitRate =
        totalRequests > 0 ? cacheHits / totalRequests : 0;
      const totalInputTokens = totals.totalInputTokens ?? 0;
      const totalOutputTokens = totals.totalOutputTokens ?? 0;
      const totalCostActualUsd = totals.totalCostActualUsd ?? 0;
      const totalCostBaselineUsd = totals.totalCostBaselineUsd ?? 0;
      const totalSavedUsd = totals.totalSavedUsd ?? 0;

      // Get byModel stats
      const byModelResult = db.query(
        `
        SELECT
          routed_model,
          COUNT(*) as requests,
          SUM(input_tokens) as inputTokens,
          SUM(output_tokens) as outputTokens,
          SUM(cost_actual) as costActualUsd,
          SUM(saved_usd) as savedUsd
        FROM requests
        GROUP BY routed_model
        ORDER BY savedUsd DESC
        `
      ).all() as Array<{
        routed_model: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        costActualUsd: number;
        savedUsd: number;
      }>;

      const byModel = byModelResult.map((row) => ({
        routedModel: row.routed_model,
        requests: row.requests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costActualUsd: row.costActualUsd,
        savedUsd: row.savedUsd,
      }));

      // Get byRoute stats (only downgraded)
      const byRouteResult = db.query(
        `
        SELECT
          requested_model,
          routed_model,
          COUNT(*) as requests,
          SUM(saved_usd) as savedUsd
        FROM requests
        WHERE downgraded = 1
        GROUP BY requested_model, routed_model
        ORDER BY savedUsd DESC
        `
      ).all() as Array<{
        requested_model: string;
        routed_model: string;
        requests: number;
        savedUsd: number;
      }>;

      const byRoute = byRouteResult.map((row) => ({
        requestedModel: row.requested_model,
        routedModel: row.routed_model,
        requests: row.requests,
        savedUsd: row.savedUsd,
      }));

      // Get timeline (last 24 hours, hourly buckets, only hours with data)
      const timelineResult = db.query(
        `
        SELECT
          strftime('%Y-%m-%dT%H:00:00Z', ts / 1000.0, 'unixepoch') as hourIso,
          COUNT(*) as requests,
          SUM(saved_usd) as savedUsd,
          SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cacheHits
        FROM requests
        WHERE ts > (SELECT MAX(ts) - 86400000 FROM requests)
        GROUP BY hourIso
        ORDER BY hourIso ASC
        `
      ).all() as Array<{
        hourIso: string;
        requests: number;
        savedUsd: number;
        cacheHits: number;
      }>;

      const timeline = timelineResult.map((row) => ({
        hourIso: row.hourIso,
        requests: row.requests,
        savedUsd: row.savedUsd,
        cacheHits: row.cacheHits,
      }));

      return {
        totalRequests,
        downgradedRequests,
        cacheHits,
        cacheHitRate,
        totalInputTokens,
        totalOutputTokens,
        totalCostActualUsd,
        totalCostBaselineUsd,
        totalSavedUsd,
        byModel,
        byRoute,
        timeline,
      };
    },
  };
}
