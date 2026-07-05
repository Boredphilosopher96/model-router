import { describe, it, expect, afterAll } from "bun:test";
import { startServer, extractStreamUsage } from "../src/server.ts";
import { PluginPipeline } from "../src/plugins/index.ts";
import type { RouterConfig } from "../src/types.ts";

describe("server integration", () => {
  let mockServer: ReturnType<typeof Bun.serve>;
  let appServer: Awaited<ReturnType<typeof startServer>> | null = null;
  let mockUrl: string = "";

  // Track the last body sent to the mock upstream for assertions
  let lastUpstreamBody: any = null;

  afterAll(async () => {
    if (appServer?.stop) appServer.stop();
    if (mockServer?.stop) mockServer.stop(true);
  });

  it("starts mock upstream and app server", async () => {
    // Start mock upstream that echoes requests and tracks the last body
    mockServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;

        // For /v1/responses, /v1/chat/completions, /v1/messages — simulate a response
        if (req.method === "POST" && (path === "/v1/responses" || path === "/v1/chat/completions" || path === "/v1/messages")) {
          const body: any = await req.json();
          lastUpstreamBody = body;
          return Response.json({
            id: "resp_1",
            object: "response",
            model: body.model,
            output: [],
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }

        // For /v1/models — return a list
        if (req.method === "GET" && path === "/v1/models") {
          return Response.json({
            object: "list",
            data: [
              { id: "gpt-5.4-nano", object: "model" },
              { id: "gpt-5.4-mini", object: "model" },
            ],
          });
        }

        // For /v1/messages/count_tokens — passthrough test, echo the body back
        if (req.method === "POST" && path === "/v1/messages/count_tokens") {
          const body: any = await req.json();
          lastUpstreamBody = body;
          return Response.json({ input_tokens: 5, output_tokens: 0 });
        }

        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    const port = mockServer.port;
    mockUrl = `http://localhost:${port}`;

    // Start the app server with the mock as upstream
    const config: RouterConfig = {
      port: 0,
      mode: "aggressive",
      cacheEnabled: true,
      cacheTtlMs: 60000,
      dbPath: ":memory:",
      upstreams: [
        { name: "anthropic", baseUrl: mockUrl, dialect: "anthropic", models: ["claude-*"], authStyle: "none", default: true },
        { name: "openai", baseUrl: mockUrl, dialect: "openai", models: ["gpt-*"], authStyle: "none", default: true },
      ],
    };

    appServer = await startServer(config, new PluginPipeline());
    expect(appServer.server.port).toBeGreaterThan(0);
  });

  it("POST /v1/responses: routes model and rewrites response", async () => {
    expect(appServer).not.toBeNull();
    const appUrl = `http://localhost:${appServer!.server.port}`;
    const response = await fetch(`${appUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "hi",
        max_output_tokens: 50,
      }),
    });

    expect(response.ok).toBe(true);

    // Check x-router-routed-model header
    const routedModel = response.headers.get("x-router-routed-model");
    expect(routedModel).toBe("gpt-5.4-nano");

    // Check x-router-upstream header is present
    const upstreamHeader = response.headers.get("x-router-upstream");
    expect(upstreamHeader).toBe("openai");

    // Check x-router-task header is present
    const taskHeader = response.headers.get("x-router-task");
    expect(taskHeader).not.toBeNull();

    // Check response body .model is rewritten to requested model
    const json: any = await response.json();
    expect(json.model).toBe("gpt-5.4");

    // Check that mock received the routed model
    expect(lastUpstreamBody.model).toBe("gpt-5.4-nano");
  });

  it("GET /v1/models with anthropic-version header returns anthropic models", async () => {
    expect(appServer).not.toBeNull();
    const appUrl = `http://localhost:${appServer!.server.port}`;
    const response = await fetch(`${appUrl}/v1/models`, {
      method: "GET",
      headers: { "anthropic-version": "2023-06-01" },
    });

    expect(response.ok).toBe(true);
    const json: any = await response.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.every((m: any) => m.type === "model")).toBe(true);
    // First entry should be "auto"
    expect(json.data[0]!.id).toBe("auto");
    expect(json.data.some((m: any) => m.id === "claude-haiku-4-5")).toBe(true);
  });

  it("GET /v1/models without anthropic headers returns openai models", async () => {
    expect(appServer).not.toBeNull();
    const appUrl = `http://localhost:${appServer!.server.port}`;
    const response = await fetch(`${appUrl}/v1/models`, {
      method: "GET",
    });

    expect(response.ok).toBe(true);
    const json: any = await response.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
    // First entry should be "auto"
    expect(json.data[0]!.id).toBe("auto");
    expect(json.data.some((m: any) => m.id === "gpt-5.4-nano")).toBe(true);
    expect(json.data.some((m: any) => m.id === "claude-haiku-4-5")).toBe(false);
  });

  it("POST /v1/messages/count_tokens is a passthrough (not rerouted)", async () => {
    expect(appServer).not.toBeNull();
    const appUrl = `http://localhost:${appServer!.server.port}`;
    const response = await fetch(`${appUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "test" }],
      }),
    });

    expect(response.ok).toBe(true);

    // Passthrough should NOT reroute the model
    expect(lastUpstreamBody.model).toBe("claude-opus-4-8");
  });

  it("POST /p/anthropic/v1/messages: per-provider mount routes correctly", async () => {
    expect(appServer).not.toBeNull();
    const appUrl = `http://localhost:${appServer!.server.port}`;
    const response = await fetch(`${appUrl}/p/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.ok).toBe(true);
    // Should route to cheapest: claude-haiku-4-5
    const routedModel = response.headers.get("x-router-routed-model");
    expect(routedModel).toBe("claude-haiku-4-5");
    expect(lastUpstreamBody.model).toBe("claude-haiku-4-5");
  });

  it("extractStreamUsage handles Responses API SSE with response.completed event", () => {
    const sseText = `data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":25}}}`;
    const usage = extractStreamUsage("openai", sseText);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(25);
  });

  it("extractStreamUsage handles chat-completions style chunk with prompt/completion_tokens", () => {
    const sseText = `data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}`;
    const usage = extractStreamUsage("openai", sseText);
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(3);
  });

  it("extractStreamUsage handles anthropic usage format", () => {
    const sseText = `data: {"type":"message_delta","message":{"usage":{"input_tokens":50,"output_tokens":15}}}`;
    const usage = extractStreamUsage("anthropic", sseText);
    expect(usage.inputTokens).toBe(50);
    expect(usage.outputTokens).toBe(15);
  });

  it("extractStreamUsage ignores [DONE] and empty lines", () => {
    const sseText = `data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}
data: [DONE]

data: {"type":"other"}`;
    const usage = extractStreamUsage("openai", sseText);
    expect(usage.inputTokens).toBe(5);
    expect(usage.outputTokens).toBe(2);
  });

  it("GET /api/router-eval returns JSON with numeric totalDecisions after a request", async () => {
    expect(appServer).not.toBeNull();
    const appUrl = `http://localhost:${appServer!.server.port}`;

    // Make a request to generate some routing decisions
    await fetch(`${appUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "test",
        max_output_tokens: 10,
      }),
    });

    // Query the router eval endpoint
    const response = await fetch(`${appUrl}/api/router-eval`);
    expect(response.ok).toBe(true);

    const json: any = await response.json();
    expect(typeof json.totalDecisions).toBe("number");
    expect(json.totalDecisions).toBeGreaterThan(0);
  });
});
