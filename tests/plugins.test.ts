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
      mount: "anthropic",
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
      mount: "anthropic",
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
      mount: "anthropic",
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
      mount: "anthropic",
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
      mount: "anthropic",
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

describe("Plugin composability: priority and matching", () => {
  it("priority 1 plugin runs before default 100 regardless of registration order", async () => {
    const order: string[] = [];

    const highPriority: ProxyPlugin = {
      name: "high-priority",
      priority: 1,
      onRequest(body, ctx) {
        order.push("high-priority");
        return body;
      },
    };

    const defaultPriority: ProxyPlugin = {
      name: "default-priority",
      onRequest(body, ctx) {
        order.push("default-priority");
        return body;
      },
    };

    // Register in reverse priority order
    const pipeline = new PluginPipeline();
    pipeline.use(defaultPriority).use(highPriority);

    const ctx: PluginContext = {
      provider: "anthropic",
      mount: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };

    await pipeline.runRequest({}, ctx);
    // high-priority should run first despite being registered second
    expect(order).toEqual(["high-priority", "default-priority"]);
  });

  it("plugin with match {mounts:[\"anthropic\"]} runs only when ctx.mount===\"anthropic\"", async () => {
    const ran: string[] = [];

    const scopedPlugin: ProxyPlugin = {
      name: "anthropic-only",
      match: { mounts: ["anthropic"] },
      onRequest(body, ctx) {
        ran.push("anthropic-only");
        return body;
      },
    };

    const pipeline = new PluginPipeline();
    pipeline.use(scopedPlugin);

    // Test with anthropic mount
    const ctxAnthropic: PluginContext = {
      provider: "anthropic",
      mount: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };
    await pipeline.runRequest({}, ctxAnthropic);
    expect(ran).toContain("anthropic-only");

    ran.length = 0;

    // Test with copilot mount (should be skipped)
    const ctxCopilot: PluginContext = {
      provider: "openai",
      mount: "copilot",
      path: "/v1/chat/completions",
      requestedModel: "gpt-5.4",
      state: {},
    };
    await pipeline.runRequest({}, ctxCopilot);
    expect(ran).not.toContain("anthropic-only");
  });

  it("plugin with match {models:[\"claude-*\"]} skipped for gpt request", async () => {
    const ran: string[] = [];

    const claudeOnly: ProxyPlugin = {
      name: "claude-only",
      match: { models: ["claude-*"] },
      onRequest(body, ctx) {
        ran.push("claude-only");
        return body;
      },
    };

    const pipeline = new PluginPipeline();
    pipeline.use(claudeOnly);

    // Test with claude model
    const ctxClaude: PluginContext = {
      provider: "anthropic",
      mount: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };
    await pipeline.runRequest({}, ctxClaude);
    expect(ran).toContain("claude-only");

    ran.length = 0;

    // Test with gpt model (should be skipped)
    const ctxGpt: PluginContext = {
      provider: "openai",
      mount: "openai",
      path: "/v1/chat/completions",
      requestedModel: "gpt-5.4-nano",
      state: {},
    };
    await pipeline.runRequest({}, ctxGpt);
    expect(ran).not.toContain("claude-only");
  });

  it("composePlugins merges two plugins in inner order", async () => {
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

    const composed = (() => {
      const { composePlugins } = require("../src/plugins/index.ts");
      return composePlugins("composed", [plugin1, plugin2]);
    })();

    const pipeline = new PluginPipeline();
    pipeline.use(composed);

    const ctx: PluginContext = {
      provider: "anthropic",
      mount: "anthropic",
      path: "/v1/messages",
      requestedModel: "claude-opus-4-8",
      state: {},
    };

    await pipeline.runRequest({}, ctx);
    // Should run in inner order
    expect(order).toEqual(["plugin1", "plugin2"]);
  });
});
