import { describe, expect, it, vi } from 'vitest';

import { InMemoryProviderCache } from './cache.js';
import type { GamewireWorkerConfig } from './config.js';
import {
  ApiFootballIngestionLoop,
  LAST_GOOD_TTL_SECONDS,
  LOOP_WORKLOAD_PRIORITY,
  type IngestionFetchOptions,
} from './ingestion.js';
import {
  InMemoryMinuteCounterStore,
  ProviderMinuteLimiter,
  type ProviderMinuteCaps,
} from './minute-limiter.js';
import type { ProviderFetch } from './provider-http.js';
import { ProviderQuotaTracker } from './quota.js';

const config: GamewireWorkerConfig = {
  port: 8095,
  gameServiceUrl: 'http://game-service:9090',
  identityServiceUrl: 'http://identity:9090',
  providerId: 'api-football',
  providerKind: 'football',
  providerMode: 'live',
  providerBaseUrl: 'https://provider.example.test',
  providerApiKey: 'sample-test-key',
  identityProviderId: 'identity-data-football',
  webhookPath: '/webhooks/gamewire',
  logLevel: 'info',
  redisNamespace: 'gamewire',
  providerHardCap: 100,
  providerSoftCap: 90,
  ingestionEnabled: true,
  bootstrapFixtureIds: [],
  ingestionRunImmediateTick: false,
  authContextJwksUrl: 'https://auth.test/.well-known/jwks.json',
  authContextIssuer: 'auth-service-test',
  authContextAudience: 'gamewire-worker',
  authContextRequiredScope: 'gamewire.workflow.invoke',
  assetMirror: { region: 'auto' },
};

const MINUTE = 60_000;
const T0 = 29_000_000 * MINUTE;

const quiet = () => undefined;

const makeClock = (start: number) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const fetchMock = (
  payload: unknown = { response: [{ fixture: { id: 1, status: { short: '1H' } } }] },
  headers: Record<string, string> = {}
) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type'
          ? 'application/json'
          : (headers[name.toLowerCase()] ?? null),
    },
    json: async () => payload,
  }) as unknown as ProviderFetch & { mock: ReturnType<typeof vi.fn>['mock'] };

interface Harness {
  readonly loop: ApiFootballIngestionLoop;
  readonly clock: ReturnType<typeof makeClock>;
  readonly store: InMemoryMinuteCounterStore;
  readonly limiter: ProviderMinuteLimiter;
  readonly quota: ProviderQuotaTracker;
  readonly fetchFn: ReturnType<typeof fetchMock>;
  readonly sleep: ReturnType<typeof vi.fn>;
  readonly bridge: ReturnType<typeof vi.fn>;
  readonly logs: Record<string, unknown>[];
}

const harness = (
  input: {
    readonly caps?: Partial<ProviderMinuteCaps>;
    readonly quota?: ProviderQuotaTracker;
    readonly fetchFn?: ReturnType<typeof fetchMock>;
    readonly sleepAdvancesClock?: boolean;
    readonly cfg?: GamewireWorkerConfig;
    readonly start?: number;
  } = {}
): Harness => {
  const clock = makeClock(input.start ?? T0);
  const store = new InMemoryMinuteCounterStore({ clock: clock.now });
  const limiter = new ProviderMinuteLimiter({
    providerId: 'api-football',
    caps: { live: 4, 'near-live': 3, background: 2, ...input.caps },
    store,
    clock: clock.now,
  });
  const quota =
    input.quota ??
    new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 100,
      softCap: 90,
      clock: () => new Date(clock.now()),
    });
  const fetchFn = input.fetchFn ?? fetchMock();
  const sleep = vi.fn(async (ms: number) => {
    if (input.sleepAdvancesClock) {
      clock.advance(ms);
    }
  });
  const bridge = vi.fn();
  const logs: Record<string, unknown>[] = [];
  const loop = new ApiFootballIngestionLoop({
    config: input.cfg ?? config,
    cache: new InMemoryProviderCache({ clock: clock.now }),
    quota,
    minuteLimiter: limiter,
    fetchFn,
    clock: clock.now,
    sleep,
    onFixtureFetched: bridge,
    logger: (entry) => logs.push(entry),
  });
  return { loop, clock, store, limiter, quota, fetchFn, sleep, bridge, logs };
};

const bucket = (h: Harness) => h.store.read(h.limiter.keyFor(Math.floor(h.clock.now() / MINUTE)));

describe('live minute deny serves the last-good payload', () => {
  it('writes a separate last-good key for live fetches only', async () => {
    const h = harness();
    await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
      priority: 'live',
    });
    await h.loop.fetchWorkload({
      workload: 'fixture-detail-preKO',
      resourceId: '2',
      priority: 'near-live',
    });
    const liveKey = h.loop.cacheKeyFor('fixture-detail-live', '1');
    const preKey = h.loop.cacheKeyFor('fixture-detail-preKO', '2');
    expect(await h.loop.cache.get(h.loop.lastGoodKeyFor(liveKey))).toBeDefined();
    expect(await h.loop.cache.get(h.loop.lastGoodKeyFor(preKey))).toBeUndefined();
    // The last-good copy outlives the 30s workload TTL.
    h.clock.advance(31_000);
    expect(await h.loop.cache.get(liveKey)).toBeUndefined();
    expect(await h.loop.cache.get(h.loop.lastGoodKeyFor(liveKey))).toBeDefined();
    h.clock.advance(LAST_GOOD_TTL_SECONDS * 1_000);
    expect(await h.loop.cache.get(h.loop.lastGoodKeyFor(liveKey))).toBeUndefined();
  });

  it('returns the stale payload, counts the throttle, and does not re-run the bridge', async () => {
    const h = harness({ caps: { live: 1, 'near-live': 1, background: 1 } });
    const first = await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
      priority: 'live',
    });
    expect(first.status).toBe('fetched');
    expect(h.bridge).toHaveBeenCalledTimes(1);

    // Primary entry expired, same minute, bucket full.
    h.clock.advance(31_000);
    const second = await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
      priority: 'live',
    });
    expect(second.status).toBe('cached');
    expect(second.stale).toBe(true);
    expect(second.throttled).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(second.fallbackReason).toBe('PROVIDER_RATE_LIMITED');
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.bridge).toHaveBeenCalledTimes(1);
    // Live never waits.
    expect(h.sleep).not.toHaveBeenCalled();
    // No daily quota spent on the denied call.
    expect((await h.quota.snapshot()).calls).toBe(1);

    const metrics = h.loop.metrics.snapshot();
    expect(metrics.providerMinuteThrottled).toEqual({ 'fixture-detail-live': 1 });
    expect(metrics.providerStaleServed).toEqual({ 'fixture-detail-live': 1 });
    expect(metrics.callOutcomes.throttled).toBe(1);
    expect(h.logs.some((entry) => entry.event === 'provider_minute_throttled')).toBe(true);
  });

  it('reports rate_limited when there is no last-good payload', async () => {
    const h = harness({ caps: { live: 1, 'near-live': 1, background: 1 } });
    await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
      priority: 'live',
    });
    const other = await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '2',
      priority: 'live',
    });
    expect(other.status).toBe('rate_limited');
    expect(other.throttled).toBe(true);
    expect(other.stale).toBeUndefined();
    expect(other.fallbackReason).toBe('PROVIDER_RATE_LIMITED');
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(await h.loop.cache.get(other.cacheKey)).toBeUndefined();
  });
});

describe('near-live and background wait and retry once', () => {
  it('waits for the limiter, retries, and fetches when room opened', async () => {
    const h = harness({
      caps: { live: 3, 'near-live': 2, background: 2 },
      sleepAdvancesClock: true,
      start: T0 + 50_000,
    });
    for (const league of ['39', '140']) {
      await h.loop.fetchWorkload({
        workload: 'competition-standings',
        resourceId: `standings-${league}-2026`,
        priority: 'background',
      });
    }
    const third = await h.loop.fetchWorkload({
      workload: 'competition-standings',
      resourceId: 'standings-135-2026',
      priority: 'background',
    });
    expect(h.sleep).toHaveBeenCalledTimes(1);
    // 10s to the boundary, then half a minute for the full bucket to decay
    // to 1 of 2.
    expect(h.sleep.mock.calls[0]?.[0]).toBe(40_000);
    expect(third.status).toBe('fetched');
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    expect(h.logs.some((entry) => entry.event === 'provider_minute_wait')).toBe(true);
  });

  it('gives up after one retry and reports rate_limited', async () => {
    const h = harness({ caps: { live: 2, 'near-live': 1, background: 1 } });
    await h.loop.fetchWorkload({
      workload: 'fixture-detail-preKO',
      resourceId: '1',
      priority: 'near-live',
    });
    const second = await h.loop.fetchWorkload({
      workload: 'fixture-detail-preKO',
      resourceId: '2',
      priority: 'near-live',
    });
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('rate_limited');
    expect(second.throttled).toBe(true);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.loop.metrics.snapshot().providerMinuteThrottled).toEqual({
      'fixture-detail-preKO': 1,
    });
  });

  it('background stops below the ceiling that live still has', async () => {
    const h = harness({ caps: { live: 3, 'near-live': 2, background: 1 } });
    const results = [];
    for (const id of ['a', 'b']) {
      results.push(
        await h.loop.fetchWorkload({
          workload: 'team-match-stats',
          resourceId: id,
          priority: 'background',
        })
      );
    }
    expect(results.map((r) => r.status)).toEqual(['fetched', 'rate_limited']);
    const live = await h.loop.fetchWorkload({
      workload: 'team-match-stats',
      resourceId: 'c',
      priority: 'live',
    });
    expect(live.status).toBe('fetched');
  });
});

describe('limiter and daily quota together', () => {
  it('returns the minute token when the daily quota denies the call', async () => {
    const quota = new ProviderQuotaTracker({ provider: 'api-football', hardCap: 1, softCap: 1 });
    const h = harness({ quota });
    await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
      priority: 'live',
    });
    const denied = await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '2',
      priority: 'live',
    });
    expect(denied.status).toBe('denied');
    expect(await bucket(h)).toBe(1);
  });

  it('returns the minute token and the quota when the call is skipped', async () => {
    const h = harness({ cfg: { ...config, providerMode: 'replay' } });
    const skipped = await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
      priority: 'live',
    });
    expect(skipped.status).toBe('skipped');
    expect(await bucket(h)).toBe(0);
    expect((await h.quota.snapshot()).calls).toBe(0);
  });

  it('refuses background at the background daily cap and keeps serving live', async () => {
    const quota = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 8,
      backgroundDailyCap: 1,
    });
    const h = harness({ quota });
    expect(
      (
        await h.loop.fetchWorkload({
          workload: 'fixture-detail-fullTime',
          resourceId: '1',
          priority: 'background',
        })
      ).status
    ).toBe('fetched');
    const denied = await h.loop.fetchWorkload({
      workload: 'fixture-detail-fullTime',
      resourceId: '2',
      priority: 'background',
    });
    expect(denied.status).toBe('denied');
    expect(denied.error?.message).toContain('background_cap');
    expect(denied.quota.backgroundCapReached).toBe(true);
    const live = await h.loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '2',
      priority: 'live',
    });
    expect(live.status).toBe('fetched');
  });
});

describe('provider header sync', () => {
  it('feeds the daily headers to the quota and the minute header to the limiter', async () => {
    const clock = makeClock(T0 + 5_000);
    const quota = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 140_000,
      softCap: 130_000,
      backgroundDailyCap: 110_000,
      quotaSource: 'provider-header',
      clock: () => new Date(clock.now()),
    });
    const fetchFn = fetchMock(undefined, {
      'x-ratelimit-requests-limit': '150000',
      'x-ratelimit-requests-remaining': '30000',
      'x-ratelimit-limit': '900',
      'x-ratelimit-remaining': '40',
    });
    const store = new InMemoryMinuteCounterStore({ clock: clock.now });
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store,
      clock: clock.now,
    });
    const sleep = vi.fn(async () => undefined);
    const loop = new ApiFootballIngestionLoop({
      config,
      cache: new InMemoryProviderCache({ clock: clock.now }),
      quota,
      minuteLimiter: limiter,
      fetchFn,
      clock: clock.now,
      sleep,
      logger: quiet,
    });
    await loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
      priority: 'live',
    });
    const snapshot = await quota.snapshot();
    expect(snapshot.remoteCalls).toBe(120_000);
    expect(snapshot.calls).toBe(120_000);
    // Background is now past its daily cap and the provider says 40 left
    // this minute: it is refused.
    const background = await loop.fetchWorkload({
      workload: 'team-metadata',
      resourceId: '33',
      priority: 'background',
    });
    expect(background.status).toBe('rate_limited');
    expect(background.throttled).toBe(true);
    // Live still goes.
    const live = await loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '2',
      priority: 'live',
    });
    expect(live.status).toBe('fetched');
  });
});

describe('loop priorities', () => {
  it('the polling loop passes its own class for every call it makes', () => {
    expect(LOOP_WORKLOAD_PRIORITY).toEqual({
      'fixtures-next-7d': 'near-live',
      'fixture-detail-preKO': 'near-live',
      'fixture-detail-live': 'live',
      'fixture-detail-fullTime': 'near-live',
      'events-post-final': 'near-live',
      'lineups-post-confirm': 'near-live',
      'squad-list-fallback': 'background',
      'team-metadata': 'background',
    });
  });

  it('runs the live tick and its stats sidecar as live, discovery as near-live', async () => {
    const h = harness({
      caps: { live: 800, 'near-live': 650, background: 450 },
      fetchFn: fetchMock({
        response: [{ fixture: { id: 77, status: { short: '2H' } }, teams: {} }],
      }),
    });
    const seen: Array<Pick<IngestionFetchOptions, 'workload' | 'priority'>> = [];
    const original = h.loop.fetchWorkload.bind(h.loop);
    vi.spyOn(h.loop, 'fetchWorkload').mockImplementation(async (options) => {
      seen.push({ workload: options.workload, priority: options.priority });
      return original(options);
    });
    const stop = h.loop.start({
      bootstrapFixtureIds: ['77'],
      runImmediately: true,
      intervals: {
        'fixtures-next-7d': 1_000,
        'fixture-detail-preKO': 0,
        'fixture-detail-live': 1_000,
        'fixture-detail-fullTime': 0,
        'events-post-final': 0,
        'lineups-post-confirm': 0,
      },
      schedule: () => 'h',
      cancel: () => undefined,
    });
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    stop();
    const classOf = (workload: string) =>
      new Set(seen.filter((s) => s.workload === workload).map((s) => s.priority));
    expect(classOf('fixture-detail-live')).toEqual(new Set(['live']));
    expect(classOf('team-match-stats')).toEqual(new Set(['live']));
    expect(classOf('player-match-stats')).toEqual(new Set(['live']));
    expect(classOf('fixtures-next-7d')).toEqual(new Set(['near-live']));
  });
});

describe('tick in-flight guard and duration metric', () => {
  it('skips a tick while the previous one of the same workload is running', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ response: [] }),
      };
    }) as unknown as ProviderFetch;
    const clock = makeClock(T0);
    const logs: Record<string, unknown>[] = [];
    const loop = new ApiFootballIngestionLoop({
      config,
      fetchFn,
      clock: clock.now,
      logger: (entry) => logs.push(entry),
    });
    const callbacks = new Map<number, () => void>();
    let index = 0;
    loop.start({
      teamIds: ['t1'],
      intervals: {
        'fixtures-next-7d': 0,
        'fixture-detail-preKO': 0,
        'fixture-detail-live': 0,
        'fixture-detail-fullTime': 0,
        'events-post-final': 0,
        'lineups-post-confirm': 0,
        'team-metadata': 1_000,
      },
      schedule: (callback) => {
        callbacks.set(index, callback);
        index += 1;
        return index;
      },
      cancel: () => undefined,
    });
    const tick = callbacks.get(0);
    expect(tick).toBeDefined();
    tick?.();
    tick?.();
    expect(loop.metrics.snapshot().tickSkippedInFlight).toEqual({ 'team-metadata': 1 });
    expect(logs.some((entry) => entry.event === 'ingestion_tick_skipped_in_flight')).toBe(true);

    clock.advance(1_500);
    release?.();
    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const durations = loop.metrics.snapshot().tickDurationMs['team-metadata'];
    expect(durations?.count).toBe(1);
    expect(durations?.lastMs).toBe(1_500);
    // Longer than its 1s interval: logged as an overrun.
    expect(logs.some((entry) => entry.event === 'ingestion_tick_overran')).toBe(true);

    // Once settled the next tick runs again.
    tick?.();
    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(loop.metrics.snapshot().tickSkippedInFlight).toEqual({ 'team-metadata': 1 });
    expect(loop.metrics.snapshot().tickDurationMs['team-metadata']?.count).toBe(2);
  });
});
