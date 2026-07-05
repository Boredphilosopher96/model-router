import { describe, it, expect } from "bun:test";
import { PluginPipeline, type ProxyPlugin, type PluginContext } from "../src/plugins/index.ts";
import { encodeToon, toonPlugin } from "../src/plugins/toon.ts";

describe("PluginPipeline", () => {
  it("onRequest hooks run in registration order", async () => {
    const order: string[] = [];

    const plugin1: ProxyPlugin = {
      name: "plugin1",
      onRequest(body, ctx) {
        order.push("plugin1");
        return body;
      },
    };

    const plugin2: ProxyPlugin = {
      name: "plugin2",
      onRequest(body, ctx) {
        order.push("plugin2");
        return body;
      },
    };

    const plugin3: ProxyPlugin = {
      name: "plugin3",
      onRequest(body, ctx) {
        order.push("plugin3");
        return body;
      },
    };

    const pipeline = new PluginPipeline();
    pipeline.use(plugin1).use(plugin2).use(plugin3);

    const ctx: PluginContext = {
      provider: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };

    await pipeline.runRequest({}, ctx);
    expect(order).toEqual(["plugin1", "plugin2", "plugin3"]);
  });

  it("onResponse hooks run in reverse order", async () => {
    const order: string[] = [];

    const plugin1: ProxyPlugin = {
      name: "plugin1",
      onResponse(body, ctx) {
        order.push("plugin1");
        return body;
      },
    };

    const plugin2: ProxyPlugin = {
      name: "plugin2",
      onResponse(body, ctx) {
        order.push("plugin2");
        return body;
      },
    };

    const plugin3: ProxyPlugin = {
      name: "plugin3",
      onResponse(body, ctx) {
        order.push("plugin3");
        return body;
      },
    };

    const pipeline = new PluginPipeline();
    pipeline.use(plugin1).use(plugin2).use(plugin3);

    const ctx: PluginContext = {
      provider: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };

    await pipeline.runResponse({}, ctx);
    expect(order).toEqual(["plugin3", "plugin2", "plugin1"]);
  });

  it("plugin errors are swallowed", async () => {
    const order: string[] = [];

    const plugin1: ProxyPlugin = {
      name: "plugin1",
      onRequest(body, ctx) {
        order.push("plugin1");
        return body;
      },
    };

    const plugin2: ProxyPlugin = {
      name: "plugin2",
      onRequest(body, ctx) {
        throw new Error("plugin2 error");
      },
    };

    const plugin3: ProxyPlugin = {
      name: "plugin3",
      onRequest(body, ctx) {
        order.push("plugin3");
        return body;
      },
    };

    const pipeline = new PluginPipeline();
    pipeline.use(plugin1).use(plugin2).use(plugin3);

    const ctx: PluginContext = {
      provider: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };

    const result = await pipeline.runRequest({}, ctx);
    // Body should be unchanged
    expect(result).toEqual({});
    // plugin1 and plugin3 should have run despite plugin2 throwing
    expect(order).toEqual(["plugin1", "plugin3"]);
  });
});

describe("toonPlugin", () => {
  it("large json block (>=300 chars) gets converted to toon", async () => {
    const plugin = toonPlugin({ minJsonChars: 300 });

    const largeJson = JSON.stringify({
      data: Array(50).fill({ id: 1, name: "test", value: 123 }),
    });

    const body = {
      messages: [
        {
          role: "user",
          content: `Please analyze this:\n\`\`\`json\n${largeJson}\n\`\`\``,
        },
      ],
    };

    const ctx: PluginContext = {
      provider: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };

    const result = await plugin.onRequest!(body, ctx);
    const content = result.messages[0].content;

    expect(content).toContain("```toon");
    expect(content).not.toContain(largeJson);
  });

  it("small json block (<300 chars) is untouched", async () => {
    const plugin = toonPlugin({ minJsonChars: 300 });

    const smallJson = JSON.stringify({ id: 1, name: "test" });

    const body = {
      messages: [
        {
          role: "user",
          content: `Please analyze this:\n\`\`\`json\n${smallJson}\n\`\`\``,
        },
      ],
    };

    const ctx: PluginContext = {
      provider: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };

    const result = await plugin.onRequest!(body, ctx);
    const content = result.messages[0].content;

    expect(content).toContain(smallJson);
    expect(content).not.toContain("```toon");
  });

  it("encodeToon renders uniform object array in tabular form", () => {
    const value = {
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    };

    const result = encodeToon(value);
    expect(result).toContain("items[2]{id,name}:");
    expect(result).toContain("1,a");
    expect(result).toContain("2,b");
  });
});
