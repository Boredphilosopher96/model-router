# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-07-05

### Added

- **Automatic failover** — retryable upstream errors (429, 5xx, unreachable) are retried on up to two next-best (model, upstream) pairs before surfacing; safe for streaming because failures surface at response headers before body bytes reach the client; response header `x-router-failover: <n>` marks which attempt served; disable with `FAILOVER=false`.
- **Rate-limit awareness** — provider rate-limit headers (anthropic-ratelimit-* and x-ratelimit-*) parsed on every response; upstreams reporting < 5% budget remaining are soft-throttled for 30 seconds (deprioritized like open circuit, still fail-open); `/api/upstream-health` entries now include `rateRemaining` and `throttled` fields.
- **Streaming cache replay** — streaming responses are now cached as raw SSE and replayed byte-for-byte on identical requests with `x-router-cache: hit`; streams over 2 MB not cached; stream and non-stream variants cached separately; calibration now samples streamed responses by reassembling text from SSE deltas.
- **Cache normalization** (default on, `CACHE_NORMALIZE=false` to disable) — volatile bytes (ISO timestamps, bare dates, 13-digit epoch millis, UUIDs, long hex ids) normalized out of the cache key so near-identical requests hit the cache; the request itself is never modified, only the hash input.
- **Persistent conversation state** — escalation boosts and warm-prompt-cache mapping (which model last served each conversation) now persist in the SQLite file (DB_PATH), so a proxy restart no longer causes cache-blowing model switches; conversations idle past the 30-minute TTL are purged at startup.
- **Context pruning plugin** (opt-in via `PLUGIN_PRUNE=true` or `prunePlugin()` in config/library) — truncates oversized `tool_result` blocks in old turns of very long conversations (history > 30k tokens); cache-aware: by default ("whenCold" mode) only prunes when the conversation has no warm provider cache to lose, avoiding expensive cold re-reads; "always" mode overrides; options include minHistoryTokens, keepRecentTurns, maxToolResultChars, mode.
- **Content-aware token estimation** — replaces chars/4 approximation with single-pass estimator: CJK ~1 char/token, structural/code characters ~1.5 chars/token, prose ~4.2; improves cost estimates, stay-vs-switch math, and context-fit checks; exported as `estimateTextTokens` and `estimateValueTokens` from library API.
- **New environment variables** — `FAILOVER` (default true), `CACHE_NORMALIZE` (default true), `PLUGIN_PRUNE` (default false).

### Changed

- **Response cache** — now caches both streaming and non-streaming responses; streaming caching requires careful monitoring of memory usage for high-throughput proxies.
- **Escalation signal deduplication** — escalation now counts at most ONE failure signal per request (only when every candidate fails); per-upstream penalties go to the health tracker instead, preventing multi-count against a single request's retries.

### Fixed

- **Escalation no longer multi-counts a single request's upstream retries** — with failover enabled, a single request may be retried across multiple upstreams; only the final failure (if all candidates fail) counts toward escalation, not each individual retry.

## [1.2.0] - 2026-07-05

### Added

- **Shadow mode** — run an alternative routing mode and/or strategy on real traffic without applying it; compare decision agreement and estimated cost delta via `GET /api/router-eval` before switching live; response header `x-router-shadow-model` reveals the shadow's model choice per request.
- **Budgets** — declare daily, monthly, and per-upstream daily spend limits in config; routing mode tightens automatically as the most-constrained window fills (<70% unchanged, 70-90% one notch tighter, >=90% aggressive); never blocks traffic; observable at `GET /api/budget` and `x-router-budget-used` / `x-router-mode` headers.
- **Upstream health monitoring** — per-upstream circuit breaker (opens after 5 failures in 60s, half-open probe for recovery) and EWMA latency tracking; open-circuit upstreams skipped unless all candidates exhausted (fail-open); when two candidates cost within 2%, lower-latency upstream wins; status at `GET /api/upstream-health`.
- **Quality calibration** — continuous measurement of downgrade adequacy; samples downgraded non-streaming responses at a configurable rate; background grading by frontier-tier model; per-task type +1 tier recommendation when adequacy < 0.8 with >=5 samples; apply automatically (if enabled) or inspect at `GET /api/calibration`.
- **`model-router setup` command** — `model-router setup <harness> [--write]` prints exact harness configuration or applies it automatically (--write merges `./opencode.json` and appends to `~/.codex/config.toml` with backups); supports claude-code, codex, opencode, copilot, pi.

### Changed

- **New response headers** — `x-router-budget-used`, `x-router-mode` (when budget-tightened), `x-router-shadow-model` (when shadow enabled).
- **Documentation** — new sections in `docs/routing.md` for shadow mode, budgets, upstream health, and quality calibration; expanded `docs/configuration.md` with config sections and env vars for all five features; added observability endpoints in `docs/http-api.md`; new "One-command setup" section in `docs/harnesses.md`.

## [1.1.0] - 2026-07-05

### Added

- **Pluggable routing strategy** — configurable classification stage before pair selection: default "heuristic" chains user taskRules (regexes), task taxonomy extraction, and structural signals; optional "llm" strategy delegates to a tier-1 model (cached per conversation, 2s timeout, falls back to heuristic).
- **Task rules** — regex-based rules in config (`taskRules`) with pattern, tier, and taskType to override default complexity scoring.
- **Cache-aware pair ranking** — estimated request cost accounts for cached input tokens at reduced rates (~10% of full rate); long conversations stick to warm models unless switching genuinely saves money; decisions carry `sticky: true` flag.
- **Quality mode** (`ROUTER_MODE=quality`) — refuses downgrade when classifier confidence < 0.65, for workflows where wrong answers cost more than latency.
- **Plugin priority and match scoping** — `priority` field orders plugins (lower runs first); `match` field filters by mounts, dialects, and model globs; enables coexistence with harness and provider-specific plugins.
- **composePlugins()** — utility to merge multiple plugins with stable priority and match scope.
- **Provider presets** — shorthand provider syntax (`"providers": ["anthropic"]`) and expanded object form with preset support (anthropic, openai, github-copilot, github-models, openrouter); explicit fields override preset defaults.
- **Per-upstream crossProvider** — `crossProvider: true` on an upstream lets the router swap vendors (Claude ↔ GPT) within that endpoint's dialect when `ROUTER_CROSS_PROVIDER=true`.
- **Evaluation API** (`GET /api/router-eval`) — metrics on downgradeRate, stickyRate, escalationRate, regretRate (share of downgraded conversations that later escalated), breakdown by taskType and tier distribution; dashboard includes "Router performance" section.
- **Task type in context** — plugins receive `ctx.taskType` from the routing strategy.
- **New response headers** — `x-router-task` (always), `x-router-sticky` (when sticky), `x-router-escalation` updated to `x-router-escalation-boost`.
- **Stats persistence** — recorded decisions now include taskType, complexity, requiredTier, boost, sticky flag, and conversation key for post-hoc analysis.

### Changed

- **ROUTER_MODE behaviors** — `balanced` now targets one tier below ceiling (was two); `quality` mode added as a new tier-1-aware option.
- **ROUTER_STRATEGY env** — new env var to select classification strategy (heuristic | llm).
- **Model catalog** — added `cachedInputPer1M` field for cache-aware cost estimation.
- **Pricing resolution** — feed now supplies cache_read_input_token_cost; all recognized gateways (including GitHub Copilot) priced at per-token rates from the live feed.

### Fixed

- **GitHub Copilot flat-rate assumption removed** — Copilot has billed per token via AI credits since June 2026 (1 credit = $0.01, roughly API-parity per-model rates). The router now prices it from the live feed, falling back to catalog rates; feed entries without costs count as availability data only, never as "free". Documentation updated accordingly.
- **Stray empty test artifacts** — removed unused mock data files from test suite.

## [1.0.0] - 2026-07-04

### Added

- **Multi-upstream dialect-aware routing** — route requests across Anthropic, OpenAI, and custom gateway endpoints with per-provider mount paths (`/p/<name>/v1/...`); dialect detection from request path automatically constrains candidates.
- **Cheapest capable model selection** — model complexity heuristic picks minimum capability tier (1–4) based on prompt size, tool count, turn depth, output size, and task keywords; router scans all (model, upstream) pairs and selects by effective price.
- **Automatic pricing** — feed-driven gateway pricing includes GitHub Copilot subscription detection (zero marginal cost), catalog fallback for known vendors, and per-upstream custom pricing for private models; manual `priceMultiplier` override available only.
- **Conversation escalation** — stuck conversations (upstream 429/5xx, tool refusals, `is_error` results, retry loops) receive tier boosts that can exceed the requested model; boosts decay after sustained success; monitor via `/api/escalations`.
- **Auto model** — harnesses can request model `"auto"` to delegate the entire model choice to the router per request; responses report the real routed model in headers and (for auto requests only) in the response body.
- **Model allowlist** — restrict routing targets via `allowedModels` globs in config; models outside the allowlist still pass through, just never get picked; requests for disallowed models fail open.
- **Capability-aware routing** — vision/document/audio requests only route to vision-capable models; tool-calling requests only to tool-capable models; capability flags sourced from the live feed and custom upstream config.
- **Response cache** (SQLite, TTL) — identical requests bypass all upstreams; streaming requests are never cached; cache hit/miss/bypass reported in `x-router-cache` header.
- **Savings dashboard** — live HTML page showing downgraded request count, dollars saved vs. requested model, cache hit rate, per-model request/cost/downgrade tables, and per-route downgrade matrices.
- **Stats API** (`/api/stats`) — JSON endpoint with request counts, cache metrics, token totals, actual vs. baseline cost, downgraded request breakdown by model and route, and historical timeline.
- **Plugin pipeline** — request/response/routing hooks (`onRequest`, `onRouteDecision`, `onResponse`, `onRecord`) for telemetry, budgets, policy enforcement, and custom transforms; plugins loaded from config or programmatically; bundled logger and JSON-to-TOON prompt compressor plugins.
- **Upstream adapters** — escape hatch for gateways with nonstandard request/response JSON; per-upstream `adapter` module can reshape payloads and extract usage; only hooks you define run.
- **Self-updating model catalog** — model list and prices refresh daily from the community-maintained LiteLLM feed; new model generations automatically supersede old ones; compiled-in defaults (verified July 2026) are the floor; configurable refresh interval and feed URL.
- **SSE streaming passthrough** — streaming requests (`stream: true`) pass through byte-for-byte from upstream; router tees responses to extract usage for stats; streaming never cached; `model` field inside stream events not rewritten (truth in headers).
- **Harness-blind response model rewrite** — responses report the model the harness asked for; the truth is in `x-router-routed-model` / `x-router-upstream` / `x-router-reason` headers and the dashboard (except auto requests report the real model).
- **Observability endpoints** — `/health`, `/api/stats`, `/api/models`, `/api/upstreams`, `/api/escalations`, `/api/plugins`, `/dashboard` with JSON and HTML views.
- **Cross-harness mounting** — Claude Code, opencode, Codex CLI, GitHub Copilot BYOK all point their LLM base URLs at the proxy; dialect and authentication forwarded to home upstream only.

### Documentation

- **docs/harnesses.md** — per-harness setup guide for Claude Code, opencode, Codex CLI, GitHub Copilot, and generic tools.
- **docs/http-api.md** — inference endpoint behavior, request processing pipeline, response headers, error semantics, and observability API reference.
- **CONTRIBUTING.md** — prerequisites, development workflow, quality gates, code style, and project layout.
