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
  /** Provider-reported remaining rate-limit fraction (0..1); held until throttleUntil. */
  rateRemaining: number;
  throttleUntil: number;
}

export class UpstreamHealth {
  private states = new Map<string, UpstreamState>();
  constructor(private options: HealthOptions = DEFAULT_HEALTH) {}

  private state(name: string): UpstreamState {
    let s = this.states.get(name);
    if (!s) {
      s = { ewmaMs: 0, samples: 0, failures: [], openUntil: 0, totalOk: 0, totalFail: 0, rateRemaining: 1, throttleUntil: 0 };
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
   * Ingest provider rate-limit headers (Anthropic and OpenAI shapes). When an
   * upstream reports < 5% of its request/token budget remaining, it is
   * soft-throttled for 30s: deprioritized like an open circuit, but still
   * fail-open when it is the only candidate.
   */
  noteRateLimit(name: string, headers: Headers): void {
    const frac = (remainingKey: string, limitKey: string): number | null => {
      const remaining = Number(headers.get(remainingKey));
      const limit = Number(headers.get(limitKey));
      return Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 ? remaining / limit : null;
    };
    const fractions = [
      frac("anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-limit"),
      frac("anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-tokens-limit"),
      frac("x-ratelimit-remaining-requests", "x-ratelimit-limit-requests"),
      frac("x-ratelimit-remaining-tokens", "x-ratelimit-limit-tokens"),
    ].filter((f): f is number => f !== null);
    if (fractions.length === 0) return;
    const s = this.state(name);
    s.rateRemaining = Math.min(...fractions);
    s.throttleUntil = s.rateRemaining < 0.05 ? Date.now() + 30_000 : 0;
  }

  /** Nearly out of provider rate limit — deprioritize (soft, fail-open). */
  throttled(name: string): boolean {
    const s = this.states.get(name);
    return !!s && s.throttleUntil > Date.now();
  }

  /**
   * Can this upstream take traffic? Open circuit = no, except a single probe
   * window once the cooldown has elapsed (half-open). Soft throttle counts
   * as unavailable too — the router fails open when nothing else remains.
   */
  available(name: string): boolean {
    if (this.throttled(name)) return false;
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
    rateRemaining: number;
    throttled: boolean;
  }> {
    const now = Date.now();
    return [...this.states.entries()].map(([name, s]) => ({
      upstream: name,
      latencyMs: Math.round(s.ewmaMs),
      ok: s.totalOk,
      failed: s.totalFail,
      circuit: !s.openUntil ? "closed" : now >= s.openUntil ? "half-open" : "open",
      rateRemaining: Number(s.rateRemaining.toFixed(3)),
      throttled: s.throttleUntil > now,
    }));
  }
}
