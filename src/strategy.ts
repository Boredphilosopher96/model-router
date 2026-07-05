import type { RouterConfig } from "./types.ts";

/**
 * Routing strategies: classify a request into a task type and a minimum
 * capability tier. Design follows production routing practice:
 *
 *   1. user-defined rules (deterministic, auditable — first match wins)
 *   2. trivial bypass (cheap fast path for obviously-simple requests)
 *   3. task taxonomy (keyword banks over the latest user intent)
 *   4. structural signals (tools, media, output size, code density,
 *      conversation/agentic depth) adjusting the taxonomy verdict
 *
 * The optional LLM strategy asks a tier-1 model once per conversation and
 * falls back to the heuristic on error or timeout. Escalation (cascade on
 * observed failure) is layered on top by the router, so misclassification
 * self-corrects.
 */

export interface Classification {
  taskType: string;
  requiredTier: 1 | 2 | 3 | 4;
  /** Continuous difficulty signal in [0, 1] (kept for stats/eval). */
  complexity: number;
  /** How sure the classifier is; low confidence keeps higher tiers in quality mode. */
  confidence: number;
  reasons: string[];
}

export interface RoutingStrategy {
  name: string;
  classify(body: any, conversationKey: string): Classification | Promise<Classification>;
}

/** Normalize the turn list across all three request dialects. */
export function turnsOf(body: any): any[] {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  if (typeof body?.input === "string") return [{ role: "user", content: body.input }];
  return [];
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return "";
}

export function lastUserText(body: any): string {
  const turns = turnsOf(body);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === "user") {
      const t = textOf(turns[i].content);
      if (t.trim()) return t;
    }
  }
  return "";
}

/** Task taxonomy: keyword banks -> (taskType, base tier). Order matters — first hit wins. */
const TAXONOMY: Array<{ taskType: string; tier: 1 | 2 | 3 | 4; pattern: RegExp }> = [
  { taskType: "architecture", tier: 3, pattern: /\b(architect(ure)?|system design|design (a|the) (system|schema|api)|security (audit|review)|threat model|migrat(e|ion) (the|our|this)|scalab\w+|trade-?offs?)\b/i },
  { taskType: "deep-reasoning", tier: 3, pattern: /\b(prove|theorem|formal(ly)? verif\w+|complexity analysis|from first principles|research question)\b/i },
  { taskType: "debug", tier: 2, pattern: /\b(debug|root cause|stack ?trace|segfault|race condition|deadlock|memory leak|why (is|does|isn'?t|doesn'?t).{0,40}(fail|break|crash|error|wrong)|not working|reproduce)\b/i },
  { taskType: "codegen", tier: 2, pattern: /\b(implement|refactor|write (a|the|some)? ?(test|function|class|module|script|component)|add (a|the)? ?(feature|endpoint|route|flag)|fix (the|this)? ?(bug|issue|test)|optimi[sz]e)\b/i },
  { taskType: "summarize", tier: 1, pattern: /\b(summari[sz]e|tl;?dr|key (points|takeaways)|gist of)\b/i },
  { taskType: "extract", tier: 1, pattern: /\b(extract|parse|convert (this|the|to)|reformat|translate (this|the|to)|classif(y|ication)|label (the|these))\b/i },
  { taskType: "lookup", tier: 1, pattern: /^\s*(what|where|when|who|which|how (do|does|can) (i|you|we)\b|is there|does|list|show|find|grep|read|cat|explain briefly)\b/i },
  { taskType: "edit", tier: 1, pattern: /\b(rename|typo|bump (the )?version|update (the )?(comment|readme|changelog)|one-?lin(e|er)|small (change|tweak)|quick fix)\b/i },
];

/** Structural signals, each in [0, 1]. */
export function structuralSignals(body: any): Record<string, number> {
  const turns = turnsOf(body);
  let promptChars = 0;
  let codeFences = 0;
  let toolResults = 0;
  for (const m of turns) {
    const t = textOf(m?.content);
    promptChars += t.length;
    codeFences += (t.match(/```/g) ?? []).length / 2;
    if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_result" || b?.type === "function_call_output") toolResults++;
        if (b?.type === "image" || b?.type === "document" || b?.type === "image_url" || b?.type === "input_image" || b?.type === "input_file") promptChars += 4000;
      }
    }
  }
  const system = (typeof body?.system === "string" ? body.system : "") + (typeof body?.instructions === "string" ? body.instructions : "");
  promptChars += system.length;
  const maxTokens = Number(body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? 0);

  return {
    size: Math.min(promptChars / 60_000, 1),
    tools: Math.min((Array.isArray(body?.tools) ? body.tools.length : 0) / 8, 1),
    turns: Math.min(turns.length / 30, 1),
    output: Math.min(maxTokens / 32_000, 1),
    code: Math.min(codeFences / 6, 1),
    agentic: Math.min(toolResults / 10, 1),
  };
}

export interface HeuristicOptions {
  taskRules?: RouterConfig["taskRules"];
}

export function heuristicStrategy(options: HeuristicOptions = {}): RoutingStrategy {
  return {
    name: "heuristic",
    classify(body: any): Classification {
      const reasons: string[] = [];
      const text = lastUserText(body);
      const sig = structuralSignals(body);
      const complexity = Math.min(
        0.3 * sig.size! + 0.15 * sig.tools! + 0.1 * sig.turns! + 0.15 * sig.output! + 0.15 * sig.code! + 0.15 * sig.agentic!,
        1,
      );

      // 1. User rules: deterministic, first match wins.
      for (const rule of options.taskRules ?? []) {
        try {
          if (new RegExp(rule.pattern, "i").test(text)) {
            reasons.push(`rule /${rule.pattern}/ -> tier ${rule.tier}`);
            return { taskType: rule.taskType ?? "custom", requiredTier: rule.tier, complexity, confidence: 0.95, reasons };
          }
        } catch {
          // invalid user regex — skip it
        }
      }

      // 2. Task taxonomy over the latest user intent — intent beats size:
      // a five-word "why does this deadlock?" is still a debug task.
      let taskType = "chat";
      let tier: 1 | 2 | 3 | 4 = 1;
      let confidence = 0.5;
      for (const entry of TAXONOMY) {
        if (entry.pattern.test(text)) {
          taskType = entry.taskType;
          tier = entry.tier;
          confidence = 0.75;
          reasons.push(`taxonomy: ${entry.taskType} -> tier ${entry.tier}`);
          break;
        }
      }

      // 3. Trivial bypass — only when the taxonomy found nothing demanding:
      // a short single-turn ask with no structure around it.
      const turns = turnsOf(body);
      if (tier === 1 && turns.length <= 2 && text.length < 300 && sig.tools! === 0 && sig.code! === 0 && sig.size! < 0.05) {
        reasons.push("trivial bypass: short single-turn request");
        return { taskType: taskType === "chat" ? "chat" : taskType, requiredTier: 1, complexity, confidence: 0.9, reasons };
      }

      // 4. Structural adjustments to the taxonomy verdict.
      let adjust = 0;
      if (sig.size! > 0.5 || sig.output! > 0.6) adjust++;
      if (sig.agentic! > 0.5 && tier < 2) adjust++; // sustained agentic execution deserves >= tier 2
      if (sig.tools! > 0.6 && sig.code! > 0.4) adjust++;
      if (complexity > 0.75) adjust++;
      if (adjust > 0) reasons.push(`structural signals +${adjust}`);

      const requiredTier = Math.min(Math.max(tier + adjust, 1), 4) as 1 | 2 | 3 | 4;
      // Agreement between taxonomy and signals raises confidence; conflict lowers it.
      if (adjust >= 2) confidence = Math.max(confidence - 0.15, 0.35);
      return { taskType, requiredTier, complexity, confidence, reasons };
    },
  };
}

/**
 * LLM classifier: asks a small model once per conversation (result cached by
 * conversation key), falling back to the heuristic on any failure. `complete`
 * is injected by the server and runs on a tier-1 model through the normal
 * upstream pool.
 */
export function llmStrategy(
  complete: (prompt: string) => Promise<string>,
  fallback: RoutingStrategy,
  timeoutMs = 2000,
): RoutingStrategy {
  const cache = new Map<string, Classification>();
  return {
    name: "llm",
    async classify(body: any, conversationKey: string): Promise<Classification> {
      const cached = cache.get(conversationKey);
      if (cached) return { ...cached, reasons: [...cached.reasons, "cached decision"] };

      const heuristic = await fallback.classify(body, conversationKey);
      const text = lastUserText(body).slice(0, 1500);
      if (!text) return heuristic;

      const prompt =
        `Classify this request to a coding assistant by difficulty tier:\n` +
        `1=trivial lookup/small edit, 2=standard implementation/debugging, ` +
        `3=architecture/complex debugging/deep analysis, 4=frontier-hard reasoning.\n` +
        `Respond with ONLY JSON: {"tier": <1-4>, "task": "<one word>"}\n\nRequest:\n${text}`;

      try {
        const raw = await Promise.race([
          complete(prompt),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("classifier timeout")), timeoutMs)),
        ]);
        const match = raw.match(/\{[^}]*\}/);
        const parsed = JSON.parse(match?.[0] ?? "{}");
        const tier = Math.min(Math.max(Number(parsed.tier) || heuristic.requiredTier, 1), 4) as 1 | 2 | 3 | 4;
        const result: Classification = {
          taskType: typeof parsed.task === "string" ? parsed.task.toLowerCase().slice(0, 24) : heuristic.taskType,
          requiredTier: tier,
          complexity: heuristic.complexity,
          confidence: 0.85,
          reasons: [`llm classifier -> tier ${tier}`],
        };
        cache.set(conversationKey, result);
        if (cache.size > 2000) cache.delete(cache.keys().next().value!);
        return result;
      } catch (err) {
        return { ...heuristic, reasons: [...heuristic.reasons, `llm classifier failed (${String(err)}), used heuristic`] };
      }
    },
  };
}
