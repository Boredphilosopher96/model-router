import type { ProxyPlugin, PluginContext } from "../types.ts";

export function loggerPlugin(): ProxyPlugin {
  return {
    name: "logger",
    onRequest(body: any, ctx: PluginContext): any {
      const t0 = Date.now();
      ctx.state.t0 = t0;
      console.log(`[req] ${ctx.provider} ${ctx.requestedModel} …`);
      return body;
    },
    onResponse(body: any, ctx: PluginContext): any {
      const t0 = (ctx.state.t0 as number) || Date.now();
      const elapsed = Date.now() - t0;
      console.log(`[res] ${ctx.provider} ${ctx.requestedModel} -> ${ctx.routedModel} (${elapsed}ms)`);
      return body;
    },
  };
}
