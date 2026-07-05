import type { Dialect, ModelSpec, RouteDecision, RouterConfig, UpstreamProvider } from "./types.ts";
import { getModel, listModels, normalizeModelId } from "./registry.ts";
import type { Upstreams } from "./upstreams.ts";
import { heuristicStrategy, structuralSignals, turnsOf, type Classification } from "./strategy.ts";

/** Back-compat convenience: continuous difficulty in [0,1] from the default heuristic. */
export function estimateComplexity(body: any): number {
  return (heuristicStrategy().classify(body, "") as Classification).complexity;
}

/** Does the request carry image/document/audio input? (all dialects) */
export function requestNeedsVision(body: any): boolean {
  for (const m of turnsOf(body)) {
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) {
      const t = block?.type;
      if (t === "image" || t === "document" || t === "image_url" || t === "input_image" || t === "input_file" || t === "input_audio" || t === "file")
        return true;
    }
  }
  return false;
}

/** Does the request declare tools / function calling? */
export function requestUsesTools(body: any): boolean {
  return Array.isArray(body?.tools) && body.tools.length > 0;
}

/** The magic model names a harness can select to hand the choice to the router. */
function isAutoModel(id: string): boolean {
  const norm = normalizeModelId(id);
  return norm === "auto" || norm === "model-router-auto";
}

/** Rough token split: conversation prefix (cacheable) vs this turn's fresh content. */
export function estimateTokens(body: any): { history: number; fresh: number; output: number } {
  const turns = turnsOf(body);
  const chars = (v: any) => {
    try {
      return JSON.stringify(v ?? "").length;
    } catch {
      return 0;
    }
  };
  const total = chars(turns) + chars(body?.system ?? body?.instructions ?? "") + chars(body?.tools ?? "");
  const last = turns.length ? chars(turns[turns.length - 1]) : 0;
  const history = Math.ceil(Math.max(total - last, 0) / 4);
  const fresh = Math.ceil(last / 4);
  const maxTokens = Number(body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? 0);
  const output = Math.ceil(Math.min(maxTokens || 1600, 8000) / 2);
  return { history, fresh, output };
}

export interface RouteInputs {
  body: any;
  dialect: Dialect;
  home: UpstreamProvider;
  upstreams: Upstreams;
  config: Pick<RouterConfig, "mode" | "crossProvider">;
  /** Output of the routing strategy (heuristic or LLM classifier). */
  classification: Classification;
  escalationBoost?: number;
  /** The (model, upstream) whose prompt cache is warm for this conversation. */
  lastRoute?: { model: string; upstream: string } | null;
  /** Upstream health: skip open circuits, prefer faster endpoints on cost ties. */
  health?: { available(name: string): boolean; latencyMs(name: string): number };
}

/**
 * Pick the cheapest (model, upstream) pair for this request.
 *
 * Selection follows production routing practice:
 *  - the strategy's classification sets the tier floor; the requested model's
 *    tier is the ceiling (spend cap) — escalation boosts may lift both
 *    ("bump up when stuck"), and `auto` has no ceiling;
 *  - "balanced" keeps within one tier of the requested model; "quality"
 *    additionally refuses to downgrade at all when classifier confidence is
 *    low; "aggressive" trusts the classification fully;
 *  - candidates must meet capability floors (vision / tool use), fit the
 *    context window, be on the allowlist, and be served by an upstream that
 *    speaks the dialect and is authable;
 *  - pairs are ranked by ESTIMATED REQUEST COST, cache-aware: the pair that
 *    served this conversation last bills its history at cached-input rates,
 *    so long conversations stay put unless switching genuinely saves money —
 *    switching models re-feeds the whole history at full price;
 *  - vendor switching (Claude <-> GPT) happens only on the OpenAI dialect
 *    and only through upstreams that serve both (crossProvider) or when
 *    globally enabled. Never any format translation.
 */
export function route(inputs: RouteInputs): RouteDecision {
  const { body, dialect, home, upstreams, config, classification, lastRoute, health } = inputs;
  const escalationBoost = inputs.escalationBoost ?? 0;
  const requestedModel: string = body?.model ?? "";
  const auto = isAutoModel(requestedModel);
  const requested = auto ? undefined : getModel(requestedModel);
  const { complexity, taskType, confidence } = classification;
  const tokens = estimateTokens(body);
  const warm = (specId: string, upstreamName: string) =>
    !!lastRoute && normalizeModelId(lastRoute.model) === normalizeModelId(specId) && lastRoute.upstream === upstreamName;

  const noop = (reason: string): RouteDecision => ({
    requestedModel,
    routedModel: requestedModel,
    upstream: home.name,
    provider: requested?.provider ?? dialect,
    complexity,
    requiredTier: requested?.tier ?? 0,
    escalationBoost,
    auto,
    taskType,
    sticky: false,
    // Even a kept/passed-through model has an estimated cost — shadow-mode
    // comparisons and eval need it.
    estCostUsd: requested ? upstreams.estimateCostUsd(home, requested, tokens, warm(requested.id, home.name)) : 0,
    reason,
  });

  if (config.mode === "off" && !auto) return noop("routing disabled");
  if (!auto && !requested) return noop("unknown model - passed through");

  const clampTier = (t: number) => Math.min(Math.max(t, 1), 4);
  let requiredTier = clampTier(classification.requiredTier + escalationBoost);
  const ceiling = auto ? 4 : clampTier((requested?.tier ?? 4) + escalationBoost);
  requiredTier = Math.min(requiredTier, ceiling);
  if (requested && (config.mode === "balanced" || config.mode === "quality")) {
    requiredTier = clampTier(Math.max(requiredTier, requested.tier - 1));
  }
  if (requested && config.mode === "quality" && confidence < 0.65) {
    // Low classifier confidence in quality mode: don't gamble, keep the tier.
    requiredTier = clampTier(Math.max(requiredTier, requested.tier));
  }

  const needsVision = requestNeedsVision(body);
  const usesTools = requestUsesTools(body);
  const familyProvider = requested?.provider ?? dialect;
  const globalCross = config.crossProvider === true && dialect === "openai";
  const inputTokens = tokens.history + tokens.fresh;

  const modelOk = (m: ModelSpec) =>
    m.tier >= requiredTier &&
    m.tier <= ceiling &&
    m.contextWindow > inputTokens * 1.2 &&
    (!needsVision || m.vision !== false) &&
    (!usesTools || m.toolUse !== false);

  const servers = upstreams
    .list(dialect)
    .filter((u) => u.name === home.name || upstreams.hasOwnAuth(u))
    // Circuit breaker: skip upstreams that are currently failing — unless
    // that would leave no candidates at all (fail open through home).
    .filter((u, _, all) => health?.available(u.name) !== false || all.every((x) => health?.available(x.name) === false));

  const pairs: Array<{ spec: ModelSpec; upstream: UpstreamProvider; cost: number; warm: boolean }> = [];
  for (const spec of listModels()) {
    if (!modelOk(spec)) continue;
    for (const u of servers) {
      if (!upstreams.serves(u, spec)) continue;
      // Vendor discipline: stay in the requested model's family unless this
      // upstream serves multiple vendors in one dialect (or global override).
      if (spec.provider !== familyProvider && !(globalCross || (u.crossProvider === true && dialect === "openai"))) continue;
      const isWarm = warm(spec.id, u.name);
      pairs.push({ spec, upstream: u, warm: isWarm, cost: upstreams.estimateCostUsd(u, spec, tokens, isWarm) });
    }
  }
  pairs.sort((a, b) => {
    // Costs within 2% are a tie: break by upstream latency, then home-first.
    const tie = Math.abs(a.cost - b.cost) <= 0.02 * Math.max(a.cost, b.cost, 1e-9);
    if (!tie) return a.cost - b.cost;
    const lat = (health?.latencyMs(a.upstream.name) ?? 0) - (health?.latencyMs(b.upstream.name) ?? 0);
    if (lat !== 0) return lat;
    return Number(b.upstream.name === home.name) - Number(a.upstream.name === home.name);
  });

  const pick = pairs[0];
  if (!pick || (requested && pick.spec.id === requested.id && pick.upstream.name === home.name)) {
    return {
      ...noop(`kept requested model (${taskType}, required tier ${requiredTier}${escalationBoost ? `, boost +${escalationBoost}` : ""})`),
      requiredTier,
      sticky: !!pick?.warm,
      estCostUsd: pick?.cost ?? 0,
    };
  }

  // Sticky: the cache-warm pair won even though a colder pair had a lower
  // raw price — i.e. staying put was the cheaper total.
  const cheapestCold = pairs.find((p) => !p.warm);
  const sticky =
    pick.warm && !!cheapestCold && normalizeModelId(cheapestCold.spec.id) !== normalizeModelId(pick.spec.id);

  return {
    requestedModel,
    routedModel: upstreams.wireModelId(pick.upstream, pick.spec, auto ? "" : requestedModel),
    upstream: pick.upstream.name,
    provider: pick.spec.provider,
    complexity,
    requiredTier,
    escalationBoost,
    auto,
    taskType,
    sticky,
    estCostUsd: pick.cost,
    reason:
      `${taskType} (confidence ${confidence.toFixed(2)})` +
      `${escalationBoost ? ` +${escalationBoost} escalation` : ""} -> tier ${requiredTier}; ` +
      (sticky
        ? `stayed on ${pick.spec.id} via ${pick.upstream.name} - warm prompt cache beats switching`
        : `${pick.spec.id} via ${pick.upstream.name} is cheapest capable (est $${pick.cost.toFixed(6)})`),
  };
}
