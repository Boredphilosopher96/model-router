# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
