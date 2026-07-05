# Configuration reference

model-router is configured through environment variables (runtime behavior) and `router.config.json` (upstreams, allowlist, plugins). With no config file present, it defaults to the direct Anthropic and OpenAI APIs using `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4141` | Listen port. |
| `ROUTER_MODE` | `aggressive` | `aggressive` — cheapest capable model. `balanced` — at most one tier below the requested model. `off` — never reroute (cache, stats, and plugins stay active). |
| `ROUTER_CONFIG` | `router.config.json` | Path to the upstream/allowlist/plugin declaration file. |
| `ROUTER_ALLOWED_MODELS` | *(all)* | Comma-separated globs restricting routing targets, e.g. `claude-haiku-*,gpt-5.4-*`. Overrides the config file's `allowedModels`. |
| `ROUTER_CROSS_PROVIDER` | `false` | Allow vendor switches (Claude ↔ GPT) on the OpenAI dialect. Same-dialect only — never format translation. |
| `ESCALATION` | `true` | Per-conversation stuck detection and tier bumping. |
| `CACHE_ENABLED` | `true` | Response cache for non-streaming requests. |
| `CACHE_TTL_MS` | `3600000` | Cache entry lifetime (1 hour). |
| `DB_PATH` | `model-router.sqlite` | SQLite file backing the cache and stats. |
| `PRICE_AUTOUPDATE` | `true` | Daily model/price refresh from the live feed. |
| `PRICE_REFRESH_MS` | `86400000` | Refresh interval; `0` = refresh at startup only. |
| `PRICE_FEED_URL` | LiteLLM raw JSON | Alternative feed URL (must use the same schema). |
| `PRICE_CACHE_PATH` | `price-cache.json` | On-disk cache of the last successful feed fetch (offline fallback). |
| `MODELS_JSON` | `models.json` | Optional manual model overrides (array of `ModelSpec`) applied at startup; these win over feed data. |
| `PLUGIN_LOGGER` | `true` | Bundled request/latency logging plugin. |
| `PLUGIN_TOON` | `false` | Bundled JSON→TOON prompt-compression plugin. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | — | Fallback credentials for the default direct-API upstreams. |

## `router.config.json`

Top-level shape:

```jsonc
{
  "allowedModels": ["claude-haiku-*", "claude-opus-*", "gpt-5.4-*"],  // optional
  "plugins": ["./plugins/my-telemetry.ts"],                            // optional
  "providers": [ /* upstream declarations */ ]
}
```

A bare array of providers is also accepted for backward compatibility. Relative `plugins` and `adapter` paths resolve against the config file's directory.

### Upstream fields

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | yes | — | Unique name. Also the mount path: `/p/<name>/v1/...`. |
| `baseUrl` | yes | — | Endpoint origin, e.g. `https://api.githubcopilot.com`. |
| `dialect` | yes | — | Wire format the endpoint accepts: `anthropic`, `openai`, or `both`. |
| `models` | no | dialect vendor defaults; feed-driven for recognized gateway hosts | Globs of model ids this endpoint serves, matched against normalized catalog ids (`claude-*`, `gpt-5.4-*`). |
| `apiKeyEnv` | no | — | Environment variable holding this endpoint's API key. |
| `authStyle` | no | `passthrough` | `passthrough` — forward the caller's own auth headers (only toward this upstream when it is the request's home), falling back to `apiKeyEnv`. `bearer` / `x-api-key` — always send the `apiKeyEnv` credential in that header. `none` — send no credentials. |
| `headers` | no | — | Extra static headers on every outbound request. |
| `pricing` | no | — | Per-model pricing for models the catalog doesn't know. Registers the model too. See below. |
| `adapter` | no | — | Module path of an `UpstreamAdapter` for endpoints with nonstandard JSON shapes. See `docs/extending.md`. |
| `priceMultiplier` | no | automatic | Manual price scaling override. Rarely needed — see “How pricing resolves”. |
| `stripV1` | no | `false` | Endpoint paths have no `/v1` segment (GitHub Copilot, GitHub Models). |
| `vendorPrefix` | no | `false` | Send model ids vendor-prefixed with dot versions (`anthropic/claude-haiku-4.5`, OpenRouter style). |
| `default` | no | first of its dialect | Handles bare (un-mounted) `/v1/*` traffic for its dialect. |
| `enabled` | no | `true` | Set `false` to keep the entry but exclude it from the pool. |

### Custom model pricing

For a model no catalog knows (private fine-tune, internal model), declare it on the upstream that serves it:

```jsonc
"pricing": {
  "my-private-model": {
    "inputPer1M": 0.5,        // USD per 1M input tokens
    "outputPer1M": 2.0,       // USD per 1M output tokens
    "tier": 2,                // optional; inferred from price if omitted
    "contextWindow": 128000,  // optional; default 128k
    "vision": false,          // optional capability flags (default: capable)
    "toolUse": true
  }
}
```

This both registers the model in the catalog (so it can be a routing target, priced, and shown in stats) and pins its price on that upstream.

### How pricing resolves

For every (upstream, model) pair, the first match wins:

1. **Explicit `pricing` entry** on the upstream.
2. **Live feed pricing for recognized gateway hosts.** `api.githubcopilot.com` and `models.github.ai` are recognized automatically: the feed supplies both the served-model list and per-token prices. Feed entries without per-token costs (Copilot subscription) count as zero marginal cost — the endpoint wins anything it serves.
3. **Catalog API pricing × `priceMultiplier`** (default `1`). This is the "assume API pricing" fallback for custom gateways serving known models.

### Model allowlist semantics

`allowedModels` restricts which models can be **chosen as routing targets**. It does not block traffic: a request for a non-allowed model still passes through to its upstream unchanged — the router just never *picks* a non-allowed model as a cheaper substitute, and non-allowed models keep resolving for baseline cost accounting.

## Model catalog

The catalog ships with the current generation of Anthropic and OpenAI models (prices verified at release) and self-updates:

- The feed refresh keeps only the newest generation per model family and disables superseded entries (including compiled defaults) as routing targets.
- Dated snapshots, previews, legacy naming schemes, and non-chat specializations are excluded.
- Capability flags (`vision`, `toolUse`) flow in from the feed and gate routing for multimodal / tool-calling requests.
- `models.json` (or `registerModel()` from the library API) applies last and wins.
