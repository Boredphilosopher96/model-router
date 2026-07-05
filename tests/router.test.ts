import { describe, it, expect } from "bun:test";
import { estimateComplexity, route, type RouteInputs } from "../src/router.ts";
import { getModel } from "../src/registry.ts";
import { Upstreams, DEFAULT_UPSTREAMS } from "../src/upstreams.ts";
import { heuristicStrategy, type Classification } from "../src/strategy.ts";

describe("router", () => {
  describe("estimateComplexity", () => {
    it("short single message scores < 0.25", () => {
      const body = {
        messages: [{ role: "user", content: "hi" }],
      };
      const score = estimateComplexity(body);
      expect(score).toBeLessThan(0.25);
    });

    it("long message with 8 tools and max_tokens 32000 scores >= 0.6", () => {
      const longMessage = "x".repeat(60_000);
      const body = {
        messages: [{ role: "user", content: longMessage }],
        tools: Array(8).fill({ name: "tool" }),
        max_tokens: 32_000,
      };
      const score = estimateComplexity(body);
      expect(score).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("route", () => {
    const ups = new Upstreams(DEFAULT_UPSTREAMS);
    const anthropicHome = ups.get("anthropic")!;
    const openaiHome = ups.get("openai")!;

    // Helper to create basic trivial classification
    const trivialClassification = (): Classification => ({
      taskType: "chat",
      requiredTier: 1,
      complexity: 0.1,
      confidence: 0.9,
      reasons: [],
    });

    const routeWithClassification = (inputs: Omit<RouteInputs, "classification">, classification?: Classification) => {
      return route({
        ...inputs,
        classification: classification || trivialClassification(),
      });
    };

    it('aggressive mode: claude-opus-4-8 on anthropic routes to claude-haiku-4-5', () => {
      const body = {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "anthropic",
        home: anthropicHome,
        upstreams: ups,
        config: { mode: "aggressive", crossProvider: false },
      });
      expect(decision.routedModel).toBe("claude-haiku-4-5");
    });

    it('aggressive mode: gpt-5.4 on openai routes to gpt-5.4-nano', () => {
      const body = {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "openai",
        home: openaiHome,
        upstreams: ups,
        config: { mode: "aggressive", crossProvider: false },
      });
      expect(decision.routedModel).toBe("gpt-5.4-nano");
    });

    it('balanced mode: claude-opus-4-8 routes to claude-sonnet-4-6', () => {
      const body = {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "anthropic",
        home: anthropicHome,
        upstreams: ups,
        config: { mode: "balanced", crossProvider: false },
      });
      expect(decision.routedModel).toBe("claude-sonnet-4-6");
    });

    it('off mode: keeps the requested model', () => {
      const body = {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "anthropic",
        home: anthropicHome,
        upstreams: ups,
        config: { mode: "off", crossProvider: false },
      });
      expect(decision.routedModel).toBe("claude-opus-4-8");
    });

    it('unknown model id passes through unchanged', () => {
      const body = {
        model: "unknown-model-xyz",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "anthropic",
        home: anthropicHome,
        upstreams: ups,
        config: { mode: "aggressive", crossProvider: false },
      });
      expect(decision.routedModel).toBe("unknown-model-xyz");
      expect(decision.reason).toContain("unknown model");
    });

    it('routed model never has higher tier than requested', () => {
      const body = {
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "anthropic",
        home: anthropicHome,
        upstreams: ups,
        config: { mode: "aggressive", crossProvider: false },
      });
      expect(decision.routedModel).toBe("claude-haiku-4-5");

      const requestedTier = getModel("claude-haiku-4-5")!.tier;
      const routedTier = getModel(decision.routedModel)!.tier;
      expect(routedTier).toBeLessThanOrEqual(requestedTier);
    });

    it('auto model with aggressive mode routes to cheapest tier-1 model', () => {
      const body = {
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "openai",
        home: openaiHome,
        upstreams: ups,
        config: { mode: "aggressive", crossProvider: false },
      });
      expect(decision.auto).toBe(true);
      expect(decision.routedModel).toBe("gpt-5.4-nano");
    });

    it('escalationBoost: tier-1 request with boost 2 escalates to tier-3 capable model', () => {
      const body = {
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification(
        {
          body,
          dialect: "anthropic",
          home: anthropicHome,
          upstreams: ups,
          config: { mode: "aggressive", crossProvider: false },
          escalationBoost: 2,
        },
      );
      expect(decision.escalationBoost).toBe(2);
      const routedSpec = getModel(decision.routedModel)!;
      expect(routedSpec.tier).toBeGreaterThanOrEqual(3);
    });

    it('namespace preservation: gateway with vendor prefix preserves slash and dot syntax', () => {
      const gateways = new Upstreams([
        {
          name: "gw",
          baseUrl: "http://example.com",
          dialect: "openai",
          models: ["claude-*", "gpt-*"],
          authStyle: "none",
        },
      ]);
      const gwHome = gateways.get("gw")!;
      const body = {
        model: "anthropic/claude-opus-4.8",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "openai",
        home: gwHome,
        upstreams: gateways,
        config: { mode: "aggressive", crossProvider: false },
      });
      expect(decision.routedModel).toContain("anthropic/");
      expect(decision.routedModel).toContain("claude-haiku");
      expect(decision.upstream).toBe("gw");
    });

    it('priceMultiplier: flat-rate upstream (0x) beats paid upstream', () => {
      const ups2 = new Upstreams([
        {
          name: "direct",
          baseUrl: "http://a",
          dialect: "anthropic",
          models: ["claude-*"],
          authStyle: "none",
          default: true,
        },
        {
          name: "flat",
          baseUrl: "http://b",
          dialect: "anthropic",
          models: ["claude-*"],
          priceMultiplier: 0,
          authStyle: "none",
        },
      ]);
      const directHome = ups2.get("direct")!;
      const body = {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
      };
      const decision = routeWithClassification({
        body,
        dialect: "anthropic",
        home: directHome,
        upstreams: ups2,
        config: { mode: "aggressive", crossProvider: false },
      });
      expect(decision.upstream).toBe("flat");
    });

    describe("cache-aware stickiness", () => {
      it("long history body without lastRoute routes to haiku", () => {
        const messages = Array(20).fill(null).map((_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: "x".repeat(8000),
        }));
        const body = {
          model: "claude-haiku-4-5",
          messages,
        };
        const decision = routeWithClassification({
          body,
          dialect: "anthropic",
          home: anthropicHome,
          upstreams: ups,
          config: { mode: "aggressive", crossProvider: false },
          lastRoute: null,
        });
        expect(decision.routedModel).toBe("claude-haiku-4-5");
        expect(decision.sticky).toBe(false);
      });

      it("long history with lastRoute haiku keeps haiku warm (with cache warmth)", () => {
        const messages = Array(20).fill(null).map((_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: "x".repeat(8000),
        }));
        const body = {
          model: "claude-haiku-4-5",
          messages,
        };
        const decision = routeWithClassification({
          body,
          dialect: "anthropic",
          home: anthropicHome,
          upstreams: ups,
          config: { mode: "aggressive", crossProvider: false },
          lastRoute: { model: "claude-haiku-4-5", upstream: "anthropic" },
        });
        // When the last route is haiku and we keep haiku, sticky reflects cache warmth
        expect(decision.routedModel).toBe("claude-haiku-4-5");
        expect(decision.sticky).toBe(true);
      });

      it("short body with lastRoute switches away, sticky false", () => {
        const body = {
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "hi" }],
        };
        const decision = routeWithClassification({
          body,
          dialect: "anthropic",
          home: anthropicHome,
          upstreams: ups,
          config: { mode: "aggressive", crossProvider: false },
          lastRoute: { model: "claude-opus-4-8", upstream: "anthropic" },
        });
        expect(decision.routedModel).toBe("claude-haiku-4-5");
        expect(decision.sticky).toBe(false);
      });

      it("quality mode: low confidence keeps requested tier on opus", () => {
        const body = {
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "hi" }],
        };
        const lowConfidenceClassification: Classification = {
          taskType: "chat",
          requiredTier: 1,
          complexity: 0.1,
          confidence: 0.5,
          reasons: ["low confidence"],
        };
        const decision = routeWithClassification(
          {
            body,
            dialect: "anthropic",
            home: anthropicHome,
            upstreams: ups,
            config: { mode: "quality", crossProvider: false },
          },
          lowConfidenceClassification,
        );
        expect(decision.routedModel).toBe("claude-opus-4-8");
      });
    });
  });
});
