import type { PluginContext, ProxyPlugin, RequestRecord, RouteDecision } from "../types.ts";

/**
 * Plugin pipeline. Plugins see every request before it is routed/forwarded
 * and every (non-streaming) response before it is returned to the client.
 * Request hooks run in registration order; response hooks run in reverse,
 * so a plugin wraps the ones registered after it.
 */
export class PluginPipeline {
  private plugins: ProxyPlugin[] = [];

  use(plugin: ProxyPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  list(): string[] {
    return this.plugins.map((p) => p.name);
  }

  async runRequest(body: any, ctx: PluginContext): Promise<any> {
    let current = body;
    for (const p of this.plugins) {
      if (!p.onRequest) continue;
      try {
        current = await p.onRequest(current, ctx);
      } catch (err) {
        console.error(`[plugin:${p.name}] onRequest failed, passing body through:`, err);
      }
    }
    return current;
  }

  async runResponse(body: any, ctx: PluginContext): Promise<any> {
    let current = body;
    for (const p of [...this.plugins].reverse()) {
      if (!p.onResponse) continue;
      try {
        current = await p.onResponse(current, ctx);
      } catch (err) {
        console.error(`[plugin:${p.name}] onResponse failed, passing body through:`, err);
      }
    }
    return current;
  }

  /** Let plugins inspect/override the routing decision (registration order). */
  async runRouteDecision(decision: RouteDecision, body: any, ctx: PluginContext): Promise<RouteDecision> {
    let current = decision;
    for (const p of this.plugins) {
      if (!p.onRouteDecision) continue;
      try {
        const out = await p.onRouteDecision(current, body, ctx);
        if (out) current = out;
      } catch (err) {
        console.error(`[plugin:${p.name}] onRouteDecision failed, keeping decision:`, err);
      }
    }
    return current;
  }

  /** Observe the stats record before persistence (registration order). */
  async runRecord(record: RequestRecord, ctx: PluginContext): Promise<void> {
    for (const p of this.plugins) {
      if (!p.onRecord) continue;
      try {
        await p.onRecord(record, ctx);
      } catch (err) {
        console.error(`[plugin:${p.name}] onRecord failed:`, err);
      }
    }
  }

  /**
   * Load plugins from module paths (router.config.json "plugins"). Each
   * module's default export is a ProxyPlugin or a zero-arg factory.
   */
  async loadFromPaths(paths: string[], resolve: (p: string) => string): Promise<void> {
    for (const path of paths) {
      try {
        const mod = await import(resolve(path));
        const exported = mod.default ?? mod;
        const plugin: ProxyPlugin = typeof exported === "function" ? exported() : exported;
        if (!plugin?.name) throw new Error("plugin has no name");
        this.use(plugin);
        console.log(`[plugins] loaded ${plugin.name} from ${path}`);
      } catch (err) {
        console.error(`[plugins] failed to load ${path}:`, err);
      }
    }
  }
}

export type { ProxyPlugin, PluginContext };
