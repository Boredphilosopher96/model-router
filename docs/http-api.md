# HTTP API reference

## Inference endpoints

The proxy exposes three core inference endpoints for different LLM wire formats:

| Endpoint | Dialect | Equivalent stock endpoint |
|---|---|---|
| `POST /v1/messages` | Anthropic | `https://api.anthropic.com/v1/messages` |
| `POST /v1/chat/completions` | OpenAI | `https://api.openai.com/v1/chat/completions` |
| `POST /v1/responses` | OpenAI | `https://api.openai.com/v1/chat/completions` (alias) |

Each also exists under a pinned upstream path: `/p/<upstream-name>/v1/messages`, `/p/<upstream-name>/v1/chat/completions`, `/p/<upstream-name>/v1/responses`.

## Request processing

Each inference request follows this pipeline:

1. **Plugin onRequest** — your plugins can inspect and transform the raw body.
2. **Escalation check** — if this conversation is stuck (repeated upstream errors, tool failures, or retry loops), bump its capability tier.
3. **Route decision** — scan all (model, upstream) pairs meeting the capability tier, context window, and auth constraints; pick the cheapest by effective price.
4. **Plugin onRouteDecision** — plugins can inspect or override the routing decision (e.g., enforce budgets or pin to specific upstreams).
5. **Cache lookup** — for non-streaming requests, check if this exact request was seen before (TTL applies).
6. **Forward** — swap the model name, apply upstream adapter transforms if configured, and send to the target upstream.
7. **Response transform** — apply plugin onResponse hooks, rewrite the response's model field (except for `"auto"` requests, which report the real model), and return to the harness.
8. **Record stats** — record usage and cost for the dashboard and `/api/stats`.

## Response headers

Every response includes router metadata in HTTP headers:

| Header | Meaning |
|---|---|
| `x-router-requested-model` | Model name the harness asked for |
| `x-router-routed-model` | Model actually sent to the upstream |
| `x-router-upstream` | Upstream name the request went to |
| `x-router-reason` | Why the router made this choice (e.g., "cheapest capable", "escalation boost", "context limit") |
| `x-router-escalation` | (Present only if escalation applied) tier boost count |
| `x-router-failover` | (Present only when a retry served the response) Which alternate served: 1 = first alternate, 2 = second. Absent when the originally chosen pair succeeded |
| `x-router-cache` | `"hit"`, `"miss"`, or `"bypass"` for non-streaming requests; `"hit"` or `"miss"` for streaming (streaming responses are now cached raw SSE) |
| `x-router-budget-used` | (Present if budgets configured) Fraction 0–1 of the most-constrained budget window filled |
| `x-router-mode` | (Present if budget tightening applied) Effective mode after budget constraint |
| `x-router-shadow-model` | (Present if shadow mode enabled) Model the shadow config would have chosen |

## Error handling

- **Upstream errors**: pass through with original HTTP status and body (e.g., 401, 429, 500 from the upstream are relayed as-is).
- **Unreachable upstream**: return HTTP 502 with `{"error": "..."}` body.
- **Invalid JSON body**: return HTTP 400 with `{"error": "invalid JSON body"}`.
- **No home upstream configured**: return HTTP 502 (only if the dialect or pinned upstream has no provider).

Plugin errors are logged but do not break traffic; a failing plugin is skipped.

## Observability endpoints

### Health check

```
GET /health
```

Returns:

```json
{
  "ok": true,
  "mode": "aggressive",
  "cache": {
    "enabled": true,
    "entries": 42
  },
  "upstreams": [
    { "name": "anthropic", "dialect": "anthropic", "enabled": true },
    { "name": "copilot", "dialect": "openai", "enabled": true }
  ]
}
```

### Statistics API

```
GET /api/stats
```

Returns a summary of all routing activity:

```json
{
  "totalRequests": 1250,
  "downgradedRequests": 180,
  "cacheHits": 45,
  "cacheHitRate": 0.036,
  "totalInputTokens": 5000000,
  "totalOutputTokens": 2000000,
  "totalCostActualUsd": 12.50,
  "totalCostBaselineUsd": 45.00,
  "totalSavedUsd": 32.50,
  "byModel": [
    {
      "model": "claude-haiku-4-5",
      "requests": 500,
      "downgraded": 0,
      "inputTokens": 2000000,
      "outputTokens": 800000,
      "costActualUsd": 4.00,
      "costBaselineUsd": 10.00
    }
  ],
  "byRoute": [
    {
      "requested": "claude-opus-4-1",
      "routed": "claude-sonnet-4",
      "requests": 80,
      "savedUsd": 20.00
    }
  ],
  "timeline": [
    {
      "ts": 1234567890000,
      "requests": 100,
      "costActualUsd": 1.50,
      "costBaselineUsd": 4.50
    }
  ]
}
```

### Model catalog

```
GET /api/models
```

Returns the current model registry:

```json
[
  {
    "id": "claude-haiku-4-5",
    "provider": "anthropic",
    "tier": 1,
    "contextWindow": 200000,
    "inputPer1M": 0.80,
    "outputPer1M": 4.00,
    "vision": true,
    "toolUse": true,
    "enabled": true
  }
]
```

### Upstreams

```
GET /api/upstreams
```

Returns configuration of all declared upstreams:

```json
[
  {
    "name": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "dialect": "anthropic",
    "models": ["claude-*"],
    "priceMultiplier": 1.0
  }
]
```

### Escalations in progress

```
GET /api/escalations
```

Returns conversations currently stuck and receiving tier boosts:

```json
[
  {
    "conversation": "<hash>",
    "boost": 2,
    "signals": ["429", "retry_loop"],
    "lastSeen": 1234567890000
  }
]
```

### Budget status

```
GET /api/budget
```

Returns current spend vs. configured limits:

```json
{
  "daily": {
    "limitUsd": 100.0,
    "spentUsd": 72.5,
    "fractionUsed": 0.725
  },
  "monthly": {
    "limitUsd": 2000.0,
    "spentUsd": 1450.0,
    "fractionUsed": 0.725
  },
  "perMount": [
    {
      "mount": "anthropic",
      "limitUsd": 50.0,
      "spentUsd": 35.0,
      "fractionUsed": 0.7
    }
  ]
}
```

### Upstream health

```
GET /api/upstream-health
```

Returns circuit breaker and latency status per upstream:

```json
[
  {
    "upstream": "anthropic",
    "latencyMs": 245,
    "ok": true,
    "failed": 0,
    "circuit": "closed",
    "rateRemaining": 0.95,
    "throttled": false
  },
  {
    "upstream": "copilot",
    "latencyMs": 310,
    "ok": false,
    "failed": 4,
    "circuit": "half-open",
    "rateRemaining": 0.03,
    "throttled": true
  }
]
```

Fields:
- `latencyMs` — exponential-weighted moving average latency.
- `ok` — upstream is reachable and within limits.
- `failed` — failure count in the current window (resets on recovery).
- `circuit` — `"closed"` (normal), `"open"` (throttled), or `"half-open"` (recovery probe pending).
- `rateRemaining` — fraction 0–1 of the upstream's request/token budget remaining (parsed from provider rate-limit headers).
- `throttled` — bool; true when `rateRemaining < 0.05`, soft-throttling for 30 seconds.

### Quality calibration

```
GET /api/calibration
```

Returns recommendations from ongoing quality grading:

```json
{
  "enabled": true,
  "applied": false,
  "sampleRate": 0.05,
  "byTaskType": [
    {
      "taskType": "codegen",
      "sampledCount": 12,
      "gradedCount": 8,
      "avgAdequacy": 0.72,
      "recommendedTierDelta": 1
    }
  ]
}
```

Fields:
- `recommendedTierDelta` — +1 if adequacy < 0.8 with >=5 graded samples, else 0.
- `applied` — whether recommendations are being applied automatically.

### Router evaluation

```
GET /api/router-eval
```

Returns routing performance metrics and (if shadow mode enabled) shadow decision comparison:

```json
{
  "totalDecisions": 15420,
  "downgradeRate": 0.42,
  "stickyRate": 0.11,
  "escalationRate": 0.03,
  "regretRate": 0.05,
  "shadow": {
    "decisions": 15420,
    "agreementRate": 0.87,
    "estCostDeltaUsd": 45.30
  },
  "byTaskType": [
    { "taskType": "codegen", "requests": 3200, "avgComplexity": 0.31,
      "avgRequiredTier": 2.1, "downgraded": 1750, "savedUsd": 4.21, "avgLatencyMs": 2100 }
  ],
  "tierDistribution": [
    { "requiredTier": 1, "requests": 6200 }
  ]
}
```

The `shadow` block appears only if shadow mode is configured. See "How routing works" in `docs/routing.md` for metric interpretation.

### Loaded plugins

```
GET /api/plugins
```

Returns the names of all active plugins:

```json
["logger", "toon", "my-custom-plugin"]
```

### Dashboard

```
GET /dashboard
```

Returns an HTML page with live visualizations of savings, downgraded requests, cache performance, and per-model/per-route tables.

## Model listing endpoint

```
GET /v1/models
```

The response format depends on dialect detection:

- **Anthropic format**: returned if the request carries `anthropic-version` or `x-api-key` headers.
- **OpenAI format**: returned otherwise (default).

Both formats include a model named `"auto"` which harnesses can select to delegate model choice to the router.

## Passthrough endpoints

All other `/v1/*` paths (e.g., `/v1/messages/count_tokens`, `/v1/embeddings`) are forwarded verbatim to the home upstream, with the model name unchanged. These endpoints are not cached and do not contribute to routing statistics.

## Streaming

Streaming requests (`{"stream": true}`) receive byte-for-byte SSE passthrough from the upstream. The router:

- Tees the response stream to extract token usage for stats (parsed from `finish_reason`, `usage` fields in server-sent events).
- Caches streaming responses as raw SSE, replayed byte-for-byte on identical requests (x-router-cache: hit with content-type text/event-stream); streams over 2 MB not cached; stream and non-stream variants cached separately.
- Preserves all upstream SSE formatting and timing.
- Does NOT rewrite the `model` field inside stream events; the truth is in the `x-router-routed-model` header.

Connection drops and stream errors are relayed unchanged to the harness.
