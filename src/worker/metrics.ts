/**
 * Observability metrics for the ingestion loop.
 *
 * Contract:
 * - `provider_calls_total{provider,workload}` — counter, monotonic, daily quota.
 * - `cache_hit_ratio{provider}` — gauge in [0,1] computed from hit/miss counts.
 * - `provider_endpoint_volume{provider,workload}` — counter per endpoint.
 * - `provider_call_outcomes{provider,outcome}` — counter for fetched/skipped/failed.
 *
 * The snapshot is serialized JSON-friendly for exposition via /metrics. A real
 * Prometheus exporter can wrap this — the metrics module owns the contract,
 * not the wire format.
 */

export type CallOutcome = 'fetched' | 'cached' | 'skipped' | 'failed' | 'denied' | 'rate_limited';

export interface MetricsSnapshot {
  readonly providerCallsTotal: Record<string, number>;
  readonly providerEndpointVolume: Record<string, number>;
  readonly callOutcomes: Record<CallOutcome, number>;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheHitRatio: number;
  readonly quotaCallsToday: number;
  readonly quotaPosture: 'normal' | 'soft_cap_reached' | 'hard_cap_reached';
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
  };
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
    };
  }

  reset(): void {
    this.#providerCalls.clear();
    this.#endpointVolume.clear();
    for (const key of Object.keys(this.#outcomes) as CallOutcome[]) {
      this.#outcomes[key] = 0;
    }
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
