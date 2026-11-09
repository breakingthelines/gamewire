/**
 * API-Football ingestion loop.
 *
 * Conservative live-ingestion path:
 *   1. Cache-first: every workload has a TTL keyed in Redis.
 *   2. Singleflight: only one provider call per (provider, workload, resource)
 *      regardless of viewer count.
 *   3. Rate-gated: every provider call carries an explicit priority class
 *      (`live`, `near-live`, `background`). The per-minute limiter
 *      ({@link ProviderMinuteLimiter}) admits it against that class's ceiling,
 *      then the daily counter enforces the hard cap (env, default 140k), the
 *      soft cap that flips workflows to cached-only and emits PROVIDER_OUTAGE
 *      (default 130k), and the background daily cap.
 *   4. Observability: counters per provider/workload/endpoint and cache hit
 *      ratio gauge exposed via {@link IngestionMetrics}.
 *
 * The loop intentionally aggregates calls across viewers so a thundering herd
 * of UI reads cannot multiply provider RPS.
 */

import {
  API_FOOTBALL_PROVIDER_ID,
  apiFootballCompetitionKey,
  apiFootballEventPath,
  apiFootballFixturePath,
  apiFootballFixturePlayersPath,
  apiFootballFixtureStatisticsPath,
  apiFootballFixtureSyncPaths,
  apiFootballLeaguePath,
  apiFootballLineupPath,
  apiFootballSquadPath,
  apiFootballStandingPath,
  providerGameIdFromFixture,
} from '../adapters/api-football/index.js';
import {
  apiFootballInjuriesLeaguePath,
  apiFootballPlayerSeasonStatsPath,
  apiFootballSidelinedPath,
  apiFootballTeamStatisticsPath,
  apiFootballTransfersPath,
  apiFootballTrophiesPath,
} from '../adapters/api-football/enrichment-decoders.js';
import { LIVE_INGESTION_COMPETITIONS } from '../workflows/competitions.js';
import type { ProviderCache } from './cache.js';
import { InMemoryProviderCache } from './cache.js';
import type { GamewireWorkerConfig } from './config.js';
import { IngestionMetrics } from './metrics.js';
import {
  fetchApiFootballJson,
  type ProviderFetch,
  type ProviderJsonFetchResult,
} from './provider-http.js';
import {
  ProviderMinuteLimiter,
  type MinuteAcquireResult,
  type ProviderPriority,
} from './minute-limiter.js';
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
  | 'competition-current-season'
  | 'team-metadata'
  | 'provider-fixture-results'
  | 'player-season-stats'
  | 'injuries-league'
  | 'player-sidelined'
  | 'team-transfers'
  | 'trophies'
  | 'team-season-stats';

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
  // fixture-detail tick (see `fetchMatchStatsForFixture`). A 60s TTL keeps the
  // in-play numbers (possession, shots, ratings) within ~1 min of live while
  // still de-duping the 30s detail ticks down to one stats fetch every other
  // tick per fixture (the singleflight + cache absorb the rest). The same short
  // TTL lets the FINAL settled stats land once the fixture reaches full-time,
  // rather than freezing a mid-match snapshot for hours. The on-demand
  // post-final + backfill workflows walk each fixture once, so it costs them
  // nothing.
  //
  // Quota: a refresh = 2 calls (team + player), cache-first, so the TTL — not
  // the 30s tick — sets the provider rate. At 60s a full 5-league domestic
  // gameweek (~48 fixtures, the busiest realistic day) costs ~11.5k stats
  // calls/day; with scores + the rest of the fleet that totals ~24k/day, well
  // under the 60k soft cap and clear of the per-minute limit at peak
  // concurrency. 30s was affordable on the daily cap (~36k total) but sat at
  // the soft-cap line and pushed per-minute pressure on a packed Saturday slot,
  // so 60s is the deliberate midpoint: half the staleness of the old 2-min for
  // a fraction of 30s's cost. The frontend Stats tab polls at 15s, so it
  // surfaces each 60s backend refresh promptly.
  'team-match-stats': 60,
  'player-match-stats': 60,
  'squad-list-fallback': 24 * 60 * 60,
  // Standings move at most once per fixture round; a 6h TTL keeps the First
  // Touch club picker's table warm without re-spending provider budget on a
  // settled ladder. The daily-anchor sweep refreshes it once per run.
  'competition-standings': 6 * 60 * 60,
  // A competition's "current season" flips at most once per year (the summer
  // roll), so a 24h TTL is generous — comfortably exceeding standings' 6h. The
  // daily-anchor sweep refreshes it once per run; this TTL de-dupes any
  // repeated fetch within a day to a single provider call per competition.
  'competition-current-season': 24 * 60 * 60,
  'team-metadata': 24 * 60 * 60,
  // PF-GW1 (`workflows/provider-fixture-results.ts`). Never cached, like
  // enrichment: the workflow fetches with `cache: 'bypass'` (verdict D9),
  // and the cache key ignores `path`, so a cached nightly entry would serve
  // the previous night's date window. TTL 0 so a direct call caches nothing.
  'provider-fixture-results': 0,
  // Enrichment (GW-6a). Never cached: the provider-enrichment workflow fetches
  // with `cache: 'bypass'` and writes each page straight to game-service
  // (verdict D9, the shared Redis has no maxmemory). The TTL is 0 so a direct
  // call without the bypass caches nothing either.
  'player-season-stats': 0,
  // GW-6b enrichment datasets: never cached, same as player-season-stats (D9).
  'injuries-league': 0,
  'player-sidelined': 0,
  'team-transfers': 0,
  trophies: 0,
  // GW-6c: never cached either (D9).
  'team-season-stats': 0,
} as const;

/**
 * TTL for an EMPTY `lineups-post-confirm` response (`{ response: [] }`), i.e.
 * lineups not published yet during the pre-kickoff window. The full
 * `lineups-post-confirm` TTL (1h) is right for a POPULATED lineup — confirmed XIs
 * don't change — but caching the empty for 1h masks the real lineup for up to an
 * hour: the next ~6 ten-minute polls all hit the stale empty and never re-ask the
 * provider. Premier League lineups typically publish ~T-60 to T-75; a short empty
 * TTL (< the 10-min poll interval) lets the next tick re-fetch and surface them
 * at the provider's earliest availability. Quota cost is trivial (~+5 calls per
 * fixture across the pre-match window).
 */
export const LINEUPS_EMPTY_TTL_SECONDS = 5 * 60;

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
  // Not on the steady-state polling cron: current-season windows are pulled by
  // the daily-anchor sweep (and any one-shot trigger). A 0 interval keeps
  // enqueueTick from scheduling a standalone poll; the workload identifier
  // stays available for direct fetchWorkload calls only.
  'competition-current-season': 0,
  'team-metadata': 6 * 60 * 60 * 1000,
  // Not on the steady-state polling cron: PF-GW1 is invoked only via its own
  // `/workflows/provider-fixture-results` endpoint (kernel-scheduled or
  // ops one-shot), never by `enqueueTick`. A 0 interval keeps it off the
  // loop; the workload identifier stays available for direct
  // `fetchWorkload` calls only.
  'provider-fixture-results': 0,
  // Driven only by POST /workflows/provider-enrichment.
  'player-season-stats': 0,
  // GW-6b enrichment datasets: driven only by the same endpoint.
  'injuries-league': 0,
  'player-sidelined': 0,
  'team-transfers': 0,
  trophies: 0,
  'team-season-stats': 0,
} as const;

/**
 * How long a live payload stays available as "last good" after it was fetched.
 * The primary cache entry expires with the workload TTL (30s for live detail),
 * so without a second key there is nothing to serve when the per-minute
 * limiter denies a live call.
 */
export const LAST_GOOD_TTL_SECONDS = 15 * 60;

/**
 * Priority class of every call the polling loop makes itself. Workflows do not
 * use this table: every `/workflows/*` call passes `background` explicitly,
 * because backfills reuse live workload names (`team-match-stats`,
 * `fixture-detail-fullTime`, ...) and must not run at live priority.
 */
export const LOOP_WORKLOAD_PRIORITY = {
  'fixtures-next-7d': 'near-live',
  'fixture-detail-preKO': 'near-live',
  'fixture-detail-live': 'live',
  'fixture-detail-fullTime': 'near-live',
  'events-post-final': 'near-live',
  'lineups-post-confirm': 'near-live',
  'squad-list-fallback': 'background',
  'team-metadata': 'background',
} as const satisfies Partial<Record<IngestionWorkload, ProviderPriority>>;

export interface IngestionFetchOptions {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  /**
   * Required. The caller decides the class; it is never inferred from the
   * workload name. The live tick and its stats sidecar pass `live`; other loop
   * ticks pass `near-live`; every workflow passes `background`.
   */
  readonly priority: ProviderPriority;
  readonly replayId?: string;
  /** Optional override for tests. */
  readonly path?: string;
  /**
   * `bypass` skips the cache read and write for this call: the payload goes
   * back to the caller only. Used for bulk enrichment pages, which must not
   * be held in the shared cache (verdict D9). Default `use`.
   */
  readonly cache?: 'use' | 'bypass';
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
  readonly priority?: ProviderPriority;
  /** The per-minute limiter held this call back (status `rate_limited`, or a stale `cached`). */
  readonly throttled?: boolean;
  /** `data` is the last-good payload served because the live call was throttled. */
  readonly stale?: boolean;
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
  /** Per-minute limiter. Defaults to an in-memory limiter with the default ceilings. */
  readonly minuteLimiter?: ProviderMinuteLimiter;
  /** Sleep used when near-live/background wait for the next minute. Override in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
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
  /**
   * How long a fetch waits for {@link onFixtureFetched} before returning. The
   * bridge keeps running past it. Default {@link DEFAULT_BRIDGE_TIMEOUT_MS}.
   */
  readonly bridgeTimeoutMs?: number;
}

/** Default wait for the fixture bridge inside one fetch. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

export interface IngestionLoopStartOptions {
  /** Recurring fixture ids to keep polling. */
  readonly fixtureIds?: readonly string[];
  /** One-shot fixture ids to fetch during an immediate boot tick. */
  readonly bootstrapFixtureIds?: readonly string[];
  readonly teamIds?: readonly string[];
  /** Run one tick immediately on start, then continue on the normal intervals. */
  readonly runImmediately?: boolean;
  /** Override ms intervals for tests. */
  readonly intervals?: Partial<Record<IngestionWorkload, number>>;
  /**
   * Override the per-workload tick deadline (ms) for tests. A run older than
   * its deadline stops blocking the next tick. Default: see
   * {@link defaultTickDeadlineMs}.
   */
  readonly tickDeadlineMs?: Partial<Record<IngestionWorkload, number>>;
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

const SECONDS_TO_MS = 1_000;

const MIN_TICK_DEADLINE_MS = 2 * 60 * 1_000;
const MAX_TICK_DEADLINE_MS = 15 * 60 * 1_000;

/**
 * How long a tick may run before the next tick stops waiting for it: four
 * intervals, at least 2 minutes (one near-live minute wait plus a few request
 * timeouts) and at most 15 minutes. The 30s live tick gets 2 minutes; the
 * hourly discovery sweep gets 15.
 */
export const defaultTickDeadlineMs = (intervalMs: number): number =>
  Math.min(MAX_TICK_DEADLINE_MS, Math.max(MIN_TICK_DEADLINE_MS, intervalMs * 4));

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
  readonly #minuteLimiter: ProviderMinuteLimiter;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #metrics: IngestionMetrics;
  readonly #singleflight: Singleflight;
  readonly #fetchFn?: ProviderFetch;
  readonly #clock: () => number;
  readonly #log: (entry: Record<string, unknown>) => void;
  readonly #provider: string;
  readonly #timers: unknown[] = [];
  readonly #onFixtureFetched?: OnFixtureFetchedCallback;
  readonly #bridgeTimeoutMs: number;

  constructor(options: IngestionLoopOptions) {
    this.#config = options.config;
    this.#provider = options.config.providerId;
    this.#cache = options.cache ?? new InMemoryProviderCache();
    this.#quota =
      options.quota ?? new ProviderQuotaTracker({ provider: options.config.providerId });
    this.#metrics = options.metrics ?? new IngestionMetrics();
    this.#clock = options.clock ?? Date.now;
    this.#minuteLimiter =
      options.minuteLimiter ??
      new ProviderMinuteLimiter({ providerId: options.config.providerId, clock: this.#clock });
    this.#sleep = options.sleep ?? defaultSleep;
    this.#singleflight = options.singleflight ?? new Singleflight();
    this.#fetchFn = options.fetchFn;
    this.#log = options.logger ?? defaultLogger;
    this.#onFixtureFetched = options.onFixtureFetched;
    this.#bridgeTimeoutMs = options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
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

  get minuteLimiter(): ProviderMinuteLimiter {
    return this.#minuteLimiter;
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
    const priority = options.priority;
    const path = options.path ?? apiFootballPathFor(workload, options.resourceId);
    const cacheKey = this.cacheKeyFor(workload, options.resourceId);
    const ttlSeconds = INGESTION_TTL_SECONDS[workload];
    const useCache = options.cache !== 'bypass';

    // Cache lookup is outside the singleflight so concurrent hits return
    // instantly without contention.
    const cached = useCache ? await this.#cache.get<unknown>(cacheKey) : undefined;
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

    // Singleflight ensures the next steps run at most once per cache key and
    // priority class. The class is part of the merge key: the minute-limiter
    // wait (up to 60s) and the background daily cap both run inside the merged
    // call, so a live caller that joined a background leader would inherit its
    // wait and its throttled or denied result. Callers of different classes
    // fetch separately; the cache re-check below still collapses a call that
    // starts after another class has already landed the payload.
    return this.#singleflight.do(this.mergeKeyFor(priority, cacheKey), async () => {
      // Re-check cache inside singleflight in case the leader populated it
      // while we waited for the lock; this prevents double provider calls
      // immediately after a slow first request settles.
      const racedHit = useCache ? await this.#cache.get<unknown>(cacheKey) : undefined;
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

      // Per-minute limiter first: a call that may not leave this minute must
      // not spend daily quota.
      const minute = await this.#acquireMinute(priority, workload, cacheKey);
      if (!minute.allowed) {
        return this.#throttled<TResponse>(options, cacheKey, minute);
      }

      // Quota reservation precedes the call. If we are at hard cap (or, for
      // background, the background daily cap) the call is denied; if we cross
      // the soft cap during this reservation we still run the call but mark
      // the result so the operator sees the fallback.
      const reservation = await this.#quota.reserve(1, undefined, priority);
      this.#recordQuota(reservation.snapshot);

      if (!reservation.allowed) {
        await this.#minuteLimiter.release(minute);
        this.#metrics.recordOutcome('denied');
        this.#log({
          event: 'ingestion_quota_exceeded',
          provider: this.#provider,
          workload,
          cacheKey,
          reason: reservation.reason,
          priority,
          calls: reservation.snapshot.calls,
        });
        const capLabel =
          reservation.reason === 'background_cap'
            ? `${reservation.snapshot.calls} >= ${this.#quota.backgroundDailyCap} (background)`
            : `${reservation.snapshot.calls} >= ${reservation.snapshot.hardCap}`;
        return {
          status: 'denied',
          priority,
          workload,
          resourceId: options.resourceId,
          cacheKey,
          cacheHit: false,
          cachedOnlyMode: true,
          quota: reservation.snapshot,
          fallbackReason: 'PROVIDER_OUTAGE',
          error: {
            message: `Provider quota ${reservation.reason ?? 'hard_cap'} reached: ${capLabel}`,
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
      this.#observeProviderHeaders(fetchResult);

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
          await this.#minuteLimiter.release(minute);
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
          ...(fetchResult.timedOut ? { timedOut: true } : {}),
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
      if (json !== undefined && useCache && ttlSeconds > 0) {
        // An empty pre-kickoff lineups response means "not published yet" — a
        // transient state that flips within the pre-match window. Cache it briefly
        // (not the full 1h) so the next poll re-hits the provider and catches
        // lineups the moment they land. A populated lineup keeps the full TTL.
        const effectiveTtl =
          workload === 'lineups-post-confirm' && lineupsMissing(json)
            ? Math.min(ttlSeconds, LINEUPS_EMPTY_TTL_SECONDS)
            : ttlSeconds;
        await this.#cache.set(cacheKey, json, effectiveTtl);
        if (priority === 'live') {
          await this.#cache.set(this.lastGoodKeyFor(cacheKey), json, LAST_GOOD_TTL_SECONDS);
        }
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

  /** Singleflight key: one merged provider call per cache key and priority class. */
  mergeKeyFor(priority: ProviderPriority, cacheKey: string): string {
    return `${priority}:${cacheKey}`;
  }

  /** Separate key holding the last successful live payload for {@link LAST_GOOD_TTL_SECONDS}. */
  lastGoodKeyFor(cacheKey: string): string {
    return `${cacheKey}:last-good`;
  }

  /**
   * Ask the per-minute limiter for a token. `live` is answered at once (a
   * denied live call serves the last-good payload instead). `near-live` and
   * `background` wait, at most 60s, until the limiter expects room (the next
   * minute boundary or a little after it), and retry once.
   */
  async #acquireMinute(
    priority: ProviderPriority,
    workload: IngestionWorkload,
    cacheKey: string
  ): Promise<MinuteAcquireResult> {
    const first = await this.#minuteLimiter.tryAcquire(priority);
    if (first.allowed || priority === 'live') {
      return first;
    }
    // Wait until the estimate would admit this call, never more than 60s.
    const waitMs = Math.max(0, Math.min(60_000, first.retryAfterMs ?? first.msUntilNextMinute));
    this.#log({
      event: 'provider_minute_wait',
      provider: this.#provider,
      workload,
      priority,
      cacheKey,
      reason: first.reason,
      estimate: first.estimate,
      ceiling: first.ceiling,
      waitMs,
    });
    await this.#sleep(waitMs);
    return this.#minuteLimiter.tryAcquire(priority);
  }

  async #throttled<TResponse>(
    options: IngestionFetchOptions,
    cacheKey: string,
    minute: MinuteAcquireResult
  ): Promise<IngestionFetchResult<TResponse>> {
    const { workload, priority } = options;
    this.#metrics.recordMinuteThrottled(workload);
    this.#metrics.recordOutcome('throttled');
    this.#log({
      event: 'provider_minute_throttled',
      provider: this.#provider,
      workload,
      priority,
      cacheKey,
      reason: minute.reason,
      estimate: minute.estimate,
      ceiling: minute.ceiling,
    });
    const snapshot = await this.#quota.snapshot();
    this.#recordQuota(snapshot);
    if (priority === 'live') {
      const lastGood = await this.#cache.get<unknown>(this.lastGoodKeyFor(cacheKey));
      if (lastGood !== undefined) {
        // The bridge already ingested this payload when it was fetched, so
        // it is not notified again.
        this.#metrics.recordStaleServed(workload);
        return {
          status: 'cached',
          workload,
          resourceId: options.resourceId,
          cacheKey,
          cacheHit: true,
          cachedOnlyMode: snapshot.cachedOnlyMode,
          quota: snapshot,
          data: lastGood,
          priority,
          throttled: true,
          stale: true,
          fallbackReason: 'PROVIDER_RATE_LIMITED',
        };
      }
    }
    return {
      status: 'rate_limited',
      workload,
      resourceId: options.resourceId,
      cacheKey,
      cacheHit: false,
      cachedOnlyMode: snapshot.cachedOnlyMode,
      quota: snapshot,
      priority,
      throttled: true,
      fallbackReason: 'PROVIDER_RATE_LIMITED',
      error: {
        message: `Provider minute limit for ${priority} reached (${minute.reason ?? 'minute_cap'}: ${Math.round(minute.estimate)}/${minute.ceiling})`,
      },
    };
  }

  #observeProviderHeaders(fetchResult: ProviderJsonFetchResult<unknown>): void {
    const headers = fetchResult.rateLimit;
    if (!headers) {
      return;
    }
    this.#quota.observeProviderDaily({
      limit: headers.dailyLimit,
      remaining: headers.dailyRemaining,
    });
    this.#minuteLimiter.observeProviderMinute({
      remaining: headers.minuteRemaining,
      limit: headers.minuteLimit,
    });
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
    // Per-fixture lifecycle (status + kickoff + final-since): the routing source
    // of truth that decides which workload, if any, polls each fixture.
    const fixtureLifecycle = new Map<string, FixtureLifecycle>();

    const tickDeadlineFor = (workload: IngestionWorkload): number =>
      options.tickDeadlineMs?.[workload] ?? defaultTickDeadlineMs(intervals[workload] ?? 0);

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

    // Per-workload in-flight guard. Ticks are fired by `setInterval`, so a
    // tick that runs longer than its interval would otherwise overlap the next
    // one and pile up. A tick that finds the previous run of the same workload
    // still going is skipped and counted.
    //
    // A run that outlives its deadline (see `tickDeadlineMs`) no longer holds
    // the flag: the next tick logs `ingestion_tick_deadline_exceeded`, drops
    // the stale run's claim and starts a fresh one. Provider requests carry
    // their own timeout, so this only fires when something else hangs (a
    // bridge call, a store). Without it one hung run would stop the workload
    // until the pod restarts.
    const inFlight = new Map<
      IngestionWorkload,
      { readonly startedAt: number; readonly run: number }
    >();
    let runCounter = 0;
    const runRefresh = (workload: IngestionWorkload, refresh: () => Promise<void>): void => {
      const current = inFlight.get(workload);
      if (current !== undefined) {
        const runningMs = Math.max(0, this.#clock() - current.startedAt);
        const deadlineMs = tickDeadlineFor(workload);
        if (runningMs < deadlineMs) {
          this.#metrics.recordTickSkippedInFlight(workload);
          this.#log({
            event: 'ingestion_tick_skipped_in_flight',
            provider: this.#provider,
            workload,
            runningMs,
          });
          return;
        }
        this.#metrics.recordTickDeadlineExceeded(workload);
        this.#log({
          event: 'ingestion_tick_deadline_exceeded',
          provider: this.#provider,
          workload,
          runningMs,
          deadlineMs,
        });
        inFlight.delete(workload);
      }
      runCounter += 1;
      const run = runCounter;
      const startedAt = this.#clock();
      inFlight.set(workload, { startedAt, run });
      const settle = (): void => {
        // A run abandoned at its deadline must not clear a newer run's claim.
        if (inFlight.get(workload)?.run === run) {
          inFlight.delete(workload);
        }
        const durationMs = Math.max(0, this.#clock() - startedAt);
        this.#metrics.recordTickDuration(workload, durationMs);
        const interval = intervals[workload] ?? 0;
        if (interval > 0 && durationMs >= interval) {
          this.#log({
            event: 'ingestion_tick_overran',
            provider: this.#provider,
            workload,
            durationMs,
            intervalMs: interval,
          });
        }
      };
      let pending: Promise<void>;
      try {
        pending = refresh();
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending
        .catch((error: unknown) => {
          this.#log({
            event: 'ingestion_tick_error',
            provider: this.#provider,
            workload,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(settle);
    };

    // Upsert discovered/observed fixtures into the live-set + lifecycle map.
    // Status + kickoff drive per-fixture workload ROUTING (see `fixturePhase`):
    // a fixture is only polled by the workload matching its current phase, so
    // the call budget scales with in-play matches, not the 7-day catalogue.
    const upsertFixtures = (records: readonly DiscoveredFixture[], source: string): void => {
      const before = fixtureIds.size;
      const nowMs = this.#clock();
      for (const record of records) {
        const id = record.id.trim();
        if (id === '') {
          continue;
        }
        fixtureIds.add(id);
        const prev = fixtureLifecycle.get(id);
        const status = record.status || prev?.status || '';
        const isFinal = FINAL_FIXTURE_STATUSES.has(status);
        fixtureLifecycle.set(id, {
          status,
          kickoffMs: Number.isFinite(record.kickoffMs)
            ? record.kickoffMs
            : (prev?.kickoffMs ?? Number.NaN),
          // Stamp the first final sighting and preserve it; clear if a fixture
          // somehow leaves a final status (it should not, but stay defensive).
          finalSinceMs: isFinal ? (prev?.finalSinceMs ?? nowMs) : undefined,
          lastSeenMs: nowMs,
        });
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

    // Routing: partition the tracked set by lifecycle phase. Each polling
    // workload fetches ONLY the fixtures in its phase(s), so a fixture that is
    // days away, finished, or postponed is never live-polled.
    const idsInPhase = (...phases: readonly FixturePhase[]): readonly string[] => {
      const nowMs = this.#clock();
      const wanted = new Set(phases);
      const out: string[] = [];
      for (const id of fixtureIds) {
        if (wanted.has(fixturePhase(fixtureLifecycle.get(id), nowMs))) {
          out.push(id);
        }
      }
      return out;
    };
    // Bootstrap fixtures (deterministic staging smoke) are force-included in the
    // boot fetch regardless of phase; on prod the bootstrap set is empty.
    const withBootstrap = (ids: readonly string[]): readonly string[] => [
      ...new Set([...ids, ...bootstrapFixtureIds]),
    ];

    // Drop settled fixtures (finished + past the post-final window, postponed, or
    // kickoff long gone) so the in-memory set stays bounded over long uptimes
    // instead of growing forever the way the old append-only path did.
    const pruneSettledFixtures = (): void => {
      const nowMs = this.#clock();
      let pruned = 0;
      // Deleting the current element from a Set during `for...of` is safe (the
      // iterator is live and visits each member once in insertion order).
      for (const id of fixtureIds) {
        if (fixturePhase(fixtureLifecycle.get(id), nowMs) === 'settled') {
          fixtureIds.delete(id);
          fixtureLifecycle.delete(id);
          fixtureTeamIds.delete(id);
          pruned += 1;
        }
      }
      if (pruned > 0) {
        this.#log({
          event: 'ingestion_fixtures_pruned',
          provider: this.#provider,
          pruned,
          total: fixtureIds.size,
        });
      }
    };

    // Discovery sweep that populates the live polling set (`fixtureIds`). Runs
    // hourly on its own tick AND once at boot (see the unconditional seed at the
    // end of `start`) so a restart re-establishes the in-flight fixture set.
    const discoverFixtures = async (): Promise<void> => {
      // Sweep EVERY competition in the catalogue, not just the first. The
      // fixture-sync paths line up 1:1 with `LIVE_INGESTION_COMPETITIONS`,
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
      // failure (quota/provider error) from the rest of the sweep. The fixture
      // list includes LIVE games (`isDiscoverableFixture`), so this also
      // re-adopts in-play matches after a restart.
      const paths = apiFootballFixtureSyncPaths();
      await Promise.allSettled(
        LIVE_INGESTION_COMPETITIONS.map(async (competition, index) => {
          const path = paths[index];
          if (path === undefined) {
            return;
          }
          const result = await this.fetchWorkload({
            workload: 'fixtures-next-7d',
            resourceId: apiFootballCompetitionKey(competition),
            path,
            priority: LOOP_WORKLOAD_PRIORITY['fixtures-next-7d'],
          });
          upsertFixtures(
            fixtureLifecycleFromFixtureList(result.data, this.#clock()),
            'fixtures-next-7d'
          );
        })
      );
      // Drop settled fixtures so the in-memory set stays bounded over long
      // uptimes instead of growing forever.
      pruneSettledFixtures();
    };
    enqueueTick('fixtures-next-7d', discoverFixtures);

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
      const priority: ProviderPriority = LOOP_WORKLOAD_PRIORITY[workload];
      // Bounded fan-out (was an unbounded `Promise.allSettled(ids.map(...))`):
      // cap simultaneous in-flight provider calls so a busy slot spreads its
      // requests instead of bursting them all and tripping the per-minute limit.
      await mapWithConcurrency(ids, MAX_PROVIDER_FANOUT, async (id) => {
        const result = await this.fetchWorkload({
          workload,
          resourceId: id,
          priority,
        });
        if (FIXTURE_DETAIL_WORKLOADS.has(workload) && result.data !== undefined) {
          const teamIds = teamIdsFromFixtureDetail(result.data);
          if (teamIds.length > 0) {
            fixtureTeamIds.set(id, teamIds);
          }
          const statusShort = statusShortFromFixtureDetail(result.data);
          // Keep the lifecycle phase fresh from the live payload so an
          // NS->1H->FT transition re-routes the fixture immediately, instead of
          // waiting for the next hourly discovery sweep.
          if (statusShort !== '') {
            upsertFixtures([{ id, status: statusShort, kickoffMs: Number.NaN }], workload);
          }
          // Match-stats sidecar: a live (or just-finished) fixture-detail tick
          // is the trigger to refresh team + player match stats for the same
          // fixture. The provider exposes `/fixtures/statistics` +
          // `/fixtures/players` only for in-play / finished fixtures, so this
          // is gated on the detail payload's status. The short stats TTL keeps
          // the live numbers fresh without re-spending budget every 30s tick;
          // the bridge (`onFixtureFetched`) owns the canonical ingest into
          // game-service. Skipped for pre-kickoff fixtures (empty payload).
          if (STATS_FETCH_FIXTURE_STATUSES.has(statusShort)) {
            await fetchMatchStatsForFixture(id, priority);
          }
        }
        if (workload === 'lineups-post-confirm' && lineupsMissing(result.data)) {
          let teamIds = fixtureTeamIds.get(id) ?? [];
          if (teamIds.length === 0) {
            const fixtureDetail = await this.fetchWorkload({
              workload: 'fixture-detail-fullTime',
              resourceId: id,
              priority: LOOP_WORKLOAD_PRIORITY['fixture-detail-fullTime'],
            });
            teamIds = teamIdsFromFixtureDetail(fixtureDetail.data);
            if (teamIds.length > 0) {
              fixtureTeamIds.set(id, teamIds);
            }
          }
          await fetchSquadFallbacksForFixture(id, teamIds);
        }
      });
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
            priority: LOOP_WORKLOAD_PRIORITY['squad-list-fallback'],
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
    // The sidecar inherits the class of the tick that triggered it: `live`
    // from the live tick, `near-live` from the full-time tick.
    const fetchMatchStatsForFixture = async (
      fixtureId: string,
      priority: ProviderPriority
    ): Promise<void> => {
      await Promise.allSettled([
        this.fetchWorkload({ workload: 'team-match-stats', resourceId: fixtureId, priority }),
        this.fetchWorkload({ workload: 'player-match-stats', resourceId: fixtureId, priority }),
      ]);
    };

    enqueueTick(
      'fixture-detail-preKO',
      async () => {
        await fetchFixtureWorkload('fixture-detail-preKO', idsInPhase('preKO'));
      },
      async () => {
        await fetchFixtureWorkload('fixture-detail-preKO', withBootstrap(idsInPhase('preKO')));
      }
    );
    enqueueTick(
      'fixture-detail-live',
      async () => {
        await fetchFixtureWorkload('fixture-detail-live', idsInPhase('live'));
      },
      async () => {
        await fetchFixtureWorkload('fixture-detail-live', withBootstrap(idsInPhase('live')));
      }
    );
    enqueueTick(
      'fixture-detail-fullTime',
      async () => {
        await fetchFixtureWorkload('fixture-detail-fullTime', idsInPhase('postFinal'));
      },
      async () => {
        await fetchFixtureWorkload(
          'fixture-detail-fullTime',
          withBootstrap(idsInPhase('postFinal'))
        );
      }
    );
    enqueueTick(
      'events-post-final',
      async () => {
        await fetchFixtureWorkload('events-post-final', idsInPhase('postFinal'));
      },
      async () => {
        await fetchFixtureWorkload('events-post-final', withBootstrap(idsInPhase('postFinal')));
      }
    );
    enqueueTick(
      'lineups-post-confirm',
      async () => {
        await fetchFixtureWorkload('lineups-post-confirm', idsInPhase('preKO', 'postFinal'));
      },
      async () => {
        await fetchFixtureWorkload(
          'lineups-post-confirm',
          withBootstrap(idsInPhase('preKO', 'postFinal'))
        );
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
              priority: LOOP_WORKLOAD_PRIORITY['team-metadata'],
            })
          )
        );
      });
    }

    this.#timers.push(...stopHandles);

    // Resilience: ALWAYS re-establish the in-flight fixture set at boot. The
    // recurring fixture-detail ticks poll `fixtureIds`, which is in-memory and
    // otherwise empty until the hourly `fixtures-next-7d` sweep first fires. So
    // a worker restart (deploy / crash) with `runImmediately=false` would leave
    // every in-play game frozen for up to an hour — or permanently if pods
    // recycle faster than hourly. The discovery list includes LIVE games, so
    // this lets gamewire pick back up the matches already in flight within one
    // `fixture-detail-live` tick. When `runImmediately` is on, the tick's own
    // immediate refresh already ran it, so only seed here when it's off.
    if (!options.runImmediately) {
      runRefresh('fixtures-next-7d', discoverFixtures);
    }

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounded: the bridge runs inside the merged fetch, so a hung bridge
      // call (a stalled Redis publish, a stuck RPC) would hold the merge and
      // the tick open. Past the deadline the bridge keeps running on its own
      // and the fetch returns.
      const timedOut = Symbol('bridge-timeout');
      const outcome = await Promise.race([
        Promise.resolve(this.#onFixtureFetched({ workload, resourceId, data })),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), this.#bridgeTimeoutMs);
        }),
      ]);
      if (outcome === timedOut) {
        this.#log({
          event: 'ingestion_bridge_timeout',
          provider: this.#provider,
          workload,
          resourceId,
          timeoutMs: this.#bridgeTimeoutMs,
        });
      }
    } catch (error) {
      this.#log({
        event: 'ingestion_bridge_error',
        provider: this.#provider,
        workload,
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
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
  //
  // `provider-fixture-results` is deliberately NOT a member of this set.
  // PF-GW1 fetches reference-set leagues and seasons the catalogue does not
  // cover (profile-spec.md §2.3, ADR-053): running its list payload through
  // `ingestFixtureList` would mint canonical `games` rows and
  // `provider_game_mappings` crosswalk entries for leagues/seasons BTL does
  // not catalogue, which the spec forbids this workflow from ever doing.
  // It must also stay out of the asset-mirror bridge for the same reason
  // (both bridges are driven off this one set, see `#notifyFixtureFetched`).
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

// Final (played-to-completion) statuses. A fixture is post-final-polled for a
// short window after the first final sighting, then settles out of the set.
const FINAL_FIXTURE_STATUSES = new Set(['FT', 'AET', 'PEN']);

// Terminal non-played statuses. These never produce a live timeline, so they are
// dropped from the polling set immediately.
const TERMINAL_NO_PLAY_STATUSES = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);

// Per-fixture workload ROUTING windows. A fixture is only polled by the workload
// matching its lifecycle phase (see `fixturePhase`), so the provider call budget
// scales with the handful of matches actually near kickoff / in play, NOT the
// full 7-day discovery catalogue.
const PRE_KICKOFF_LEAD_MS = 90 * 60 * 1_000; // pre-KO polling starts 90m out (lineups land ~60m before)
const KICKOFF_GRACE_MS = 5 * 60 * 1_000; // adopt into the live set 5m before KO to catch the in-play flip
const MAX_LIVE_WINDOW_MS = 3.5 * 60 * 60 * 1_000; // stop live-polling an un-flipped fixture 3.5h after KO (covers ET+pens; bounds no-shows)
const POST_FINAL_WINDOW_MS = 25 * 60 * 1_000; // keep polling final/lineups for 25m after FT, then settle

// Max simultaneous in-flight provider fetches per workload tick. Caps the
// instantaneous burst so a busy slot (many concurrent kickoffs) spreads its
// calls instead of firing them all at once and tripping the per-minute limit.
const MAX_PROVIDER_FANOUT = 6;

type FixturePhase = 'live' | 'preKO' | 'postFinal' | 'upcoming' | 'settled';

interface FixtureLifecycle {
  /** Provider status short code (e.g. NS, 1H, FT), upper-cased. */
  readonly status: string;
  /** Scheduled kickoff epoch ms (NaN when undated). */
  readonly kickoffMs: number;
  /** First epoch ms we observed a final status (drives the post-final window). */
  readonly finalSinceMs?: number;
  /** Last tick that referenced this fixture. */
  readonly lastSeenMs: number;
}

interface DiscoveredFixture {
  readonly id: string;
  readonly status: string;
  readonly kickoffMs: number;
}

/**
 * Classify a fixture into the workload phase that should poll it. This is the
 * single source of routing truth: live ticks poll `live`, the pre-KO tick polls
 * `preKO`, the full-time/lineup ticks poll `postFinal`. `upcoming` (far-future)
 * and `settled` (finished + windowed-out, postponed, or kickoff long gone) are
 * NEVER polled, which is what bounds the daily call budget.
 */
function fixturePhase(rec: FixtureLifecycle | undefined, nowMs: number): FixturePhase {
  if (!rec) {
    return 'settled';
  }
  const { status, kickoffMs, finalSinceMs } = rec;
  if (LIVE_FIXTURE_STATUSES.has(status)) {
    return 'live';
  }
  if (FINAL_FIXTURE_STATUSES.has(status)) {
    return nowMs <= (finalSinceMs ?? nowMs) + POST_FINAL_WINDOW_MS ? 'postFinal' : 'settled';
  }
  if (TERMINAL_NO_PLAY_STATUSES.has(status)) {
    return 'settled';
  }
  // Scheduled / NS / TBD / unknown: route by the kickoff clock so a fixture is
  // adopted into the live set right at kickoff, even before the provider flips
  // its status to 1H.
  if (Number.isFinite(kickoffMs)) {
    if (nowMs > kickoffMs + MAX_LIVE_WINDOW_MS) {
      return 'settled';
    }
    if (nowMs >= kickoffMs - KICKOFF_GRACE_MS) {
      return 'live';
    }
    if (nowMs >= kickoffMs - PRE_KICKOFF_LEAD_MS) {
      return 'preKO';
    }
  }
  return 'upcoming';
}

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
    case 'competition-current-season':
      return apiFootballLeaguePath(currentSeasonResourceLeagueId(resourceId));
    case 'team-metadata':
      return `/teams?id=${encodeURIComponent(resourceId)}`;
    case 'provider-fixture-results':
      // PF-GW1's workflow always passes an explicit `options.path`
      // (`seasonFixturesPath`/`nightlyFixturesPath`), so this fallback is
      // never reached in practice; it exists only so the switch stays
      // exhaustive over `IngestionWorkload`.
      return '/fixtures';
    case 'player-season-stats': {
      const match = /^players-(\d+)-(\d+)-(\d+)$/.exec(resourceId.trim());
      return match
        ? apiFootballPlayerSeasonStatsPath(Number(match[1]), Number(match[2]), Number(match[3]))
        : '/players';
    }
    // GW-6b: the provider-enrichment workflow always passes `path`; these
    // fallbacks only shape a direct call by resource id.
    case 'injuries-league': {
      const match = /^injuries-(\d+)-(\d+)$/.exec(resourceId.trim());
      return match
        ? apiFootballInjuriesLeaguePath(Number(match[1]), Number(match[2]))
        : '/injuries';
    }
    case 'player-sidelined':
      return apiFootballSidelinedPath(resourceId.trim().split('-').filter(Boolean));
    case 'team-transfers':
      return apiFootballTransfersPath(resourceId.trim());
    case 'trophies':
      return apiFootballTrophiesPath('player', resourceId.trim().split('-').filter(Boolean));
    case 'team-season-stats': {
      const match = /^team-stats-(\d+)-(\d+)-(\d+)$/.exec(resourceId.trim());
      return match
        ? apiFootballTeamStatisticsPath(Number(match[1]), Number(match[2]), match[3] ?? '')
        : '/teams/statistics';
    }
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

/**
 * Parse a `current-season-<leagueId>` resource id back into its provider league
 * id. Used only by the direct-call path fallback in {@link apiFootballPathFor};
 * the daily-anchor sweep passes an explicit path, so this reconstructs the id
 * for any operator one-shot that calls `fetchWorkload({ workload:
 * 'competition-current-season', resourceId })` without a path. Returns an empty
 * string for a malformed id; the provider call then 4xxs and the fetch records
 * a failure rather than silently hitting the wrong league.
 */
function currentSeasonResourceLeagueId(resourceId: string): string {
  const match = /^current-season-(\d+)$/.exec(resourceId.trim());
  return match?.[1] ?? '';
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

function fixtureKickoffMs(fixture: Record<string, unknown>): number {
  const rawDate = fixture.date;
  if (typeof rawDate !== 'string' || rawDate.trim() === '') {
    return Number.NaN;
  }
  return Date.parse(rawDate);
}

/**
 * Parse a `/fixtures` LIST envelope into per-fixture lifecycle records (id +
 * status + kickoff), filtered to the discovery window. Parallel to
 * `fixtureIdsFromFixtureList`, but carries the status + kickoff that drive
 * per-fixture workload routing instead of just the id.
 */
function fixtureLifecycleFromFixtureList(
  data: unknown,
  nowMs: number
): readonly DiscoveredFixture[] {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const out = new Map<string, DiscoveredFixture>();
  for (const item of data.response) {
    if (!isRecord(item) || !isRecord(item.fixture)) {
      continue;
    }
    const fixture = item.fixture;
    const id = providerGameIdFromFixture(fixture);
    if (id === '' || !isDiscoverableFixture(fixture, nowMs)) {
      continue;
    }
    const status = isRecord(fixture.status) ? String(fixture.status.short ?? '').toUpperCase() : '';
    out.set(id, { id, status, kickoffMs: fixtureKickoffMs(fixture) });
  }
  return [...out.values()];
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Replaces the
 * unbounded `Promise.allSettled(ids.map(...))` fan-out so a busy slot spreads
 * its provider calls instead of bursting them all simultaneously. Per-item
 * throws are swallowed: one bad fetch must never wedge the tick.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      try {
        await fn(item);
      } catch {
        // Isolated per-item failure; the loop must never wedge on one fetch.
      }
    }
  });
  await Promise.all(workers);
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

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

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
  fixtureLifecycleFromFixtureList,
  fixturePhase,
  lineupsMissing,
  mapWithConcurrency,
  squadListResourceId,
  teamIdsFromFixtureDetail,
  SECONDS_TO_MS,
};
