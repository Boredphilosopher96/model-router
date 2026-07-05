/**
 * Upstream health: per-endpoint rolling latency (EWMA) and a failure-driven
 * circuit breaker. The router skips upstreams whose circuit is open and
 * prefers faster endpoints when candidate costs are effectively tied.
 * Everything fails open: an upstream with no data is healthy.
 */

export interface HealthOptions {
  /** Failures within the window that open the circuit. */
  failureThreshold: number;
  windowMs: number;
  /** How long an open circuit stays open before a probe is allowed. */
  cooldownMs: number;
  /** EWMA smoothing for latency (0..1, weight of the newest sample). */
  alpha: number;
}

export const DEFAULT_HEALTH: HealthOptions = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
  alpha: 0.3,
};

interface UpstreamState {
  ewmaMs: number;
  samples: number;
  failures: number[]; // timestamps
  openUntil: number;
  totalOk: number;
  totalFail: number;
}

export class UpstreamHealth {
  private states = new Map<string, UpstreamState>();
  constructor(private options: HealthOptions = DEFAULT_HEALTH) {}

  private state(name: string): UpstreamState {
    let s = this.states.get(name);
    if (!s) {
      s = { ewmaMs: 0, samples: 0, failures: [], openUntil: 0, totalOk: 0, totalFail: 0 };
      this.states.set(name, s);
    }
    return s;
  }

  /** Record the outcome of an upstream call. Failures = network errors, 429, 5xx. */
  note(name: string, ok: boolean, latencyMs: number): void {
    const s = this.state(name);
    const now = Date.now();
    if (ok) {
      s.totalOk++;
      s.ewmaMs = s.samples === 0 ? latencyMs : this.options.alpha * latencyMs + (1 - this.options.alpha) * s.ewmaMs;
      s.samples++;
      // A success while half-open closes the circuit.
      if (s.openUntil && now >= s.openUntil) {
        s.openUntil = 0;
        s.failures = [];
      }
      return;
    }
    s.totalFail++;
    s.failures.push(now);
    const cutoff = now - this.options.windowMs;
    s.failures = s.failures.filter((t) => t >= cutoff);
    if (s.failures.length >= this.options.failureThreshold) {
      s.openUntil = now + this.options.cooldownMs;
      s.failures = [];
    }
  }

  /**
   * Can this upstream take traffic? Open circuit = no, except a single probe
   * window once the cooldown has elapsed (half-open).
   */
  available(name: string): boolean {
    const s = this.states.get(name);
    if (!s || !s.openUntil) return true;
    return Date.now() >= s.openUntil; // half-open: allow probes
  }

  /** Smoothed latency; 0 when unknown (treated as "no penalty"). */
  latencyMs(name: string): number {
    return this.states.get(name)?.ewmaMs ?? 0;
  }

  snapshot(): Array<{
    upstream: string;
    latencyMs: number;
    ok: number;
    failed: number;
    circuit: "closed" | "open" | "half-open";
  }> {
    const now = Date.now();
    return [...this.states.entries()].map(([name, s]) => ({
      upstream: name,
      latencyMs: Math.round(s.ewmaMs),
      ok: s.totalOk,
      failed: s.totalFail,
      circuit: !s.openUntil ? "closed" : now >= s.openUntil ? "half-open" : "open",
    }));
  }
}
