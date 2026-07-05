import { describe, it, expect } from "bun:test";
import { familyOf, parseFeed } from "../src/pricefeed.ts";

describe("pricefeed", () => {
  describe("familyOf", () => {
    it('extracts family "claude-opus" and version 4.8 from "claude-opus-4-8"', () => {
      const result = familyOf("claude-opus-4-8");
      expect(result.family).toBe("claude-opus");
      expect(result.version).toBe(4.8);
    });

    it('extracts family "gpt-mini" and version 5.4 from "gpt-5.4-mini"', () => {
      const result = familyOf("gpt-5.4-mini");
      expect(result.family).toBe("gpt-mini");
      expect(result.version).toBe(5.4);
    });

    it('extracts family "gpt" and version 5.5 from "gpt-5.5"', () => {
      const result = familyOf("gpt-5.5");
      expect(result.family).toBe("gpt");
      expect(result.version).toBe(5.5);
    });

    it('extracts family "claude-haiku" and version 4.5 from "claude-haiku-4-5"', () => {
      const result = familyOf("claude-haiku-4-5");
      expect(result.family).toBe("claude-haiku");
      expect(result.version).toBe(4.5);
    });

    it('extracts family "gpt-nano" and version 5.4 from "gpt-5.4-nano"', () => {
      const result = familyOf("gpt-5.4-nano");
      expect(result.family).toBe("gpt-nano");
      expect(result.version).toBe(5.4);
    });
  });

  describe("parseFeed", () => {
    it("keeps only openai and anthropic providers with mode chat/responses and both costs present", () => {
      const feed = {
        "claude-haiku-4-5": {
          litellm_provider: "anthropic",
          mode: "chat",
          input_cost_per_token: 5e-8,
          output_cost_per_token: 2.5e-7,
          max_input_tokens: 200_000,
        },
        "gemini-2-pro": {
          litellm_provider: "google",
          mode: "chat",
          input_cost_per_token: 1e-7,
          output_cost_per_token: 2e-7,
          max_input_tokens: 1_000_000,
        },
        "gpt-5.4-nano": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
        "gpt-invalid": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          // missing output_cost_per_token
          max_input_tokens: 1_050_000,
        },
      };
      const result = parseFeed(feed);
      expect(result.length).toBe(2);
      expect(result.some((m) => m.id === "claude-haiku-4-5")).toBe(true);
      expect(result.some((m) => m.id === "gpt-5.4-nano")).toBe(true);
      expect(result.some((m) => m.id === "gemini-2-pro")).toBe(false);
      expect(result.some((m) => m.id === "gpt-invalid")).toBe(false);
    });

    it("converts per-token costs to per-1M", () => {
      const feed = {
        "gpt-5.4-nano": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
      };
      const result = parseFeed(feed);
      expect(result.length).toBe(1);
      expect(result[0]!.inputPer1M).toBeCloseTo(0.2, 5);
      expect(result[0]!.outputPer1M).toBeCloseTo(1.25, 5);
    });

    it("keeps only the newest version per family", () => {
      const feed = {
        "gpt-5.4-nano": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
        "gpt-5.4-mini": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 7.5e-7,
          output_cost_per_token: 4.5e-6,
          max_input_tokens: 1_050_000,
        },
        "gpt-5.5": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 5e-6,
          output_cost_per_token: 3e-5,
          max_input_tokens: 1_050_000,
        },
        "gpt-5.1": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 1e-7,
          output_cost_per_token: 5e-7,
          max_input_tokens: 1_050_000,
        },
      };
      const result = parseFeed(feed);
      // gpt-5.4-nano, gpt-5.4-mini, gpt-5.5 should survive (newest per family)
      // gpt-5.1 should be filtered out (older gpt family)
      const gptFamily = result.filter((m) => m.provider === "openai");
      const families = new Set(gptFamily.map((m) => {
        const vMatch = m.id.match(/\d+(?:[.-]\d+)*/);
        const fam = m.id.replace(/\d+(?:[.-]\d+)*/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
        return fam;
      }));
      // Only newest versions per family
      expect(result.some((m) => m.id === "gpt-5.5")).toBe(true); // newest gpt
      expect(result.some((m) => m.id === "gpt-5.1")).toBe(false); // old gpt
    });

    it("excludes dated ids like gpt-5.4-2026-03-05", () => {
      const feed = {
        "gpt-5.4-2026-03-05": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
        "gpt-5.4-nano": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
      };
      const result = parseFeed(feed);
      expect(result.some((m) => m.id === "gpt-5.4-2026-03-05")).toBe(false);
      expect(result.some((m) => m.id === "gpt-5.4-nano")).toBe(true);
    });

    it("excludes ids containing chat-latest or preview", () => {
      const feed = {
        "gpt-5.4-chat-latest": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
        "gpt-5.4-preview": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
        "gpt-5.4-nano": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 1.25e-6,
          max_input_tokens: 1_050_000,
        },
      };
      const result = parseFeed(feed);
      expect(result.some((m) => m.id === "gpt-5.4-chat-latest")).toBe(false);
      expect(result.some((m) => m.id === "gpt-5.4-preview")).toBe(false);
      expect(result.some((m) => m.id === "gpt-5.4-nano")).toBe(true);
    });

    it("assigns tier 1 to a claude-haiku-9-9 entry (known family map)", () => {
      const feed = {
        "claude-haiku-9-9": {
          litellm_provider: "anthropic",
          mode: "chat",
          input_cost_per_token: 1e-8,
          output_cost_per_token: 5e-8,
          max_input_tokens: 200_000,
        },
      };
      const result = parseFeed(feed);
      expect(result.length).toBe(1);
      expect(result[0]!.tier).toBe(1);
    });

    it("assigns price-band tiers to unknown families", () => {
      const feed = {
        "unknown-cheap-1-0": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 5e-7,
          output_cost_per_token: 2e-7,
          max_input_tokens: 1_050_000,
        },
        "unknown-mid-2-0": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 1.5e-6,
          output_cost_per_token: 2e-6,
          max_input_tokens: 1_050_000,
        },
        "unknown-expensive-3-0": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 5e-6,
          output_cost_per_token: 5e-6,
          max_input_tokens: 1_050_000,
        },
      };
      const result = parseFeed(feed);
      expect(result.length).toBe(3);
      const cheap = result.find((m) => m.id === "unknown-cheap-1-0");
      const mid = result.find((m) => m.id === "unknown-mid-2-0");
      const expensive = result.find((m) => m.id === "unknown-expensive-3-0");
      // blended is 0.75*input + 0.25*output
      // cheap: 0.75*0.5 + 0.25*0.2 = 0.375 + 0.05 = 0.425 < 0.9 -> tier 1
      // mid: 0.75*1.5 + 0.25*2 = 1.125 + 0.5 = 1.625, between 0.9 and 3 -> tier 2
      // expensive: 0.75*5 + 0.25*5 = 3.75 + 1.25 = 5, between 3 and 12 -> tier 3
      expect(cheap?.tier).toBe(1);
      expect(mid?.tier).toBe(2);
      expect(expensive?.tier).toBe(3);
    });
  });
});
