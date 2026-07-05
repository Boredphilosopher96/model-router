/**
 * Per-conversation escalation: when a conversation keeps failing or looping
 * on a cheap model, raise its tier floor; after sustained success, settle
 * back down. State is in-memory with TTL — a proxy restart simply forgets.
 *
 * Signals that count as "struggling":
 *  - upstream failures (5xx/429) and provider refusals for the conversation
 *  - tool_result blocks flowing back in with is_error: true (the model's
 *    tool calls are failing)
 *  - loop suspicion: the same conversation re-enters many times in a short
 *    window without its message count growing much (retry churn)
 */

export interface EscalationConfig {
  /** signals within the window needed to add +1 tier boost */
  signalsPerBoost: number;
  /** max tiers we will boost above the computed requirement */
  maxBoost: number;
  /** clean responses needed to remove one boost level */
  successesPerDecay: number;
  /** forget conversations idle longer than this */
  ttlMs: number;
  /** turns after which a conversation re-entering rapidly counts as looping */
  loopTurnThreshold: number;
}

export const DEFAULT_ESCALATION: EscalationConfig = {
  signalsPerBoost: 3,
  maxBoost: 2,
  successesPerDecay: 4,
  ttlMs: 30 * 60 * 1000,
  loopTurnThreshold: 12,
};

interface ConvoState {
  boost: number;
  signals: number;
  successes: number;
  lastSeen: number;
  lastTurnCount: number;
  entries: number;
  /** Last (model, upstream) that served this conversation — its prompt cache is warm there. */
  lastModel?: string;
  lastUpstream?: string;
}

/** Stable conversation identity: hash of system prompt + first user turn. */
export function conversationKey(provider: string, body: any): string {
  const turns: any[] = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const firstUser = turns.find((m) => m?.role === "user");
  const seed = JSON.stringify({
    provider,
    system: body?.system ?? body?.instructions ?? null,
    first: firstUser?.content ?? null,
  });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(seed);
  return hasher.digest("hex").slice(0, 24);
}

/** Count is_error tool results in the newest turns of the request. */
function countIncomingToolErrors(body: any): number {
  const turns: any[] = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  let errors = 0;
  for (const m of turns.slice(-6)) {
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const block of content) {
      if ((block?.type === "tool_result" || block?.type === "function_call_output") && block?.is_error === true) errors++;
    }
    if (m?.role === "tool" && typeof m?.content === "string" && /^error[:\s]/i.test(m.content)) errors++;
  }
  return errors;
}

export class EscalationTracker {
  private convos = new Map<string, ConvoState>();
  constructor(private config: EscalationConfig = DEFAULT_ESCALATION) {}

  private state(key: string): ConvoState {
    this.gc();
    let s = this.convos.get(key);
    if (!s) {
      s = { boost: 0, signals: 0, successes: 0, lastSeen: Date.now(), lastTurnCount: 0, entries: 0 };
      this.convos.set(key, s);
    }
    return s;
  }

  /**
   * Inspect an incoming request; returns the tier boost to apply to it.
   * Also ingests request-visible signals (tool errors, loop churn).
   */
  observeRequest(key: string, body: any): number {
    const s = this.state(key);
    const now = Date.now();
    const turns: any[] = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];

    s.entries++;
    const toolErrors = countIncomingToolErrors(body);
    if (toolErrors > 0) s.signals += toolErrors;

    // Loop suspicion: deep conversation re-entering fast without growing.
    const grewBy = turns.length - s.lastTurnCount;
    const rapid = now - s.lastSeen < 90_000;
    if (turns.length >= this.config.loopTurnThreshold && rapid && grewBy <= 1 && s.entries > 3) {
      s.signals++;
    }

    s.lastTurnCount = turns.length;
    s.lastSeen = now;
    this.applyThresholds(s);
    return s.boost;
  }

  /** Remember which (model, upstream) served this conversation — used for cache-aware stickiness. */
  noteRouted(key: string, model: string, upstream: string): void {
    const s = this.state(key);
    s.lastModel = model;
    s.lastUpstream = upstream;
  }

  /** The (model, upstream) whose prompt cache is warm for this conversation, if any. */
  lastRoute(key: string): { model: string; upstream: string } | null {
    const s = this.convos.get(key);
    return s?.lastModel && s?.lastUpstream ? { model: s.lastModel, upstream: s.lastUpstream } : null;
  }

  /** Report the outcome of the upstream call for this conversation. */
  observeOutcome(key: string, outcome: "ok" | "failure" | "refusal"): void {
    const s = this.state(key);
    s.lastSeen = Date.now();
    if (outcome === "ok") {
      s.successes++;
      if (s.successes >= this.config.successesPerDecay && s.boost > 0) {
        s.boost--;
        s.successes = 0;
      }
    } else {
      s.signals += outcome === "refusal" ? 2 : 1;
      s.successes = 0;
      this.applyThresholds(s);
    }
  }

  private applyThresholds(s: ConvoState): void {
    while (s.signals >= this.config.signalsPerBoost && s.boost < this.config.maxBoost) {
      s.signals -= this.config.signalsPerBoost;
      s.boost++;
      s.successes = 0;
    }
    s.signals = Math.min(s.signals, this.config.signalsPerBoost); // don't bank unbounded signals
  }

  private gc(): void {
    if (this.convos.size < 512) return;
    const cutoff = Date.now() - this.config.ttlMs;
    for (const [k, s] of this.convos) {
      if (s.lastSeen < cutoff) this.convos.delete(k);
    }
  }

  /** For /api/escalations — currently boosted conversations. */
  snapshot(): Array<{ conversation: string; boost: number; signals: number; lastSeen: string }> {
    const cutoff = Date.now() - this.config.ttlMs;
    return [...this.convos.entries()]
      .filter(([, s]) => s.lastSeen >= cutoff && (s.boost > 0 || s.signals > 0))
      .map(([k, s]) => ({ conversation: k, boost: s.boost, signals: s.signals, lastSeen: new Date(s.lastSeen).toISOString() }));
  }
}
