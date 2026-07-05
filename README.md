<div align="center">

# model-router

**A harness-blind man-in-the-middle that cuts your LLM spend.**

It sits between any coding agent and any number of model endpoints, looks at each request, and redirects it to the cheapest model and endpoint that can handle it — swapping only the model string, never the request format.

[![CI](https://github.com/Boredphilosopher96/model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Boredphilosopher96/model-router/actions/workflows/ci.yml) [![runtime](https://img.shields.io/badge/runtime-bun%20%E2%89%A5%201.1-black)]() [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![types](https://img.shields.io/badge/types-strict-3178c6)]()

</div>

```
                        ┌──────────────────────────┐      ┌─ anthropic api (claude-*)
 Claude Code ──┐        │       model-router       │      ├─ github copilot
 opencode ─────┼──────► │  dialect-aware routing   │ ───► ├─ your gateway (both dialects)
 Codex CLI ────┤        │  cache · escalation ·    │      ├─ openrouter
 Copilot BYOK ─┘        │  savings · plugins       │      └─ openai api (gpt-*)
                        └──────────────────────────┘
```

## Why

Coding agents default to expensive frontier models for every request — including the trivial ones. And if you run several providers (a Copilot subscription, direct APIs, an internal gateway), the cheapest way to serve any given request keeps shifting. model-router makes that decision per request, invisibly:

- **Content-aware task classification.** The router extracts intent from each request: lookup/summarize → tier 1, codegen/debug → tier 2, architecture/reasoning → tier 3. User-defined regex rules override. Optional LLM-based classification for complex patterns. Confidence gates prevent aggressive downgrade when unsure.
- **Cache-aware stickiness.** When a conversation has warm cache on an expensive model, staying put costs less than switching to a cheaper model cold. The router knows the difference and sticks only when it saves money — switching frequently for short tasks, staying put for long ones. Sticky decisions are labeled in headers.
- **Quality mode** — refuses downgrade when classifier confidence < 0.65, for workflows where "wrong answer faster" loses money.
- **Escalates when stuck.** Repeated failures, erroring tool calls, or retry loops bump that conversation up a tier — even above the model it asked for — then decay back after sustained success.
- **Presets for fast setup.** Declare providers by name (`"providers": ["anthropic", {"name":"copilot","preset":"github-copilot"}]`), inheriting defaults from built-in presets (Anthropic, OpenAI, GitHub Copilot, GitHub Models, OpenRouter).
- **Router performance dashboard.** Live metrics on downgrade rate, sticky rate, escalation rate, regret rate (downgraded conversations that later escalated — the router's misjudgment signal), breakdowns by task type, and tier distribution for tuning.
- **Never gets stale.** The model catalog, prices, capability flags, and gateway availability refresh daily from a maintained feed. GitHub Copilot prices via AI credits at per-token rates. New model generations automatically supersede old ones. Zero manual updates.
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
  "taskRules": [
    { "pattern": "\\b(deploy|release|promote)\\b", "tier": 3, "taskType": "release" }
  ],
  "providers": [
    "anthropic",
    { "name": "copilot", "preset": "github-copilot" },
    {
      "name": "mygateway", "baseUrl": "https://llm.internal.example.com", "dialect": "both",
      "models": ["claude-*", "gpt-*", "my-private-model"],
      "apiKeyEnv": "MYGATEWAY_API_KEY", "authStyle": "bearer",
      "pricing": { "my-private-model": { "inputPer1M": 0.5, "outputPer1M": 2.0, "tier": 2 } }
    }
  ]
}
```

Each provider becomes a mount — point each harness provider at `http://localhost:4141/p/<name>`, and the router redirects between all of them.

## Features

| | |
|---|---|
| **Cost routing** | Cheapest capable (model, endpoint) pair per request; requested model is the spend ceiling; four modes (`aggressive` / `balanced` / `quality` / `off`) |
| **Task classification** | Content-aware heuristic (regex rules → task taxonomy → structural signals) or optional LLM-based classifier; per-request taskType and confidence |
| **Cache-aware stickiness** | Long conversations stay on warm models only when it saves money; short tasks can switch freely. Sticky decisions labeled in response headers |
| **Quality mode** | Like `balanced` but refuses downgrade when classifier confidence < 0.65 |
| **Automatic pricing** | Live feed for known gateways; GitHub Copilot priced per token via AI credits; catalog API pricing assumed for custom gateways; `pricing` entries for private models |
| **Escalation** | Stuck conversations bump up a tier and settle back; observable at `/api/escalations` |
| **`auto` model** | Advertised via `GET /v1/models`; selecting it delegates the whole choice to the router |
| **Model allowlist** | `allowedModels` globs restrict routing targets; everything else still passes through |
| **Multimodal-safe** | Image/document/audio requests only route to vision-capable models; tool-calling requests only to tool-capable models |
| **Response cache** | SQLite, TTL-based; identical requests are served for free |
| **Plugins** | `onRequest` / `onRouteDecision` / `onResponse` / `onRecord` hooks; match scoping; priority ordering; loadable from config without forking |
| **Adapters** | Per-upstream request/response reshaping for gateways with nonstandard JSON; `composePlugins()` for merging related plugins |
| **Presets** | `"providers": ["anthropic", {"name":"copilot","preset":"github-copilot"}]` — endpoint/auth/path defaults for known gateways |
| **Dashboard** | Money saved, downgrade rate, cache hit rate, router performance (regret rate, sticky rate, escalation rate, task type breakdown), per-model and per-route tables |
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
