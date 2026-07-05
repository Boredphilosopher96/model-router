# How routing works

Every inference request goes through the same pipeline. The design constraint behind all of it: **only the model string is ever swapped — the request format is never translated.** An Anthropic-dialect request only goes to endpoints that accept the Anthropic format; likewise for OpenAI.

## 1. Dialect detection

The path determines the wire format: `/v1/messages` is Anthropic dialect; `/v1/chat/completions` and `/v1/responses` are OpenAI dialect. The mount (`/p/<name>` prefix, or the dialect's `default` upstream for bare paths) determines the request's **home** upstream.

## 2. Complexity → required tier

`estimateComplexity()` scores the request 0–1 from independent signals, each saturating on its own scale:

| Signal | Saturates at |
|---|---|
| Prompt size (text across all turns; media blocks add weight) | ~60k chars |
| Tool count | 8 tools |
| Conversation depth | 30 turns |
| Requested output (`max_tokens` / `max_output_tokens`) | 32k tokens |
| Hard-task keywords in the last user turn (refactor, debug, architect, prove, …) | flat bonus |

The score maps to a minimum capability tier: `<0.25` → 1, `<0.5` → 2, `<0.75` → 3, else 4.

## 3. Ceiling and floor

- The **requested model's tier is the ceiling** — the router downgrades, never upgrades, so the model your harness asks for is the spend cap.
- **`auto` has no ceiling**: the router picks freely by complexity.
- **`balanced` mode** raises the floor to one tier below the requested model.
- **Escalation** (below) can raise both floor and ceiling — that is the one sanctioned way above the requested tier.

## 4. Capability constraints

Requests carrying images, documents, or audio only route to models with `vision` support; requests declaring tools only route to models with `toolUse` support. Capability flags come from the live feed; unknown capability fails open (assumed capable).

## 5. Pair selection

Candidates are every (model, upstream) combination where:

- the model meets the tier floor/ceiling, fits the context window (with 20% headroom), passes capability checks, is enabled, and is on the allowlist;
- the model stays in the requested model's vendor family (Claude→Claude), unless `ROUTER_CROSS_PROVIDER=true` and the dialect is OpenAI;
- the upstream speaks the request's dialect, serves the model, and is either the request's home or has its own configured credentials.

Pairs are sorted by **effective price** (see `docs/configuration.md` → How pricing resolves); ties prefer the home upstream. The winner's model id is written in the form that upstream expects (namespace style preserved, `vendorPrefix` applied).

## 6. Escalation — bumping when stuck

The tracker keys conversations by a stable fingerprint (system prompt + first user turn), so a growing conversation keeps its identity across requests. Signals that a conversation is struggling:

- upstream failures (429/5xx) and provider refusals,
- `is_error: true` tool results flowing back in (the model's tool calls are failing),
- loop suspicion: a deep conversation re-entering rapidly without growing.

Every 3 signals add +1 tier boost (max +2 by default); 4 clean responses remove one level; idle conversations are forgotten after 30 minutes. A boost raises the tier floor *and* ceiling, so a conversation stuck on a tier-1 model can be bumped to tier 2 or 3 even though it asked for the tier-1 model. Active boosts are visible at `GET /api/escalations` and on responses as `x-router-escalation`.

## 7. Fail-open guarantees

The router never blocks traffic it doesn't understand:

- unknown model id → passed through to the home upstream unchanged;
- `ROUTER_MODE=off` → no rerouting (cache/stats/plugins still active);
- feed down → last-known prices from the disk cache, compiled defaults as the floor;
- plugin/adapter failure → logged, skipped, request proceeds;
- upstream error → the provider's status and body pass through untouched so the harness sees the real failure.

## Harness blindness

Responses report the `model` the harness asked for (except `auto`, which reports the real pick). The actual decision is exposed out-of-band: `x-router-requested-model`, `x-router-routed-model`, `x-router-upstream`, `x-router-reason`, `x-router-cache`, `x-router-escalation` response headers, plus the dashboard and stats API. Streaming bodies are passed through untouched, so event payloads name the real model — the headers remain the source of truth.
