import type { ModelSpec, Provider } from "./types.ts";

/**
 * Model registry. Seeded with the latest generation of each provider
 * (pricing: USD per 1M tokens, current as of 2026-07). Extend at runtime
 * with registerModel(), or drop a models.json next to the process
 * (array of ModelSpec) to add/override entries at startup.
 */
const models = new Map<string, ModelSpec>();

export const DEFAULT_MODELS: ModelSpec[] = [
  // Anthropic — latest generation only
  { id: "claude-haiku-4-5", provider: "anthropic", inputPer1M: 1.0, outputPer1M: 5.0, tier: 1, contextWindow: 200_000, enabled: true },
  { id: "claude-sonnet-4-6", provider: "anthropic", inputPer1M: 3.0, outputPer1M: 15.0, tier: 2, contextWindow: 1_000_000, enabled: true },
  { id: "claude-opus-4-8", provider: "anthropic", inputPer1M: 5.0, outputPer1M: 25.0, tier: 3, contextWindow: 1_000_000, enabled: true },
  { id: "claude-fable-5", provider: "anthropic", inputPer1M: 10.0, outputPer1M: 50.0, tier: 4, contextWindow: 1_000_000, enabled: true },

  // OpenAI — latest generation only (verified against the official pricing page, 2026-07)
  { id: "gpt-5.4-nano", provider: "openai", inputPer1M: 0.2, outputPer1M: 1.25, tier: 1, contextWindow: 1_050_000, enabled: true },
  { id: "gpt-5.4-mini", provider: "openai", inputPer1M: 0.75, outputPer1M: 4.5, tier: 2, contextWindow: 1_050_000, enabled: true },
  { id: "gpt-5.4", provider: "openai", inputPer1M: 2.5, outputPer1M: 15.0, tier: 3, contextWindow: 1_050_000, enabled: true },
  { id: "gpt-5.5", provider: "openai", inputPer1M: 5.0, outputPer1M: 30.0, tier: 4, contextWindow: 1_050_000, enabled: true },
];

export function registerModel(spec: ModelSpec): void {
  models.set(spec.id, spec);
}

export function globToRegex(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
}

/**
 * Restrict which models the router may route TO. Globs match normalized ids
 * ("claude-haiku-*", "gpt-5-4-*"). null clears the restriction. getModel()
 * still resolves excluded models — pass-through and baseline pricing keep
 * working; they just never win a routing decision.
 */
let allowlist: RegExp[] | null = null;

export function setModelAllowlist(globs: string[] | null): void {
  allowlist = globs && globs.length ? globs.map((g) => globToRegex(normalizeModelId(g))) : null;
}

export function isAllowed(spec: ModelSpec): boolean {
  if (!allowlist) return true;
  const norm = normalizeModelId(spec.id);
  return allowlist.some((re) => re.test(norm));
}

/**
 * Canonical form for model-id comparison, tolerant of gateway namespaces and
 * version punctuation: "openrouter/anthropic/claude-opus-4.8" and
 * "claude-opus-4-8" normalize identically.
 */
export function normalizeModelId(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.toLowerCase().replace(/\./g, "-");
}

export function getModel(id: string): ModelSpec | undefined {
  const direct = models.get(id);
  if (direct) return direct;
  const norm = normalizeModelId(id);
  for (const spec of models.values()) {
    if (norm === normalizeModelId(spec.id)) return spec;
  }
  // Tolerate dated/suffixed IDs (e.g. claude-haiku-4-5-20251001) by prefix match.
  for (const spec of models.values()) {
    if (norm.startsWith(normalizeModelId(spec.id))) return spec;
  }
  return undefined;
}


export function listModels(provider?: Provider): ModelSpec[] {
  const all = [...models.values()].filter((m) => m.enabled && isAllowed(m));
  return provider ? all.filter((m) => m.provider === provider) : all;
}

/** Blended per-token price used to compare models (assumes ~3:1 input:output). */
export function blendedPricePer1M(m: ModelSpec): number {
  return 0.75 * m.inputPer1M + 0.25 * m.outputPer1M;
}

export function costUsd(m: ModelSpec, inputTokens: number, outputTokens: number): number {
  return (inputTokens * m.inputPer1M + outputTokens * m.outputPer1M) / 1_000_000;
}

export async function loadRegistry(extraModelsPath?: string): Promise<void> {
  models.clear();
  for (const spec of DEFAULT_MODELS) registerModel(spec);
  if (extraModelsPath) {
    const file = Bun.file(extraModelsPath);
    if (await file.exists()) {
      const extra = (await file.json()) as ModelSpec[];
      for (const spec of extra) registerModel(spec);
    }
  }
}

// Seed synchronously so importing modules always see the defaults.
for (const spec of DEFAULT_MODELS) registerModel(spec);
