import type { UpstreamAdapter } from "../../src/types.ts";

/**
 * Template adapter: attach to an upstream whose JSON shape deviates from the
 * standard dialects (router.config.json -> "adapter": "./examples/adapters/mygateway.ts").
 * Only the hooks you define run; everything else stays stock.
 */
const adapter: UpstreamAdapter = {
  // Reshape the outgoing body (model already swapped by the router).
  transformRequest(body) {
    return body;
  },
  // Reshape the gateway's response back into the standard dialect.
  transformResponse(body) {
    // Example: normalize a gateway that reports usage as result.tokens.{in,out}
    if (body?.result?.tokens && !body.usage) {
      body.usage = { input_tokens: body.result.tokens.in, output_tokens: body.result.tokens.out };
    }
    return body;
  },
  // Custom token-usage extraction when the shape differs (feeds the dashboard).
  extractUsage(json) {
    const t = json?.result?.tokens;
    return t ? { inputTokens: t.in ?? 0, outputTokens: t.out ?? 0 } : undefined;
  },
};

export default adapter;
