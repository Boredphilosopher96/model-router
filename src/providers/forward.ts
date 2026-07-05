import type { Dialect } from "../types.ts";

/** Pull token usage out of a provider response body (any dialect). */
export function extractUsage(dialect: Dialect, json: any): { inputTokens: number; outputTokens: number } {
  if (dialect === "anthropic") {
    const u = json?.usage ?? {};
    return {
      inputTokens:
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
    };
  }
  // OpenAI: chat completions uses prompt/completion_tokens, Responses API uses input/output_tokens.
  const u = json?.usage ?? {};
  return {
    inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
  };
}
