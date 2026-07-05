import type { ModelSpec, Provider } from "./types.ts";
import { blendedPricePer1M, listModels, registerModel } from "./registry.ts";

/**
 * Self-updating pricing: pulls the community-maintained LiteLLM price feed
 * (model id -> per-token cost, context window, provider), keeps only the
 * newest generation of each model family, and writes the result into the
 * registry. Compiled-in defaults are never removed — the feed only adds
 * newer models and corrects prices, so the proxy still works offline.
 */

export const DEFAULT_FEED_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

interface FeedEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  max_input_tokens?: number;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
}

/**
 * Per-gateway model availability + pricing extracted from the feed, keyed by
 * gateway kind ("github_copilot", …) then normalized model id. `null` costs
 * mean the gateway serves the model at no per-token cost (subscription).
 */
const gatewayFeed = new Map<string, Map<string, { inputPer1M: number | null; outputPer1M: number | null }>>();

export function gatewayPricing(kind: string, normId: string): { inputPer1M: number | null; outputPer1M: number | null } | undefined {
  return gatewayFeed.get(kind)?.get(normId);
}

export function gatewayServes(kind: string, normId: string): boolean | undefined {
  const models = gatewayFeed.get(kind);
  if (!models) return undefined; // feed hasn't told us anything about this gateway
  for (const known of models.keys()) {
    if (normId === known || normId.startsWith(known) || known.startsWith(normId)) return true;
  }
  return false;
}

export interface PriceFeedOptions {
  feedUrl?: string;
  /** Where the last successful feed is cached on disk. */
  cachePath?: string;
  /** Refresh interval; 0 disables the timer. Default 24h. */
  refreshMs?: number;
  /** Disk cache younger than this is used instead of fetching at startup. */
  maxCacheAgeMs?: number;
}

/** id suffixes/infixes that mark dated snapshots or non-chat specializations. */
const EXCLUDE =
  /(\d{4}-\d{2}-\d{2})|(-\d{8}$)|(-latest)|(preview)|(audio)|(realtime)|(transcribe)|(tts)|(image)|(embed)|(moderation)|(search)|(-chat$)|(deep-research)|(computer-use)|(:|\/)/i;

/**
 * Legacy naming schemes, excluded outright. These prefixes are frozen — new
 * releases use current naming — so this list can't rot the way a model
 * allowlist would.
 */
const LEGACY: Record<Provider, RegExp> = {
  openai: /^(gpt-[1-4])|^(o\d)|^(chatgpt)|^(davinci)|^(babbage)|^(text-)/i,
  anthropic: /^claude-[1-3]([.-]|$)|^claude-instant/i,
};

/** Known family -> tier. Anything unknown falls back to price bands. */
const FAMILY_TIERS: Record<string, 1 | 2 | 3 | 4> = {
  "claude-haiku": 1,
  "claude-sonnet": 2,
  "claude-opus": 3,
  "claude-fable": 4,
  "claude-mythos": 4,
  "gpt-nano": 1,
  "gpt-mini": 2,
  gpt: 3,
};

function tierFor(family: string, spec: { inputPer1M: number; outputPer1M: number }): 1 | 2 | 3 | 4 {
  const known = FAMILY_TIERS[family];
  if (known) return known;
  const blended = blendedPricePer1M(spec as ModelSpec);
  if (blended < 0.9) return 1;
  if (blended < 3) return 2;
  if (blended < 12) return 3;
  return 4;
}

/**
 * Split a model id into (family, version): version digits are removed from the
 * id to form the family, so newer generations replace older ones.
 *   claude-opus-4-8  -> family "claude-opus",  version 4.8
 *   gpt-5.4-mini     -> family "gpt-mini",     version 5.4
 *   gpt-5.5          -> family "gpt",          version 5.5
 */
export function familyOf(id: string): { family: string; version: number } {
  const versionMatch = id.match(/\d+(?:[.-]\d+)*/);
  const version = versionMatch ? Number(versionMatch[0].replaceAll("-", ".").split(".").slice(0, 2).join(".")) : 0;
  const family = id
    .replace(/\d+(?:[.-]\d+)*/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return { family, version: Number.isFinite(version) ? version : 0 };
}

/**
 * Extract per-gateway availability/pricing (github_copilot etc.) from the
 * feed. Entries look like "github_copilot/claude-haiku-4.5" with absent
 * costs for subscription-priced gateways.
 */
export function parseGatewayFeed(feed: Record<string, FeedEntry>): typeof gatewayFeed {
  const out = new Map<string, Map<string, { inputPer1M: number | null; outputPer1M: number | null }>>();
  for (const [id, entry] of Object.entries(feed)) {
    const kind = entry?.litellm_provider;
    if (!kind || !id.startsWith(`${kind}/`)) continue;
    if (kind !== "github_copilot" && kind !== "github") continue;
    if (entry.mode !== "chat" && entry.mode !== "responses") continue;
    const tail = id.slice(kind.length + 1);
    if (/preview|latest|-\d{8}$|\d{4}-\d{2}-\d{2}/.test(tail)) continue;
    let models = out.get(kind);
    if (!models) out.set(kind, (models = new Map()));
    models.set(tail.toLowerCase().replace(/\./g, "-"), {
      inputPer1M: entry.input_cost_per_token != null ? Number((entry.input_cost_per_token * 1_000_000).toFixed(6)) : null,
      outputPer1M: entry.output_cost_per_token != null ? Number((entry.output_cost_per_token * 1_000_000).toFixed(6)) : null,
    });
  }
  return out;
}

/** Parse the raw feed into ModelSpecs, keeping only the newest of each family. */
export function parseFeed(feed: Record<string, FeedEntry>): ModelSpec[] {
  const byFamily = new Map<string, { version: number; spec: ModelSpec }>();

  for (const [id, entry] of Object.entries(feed)) {
    const provider = entry?.litellm_provider as Provider;
    if (provider !== "openai" && provider !== "anthropic") continue;
    if (entry.mode !== "chat" && entry.mode !== "responses") continue;
    if (!entry.input_cost_per_token || !entry.output_cost_per_token) continue;
    if (EXCLUDE.test(id) || LEGACY[provider].test(id)) continue;

    const spec: ModelSpec = {
      id,
      provider,
      inputPer1M: Number((entry.input_cost_per_token * 1_000_000).toFixed(6)),
      outputPer1M: Number((entry.output_cost_per_token * 1_000_000).toFixed(6)),
      tier: 1,
      contextWindow: entry.max_input_tokens ?? 128_000,
      enabled: true,
      vision: entry.supports_vision,
      toolUse: entry.supports_function_calling,
    };
    const { family, version } = familyOf(id);
    if (!family || version === 0) continue;
    spec.tier = tierFor(family, spec);

    const current = byFamily.get(`${provider}:${family}`);
    if (!current || version > current.version) {
      byFamily.set(`${provider}:${family}`, { version, spec });
    }
  }

  return [...byFamily.values()].map((v) => v.spec);
}

async function applyFeed(raw: Record<string, FeedEntry>): Promise<number> {
  const specs = parseFeed(raw);
  for (const spec of specs) registerModel(spec);
  gatewayFeed.clear();
  for (const [kind, models] of parseGatewayFeed(raw)) gatewayFeed.set(kind, models);
  // Disable any already-registered model (incl. compiled defaults) superseded
  // by a strictly newer feed model in the same provider+family, so the routing
  // pool only ever contains the latest generation. Disabled models still
  // resolve via getModel() for pass-through and baseline pricing.
  for (const existing of listModels()) {
    const e = familyOf(existing.id);
    const newer = specs.some(
      (s) =>
        s.provider === existing.provider &&
        s.id !== existing.id &&
        familyOf(s.id).family === e.family &&
        familyOf(s.id).version > e.version,
    );
    if (newer) registerModel({ ...existing, enabled: false });
  }
  return specs.length;
}

export interface PriceAutoUpdater {
  /** Fetch + apply once. Returns number of models applied, or null on failure. */
  refresh(): Promise<number | null>;
  stop(): void;
}

export function startPriceAutoUpdate(options: PriceFeedOptions = {}): PriceAutoUpdater {
  const feedUrl = options.feedUrl ?? Bun.env.PRICE_FEED_URL ?? DEFAULT_FEED_URL;
  const cachePath = options.cachePath ?? Bun.env.PRICE_CACHE_PATH ?? "price-cache.json";
  const refreshMs = options.refreshMs ?? Number(Bun.env.PRICE_REFRESH_MS ?? 24 * 60 * 60 * 1000);
  const maxCacheAgeMs = options.maxCacheAgeMs ?? refreshMs;

  let inFlight: Promise<number | null> | null = null;

  function refresh(): Promise<number | null> {
    // Coalesce concurrent refreshes (startup + manual + timer).
    if (inFlight) return inFlight;
    inFlight = doRefresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function doRefresh(): Promise<number | null> {
    try {
      const resp = await fetch(feedUrl, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`feed HTTP ${resp.status}`);
      const raw = (await resp.json()) as Record<string, FeedEntry>;
      const count = await applyFeed(raw);
      await Bun.write(cachePath, JSON.stringify({ fetchedAt: Date.now(), feed: raw }));
      console.log(`[pricefeed] refreshed ${count} models from feed`);
      return count;
    } catch (err) {
      console.error(`[pricefeed] refresh failed (keeping current prices): ${String(err)}`);
      return null;
    }
  }

  // Startup: recent disk cache first (fast, offline-friendly), else fetch.
  (async () => {
    try {
      const file = Bun.file(cachePath);
      if (await file.exists()) {
        const cached = (await file.json()) as { fetchedAt: number; feed: Record<string, FeedEntry> };
        if (Date.now() - cached.fetchedAt < maxCacheAgeMs) {
          const count = await applyFeed(cached.feed);
          console.log(`[pricefeed] loaded ${count} models from disk cache`);
          return;
        }
      }
    } catch {
      // corrupt cache — fall through to a network refresh
    }
    await refresh();
  })();

  let timer: ReturnType<typeof setInterval> | undefined;
  if (refreshMs > 0) {
    timer = setInterval(refresh, refreshMs);
    // Don't keep the process alive just for the refresh timer.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }

  return {
    refresh,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
