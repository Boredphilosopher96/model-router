import type { BudgetConfig, RouterConfig, StatsStore } from "./types.ts";

/**
 * Spend budgets: as a window's budget depletes, routing tightens toward
 * `aggressive` — the proxy never blocks traffic, it just gets stingier.
 *
 *   usage < 70%   -> configured mode unchanged
 *   70% – 90%     -> one notch stricter (quality -> balanced -> aggressive)
 *   >= 90%        -> aggressive
 *
 * The binding constraint is whichever configured window (daily, monthly,
 * per-mount daily) has the highest usage fraction.
 */

type Mode = RouterConfig["mode"];

const STRICTER: Record<Mode, Mode> = {
  quality: "balanced",
  balanced: "aggressive",
  aggressive: "aggressive",
  off: "off", // off is an explicit operator choice; budgets don't override it
};

function startOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export class BudgetGuard {
  private cache = new Map<string, { at: number; value: number }>();

  constructor(
    private stats: Pick<StatsStore, "spendSince">,
    private config: BudgetConfig,
    private cacheTtlMs = 15_000,
  ) {}

  /** Drop cached spend numbers (tests; or after bulk imports). */
  flushCache(): void {
    this.cache.clear();
  }

  get enabled(): boolean {
    return (
      this.config.dailyUsd != null ||
      this.config.monthlyUsd != null ||
      Object.keys(this.config.perMountDailyUsd ?? {}).length > 0
    );
  }

  private spend(since: number, mount?: string): number {
    const key = `${since}:${mount ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.value;
    let value = 0;
    try {
      value = this.stats.spendSince(since, mount);
    } catch {
      // budget must never break proxying
    }
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 64) this.cache.clear();
    return value;
  }

  /** Highest usage fraction across all configured windows for this mount. */
  usage(mount: string): { fraction: number; binding: string } {
    if (!this.enabled) return { fraction: 0, binding: "none" };
    const now = new Date();
    const windows: Array<{ name: string; limit: number | undefined; since: number; mount?: string }> = [
      { name: "daily", limit: this.config.dailyUsd, since: startOfDay(now) },
      { name: "monthly", limit: this.config.monthlyUsd, since: startOfMonth(now) },
      { name: `mount:${mount}`, limit: this.config.perMountDailyUsd?.[mount], since: startOfDay(now), mount },
    ];
    let fraction = 0;
    let binding = "none";
    for (const w of windows) {
      if (w.limit == null || w.limit <= 0) continue;
      const f = this.spend(w.since, w.mount) / w.limit;
      if (f > fraction) {
        fraction = f;
        binding = w.name;
      }
    }
    return { fraction, binding };
  }

  /** The mode routing should actually use right now for this mount. */
  effectiveMode(baseMode: Mode, mount: string): { mode: Mode; usage: number; binding: string } {
    const { fraction, binding } = this.usage(mount);
    let mode = baseMode;
    if (fraction >= 0.9) mode = baseMode === "off" ? "off" : "aggressive";
    else if (fraction >= 0.7) mode = STRICTER[baseMode];
    return { mode, usage: fraction, binding };
  }

  snapshot(mounts: string[]): {
    enabled: boolean;
    dailyUsd?: number;
    dailySpentUsd?: number;
    monthlyUsd?: number;
    monthlySpentUsd?: number;
    perMount: Array<{ mount: string; limitUsd: number; spentUsd: number }>;
  } {
    const now = new Date();
    const out: ReturnType<BudgetGuard["snapshot"]> = { enabled: this.enabled, perMount: [] };
    if (this.config.dailyUsd != null) {
      out.dailyUsd = this.config.dailyUsd;
      out.dailySpentUsd = this.spend(startOfDay(now));
    }
    if (this.config.monthlyUsd != null) {
      out.monthlyUsd = this.config.monthlyUsd;
      out.monthlySpentUsd = this.spend(startOfMonth(now));
    }
    for (const [mount, limit] of Object.entries(this.config.perMountDailyUsd ?? {})) {
      out.perMount.push({ mount, limitUsd: limit, spentUsd: this.spend(startOfDay(now), mount) });
    }
    void mounts;
    return out;
  }
}
