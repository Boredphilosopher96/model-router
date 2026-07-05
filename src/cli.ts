#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";

const arg = Bun.argv[2];
if (arg === "setup") {
  const { runSetup } = await import("./setup.ts");
  process.exit(await runSetup(Bun.argv.slice(3)));
}
if (arg === "--version" || arg === "-v") {
  console.log(pkg.version);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  console.log(`model-router ${pkg.version} — harness-blind LLM cost router

Usage:
  model-router                 start the proxy (config via env + router.config.json)
  model-router setup <harness> print/apply harness config (claude-code, codex, opencode, copilot, pi)
  model-router --version       print version
  model-router --help          this help

Key environment variables:
  PORT=4141                    listen port
  ROUTER_MODE=aggressive       aggressive | balanced | off
  ROUTER_CONFIG=router.config.json   upstream/plugin/allowlist declarations
  ROUTER_ALLOWED_MODELS=       comma-separated globs restricting routing targets
  ESCALATION=true              stuck-conversation tier bumping
  CACHE_ENABLED=true           response cache (CACHE_TTL_MS=3600000)
  DB_PATH=model-router.sqlite  cache + stats storage
  PRICE_AUTOUPDATE=true        daily model/price refresh from the live feed
  ANTHROPIC_API_KEY / OPENAI_API_KEY   fallback upstream credentials

Docs: README.md and docs/ in the package, or the repository.`);
  process.exit(0);
}
import { loadRegistry } from "./registry.ts";
import { startServer } from "./server.ts";
import { PluginPipeline } from "./plugins/index.ts";
import { loggerPlugin } from "./plugins/logger.ts";
import { toonPlugin } from "./plugins/toon.ts";
import { startPriceAutoUpdate } from "./pricefeed.ts";

const config = loadConfig();
await loadRegistry(Bun.env.MODELS_JSON ?? "models.json");

// Self-updating prices/models. Disable with PRICE_AUTOUPDATE=false.
const priceUpdater =
  Bun.env.PRICE_AUTOUPDATE !== "false" ? startPriceAutoUpdate() : { stop() {}, refresh: async () => null };

const plugins = new PluginPipeline();
if (Bun.env.PLUGIN_LOGGER !== "false") plugins.use(loggerPlugin());
if (Bun.env.PLUGIN_TOON === "true") plugins.use(toonPlugin());
if (Bun.env.PLUGIN_PRUNE === "true") {
  const { prunePlugin } = await import("./plugins/prune.ts");
  plugins.use(prunePlugin());
}

const rs = await startServer(config, plugins);

console.log(`model-router listening on http://localhost:${rs.server.port}`);
console.log(`  mode=${config.mode} cache=${config.cacheEnabled ? `${config.cacheTtlMs}ms TTL` : "off"}`);
console.log(`  upstreams  -> ${rs.upstreams.list().map((u) => `${u.name} (${u.dialect})`).join(", ")}`);
console.log(`  endpoints  -> /v1/messages | /v1/chat/completions | /v1/responses  (also under /p/<upstream>/...)`);
console.log(`  dashboard  -> http://localhost:${rs.server.port}/dashboard`);

function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down…`);
  priceUpdater.stop();
  rs.stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
