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
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_PROVIDER_ID,
  apiFootballCompetitionKey,
  apiFootballEventPath,
  apiFootballFixturePath,
  apiFootballFixturePlayersPath,
  apiFootballFixtureStatisticsPath,
  apiFootballFixtureSyncPaths,
  apiFootballLineupPath,
  apiFootballSquadPath,
  apiFootballStandingPath,
  providerGameIdFromFixture,
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
  | 'events-post-final'
  | 'lineups-post-confirm'
  | 'team-match-stats'
  | 'player-match-stats'
  | 'squad-list-fallback'
  | 'competition-standings'
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
  'events-post-final': 6 * 60 * 60,
  'lineups-post-confirm': 60 * 60,
  // Team + player match stats are pulled as a sidecar off the live
  // fixture-detail tick (see `fetchMatchStatsForFixture`). A short 2-min TTL
  // keeps the in-play numbers (possession, shots, ratings) refreshing during a
  // match while still de-duping the 30s detail ticks down to one stats fetch
  // every ~2 min per fixture (the singleflight + cache absorb the rest). The
  // same short TTL also lets the FINAL settled stats land once the fixture
  // reaches full-time, rather than freezing a mid-match snapshot for hours.
  // The on-demand post-final + backfill workflows walk each fixture once, so
  // the short TTL costs them nothing.
  'team-match-stats': 2 * 60,
  'player-match-stats': 2 * 60,
  'squad-list-fallback': 24 * 60 * 60,
  // Standings move at most once per fixture round; a 6h TTL keeps the First
  // Touch club picker's table warm without re-spending provider budget on a
  // settled ladder. The daily-anchor sweep refreshes it once per run.
  'competition-standings': 6 * 60 * 60,
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
  // Retired from the steady-state cron. The fixture-detail-live payload
  // carries the same accumulating events[] inline, and the bridge lifts that
  // slice into game_occurrences on every live tick. Polling
  // /fixtures/events on its own 30-min cadence was tuned for "events settle
  // after FT", but the first pre-kickoff fetch returned [] which the 6h TTL
  // then poisoned into a half-day cache hit — so during a live match this
  // workload only ever emitted `bridge_events_missing` while the inline path
  // never fired. A 0 interval keeps `enqueueTick` from scheduling it; the
  // workload identifier stays in the type union so direct `fetchWorkload`
  // calls (replay tooling, backfill workflows) continue to work.
  'events-post-final': 0,
  'lineups-post-confirm': 10 * 60 * 1000, // every 10 min after lineups confirmed
  // Match stats have no standalone cron tick. They are driven as a sidecar off
  // the live fixture-detail tick (`fetchMatchStatsForFixture`, gated on in-play
  // / finished status) and pulled on-demand by the webhook-completed
  // (post-final) and season-backfill workflows. A 0 interval keeps
  // `enqueueTick` from scheduling a separate stats poll; the sidecar fetch
  // rides the existing 30s `fixture-detail-live` cadence instead.
  'team-match-stats': 0,
  'player-match-stats': 0,
  'squad-list-fallback': 6 * 60 * 60 * 1000,
  // Not on the steady-state polling cron: standings are pulled by the
  // daily-anchor sweep (and any one-shot trigger). A 0 interval keeps
  // enqueueTick from scheduling a standalone standings poll, so the workload
  // identifier stays available for direct fetchWorkload calls only.
  'competition-standings': 0,
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
  readonly status: 'cached' | 'fetched' | 'skipped' | 'failed' | 'denied' | 'rate_limited';
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly cacheKey: string;
  readonly cacheHit: boolean;
  readonly cachedOnlyMode: boolean;
  readonly quota: ProviderQuotaSnapshot;
  readonly fallbackReason?: 'PROVIDER_OUTAGE' | 'PROVIDER_RATE_LIMITED';
  readonly fetch?: ProviderJsonFetchResult<TResponse>;
  readonly data?: unknown;
  readonly error?: { readonly message: string };
}

/**
 * Optional bridge callback invoked after every successful `fetchWorkload`
 * call whose status is `fetched` or `cached` and whose workload carries
 * fixture-scoped provider data (fixture detail, events, or lineups).
 * The ingestion loop calls this without awaiting back-pressure: any error
 * is caught and logged via the loop's structured `#log` sink so the
 * fetch path can never be stalled by downstream wiring.
 *
 * Discovery and metadata workloads do NOT trigger this callback; their payload
 * shape differs from a single fixture resource.
 */
export type OnFixtureFetchedCallback = (input: {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly data: unknown;
}) => Promise<void> | void;

export interface IngestionLoopOptions {
  readonly config: GamewireWorkerConfig;
  readonly cache?: ProviderCache;
  readonly quota?: ProviderQuotaTracker;
  readonly metrics?: IngestionMetrics;
  readonly singleflight?: Singleflight;
  readonly fetchFn?: ProviderFetch;
  readonly clock?: () => number;
  readonly logger?: (entry: Record<string, unknown>) => void;
  /**
   * Optional bridge fired after fixture-scoped provider fetches (cached or
   * freshly-fetched). See {@link OnFixtureFetchedCallback}. Defaults to
   * a no-op so the existing test surface remains unaffected.
   */
  readonly onFixtureFetched?: OnFixtureFetchedCallback;
}

export interface IngestionLoopStartOptions {
  /** Recurring fixture ids to keep polling. */
  readonly fixtureIds?: readonly string[];
  /** One-shot fixture ids to fetch during an immediate boot tick. */
  readonly bootstrapFixtureIds?: readonly string[];
  readonly teamIds?: readonly string[];
  readonly playerIds?: readonly string[];
  /** Run one tick immediately on start, then continue on the normal intervals. */
  readonly runImmediately?: boolean;
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
  readonly #onFixtureFetched?: OnFixtureFetchedCallback;

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
    this.#onFixtureFetched = options.onFixtureFetched;
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
      await this.#notifyFixtureFetched(workload, options.resourceId, cached);
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
        await this.#notifyFixtureFetched(workload, options.resourceId, racedHit);
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

      if (fetchResult.status === 'rate_limited') {
        // api-football's free + Pro plans return rate-limit responses as HTTP
        // 200 with `{response: [], errors: {rateLimit: "..."}}`. The call DID
        // leave the worker (so the reservation stays consumed) but the
        // envelope is poison — caching it would surface `empty_provider_response`
        // every time downstream re-reads the entry until the TTL expires (6h
        // for match-stats). Skip the cache write, record an outcome metric so
        // ops can graph rate-limit hits, log a structured event, and propagate
        // PROVIDER_RATE_LIMITED via fallbackReason so the workflow layer can
        // emit a degrade flag.
        this.#metrics.recordProviderCall(this.#provider, workload, path);
        this.#metrics.recordOutcome('rate_limited');
        this.#log({
          event: 'provider_rate_limited',
          provider: this.#provider,
          workload,
          resourceId: options.resourceId,
          cacheKey,
          message: fetchResult.rateLimitMessage,
        });
        return {
          status: 'rate_limited',
          workload,
          resourceId: options.resourceId,
          cacheKey,
          cacheHit: false,
          cachedOnlyMode: reservation.snapshot.cachedOnlyMode,
          quota: reservation.snapshot,
          fetch: fetchResult,
          fallbackReason: 'PROVIDER_RATE_LIMITED',
          error: fetchResult.rateLimitMessage
            ? { message: fetchResult.rateLimitMessage }
            : undefined,
        } satisfies IngestionFetchResult<TResponse>;
      }

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

      await this.#notifyFixtureFetched(workload, options.resourceId, json);

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
    const fixtureIds = new Set(normaliseResourceIds(options.fixtureIds ?? []));
    const bootstrapFixtureIds = new Set(normaliseResourceIds(options.bootstrapFixtureIds ?? []));
    const fixtureTeamIds = new Map<string, readonly string[]>();

    const enqueueTick = (
      workload: IngestionWorkload,
      refresh: () => Promise<void>,
      immediateRefresh: () => Promise<void> = refresh
    ): void => {
      const interval = intervals[workload];
      if (!interval || interval <= 0) {
        return;
      }
      if (options.runImmediately) {
        runRefresh(workload, immediateRefresh);
      }
      const handle = schedule(() => {
        runRefresh(workload, refresh);
      }, interval);
      stopHandles.push(handle);
    };

    const runRefresh = (workload: IngestionWorkload, refresh: () => Promise<void>): void => {
      refresh().catch((error: unknown) => {
        this.#log({
          event: 'ingestion_tick_error',
          provider: this.#provider,
          workload,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    const addFixtureIds = (ids: readonly string[], source: string): void => {
      const before = fixtureIds.size;
      for (const id of normaliseResourceIds(ids)) {
        fixtureIds.add(id);
      }
      const added = fixtureIds.size - before;
      if (added > 0) {
        this.#log({
          event: 'ingestion_fixture_ids_discovered',
          provider: this.#provider,
          source,
          added,
          total: fixtureIds.size,
        });
      }
    };

    enqueueTick('fixtures-next-7d', async () => {
      // Sweep EVERY competition in the catalogue, not just the first. The
      // fixture-sync paths line up 1:1 with `API_FOOTBALL_BETA_COMPETITIONS`,
      // so each league is fetched under its own `league-<id>-season-<season>`
      // resourceId. This is what lands SCHEDULED games for upcoming-only
      // competitions — most importantly FIFA World Cup 2026 (league 1 /
      // season 2026) ahead of its opener: the previous `[0]` fetch only ever
      // pulled the Premier League, so WC fixtures never reached the bridge.
      //
      // Each fetch flows through the ingestion-loop bridge's
      // `fixtures-next-7d` branch, which upserts a canonical SCHEDULED game +
      // the provider_game_mappings crosswalk per fixture (idempotent on
      // `(provider, provider_game_id)`). Per-league resourceIds keep cache
      // keys + crosswalk scopes clean. `allSettled` isolates one league's
      // failure (quota/provider error) from the rest of the sweep.
      const paths = apiFootballFixtureSyncPaths();
      await Promise.allSettled(
        API_FOOTBALL_BETA_COMPETITIONS.map(async (competition, index) => {
          const path = paths[index];
          if (path === undefined) {
            return;
          }
          const result = await this.fetchWorkload({
            workload: 'fixtures-next-7d',
            resourceId: apiFootballCompetitionKey(competition),
            path,
          });
          addFixtureIds(fixtureIdsFromFixtureList(result.data, this.#clock()), 'fixtures-next-7d');
        })
      );
    });

    const fixtureIdsForImmediate = (): readonly string[] => [
      ...new Set([...fixtureIds, ...bootstrapFixtureIds]),
    ];
    const fetchFixtureWorkload = async (
      workload: Extract<
        IngestionWorkload,
        | 'fixture-detail-preKO'
        | 'fixture-detail-live'
        | 'fixture-detail-fullTime'
        | 'events-post-final'
        | 'lineups-post-confirm'
      >,
      ids: readonly string[]
    ): Promise<void> => {
      await Promise.allSettled(
        ids.map(async (id) => {
          const result = await this.fetchWorkload({
            workload,
            resourceId: id,
          });
          if (FIXTURE_DETAIL_WORKLOADS.has(workload) && result.data !== undefined) {
            const teamIds = teamIdsFromFixtureDetail(result.data);
            if (teamIds.length > 0) {
              fixtureTeamIds.set(id, teamIds);
            }
            // Match-stats sidecar: a live (or just-finished) fixture-detail tick
            // is the trigger to refresh team + player match stats for the same
            // fixture. The provider exposes `/fixtures/statistics` +
            // `/fixtures/players` only for in-play / finished fixtures, so this
            // is gated on the detail payload's status. The short stats TTL keeps
            // the live numbers fresh without re-spending budget every 30s tick;
            // the bridge (`onFixtureFetched`) owns the canonical ingest into
            // game-service. Skipped for pre-kickoff fixtures (empty payload).
            const statusShort = statusShortFromFixtureDetail(result.data);
            if (STATS_FETCH_FIXTURE_STATUSES.has(statusShort)) {
              await fetchMatchStatsForFixture(id);
            }
          }
          if (workload === 'lineups-post-confirm' && lineupsMissing(result.data)) {
            let teamIds = fixtureTeamIds.get(id) ?? [];
            if (teamIds.length === 0) {
              const fixtureDetail = await this.fetchWorkload({
                workload: 'fixture-detail-fullTime',
                resourceId: id,
              });
              teamIds = teamIdsFromFixtureDetail(fixtureDetail.data);
              if (teamIds.length > 0) {
                fixtureTeamIds.set(id, teamIds);
              }
            }
            await fetchSquadFallbacksForFixture(id, teamIds);
          }
        })
      );
    };

    const fetchSquadFallbacksForFixture = async (
      fixtureId: string,
      teamIds: readonly string[]
    ): Promise<void> => {
      await Promise.allSettled(
        normaliseResourceIds(teamIds).map((teamId) =>
          this.fetchWorkload({
            workload: 'squad-list-fallback',
            resourceId: squadListResourceId(fixtureId, teamId),
          })
        )
      );
    };

    // Fetch team + player match stats for one fixture. The provider serves
    // these on dedicated endpoints (`/fixtures/statistics`, `/fixtures/players`)
    // — they are NOT embedded in the `/fixtures?id=N` detail payload the way
    // the events[] timeline is, so they cannot be lifted inline. The bridge
    // routes both workloads to game-service's IngestTeamMatchStats /
    // IngestPlayerMatchStats. `allSettled` isolates one endpoint's failure from
    // the other; the cache + singleflight + quota gates apply per workload.
    const fetchMatchStatsForFixture = async (fixtureId: string): Promise<void> => {
      await Promise.allSettled([
        this.fetchWorkload({ workload: 'team-match-stats', resourceId: fixtureId }),
        this.fetchWorkload({ workload: 'player-match-stats', resourceId: fixtureId }),
      ]);
    };

    enqueueTick(
      'fixture-detail-preKO',
      async () => {
        await fetchFixtureWorkload('fixture-detail-preKO', [...fixtureIds]);
      },
      async () => {
        await fetchFixtureWorkload('fixture-detail-preKO', fixtureIdsForImmediate());
      }
    );
    enqueueTick(
      'fixture-detail-live',
      async () => {
        await fetchFixtureWorkload('fixture-detail-live', [...fixtureIds]);
      },
      async () => {
        await fetchFixtureWorkload('fixture-detail-live', fixtureIdsForImmediate());
      }
    );
    enqueueTick(
      'fixture-detail-fullTime',
      async () => {
        await fetchFixtureWorkload('fixture-detail-fullTime', [...fixtureIds]);
      },
      async () => {
        await fetchFixtureWorkload('fixture-detail-fullTime', fixtureIdsForImmediate());
      }
    );
    enqueueTick(
      'events-post-final',
      async () => {
        await fetchFixtureWorkload('events-post-final', [...fixtureIds]);
      },
      async () => {
        await fetchFixtureWorkload('events-post-final', fixtureIdsForImmediate());
      }
    );
    enqueueTick(
      'lineups-post-confirm',
      async () => {
        await fetchFixtureWorkload('lineups-post-confirm', [...fixtureIds]);
      },
      async () => {
        await fetchFixtureWorkload('lineups-post-confirm', fixtureIdsForImmediate());
      }
    );

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

  /**
   * Fan out a successful fixture-scoped fetch (cached or freshly-fetched)
   * to the bridge callback. Any callback throw is caught + logged — the
   * fetch path must never be back-pressured by downstream consumers.
   *
   * Discovery and metadata workloads are ignored here so the callback stays
   * scoped to one provider fixture resource at a time.
   */
  async #notifyFixtureFetched(
    workload: IngestionWorkload,
    resourceId: string,
    data: unknown
  ): Promise<void> {
    if (!this.#onFixtureFetched) {
      return;
    }
    if (!BRIDGE_WORKLOADS.has(workload)) {
      return;
    }
    if (data === undefined) {
      return;
    }
    try {
      await Promise.resolve(this.#onFixtureFetched({ workload, resourceId, data }));
    } catch (error) {
      this.#log({
        event: 'ingestion_bridge_error',
        provider: this.#provider,
        workload,
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Workloads whose payload is fixture detail. Event and lineup fetches also
 * flow through the bridge via `BRIDGE_WORKLOADS`, but only these detail
 * workloads drive match-concluded observation.
 */
const FIXTURE_DETAIL_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set([
  'fixture-detail-preKO',
  'fixture-detail-live',
  'fixture-detail-fullTime',
]);

const BRIDGE_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set([
  ...FIXTURE_DETAIL_WORKLOADS,
  // The fixtures LIST workload flows through the bridge so the
  // match-concluded bridge can mint SCHEDULED canonical games + the
  // provider_game_mappings crosswalk for upcoming fixtures (the forward
  // -1d/+7d window and the season discovery pass). The single-fixture
  // detail/events/lineups branches only fire once a fixture is in-play or
  // finalised; without the list branch a competition whose fixtures are all
  // upcoming (e.g. FIFA World Cup 2026 before its opener) never created any
  // canonical games. The bridge's list branch never publishes a
  // match-concluded fact — it only upserts the SCHEDULED game + crosswalk.
  'fixtures-next-7d',
  'events-post-final',
  'lineups-post-confirm',
  'team-match-stats',
  'player-match-stats',
  'squad-list-fallback',
]);

const FIXTURE_DISCOVERY_AHEAD_MS = 7 * 24 * 60 * 60 * 1_000;
const FIXTURE_DISCOVERY_BEHIND_MS = 2 * 60 * 60 * 1_000;

const LIVE_FIXTURE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'SUSP']);

// Settled (full-time) fixture statuses. A fixture in one of these has a final
// scoreline, so its match stats are settled and worth a last fetch.
const FINISHED_FIXTURE_STATUSES = new Set(['FT', 'AET', 'PEN']);

// Statuses for which the provider exposes match statistics worth ingesting.
// In-play AND finished fixtures both carry a `/fixtures/statistics` +
// `/fixtures/players` payload (live numbers accumulate during play and settle
// at full-time). Pre-kickoff (NS) fixtures return empty arrays, so they are
// excluded to avoid burning provider budget + caching an empty envelope.
const STATS_FETCH_FIXTURE_STATUSES: ReadonlySet<string> = new Set([
  ...LIVE_FIXTURE_STATUSES,
  ...FINISHED_FIXTURE_STATUSES,
]);

function apiFootballPathFor(workload: IngestionWorkload, resourceId: string): string {
  switch (workload) {
    case 'fixtures-next-7d':
      return apiFootballFixtureSyncPaths()[0] ?? '/fixtures';
    case 'fixture-detail-preKO':
    case 'fixture-detail-live':
    case 'fixture-detail-fullTime':
      return apiFootballFixturePath(resourceId);
    case 'events-post-final':
      return apiFootballEventPath(resourceId);
    case 'lineups-post-confirm':
      return apiFootballLineupPath(resourceId);
    case 'team-match-stats':
      return apiFootballFixtureStatisticsPath(resourceId);
    case 'player-match-stats':
      return apiFootballFixturePlayersPath(resourceId);
    case 'squad-list-fallback':
      return apiFootballSquadPath(teamIdFromSquadListResourceId(resourceId));
    case 'competition-standings': {
      const { leagueId, season } = standingsResourceParts(resourceId);
      return apiFootballStandingPath(leagueId, season);
    }
    case 'team-metadata':
      return `/teams?id=${encodeURIComponent(resourceId)}`;
    case 'player-metadata':
      return `/players?id=${encodeURIComponent(resourceId)}`;
  }
}

/**
 * Parse a `standings-<leagueId>-<season>` resource id back into its provider
 * league id + season. Used only by the direct-call path fallback in
 * {@link apiFootballPathFor}; the daily-anchor sweep passes an explicit path,
 * so the fields are reconstructed here for any operator one-shot that calls
 * `fetchWorkload({ workload: 'competition-standings', resourceId })` without a
 * path. Returns empty strings for a malformed id; the provider call then 4xxs
 * and the fetch records a failure rather than silently hitting the wrong table.
 */
function standingsResourceParts(resourceId: string): {
  readonly leagueId: string;
  readonly season: string;
} {
  const match = /^standings-(\d+)-(\d+)$/.exec(resourceId.trim());
  if (!match) {
    return { leagueId: '', season: '' };
  }
  return { leagueId: match[1] ?? '', season: match[2] ?? '' };
}

function fixtureIdsFromFixtureList(data: unknown, nowMs: number): readonly string[] {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data.response) {
    if (!isRecord(item)) {
      continue;
    }
    const fixture = item.fixture;
    if (!isRecord(fixture)) {
      continue;
    }
    const id = providerGameIdFromFixture(fixture);
    if (id === '') {
      continue;
    }
    if (isDiscoverableFixture(fixture, nowMs)) {
      ids.add(id);
    }
  }
  return [...ids];
}

function isDiscoverableFixture(fixture: Record<string, unknown>, nowMs: number): boolean {
  const status = isRecord(fixture.status) ? String(fixture.status.short ?? '').toUpperCase() : '';
  if (LIVE_FIXTURE_STATUSES.has(status)) {
    return true;
  }
  const rawDate = fixture.date;
  if (typeof rawDate !== 'string' || rawDate.trim() === '') {
    return false;
  }
  const scheduledMs = Date.parse(rawDate);
  if (!Number.isFinite(scheduledMs)) {
    return false;
  }
  return (
    scheduledMs >= nowMs - FIXTURE_DISCOVERY_BEHIND_MS &&
    scheduledMs <= nowMs + FIXTURE_DISCOVERY_AHEAD_MS
  );
}

function normaliseResourceIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed !== '') {
      seen.add(trimmed);
    }
  }
  return [...seen];
}

function teamIdsFromFixtureDetail(data: unknown): readonly string[] {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data.response) {
    if (!isRecord(item) || !isRecord(item.teams)) {
      continue;
    }
    for (const key of ['home', 'away'] as const) {
      const team = item.teams[key];
      if (!isRecord(team)) {
        continue;
      }
      const id = team.id;
      if ((typeof id === 'string' && id.trim() !== '') || (typeof id === 'number' && id > 0)) {
        ids.add(String(id).trim());
      }
    }
  }
  return [...ids];
}

/**
 * Read the provider status short code off a `/fixtures?id=N` detail envelope
 * (`response[0].fixture.status.short`), upper-cased. Returns an empty string
 * when the payload is malformed or the status is absent. Used to gate the
 * live match-stats fetch so it only fires for in-play / finished fixtures.
 */
function statusShortFromFixtureDetail(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return '';
  }
  for (const item of data.response) {
    if (!isRecord(item) || !isRecord(item.fixture)) {
      continue;
    }
    const status = item.fixture.status;
    if (!isRecord(status)) {
      continue;
    }
    const short = status.short;
    if (typeof short === 'string' && short.trim() !== '') {
      return short.trim().toUpperCase();
    }
  }
  return '';
}

function lineupsMissing(data: unknown): boolean {
  return isRecord(data) && Array.isArray(data.response) && data.response.length === 0;
}

function squadListResourceId(fixtureId: string, teamId: string): string {
  return `${fixtureId.trim()}:${teamId.trim()}`;
}

function teamIdFromSquadListResourceId(resourceId: string): string {
  const [, teamId = ''] = resourceId.split(':');
  return teamId.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  fixtureIdsFromFixtureList,
  lineupsMissing,
  squadListResourceId,
  teamIdsFromFixtureDetail,
  SECONDS_TO_MS,
};
