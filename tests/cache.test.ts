import { describe, it, expect } from "bun:test";
import { createCache, cacheKey } from "../src/cache.ts";

describe("cache", () => {
  describe("createCache", () => {
    it("set/get roundtrip", () => {
      const cache = createCache(":memory:", 5000);
      const key = "test-key";
      const body = '{"result":"success"}';
      const model = "test-model";

      cache.set(key, body, model);
      const result = cache.get(key);

      expect(result).not.toBeNull();
      expect(result?.body).toBe(body);
      expect(result?.model).toBe(model);
    });

    it("expiry: ttl 1ms, sleep 10ms, get returns null", async () => {
      const cache = createCache(":memory:", 1);
      const key = "test-key";
      const body = '{"result":"expired"}';
      const model = "test-model";

      cache.set(key, body, model);
      await Bun.sleep(10);
      const result = cache.get(key);

      expect(result).toBeNull();
    });
  });

  describe("cacheKey", () => {
    it("stable under object key reordering", () => {
      const body1 = {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
        system: "You are helpful",
        tools: [],
      };

      const body2 = {
        tools: [],
        system: "You are helpful",
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-8",
      };

      const key1 = cacheKey("anthropic", body1);
      const key2 = cacheKey("anthropic", body2);

      expect(key1).toBe(key2);
    });

    it("differs when messages differ", () => {
      const body1 = {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hello" }],
      };

      const body2 = {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "goodbye" }],
      };

      const key1 = cacheKey("anthropic", body1);
      const key2 = cacheKey("anthropic", body2);

      expect(key1).not.toBe(key2);
    });
  });
});
