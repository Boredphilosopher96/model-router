import type { PluginContext, ProxyPlugin, RequestRecord, RouteDecision } from "../types.ts";
import { globToRegex, normalizeModelId } from "../registry.ts";

/** Does this plugin apply to the request in ctx? (match-less plugins apply everywhere) */
export function pluginApplies(p: ProxyPlugin, ctx: PluginContext): boolean {
  const m = p.match;
  if (!m) return true;
  if (m.dialects && !m.dialects.includes(ctx.provider)) return false;
  if (m.mounts && !m.mounts.some((g) => globToRegex(g).test(ctx.mount))) return false;
  if (m.models) {
    const norm = normalizeModelId(ctx.requestedModel);
    if (!m.models.some((g) => globToRegex(normalizeModelId(g)).test(norm))) return false;
  }
  return true;
}

/**
 * Merge several plugins into one composite unit that runs them in order —
 * lets a bundle of related plugins (e.g. everything for one custom provider)
 * be registered, scoped, and prioritized as a single plugin without touching
 * the individual plugins or the rest of the pipeline.
 */
export function composePlugins(
  name: string,
  plugins: ProxyPlugin[],
  options: Pick<ProxyPlugin, "priority" | "match"> = {},
): ProxyPlugin {
  return {
    name,
    ...options,
    async onRequest(body, ctx) {
      let current = body;
      for (const p of plugins) if (p.onRequest && pluginApplies(p, ctx)) current = await p.onRequest(current, ctx);
      return current;
    },
    async onRouteDecision(decision, body, ctx) {
      let current = decision;
      for (const p of plugins) {
        if (!p.onRouteDecision || !pluginApplies(p, ctx)) continue;
        const out = await p.onRouteDecision(current, body, ctx);
        if (out) current = out;
      }
      return current;
    },
    async onResponse(body, ctx) {
      let current = body;
      for (const p of [...plugins].reverse()) if (p.onResponse && pluginApplies(p, ctx)) current = await p.onResponse(current, ctx);
      return current;
    },
    async onRecord(record, ctx) {
      for (const p of plugins) if (p.onRecord && pluginApplies(p, ctx)) await p.onRecord(record, ctx);
    },
  };
}

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
    // Stable order: priority ascending (default 100), then registration order.
    this.plugins = this.plugins
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (a.p.priority ?? 100) - (b.p.priority ?? 100) || a.i - b.i)
      .map((x) => x.p);
    return this;
  }

  list(): string[] {
    return this.plugins.map((p) => p.name);
  }

  async runRequest(body: any, ctx: PluginContext): Promise<any> {
    let current = body;
    for (const p of this.plugins) {
      if (!p.onRequest || !pluginApplies(p, ctx)) continue;
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
      if (!p.onResponse || !pluginApplies(p, ctx)) continue;
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
      if (!p.onRouteDecision || !pluginApplies(p, ctx)) continue;
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
      if (!p.onRecord || !pluginApplies(p, ctx)) continue;
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
