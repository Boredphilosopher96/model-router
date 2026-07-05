import { describe, it, expect } from "bun:test";
import { EscalationTracker, conversationKey } from "../src/escalation.ts";

describe("escalation", () => {
  describe("conversationKey", () => {
    it("stable across same system + first user message", () => {
      const body1 = {
        system: "You are helpful",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "how are you?" },
        ],
      };

      const body2 = {
        system: "You are helpful",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "goodbye" },
          { role: "user", content: "what is 2+2?" },
        ],
      };

      const key1 = conversationKey("anthropic", body1);
      const key2 = conversationKey("anthropic", body2);
      expect(key1).toBe(key2);
    });

    it("differs when first user message changes", () => {
      const body1 = {
        system: "You are helpful",
        messages: [{ role: "user", content: "hello" }],
      };

      const body2 = {
        system: "You are helpful",
        messages: [{ role: "user", content: "goodbye" }],
      };

      const key1 = conversationKey("anthropic", body1);
      const key2 = conversationKey("anthropic", body2);
      expect(key1).not.toBe(key2);
    });

    it("differs when system prompt changes", () => {
      const body1 = {
        system: "You are helpful",
        messages: [{ role: "user", content: "hello" }],
      };

      const body2 = {
        system: "You are not helpful",
        messages: [{ role: "user", content: "hello" }],
      };

      const key1 = conversationKey("anthropic", body1);
      const key2 = conversationKey("anthropic", body2);
      expect(key1).not.toBe(key2);
    });

    it("handles OpenAI input format (input field instead of messages)", () => {
      const body = {
        instructions: "You are helpful",
        input: [
          { role: "user", content: "hello" },
        ],
      };

      const key = conversationKey("openai", body);
      expect(typeof key).toBe("string");
      expect(key.length).toBe(24);
    });
  });

  describe("EscalationTracker", () => {
    it("observeRequest with two failures reaches boost 1", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);
      const key = "test-conv";
      const body = { messages: [{ role: "user", content: "hi" }] };

      // Two failures
      tracker.observeOutcome(key, "failure");
      tracker.observeOutcome(key, "failure");

      // Next request should return boost 1
      const boost = tracker.observeRequest(key, body);
      expect(boost).toBe(1);
    });

    it("boost continues to increase up to maxBoost", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);
      const key = "test-conv";
      const body = { messages: [{ role: "user", content: "hi" }] };

      // Four failures -> boost 2
      tracker.observeOutcome(key, "failure");
      tracker.observeOutcome(key, "failure");
      tracker.observeOutcome(key, "failure");
      tracker.observeOutcome(key, "failure");

      const boost = tracker.observeRequest(key, body);
      expect(boost).toBe(2);
    });

    it("boost never exceeds maxBoost", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);
      const key = "test-conv";
      const body = { messages: [{ role: "user", content: "hi" }] };

      // Six failures -> would be boost 3, clamped to 2
      for (let i = 0; i < 6; i++) {
        tracker.observeOutcome(key, "failure");
      }

      const boost = tracker.observeRequest(key, body);
      expect(boost).toBe(2);
      expect(boost).toBeLessThanOrEqual(config.maxBoost);
    });

    it("successes decay the boost", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);
      const key = "test-conv";
      const body = { messages: [{ role: "user", content: "hi" }] };

      // Get to boost 1
      tracker.observeOutcome(key, "failure");
      tracker.observeOutcome(key, "failure");
      expect(tracker.observeRequest(key, body)).toBe(1);

      // Two successes should decay boost back to 0
      tracker.observeOutcome(key, "ok");
      tracker.observeOutcome(key, "ok");
      const nextBoost = tracker.observeRequest(key, body);
      expect(nextBoost).toBe(0);
    });

    it("tool_result blocks with is_error escalate the conversation", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);
      const key = "test-conv";

      const bodyWithErrors = {
        messages: [
          { role: "user", content: "call a tool" },
          { role: "assistant", content: "" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "123", is_error: true, content: "Tool failed" },
            ],
          },
        ],
      };

      // First request with tool error
      let boost = tracker.observeRequest(key, bodyWithErrors);
      expect(boost).toBe(0); // 1 signal, need 2 for boost

      // Second request with tool error
      boost = tracker.observeRequest(key, bodyWithErrors);
      expect(boost).toBe(1); // 2 signals -> boost 1
    });

    it("refusal counts as 2 signals", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);
      const key = "test-conv";
      const body = { messages: [{ role: "user", content: "hi" }] };

      // One refusal (counts as 2 signals)
      tracker.observeOutcome(key, "refusal");
      const boost = tracker.observeRequest(key, body);
      expect(boost).toBe(1);
    });

    it("snapshot returns boosted conversations", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);

      const key1 = "conv-1";
      const key2 = "conv-2";
      const body = { messages: [{ role: "user", content: "hi" }] };

      // Boost conv-1
      tracker.observeOutcome(key1, "failure");
      tracker.observeOutcome(key1, "failure");
      tracker.observeRequest(key1, body);

      // Leave conv-2 unboosted
      tracker.observeRequest(key2, body);

      const snap = tracker.snapshot();
      expect(snap.some((e) => e.conversation === key1 && e.boost > 0)).toBe(true);
      expect(snap.every((e) => e.boost > 0 || e.signals > 0)).toBe(true);
    });

    it("snapshot includes lastSeen as ISO string", () => {
      const config = { signalsPerBoost: 2, maxBoost: 2, successesPerDecay: 2, ttlMs: 60000, loopTurnThreshold: 4 };
      const tracker = new EscalationTracker(config);
      const key = "test-conv";
      const body = { messages: [{ role: "user", content: "hi" }] };

      tracker.observeOutcome(key, "failure");
      tracker.observeOutcome(key, "failure");
      tracker.observeRequest(key, body);

      const snap = tracker.snapshot();
      const entry = snap.find((e) => e.conversation === key);
      expect(entry).toBeDefined();
      expect(typeof entry!.lastSeen).toBe("string");
      // Should be valid ISO format
      expect(new Date(entry!.lastSeen).getTime()).toBeGreaterThan(0);
    });
  });
});
