# Connecting harnesses

The model-router proxy listens on `http://localhost:4141` (configurable via `PORT` env). Every harness (Claude Code, opencode, Codex CLI, GitHub Copilot, or other tools) points its LLM base URL at the proxy. The router then examines each request, picks the cheapest capable model + upstream combination, swaps only the model string, and forwards it.

## One-command setup

For harnesses that support inline configuration, use the setup command to print or apply router config:

```bash
model-router setup <harness> [--write]
```

Where `<harness>` is one of: `claude-code`, `codex`, `opencode`, `copilot`, `pi`.

- Without `--write`: prints exact config (safe; useful for copy-paste into harness settings).
- With `--write`: applies config automatically:
  - `opencode`: merges into `./opencode.json` (creates `./opencode.json.bak` backup).
  - `codex`: appends to `~/.codex/config.toml` (creates backup at `~/.codex/config.toml.bak`).
  - Others: print instructions (safe by design — requires manual setup).

Example:

```bash
model-router setup claude-code
model-router setup codex --write
```

## Mount styles

Two path patterns direct traffic:

- **Bare paths** (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`): use the request's dialect's `default` upstream (the one marked `"default": true` in your config).
- **Pinned mounts** (`/p/<upstream-name>/v1/...`): set that upstream as the request's *home* — the default destination and the only endpoint the caller's own credentials are forwarded to. The router may still redirect a request to a *different* upstream when it is cheaper, but only if that upstream has its own configured credentials. Use pinned mounts whenever multiple configured upstreams share a dialect — each gets its own path.

## Claude Code

Set the `ANTHROPIC_BASE_URL` environment variable before running Claude Code:

```bash
ANTHROPIC_BASE_URL=http://localhost:4141 claude
```

Or to pin a specific upstream (e.g., your custom gateway):

```bash
ANTHROPIC_BASE_URL=http://localhost:4141/p/mygateway claude
```

The proxy handles Claude Code's startup probes (`GET /v1/models`, token counting, etc.) and all inference requests. Response headers `x-router-routed-model`, `x-router-upstream`, and `x-router-reason` reveal the routing decision.

## opencode

In your `opencode.json` config file, set each custom provider's `baseURL` option to point at the proxy. Use the pinned mount style when adding multiple providers:

```json
{
  "providers": [
    {
      "name": "github-copilot",
      "provider": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:4141/p/copilot/v1"
      }
    },
    {
      "name": "anthropic",
      "provider": "@ai-sdk/anthropic",
      "options": {
        "baseURL": "http://localhost:4141/p/anthropic"
      }
    }
  ]
}
```

The Anthropic provider also accepts a `baseURL` option (besides the standard `ANTHROPIC_BASE_URL` env var); when set, it overrides the environment.

## Codex CLI

Edit `~/.codex/config.toml` and add a model provider pointing to the router:

```toml
[model_providers.router]
name = "router"
base_url = "http://localhost:4141/p/openai/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
model_provider = "router"
```

The `wire_api` field accepts either `"responses"` or `"chat"` (both OpenAI-compatible endpoints). The proxy forwards your `OPENAI_API_KEY` to the home upstream, which then handles authentication with its own credentials or passes yours through.

## GitHub Copilot BYOK (VS Code)

In VS Code, open *Manage Language Models* and add an OpenAI-compatible language model provider:

- **Endpoint**: `http://localhost:4141/p/<upstream-name>/v1`
- Replace `<upstream-name>` with the name of your upstream in `router.config.json` (e.g., `"copilot"`, `"mygateway"`, etc.).

VS Code will send requests via the proxy. The router detects the dialect from the path and routes accordingly.

## Anything else

The invariant for all harnesses: point its Anthropic or OpenAI API base URL at the proxy. Exact config keys drift between harness versions, so consult each tool's documentation for where to set the base URL, then use:

- Anthropic-format tools: `ANTHROPIC_BASE_URL=http://localhost:4141[/p/<name>]`
- OpenAI-format tools: set the base URL to `http://localhost:4141[/p/<name>]/v1`

Startup probes (model listing, token counting) are either answered by the proxy or passed through to the home upstream. All standard inference endpoints are supported.

## Selecting the auto model

When you list available models (via `GET /v1/models`), the response includes a model named `"auto"`. Harnesses that support model selection can choose it to delegate the whole model-choice decision to the router. The router then picks the cheapest capable model per request and reports the real model name in the `x-router-routed-model` header.

Note: responses for `"auto"` selections report the actual routed model in the response's `model` field, unlike non-auto requests which are rewritten to show the originally requested model.

## Verifying it works

Test the connection with a curl request:

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-..." \
  -d '{"model": "claude-haiku-4-5", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]}'
```

Look for response headers:

```
x-router-routed-model: claude-haiku-4-5
x-router-upstream: anthropic
x-router-reason: cheapest capable
```

Visit the dashboard at `http://localhost:4141/dashboard` to see live savings, downgraded request counts, cache hit rate, and per-model/per-route tables.
