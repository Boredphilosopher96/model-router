import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { UpstreamHealth, DEFAULT_HEALTH } from "../src/health.ts";
import { BudgetGuard } from "../src/budget.ts";
import { Calibrator } from "../src/calibration.ts";
import { createStats } from "../src/stats.ts";
import { route, type RouteInputs } from "../src/router.ts";
import { Upstreams } from "../src/upstreams.ts";
import { startServer } from "../src/server.ts";
import { PluginPipeline } from "../src/plugins/index.ts";
import { runSetup } from "../src/setup.ts";
import { heuristicStrategy, type Classification } from "../src/strategy.ts";
import type { RouterConfig, RequestRecord } from "../src/types.ts";

describe("UpstreamHealth", () => {
  let health: UpstreamHealth;

  beforeEach(() => {
    health = new UpstreamHealth();
  });

  it("fresh instance has available=true and latencyMs=0", () => {
    expect(health.available("x")).toBe(true);
    expect(health.latencyMs("x")).toBe(0);
  });

  it("EWMA latency interpolates between samples", () => {
    health.note("x", true, 100);
    health.note("x", true, 200);
    const latency = health.latencyMs("x");
    // With alpha=0.3: 0.3*200 + 0.7*100 = 60+70 = 130
    expect(latency).toBeGreaterThan(100);
    expect(latency).toBeLessThan(200);
  });

  it("circuit breaker: 3 failures within window opens circuit", () => {
    const opts = { failureThreshold: 3, windowMs: 60000, cooldownMs: 60000, alpha: 0.3 };
    const hb = new UpstreamHealth(opts);
    hb.note("u1", false, 0);
    hb.note("u1", false, 0);
    hb.note("u1", false, 0);
    expect(hb.available("u1")).toBe(false);
    const snapshot = hb.snapshot();
    expect(snapshot[0]?.circuit).toBe("open");
  });

  it("half-open: after cooldown, available returns true for probe", async () => {
    const hb = new UpstreamHealth({ failureThreshold: 1, windowMs: 60000, cooldownMs: 1, alpha: 0.3 });
    hb.note("u1", false, 0);
    expect(hb.available("u1")).toBe(false);
    await Bun.sleep(5);
    expect(hb.available("u1")).toBe(true);
  });

  it("probe success closes circuit", async () => {
    const hb = new UpstreamHealth({ failureThreshold: 1, windowMs: 60000, cooldownMs: 1, alpha: 0.3 });
    hb.note("u1", false, 0);
    await Bun.sleep(5);
    hb.note("u1", true, 50);
    expect(hb.snapshot()[0]?.circuit).toBe("closed");
  });
});

describe("BudgetGuard", () => {
  let guard: BudgetGuard;
  let mockSpend: number;

  beforeEach(() => {
    mockSpend = 0;
    const stats = { spendSince: (ts: number, mount?: string) => mockSpend };
    guard = new BudgetGuard(stats, { dailyUsd: 10 });
  });

  it("at 50% spend, mode stays unchanged", () => {
    mockSpend = 5;
    const result = guard.effectiveMode("quality", "any");
    expect(result.mode).toBe("quality");
  });

  it("at 75% spend, mode escalates one notch", () => {
    mockSpend = 7.5;
    guard.flushCache();
    const result = guard.effectiveMode("quality", "any");
    expect(result.mode).toBe("balanced");
  });

  it("at 95% spend, mode becomes aggressive", () => {
    mockSpend = 9.5;
    guard.flushCache();
    const result = guard.effectiveMode("quality", "any");
    expect(result.mode).toBe("aggressive");
  });

  it("off mode stays off even at high spend", () => {
    mockSpend = 9.5;
    guard.flushCache();
    const result = guard.effectiveMode("off", "any");
    expect(result.mode).toBe("off");
  });

  it("perMountDailyUsd constraints per-mount usage", () => {
    const guard2 = new BudgetGuard(
      {
        spendSince: (ts: number, mount?: string) => {
          return mount === "copilot" ? 0.95 : 0;
        },
      },
      { perMountDailyUsd: { copilot: 1 } }
    );
    const usage = guard2.usage("copilot");
    expect(usage.binding).toBe("mount:copilot");
    expect(usage.fraction).toBe(0.95);
    guard2.flushCache();
    const result = guard2.effectiveMode("balanced", "copilot");
    expect(result.mode).toBe("aggressive");
  });

  it("usage for unmounted upstream when no perMount constraint", () => {
    const guard2 = new BudgetGuard(
      {
        spendSince: (ts: number, mount?: string) => 0,
      },
      { perMountDailyUsd: { copilot: 1 } }
    );
    const usage = guard2.usage("anthropic");
    expect(usage.fraction).toBe(0);
  });

  it("disabled when config is empty", () => {
    const guard2 = new BudgetGuard({ spendSince: () => 0 }, {});
    expect(guard2.enabled).toBe(false);
    const result = guard2.effectiveMode("balanced", "any");
    expect(result.usage).toBe(0);
  });
});

describe("StatsStore.spendSince + shadow eval", () => {
  let stats = createStats(":memory:");

  beforeEach(() => {
    stats = createStats(":memory:");
  });

  it("records requests and spendSince returns sum by mount", () => {
    const now = Date.now();
    const rec1: RequestRecord = {
      ts: now,
      provider: "anthropic",
      upstream: "a",
      requestedModel: "claude-opus",
      routedModel: "claude-haiku",
      inputTokens: 100,
      outputTokens: 50,
      costActual: 1.0,
      costBaseline: 2.0,
      savedUsd: 1.0,
      cacheHit: false,
      downgraded: true,
      latencyMs: 100,
      taskType: "chat",
      complexity: 0.5,
      requiredTier: 1,
      escalationBoost: 0,
      sticky: false,
      conversation: "conv1",
      mount: "a",
      estCostUsd: 1.0,
      shadowModel: "",
      shadowCostUsd: 0,
    };
    const rec2: RequestRecord = {
      ...rec1,
      upstream: "b",
      mount: "b",
      costActual: 2.0,
      ts: now + 100,
      conversation: "conv2",
    };
    stats.record(rec1);
    stats.record(rec2);
    expect(stats.spendSince(0)).toBe(3);
    expect(stats.spendSince(0, "a")).toBe(1);
    expect(stats.spendSince(0, "b")).toBe(2);
  });

  it("shadow mode: records shadow cost and computes agreement", () => {
    const now = Date.now();
    const rec1: RequestRecord = {
      ts: now,
      provider: "anthropic",
      upstream: "u",
      requestedModel: "claude-opus",
      routedModel: "claude-haiku",
      inputTokens: 100,
      outputTokens: 50,
      costActual: 1.0,
      costBaseline: 2.0,
      savedUsd: 1.0,
      cacheHit: false,
      downgraded: true,
      latencyMs: 100,
      taskType: "chat",
      complexity: 0.5,
      requiredTier: 1,
      escalationBoost: 0,
      sticky: false,
      conversation: "conv1",
      mount: "u",
      estCostUsd: 1.0,
      shadowModel: "claude-haiku", // agree
      shadowCostUsd: 0.9,
    };
    const rec2: RequestRecord = {
      ...rec1,
      ts: now + 100,
      conversation: "conv2",
      shadowModel: "claude-sonnet", // differ
      shadowCostUsd: 1.5,
      estCostUsd: 1.0,
    };
    stats.record(rec1);
    stats.record(rec2);
    const evaluation = stats.routerEval();
    expect(evaluation.shadow?.decisions).toBe(2);
    expect(evaluation.shadow?.agreementRate).toBe(0.5);
    // estCostDeltaUsd = (0.9 - 1.0) + (1.5 - 1.0) = -0.1 + 0.5 = 0.4
    expect(evaluation.shadow?.estCostDeltaUsd).toBeCloseTo(0.4);
  });
});

describe("Router health integration", () => {
  const trivialClassification = (): Classification => ({
    taskType: "chat",
    requiredTier: 1,
    complexity: 0.1,
    confidence: 0.9,
    reasons: [],
  });

  it("skips open-circuit home upstream when alternative exists", () => {
    const ups = new Upstreams([
      { name: "u1", baseUrl: "http://a", dialect: "anthropic", authStyle: "none" },
      { name: "u2", baseUrl: "http://b", dialect: "anthropic", authStyle: "none" },
    ]);
    const home = ups.get("u1")!;
    const health = {
      available: (n: string) => n !== "u1",
      latencyMs: () => 0,
    };
    const inputs: RouteInputs = {
      body: { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] },
      dialect: "anthropic",
      home,
      upstreams: ups,
      config: { mode: "aggressive", crossProvider: false },
      classification: trivialClassification(),
      health,
    };
    const decision = route(inputs);
    expect(decision.upstream).toBe("u2");
  });

  it("falls open: routes through home when all unavailable", () => {
    const ups = new Upstreams([
      { name: "u1", baseUrl: "http://a", dialect: "anthropic", authStyle: "none" },
      { name: "u2", baseUrl: "http://b", dialect: "anthropic", authStyle: "none" },
    ]);
    const home = ups.get("u1")!;
    const health = {
      available: () => false,
      latencyMs: () => 0,
    };
    const inputs: RouteInputs = {
      body: { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] },
      dialect: "anthropic",
      home,
      upstreams: ups,
      config: { mode: "aggressive", crossProvider: false },
      classification: trivialClassification(),
      health,
    };
    const decision = route(inputs);
    expect([decision.upstream]).toContain(decision.upstream);
  });

  it("latency tie-break: faster upstream wins when costs equivalent", () => {
    const ups = new Upstreams([
      { name: "u1", baseUrl: "http://a", dialect: "openai", models: ["gpt-*"], authStyle: "none" },
      { name: "u2", baseUrl: "http://b", dialect: "openai", models: ["gpt-*"], authStyle: "none" },
    ]);
    const home = ups.get("u1")!;
    const health = {
      available: () => true,
      latencyMs: (n: string) => (n === "u1" ? 500 : 10),
    };
    const inputs: RouteInputs = {
      body: { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] },
      dialect: "openai",
      home,
      upstreams: ups,
      config: { mode: "aggressive", crossProvider: false },
      classification: trivialClassification(),
      health,
    };
    const decision = route(inputs);
    expect(decision.upstream).toBe("u2");
  });
});

describe("Calibrator", () => {
  let cal: Calibrator;

  afterEach(() => {
    cal.stop();
  });

  it("grader always adequate: no tier bump recommendation after 5 samples", async () => {
    cal = new Calibrator(
      ":memory:",
      async () => JSON.stringify({ adequate: true }),
      { sampleRate: 1, minSamples: 5, apply: false, gradeIntervalMs: 0, adequacyThreshold: 0.8, batchSize: 10 }
    );
    for (let i = 0; i < 5; i++) {
      cal.maybeSample({
        taskType: "test",
        requiredTier: 1,
        routedModel: "claude-haiku",
        prompt: "test prompt",
        response: "test response",
      });
    }
    await cal.gradePending();
    const snap = cal.snapshot();
    expect(snap.recommendations[0]?.recommendTierBump).toBe(false);
  });

  it("grader always inadequate: tier bump with apply=true still returns 0", async () => {
    cal = new Calibrator(
      ":memory:",
      async () => JSON.stringify({ adequate: false }),
      { sampleRate: 1, minSamples: 2, apply: false, gradeIntervalMs: 0, adequacyThreshold: 0.8, batchSize: 10 }
    );
    for (let i = 0; i < 2; i++) {
      cal.maybeSample({
        taskType: "test",
        requiredTier: 1,
        routedModel: "claude-haiku",
        prompt: "test prompt " + i,
        response: "test response " + i,
      });
    }
    await cal.gradePending();
    expect(cal.tierBoost("test")).toBe(0);
  });

  it("sampleRate 0: never samples", () => {
    cal = new Calibrator(
      ":memory:",
      async () => JSON.stringify({ adequate: true }),
      { sampleRate: 0, minSamples: 1, apply: false, gradeIntervalMs: 0, adequacyThreshold: 0.8, batchSize: 10 }
    );
    for (let i = 0; i < 10; i++) {
      cal.maybeSample({
        taskType: "test",
        requiredTier: 1,
        routedModel: "claude-haiku",
        prompt: "test",
        response: "test",
      });
    }
    expect(cal.snapshot().pending).toBe(0);
  });
});

describe("Setup command", () => {
  it("no args returns 0 with usage text", async () => {
    const code = await runSetup([]);
    expect(code).toBe(0);
  });

  it("unknown harness returns 1", async () => {
    const code = await runSetup(["nope" as any]);
    expect(code).toBe(1);
  });

  it("claude-code returns 0", async () => {
    const code = await runSetup(["claude-code"]);
    expect(code).toBe(0);
  });

  it("copilot returns 0", async () => {
    const code = await runSetup(["copilot"]);
    expect(code).toBe(0);
  });
});

describe("Server integration", () => {
  let mockServer: ReturnType<typeof Bun.serve>;
  let appServer: Awaited<ReturnType<typeof startServer>> | null = null;
  let mockUrl: string = "";

  afterEach(async () => {
    if (appServer?.stop) appServer.stop();
    if (mockServer?.stop) mockServer.stop(true);
  });

  it("serves budget and health endpoints with budgets config", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;
        if (req.method === "POST" && path === "/v1/messages") {
          return Response.json({
            id: "msg_1",
            type: "message",
            model: "claude-3-5-haiku-20241022",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    const port = mockServer.port;
    mockUrl = `http://localhost:${port}`;

    const config: RouterConfig = {
      port: 0,
      mode: "aggressive",
      cacheEnabled: false,
      cacheTtlMs: 60000,
      dbPath: ":memory:",
      upstreams: [
        { name: "anthropic", baseUrl: mockUrl, dialect: "anthropic", models: ["claude-*"], authStyle: "none", default: true },
      ],
      budgets: { dailyUsd: 100 },
      shadow: { mode: "off" },
    };

    appServer = await startServer(config, new PluginPipeline());
    const appUrl = `http://localhost:${appServer!.server.port}`;

    const budgetRes = await fetch(`${appUrl}/api/budget`);
    expect(budgetRes.ok).toBe(true);
    const budget = (await budgetRes.json()) as { enabled: boolean };
    expect(budget.enabled).toBe(true);

    const healthRes = await fetch(`${appUrl}/api/upstream-health`);
    expect(healthRes.ok).toBe(true);
    const health = (await healthRes.json()) as unknown[];
    expect(Array.isArray(health)).toBe(true);

    const calibRes = await fetch(`${appUrl}/api/calibration`);
    expect(calibRes.ok).toBe(true);
    const calib = (await calibRes.json()) as { enabled: boolean };
    expect(calib.enabled).toBe(false);
  });

  it("request includes router headers and shadow mode off", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/v1/messages") {
          return Response.json({
            id: "msg_1",
            type: "message",
            model: "claude-3-5-haiku-20241022",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    const port = mockServer.port;
    mockUrl = `http://localhost:${port}`;

    const config: RouterConfig = {
      port: 0,
      mode: "aggressive",
      cacheEnabled: false,
      cacheTtlMs: 60000,
      dbPath: ":memory:",
      upstreams: [
        { name: "anthropic", baseUrl: mockUrl, dialect: "anthropic", authStyle: "none", default: true },
      ],
      budgets: { dailyUsd: 100 },
      shadow: { mode: "off" },
    };

    appServer = await startServer(config, new PluginPipeline());
    const appUrl = `http://localhost:${appServer!.server.port}`;

    const res = await fetch(`${appUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("x-router-budget-used")).toBeDefined();
    expect(res.headers.get("x-router-shadow-model")).toBeDefined();
  });
});
