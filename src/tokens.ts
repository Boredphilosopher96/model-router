/**
 * Token estimation without a tokenizer dependency. The naive chars/4 rule is
 * ~15–30% off on code and catastrophically off on CJK text; this estimator is
 * content-aware:
 *
 *   - CJK characters tokenize ~1 char/token
 *   - code and JSON tokenize denser (~3.4 chars/token) — punctuation,
 *     identifiers, and structure split into more tokens
 *   - English prose averages ~4 chars/token
 *
 * Deterministic and fast (single pass); good enough for routing decisions,
 * cost estimates, and context-window fit checks. Not billing-grade.
 */

const CJK =
  /[ᄀ-ᇿ⺀-⻿　-鿿가-힯豈-﫿＀-￯]/;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let structural = 0; // brackets, quotes, operators — token-splitting characters
  const len = text.length;
  // Sample long strings to keep this O(1)-ish on megabyte histories.
  const step = len > 200_000 ? Math.ceil(len / 100_000) : 1;
  let sampled = 0;
  for (let i = 0; i < len; i += step) {
    const ch = text[i]!;
    sampled++;
    if (CJK.test(ch)) cjk++;
    else if ("{}[]()<>\"'`,:;=+-*/\\|&^%$#@!~\n\t".includes(ch)) structural++;
  }
  const scale = len / Math.max(sampled, 1);
  const cjkChars = cjk * scale;
  const structuralChars = structural * scale;
  const plainChars = Math.max(len - cjkChars - structuralChars, 0);
  // CJK ~1 char/token; structural chars often become their own token (~1.5
  // chars/token effective); plain text ~4.2 chars/token.
  return Math.ceil(cjkChars + structuralChars / 1.5 + plainChars / 4.2);
}

/** Estimate tokens for any JSON-serializable value (tools, messages, …). */
export function estimateValueTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value ?? ""));
  } catch {
    return 0;
  }
}
