import { describe, it, expect, afterEach, afterAll } from "bun:test";
import {
  setModelAllowlist,
  listModels,
  getModel,
  registerModel,
  normalizeModelId,
} from "../src/registry.ts";
import { route, requestNeedsVision, requestUsesTools, type RouteInputs } from "../src/router.ts";
import { Upstreams, DEFAULT_UPSTREAMS, loadRouterSetup, kindOf } from "../src/upstreams.ts";
import { parseGatewayFeed } from "../src/pricefeed.ts";
import { PluginPipeline, type ProxyPlugin, type PluginContext } from "../src/plugins/index.ts";
import { heuristicStrategy, type Classification } from "../src/strategy.ts";
import type { UpstreamProvider, RouteDecision } from "../src/types.ts";
import { rmSync, mkdirSync } from "fs";

/** Type for feed entries in parseGatewayFeed (not exported from pricefeed.ts) */
interface FeedEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  max_input_tokens?: number;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
}

// Helper for trivial classification
function trivialClassification(): Classification {
  return {
    taskType: "chat",
    requiredTier: 1,
    complexity: 0.1,
    confidence: 0.9,
    reasons: [],
  };
}

function routeWithClassification(inputs: Omit<RouteInputs, "classification">, classification?: Classification) {
  return route({
    ...inputs,
    classification: classification || trivialClassification(),
  });
}

describe("Features: Allowlist", () => {
  afterEach(() => {
    setModelAllowlist(null);
  });

  it("setModelAllowlist restricts listModels but getModel still resolves", () => {
    setModelAllowlist(["claude-haiku-*"]);

    const models = listModels("anthropic");
    // Only haiku should be in the list
    expect(models.every((m) => m.id.includes("haiku"))).toBe(true);
    expect(models.some((m) => m.id.includes("opus"))).toBe(false);
    expect(models.some((m) => m.id.includes("sonnet"))).toBe(false);

    // But getModel still finds opus (for pass-through, baseline pricing)
    const opus = getModel("claude-opus-4-8");
    expect(opus).not.toBeUndefined();
    expect(opus?.id).toBe("claude-opus-4-8");
  });

  it("trivial claude-opus-4-8 request routes to cheapest haiku when allowlist is set", () => {
    setModelAllowlist(["claude-haiku-*"]);

    const ups = new Upstreams(DEFAULT_UPSTREAMS);
    const home = ups.get("anthropic")!;
    const body = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
    };

    const decision = routeWithClassification({
      body,
      dialect: "anthropic",
      home,
      upstreams: ups,
      config: { mode: "aggressive", crossProvider: false },
    });
    expect(decision.routedModel).toBe("claude-haiku-4-5");
  });

  it("trivial opus request keeps opus when allowlist is [claude-opus-*]", () => {
    setModelAllowlist(["claude-opus-*"]);

    const ups = new Upstreams(DEFAULT_UPSTREAMS);
    const home = ups.get("anthropic")!;
    const body = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
    };

    const decision = routeWithClassification({
      body,
      dialect: "anthropic",
      home,
      upstreams: ups,
      config: { mode: "aggressive", crossProvider: false },
    });
    // Opus is allowed, so it's the only option; it should be kept
    expect(decision.routedModel).toBe("claude-opus-4-8");
  });
});

describe("Features: Capability Routing", () => {
  afterEach(() => {
    // Clean up the temp model
    const spec = getModel("tiny-text");
    if (spec) {
      registerModel({ ...spec, enabled: false });
    }
  });

  it("requestNeedsVision detects anthropic image blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } },
          ],
        },
      ],
    };
    expect(requestNeedsVision(body)).toBe(true);
  });

  it("requestNeedsVision detects openai image_url blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What's in this image?" }, { type: "image_url", image_url: { url: "https://..." } }],
        },
      ],
    };
    expect(requestNeedsVision(body)).toBe(true);
  });

  it("requestNeedsVision returns false for text-only", () => {
    const body = {
      messages: [{ role: "user", content: "just text" }],
    };
    expect(requestNeedsVision(body)).toBe(false);
  });

  it("requestUsesTools returns true when body.tools is non-empty", () => {
    const body = {
      messages: [{ role: "user", content: "call a tool" }],
      tools: [{ name: "get_weather", description: "Get the weather" }],
    };
    expect(requestUsesTools(body)).toBe(true);
  });

  it("requestUsesTools returns false when body.tools is absent or empty", () => {
    const body1 = {
      messages: [{ role: "user", content: "no tools" }],
    };
    expect(requestUsesTools(body1)).toBe(false);

    const body2 = {
      messages: [{ role: "user", content: "empty tools" }],
      tools: [],
    };
    expect(requestUsesTools(body2)).toBe(false);
  });

  it("text-only request routes to cheapest (tiny-text) when available", () => {
    registerModel({
      id: "tiny-text",
      provider: "anthropic",
      inputPer1M: 0.01,
      outputPer1M: 0.05,
      tier: 1,
      contextWindow: 100000,
      enabled: true,
      vision: false,
    });

    // Create an upstream that serves tiny-text
    const ups = new Upstreams([
      ...DEFAULT_UPSTREAMS,
      {
        name: "cheap",
        baseUrl: "https://cheap.api",
        dialect: "anthropic",
        models: ["tiny-*"],
        authStyle: "none",
      },
    ]);
    const home = ups.get("anthropic")!;
    const body = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "just text" }],
    };

    const decision = routeWithClassification({
      body,
      dialect: "anthropic",
      home,
      upstreams: ups,
      config: { mode: "aggressive", crossProvider: false },
    });
    expect(decision.routedModel).toBe("tiny-text");
  });

  it("request with image routes to vision-capable model even if cheaper text-only exists", () => {
    registerModel({
      id: "tiny-text",
      provider: "anthropic",
      inputPer1M: 0.01,
      outputPer1M: 0.05,
      tier: 1,
      contextWindow: 100000,
      enabled: true,
      vision: false,
    });

    const ups = new Upstreams(DEFAULT_UPSTREAMS);
    const home = ups.get("anthropic")!;
    const body = {
      model: "claude-opus-4-8",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } },
          ],
        },
      ],
    };

    const decision = routeWithClassification({
      body,
      dialect: "anthropic",
      home,
      upstreams: ups,
      config: { mode: "aggressive", crossProvider: false },
    });
    // Should not route to tiny-text (vision: false), instead haiku (vision-capable)
    expect(decision.routedModel).toBe("claude-haiku-4-5");
    expect(decision.routedModel).not.toBe("tiny-text");
  });
});

describe("Features: resolveUpstream Presets", () => {
  it("resolveUpstream(\"github-copilot\") yields github-copilot endpoint with openai dialect", async () => {
    const { resolveUpstream } = await import("../src/upstreams.ts");
    const resolved = resolveUpstream("github-copilot");
    expect(resolved.name).toBe("github-copilot");
    expect(resolved.baseUrl).toBe("https://api.githubcopilot.com");
    expect(resolved.dialect).toBe("openai");
    expect(resolved.stripV1).toBe(true);
    expect(resolved.crossProvider).toBe(true);
  });

  it("resolveUpstream with user preset override keeps apiKeyEnv", async () => {
    const { resolveUpstream } = await import("../src/upstreams.ts");
    const resolved = resolveUpstream({
      name: "my-openrouter",
      preset: "openrouter",
      apiKeyEnv: "MY_KEY",
    });
    expect(resolved.name).toBe("my-openrouter");
    expect(resolved.preset).toBe("openrouter");
    expect(resolved.apiKeyEnv).toBe("MY_KEY");
    expect(resolved.vendorPrefix).toBe(true);
  });

  it("resolveUpstream with bad name and no preset throws", async () => {
    const { resolveUpstream } = await import("../src/upstreams.ts");
    expect(() => {
      resolveUpstream({
        name: "bad-upstream",
        // No preset, no baseUrl/dialect
      });
    }).toThrow();
  });
});

describe("Features: parseGatewayFeed + Gateway Pricing", () => {
  it("parseGatewayFeed extracts github_copilot models with normalized ids", () => {
    const feed: Record<string, FeedEntry> = {
      "github_copilot/claude-haiku-4.5": {
        litellm_provider: "github_copilot",
        mode: "chat",
      },
      "github_copilot/gpt-5.4": {
        litellm_provider: "github_copilot",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
      "openai/gpt-5.5": {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 5e-6,
        output_cost_per_token: 3e-5,
      },
    };

    const result = parseGatewayFeed(feed);

    // Should have github_copilot key
    expect(result.has("github_copilot")).toBe(true);

    // Should not have openai key (openai is for direct API, not gateway)
    expect(result.has("openai")).toBe(false);

    // github_copilot should have normalized ids
    const copilotModels = result.get("github_copilot")!;
    expect(copilotModels.has("claude-haiku-4-5")).toBe(true);
    expect(copilotModels.has("gpt-5-4")).toBe(true);

    // Pricing: claude-haiku-4.5 should have null costs (subscription)
    const haikuPricing = copilotModels.get("claude-haiku-4-5")!;
    expect(haikuPricing.inputPer1M).toBeNull();
    expect(haikuPricing.outputPer1M).toBeNull();

    // Pricing: gpt-5-4 should have costs in per-1M (1e-6 * 1e6 = 1)
    const gptPricing = copilotModels.get("gpt-5-4")!;
    expect(gptPricing.inputPer1M).toBe(1);
    expect(gptPricing.outputPer1M).toBe(2);
  });
});

describe("Features: Upstreams Auto-Pricing", () => {
  afterEach(() => {
    const spec = getModel("my-model");
    if (spec) {
      registerModel({ ...spec, enabled: false });
    }
  });

  it("kindOf returns 'github_copilot' for github copilot URLs", () => {
    const upstream: UpstreamProvider = {
      name: "copilot",
      baseUrl: "https://api.githubcopilot.com/v1",
      dialect: "anthropic",
    };
    expect(kindOf(upstream)).toBe("github_copilot");
  });

  it("kindOf returns null for unknown hosts", () => {
    const upstream: UpstreamProvider = {
      name: "private",
      baseUrl: "https://llm.internal",
      dialect: "anthropic",
    };
    expect(kindOf(upstream)).toBe(null);
  });

  it("upstream with custom pricing registers model and pricesFor returns custom prices", async () => {
    const tmpDir = `${import.meta.dir}/.tmp`;
    try {
      mkdirSync(tmpDir);
    } catch {
      // already exists
    }
    const configPath = `${tmpDir}/temp-router-config.json`;
    const config = {
      providers: [
        {
          name: "custom",
          baseUrl: "https://custom.api/v1",
          dialect: "anthropic" as const,
          pricing: {
            "my-model": {
              inputPer1M: 0.5,
              outputPer1M: 2,
              tier: 2 as const,
            },
          },
        },
      ],
    };

    await Bun.write(configPath, JSON.stringify(config));

    try {
      const setup = await loadRouterSetup(configPath);
      const customUpstream = setup.upstreams.get("custom")!;
      const myModel = getModel("my-model");

      expect(myModel).not.toBeUndefined();
      expect(myModel?.id).toBe("my-model");

      const prices = setup.upstreams.pricesFor(customUpstream, myModel!);
      expect(prices.inputPer1M).toBe(0.5);
      expect(prices.outputPer1M).toBe(2);
    } finally {
      try {
        await Bun.file(configPath).unlink?.();
      } catch {
        // ignore
      }
    }
  });

  it("plain upstream without custom pricing uses catalog prices", () => {
    const ups = new Upstreams(DEFAULT_UPSTREAMS);
    const anthropic = ups.get("anthropic")!;
    const haiku = getModel("claude-haiku-4-5")!;

    const prices = ups.pricesFor(anthropic, haiku);
    expect(prices.inputPer1M).toBe(1); // from DEFAULT_MODELS
    expect(prices.outputPer1M).toBe(5);
  });

  it("upstream with priceMultiplier 0.5 returns half the catalog price", () => {
    const ups = new Upstreams([
      {
        name: "half-price",
        baseUrl: "https://example.com",
        dialect: "anthropic",
        models: ["claude-*"],
        priceMultiplier: 0.5,
        authStyle: "none",
      },
    ]);

    const halfPrice = ups.get("half-price")!;
    const haiku = getModel("claude-haiku-4-5")!;

    const prices = ups.pricesFor(halfPrice, haiku);
    expect(prices.inputPer1M).toBe(0.5); // 1 * 0.5
    expect(prices.outputPer1M).toBe(2.5); // 5 * 0.5
  });
});

describe("Features: Plugin Hooks", () => {
  const tmpDir = `${import.meta.dir}/.tmp`;

  afterAll(() => {
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const getTmpPath = (name: string) => `${tmpDir}/${name}`;

  // Helper for creating minimal RouteDecision fixtures
  function createDecision(overrides?: Partial<RouteDecision>): RouteDecision {
    return {
      requestedModel: "claude-opus-4-8",
      routedModel: "claude-haiku-4-5",
      upstream: "anthropic",
      provider: "anthropic",
      complexity: 0.5,
      requiredTier: 2,
      escalationBoost: 0,
      auto: false,
      taskType: "chat",
      sticky: false,
      estCostUsd: 0.001,
      reason: "test",
      ...overrides,
    };
  }

  // Helper for creating minimal PluginContext fixtures
  function createCtx(overrides?: Partial<PluginContext>): PluginContext {
    return {
      provider: "anthropic",
      mount: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
      ...overrides,
    };
  }

  it("runRouteDecision allows plugin to replace the decision", async () => {
    const pipeline = new PluginPipeline();

    const plugin: ProxyPlugin = {
      name: "decision-replacer",
      onRouteDecision(decision: RouteDecision): RouteDecision {
        return { ...decision, routedModel: "x" };
      },
    };

    pipeline.use(plugin);

    const originalDecision = createDecision();
    const ctx = createCtx();

    const result = await pipeline.runRouteDecision(originalDecision, {}, ctx);
    expect(result.routedModel).toBe("x");
  });

  it("runRouteDecision with void-returning plugin keeps the decision", async () => {
    const pipeline = new PluginPipeline();

    const plugin: ProxyPlugin = {
      name: "void-plugin",
      onRouteDecision(): void {
        // Return void (undefined)
      },
    };

    pipeline.use(plugin);

    const originalDecision = createDecision();
    const ctx = createCtx();

    const result = await pipeline.runRouteDecision(originalDecision, {}, ctx);
    expect(result.routedModel).toBe("claude-haiku-4-5");
  });

  it("runRouteDecision swallows throwing onRouteDecision", async () => {
    const pipeline = new PluginPipeline();

    const plugin: ProxyPlugin = {
      name: "throwing-plugin",
      onRouteDecision(): never {
        throw new Error("plugin error");
      },
    };

    pipeline.use(plugin);

    const originalDecision = createDecision();
    const ctx = createCtx();

    const result = await pipeline.runRouteDecision(originalDecision, {}, ctx);
    // Decision should be kept despite throw
    expect(result.routedModel).toBe("claude-haiku-4-5");
  });

  it("runRecord invokes onRecord with the record", async () => {
    const pipeline = new PluginPipeline();
    let capturedRecord: any = null;

    const plugin: ProxyPlugin = {
      name: "recorder",
      onRecord(record) {
        capturedRecord = record;
      },
    };

    pipeline.use(plugin);

    const record: any = {
      ts: Date.now(),
      provider: "anthropic",
      upstream: "anthropic",
      requestedModel: "claude-opus-4-8",
      routedModel: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 50,
      costActual: 0.5,
      costBaseline: 1.0,
      savedUsd: 0.5,
      cacheHit: false,
      downgraded: true,
      latencyMs: 500,
      taskType: "chat",
      complexity: 0.1,
      requiredTier: 1,
      escalationBoost: 0,
      sticky: false,
      conversation: "conv-123",
    };

    const ctx = createCtx();

    await pipeline.runRecord(record, ctx);
    expect(capturedRecord).toBe(record);
  });

  it("runRecord swallows throwing onRecord", async () => {
    const pipeline = new PluginPipeline();

    const plugin: ProxyPlugin = {
      name: "throwing-recorder",
      onRecord(): never {
        throw new Error("record error");
      },
    };

    pipeline.use(plugin);

    const record: any = {
      ts: Date.now(),
      provider: "anthropic",
      upstream: "anthropic",
      requestedModel: "claude-opus-4-8",
      routedModel: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 50,
      costActual: 0.5,
      costBaseline: 1.0,
      savedUsd: 0.5,
      cacheHit: false,
      downgraded: true,
      latencyMs: 500,
      taskType: "chat",
      complexity: 0.1,
      requiredTier: 1,
      escalationBoost: 0,
      sticky: false,
      conversation: "conv-123",
    };

    const ctx = createCtx();

    // Should not throw
    await pipeline.runRecord(record, ctx);
  });

  it("loadFromPaths loads a plugin from a module file", async () => {
    const tempPluginPath = getTmpPath("temp-plugin.ts");
    try {
      mkdirSync(tmpDir);
    } catch {
      // already exists
    }

    const pluginCode = `export default {
  name: "temp-plugin",
  onRequest(body: any) {
    return body;
  },
};`;

    await Bun.write(tempPluginPath, pluginCode);

    const pipeline = new PluginPipeline();
    const resolve = (p: string) => {
      // For relative paths, resolve against tmpDir
      if (p.startsWith(".")) {
        return `${tmpDir}/${p.slice(2)}`;
      }
      return p;
    };

    // Use a small delay to ensure file is written before importing
    await new Promise((r) => setTimeout(r, 10));

    await pipeline.loadFromPaths(["./temp-plugin.ts"], resolve);

    const names = pipeline.list();
    expect(names).toContain("temp-plugin");
  });

  it("loadFromPaths logs error for nonexistent path but does not throw", async () => {
    const pipeline = new PluginPipeline();

    // Should not throw even if path doesn't exist
    const nonExistentPath = `${tmpDir}/nonexistent-plugin-xyz.ts`;
    await pipeline.loadFromPaths([nonExistentPath], (p: string) => p);

    const names = pipeline.list();
    expect(names.length).toBe(0);
  });

  it("loadFromPaths works with factory function", async () => {
    const tempPluginPath = getTmpPath("temp-factory-plugin.ts");
    try {
      mkdirSync(tmpDir);
    } catch {
      // already exists
    }

    const pluginCode = `export default function createPlugin() {
  return {
    name: "factory-plugin",
    onRequest(body: any) {
      return body;
    },
  };
}`;

    await Bun.write(tempPluginPath, pluginCode);

    const pipeline = new PluginPipeline();
    const resolve = (p: string) => {
      if (p.startsWith(".")) {
        return `${tmpDir}/${p.slice(2)}`;
      }
      return p;
    };

    // Use a small delay to ensure file is written before importing
    await new Promise((r) => setTimeout(r, 10));

    await pipeline.loadFromPaths(["./temp-factory-plugin.ts"], resolve);

    const names = pipeline.list();
    expect(names).toContain("factory-plugin");
  });
});
