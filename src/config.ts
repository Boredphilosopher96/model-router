import type { RouterConfig } from "./types.ts";

export function loadConfig(env: Record<string, string | undefined> = Bun.env): RouterConfig {
  const mode = env.ROUTER_MODE ?? "aggressive";
  if (mode !== "aggressive" && mode !== "balanced" && mode !== "off") {
    throw new Error(`ROUTER_MODE must be aggressive|balanced|off, got: ${mode}`);
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
  };
}
