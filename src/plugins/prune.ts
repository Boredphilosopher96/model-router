import type { ProxyPlugin } from "../types.ts";
import { estimateTextTokens } from "../tokens.ts";

/**
 * Context pruning (opt-in, PLUGIN_PRUNE=true): truncate the bodies of OLD
 * oversized tool_result blocks in very long conversations. Old tool output is
 * the bulk of agent-session context and is rarely load-bearing after the
 * model has acted on it.
 *
 * Cache-aware by design: truncating history invalidates the provider's
 * prompt cache for everything after the edit, so by default pruning only
 * happens when the conversation has NO warm cache to lose ("whenCold" —
 * e.g. right after a model switch, or on a fresh proxy). "always" prunes
 * regardless; use it when conversations are so long that even cached-rate
 * history dominates cost.
 */
export interface PruneOptions {
  /** Prune only when history tokens exceed this. Default 30_000. */
  minHistoryTokens?: number;
  /** Never touch the newest N turns. Default 8. */
  keepRecentTurns?: number;
  /** Tool results longer than this get truncated (chars). Default 4_000. */
  maxToolResultChars?: number;
  /** "whenCold" (default) or "always". */
  mode?: "whenCold" | "always";
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[model-router: pruned ${text.length - max} chars of stale tool output]…\n${text.slice(-tail)}`;
}

export function prunePlugin(options: PruneOptions = {}): ProxyPlugin {
  const minHistoryTokens = options.minHistoryTokens ?? 30_000;
  const keepRecentTurns = options.keepRecentTurns ?? 8;
  const maxChars = options.maxToolResultChars ?? 4_000;
  const mode = options.mode ?? "whenCold";

  return {
    name: "prune",
    priority: 40, // run before compression/telemetry plugins
    onRequest(body, ctx) {
      const turns: any[] = Array.isArray(body?.messages) ? body.messages : [];
      if (turns.length <= keepRecentTurns) return body;

      // Cache-awareness: with a warm provider cache, history bills at ~10% —
      // pruning would force a full cold re-read and usually costs MORE.
      const lastRoute = ctx.state["model-router:lastRoute"];
      if (mode === "whenCold" && lastRoute) return body;

      const historyTokens = estimateTextTokens(JSON.stringify(turns.slice(0, -1)));
      if (historyTokens < minHistoryTokens) return body;

      let pruned = 0;
      const cutoff = turns.length - keepRecentTurns;
      const nextTurns = turns.map((m, i) => {
        if (i >= cutoff || !Array.isArray(m?.content)) return m;
        let changed = false;
        const content = m.content.map((block: any) => {
          const isToolResult = block?.type === "tool_result" || block?.type === "function_call_output";
          if (!isToolResult) return block;
          if (typeof block.content === "string" && block.content.length > maxChars) {
            changed = true;
            pruned += block.content.length - maxChars;
            return { ...block, content: truncateMiddle(block.content, maxChars) };
          }
          if (Array.isArray(block.content)) {
            const inner = block.content.map((b: any) =>
              typeof b?.text === "string" && b.text.length > maxChars
                ? ((changed = true), (pruned += b.text.length - maxChars), { ...b, text: truncateMiddle(b.text, maxChars) })
                : b,
            );
            return changed ? { ...block, content: inner } : block;
          }
          if (typeof block?.output === "string" && block.output.length > maxChars) {
            changed = true;
            pruned += block.output.length - maxChars;
            return { ...block, output: truncateMiddle(block.output, maxChars) };
          }
          return block;
        });
        return changed ? { ...m, content } : m;
      });

      if (pruned === 0) return body;
      ctx.state["model-router:prunedChars"] = pruned;
      return { ...body, messages: nextTurns };
    },
  };
}
