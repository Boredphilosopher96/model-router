# Contributing

We welcome contributions. This guide covers setup, quality gates, and code style.

## Prerequisites

- Bun >= 1.1
- Node.js 18+ (for compatibility, though Bun is the runtime)

## Setup

```bash
bun install
```

## Development

```bash
bun run dev          # watch mode with hot reload
bun test             # unit + integration tests (mock upstreams, no network)
bun run typecheck    # strict tsc with no-emit
```

## Quality gates

Before opening a pull request, ensure:

- **Tests pass** — `bun test` runs all unit and integration tests against mock upstreams (no network calls).
- **Type safety** — `bunx tsc --noEmit` must pass with strict mode; no `any` types without justification.
- **Code style** — match existing patterns: strict TypeScript, `.ts` import extensions (no `.js`), fail-open error handling (a plugin/adapter/feed failure must never break proxying).

## Code style

- **Import extensions** — always use `.ts` for local imports, never `.js`.
- **Error handling** — plugins, adapters, and feed updates are optional. If a plugin throws, log and skip it; if the price feed is unreachable, fall back to compiled defaults. Never let optional systems break the core proxy.
- **Type safety** — use strict TypeScript. Avoid `any`; use `unknown` and narrow. All public functions should have explicit return types.
- **Naming** — use camelCase for functions/variables, PascalCase for types/interfaces.
- **Comments** — prefer clear code; comment only non-obvious logic (plugin hooks, pricing edge cases, etc.).

## Project layout

| Path | Purpose |
|---|---|
| `src/server.ts` | HTTP server and request/response routing; main inference endpoint handlers and observability routes |
| `src/router.ts` | Routing decision logic: complexity → tier, escalation checks, (model, upstream) pair scoring and selection |
| `src/upstreams.ts` | Upstream pool, auth handling, per-upstream pricing, config loading, adapter lifecycle |
| `src/registry.ts` | Model catalog: fetch, merge, supersede, lookup by id; cost calculation |
| `src/pricefeed.ts` | LiteLLM feed polling, refresh scheduling, disk cache, compiled fallback |
| `src/escalation.ts` | Stuck-conversation detection: error counts, tool refusals, retry loops, tier boost decay |
| `src/cache.ts` | SQLite response cache: key generation, TTL eviction, hit/miss recording |
| `src/stats.ts` | SQLite stats store: request records, aggregation, timeline bucketing |
| `src/plugins/` | Plugin pipeline and bundled plugins (logger, TOON prompt compressor) |
| `tests/` | Unit and integration tests (mock upstream servers, no network) |

## Submitting a PR

1. Create a feature branch from `main`.
2. Make your changes and add tests for behavior changes.
3. Ensure all quality gates pass (`bun test`, `bun run typecheck`).
4. Open a PR with a clear description of what changed and why.

## License

All contributions are licensed under the MIT License (see LICENSE).
