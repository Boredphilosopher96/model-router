import { dirname, resolve } from "node:path";
import type { CustomModelPricing, Dialect, ModelSpec, UpstreamAdapter, UpstreamProvider } from "./types.ts";
import { getModel, globToRegex, normalizeModelId, registerModel, setModelAllowlist } from "./registry.ts";
import { gatewayPricing, gatewayServes } from "./pricefeed.ts";

/**
 * The upstream pool: every endpoint the proxy can send traffic to. Declared
 * in router.config.json, with sensible direct-API defaults when env keys are
 * present. The router picks a (model, upstream) pair; this module answers
 * "who can serve what, at what effective price, with which credentials".
 */

export const DEFAULT_UPSTREAMS: UpstreamProvider[] = [
  {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    dialect: "anthropic",
    models: ["claude-*"],
    apiKeyEnv: "ANTHROPIC_API_KEY",
    default: true,
  },
  {
    name: "openai",
    baseUrl: "https://api.openai.com",
    dialect: "openai",
    models: ["gpt-*", "o*"],
    apiKeyEnv: "OPENAI_API_KEY",
    default: true,
  },
];

/** Gateway kinds with feed-driven pricing, inferred from the host. */
export function kindOf(u: UpstreamProvider): string | null {
  try {
    const host = new URL(u.baseUrl).host;
    if (host.includes("githubcopilot")) return "github_copilot";
    if (host === "models.github.ai" || host.endsWith(".github.ai")) return "github";
    return null;
  } catch {
    return null;
  }
}

export class Upstreams {
  private byName = new Map<string, UpstreamProvider>();
  private matchers = new Map<string, RegExp[]>();
  private adapters = new Map<string, UpstreamAdapter>();
  private declaredModels = new Set<string>();

  constructor(providers: UpstreamProvider[], adapters?: Map<string, UpstreamAdapter>) {
    for (const p of providers) {
      if (p.enabled === false) continue;
      this.byName.set(p.name, p);
      // Feed-known gateways (Copilot, …) with no declared list defer entirely
      // to the feed's availability data; plain endpoints default by dialect.
      const globs =
        p.models ??
        (kindOf(p) ? ["*"] : p.dialect === "anthropic" ? ["claude-*"] : p.dialect === "openai" ? ["gpt-*", "o*"] : ["*"]);
      // Models with custom pricing are implicitly served by their upstream.
      const withCustom = [...globs, ...Object.keys(p.pricing ?? {})];
      this.matchers.set(p.name, withCustom.map(globToRegex));
      if (p.models) this.declaredModels.add(p.name);
    }
    for (const [name, adapter] of adapters ?? []) this.adapters.set(name, adapter);
  }

  adapterOf(name: string): UpstreamAdapter | undefined {
    return this.adapters.get(name);
  }

  get(name: string): UpstreamProvider | undefined {
    return this.byName.get(name);
  }

  list(dialect?: Dialect): UpstreamProvider[] {
    const all = [...this.byName.values()];
    return dialect ? all.filter((u) => u.dialect === dialect || u.dialect === "both") : all;
  }

  /** The upstream used for bare /v1/* requests of this dialect. */
  home(dialect: Dialect, explicitName?: string): UpstreamProvider | undefined {
    if (explicitName) return this.byName.get(explicitName);
    const pool = this.list(dialect);
    return pool.find((u) => u.default) ?? pool[0];
  }

  serves(u: UpstreamProvider, spec: ModelSpec): boolean {
    const norm = normalizeModelId(spec.id);
    if (!(this.matchers.get(u.name) ?? []).some((re) => re.test(norm))) return false;
    // When the price feed knows this gateway and the user didn't declare an
    // explicit model list, trust the feed's availability.
    const kind = kindOf(u);
    if (kind && !this.declaredModels.has(u.name)) {
      const known = gatewayServes(kind, norm);
      if (known !== undefined) return known;
    }
    return true;
  }

  /**
   * Effective per-1M prices for a (upstream, model) pair — fully automatic:
   *  1. explicit `pricing` on the upstream (custom/private models),
   *  2. the live gateway feed (GitHub Copilot etc.; absent costs = flat-rate 0),
   *  3. catalog API pricing x the manual multiplier if one was set (default 1).
   */
  pricesFor(u: UpstreamProvider, spec: ModelSpec): { inputPer1M: number; outputPer1M: number } {
    const norm = normalizeModelId(spec.id);
    for (const [id, p] of Object.entries(u.pricing ?? {})) {
      if (normalizeModelId(id) === norm) return { inputPer1M: p.inputPer1M, outputPer1M: p.outputPer1M };
    }
    const kind = kindOf(u);
    if (kind) {
      const feed = gatewayPricing(kind, norm);
      if (feed) return { inputPer1M: feed.inputPer1M ?? 0, outputPer1M: feed.outputPer1M ?? 0 };
      // Known subscription gateway, model not in feed yet: still flat-rate.
      if (kind === "github_copilot") return { inputPer1M: 0, outputPer1M: 0 };
    }
    const mult = u.priceMultiplier ?? 1;
    return { inputPer1M: spec.inputPer1M * mult, outputPer1M: spec.outputPer1M * mult };
  }

  effectiveBlended(u: UpstreamProvider, spec: ModelSpec): number {
    const p = this.pricesFor(u, spec);
    return 0.75 * p.inputPer1M + 0.25 * p.outputPer1M;
  }

  /** USD cost of a completed call on this upstream. */
  costUsd(u: UpstreamProvider, spec: ModelSpec, inputTokens: number, outputTokens: number): number {
    const p = this.pricesFor(u, spec);
    return (inputTokens * p.inputPer1M + outputTokens * p.outputPer1M) / 1_000_000;
  }

  /** True when this upstream can authenticate without the caller's own credentials. */
  hasOwnAuth(u: UpstreamProvider): boolean {
    if (u.authStyle === "none") return true;
    if (u.apiKeyEnv && Bun.env[u.apiKeyEnv]) return true;
    if (u.headers && Object.keys(u.headers).some((h) => /authorization|api-key|token/i.test(h))) return true;
    return false;
  }

  /** The model id string this upstream expects on the wire. */
  wireModelId(u: UpstreamProvider, spec: ModelSpec, requestedRaw: string): string {
    if (u.vendorPrefix) {
      // OpenRouter style: vendor/tail with dot versions ("anthropic/claude-haiku-4.5")
      const tail = spec.id.replace(/(\d)-(\d)/g, "$1.$2");
      return `${spec.provider}/${tail}`;
    }
    // Preserve whatever namespace/punctuation style the caller used.
    return requestedRaw ? toStyleOf(requestedRaw, spec) : spec.id;
  }

  /** Compose the full upstream URL for a proxy path like /v1/messages. */
  url(u: UpstreamProvider, path: string, search = ""): string {
    const p = u.stripV1 ? path.replace(/^\/v1/, "") : path;
    return `${u.baseUrl.replace(/\/$/, "")}${p}${search}`;
  }

  /**
   * Build outbound headers. Caller credentials pass through only when this
   * upstream is the request's home (`isHome`); otherwise configured auth is
   * used. Anthropic-dialect version/beta headers are always preserved.
   */
  headers(u: UpstreamProvider, dialect: Dialect, clientHeaders: Headers, isHome: boolean): Headers {
    const h = new Headers();
    h.set("content-type", "application/json");
    if (dialect === "anthropic") {
      h.set("anthropic-version", clientHeaders.get("anthropic-version") ?? "2023-06-01");
      const beta = clientHeaders.get("anthropic-beta");
      if (beta) h.set("anthropic-beta", beta);
    }
    for (const [k, v] of Object.entries(u.headers ?? {})) h.set(k, v);

    const style = u.authStyle ?? "passthrough";
    const envKey = u.apiKeyEnv ? Bun.env[u.apiKeyEnv] : undefined;
    const clientKey = clientHeaders.get("x-api-key");
    const clientAuth = clientHeaders.get("authorization");

    if (style === "none") return h;
    if (style === "bearer" && envKey) {
      h.set("authorization", `Bearer ${envKey}`);
      return h;
    }
    if (style === "x-api-key" && envKey) {
      h.set("x-api-key", envKey);
      return h;
    }
    // passthrough (default): the caller's own credentials, but only toward
    // the upstream they were meant for; configured key is the fallback.
    if (isHome && (clientKey || clientAuth)) {
      if (clientKey) h.set("x-api-key", clientKey);
      if (clientAuth) h.set("authorization", clientAuth);
    } else if (envKey) {
      if (dialect === "anthropic") h.set("x-api-key", envKey);
      else h.set("authorization", `Bearer ${envKey}`);
    }
    return h;
  }
}

/** Rewrite a routed spec into the punctuation/namespace style of the requested id. */
export function toStyleOf(requestedRaw: string, routed: ModelSpec): string {
  const slash = requestedRaw.lastIndexOf("/");
  const prefix = slash >= 0 ? requestedRaw.slice(0, slash + 1) : "";
  const tail = slash >= 0 ? requestedRaw.slice(slash + 1) : requestedRaw;

  let routedTail = routed.id;
  const tailUsesDots = /\d\.\d/.test(tail);
  const specUsesDots = /\d\.\d/.test(routed.id);
  if (tailUsesDots && !specUsesDots) routedTail = routed.id.replace(/(\d)-(\d)/g, "$1.$2");
  else if (!tailUsesDots && specUsesDots) routedTail = routed.id.replace(/(\d)\.(\d)/g, "$1-$2");

  let outPrefix = prefix;
  if (prefix) {
    const segs = prefix.slice(0, -1).split("/");
    const last = segs[segs.length - 1];
    if (last === "anthropic" || last === "openai") {
      segs[segs.length - 1] = routed.provider;
      outPrefix = segs.join("/") + "/";
    }
  }
  return outPrefix + routedTail;
}

interface RouterFile {
  providers?: UpstreamProvider[];
  allowedModels?: string[];
  plugins?: string[];
}

export interface RouterSetup {
  upstreams: Upstreams;
  /** Plugin module paths declared in the config file. */
  pluginPaths: string[];
}

/** Guess the vendor for a custom-priced model id. */
function providerFor(id: string, dialect: Dialect | "both"): "anthropic" | "openai" {
  if (/claude/i.test(id)) return "anthropic";
  if (/gpt|^o\d/i.test(id)) return "openai";
  return dialect === "anthropic" ? "anthropic" : "openai";
}

function tierForPrice(p: CustomModelPricing): 1 | 2 | 3 | 4 {
  if (p.tier) return p.tier;
  const blended = 0.75 * p.inputPer1M + 0.25 * p.outputPer1M;
  if (blended < 0.9) return 1;
  if (blended < 3) return 2;
  if (blended < 12) return 3;
  return 4;
}

/**
 * Load the full router setup: upstreams (with env-key defaults filling any
 * uncovered dialect), custom-priced models registered into the catalog,
 * adapters imported, the model allowlist applied, and plugin paths collected.
 */
export async function loadUpstreams(
  configPath?: string,
  inline?: UpstreamProvider[],
  allowedModels?: string[],
): Promise<Upstreams> {
  return (await loadRouterSetup(configPath, inline, allowedModels)).upstreams;
}

export async function loadRouterSetup(
  configPath?: string,
  inline?: UpstreamProvider[],
  allowedModels?: string[],
): Promise<RouterSetup> {
  const declared: UpstreamProvider[] = [];
  let fileConf: RouterFile = {};
  if (configPath) {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      const parsed = (await file.json()) as RouterFile | UpstreamProvider[];
      fileConf = Array.isArray(parsed) ? { providers: parsed } : parsed;
      for (const p of fileConf.providers ?? []) {
        if (!p?.name || !p?.baseUrl || !p?.dialect) throw new Error(`invalid upstream in ${configPath}: ${JSON.stringify(p)}`);
        declared.push(p);
      }
    }
  }
  for (const p of inline ?? []) declared.push(p);

  // Direct-API defaults fill any dialect that has no declared upstream.
  const names = new Set(declared.map((p) => p.name));
  const dialectCovered = (d: Dialect) => declared.some((p) => p.dialect === d || p.dialect === "both");
  for (const def of DEFAULT_UPSTREAMS) {
    if (!names.has(def.name) && !dialectCovered(def.dialect as Dialect)) declared.push(def);
  }

  // Custom-priced models join the catalog so routing/stats can price them.
  for (const p of declared) {
    for (const [id, pricing] of Object.entries(p.pricing ?? {})) {
      if (!getModel(id)) {
        registerModel({
          id,
          provider: providerFor(id, p.dialect),
          inputPer1M: pricing.inputPer1M,
          outputPer1M: pricing.outputPer1M,
          tier: tierForPrice(pricing),
          contextWindow: pricing.contextWindow ?? 128_000,
          enabled: true,
          vision: pricing.vision,
          toolUse: pricing.toolUse,
        });
      }
    }
  }

  // Adapters: module default export is an UpstreamAdapter or a factory for one.
  // A missing/broken adapter is a warning, not a crash — the upstream then
  // runs with stock request/response handling.
  const adapters = new Map<string, UpstreamAdapter>();
  for (const p of declared) {
    if (!p.adapter) continue;
    try {
      const mod = await import(resolveModulePath(p.adapter, configPath));
      const exported = mod.default ?? mod;
      adapters.set(p.name, typeof exported === "function" ? exported() : exported);
      console.log(`[upstreams] loaded adapter for ${p.name} from ${p.adapter}`);
    } catch (err) {
      console.error(`[upstreams] adapter for ${p.name} failed to load (running stock): ${String(err)}`);
    }
  }

  setModelAllowlist(allowedModels ?? fileConf.allowedModels ?? null);
  return { upstreams: new Upstreams(declared, adapters), pluginPaths: fileConf.plugins ?? [] };
}

/** Resolve ./relative module paths against the config file's directory. */
export function resolveModulePath(path: string, configPath?: string): string {
  if (!path.startsWith(".")) return path;
  const base = configPath ? dirname(resolve(configPath)) : process.cwd();
  return resolve(base, path);
}
