export type Provider = "anthropic" | "openai";

/** The wire format a request/upstream speaks. Same as Provider, plus "both". */
export type Dialect = "anthropic" | "openai";

/**
 * One configured upstream endpoint (direct API, gateway, subscription
 * service, or private backend). Declared in router.config.json.
 */
export interface UpstreamProvider {
  /** Unique name; also the mount path /p/<name>/v1/... */
  name: string;
  baseUrl: string;
  /** Which wire format(s) this endpoint accepts. */
  dialect: Dialect | "both";
  /**
   * Globs of model ids this upstream can serve (matched against normalized
   * catalog ids), e.g. ["claude-*"] or ["claude-*", "gpt-*"].
   * Default: the vendor models matching its dialect.
   */
  models?: string[];
  /** Env var holding this upstream's API key. */
  apiKeyEnv?: string;
  /** Extra static headers (e.g. gateway tokens, OpenRouter attribution). */
  headers?: Record<string, string>;
  /**
   * How to send credentials: "passthrough" forwards the caller's own auth
   * headers (only valid when this upstream is the request's home),
   * "bearer"/"x-api-key" use apiKeyEnv, "none" sends nothing.
   * Default: passthrough, falling back to apiKeyEnv when the caller sent none.
   */
  authStyle?: "passthrough" | "bearer" | "x-api-key" | "none";
  /**
   * Manual override multiplier on catalog prices. Normally unnecessary:
   * known gateway hosts (GitHub Copilot, …) are priced automatically from
   * the feed, unknown gateways assume catalog API pricing, and `pricing`
   * covers models the catalog doesn't know. 0 = flat-rate/free.
   */
  priceMultiplier?: number;
  /**
   * Pricing (and registration) for models this upstream serves that the
   * catalog doesn't know — e.g. a private fine-tune on a custom gateway.
   * Keyed by model id.
   */
  pricing?: Record<string, CustomModelPricing>;
  /** Module path of an UpstreamAdapter for gateways with deviant JSON shapes. */
  adapter?: string;
  /** Endpoint has no /v1 path segment (GitHub Copilot / GitHub Models style). */
  stripV1?: boolean;
  /** Model ids must be sent vendor-prefixed ("anthropic/claude-…", OpenRouter style). */
  vendorPrefix?: boolean;
  /** Marks the default upstream for its dialect on the un-mounted /v1/* paths. */
  default?: boolean;
  enabled?: boolean;
}

/** A model the router can route to. Pricing is USD per 1M tokens. */
export interface ModelSpec {
  id: string;
  provider: Provider;
  inputPer1M: number;
  outputPer1M: number;
  /** Capability tier: 1 = smallest/cheapest … 4 = frontier. */
  tier: 1 | 2 | 3 | 4;
  contextWindow: number;
  enabled: boolean;
  /** Accepts image/document input. undefined = assume yes (fail open). */
  vision?: boolean;
  /** Supports tool/function calling. undefined = assume yes (fail open). */
  toolUse?: boolean;
}

/** Per-upstream pricing for a model the catalog doesn't know (custom gateways). */
export interface CustomModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  tier?: 1 | 2 | 3 | 4;
  contextWindow?: number;
  vision?: boolean;
  toolUse?: boolean;
}

/**
 * Escape hatch for gateways whose request/response JSON deviates from the
 * standard dialects. Loaded from the module path in UpstreamProvider.adapter;
 * the module's default export must satisfy this interface (or be a factory
 * returning it). Only the hooks you define run — everything else is stock.
 */
export interface UpstreamAdapter {
  /** Reshape the outgoing body (model already swapped) for this gateway. */
  transformRequest?(body: any, upstream: UpstreamProvider): any | Promise<any>;
  /** Reshape the gateway's response back into the standard dialect. */
  transformResponse?(body: any, upstream: UpstreamProvider): any | Promise<any>;
  /** Custom token-usage extraction when the gateway's usage shape differs. */
  extractUsage?(json: any): { inputTokens: number; outputTokens: number } | undefined;
}

/** What the router decided for a single request. */
export interface RouteDecision {
  requestedModel: string;
  routedModel: string;
  /** Name of the upstream the request is sent to. */
  upstream: string;
  provider: Provider;
  /** Estimated request complexity in [0, 1]. */
  complexity: number;
  /** Minimum tier the request was judged to need. */
  requiredTier: number;
  /** Extra tiers applied because this conversation was struggling. */
  escalationBoost: number;
  /** True when the caller selected the "auto" model. */
  auto: boolean;
  reason: string;
}

/** Context handed to every plugin hook. */
export interface PluginContext {
  provider: Provider;
  path: string;
  requestedModel: string;
  routedModel?: string;
  /** Scratch space plugins can use to pass data from onRequest to onResponse. */
  state: Record<string, unknown>;
}

/**
 * A proxy plugin. Every hook is optional — implement only what you need.
 * Body hooks run in registration order on the request and reverse order on
 * the response; return the (possibly transformed) value, or the input to
 * no-op. Plugins can also be loaded from module paths listed in
 * router.config.json ("plugins": ["./my-plugin.ts"]) — the default export
 * must be a ProxyPlugin or a zero-arg factory returning one.
 */
export interface ProxyPlugin {
  name: string;
  /** Transform the incoming request body before routing. */
  onRequest?(body: any, ctx: PluginContext): any | Promise<any>;
  /** Inspect or override the routing decision (return a decision to replace it). */
  onRouteDecision?(decision: RouteDecision, body: any, ctx: PluginContext): RouteDecision | void | Promise<RouteDecision | void>;
  /** Transform the (non-streaming) response body before it returns. */
  onResponse?(body: any, ctx: PluginContext): any | Promise<any>;
  /** Observe/enrich the stats record before it is persisted (telemetry, budgets…). */
  onRecord?(record: RequestRecord, ctx: PluginContext): void | Promise<void>;
}

/** One completed request, as recorded for the dashboard. */
export interface RequestRecord {
  ts: number;
  provider: Provider;
  /** Upstream that served the request. */
  upstream: string;
  requestedModel: string;
  routedModel: string;
  inputTokens: number;
  outputTokens: number;
  /** What the request actually cost, USD. 0 on cache hit. */
  costActual: number;
  /** What it would have cost on the requested model, USD. */
  costBaseline: number;
  savedUsd: number;
  cacheHit: boolean;
  downgraded: boolean;
  latencyMs: number;
}

/** Aggregate stats served to the dashboard at /api/stats. */
export interface StatsSummary {
  totalRequests: number;
  downgradedRequests: number;
  cacheHits: number;
  cacheHitRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostActualUsd: number;
  totalCostBaselineUsd: number;
  totalSavedUsd: number;
  byModel: Array<{
    routedModel: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costActualUsd: number;
    savedUsd: number;
  }>;
  byRoute: Array<{
    requestedModel: string;
    routedModel: string;
    requests: number;
    savedUsd: number;
  }>;
  /** Hourly buckets, oldest first, for the last 24h. */
  timeline: Array<{
    hourIso: string;
    requests: number;
    savedUsd: number;
    cacheHits: number;
  }>;
}

/** Persistent response cache. Implemented in src/cache.ts (bun:sqlite). */
export interface ResponseCache {
  get(key: string): { body: string; model: string } | null;
  set(key: string, body: string, model: string): void;
  /** Remove expired entries; returns number removed. */
  prune(): number;
  size(): number;
}

/** Persistent request log + aggregations. Implemented in src/stats.ts (bun:sqlite). */
export interface StatsStore {
  record(rec: RequestRecord): void;
  summary(): StatsSummary;
}

export interface RouterConfig {
  port: number;
  /**
   * aggressive: always route to the cheapest model meeting the required tier.
   * balanced: route down at most one tier below the requested model.
   * off: never change the model (proxy/cache/stats still apply).
   */
  mode: "aggressive" | "balanced" | "off";
  cacheTtlMs: number;
  cacheEnabled: boolean;
  dbPath: string;
  /** Path to router.config.json declaring upstream providers. */
  upstreamsConfigPath?: string;
  /** Upstream declarations (merged over/instead of the config file). */
  upstreams?: UpstreamProvider[];
  /**
   * Globs restricting which catalog models the router may route TO
   * (e.g. ["claude-haiku-*", "claude-sonnet-*", "gpt-5.4-*"]).
   * Requests for other models still pass through; they just won't be
   * chosen as routing targets. Default: all enabled models.
   */
  allowedModels?: string[];
  /** Plugin module paths to load (in addition to router.config.json's "plugins"). */
  plugins?: string[];
  /**
   * Allow cross-vendor switches on the OpenAI dialect (gateways serve every
   * vendor in that format). Default false.
   */
  crossProvider?: boolean;
  /** Per-conversation stuck-detection and tier bumping. Default true. */
  escalationEnabled?: boolean;
}
