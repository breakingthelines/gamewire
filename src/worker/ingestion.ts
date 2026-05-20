/**
 * API-Football ingestion loop.
 *
 * Conservative live-ingestion path:
 *   1. Cache-first: every workload has a TTL keyed in Redis.
 *   2. Singleflight: only one provider call per (provider, workload, resource)
 *      regardless of viewer count.
 *   3. Quota-gated: daily counter enforces a 70k hard cap with a 60k soft cap
 *      that flips the worker into cached-only mode and emits PROVIDER_OUTAGE
 *      via game-service.
 *   4. Observability: counters per provider/workload/endpoint and cache hit
 *      ratio gauge exposed via {@link IngestionMetrics}.
 *
 * The loop intentionally aggregates calls across viewers so a thundering herd
 * of UI reads cannot multiply provider RPS.
 */

import {
  API_FOOTBALL_PROVIDER_ID,
  apiFootballFixturePath,
  apiFootballFixtureSyncPaths,
  apiFootballLineupPath,
} from '../adapters/api-football/index.js';
import type { ProviderCache } from './cache.js';
import { InMemoryProviderCache } from './cache.js';
import type { GamewireWorkerConfig } from './config.js';
import { IngestionMetrics } from './metrics.js';
import {
  fetchApiFootballJson,
  type ProviderFetch,
  type ProviderJsonFetchResult,
} from './provider-http.js';
import type { ProviderQuotaSnapshot } from './quota.js';
import { ProviderQuotaTracker } from './quota.js';
import { Singleflight } from './singleflight.js';

/**
 * Workload identifier. Mirrors the cache TTL table in the task brief.
 */
export type IngestionWorkload =
  | 'fixtures-next-7d'
  | 'fixture-detail-preKO'
  | 'fixture-detail-live'
  | 'fixture-detail-fullTime'
  | 'lineups-post-confirm'
  | 'team-metadata'
  | 'player-metadata';

/**
 * TTL table verbatim from the task brief. Keep changes here in lockstep with
 * the operations runbook; the values are intentionally conservative for the
 * 75k/day API-Football plan budget.
 */
export const INGESTION_TTL_SECONDS: Record<IngestionWorkload, number> = {
  'fixtures-next-7d': 6 * 60 * 60,
  'fixture-detail-preKO': 60 * 60,
  'fixture-detail-live': 30,
  'fixture-detail-fullTime': 6 * 60 * 60,
  'lineups-post-confirm': 60 * 60,
  'team-metadata': 24 * 60 * 60,
  'player-metadata': 24 * 60 * 60,
} as const;

/**
 * Loop tick cadence per workload. Live fixtures poll at the TTL; metadata
 * workloads tick once per day. Polling cadence is independent of TTL so a
 * cache hit short-circuits the provider call.
 */
export const INGESTION_TICK_INTERVAL_MS: Record<IngestionWorkload, number> = {
  'fixtures-next-7d': 60 * 60 * 1000, // top of the hour
  'fixture-detail-preKO': 10 * 60 * 1000, // every 10 min for upcoming kickoffs
  'fixture-detail-live': 30 * 1000, // every 30s for in-play fixtures
  'fixture-detail-fullTime': 30 * 60 * 1000, // every 30 min after FT
  'lineups-post-confirm': 10 * 60 * 1000, // every 10 min after lineups confirmed
  'team-metadata': 6 * 60 * 60 * 1000,
  'player-metadata': 6 * 60 * 60 * 1000,
} as const;

export interface IngestionFetchOptions {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly replayId?: string;
  /** Optional override for tests. */
  readonly path?: string;
}

export interface IngestionFetchResult<TResponse = unknown> {
  readonly status: 'cached' | 'fetched' | 'skipped' | 'failed' | 'denied';
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly cacheKey: string;
  readonly cacheHit: boolean;
  readonly cachedOnlyMode: boolean;
  readonly quota: ProviderQuotaSnapshot;
  readonly fallbackReason?: 'PROVIDER_OUTAGE';
  readonly fetch?: ProviderJsonFetchResult<TResponse>;
  readonly data?: unknown;
  readonly error?: { readonly message: string };
}

export interface IngestionLoopOptions {
  readonly config: GamewireWorkerConfig;
  readonly cache?: ProviderCache;
  readonly quota?: ProviderQuotaTracker;
  readonly metrics?: IngestionMetrics;
  readonly singleflight?: Singleflight;
  readonly fetchFn?: ProviderFetch;
  readonly clock?: () => number;
  readonly logger?: (entry: Record<string, unknown>) => void;
}

export interface IngestionLoopStartOptions {
  readonly fixtureIds?: readonly string[];
  readonly teamIds?: readonly string[];
  readonly playerIds?: readonly string[];
  /** Override ms intervals for tests. */
  readonly intervals?: Partial<Record<IngestionWorkload, number>>;
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

const SECONDS_TO_MS = 1_000;

/**
 * Provider-agnostic ingestion controller. Exposes a single coordinated path
 * for the worker entry to wire into HTTP routes, scheduler ticks, or webhook
 * receivers — though API-Football v3 has no webhook support so only the
 * polling path is exercised in production.
 */
export class ApiFootballIngestionLoop {
  readonly #config: GamewireWorkerConfig;
  readonly #cache: ProviderCache;
  readonly #quota: ProviderQuotaTracker;
  readonly #metrics: IngestionMetrics;
  readonly #singleflight: Singleflight;
  readonly #fetchFn?: ProviderFetch;
  readonly #clock: () => number;
  readonly #log: (entry: Record<string, unknown>) => void;
  readonly #provider: string;
  readonly #timers: unknown[] = [];

  constructor(options: IngestionLoopOptions) {
    this.#config = options.config;
    this.#provider = options.config.providerId;
    this.#cache = options.cache ?? new InMemoryProviderCache();
    this.#quota =
      options.quota ?? new ProviderQuotaTracker({ provider: options.config.providerId });
    this.#metrics = options.metrics ?? new IngestionMetrics();
    this.#singleflight = options.singleflight ?? new Singleflight();
    this.#fetchFn = options.fetchFn;
    this.#clock = options.clock ?? Date.now;
    this.#log = options.logger ?? defaultLogger;
  }

  get metrics(): IngestionMetrics {
    return this.#metrics;
  }

  get cache(): ProviderCache {
    return this.#cache;
  }

  get quota(): ProviderQuotaTracker {
    return this.#quota;
  }

  /**
   * Fetch one workload result through the cache+singleflight+quota pipeline.
   *
   * The caller passes a workload + resourceId; the loop owns:
   *   - cache key derivation
   *   - cache lookup
   *   - singleflight key derivation
   *   - quota reservation (with refund on cache hit avoidance)
   *   - provider HTTP call (delegated to fetchApiFootballJson)
   *   - cache write on success
   *   - metric increments
   *   - fallback reason emission when in cached-only mode
   */
  async fetchWorkload<TResponse = unknown>(
    options: IngestionFetchOptions
  ): Promise<IngestionFetchResult<TResponse>> {
    const workload = options.workload;
    const path = options.path ?? apiFootballPathFor(workload, options.resourceId);
    const cacheKey = this.cacheKeyFor(workload, options.resourceId);
    const ttlSeconds = INGESTION_TTL_SECONDS[workload];

    // Cache lookup is outside the singleflight so concurrent hits return
    // instantly without contention.
    const cached = await this.#cache.get<unknown>(cacheKey);
    if (cached !== undefined) {
      this.#metrics.recordCacheHit();
      this.#metrics.recordOutcome('cached');
      const quotaSnapshot = await this.#quota.snapshot();
      this.#recordQuota(quotaSnapshot);
      this.#log({
        event: 'ingestion_cache_hit',
        provider: this.#provider,
        workload,
        cacheKey,
      });
      return {
        status: 'cached',
        workload,
        resourceId: options.resourceId,
        cacheKey,
        cacheHit: true,
        cachedOnlyMode: quotaSnapshot.cachedOnlyMode,
        quota: quotaSnapshot,
        data: cached,
      };
    }

    this.#metrics.recordCacheMiss();

    // Singleflight ensures the next steps run at most once per cache key.
    return this.#singleflight.do(cacheKey, async () => {
      // Re-check cache inside singleflight in case the leader populated it
      // while we waited for the lock; this prevents double provider calls
      // immediately after a slow first request settles.
      const racedHit = await this.#cache.get<unknown>(cacheKey);
      if (racedHit !== undefined) {
        this.#metrics.recordOutcome('cached');
        const snapshot = await this.#quota.snapshot();
        this.#recordQuota(snapshot);
        return {
          status: 'cached',
          workload,
          resourceId: options.resourceId,
          cacheKey,
          cacheHit: true,
          cachedOnlyMode: snapshot.cachedOnlyMode,
          quota: snapshot,
          data: racedHit,
        } satisfies IngestionFetchResult<TResponse>;
      }

      // Quota reservation precedes the call. If we are at hard cap the call
      // is denied; if we cross the soft cap during this reservation we still
      // run the call but mark the result so the operator sees the fallback.
      const reservation = await this.#quota.reserve();
      this.#recordQuota(reservation.snapshot);

      if (!reservation.allowed) {
        this.#metrics.recordOutcome('denied');
        this.#log({
          event: 'ingestion_quota_exceeded',
          provider: this.#provider,
          workload,
          cacheKey,
          reason: reservation.reason,
          calls: reservation.snapshot.calls,
        });
        return {
          status: 'denied',
          workload,
          resourceId: options.resourceId,
          cacheKey,
          cacheHit: false,
          cachedOnlyMode: true,
          quota: reservation.snapshot,
          fallbackReason: 'PROVIDER_OUTAGE',
          error: {
            message: `Provider quota ${reservation.reason ?? 'hard_cap'} reached: ${reservation.snapshot.calls} >= ${reservation.snapshot.hardCap}`,
          },
        } satisfies IngestionFetchResult<TResponse>;
      }

      const fetchResult = await fetchApiFootballJson<TResponse>({
        config: this.#config,
        workload,
        resourceId: options.resourceId,
        replayId: options.replayId ?? `live:${workload}:${this.#clock()}`,
        path,
        fetchFn: this.#fetchFn,
      });

      if (fetchResult.status !== 'fetched') {
        // Refund the reservation when the call was skipped before hitting the
        // network (replay mode, missing key, unsupported provider). The
        // counter must reflect calls that actually left the worker. Failed
        // calls keep the reservation: the provider was reached, just errored.
        let postSnapshot = reservation.snapshot;
        if (fetchResult.status === 'skipped') {
          postSnapshot = await this.#quota.refund();
          this.#recordQuota(postSnapshot);
        } else {
          this.#metrics.recordProviderCall(this.#provider, workload, path);
        }
        this.#metrics.recordOutcome(fetchResult.status);
        this.#log({
          event: 'ingestion_provider_skip',
          provider: this.#provider,
          workload,
          cacheKey,
          fetchStatus: fetchResult.status,
          skipReason: (fetchResult as { skipReason?: string }).skipReason,
        });
        return {
          status: fetchResult.status,
          workload,
          resourceId: options.resourceId,
          cacheKey,
          cacheHit: false,
          cachedOnlyMode: postSnapshot.cachedOnlyMode,
          quota: postSnapshot,
          fetch: fetchResult,
          error: fetchResult.error,
          fallbackReason: postSnapshot.cachedOnlyMode ? 'PROVIDER_OUTAGE' : undefined,
        } satisfies IngestionFetchResult<TResponse>;
      }

      this.#metrics.recordProviderCall(this.#provider, workload, path);
      this.#metrics.recordOutcome('fetched');
      const json = fetchResult.json;
      if (json !== undefined) {
        await this.#cache.set(cacheKey, json, ttlSeconds);
      }

      this.#log({
        event: 'ingestion_provider_fetch',
        provider: this.#provider,
        workload,
        cacheKey,
        ttlSeconds,
        calls: reservation.snapshot.calls,
        cachedOnlyMode: reservation.snapshot.cachedOnlyMode,
      });

      return {
        status: 'fetched',
        workload,
        resourceId: options.resourceId,
        cacheKey,
        cacheHit: false,
        cachedOnlyMode: reservation.snapshot.cachedOnlyMode,
        quota: reservation.snapshot,
        fetch: fetchResult,
        data: json,
        fallbackReason: reservation.snapshot.cachedOnlyMode ? 'PROVIDER_OUTAGE' : undefined,
      } satisfies IngestionFetchResult<TResponse>;
    });
  }

  /**
   * Compute the canonical cache key for a workload. Shape:
   *   provider:workload:resource
   * Keeps Redis namespace under one shared prefix per provider.
   */
  cacheKeyFor(workload: IngestionWorkload, resourceId: string): string {
    return `${this.#provider}:${workload}:${resourceId}`;
  }

  /**
   * Schedule recurring ticks for each workload. Returns a stop function that
   * cancels all timers. The caller is responsible for providing the list of
   * fixtures/teams/players to refresh on each tick.
   *
   * Note: API-Football v3 has no webhook support, so the live ingestion path
   * is polling-only. This loop is the single source of provider calls.
   */
  start(options: IngestionLoopStartOptions = {}): () => void {
    const intervals = { ...INGESTION_TICK_INTERVAL_MS, ...options.intervals };
    const schedule = options.schedule ?? defaultSchedule;
    const cancel = options.cancel ?? defaultCancel;
    const stopHandles: unknown[] = [];

    const enqueueTick = (workload: IngestionWorkload, refresh: () => Promise<void>): void => {
      const interval = intervals[workload];
      if (!interval || interval <= 0) {
        return;
      }
      const handle = schedule(() => {
        refresh().catch((error: unknown) => {
          this.#log({
            event: 'ingestion_tick_error',
            provider: this.#provider,
            workload,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, interval);
      stopHandles.push(handle);
    };

    enqueueTick('fixtures-next-7d', async () => {
      await this.fetchWorkload({
        workload: 'fixtures-next-7d',
        resourceId: 'top-competitions',
        path: apiFootballFixtureSyncPaths()[0],
      });
    });

    const fixtureIds = options.fixtureIds ?? [];
    if (fixtureIds.length > 0) {
      enqueueTick('fixture-detail-preKO', async () => {
        await Promise.allSettled(
          fixtureIds.map((id) =>
            this.fetchWorkload({
              workload: 'fixture-detail-preKO',
              resourceId: id,
            })
          )
        );
      });
      enqueueTick('fixture-detail-live', async () => {
        await Promise.allSettled(
          fixtureIds.map((id) =>
            this.fetchWorkload({
              workload: 'fixture-detail-live',
              resourceId: id,
            })
          )
        );
      });
      enqueueTick('fixture-detail-fullTime', async () => {
        await Promise.allSettled(
          fixtureIds.map((id) =>
            this.fetchWorkload({
              workload: 'fixture-detail-fullTime',
              resourceId: id,
            })
          )
        );
      });
      enqueueTick('lineups-post-confirm', async () => {
        await Promise.allSettled(
          fixtureIds.map((id) =>
            this.fetchWorkload({
              workload: 'lineups-post-confirm',
              resourceId: id,
            })
          )
        );
      });
    }

    const teamIds = options.teamIds ?? [];
    if (teamIds.length > 0) {
      enqueueTick('team-metadata', async () => {
        await Promise.allSettled(
          teamIds.map((id) =>
            this.fetchWorkload({
              workload: 'team-metadata',
              resourceId: id,
              path: `/teams?id=${encodeURIComponent(id)}`,
            })
          )
        );
      });
    }

    const playerIds = options.playerIds ?? [];
    if (playerIds.length > 0) {
      enqueueTick('player-metadata', async () => {
        await Promise.allSettled(
          playerIds.map((id) =>
            this.fetchWorkload({
              workload: 'player-metadata',
              resourceId: id,
              path: `/players?id=${encodeURIComponent(id)}`,
            })
          )
        );
      });
    }

    this.#timers.push(...stopHandles);

    return () => {
      for (const handle of stopHandles) {
        cancel(handle);
      }
    };
  }

  /**
   * Convenience helper used by tests and the worker HTTP path to read a
   * snapshot of metrics + quota in one shot.
   */
  async observe(): Promise<{
    readonly metrics: ReturnType<IngestionMetrics['snapshot']>;
    readonly quota: ProviderQuotaSnapshot;
    readonly ttlSeconds: typeof INGESTION_TTL_SECONDS;
  }> {
    const quota = await this.#quota.snapshot();
    this.#recordQuota(quota);
    return {
      metrics: this.#metrics.snapshot(),
      quota,
      ttlSeconds: INGESTION_TTL_SECONDS,
    };
  }

  #recordQuota(snapshot: ProviderQuotaSnapshot): void {
    this.#metrics.recordQuota(snapshot.calls, snapshot.posture);
  }
}

function apiFootballPathFor(workload: IngestionWorkload, resourceId: string): string {
  switch (workload) {
    case 'fixtures-next-7d':
      return apiFootballFixtureSyncPaths()[0] ?? '/fixtures';
    case 'fixture-detail-preKO':
    case 'fixture-detail-live':
    case 'fixture-detail-fullTime':
      return apiFootballFixturePath(resourceId);
    case 'lineups-post-confirm':
      return apiFootballLineupPath(resourceId);
    case 'team-metadata':
      return `/teams?id=${encodeURIComponent(resourceId)}`;
    case 'player-metadata':
      return `/players?id=${encodeURIComponent(resourceId)}`;
  }
}

function defaultLogger(entry: Record<string, unknown>): void {
  // Keep one structured line per event; secrets are never present in this
  // path because provider-http redacts the API key before reporting.
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
}

const defaultSchedule = (callback: () => void, ms: number): unknown => setInterval(callback, ms);

const defaultCancel = (handle: unknown): void => {
  if (handle && typeof handle === 'object' && 'unref' in handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  }
};

export const PROVIDER_ID = API_FOOTBALL_PROVIDER_ID;

export const __test = {
  apiFootballPathFor,
  SECONDS_TO_MS,
};
