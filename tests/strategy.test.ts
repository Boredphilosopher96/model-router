import { describe, it, expect } from "bun:test";
import { heuristicStrategy, type Classification } from "../src/strategy.ts";

describe("strategy: heuristicStrategy classification", () => {
  describe("task taxonomy", () => {
    it("short 'what is X?' -> tier 1 chat", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [{ role: "user", content: "what is machine learning?" }],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.requiredTier).toBe(1);
      expect(classification.taskType).toBe("lookup");
    });

    it("'refactor and write tests' -> tier 2 codegen", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [{ role: "user", content: "please refactor this function and write comprehensive tests" }],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.requiredTier).toBe(2);
      expect(classification.taskType).toBe("codegen");
    });

    it("'design the system architecture ... tradeoffs' -> tier >= 3 architecture", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [
          {
            role: "user",
            content: "Design the system architecture for a distributed cache system, considering scalability tradeoffs and failure modes",
          },
        ],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.requiredTier).toBeGreaterThanOrEqual(3);
      expect(classification.taskType).toBe("architecture");
    });

    it("'why does this deadlock? root cause' -> debug tier >= 2", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [
          {
            role: "user",
            content: "Why does this deadlock occur? Help me find the root cause of the deadlock",
          },
        ],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.requiredTier).toBeGreaterThanOrEqual(2);
      expect(classification.taskType).toBe("debug");
    });
  });

  describe("task rules override", () => {
    it("pattern 'compliance' matches rule -> tier 4 wins", () => {
      const strategy = heuristicStrategy({
        taskRules: [{ pattern: "compliance", tier: 4, taskType: "compliance" }],
      });
      const body = {
        messages: [
          {
            role: "user",
            content: "Check this code for GDPR compliance issues",
          },
        ],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.requiredTier).toBe(4);
      expect(classification.taskType).toBe("compliance");
      expect(classification.confidence).toBe(0.95);
    });

    it("task rules have higher priority than taxonomy", () => {
      const strategy = heuristicStrategy({
        taskRules: [{ pattern: "urgent|critical", tier: 4, taskType: "urgent" }],
      });
      const body = {
        messages: [
          {
            role: "user",
            content: "Critical: refactor this function", // Would be tier 2 codegen, but rule overrides
          },
        ],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.requiredTier).toBe(4);
      expect(classification.taskType).toBe("urgent");
    });
  });

  describe("trivial bypass does NOT override taxonomy", () => {
    it("short 'refactor X' is still tier 2 codegen, not bypassed to tier 1", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [{ role: "user", content: "refactor this" }],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.requiredTier).toBe(2);
      expect(classification.taskType).toBe("codegen");
    });
  });

  describe("structural escalation", () => {
    it("body with 60k chars + 8 tools + max_tokens 32000 -> requiredTier >= 2", () => {
      const strategy = heuristicStrategy();
      const largeContent = "x".repeat(60_000);
      const body = {
        messages: [{ role: "user", content: largeContent }],
        tools: Array(8).fill({ name: "tool" }),
        max_tokens: 32_000,
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      // Large size + many tools escalates to at least tier 2
      expect(classification.requiredTier).toBeGreaterThanOrEqual(2);
    });

    it("large agentic conversation (many tool results) escalates tier", () => {
      const strategy = heuristicStrategy();
      const turns = [];
      for (let i = 0; i < 15; i++) {
        turns.push({
          role: "user",
          content: `call tool ${i}`,
        });
        turns.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `tool_${i}`,
              name: "get_data",
              input: {},
            },
          ],
        });
        turns.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool_${i}`,
              content: `result ${i}`,
            },
          ],
        });
      }
      const body = {
        messages: turns,
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      // High agentic density should elevate tier
      expect(classification.requiredTier).toBeGreaterThanOrEqual(2);
    });
  });

  describe("complexity scoring", () => {
    it("complexity is in [0, 1] range", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [{ role: "user", content: "hi" }],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.complexity).toBeGreaterThanOrEqual(0);
      expect(classification.complexity).toBeLessThanOrEqual(1);
    });

    it("trivial request has low complexity", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [{ role: "user", content: "hi" }],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.complexity).toBeLessThan(0.2);
    });
  });

  describe("confidence scoring", () => {
    it("rule-matched classification has high confidence (0.95)", () => {
      const strategy = heuristicStrategy({
        taskRules: [{ pattern: "debug", tier: 2, taskType: "debug" }],
      });
      const body = {
        messages: [{ role: "user", content: "debug this issue" }],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.confidence).toBe(0.95);
    });

    it("taxonomy-matched classification has reasonable confidence (0.75)", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [{ role: "user", content: "refactor this code" }],
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      expect(classification.confidence).toBe(0.75);
    });

    it("taxonomy-matched classification has reasonable confidence even with structural signals", () => {
      const strategy = heuristicStrategy();
      const body = {
        messages: [
          {
            role: "user",
            content: "refactor " + "x".repeat(70_000), // Huge size
          },
        ],
        tools: Array(8).fill({ name: "tool" }),
      };
      const classification = strategy.classify(body, "test-key") as Classification;
      // Confidence starts at 0.75 for taxonomy match; may be lowered if signals strongly conflict
      expect(classification.confidence).toBeLessThanOrEqual(0.75);
    });
  });
});
