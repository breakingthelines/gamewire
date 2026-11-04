/**
 * Observability metrics for the ingestion loop.
 *
 * Contract:
 * - `provider_calls_total{provider,workload}` — counter, monotonic, daily quota.
 * - `cache_hit_ratio{provider}` — gauge in [0,1] computed from hit/miss counts.
 * - `provider_endpoint_volume{provider,workload}` — counter per endpoint.
 * - `provider_call_outcomes{provider,outcome}` — counter for fetched/skipped/failed.
 * - `provider_minute_throttled{workload}` — counter of calls the per-minute
 *   limiter held back (after any retry). Expected to stay 0 at today's load.
 * - `provider_stale_served{workload}` — live calls answered from the last-good
 *   payload because the limiter denied them.
 * - `ingestion_tick_duration_ms{workload}` — last/max/total/count per tick.
 * - `ingestion_tick_skipped_in_flight{workload}` — ticks skipped because the
 *   previous tick of the same workload was still running.
 *
 * The snapshot is serialized JSON-friendly for exposition via /metrics. A real
 * Prometheus exporter can wrap this — the metrics module owns the contract,
 * not the wire format.
 */

export type CallOutcome =
  | 'fetched'
  | 'cached'
  | 'skipped'
  | 'failed'
  | 'denied'
  | 'rate_limited'
  | 'throttled';

export interface TickDurationStats {
  readonly count: number;
  readonly lastMs: number;
  readonly maxMs: number;
  readonly totalMs: number;
}

export interface MetricsSnapshot {
  readonly providerCallsTotal: Record<string, number>;
  readonly providerEndpointVolume: Record<string, number>;
  readonly callOutcomes: Record<CallOutcome, number>;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheHitRatio: number;
  readonly quotaCallsToday: number;
  readonly quotaPosture: 'normal' | 'soft_cap_reached' | 'hard_cap_reached';
  readonly providerMinuteThrottled: Record<string, number>;
  readonly providerStaleServed: Record<string, number>;
  readonly tickDurationMs: Record<string, TickDurationStats>;
  readonly tickSkippedInFlight: Record<string, number>;
}

export class IngestionMetrics {
  readonly #providerCalls = new Map<string, number>();
  readonly #endpointVolume = new Map<string, number>();
  readonly #outcomes: Record<CallOutcome, number> = {
    fetched: 0,
    cached: 0,
    skipped: 0,
    failed: 0,
    denied: 0,
    rate_limited: 0,
    throttled: 0,
  };
  readonly #minuteThrottled = new Map<string, number>();
  readonly #staleServed = new Map<string, number>();
  readonly #tickDurations = new Map<string, TickDurationStats>();
  readonly #tickSkipped = new Map<string, number>();
  #cacheHits = 0;
  #cacheMisses = 0;
  #quotaCallsToday = 0;
  #quotaPosture: 'normal' | 'soft_cap_reached' | 'hard_cap_reached' = 'normal';

  recordProviderCall(provider: string, workload: string, endpoint: string): void {
    this.#bump(this.#providerCalls, `${provider}|${workload}`);
    this.#bump(this.#endpointVolume, `${provider}|${endpoint}`);
  }

  recordCacheHit(): void {
    this.#cacheHits += 1;
  }

  recordCacheMiss(): void {
    this.#cacheMisses += 1;
  }

  recordOutcome(outcome: CallOutcome): void {
    this.#outcomes[outcome] += 1;
  }

  recordQuota(calls: number, posture: MetricsSnapshot['quotaPosture']): void {
    this.#quotaCallsToday = calls;
    this.#quotaPosture = posture;
  }

  recordMinuteThrottled(workload: string): void {
    this.#bump(this.#minuteThrottled, workload);
  }

  recordStaleServed(workload: string): void {
    this.#bump(this.#staleServed, workload);
  }

  recordTickDuration(workload: string, durationMs: number): void {
    const ms = Math.max(0, durationMs);
    const prev = this.#tickDurations.get(workload);
    this.#tickDurations.set(workload, {
      count: (prev?.count ?? 0) + 1,
      lastMs: ms,
      maxMs: Math.max(prev?.maxMs ?? 0, ms),
      totalMs: (prev?.totalMs ?? 0) + ms,
    });
  }

  recordTickSkippedInFlight(workload: string): void {
    this.#bump(this.#tickSkipped, workload);
  }

  snapshot(): MetricsSnapshot {
    const total = this.#cacheHits + this.#cacheMisses;
    const ratio = total === 0 ? 0 : this.#cacheHits / total;
    return {
      providerCallsTotal: mapToObject(this.#providerCalls),
      providerEndpointVolume: mapToObject(this.#endpointVolume),
      callOutcomes: { ...this.#outcomes },
      cacheHits: this.#cacheHits,
      cacheMisses: this.#cacheMisses,
      cacheHitRatio: Number(ratio.toFixed(4)),
      quotaCallsToday: this.#quotaCallsToday,
      quotaPosture: this.#quotaPosture,
      providerMinuteThrottled: mapToObject(this.#minuteThrottled),
      providerStaleServed: mapToObject(this.#staleServed),
      tickDurationMs: Object.fromEntries(this.#tickDurations),
      tickSkippedInFlight: mapToObject(this.#tickSkipped),
    };
  }

  reset(): void {
    this.#providerCalls.clear();
    this.#endpointVolume.clear();
    for (const key of Object.keys(this.#outcomes) as CallOutcome[]) {
      this.#outcomes[key] = 0;
    }
    this.#minuteThrottled.clear();
    this.#staleServed.clear();
    this.#tickDurations.clear();
    this.#tickSkipped.clear();
    this.#cacheHits = 0;
    this.#cacheMisses = 0;
    this.#quotaCallsToday = 0;
    this.#quotaPosture = 'normal';
  }

  #bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

function mapToObject(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of map.entries()) {
    out[key] = value;
  }
  return out;
}
