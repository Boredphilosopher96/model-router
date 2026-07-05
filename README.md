<div align="center">

# model-router

**A harness-blind man-in-the-middle that cuts your LLM spend.**

It sits between any coding agent and any number of model endpoints, looks at each request, and redirects it to the cheapest model and endpoint that can handle it — swapping only the model string, never the request format.

[![CI](https://github.com/Boredphilosopher96/model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Boredphilosopher96/model-router/actions/workflows/ci.yml) [![runtime](https://img.shields.io/badge/runtime-bun%20%E2%89%A5%201.1-black)]() [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![types](https://img.shields.io/badge/types-strict-3178c6)]()

</div>

```
                        ┌──────────────────────────┐      ┌─ anthropic api (claude-*)
 Claude Code ──┐        │       model-router       │      ├─ github copilot (flat-rate)
 opencode ─────┼──────► │  dialect-aware routing   │ ───► ├─ your gateway (both dialects)
 Codex CLI ────┤        │  cache · escalation ·    │      ├─ openrouter
 Copilot BYOK ─┘        │  savings · plugins       │      └─ openai api (gpt-*)
                        └──────────────────────────┘
```

## Why

Coding agents default to expensive frontier models for every request — including the trivial ones. And if you run several providers (a Copilot subscription, direct APIs, an internal gateway), the cheapest way to serve any given request keeps shifting. model-router makes that decision per request, invisibly:

- **Cheapest capable (model, endpoint) pair.** A complexity heuristic picks the minimum capability tier; the router scans every endpoint that speaks the request's dialect and picks by effective price. A flat-rate subscription endpoint (like GitHub Copilot — priced automatically from a live feed) wins everything it can serve.
- **Escalates when stuck.** Repeated failures, erroring tool calls, or retry loops bump that conversation up a tier — even above the model it asked for — then decay back after sustained success.
- **Never gets stale.** The model catalog, prices, capability flags, and gateway availability refresh daily from a maintained feed. New model generations supersede old ones automatically. Zero manual updates.
- **Never gets in the way.** Unknown models, unparseable requests, feed outages, broken plugins — everything fails open and passes through. Provider errors reach your harness untouched.
- **Proves the savings.** Every request is logged with actual cost vs. what the requested model would have cost, on a live dashboard.

Harness-blind means your agent never knows: responses report the model it asked for; the truth lives in `x-router-*` response headers and the dashboard.

## Quick start

```sh
git clone https://github.com/Boredphilosopher96/model-router && cd model-router
bun install
ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... bun start
```

Point a harness at it and watch the dashboard:

```sh
ANTHROPIC_BASE_URL=http://localhost:4141 claude     # Claude Code
open http://localhost:4141/dashboard
```

That's the whole minimal setup — with no config file, the proxy fronts the direct Anthropic and OpenAI APIs. To route across multiple providers (Copilot, gateways, internal backends), declare them:

```sh
cp router.config.example.json router.config.json    # then edit
```

```jsonc
{
  "allowedModels": ["claude-haiku-*", "claude-sonnet-*", "claude-opus-*", "gpt-5.4-*", "gpt-5.5"],
  "providers": [
    { "name": "anthropic", "baseUrl": "https://api.anthropic.com", "dialect": "anthropic",
      "models": ["claude-*"], "apiKeyEnv": "ANTHROPIC_API_KEY", "default": true },

    // Copilot: no model list or pricing needed — recognized host, feed-driven,
    // subscription counts as zero marginal cost so it wins whatever it serves.
    { "name": "copilot", "baseUrl": "https://api.githubcopilot.com", "dialect": "openai",
      "authStyle": "passthrough", "stripV1": true },

    { "name": "mygateway", "baseUrl": "https://llm.internal.example.com", "dialect": "both",
      "models": ["claude-*", "gpt-*", "my-private-model"],
      "apiKeyEnv": "MYGATEWAY_API_KEY", "authStyle": "bearer",
      "pricing": { "my-private-model": { "inputPer1M": 0.5, "outputPer1M": 2.0, "tier": 2 } } }
  ]
}
```

Each provider becomes a mount — point each harness provider at `http://localhost:4141/p/<name>`, and the router redirects between all of them.

## Features

| | |
|---|---|
| **Cost routing** | Cheapest capable (model, endpoint) pair per request; requested model is the spend ceiling; three modes (`aggressive` / `balanced` / `off`) |
| **Automatic pricing** | Live feed for known gateways (Copilot subscription detected as zero marginal cost); catalog API pricing assumed for custom gateways; `pricing` entries for private models |
| **Escalation** | Stuck conversations bump up a tier and settle back; observable at `/api/escalations` |
| **`auto` model** | Advertised via `GET /v1/models`; selecting it delegates the whole choice to the router |
| **Model allowlist** | `allowedModels` globs restrict routing targets; everything else still passes through |
| **Multimodal-safe** | Image/document/audio requests only route to vision-capable models; tool-calling requests only to tool-capable models |
| **Response cache** | SQLite, TTL-based; identical requests are served for free |
| **Plugins** | `onRequest` / `onRouteDecision` / `onResponse` / `onRecord` hooks; loadable from config without forking |
| **Adapters** | Per-upstream request/response reshaping for gateways with nonstandard JSON |
| **Dashboard** | Money saved, downgrades, cache hit rate, per-model and per-route breakdowns |
| **Streaming** | Byte-for-byte SSE passthrough with usage teed out for stats |

## Documentation

| Guide | Contents |
|---|---|
| [Connecting harnesses](docs/harnesses.md) | Claude Code, opencode, Codex CLI, Copilot BYOK, generic setup; verifying with headers |
| [Configuration reference](docs/configuration.md) | Every env var and `router.config.json` field; pricing resolution; allowlist semantics |
| [How routing works](docs/routing.md) | Complexity scoring, tiers, escalation mechanics, fail-open guarantees |
| [Extending](docs/extending.md) | Writing plugins, upstream adapters, custom models/pricing, library API |
| [HTTP API reference](docs/http-api.md) | Endpoints, response headers, observability APIs, error semantics |

Working templates ship in [`examples/`](examples): a telemetry plugin and a gateway adapter.

## Requirements & operations

- **Runtime:** [Bun](https://bun.sh) ≥ 1.1 (uses `bun:sqlite`, `Bun.serve`).
- **State:** one SQLite file (`DB_PATH`) for cache + stats, one JSON file for the price-feed cache. Delete either at any time; the proxy rebuilds them.
- **Shutdown:** SIGINT/SIGTERM close the server gracefully.
- **Health:** `GET /health` for liveness; `GET /api/stats` for metrics scraping.
- **Security notes:** the proxy forwards a harness's own credentials only to the upstream they were meant for; cross-upstream redirects require that upstream's own configured key. Run it on localhost or inside your network perimeter — it is a credential-bearing proxy and ships without inbound auth.

## Development

```sh
bun test           # 80 unit + integration tests (mock upstreams, no network)
bun run typecheck  # strict tsc
bun run dev        # watch mode
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and conventions, and [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE) © 2026 Sumukh Nitundila
