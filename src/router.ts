import type { Dialect, ModelSpec, RouteDecision, RouterConfig, UpstreamProvider } from "./types.ts";
import { getModel, listModels, normalizeModelId } from "./registry.ts";
import type { Upstreams } from "./upstreams.ts";

/** Normalize the turn list across Anthropic messages, OpenAI chat, and OpenAI Responses shapes. */
function turnsOf(body: any): any[] {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input; // Responses API item list
  if (typeof body?.input === "string") return [{ role: "user", content: body.input }];
  return [];
}

/**
 * Estimate request complexity in [0, 1] from the raw provider body.
 * Works for Anthropic (/v1/messages), OpenAI chat (/v1/chat/completions),
 * and OpenAI Responses (/v1/responses) shapes.
 */
export function estimateComplexity(body: any): number {
  const messages = turnsOf(body);

  let promptChars = 0;
  for (const m of messages) {
    if (typeof m?.content === "string") promptChars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const block of m.content) {
        if (typeof block?.text === "string") promptChars += block.text.length;
        // images / documents push complexity up
        if (
          block?.type === "image" ||
          block?.type === "document" ||
          block?.type === "image_url" ||
          block?.type === "input_image" ||
          block?.type === "input_file"
        )
          promptChars += 4000;
      }
    }
  }
  const system =
    (typeof body?.system === "string" ? body.system : "") +
    (typeof body?.instructions === "string" ? body.instructions : "");
  promptChars += system.length;

  const toolCount = Array.isArray(body?.tools) ? body.tools.length : 0;
  const turnCount = messages.length;
  const maxTokens = Number(body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? 0);

  // Each signal saturates independently, then they are blended.
  const sizeScore = Math.min(promptChars / 60_000, 1); // ~15K tokens of prompt = max
  const toolScore = Math.min(toolCount / 8, 1);
  const turnScore = Math.min(turnCount / 30, 1);
  const outputScore = Math.min(maxTokens / 32_000, 1);

  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const lastText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.map((b: any) => b?.text ?? "").join(" ")
        : "";
  const hardTaskHint =
    /\b(prove|refactor|architect|debug|optimi[sz]e|migrat\w+|design\s+a|step[- ]by[- ]step|analyz\w+|implement)\b/i.test(lastText)
      ? 0.25
      : 0;

  const score = 0.35 * sizeScore + 0.2 * toolScore + 0.15 * turnScore + 0.15 * outputScore + hardTaskHint;
  return Math.min(Math.max(score, 0), 1);
}

function requiredTierFor(complexity: number): number {
  if (complexity < 0.25) return 1;
  if (complexity < 0.5) return 2;
  if (complexity < 0.75) return 3;
  return 4;
}

/** Rough token estimate for context-window fitting (chars / 4). */
function estimateInputTokens(body: any): number {
  try {
    return Math.ceil(JSON.stringify(body?.messages ?? body?.input ?? "").length / 4);
  } catch {
    return 0;
  }
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

/**
 * Pick the cheapest (model, upstream) pair that can serve this request:
 *  - the model meets the required capability tier (raised by any escalation
 *    boost when the conversation is struggling), fits the context, and stays
 *    within the requested model's tier as the ceiling — except that an
 *    escalation boost may lift the ceiling ("bump up when stuck"), and
 *    `auto` has no requested ceiling at all;
 *  - the upstream speaks the request's dialect, serves the model, and is
 *    either the request's home (caller's own auth passes through) or has its
 *    own configured credentials;
 *  - price = catalog price x upstream multiplier, so a flat-rate upstream
 *    (multiplier 0, e.g. a Copilot subscription) wins whenever it can serve;
 *  - in "balanced" mode, at most one tier below the requested model;
 *  - vendor switching (claude <-> gpt) only on the OpenAI dialect and only
 *    when crossProvider is enabled — never any format translation.
 */
export function route(
  body: any,
  dialect: Dialect,
  home: UpstreamProvider,
  upstreams: Upstreams,
  config: Pick<RouterConfig, "mode" | "crossProvider">,
  escalationBoost = 0,
): RouteDecision {
  const requestedModel: string = body?.model ?? "";
  const auto = isAutoModel(requestedModel);
  const requested = auto ? undefined : getModel(requestedModel);
  const complexity = estimateComplexity(body);

  const noop = (reason: string): RouteDecision => ({
    requestedModel,
    routedModel: requestedModel,
    upstream: home.name,
    provider: requested?.provider ?? dialect,
    complexity,
    requiredTier: requested?.tier ?? 0,
    escalationBoost,
    auto,
    reason,
  });

  if (config.mode === "off" && !auto) return noop("routing disabled");
  if (!auto && !requested) return noop("unknown model - passed through");

  const clampTier = (t: number) => Math.min(Math.max(t, 1), 4);
  let requiredTier = clampTier(requiredTierFor(complexity) + escalationBoost);
  const ceiling = auto ? 4 : clampTier((requested?.tier ?? 4) + escalationBoost);
  requiredTier = Math.min(requiredTier, ceiling);
  if (config.mode === "balanced" && requested) {
    requiredTier = clampTier(Math.max(requiredTier, requested.tier - 1));
  }

  const crossProvider = config.crossProvider === true && dialect === "openai";
  const inputTokens = estimateInputTokens(body);
  const needsVision = requestNeedsVision(body);
  const usesTools = requestUsesTools(body);
  // Stay in the requested model's vendor family by default: "anthropic/claude-…"
  // on an OpenAI-dialect gateway keeps switching among Claude models.
  const familyProvider = requested?.provider ?? dialect;
  const modelPool = (crossProvider ? listModels() : listModels(familyProvider)).filter(
    (m) =>
      m.tier >= requiredTier &&
      m.tier <= ceiling &&
      m.contextWindow > inputTokens * 1.2 &&
      // Capability floor: multimodal / tool requests only go to models that
      // support them (unknown capability fails open).
      (!needsVision || m.vision !== false) &&
      (!usesTools || m.toolUse !== false),
  );

  const servers = upstreams.list(dialect).filter((u) => u.name === home.name || upstreams.hasOwnAuth(u));
  const pairs: Array<{ spec: ModelSpec; upstream: UpstreamProvider; cost: number }> = [];
  for (const spec of modelPool) {
    for (const u of servers) {
      if (!upstreams.serves(u, spec)) continue;
      pairs.push({ spec, upstream: u, cost: upstreams.effectiveBlended(u, spec) });
    }
  }
  pairs.sort(
    (a, b) => a.cost - b.cost || Number(b.upstream.name === home.name) - Number(a.upstream.name === home.name),
  );

  const pick = pairs[0];
  if (!pick || (requested && pick.spec.id === requested.id && pick.upstream.name === home.name)) {
    return noop(`kept requested model (required tier ${requiredTier}${escalationBoost ? `, boost +${escalationBoost}` : ""})`);
  }
  return {
    requestedModel,
    routedModel: upstreams.wireModelId(pick.upstream, pick.spec, auto ? "" : requestedModel),
    upstream: pick.upstream.name,
    provider: pick.spec.provider,
    complexity,
    requiredTier,
    escalationBoost,
    auto,
    reason:
      `complexity ${complexity.toFixed(2)}${escalationBoost ? ` +${escalationBoost} escalation` : ""}` +
      ` -> tier ${requiredTier}; ${pick.spec.id} via ${pick.upstream.name} is cheapest capable`,
  };
}
