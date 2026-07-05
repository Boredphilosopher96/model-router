import type { RouterConfig } from "./types.ts";

export function loadConfig(env: Record<string, string | undefined> = Bun.env): RouterConfig {
  const mode = env.ROUTER_MODE ?? "aggressive";
  if (mode !== "aggressive" && mode !== "balanced" && mode !== "quality" && mode !== "off") {
    throw new Error(`ROUTER_MODE must be aggressive|balanced|quality|off, got: ${mode}`);
  }
  return {
    port: Number(env.PORT ?? 4141),
    mode,
    cacheEnabled: env.CACHE_ENABLED !== "false",
    cacheTtlMs: Number(env.CACHE_TTL_MS ?? 60 * 60 * 1000),
    dbPath: env.DB_PATH ?? "model-router.sqlite",
    upstreamsConfigPath: env.ROUTER_CONFIG ?? "router.config.json",
    allowedModels: env.ROUTER_ALLOWED_MODELS?.split(",").map((s) => s.trim()).filter(Boolean),
    crossProvider: env.ROUTER_CROSS_PROVIDER === "true",
    escalationEnabled: env.ESCALATION !== "false",
    failover: env.FAILOVER !== "false",
    cacheNormalize: env.CACHE_NORMALIZE !== "false",
    strategy: env.ROUTER_STRATEGY === "llm" ? "llm" : "heuristic",
    shadow:
      env.SHADOW_MODE || env.SHADOW_STRATEGY
        ? {
            mode: (env.SHADOW_MODE as any) || undefined,
            strategy: env.SHADOW_STRATEGY === "llm" ? "llm" : env.SHADOW_STRATEGY === "heuristic" ? "heuristic" : undefined,
          }
        : undefined,
    budgets:
      env.BUDGET_DAILY_USD || env.BUDGET_MONTHLY_USD
        ? {
            dailyUsd: env.BUDGET_DAILY_USD ? Number(env.BUDGET_DAILY_USD) : undefined,
            monthlyUsd: env.BUDGET_MONTHLY_USD ? Number(env.BUDGET_MONTHLY_USD) : undefined,
          }
        : undefined,
    calibration:
      env.CALIBRATION === "true"
        ? {
            enabled: true,
            sampleRate: env.CALIBRATION_SAMPLE ? Number(env.CALIBRATION_SAMPLE) : undefined,
            apply: env.CALIBRATION_APPLY === "true",
          }
        : undefined,
  };
}
