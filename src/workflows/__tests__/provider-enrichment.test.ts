/**
 * provider-enrichment (GW-6a, player-season-stats).
 *
 * Runs the real ingestion loop (limiter, quota, cache) against a stub provider
 * so priority, cache bypass and quota behaviour are exercised end to end. Only
 * the provider HTTP and the game-service ingest client are stubbed.
 */
import { readFileSync } from 'node:fs';

import type {
  IngestBatchResponse,
  IngestProviderPlayerSeasonStatsRequest,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryProviderCache } from '../../worker/cache.js';
import type { ProviderEnrichmentIngestClient } from '../../worker/clients/game-service.js';
import type { GamewireWorkerConfig } from '../../worker/config.js';
import { ApiFootballIngestionLoop } from '../../worker/ingestion.js';
import {
  DEFAULT_ENRICHMENT_MINUTE_CAP,
  InMemoryMinuteCounterStore,
  ProviderMinuteLimiter,
} from '../../worker/minute-limiter.js';
import type { ProviderFetch } from '../../worker/provider-http.js';
import { ProviderQuotaTracker } from '../../worker/quota.js';
import {
  DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN,
  ENRICHMENT_INGEST_BATCH_SIZE,
  MAX_ENRICHMENT_CALLS_PER_RUN,
  clampEnrichmentLimit,
  enrichmentCursorKey,
  providerEnrichmentWorkflow,
  resolveEnrichmentTargets,
  type EnrichmentCursor,
} from '../provider-enrichment.js';
import type {
  CompetitionEntry,
  ProviderEnrichmentDeps,
  ProviderEnrichmentInput,
  WorkflowDeps,
  WorkflowLogEntry,
} from '../types.js';
import { providerEnrichmentToWire } from '../wire.js';

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
  providerHardCap: 140_000,
  providerSoftCap: 130_000,
  ingestionEnabled: true,
  bootstrapFixtureIds: [],
  ingestionRunImmediateTick: false,
  authContextJwksUrl: 'https://auth.test/.well-known/jwks.json',
  authContextIssuer: 'auth-service-test',
  authContextAudience: 'gamewire-worker',
  authContextRequiredScope: 'gamewire.workflow.invoke',
  assetMirror: { region: 'auto' },
};

const REAL_PAGE: { response: unknown[]; paging: { current: number; total: number } } = JSON.parse(
  readFileSync(
    new URL('../../adapters/api-football/fixtures/players-season-page.json', import.meta.url),
    'utf8'
  )
);

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);

const entry = (
  key: string,
  leagueId: number,
  tier: CompetitionEntry['tier'],
  season = 2026
): CompetitionEntry => ({
  key,
  label: key,
  country: 'X',
  apiFootballLeagueId: leagueId,
  season,
  calendar: null,
  tier,
  liveIngestion: true,
  steadyStateSweep: true,
});

const CATALOGUE: readonly CompetitionEntry[] = [
  entry('premier-league', 39, 'domestic-top-five'),
  entry('eredivisie', 88, 'domestic-league'),
  entry('fa-cup', 45, 'domestic-cup', 2025),
  entry('champions-league', 2, 'european'),
  entry('world-cup', 1, 'international'),
];

/** One synthetic player block for league L, team T. */
const playerEntry = (leagueId: number, playerId: number, teamId = 1000) => ({
  player: { id: playerId, name: `P. ${playerId}`, nationality: 'X' },
  statistics: [
    {
      team: { id: teamId, name: `Team ${teamId}` },
      league: { id: leagueId },
      games: { appearences: 10, minutes: 900, rating: '6.9' },
      shots: { total: null, on: null },
      goals: { total: 0, assists: 1 },
    },
  ],
});

const pageEnvelope = (leagueId: number, page: number, total: number, rows = 2) => ({
  get: 'players',
  errors: [],
  results: rows,
  paging: { current: page, total },
  response: Array.from({ length: rows }, (_, i) => playerEntry(leagueId, page * 1000 + i)),
});

const parseUrl = (url: string) => {
  const parsed = new URL(url);
  return {
    path: parsed.pathname,
    league: Number(parsed.searchParams.get('league')),
    season: Number(parsed.searchParams.get('season')),
    page: Number(parsed.searchParams.get('page')),
  };
};

interface HarnessOptions {
  /** Pages per `${league}:${season}`. Default 3. */
  readonly totals?: Record<string, number>;
  /** Override the envelope for a request. Return undefined for the default. */
  readonly respond?: (req: { league: number; season: number; page: number }) => unknown;
  readonly enrichment?: Partial<ProviderEnrichmentDeps> | null;
  readonly ingest?: ProviderEnrichmentIngestClient['ingestProviderPlayerSeasonStats'];
  readonly backgroundDailyCap?: number;
  readonly hardCap?: number;
  readonly softCap?: number;
  readonly backgroundMinuteCap?: number;
}

const harness = (options: HarnessOptions = {}) => {
  let now = T0;
  const clockMs = () => now;
  const advance = (ms: number) => {
    now += ms;
  };
  const sleep = vi.fn(async (ms: number) => {
    advance(ms);
  });
  const urls: string[] = [];
  const fetchTimes: number[] = [];
  const fetchFn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    fetchTimes.push(now);
    const req = parseUrl(url);
    const custom = options.respond?.(req);
    const total = options.totals?.[`${req.league}:${req.season}`] ?? 3;
    const payload = custom ?? pageEnvelope(req.league, req.page, total);
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => payload,
    };
  }) as unknown as ProviderFetch;
  const cache = new InMemoryProviderCache({ clock: clockMs });
  const cacheSet = vi.spyOn(cache, 'set');
  const hardCap = options.hardCap ?? 140_000;
  const softCap = options.softCap ?? Math.min(130_000, hardCap);
  const quota = new ProviderQuotaTracker({
    provider: 'api-football',
    hardCap,
    softCap,
    backgroundDailyCap: options.backgroundDailyCap ?? Math.min(110_000, softCap),
    clock: () => new Date(now),
  });
  const reserve = vi.spyOn(quota, 'reserve');
  const minuteLimiter = new ProviderMinuteLimiter({
    providerId: 'api-football',
    clock: clockMs,
    store: new InMemoryMinuteCounterStore({ clock: clockMs }),
    caps: {
      live: 800,
      'near-live': 650,
      background: options.backgroundMinuteCap ?? 450,
    },
  });
  const acquire = vi.spyOn(minuteLimiter, 'tryAcquire');
  const loop = new ApiFootballIngestionLoop({
    config,
    cache,
    quota,
    minuteLimiter,
    fetchFn,
    clock: clockMs,
    sleep,
    logger: () => undefined,
  });
  const requests: IngestProviderPlayerSeasonStatsRequest[] = [];
  const ingestImpl =
    options.ingest ??
    (async (request: IngestProviderPlayerSeasonStatsRequest) =>
      ({ acceptedCount: request.rows.length }) as IngestBatchResponse);
  const ingest = vi.fn(async (request: IngestProviderPlayerSeasonStatsRequest) => {
    requests.push(request);
    return ingestImpl(request);
  });
  const logs: WorkflowLogEntry[] = [];
  const enrichment: ProviderEnrichmentDeps | undefined =
    options.enrichment === null
      ? undefined
      : {
          enabledDatasets: ['player-season-stats'],
          ingest: { ingestProviderPlayerSeasonStats: ingest },
          limiter: new ProviderMinuteLimiter({
            providerId: 'api-football:enrichment',
            clock: clockMs,
            store: new InMemoryMinuteCounterStore({ clock: clockMs }),
            caps: { live: 120, 'near-live': 120, background: 120 },
          }),
          sleep,
          ...options.enrichment,
        };
  const deps: WorkflowDeps = {
    ingestion: loop,
    competitions: CATALOGUE,
    clock: () => new Date(now),
    logger: (e) => logs.push(e),
    enrichment,
  };
  const run = (input: Partial<ProviderEnrichmentInput> = {}) =>
    providerEnrichmentWorkflow(
      { dataset: 'player-season-stats', mode: 'nightly', ...input } as ProviderEnrichmentInput,
      deps
    );
  return {
    run,
    deps,
    urls,
    fetchTimes,
    fetchFn,
    cache,
    cacheSet,
    quota,
    reserve,
    acquire,
    ingest,
    requests,
    logs,
    sleep,
    advance,
    now: () => now,
  };
};

const FULL = { mode: 'full', leagueIds: [88, 39], seasons: [2024, 2023] } as const;

describe('kill switch', () => {
  it('is off when enrichment is not wired (the env default)', async () => {
    const h = harness({ enrichment: null });
    const out = await h.run(FULL);
    expect(out.status).toBe('disabled');
    expect(out.callsUsed).toBe(0);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('is off when the dataset is not in the allowlist', async () => {
    const h = harness({ enrichment: { enabledDatasets: ['injuries-league'] } });
    const out = await h.run(FULL);
    expect(out.status).toBe('disabled');
    expect(out.reason).toContain('not enabled');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('is off with an empty allowlist', async () => {
    const h = harness({ enrichment: { enabledDatasets: [] } });
    expect((await h.run(FULL)).status).toBe('disabled');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});

describe('full mode (history backfill)', () => {
  it('walks every page of every league-season, season-major, and stops at paging.total', async () => {
    const h = harness({ totals: { '88:2024': 3, '39:2024': 2, '88:2023': 1, '39:2023': 2 } });
    const out = await h.run(FULL);
    expect(out.status).toBe('completed');
    expect(h.urls.map((u) => parseUrl(u)).map((r) => `${r.league}:${r.season}:${r.page}`)).toEqual([
      '88:2024:1',
      '88:2024:2',
      '88:2024:3',
      '39:2024:1',
      '39:2024:2',
      '88:2023:1',
      '39:2023:1',
      '39:2023:2',
    ]);
    expect(h.urls.every((u) => parseUrl(u).path === '/players')).toBe(true);
    expect(out.callsUsed).toBe(8);
    expect(out.pagesFetched).toBe(8);
    expect(out.rowsIngested).toBe(16);
    expect(out.targets.map((t) => [t.leagueId, t.season, t.status, t.pagesTotal])).toEqual([
      [88, 2024, 'complete', 3],
      [39, 2024, 'complete', 2],
      [88, 2023, 'complete', 1],
      [39, 2023, 'complete', 2],
    ]);
  });

  it('writes one ingest call per page with provider ids and the requested season', async () => {
    const h = harness({ totals: { '88:2024': 2 } });
    await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(h.ingest).toHaveBeenCalledTimes(2);
    const [first] = h.requests;
    expect(first?.metadata?.provider).toBe('api-football');
    expect(first?.metadata?.rawPayloadRef).toBe(
      'provider://api-football/players?league=88&season=2024&page=1'
    );
    expect(first?.metadata?.idempotencyKey).toContain('player-season-stats');
    for (const row of first?.rows ?? []) {
      expect(row.providerCompetitionId).toBe('88');
      expect(row.seasonYear).toBe(2024);
      expect(row.providerTeamId).toBe('1000');
    }
  });

  it('stops a league-season with zero pages without error', async () => {
    const h = harness({ totals: { '88:2024': 0 } });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.status).toBe('completed');
    expect(h.urls).toHaveLength(1);
    expect(out.targets[0]).toMatchObject({ status: 'complete', pagesTotal: 0 });
  });
});

describe('null versus zero', () => {
  it('sends a provider null as an absent key and a provider 0 as 0', async () => {
    const h = harness({
      respond: (req) => (req.league === 88 ? REAL_PAGE : undefined),
      totals: { '88:2024': 1 },
    });
    // The fixture says 43 pages; serve it for page 1 only, then an empty last page.
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024], limit: 1 });
    expect(out.callsUsed).toBe(1);
    const rows = h.requests[0]?.rows ?? [];
    const karsdorp = rows.find((row) => row.providerPlayerId === '770');
    expect(karsdorp).toBeDefined();
    expect(Object.keys(karsdorp?.values ?? {})).not.toContain('shots');
    expect(Object.keys(karsdorp?.values ?? {})).not.toContain('passes_accuracy');
    expect(karsdorp?.values.goals).toBe(0);
    const goalkeeper = rows.find((row) => row.providerPlayerId === '124');
    expect(goalkeeper?.values).toEqual({});
  });
});

describe('no bulk caching (verdict D9)', () => {
  it('never writes a provider page to the cache, only small cursors', async () => {
    const h = harness({ totals: { '88:2024': 3 } });
    await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    const keys = h.cacheSet.mock.calls.map((call) => call[0]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toBe(enrichmentCursorKey('player-season-stats', 88, 2024));
    }
    for (const call of h.cacheSet.mock.calls) {
      expect(JSON.stringify(call[1]).length).toBeLessThan(200);
    }
    expect(await h.cache.get('api-football:player-season-stats:players-88-2024-1')).toBeUndefined();
  });

  it('refetches on a second direct call: the bypass skips the cache read too', async () => {
    const h = harness();
    const fetchOnce = () =>
      h.deps.ingestion.fetchWorkload({
        workload: 'player-season-stats',
        resourceId: 'players-88-2024-1',
        priority: 'background',
        cache: 'bypass',
      });
    expect((await fetchOnce()).status).toBe('fetched');
    expect((await fetchOnce()).status).toBe('fetched');
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    expect(parseUrl(h.urls[0] ?? '')).toMatchObject({ league: 88, season: 2024, page: 1 });
  });
});

describe('background priority (verdict D5)', () => {
  it('spends every call at background priority through the provider limiter and quota', async () => {
    const h = harness({ totals: { '88:2024': 3 } });
    await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(h.acquire).toHaveBeenCalledTimes(3);
    for (const call of h.acquire.mock.calls) {
      expect(call[0]).toBe('background');
    }
    expect(h.reserve).toHaveBeenCalledTimes(3);
    for (const call of h.reserve.mock.calls) {
      expect(call[2]).toBe('background');
    }
  });

  it('stops as incomplete at the background daily cap without touching live headroom', async () => {
    const h = harness({ totals: { '88:2024': 10 }, backgroundDailyCap: 4 });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.status).toBe('incomplete');
    expect(out.callsUsed).toBeLessThanOrEqual(4);
    expect(out.degradeFlags.some((f) => f.trigger === 'background-cap')).toBe(true);
    expect(out.targets[0]?.status).toBe('partial');
  });

  it('aborts at the hard cap', async () => {
    const h = harness({
      totals: { '88:2024': 10 },
      hardCap: 2,
      softCap: 2,
      backgroundDailyCap: 2,
    });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.status).toBe('aborted');
    expect(out.callsUsed).toBe(2);
    expect(h.urls).toHaveLength(2);
    expect(out.degradeFlags.some((f) => f.trigger === 'hard-cap')).toBe(true);
  });

  it('stops as incomplete at the soft cap (workflows go cached-only)', async () => {
    const h = harness({
      totals: { '88:2024': 10 },
      hardCap: 10,
      softCap: 2,
      backgroundDailyCap: 10,
    });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.status).toBe('incomplete');
    expect(out.callsUsed).toBe(2);
    expect(out.degradeFlags.some((f) => f.trigger === 'soft-cap')).toBe(true);
    expect(out.targets[0]).toMatchObject({ status: 'partial', nextPage: 3 });
  });
});

describe('per-run call limit and resume', () => {
  it('stops at the limit and resumes from the cursor on the next run', async () => {
    const h = harness({ totals: { '88:2024': 8 } });
    const first = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024], limit: 5 });
    expect(first.status).toBe('incomplete');
    expect(first.reason).toContain('call limit 5');
    expect(first.callsUsed).toBe(5);
    expect(first.targets[0]).toMatchObject({ status: 'partial', nextPage: 6, pagesTotal: 8 });

    h.advance(6 * 60 * 60 * 1000);
    const second = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024], limit: 5 });
    expect(second.status).toBe('completed');
    expect(second.callsUsed).toBe(3);
    expect(h.urls.slice(5).map((u) => parseUrl(u).page)).toEqual([6, 7, 8]);
  });

  it('marks later league-seasons not-started once the limit stops the run', async () => {
    const h = harness({ totals: { '88:2024': 3, '39:2024': 3 } });
    const out = await h.run({ mode: 'full', leagueIds: [88, 39], seasons: [2024], limit: 3 });
    expect(out.targets.map((t) => t.status)).toEqual(['complete', 'not-started']);
  });

  it('skips a completed league-season on a re-run inside the window', async () => {
    const h = harness({ totals: { '88:2024': 2 } });
    await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    h.advance(24 * 60 * 60 * 1000);
    const again = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(again.status).toBe('completed');
    expect(again.callsUsed).toBe(0);
    expect(again.targets[0]?.status).toBe('fresh');
  });

  it('reset ignores the cursor', async () => {
    const h = harness({ totals: { '88:2024': 2 } });
    await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    const again = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024], reset: true });
    expect(again.callsUsed).toBe(2);
  });

  it('nightly refetches the next night (20h window)', async () => {
    const h = harness({ totals: { '39:2026': 2, '88:2026': 1 } });
    expect((await h.run()).callsUsed).toBe(3);
    h.advance(2 * 60 * 60 * 1000);
    expect((await h.run()).callsUsed).toBe(0);
    h.advance(22 * 60 * 60 * 1000);
    expect((await h.run()).callsUsed).toBe(3);
  });

  it('clamps the limit', () => {
    expect(clampEnrichmentLimit(undefined)).toBe(DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN);
    expect(clampEnrichmentLimit(0)).toBe(DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN);
    expect(clampEnrichmentLimit(-3)).toBe(DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN);
    expect(clampEnrichmentLimit(12.7)).toBe(12);
    expect(clampEnrichmentLimit(1_000_000)).toBe(MAX_ENRICHMENT_CALLS_PER_RUN);
  });
});

describe('enrichment minute ceiling', () => {
  it('holds the job to its own per-minute ceiling by waiting', async () => {
    const h = harness({
      totals: { '88:2024': 7 },
      enrichment: {
        limiter: new ProviderMinuteLimiter({
          providerId: 'api-football:enrichment',
          caps: { live: 3, 'near-live': 3, background: 3 },
          clock: () => h.now(),
          store: new InMemoryMinuteCounterStore({ clock: () => h.now() }),
        }),
      },
    });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.status).toBe('completed');
    expect(out.callsUsed).toBe(7);
    expect(h.sleep).toHaveBeenCalled();
    // No 60-second window holds more than the ceiling.
    for (const start of h.fetchTimes) {
      const inWindow = h.fetchTimes.filter((t) => t >= start && t < start + MINUTE).length;
      expect(inWindow).toBeLessThanOrEqual(3);
    }
  });

  it('defaults to 120 a minute when no limiter is injected', async () => {
    expect(DEFAULT_ENRICHMENT_MINUTE_CAP).toBe(120);
    const h = harness({
      totals: { '88:2024': 125 },
      enrichment: { limiter: undefined, minuteCap: undefined },
    });
    // The built-in limiter runs on the workflow clock: 120 calls go out in the
    // first minute, the 121st waits for room.
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024], limit: 121 });
    expect(out.callsUsed).toBe(121);
    expect(h.sleep).toHaveBeenCalled();
    // The wait lands just past the minute boundary, never a whole extra minute.
    expect((h.fetchTimes[120] ?? 0) - T0).toBeLessThan(2 * MINUTE);
    expect(h.fetchTimes.filter((t) => t === T0)).toHaveLength(120);
    expect(h.fetchTimes[120]).toBeGreaterThan(T0);
  });

  it('gives up as incomplete when the limiter stays full', async () => {
    const h = harness({
      totals: { '88:2024': 3 },
      enrichment: {
        limiter: {
          tryAcquire: async () => ({
            allowed: false,
            priority: 'background',
            epochMinute: 0,
            estimate: 120,
            ceiling: 120,
            msUntilNextMinute: 1_000,
            retryAfterMs: 1_000,
            reason: 'minute_cap',
          }),
        } as unknown as ProviderMinuteLimiter,
      },
    });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.status).toBe('incomplete');
    expect(out.reason).toContain('minute limiter');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('keeps the cursor on a failed ingest and retries that page next run', async () => {
    let fail = true;
    const h = harness({
      totals: { '88:2024': 3 },
      ingest: async (request) => {
        const page = request.metadata?.rawPayloadRef.endsWith('page=2');
        if (fail && page) {
          throw new Error('unavailable');
        }
        return { acceptedCount: request.rows.length } as IngestBatchResponse;
      },
    });
    const first = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(first.status).toBe('incomplete');
    expect(first.targets[0]).toMatchObject({ status: 'failed', nextPage: 2 });
    expect(first.targets[0]?.errors[0]).toContain('ingest failed');
    const cursor = await h.cache.get<EnrichmentCursor>(
      enrichmentCursorKey('player-season-stats', 88, 2024)
    );
    expect(cursor?.nextPage).toBe(2);

    fail = false;
    const second = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(second.status).toBe('completed');
    expect(h.urls.slice(2).map((u) => parseUrl(u).page)).toEqual([2, 3]);
  });

  it('treats a 200 with provider errors and no rows as a failed page', async () => {
    const h = harness({
      respond: () => ({
        errors: { plan: 'not covered' },
        response: [],
        paging: { current: 1, total: 1 },
      }),
    });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.targets[0]?.status).toBe('failed');
    expect(out.targets[0]?.errors[0]).toContain('provider errors');
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('aborts after three failed pages in a row', async () => {
    const h = harness({
      respond: () => ({
        errors: { plan: 'not covered' },
        response: [],
        paging: { current: 1, total: 1 },
      }),
    });
    const out = await h.run({ mode: 'full', leagueIds: [88, 39, 61, 78], seasons: [2024] });
    expect(out.status).toBe('aborted');
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    expect(out.targets.map((t) => t.status)).toEqual(['failed', 'failed', 'failed', 'not-started']);
  });

  it('makes no provider call when the ingest client is not wired', async () => {
    const h = harness({ enrichment: { ingest: undefined } });
    const out = await h.run(FULL);
    expect(out.status).toBe('skipped');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('retries a minute-throttled page, then stops as incomplete', async () => {
    const h = harness({ totals: { '88:2024': 3 } });
    // The provider-wide limiter refuses background every time.
    h.acquire.mockResolvedValue({
      allowed: false,
      priority: 'background',
      epochMinute: 0,
      estimate: 450,
      ceiling: 450,
      msUntilNextMinute: 1_000,
      retryAfterMs: 1_000,
      reason: 'minute_cap',
    });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(out.status).toBe('incomplete');
    expect(out.degradeFlags.some((f) => f.trigger === 'provider-rate-limited')).toBe(true);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(out.callsUsed).toBe(0);
    // Three page attempts, each with the loop's own wait and retry.
    expect(h.acquire).toHaveBeenCalledTimes(6);
    expect(h.logs.filter((l) => l.event === 'provider_enrichment.rate_limited')).toHaveLength(3);
  });
});

describe('batches', () => {
  it(`splits a page into ingest calls of at most ${ENRICHMENT_INGEST_BATCH_SIZE} rows`, async () => {
    const h = harness({
      respond: (req) => pageEnvelope(req.league, req.page, 1, ENRICHMENT_INGEST_BATCH_SIZE + 1),
    });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] });
    expect(h.requests.map((r) => r.rows.length)).toEqual([ENRICHMENT_INGEST_BATCH_SIZE, 1]);
    expect(out.rowsIngested).toBe(ENRICHMENT_INGEST_BATCH_SIZE + 1);
    expect(new Set(h.requests.map((r) => r.metadata?.idempotencyKey)).size).toBe(2);
  });
});

describe('dry run', () => {
  it('plans targets without provider calls or writes', async () => {
    const h = harness();
    const out = await h.run({ ...FULL, dryRun: true });
    expect(out.status).toBe('completed');
    expect(out.dryRun).toBe(true);
    expect(out.targets).toHaveLength(4);
    expect(out.targets.every((t) => t.status === 'planned')).toBe(true);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.cacheSet).not.toHaveBeenCalled();
  });
});

describe('target resolution (no season-end gate, verdict D15)', () => {
  it('nightly defaults to catalogue domestic leagues at their catalogue season', () => {
    const { targets } = resolveEnrichmentTargets({ mode: 'nightly' }, CATALOGUE);
    expect(targets).toEqual([
      { leagueId: 39, season: 2026 },
      { leagueId: 88, season: 2026 },
    ]);
  });

  it('nightly takes explicit league ids and seasons', () => {
    expect(
      resolveEnrichmentTargets({ mode: 'nightly', leagueIds: [45], seasons: [2025] }, CATALOGUE)
        .targets
    ).toEqual([{ leagueId: 45, season: 2025 }]);
    expect(resolveEnrichmentTargets({ mode: 'nightly', leagueIds: [88, 253] }, CATALOGUE)).toEqual({
      targets: [{ leagueId: 88, season: 2026 }],
      unresolved: [253],
    });
  });

  it('full mode uses exactly the requested leagues and seasons, de-duplicated', () => {
    expect(
      resolveEnrichmentTargets(
        { mode: 'full', leagueIds: [253, 253, 88], seasons: [2025, 2023, 2025] },
        CATALOGUE
      ).targets
    ).toEqual([
      { leagueId: 253, season: 2025 },
      { leagueId: 88, season: 2025 },
      { leagueId: 253, season: 2023 },
      { leagueId: 88, season: 2023 },
    ]);
  });

  it('fetches a season whatever its end date: no date gate at all', async () => {
    // 2019 ended years ago; the request names it, so it is fetched.
    const h = harness({ totals: { '88:2019': 1 } });
    const out = await h.run({ mode: 'full', leagueIds: [88], seasons: [2019] });
    expect(out.callsUsed).toBe(1);
  });

  it('skips with a reason when nothing resolves', async () => {
    const h = harness();
    const out = await h.run({ mode: 'nightly', leagueIds: [999] });
    expect(out.status).toBe('skipped');
    expect(h.logs.some((l) => l.event === 'provider_enrichment.target_unresolved')).toBe(true);
  });
});

describe('wire projection', () => {
  it('drops per-target errors and keeps totals', async () => {
    const h = harness({ totals: { '88:2024': 2 } });
    const wire = providerEnrichmentToWire(
      await h.run({ mode: 'full', leagueIds: [88], seasons: [2024] })
    );
    expect(wire).toMatchObject({ status: 'completed', callsUsed: 2, rowsIngested: 4 });
    expect(wire.targets[0]).not.toHaveProperty('errors');
  });
});
