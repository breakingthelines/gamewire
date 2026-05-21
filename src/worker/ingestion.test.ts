import { describe, expect, it, vi } from 'vitest';

import { InMemoryProviderCache } from './cache.js';
import type { GamewireWorkerConfig } from './config.js';
import {
  ApiFootballIngestionLoop,
  INGESTION_TICK_INTERVAL_MS,
  INGESTION_TTL_SECONDS,
  PROVIDER_ID,
  __test as ingestionTest,
} from './ingestion.js';
import { IngestionMetrics } from './metrics.js';
import type { ProviderFetch } from './provider-http.js';
import { InMemoryQuotaStore, ProviderQuotaTracker } from './quota.js';
import { Singleflight } from './singleflight.js';

const baseConfig: GamewireWorkerConfig = {
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
  providerHardCap: 5,
  providerSoftCap: 3,
  ingestionEnabled: true,
  bootstrapFixtureIds: [],
  ingestionRunImmediateTick: true,
};

const replayConfig: GamewireWorkerConfig = {
  ...baseConfig,
  providerMode: 'replay',
  ingestionEnabled: false,
  providerApiKey: undefined,
};

const buildFetchMock = (
  payload: unknown
): ProviderFetch & { mock: ReturnType<typeof vi.fn>['mock'] } =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => payload,
  }) as unknown as ProviderFetch & { mock: ReturnType<typeof vi.fn>['mock'] };

// Quiet logger keeps the test output clean; production wires through the
// structured default logger.
const quietLogger = () => undefined;

describe('ApiFootballIngestionLoop.fetchWorkload', () => {
  it('exports the API-Football provider id', () => {
    expect(PROVIDER_ID).toBe('api-football');
  });

  it('exposes the documented TTL table verbatim', () => {
    expect(INGESTION_TTL_SECONDS).toEqual({
      'fixtures-next-7d': 6 * 60 * 60,
      'fixture-detail-preKO': 60 * 60,
      'fixture-detail-live': 30,
      'fixture-detail-fullTime': 6 * 60 * 60,
      'events-post-final': 6 * 60 * 60,
      'lineups-post-confirm': 60 * 60,
      'squad-list-fallback': 24 * 60 * 60,
      'team-metadata': 24 * 60 * 60,
      'player-metadata': 24 * 60 * 60,
    });
    expect(INGESTION_TICK_INTERVAL_MS['fixture-detail-live']).toBe(30_000);
  });

  it('fetches once on miss and caches under provider:workload:resource', async () => {
    const fetchFn = buildFetchMock({ response: [{ fixture: { id: 1 } }] });
    const cache = new InMemoryProviderCache();
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      cache,
      fetchFn,
      logger: quietLogger,
    });

    const first = await loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
    });

    expect(first.status).toBe('fetched');
    expect(first.cacheHit).toBe(false);
    expect(first.cacheKey).toBe('api-football:fixture-detail-live:1');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const second = await loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '1',
    });
    expect(second.status).toBe('cached');
    expect(second.cacheHit).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls through singleflight', async () => {
    type StubResponse = {
      readonly ok: true;
      readonly status: number;
      readonly headers: { get: () => null };
      readonly json: () => Promise<unknown>;
    };
    let releaseFetch: ((value: StubResponse) => void) | undefined;
    const fetchSpy = vi.fn().mockImplementation(
      () =>
        new Promise<StubResponse>((resolve) => {
          releaseFetch = resolve;
        })
    );
    const fetchFn = fetchSpy as unknown as ProviderFetch;
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      fetchFn,
      logger: quietLogger,
    });

    const a = loop.fetchWorkload({ workload: 'fixture-detail-live', resourceId: '99' });
    const b = loop.fetchWorkload({ workload: 'fixture-detail-live', resourceId: '99' });
    const c = loop.fetchWorkload({ workload: 'fixture-detail-live', resourceId: '99' });

    // Let the async cache lookups + singleflight bookkeeping run so the
    // leader actually reaches the fetch boundary.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    releaseFetch?.({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ response: [] }),
    });

    await Promise.all([a, b, c]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refunds the quota reservation when a fetch is skipped (replay mode)', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fetchSpy as unknown as ProviderFetch;
    const quota = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 5,
      softCap: 3,
      store: new InMemoryQuotaStore(),
    });
    const loop = new ApiFootballIngestionLoop({
      config: { ...replayConfig, ingestionEnabled: false },
      fetchFn,
      quota,
      logger: quietLogger,
    });

    const result = await loop.fetchWorkload({
      workload: 'fixture-detail-preKO',
      resourceId: '42',
    });

    expect(result.status).toBe('skipped');
    expect(result.fetch?.skipReason).toBe('replay_mode');
    expect(fetchSpy).not.toHaveBeenCalled();
    const snap = await quota.snapshot();
    expect(snap.calls).toBe(0);
  });

  it('denies further provider calls once the hard cap is reached', async () => {
    const store = new InMemoryQuotaStore();
    const quota = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 2,
      softCap: 1,
      store,
    });
    // Pre-fill the quota counter so the next reservation breaches the cap.
    await store.increment(quota.windowFor(), 2);

    const fetchFn = buildFetchMock({ response: [{ fixture: { id: 7 } }] });
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      fetchFn,
      quota,
      logger: quietLogger,
    });

    const result = await loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '7',
    });

    expect(result.status).toBe('denied');
    expect(result.fallbackReason).toBe('PROVIDER_OUTAGE');
    expect(result.cachedOnlyMode).toBe(true);
    expect(result.quota.posture).toBe('hard_cap_reached');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('flags PROVIDER_OUTAGE fallback once the soft cap is crossed', async () => {
    const store = new InMemoryQuotaStore();
    const quota = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 5,
      softCap: 1,
      store,
    });

    const fetchFn = buildFetchMock({ response: [{ fixture: { id: 11 } }] });
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      fetchFn,
      quota,
      logger: quietLogger,
    });

    const result = await loop.fetchWorkload({
      workload: 'fixture-detail-live',
      resourceId: '11',
    });

    expect(result.status).toBe('fetched');
    expect(result.fallbackReason).toBe('PROVIDER_OUTAGE');
    expect(result.cachedOnlyMode).toBe(true);
    expect(result.quota.posture).toBe('soft_cap_reached');
  });

  it('writes cache with the workload TTL on fetched results', async () => {
    const cache = new InMemoryProviderCache();
    const setSpy = vi.spyOn(cache, 'set');
    const fetchFn = buildFetchMock({ response: [{ fixture: { id: 22 } }] });
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      cache,
      fetchFn,
      logger: quietLogger,
    });

    await loop.fetchWorkload({ workload: 'fixtures-next-7d', resourceId: 'top' });
    expect(setSpy).toHaveBeenCalledWith(
      'api-football:fixtures-next-7d:top',
      expect.objectContaining({ response: expect.any(Array) }),
      INGESTION_TTL_SECONDS['fixtures-next-7d']
    );
  });

  it('exposes a metrics + quota snapshot via observe()', async () => {
    const metrics = new IngestionMetrics();
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      metrics,
      quota: new ProviderQuotaTracker({
        provider: 'api-football',
        hardCap: 5,
        softCap: 3,
        store: new InMemoryQuotaStore(),
      }),
      fetchFn: buildFetchMock({ response: [{ fixture: { id: 1 } }] }),
      logger: quietLogger,
    });

    await loop.fetchWorkload({ workload: 'fixture-detail-preKO', resourceId: '1' });

    const observation = await loop.observe();
    expect(observation.ttlSeconds).toEqual(INGESTION_TTL_SECONDS);
    expect(observation.metrics.callOutcomes.fetched).toBe(1);
    expect(observation.quota.calls).toBe(1);
    expect(observation.quota.posture).toBe('normal');
  });
});

describe('ApiFootballIngestionLoop.start', () => {
  it('schedules tick handlers for each workload that has resources', () => {
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      fetchFn: buildFetchMock({ response: [] }),
      singleflight: new Singleflight(),
      logger: quietLogger,
    });

    const handles: number[] = [];
    let nextHandle = 1;
    const schedule = vi.fn((_callback: () => void, _ms: number) => {
      const handle = nextHandle++;
      handles.push(handle);
      return handle;
    });
    const cancel = vi.fn();

    const stop = loop.start({
      fixtureIds: ['1', '2'],
      teamIds: ['t1'],
      playerIds: ['p1'],
      intervals: {
        'fixtures-next-7d': 1_000,
        'fixture-detail-preKO': 1_000,
        'fixture-detail-live': 1_000,
        'fixture-detail-fullTime': 1_000,
        'events-post-final': 1_000,
        'lineups-post-confirm': 1_000,
        'team-metadata': 1_000,
        'player-metadata': 1_000,
      },
      schedule,
      cancel,
    });

    // 1 fixtures-next-7d + 5 dynamic fixture workloads + 1 team + 1 player = 8
    expect(schedule).toHaveBeenCalledTimes(8);
    stop();
    expect(cancel).toHaveBeenCalledTimes(8);
    expect(cancel.mock.calls.map((args) => args[0])).toEqual(handles);
  });

  it('skips workloads with no resources or zero interval', () => {
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      fetchFn: buildFetchMock({ response: [] }),
      logger: quietLogger,
    });

    const schedule = vi.fn(() => 'h');
    const cancel = vi.fn();
    loop.start({
      intervals: {
        'fixtures-next-7d': 0,
        'fixture-detail-preKO': 0,
        'fixture-detail-live': 0,
        'fixture-detail-fullTime': 0,
        'events-post-final': 0,
        'lineups-post-confirm': 0,
      },
      schedule,
      cancel,
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('can run one immediate boot tick for bootstrap fixture ids', async () => {
    const fetchFn = buildFetchMock({ response: [{ fixture: { id: 1917 } }] });
    const loop = new ApiFootballIngestionLoop({
      config: baseConfig,
      fetchFn,
      logger: quietLogger,
    });

    const schedule = vi.fn(() => 'h');
    const cancel = vi.fn();
    const stop = loop.start({
      bootstrapFixtureIds: ['1917'],
      runImmediately: true,
      intervals: {
        'fixtures-next-7d': 1_000,
        'fixture-detail-preKO': 1_000,
        'fixture-detail-live': 1_000,
        'fixture-detail-fullTime': 1_000,
        'events-post-final': 1_000,
        'lineups-post-confirm': 1_000,
      },
      schedule,
      cancel,
    });

    for (let i = 0; i < 5 && fetchFn.mock.calls.length < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(5);
    const urls = fetchFn.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/fixtures?id=1917'))).toBe(true);
    expect(urls.some((url) => url.includes('/fixtures/events?fixture=1917'))).toBe(true);
    stop();
  });

  it('extracts only near-window fixture ids from fixture-list payloads', () => {
    const now = Date.parse('2026-05-21T12:00:00Z');

    expect(
      ingestionTest.fixtureIdsFromFixtureList(
        {
          response: [
            { fixture: { id: 1, date: '2026-05-22T15:00:00Z', status: { short: 'NS' } } },
            { fixture: { id: 2, date: '2026-07-01T15:00:00Z', status: { short: 'NS' } } },
            { fixture: { id: 3, date: '2026-05-01T15:00:00Z', status: { short: 'FT' } } },
            { fixture: { id: 4, date: '2026-07-01T15:00:00Z', status: { short: '1H' } } },
          ],
        },
        now
      )
    ).toEqual(['1', '4']);
  });

  it('extracts fixture team ids and builds squad-list fallback resources', () => {
    const fixture = {
      response: [
        {
          teams: {
            home: { id: 10379, name: 'San Marino U19' },
            away: { id: 10339, name: 'Latvia U19' },
          },
        },
      ],
    };

    expect(ingestionTest.teamIdsFromFixtureDetail(fixture)).toEqual(['10379', '10339']);
    expect(ingestionTest.lineupsMissing({ response: [] })).toBe(true);
    expect(ingestionTest.squadListResourceId('1538961', '10379')).toBe('1538961:10379');
    expect(ingestionTest.apiFootballPathFor('squad-list-fallback', '1538961:10379')).toBe(
      '/players/squads?team=10379'
    );
  });
});
