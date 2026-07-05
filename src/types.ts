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
  /**
   * Fills baseUrl/dialect/auth/path defaults for well-known endpoints:
   * "anthropic" | "openai" | "github-copilot" | "github-models" | "openrouter".
   * Any field you set explicitly wins over the preset.
   */
  preset?: string;
  baseUrl?: string;
  /** Which wire format(s) this endpoint accepts. */
  dialect?: Dialect | "both";
  /**
   * This endpoint serves multiple vendors in one dialect (GitHub, OpenRouter…):
   * allow the router to swap vendors (Claude <-> GPT) within it. Same dialect
   * only — never format translation. Default false.
   */
  crossProvider?: boolean;
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
  /** Price of cache-read input tokens. Default: 10% of inputPer1M. */
  cachedInputPer1M?: number;
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
  /** Task classification from the routing strategy (e.g. "codegen", "lookup"). */
  taskType: string;
  /** True when the pick stayed on the conversation's previous model to keep its prompt cache warm. */
  sticky: boolean;
  /** Estimated cost of this request on the chosen (model, upstream), USD. */
  estCostUsd: number;
  reason: string;
}

/** Context handed to every plugin hook. */
export interface PluginContext {
  provider: Provider;
  path: string;
  /** Home upstream name (the /p/<mount> the request arrived on, or the dialect default). */
  mount: string;
  requestedModel: string;
  routedModel?: string;
  /** Task classification, available from onRouteDecision onwards. */
  taskType?: string;
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
  /** Lower runs earlier on requests (and later on responses). Default 100. */
  priority?: number;
  /**
   * Scope the plugin to a subset of traffic; hooks are skipped elsewhere.
   * All present conditions must match. Globs allowed in models/mounts.
   * This is what lets model-router plugins coexist with harness-level or
   * provider-specific plugins without touching each other's traffic.
   */
  match?: {
    mounts?: string[];
    dialects?: Dialect[];
    models?: string[];
  };
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
  /** Routing-evaluation fields. */
  taskType: string;
  complexity: number;
  requiredTier: number;
  escalationBoost: number;
  sticky: boolean;
  /** Conversation fingerprint — lets the evaluator link decisions to later escalations. */
  conversation: string;
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

/** Router-performance metrics for strategy tuning, served at /api/router-eval. */
export interface RouterEval {
  totalDecisions: number;
  /** Share of requests routed to a different model than requested. */
  downgradeRate: number;
  /** Share of requests kept on a pricier model because its prompt cache was warm. */
  stickyRate: number;
  /** Share of requests that carried an escalation boost. */
  escalationRate: number;
  /**
   * Share of downgraded conversations that later needed escalation — the
   * router's misjudgment signal. High regret => routing too aggressively.
   */
  regretRate: number;
  byTaskType: Array<{
    taskType: string;
    requests: number;
    avgComplexity: number;
    avgRequiredTier: number;
    downgraded: number;
    savedUsd: number;
    avgLatencyMs: number;
  }>;
  tierDistribution: Array<{ requiredTier: number; requests: number }>;
}

/** Persistent request log + aggregations. Implemented in src/stats.ts (bun:sqlite). */
export interface StatsStore {
  record(rec: RequestRecord): void;
  summary(): StatsSummary;
  routerEval(): RouterEval;
}

export interface RouterConfig {
  port: number;
  /**
   * aggressive: always route to the cheapest model meeting the required tier.
   * balanced: route down at most one tier below the requested model.
   * quality: like balanced, but refuses to downgrade at all when classifier
   *          confidence is low — bias toward the requested model.
   * off: never change the model (proxy/cache/stats still apply).
   */
  mode: "aggressive" | "balanced" | "quality" | "off";
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
  /**
   * Routing strategy: "heuristic" (default — multi-signal task classifier,
   * sub-millisecond) or "llm" (a tier-1 model classifies each new
   * conversation once; falls back to heuristic on error/timeout).
   */
  strategy?: "heuristic" | "llm";
  /**
   * User-defined task rules evaluated before built-in classification:
   * first match wins. Patterns are case-insensitive regexes tested against
   * the latest user message.
   */
  taskRules?: Array<{ pattern: string; tier: 1 | 2 | 3 | 4; taskType?: string }>;
}
