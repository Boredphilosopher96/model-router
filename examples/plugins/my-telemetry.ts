import type { ProxyPlugin } from "../../src/types.ts";

/**
 * Template plugin: load via router.config.json -> "plugins": ["./examples/plugins/my-telemetry.ts"].
 * Every hook is optional — hook whatever functionality you need into the proxy layer.
 */
export default function myTelemetry(): ProxyPlugin {
  return {
    name: "my-telemetry",
    onRouteDecision(decision) {
      // Inspect or override routing: return a modified decision to replace it,
      // or return nothing to keep it. e.g. force a model for a specific
      // tenant: return { ...decision, routedModel: "claude-opus-4-8" };
      void decision;
    },
    onRecord(record) {
      // Every completed request lands here: ship to your metrics pipeline.
      // e.g. statsd.gauge("llm.saved_usd", record.savedUsd)
    },
  };
}
