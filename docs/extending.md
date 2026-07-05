# Extending model-router

Three extension points, all designed to fail open — a broken extension logs and degrades to stock behavior; it never breaks proxying.

## Plugins

A plugin hooks into the proxy layer. Every hook is optional.

```ts
import type { ProxyPlugin } from "@boredphilosopher96/model-router";

const plugin: ProxyPlugin = {
  name: "my-plugin",

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

**Ordering.** `onRequest`, `onRouteDecision`, and `onRecord` run in registration order; `onResponse` runs in reverse, so a plugin wraps the ones registered after it. A hook that throws is logged and skipped.

**Three ways to register:**

1. **Config file** — no code changes to the router:

   ```jsonc
   // router.config.json
   { "plugins": ["./plugins/my-telemetry.ts"] }
   ```

   The module's default export must be a `ProxyPlugin` or a zero-arg factory returning one. Template: `examples/plugins/my-telemetry.ts`.

2. **Library API**:

   ```ts
   import { startServer, loadConfig, PluginPipeline } from "@boredphilosopher96/model-router";
   await startServer(loadConfig(), new PluginPipeline().use(plugin));
   ```

3. **Bundled plugins** via env: `PLUGIN_LOGGER` (default on), `PLUGIN_TOON` (JSON→TOON prompt compression, default off).

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
import type { UpstreamAdapter } from "@boredphilosopher96/model-router";

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
} from "@boredphilosopher96/model-router";

const rs = await startServer(loadConfig(), new PluginPipeline());
// rs.server, rs.upstreams, rs.cache, rs.stats, rs.escalation, rs.stop()
```

All public types (`ModelSpec`, `UpstreamProvider`, `RouteDecision`, `RequestRecord`, `ProxyPlugin`, `UpstreamAdapter`, `RouterConfig`, …) are exported from the package root.
