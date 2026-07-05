# Extending model-router

Three extension points, all designed to fail open — a broken extension logs and degrades to stock behavior; it never breaks proxying.

## Plugins

A plugin hooks into the proxy layer. Every hook is optional.

```ts
import type { ProxyPlugin } from "@curliness8029/model-router";

const plugin: ProxyPlugin = {
  name: "my-plugin",
  priority: 50,                          // optional; lower runs earlier (default 100)

  // Transform the incoming request body before routing.
  onRequest(body, ctx) {
    return body;
  },

  // Inspect or override the routing decision. Return a decision to replace
  // it, or nothing to keep it. ctx.state carries data to later hooks.
  onRouteDecision(decision, body, ctx) {
    if (ctx.requestedModel === "claude-fable-5" && isOverBudget(ctx)) {
      return { ...decision, routedModel: "claude-opus-4-8", reason: "budget cap" };
    }
  },

  // Transform the (non-streaming) response body before it returns.
  onResponse(body, ctx) {
    return body;
  },

  // Observe every completed request before it is persisted to stats.
  onRecord(record, ctx) {
    metrics.gauge("llm.saved_usd", record.savedUsd);
  },
};
```

**Plugin context.** `ctx` includes `mount` (the upstream name) and `taskType` (from the routing strategy) in addition to the request/decision data.

**Ordering and priority.** By default, plugins run in registration order. The `priority` field allows fine-grained control: lower numbers run earlier (default `100`). `onRequest`, `onRouteDecision`, and `onRecord` run in priority order; `onResponse` runs in reverse (so a plugin wraps the ones registered after it). A hook that throws is logged and skipped.

**Match scoping.** Restrict a plugin to specific traffic with the `match` field:

```ts
{
  name: "mygateway-telemetry",
  priority: 50,
  match: {
    mounts: ["mygateway"],             // only this upstream
    dialects: ["anthropic"],           // only Anthropic-dialect requests
    models: ["claude-*"]               // glob: only these models
  },
  onRecord(record, ctx) {
    mygateway.recordMetrics(record);
  }
}
```

This pattern lets model-router plugins coexist with harness-level plugins and provider-specific plugins without touching each other's traffic. Matchers default to matching everything (unset = unrestricted); all specified filters must pass.

**Composing plugins.** Merge multiple plugins into one with stable priority and scoping:

```ts
import { composePlugins } from "@curliness8029/model-router";

const merged = composePlugins("telemetry-suite", [
  budgetEnforcer,
  costTracker,
  alerting
], {
  priority: 40,
  match: { mounts: ["mygateway"] }
});
```

All hooks from composed plugins run in the order registered, wrapped by the match filter. Useful for grouping related plugins and ensuring they apply only to specific traffic.

**Three ways to register:**

1. **Config file** — no code changes to the router:

   ```jsonc
   // router.config.json
   { "plugins": ["./plugins/my-telemetry.ts"] }
   ```

   The module's default export must be a `ProxyPlugin`, array of plugins, or zero-arg factory returning one. Template: `examples/plugins/my-telemetry.ts`.

2. **Library API**:

   ```ts
   import { startServer, loadConfig, PluginPipeline } from "@curliness8029/model-router";
   await startServer(loadConfig(), new PluginPipeline().use(plugin));
   ```

3. **Bundled plugins** via env: `PLUGIN_LOGGER` (default on), `PLUGIN_TOON` (JSON→TOON prompt compression, default off), `PLUGIN_PRUNE` (context pruning, default off).

**Use cases that map cleanly onto hooks:** per-tenant model pinning and budget caps (`onRouteDecision`), prompt compression and secret redaction (`onRequest`), response post-processing (`onResponse`), metrics/alerting/chargeback export (`onRecord`).

## Upstream adapters

When one gateway serves a *different model shape* — nonstandard request fields, a response envelope that deviates from the standard dialects, usage reported somewhere unusual — attach an adapter to that upstream instead of forking the proxy:

```jsonc
// router.config.json
{ "name": "mygateway", "baseUrl": "https://llm.internal", "dialect": "both",
  "adapter": "./adapters/mygateway.ts" }
```

```ts
// adapters/mygateway.ts
import type { UpstreamAdapter } from "@curliness8029/model-router";

const adapter: UpstreamAdapter = {
  // Reshape the outgoing body (the router has already swapped the model).
  transformRequest(body, upstream) {
    return { ...body, gw_flavor: true };
  },
  // Reshape the gateway's response back into the standard dialect.
  transformResponse(body, upstream) {
    if (body?.result?.tokens && !body.usage) {
      body.usage = { input_tokens: body.result.tokens.in, output_tokens: body.result.tokens.out };
    }
    return body;
  },
  // Feed the dashboard when the usage shape differs.
  extractUsage(json) {
    const t = json?.result?.tokens;
    return t ? { inputTokens: t.in ?? 0, outputTokens: t.out ?? 0 } : undefined;
  },
};
export default adapter;
```

Only the hooks you define run; every other upstream stays stock. Template: `examples/adapters/mygateway.ts`.

## Bundled plugins

### Context pruning plugin (prunePlugin)

When enabled via `PLUGIN_PRUNE=true` or by calling `prunePlugin()` in config/library, the context pruning plugin truncates oversized `tool_result` blocks in old turns of very long conversations (history > 30k tokens). This reduces token overhead and latency for deeply agentic workflows while preserving the most recent turns.

**Options:**

| Option | Default | Description |
|---|---|---|
| `minHistoryTokens` | `30000` | Minimum conversation history tokens to trigger pruning. |
| `keepRecentTurns` | `8` | Number of most recent turns (user + assistant pairs) to preserve; never pruned. |
| `maxToolResultChars` | `1500` | Maximum character length for a `tool_result` block before truncation. Longer blocks in old turns are truncated to this length. |
| `mode` | `"whenCold"` | Pruning strategy: `"whenCold"` (default) only prunes when the conversation has no warm provider cache to lose — with a warm cache, history bills at ~10% and pruning would force a full cold re-read that usually costs more. `"always"` overrides, pruning regardless. |

**How it works:**

The plugin reads `ctx.state["model-router:lastRoute"]` — the (model, upstream) whose provider prompt cache is warm for this conversation, injected by the proxy before plugins run. When `mode: "whenCold"`, pruning happens only when that state is empty (no warm cache exists — a fresh conversation, or one whose cache was already lost). With a warm cache, history bills at ~10% of the input rate, and editing any turn would invalidate the cached prefix and force a full-price re-read — usually costing more than the pruning saves.

Enable via environment:
```sh
PLUGIN_PRUNE=true
```

Or via config with options:
```jsonc
{
  "plugins": [
    {
      "name": "context-pruner",
      "module": "@curliness8029/model-router/plugins/prune",
      "options": {
        "minHistoryTokens": 30000,
        "keepRecentTurns": 8,
        "maxToolResultChars": 1500,
        "mode": "whenCold"
      }
    }
  ]
}
```

Or via library API:
```ts
import { prunePlugin } from "@curliness8029/model-router";
pipeline.use(prunePlugin({ mode: "always" }));
```

## Custom models and pricing

- **Known model on a custom gateway** — nothing to do; catalog API pricing is assumed.
- **Unknown model** — add a `pricing` entry on the upstream (see `docs/configuration.md`); it registers the model and pins its price.
- **Override anything** — drop a `models.json` next to the process (array of `ModelSpec`) or call `registerModel()`; manual entries win over the feed.

## Library API

Everything the CLI does is importable:

```ts
import {
  startServer, loadConfig,             // proxy lifecycle
  PluginPipeline,                      // plugin registration
  route, estimateComplexity,           // routing primitives
  registerModel, listModels, setModelAllowlist,  // catalog
  Upstreams, loadRouterSetup,          // upstream pool
  EscalationTracker, conversationKey,  // escalation
  startPriceAutoUpdate,                // price feed
} from "@curliness8029/model-router";

const rs = await startServer(loadConfig(), new PluginPipeline());
// rs.server, rs.upstreams, rs.cache, rs.stats, rs.escalation, rs.stop()
```

All public types (`ModelSpec`, `UpstreamProvider`, `RouteDecision`, `RequestRecord`, `ProxyPlugin`, `UpstreamAdapter`, `RouterConfig`, …) are exported from the package root.
