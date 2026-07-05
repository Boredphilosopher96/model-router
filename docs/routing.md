# How routing works

Every inference request goes through the same pipeline. The design constraint behind all of it: **only the model string is ever swapped — the request format is never translated.** An Anthropic-dialect request only goes to endpoints that accept the Anthropic format; likewise for OpenAI.

## 1. Dialect detection

The path determines the wire format: `/v1/messages` is Anthropic dialect; `/v1/chat/completions` and `/v1/responses` are OpenAI dialect. The mount (`/p/<name>` prefix, or the dialect's `default` upstream for bare paths) determines the request's **home** upstream.

## 2. Strategy stage — classify the task

Before ranking models, the router runs a pluggable classification strategy to determine `{taskType, requiredTier, complexity, confidence}`:

**Default "heuristic" strategy** chains four signals:

1. **User-defined task rules** — `taskRules` in config (regexes + tier/taskType); first match wins. Skip to step 2 if no match.
2. **Task taxonomy** — keyword banks (regexes) over the latest user message; intent beats size, so a five-word "why does this deadlock?" still classifies as debug. Lookup/summarize/extract/edit → tier 1; codegen/debug → tier 2; architecture/deep-reasoning → tier 3.
3. **Trivial bypass** — only when the taxonomy found nothing demanding: a short single-turn ask with no tools, code, or bulk lands on tier 1 with high confidence.
4. **Structural signals** — adjust the tier upward based on prompt size, tool count, conversation depth, output budget, code-fence density, and agentic depth (via `tool_result` count in history).

The result is a classification record with confidence 0–1; the router uses it to set the tier floor.

**Optional "llm" strategy** (`ROUTER_STRATEGY=llm`): a tier-1 model classifies each new conversation once, with result cached per conversation (2-second timeout, falls back to heuristic if it times out). Useful when task intent varies sharply from the prompt's surface signals.

## 3. Complexity → tier floor

The heuristic strategy computes a complexity score 0–1 from structural signals:

| Signal | Saturates at |
|---|---|
| Prompt size (text across all turns; media blocks add weight) | ~60k chars |
| Tool count | 8 tools |
| Conversation depth | 30 turns |
| Requested output (`max_tokens` / `max_output_tokens`) | 32k tokens |
| Code-fence density | 6 fenced blocks |
| Agentic depth (`tool_result` blocks in history) | 10 prior tool calls |

Structural signals adjust the taxonomy tier upward (they never lower it): very large prompts or output budgets, heavy tool+code use, and sustained agentic execution each add a tier step. The continuous score is also persisted per request for evaluation.

## 4. Tier floor and ceiling

- **Tier floor** is set by the strategy result (taskType, requiredTier, and complexity).
- **Tier ceiling** is the requested model's tier — the router downgrades, never upgrades.
- **`auto` has no ceiling**: the router picks freely.
- **`quality` mode** raises the floor and adds a confidence gate: refuses downgrade when classifier confidence < 0.65.
- **`balanced` mode** raises the floor to one tier below the ceiling (conservative).
- **`aggressive` mode** (default) downgrades to floor if cost savings justify it.
- **Escalation** (below) can raise both floor and ceiling — that is the one sanctioned way above the ceiling.

## 5. Capability constraints

Requests carrying images, documents, or audio only route to models with `vision` support; requests declaring tools only route to models with `toolUse` support. Capability flags come from the live feed; unknown capability fails open (assumed capable).

## 6. Cache-aware pair ranking

Candidates are every (model, upstream) combination where:

- the model meets the tier floor/ceiling, fits the context window (with 20% headroom), passes capability checks, is enabled, and is on the allowlist;
- the model stays in the requested model's vendor family (Claude→Claude), unless `ROUTER_CROSS_PROVIDER=true` and the dialect is OpenAI;
- the upstream speaks the request's dialect, serves the model, and is either the request's home or has its own configured credentials.

Pairs are sorted by **estimated request cost**, accounting for response caching:

- **If the (model, upstream) pair last served this conversation**, its cached history tokens bill at the upstream's cached-input rate (typically ~10% of full input rate, sourced from the feed's `cache_read_input_token_cost` or 0.1x default).
- **If switching to a new (model, upstream)**, the entire conversation history re-feeds at full input cost.

Consequence: long conversations stick to their current model unless switching genuinely saves money; short conversations can switch freely. When a decision sticks for cache cost reasons, the response includes `x-router-sticky: 1` and the decision record carries `sticky: true`.

**Worked example** (catalog rates): a conversation has 400k tokens of history, warm on Claude Opus 4.8 ($5.00/1M input, $0.50/1M cached input). A trivial follow-up arrives.

- Stay on Opus: 400k x $0.50/1M = **$0.20** for the history (plus a little fresh input/output).
- Switch to Haiku 4.5 ($1.00/1M input): 400k x $1.00/1M = **$0.40** — the whole history re-feeds cold.

Staying on the "expensive" model is half the price, so the router sticks (`sticky: true`). Early in a conversation the history is small, the cache advantage is negligible, and the cheap model wins as usual.

Ties prefer the home upstream. The winner's model id is written in the form that upstream expects (namespace style preserved, `vendorPrefix` applied).

## 7. Escalation — bumping when stuck

The tracker keys conversations by a stable fingerprint (system prompt + first user turn), so a growing conversation keeps its identity across requests. Signals that a conversation is struggling:

- upstream failures (429/5xx) and provider refusals,
- `is_error: true` tool results flowing back in (the model's tool calls are failing),
- loop suspicion: a deep conversation re-entering rapidly without growing.

Every 3 signals add +1 tier boost (max +2 by default); 4 clean responses remove one level; idle conversations are forgotten after 30 minutes. A boost raises the tier floor *and* ceiling, so a conversation stuck on a tier-1 model can be bumped to tier 2 or 3 even though it asked for the tier-1 model. Active boosts are visible at `GET /api/escalations` and on responses as `x-router-escalation`.

## 8. Shadow mode — safe strategy validation

Run a strategy change on real traffic before committing to it:

1. Configure an alternative `shadow.mode` and/or `shadow.strategy` in `router.config.json`.
2. The router evaluates every request twice in parallel: once live, once shadow.
3. The counterfactual (model and estimated cost) is recorded but never applied.
4. After a few days, query `GET /api/router-eval` for `shadow.agreementRate` and `shadow.estCostDeltaUsd`.
5. If shadow is winning (estCostDeltaUsd negative), apply it; otherwise iterate.

Response header `x-router-shadow-model` shows the shadow's model choice per request.

## 9. Budgets — automatic spend control

Declare daily, monthly, or per-upstream daily limits in `router.config.json` under `budgets`. As the most-depleted window fills, the router tightens the mode:

- <70% spent: no change.
- 70–90% spent: one notch tighter (aggressive → balanced → quality).
- >=90% spent: force aggressive (cheapest capable).

Mode `off` is never overridden. Traffic is never blocked — only routing mode tightens. Response headers `x-router-budget-used` (fraction) and `x-router-mode` (if tightened) track the constraint. Query `GET /api/budget` for current spend vs. limits.

## 10. Upstream health — circuit breaker and latency tie-break

Each upstream is monitored for latency (EWMA) and failure rate. When an upstream receives 5 failures in 60 seconds, its circuit opens for 30 seconds; a half-open probe tests recovery. Open-circuit upstreams are skipped during pair selection (unless all candidates are exhausted — fail-open).

When two (model, upstream) pairs have costs within 2% of each other, the lower-latency upstream wins the pair, then home upstream breaks ties. Upstream health is observable at `GET /api/upstream-health`.

## 11. Quality calibration — measure, grade, recommend, apply

Continuous measurement of downgrade adequacy over time:

1. **Sample** downgraded non-streaming responses at a configured rate (default 5%).
2. **Grade** each sample (after a 6-hour interval, default) using a frontier-tier model on an adequacy 0–1 scale.
3. **Recommend** per task type: if adequacy < 0.8 with >=5 graded samples, flag +1 tier recommendation.
4. **Apply** either automatically (if `calibration.apply: true`) or manually by inspecting `GET /api/calibration`.

Calibration never blocks or delays live requests (sampling is post-response, grading runs in the background). It complements `regretRate` metrics to tune downgrade strategy over time.

## 12. Fail-open guarantees

The router never blocks traffic it doesn't understand:

- unknown model id → passed through to the home upstream unchanged;
- `ROUTER_MODE=off` → no rerouting (cache/stats/plugins still active);
- feed down → last-known prices from the disk cache, compiled defaults as the floor;
- plugin/adapter failure → logged, skipped, request proceeds;
- upstream error → the provider's status and body pass through untouched so the harness sees the real failure.

## Evaluation loop

Monitor router decisions via `GET /api/router-eval`:

```json
{
  "totalDecisions": 15420,
  "downgradeRate": 0.42,
  "stickyRate": 0.11,
  "escalationRate": 0.03,
  "regretRate": 0.05,
  "byTaskType": [
    { "taskType": "codegen", "requests": 3200, "avgComplexity": 0.31,
      "avgRequiredTier": 2.1, "downgraded": 1750, "savedUsd": 4.21, "avgLatencyMs": 2100 },
    { "taskType": "lookup", "requests": 2100, "avgComplexity": 0.05,
      "avgRequiredTier": 1.0, "downgraded": 1960, "savedUsd": 2.02, "avgLatencyMs": 800 }
  ],
  "tierDistribution": [
    { "requiredTier": 1, "requests": 6200 },
    { "requiredTier": 2, "requests": 5300 }
  ]
}
```

Key metrics:

- **downgradeRate** — share of requests routed below the requested model's tier. High rate suggests you are scaling models conservatively; near-zero suggests the opposite.
- **stickyRate** — share of decisions where cache-aware ranking kept a conversation on its current (expensive) model. Signals conversation length and cost stability.
- **regretRate** — share of downgraded conversations that later escalated, indicating the router misjudged and the harness had to climb the tier. High regret (>0.10) means too aggressive; tune task rules or raise the floor.
- **byTaskType** — per-task breakdown; compare downgradeRate across types to refine rules.

The dashboard includes a "Router performance" section rendering these metrics and trends over time.

## Harness blindness

Responses report the `model` the harness asked for (except `auto`, which reports the real pick). The actual decision is exposed out-of-band: `x-router-requested-model`, `x-router-routed-model`, `x-router-upstream`, `x-router-reason`, `x-router-cache`, `x-router-escalation`, and `x-router-task` response headers, plus the dashboard and stats API. Streaming bodies are passed through untouched, so event payloads name the real model — the headers remain the source of truth. Sticky decisions also include `x-router-sticky: 1`.
