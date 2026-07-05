import type {
  Dialect,
  PluginContext,
  RequestRecord,
  ResponseCache,
  RouterConfig,
  StatsStore,
} from "./types.ts";
import { PluginPipeline } from "./plugins/index.ts";
import { route } from "./router.ts";
import { costUsd, getModel, listModels } from "./registry.ts";
import { extractUsage } from "./providers/forward.ts";
import { cacheKey, createCache } from "./cache.ts";
import { createStats } from "./stats.ts";
import { EscalationTracker, conversationKey } from "./escalation.ts";
import { Upstreams, loadRouterSetup, resolveModulePath } from "./upstreams.ts";
import { heuristicStrategy, llmStrategy, type RoutingStrategy } from "./strategy.ts";
// `with { type: "text" }` yields a string at runtime; @types/bun types *.html as HTMLBundle.
import dashboardHtmlImport from "./dashboard/index.html" with { type: "text" };
const dashboardHtml = dashboardHtmlImport as unknown as string;

export interface RouterServer {
  server: ReturnType<typeof Bun.serve>;
  plugins: PluginPipeline;
  cache: ResponseCache;
  stats: StatsStore;
  upstreams: Upstreams;
  escalation: EscalationTracker;
  stop(): void;
}

/** Which wire format an inference path speaks. */
function dialectOf(pathname: string): Dialect | null {
  if (pathname.startsWith("/v1/messages")) return "anthropic";
  if (pathname === "/v1/chat/completions" || pathname === "/v1/responses") return "openai";
  return null;
}

export async function startServer(config: RouterConfig, plugins: PluginPipeline = new PluginPipeline()): Promise<RouterServer> {
  const cache = createCache(config.dbPath, config.cacheTtlMs);
  const stats = createStats(config.dbPath);
  const escalation = new EscalationTracker();
  const setup = await loadRouterSetup(config.upstreamsConfigPath, config.upstreams, config.allowedModels);
  const upstreams = setup.upstreams;
  await plugins.loadFromPaths([...setup.pluginPaths, ...(config.plugins ?? [])], (p) =>
    resolveModulePath(p, config.upstreamsConfigPath),
  );

  // Routing strategy: fast multi-signal heuristic by default; optionally an
  // LLM classifier that asks a tier-1 model once per conversation.
  const heuristic = heuristicStrategy({ taskRules: [...setup.taskRules, ...(config.taskRules ?? [])] });
  const classifierComplete = async (prompt: string): Promise<string> => {
    const spec = listModels()
      .filter((m) => m.tier === 1)
      .sort((a, b) => a.inputPer1M - b.inputPer1M)[0];
    if (!spec) throw new Error("no tier-1 model available for classification");
    const dialect: Dialect = spec.provider;
    const u = upstreams.list(dialect).find((x) => upstreams.hasOwnAuth(x));
    if (!u) throw new Error(`no authable ${dialect} upstream for classification`);
    const body =
      dialect === "anthropic"
        ? { model: spec.id, max_tokens: 40, messages: [{ role: "user", content: prompt }] }
        : { model: spec.id, max_tokens: 40, messages: [{ role: "user", content: prompt }] };
    const path = dialect === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    const resp = await fetch(upstreams.url(u, path), {
      method: "POST",
      headers: upstreams.headers(u, dialect, new Headers(), false),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`classifier upstream ${resp.status}`);
    const json: any = await resp.json();
    return dialect === "anthropic"
      ? (json?.content?.find((b: any) => b.type === "text")?.text ?? "")
      : (json?.choices?.[0]?.message?.content ?? "");
  };
  const strategy: RoutingStrategy =
    config.strategy === "llm" ? llmStrategy(classifierComplete, heuristic) : heuristic;

  // Header values must be ISO-8859-1 safe; model ids and reasons are user-influenced.
  const headerSafe = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 500);

  async function handleInference(req: Request, dialect: Dialect, path: string, homeName?: string): Promise<Response> {
    const t0 = performance.now();
    const home = upstreams.home(dialect, homeName);
    if (!home) return Response.json({ error: `no upstream configured for ${homeName ?? dialect}` }, { status: 502 });

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const ctx: PluginContext = {
      provider: dialect,
      path,
      mount: home.name,
      requestedModel: String(body?.model ?? ""),
      state: {},
    };
    body = await plugins.runRequest(body, ctx);

    // Escalation: has this conversation been struggling on a small model?
    const convo = conversationKey(dialect, body);
    const boost = config.escalationEnabled === false ? 0 : escalation.observeRequest(convo, body);

    const classification = await strategy.classify(body, convo);
    let decision = route({
      body,
      dialect,
      home,
      upstreams,
      config,
      classification,
      escalationBoost: boost,
      lastRoute: escalation.lastRoute(convo),
    });
    decision = await plugins.runRouteDecision(decision, body, ctx);
    ctx.routedModel = decision.routedModel;
    ctx.taskType = decision.taskType;
    escalation.noteRouted(convo, decision.routedModel, decision.upstream);
    const target = upstreams.get(decision.upstream) ?? home;
    const adapter = upstreams.adapterOf(target.name);
    const isHomeTarget = target.name === home.name;
    const requestedSpec = decision.auto ? undefined : getModel(decision.requestedModel);
    const routedSpec = getModel(decision.routedModel);
    const isStream = body?.stream === true;

    const routerHeaders: Record<string, string> = {
      "x-router-requested-model": headerSafe(decision.requestedModel),
      "x-router-routed-model": headerSafe(decision.routedModel),
      "x-router-upstream": headerSafe(decision.upstream),
      "x-router-reason": headerSafe(decision.reason),
    };
    if (decision.escalationBoost > 0) routerHeaders["x-router-escalation"] = String(decision.escalationBoost);
    if (decision.sticky) routerHeaders["x-router-sticky"] = "1";
    routerHeaders["x-router-task"] = headerSafe(decision.taskType);

    const record = (usage: { inputTokens: number; outputTokens: number }, cacheHit: boolean, latencyMs: number) => {
      const costActual = cacheHit || !routedSpec ? 0 : upstreams.costUsd(target, routedSpec, usage.inputTokens, usage.outputTokens);
      const baselineSpec = requestedSpec ?? routedSpec;
      // Baseline: what the requested model would have cost at direct API rates.
      const costBaseline = baselineSpec ? costUsd(baselineSpec, usage.inputTokens, usage.outputTokens) : costActual;
      const rec: RequestRecord = {
        ts: Date.now(),
        provider: decision.provider,
        upstream: decision.upstream,
        requestedModel: decision.requestedModel,
        routedModel: decision.routedModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costActual,
        costBaseline,
        savedUsd: Math.max(costBaseline - costActual, 0),
        cacheHit,
        downgraded: decision.routedModel !== decision.requestedModel,
        latencyMs,
        taskType: decision.taskType,
        complexity: decision.complexity,
        requiredTier: decision.requiredTier,
        escalationBoost: decision.escalationBoost,
        sticky: decision.sticky,
        conversation: convo,
      };
      plugins.runRecord(rec, ctx).finally(() => {
        try {
          stats.record(rec);
        } catch (err) {
          console.error("[stats] failed to record request:", err);
        }
      });
    };

    // ---- cache lookup (non-streaming only) ----
    const key = config.cacheEnabled && !isStream ? cacheKey(dialect, body) : null;
    if (key) {
      const hit = cache.get(key);
      if (hit) {
        let json = JSON.parse(hit.body);
        record(extractUsage(dialect, json), true, performance.now() - t0);
        json = await plugins.runResponse(json, ctx);
        if (!decision.auto && json && typeof json === "object" && "model" in json) json.model = decision.requestedModel;
        return Response.json(json, { headers: { ...routerHeaders, "x-router-cache": "hit" } });
      }
    }

    // ---- forward upstream with the routed model ----
    let outBody = { ...body, model: decision.routedModel };
    if (adapter?.transformRequest) outBody = await adapter.transformRequest(outBody, target);
    let upstream: Response;
    try {
      upstream = await fetch(upstreams.url(target, path), {
        method: "POST",
        headers: upstreams.headers(target, dialect, req.headers, isHomeTarget),
        body: JSON.stringify(outBody),
      });
    } catch (err) {
      escalation.observeOutcome(convo, "failure");
      return Response.json({ error: `upstream unreachable: ${String(err)}` }, { status: 502 });
    }

    if (!upstream.ok) {
      if (upstream.status === 429 || upstream.status >= 500) escalation.observeOutcome(convo, "failure");
      // Pass provider errors through untouched so the harness sees the real failure.
      const errText = await upstream.text();
      return new Response(errText, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", ...routerHeaders },
      });
    }

    if (isStream) {
      // Pass the SSE stream through while teeing chunks to extract usage afterwards.
      const [toClient, toParser] = upstream.body!.tee();
      (async () => {
        try {
          const text = await new Response(toParser).text();
          const usage = extractStreamUsage(dialect, text);
          record(usage, false, performance.now() - t0);
          escalation.observeOutcome(convo, /"stop_reason"\s*:\s*"refusal"/.test(text) ? "refusal" : "ok");
        } catch (err) {
          console.error("[stream] usage extraction failed:", err);
        }
      })();
      return new Response(toClient, {
        status: 200,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-cache",
          ...routerHeaders,
        },
      });
    }

    let json: any = await upstream.json();
    if (adapter?.transformResponse) json = await adapter.transformResponse(json, target);
    record(adapter?.extractUsage?.(json) ?? extractUsage(dialect, json), false, performance.now() - t0);
    escalation.observeOutcome(convo, json?.stop_reason === "refusal" ? "refusal" : "ok");
    if (key) {
      try {
        cache.set(key, JSON.stringify(json), decision.routedModel);
      } catch (err) {
        console.error("[cache] failed to store response:", err);
      }
    }
    json = await plugins.runResponse(json, ctx);
    // Harness-blind: report the model the caller asked for; truth is in headers.
    if (!decision.auto && json && typeof json === "object" && "model" in json) json.model = decision.requestedModel;
    return Response.json(json, { headers: { ...routerHeaders, "x-router-cache": key ? "miss" : "bypass" } });
  }

  /** Raw passthrough for non-inference /v1/* paths (count_tokens, probes…). */
  async function handlePassthrough(req: Request, pathname: string, search: string, homeName?: string): Promise<Response> {
    const dialect: Dialect =
      req.headers.has("anthropic-version") || req.headers.has("x-api-key") || pathname.startsWith("/v1/messages")
        ? "anthropic"
        : "openai";
    const home = upstreams.home(dialect, homeName);
    if (!home) return Response.json({ error: `no upstream configured for ${homeName ?? dialect}` }, { status: 502 });
    try {
      const headers = upstreams.headers(home, dialect, req.headers, true);
      const ct = req.headers.get("content-type");
      if (ct) headers.set("content-type", ct);
      const upstream = await fetch(upstreams.url(home, pathname, search), {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch (err) {
      return Response.json({ error: `upstream unreachable: ${String(err)}` }, { status: 502 });
    }
  }

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;

      // Per-provider mounts: /p/<name>/v1/... pins the home upstream.
      let homeName: string | undefined;
      const mount = pathname.match(/^\/p\/([^/]+)(\/.*)$/);
      if (mount) {
        homeName = mount[1];
        pathname = mount[2]!;
      }

      const dialect = dialectOf(pathname);
      if (req.method === "POST" && dialect && (pathname === "/v1/messages" || pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
        return handleInference(req, dialect, pathname, homeName);
      }

      // Model listing — served from the registry in the caller's dialect,
      // with the router's own "auto" model prepended so harnesses can select it.
      if (req.method === "GET" && pathname === "/v1/models") {
        const speaksAnthropic = req.headers.has("anthropic-version") || req.headers.has("x-api-key");
        if (speaksAnthropic) {
          const specs = listModels("anthropic");
          return Response.json({
            data: [
              { type: "model", id: "auto", display_name: "auto (model-router)", created_at: "2026-01-01T00:00:00Z" },
              ...specs.map((m) => ({ type: "model", id: m.id, display_name: m.id, created_at: "2026-01-01T00:00:00Z" })),
            ],
            first_id: "auto",
            last_id: specs[specs.length - 1]?.id ?? null,
            has_more: false,
          });
        }
        const specs = listModels("openai");
        return Response.json({
          object: "list",
          data: [
            { id: "auto", object: "model", created: 1735689600, owned_by: "model-router" },
            ...specs.map((m) => ({ id: m.id, object: "model", created: 1735689600, owned_by: m.provider })),
          ],
        });
      }

      if (pathname.startsWith("/v1/")) return handlePassthrough(req, pathname, url.search, homeName);

      if (pathname === "/" || pathname === "/dashboard")
        return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (pathname === "/api/stats") return Response.json(stats.summary());
      if (pathname === "/api/models") return Response.json(listModels());
      if (pathname === "/api/upstreams")
        return Response.json(upstreams.list().map(({ name, baseUrl, dialect: d, models, priceMultiplier }) => ({ name, baseUrl, dialect: d, models, priceMultiplier })));
      if (pathname === "/api/escalations") return Response.json(escalation.snapshot());
      if (pathname === "/api/router-eval") return Response.json(stats.routerEval());
      if (pathname === "/api/plugins") return Response.json(plugins.list());
      if (pathname === "/health")
        return Response.json({
          ok: true,
          mode: config.mode,
          cache: { enabled: config.cacheEnabled, entries: cache.size() },
          upstreams: upstreams.list().map((u) => u.name),
        });

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  return { server, plugins, cache, stats, upstreams, escalation, stop: () => server.stop(true) };
}

/** Parse token usage out of an accumulated SSE stream body. */
export function extractStreamUsage(dialect: Dialect, sseText: string): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload);
      if (dialect === "anthropic") {
        const u = evt?.message?.usage ?? evt?.usage;
        if (u?.input_tokens != null)
          inputTokens = Math.max(
            inputTokens,
            (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          );
        if (u?.output_tokens != null) outputTokens = Math.max(outputTokens, u.output_tokens);
      } else {
        // chat completions: final chunk usage; Responses API: response.completed event
        const u = evt?.usage ?? evt?.response?.usage;
        if (u?.prompt_tokens != null || u?.input_tokens != null)
          inputTokens = Math.max(inputTokens, u.prompt_tokens ?? u.input_tokens ?? 0);
        if (u?.completion_tokens != null || u?.output_tokens != null)
          outputTokens = Math.max(outputTokens, u.completion_tokens ?? u.output_tokens ?? 0);
      }
    } catch {
      // partial JSON lines in flight are expected — skip
    }
  }
  return { inputTokens, outputTokens };
}
