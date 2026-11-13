/**
 * provider-enrichment GW-6b datasets: injuries-league, player-sidelined,
 * team-transfers, trophies.
 *
 * Runs the real ingestion loop (limiter, quota, cache) against a stub
 * provider, like the GW-6a suite. Only the provider HTTP and the game-service
 * ingest client are stubbed.
 */
import { timestampMs } from '@bufbuild/protobuf/wkt';
import type {
  IngestAvailabilityRequest,
  IngestCoachProfilesRequest,
  IngestBatchResponse,
  IngestHeadToHeadRequest,
  IngestProviderPredictionsRequest,
  IngestVenuesRequest,
  IngestProviderTeamSeasonStatsRequest,
  IngestTransfersRequest,
  IngestTrophiesRequest,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { SubjectType } from '@breakingthelines/protos/btl/context/v1/context_pb';
import { AvailabilitySource } from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryProviderCache } from '../../worker/cache.js';
import { parseProviderEnrichmentInput } from '../../worker/http.js';
import type { ProviderEnrichmentIngestClient } from '../../worker/clients/game-service.js';
import type { GamewireWorkerConfig } from '../../worker/config.js';
import { ApiFootballIngestionLoop } from '../../worker/ingestion.js';
import { InMemoryMinuteCounterStore, ProviderMinuteLimiter } from '../../worker/minute-limiter.js';
import type { ProviderFetch } from '../../worker/provider-http.js';
import { ProviderQuotaTracker } from '../../worker/quota.js';
import {
  clampEnrichmentLimit,
  providerEnrichmentWorkflow,
  runPreMatchEnrichment,
} from '../provider-enrichment.js';
import {
  DEFAULT_UNIT_MAX_CALLS_PER_RUN,
  INJURIES_COVERED_LEAGUE_IDS,
  MAX_TROPHIES_PER_INGEST,
  SIDELINED_LOOKBACK_MS,
  fixturesFromListEnvelope,
  headToHeadUnitKey,
  injuryDigestKey,
  teamCoachsDigestKey,
  mergeInjuryDigest,
  packTrophyRows,
  resolveInjuriesTargets,
  sidelinedMemberKey,
  teamSeasonStatsCoversAll,
  teamTrophiesPartition,
  teamsWithRecentFinalWhistle,
  trophiesPartition,
  trophiesWeek,
  unitMarkerKey,
  type InjuryPlayerDigest,
} from '../provider-enrichment-units.js';
import type {
  CompetitionEntry,
  ProviderEnrichmentDataset,
  ProviderEnrichmentDeps,
  ProviderEnrichmentInput,
  WorkflowDeps,
} from '../types.js';
import { providerEnrichmentToWire } from '../wire.js';

const config: GamewireWorkerConfig = {
  port: 8095,
  gameServiceUrl: 'http://game-service:9090',
  gameServiceJobsUrl: 'http://game-service-profile-jobs:9090',
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
  providerFixtureResultsEnabled: false,
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Thursday 2026-11-05 03:00 UTC. */
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
  entry('jupiler', 144, 'domestic-league'),
  entry('fa-cup', 45, 'domestic-cup', 2025),
  entry('champions-league', 2, 'european'),
  entry('world-cup', 1, 'international'),
  { ...entry('friendlies', 10, 'international'), enrichment: 'none' },
];

const ids = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i);

/** `/injuries?league&season`: one row per player id, kickoff at `kickoffMs`. */
const injuriesEnvelope = (
  league: number,
  season: number,
  players: number[],
  kickoffMs: number
) => ({
  get: 'injuries',
  errors: [],
  results: players.length,
  response: players.map((id) => ({
    player: { id, name: `P. ${id}`, type: 'Missing Fixture', reason: 'Knee Injury' },
    team: { id: 1000 + (id % 2), name: 'Team' },
    fixture: { id: 5_000 + id, date: '', timestamp: Math.floor(kickoffMs / 1_000) },
    league: { id: league, season },
  })),
});

const sidelinedEnvelope = (players: string[]) => ({
  get: 'sidelined',
  errors: [],
  response: players.map((id) => ({
    id: Number(id),
    sidelined: [{ type: 'Thigh Injury', start: '2026-09-01', end: null }],
  })),
});

const transfersEnvelope = (team: string, moves = 2) => ({
  get: 'transfers',
  errors: [],
  response: Array.from({ length: moves }, (_, i) => ({
    player: { id: Number(team) * 100 + i, name: `T${team}-${i}` },
    transfers: [
      {
        date: '2025-07-01',
        type: '€ 5M',
        teams: { in: { id: Number(team), name: 'In' }, out: { id: 9, name: 'Out' } },
      },
    ],
  })),
});

const trophiesEnvelope = (subjectIds: string[], perSubject: (id: string) => number = () => 1) => ({
  get: 'trophies',
  errors: [],
  response: subjectIds.map((id) => ({
    id: Number(id),
    trophies: Array.from({ length: perSubject(id) }, (_, i) => ({
      league: `Cup ${i}`,
      country: 'X',
      season: '2024/2025',
      place: i % 3 === 0 ? 'Winner' : '2nd Place',
    })),
  })),
});

const squadEnvelope = (team: string, size: number) => ({
  get: 'players',
  errors: [],
  response: [
    {
      team: { id: Number(team) },
      players: ids(Number(team) * 1000, size).map((id) => ({ id, name: `S${id}` })),
    },
  ],
});

/** A cached `/fixtures?league&season` list, the daily-anchor discovery payload. */
const fixtureList = (teams: number[]) => ({
  response: teams.map((home, i) => ({
    teams: { home: { id: home }, away: { id: teams[(i + 1) % teams.length] } },
  })),
});

const teamStatisticsEnvelope = (league: number, season: number, team: string) => ({
  get: 'teams/statistics',
  errors: [],
  response: {
    league: { id: league, season },
    team: { id: Number(team), name: `Team ${team}` },
    form: 'WDL',
    fixtures: {
      played: { total: 3 },
      wins: { total: 1 },
      draws: { total: 1 },
      loses: { total: 1 },
    },
    goals: { for: { total: { total: 4 } }, against: { total: { total: 3 } } },
    clean_sheet: { total: 1 },
    failed_to_score: { total: null },
  },
});

/** `/coachs?team=T`: a former coach and the current one, each with a career. */
const coachsEnvelope = (teamId: string) => ({
  errors: [],
  response: [
    {
      id: Number(teamId) * 10 + 1,
      name: `Former ${teamId}`,
      team: { id: Number(teamId) },
      career: [
        {
          team: { id: Number(teamId), name: `Team ${teamId}` },
          start: '2022-06-01',
          end: '2025-06-01',
        },
      ],
    },
    {
      id: Number(teamId) * 10 + 2,
      name: `Current ${teamId}`,
      team: { id: Number(teamId) },
      career: [
        { team: { id: 9, name: 'Elsewhere' }, start: '2020-01-01', end: '2025-06-01' },
        { team: { id: Number(teamId), name: `Team ${teamId}` }, start: '2025-07-01', end: null },
      ],
    },
  ],
});

/** A cached season fixture list with kickoff times and statuses. */
const datedFixtureList = (
  fixtures: readonly { home: number; away: number; kickoffMs: number; status: string }[]
) => ({
  response: fixtures.map((f, i) => ({
    fixture: {
      id: 9_000 + i,
      timestamp: Math.floor(f.kickoffMs / 1_000),
      status: { short: f.status },
    },
    teams: { home: { id: f.home }, away: { id: f.away } },
  })),
});

/** One provider fixture object, the shape `/fixtures/headtohead` and `/predictions` h2h share. */
const meeting = (id: number, home: number, away: number, date: string) => ({
  fixture: {
    id,
    date: `${date}T15:00:00+00:00`,
    referee: 'A. Referee',
    periods: { first: 1_740_841_200, second: 1_740_844_800 },
    status: { short: 'FT' },
  },
  league: { id: 39, name: 'Premier League', season: 2024 },
  teams: { home: { id: home, name: `T${home}` }, away: { id: away, name: `T${away}` } },
  goals: { home: 2, away: 1 },
});

/** `/predictions?fixture=F` for a fixture between 40 and 33, with two past meetings. */
const predictionsEnvelope = (fixtureId: string) => ({
  errors: [],
  response: [
    {
      predictions: {
        winner: { id: 33, name: 'T33', comment: 'Win or draw' },
        win_or_draw: true,
        goals: { home: '-1.5', away: '-2.5' },
        advice: 'Double chance : T33 or draw',
        percent: { home: '45%', draw: '45%', away: '10%' },
      },
      league: { id: 39 },
      teams: { home: { id: 40, name: 'T40' }, away: { id: 33, name: 'T33' } },
      comparison: { total: { home: '40%', away: '60%' } },
      h2h: [meeting(1, 33, 40, '2024-01-01'), meeting(2, 40, 33, '2025-01-01')],
      fixture: fixtureId,
    },
  ],
});

/** `/teams?id=T`: the team's record and the venue it names as home (T + 5000). */
const teamRecordEnvelope = (id: string) => ({
  errors: [],
  response: [
    {
      team: { id: Number(id), name: `Team ${id}`, country: 'England', national: false },
      venue: {
        id: id === '0' ? null : Number(id) + 5000,
        name: `Home of ${id}`,
        address: 'Lane',
        city: 'Town',
        capacity: 28_723,
        surface: 'grass',
        image: `https://media.example/venues/${Number(id) + 5000}.png`,
      },
    },
  ],
});

const venueEnvelope = (id: string) => ({
  errors: [],
  response: [
    {
      id: Number(id),
      name: `Ground ${id}`,
      address: 'Road',
      city: 'City',
      country: 'X',
      capacity: id === '0' ? null : 12_815,
      surface: 'grass',
      image: `https://media.example/venues/${id}.png`,
    },
  ],
});

/** A cached season fixture list with ids, kickoffs, statuses and venues. */
const preMatchList = (
  fixtures: readonly {
    id: number;
    home: number;
    away: number;
    kickoffMs: number;
    status?: string;
    venue?: number;
  }[]
) => ({
  response: fixtures.map((f) => ({
    fixture: {
      id: f.id,
      date: new Date(f.kickoffMs).toISOString(),
      status: { short: f.status ?? 'NS' },
      venue: { id: f.venue ?? null, name: 'Ground' },
    },
    teams: { home: { id: f.home }, away: { id: f.away } },
  })),
});

interface RequestInfo {
  readonly path: string;
  readonly params: URLSearchParams;
}

interface HarnessOptions {
  readonly respond?: (req: RequestInfo, now: number) => unknown;
  readonly enabled?: readonly ProviderEnrichmentDataset[];
  readonly enrichment?: Partial<ProviderEnrichmentDeps> | null;
  readonly ingest?: Partial<ProviderEnrichmentIngestClient>;
  readonly backgroundDailyCap?: number;
  readonly hardCap?: number;
  readonly softCap?: number;
  readonly squadSize?: number;
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
  const defaultRespond = (req: RequestInfo): unknown => {
    const list = (name: string) => (req.params.get(name) ?? '').split('-').filter(Boolean);
    switch (req.path) {
      case '/injuries':
        return injuriesEnvelope(
          Number(req.params.get('league')),
          Number(req.params.get('season')),
          [11, 12],
          now + DAY
        );
      case '/sidelined':
        return sidelinedEnvelope(list('players'));
      case '/transfers':
        return transfersEnvelope(req.params.get('team') ?? '');
      case '/trophies':
        return trophiesEnvelope(list('players').length ? list('players') : list('coachs'));
      case '/players/squads':
        return squadEnvelope(req.params.get('team') ?? '', options.squadSize ?? 25);
      case '/coachs':
        return coachsEnvelope(req.params.get('team') ?? '');
      case '/predictions':
        return predictionsEnvelope(req.params.get('fixture') ?? '');
      case '/fixtures/headtohead': {
        const [a, b] = (req.params.get('h2h') ?? '').split('-');
        return { errors: [], response: [meeting(77, Number(a), Number(b), '2025-03-01')] };
      }
      case '/venues':
        return venueEnvelope(req.params.get('id') ?? '');
      case '/teams':
        return teamRecordEnvelope(req.params.get('id') ?? '');
      case '/teams/statistics':
        return teamStatisticsEnvelope(
          Number(req.params.get('league')),
          Number(req.params.get('season')),
          req.params.get('team') ?? ''
        );
      default:
        return { errors: { path: 'unknown' }, response: [] };
    }
  };
  const fetchFn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const parsed = new URL(url);
    const req = { path: parsed.pathname, params: parsed.searchParams };
    const payload = options.respond?.(req, now) ?? defaultRespond(req);
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
    caps: { live: 800, 'near-live': 650, background: 450 },
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
  const availability: IngestAvailabilityRequest[] = [];
  const transfers: IngestTransfersRequest[] = [];
  const trophies: IngestTrophiesRequest[] = [];
  const teamStats: IngestProviderTeamSeasonStatsRequest[] = [];
  const coaches: IngestCoachProfilesRequest[] = [];
  const predictions: IngestProviderPredictionsRequest[] = [];
  const headToHead: IngestHeadToHeadRequest[] = [];
  const venues: IngestVenuesRequest[] = [];
  const accepted = (rows: readonly unknown[]) =>
    ({ acceptedCount: rows.length }) as IngestBatchResponse;
  const ingest: ProviderEnrichmentIngestClient = {
    ingestProviderPlayerSeasonStats: vi.fn(async (r) => accepted(r.rows)),
    ingestAvailability: vi.fn(async (r: IngestAvailabilityRequest) => {
      availability.push(r);
      return accepted(r.rows);
    }),
    ingestTransfers: vi.fn(async (r: IngestTransfersRequest) => {
      transfers.push(r);
      return accepted(r.rows);
    }),
    ingestTrophies: vi.fn(async (r: IngestTrophiesRequest) => {
      trophies.push(r);
      return accepted(r.rows);
    }),
    ingestProviderTeamSeasonStats: vi.fn(async (r: IngestProviderTeamSeasonStatsRequest) => {
      teamStats.push(r);
      return accepted(r.rows);
    }),
    ingestCoachProfiles: vi.fn(async (r: IngestCoachProfilesRequest) => {
      coaches.push(r);
      return accepted(r.rows);
    }),
    ingestProviderPredictions: vi.fn(async (r: IngestProviderPredictionsRequest) => {
      predictions.push(r);
      return accepted(r.rows);
    }),
    ingestHeadToHead: vi.fn(async (r: IngestHeadToHeadRequest) => {
      headToHead.push(r);
      return accepted(r.snapshots);
    }),
    ingestVenues: vi.fn(async (r: IngestVenuesRequest) => {
      venues.push(r);
      return accepted(r.rows);
    }),
    ...options.ingest,
  };
  const enrichment: ProviderEnrichmentDeps | undefined =
    options.enrichment === null
      ? undefined
      : {
          enabledDatasets: options.enabled ?? [
            'injuries-league',
            'player-sidelined',
            'team-transfers',
            'trophies',
            'team-season-stats',
            'team-coaches',
          ],
          ingest,
          limiter: new ProviderMinuteLimiter({
            providerId: 'api-football:enrichment',
            clock: clockMs,
            store: new InMemoryMinuteCounterStore({ clock: clockMs }),
            caps: { live: 120, 'near-live': 120, background: 120 },
          }),
          sleep,
          inFlight: new Set<string>(),
          ...options.enrichment,
        };
  const deps: WorkflowDeps = {
    ingestion: loop,
    competitions: CATALOGUE,
    clock: () => new Date(now),
    enrichment,
  };
  const run = (dataset: ProviderEnrichmentDataset, input: Partial<ProviderEnrichmentInput> = {}) =>
    providerEnrichmentWorkflow(
      { dataset, mode: 'nightly', ...input } as ProviderEnrichmentInput,
      deps
    );
  const seedFixtureLists = async (lists: Record<number, number[] | unknown>) => {
    for (const [league, teams] of Object.entries(lists)) {
      const season = CATALOGUE.find((c) => c.apiFootballLeagueId === Number(league))?.season;
      await cache.set(
        loop.cacheKeyFor('fixtures-next-7d', `league-${league}-season-${season}`),
        Array.isArray(teams) ? fixtureList(teams) : teams,
        6 * 60 * 60
      );
    }
    cacheSet.mockClear();
  };
  const paths = () => urls.map((u) => new URL(u).pathname + new URL(u).search);
  return {
    run,
    deps,
    urls,
    paths,
    fetchFn,
    cache,
    cacheSet,
    reserve,
    acquire,
    ingest,
    availability,
    transfers,
    trophies,
    teamStats,
    coaches,
    predictions,
    headToHead,
    venues,
    advance,
    seedFixtureLists,
    now: () => now,
  };
};

describe('kill switch', () => {
  it.each([
    'injuries-league',
    'player-sidelined',
    'team-transfers',
    'trophies',
    'team-season-stats',
    'team-coaches',
  ] as const)('%s makes no call unless it is listed', async (dataset) => {
    const h = harness({ enabled: ['player-season-stats'] });
    const out = await h.run(dataset, { playerIds: ['1'], teamIds: ['2'] });
    expect(out.status).toBe('disabled');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('is off when enrichment is not wired', async () => {
    const h = harness({ enrichment: null });
    expect((await h.run('injuries-league')).status).toBe('disabled');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('skips without a provider call when the ingest method is missing', async () => {
    const h = harness({ ingest: { ingestTransfers: undefined } });
    const out = await h.run('team-transfers', { teamIds: ['5'] });
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('ingestTransfers');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});

describe('injuries-league', () => {
  it('nightly covers the catalogue leagues with injuries coverage at their catalogue season', async () => {
    const h = harness();
    const out = await h.run('injuries-league');
    expect(out.status).toBe('completed');
    expect(h.paths()).toEqual([
      '/injuries?league=39&season=2026',
      '/injuries?league=88&season=2026',
      '/injuries?league=2&season=2026',
      '/injuries?league=1&season=2026',
    ]);
    expect(out.targets.map((t) => t.unit)).toEqual([
      'league-39-season-2026',
      'league-88-season-2026',
      'league-2-season-2026',
      'league-1-season-2026',
    ]);
    // Jupiler (144) and the FA Cup (45) have no injuries coverage.
    expect(INJURIES_COVERED_LEAGUE_IDS.has(144)).toBe(false);
  });

  it('no season-end gate (D15): a named past season is fetched', () => {
    expect(
      resolveInjuriesTargets({ mode: 'nightly', leagueIds: [88], seasons: [2023] }, CATALOGUE)
    ).toEqual([{ leagueId: 88, season: 2023 }]);
    expect(
      resolveInjuriesTargets(
        { mode: 'full', leagueIds: [88, 39], seasons: [2024, 2025] },
        CATALOGUE
      )
    ).toEqual([
      { leagueId: 88, season: 2025 },
      { leagueId: 39, season: 2025 },
      { leagueId: 88, season: 2024 },
      { leagueId: 39, season: 2024 },
    ]);
  });

  it('refuses a named league outside the catalogue unless allowUncatalogued is set', async () => {
    expect(
      resolveInjuriesTargets({ mode: 'full', leagueIds: [88, 999], seasons: [2025] }, CATALOGUE)
    ).toEqual([{ leagueId: 88, season: 2025 }]);
    expect(resolveInjuriesTargets({ mode: 'nightly', leagueIds: [999] }, CATALOGUE)).toEqual([]);
    const h = harness();
    const out = await h.run('injuries-league', { mode: 'full', leagueIds: [999], seasons: [2025] });
    expect(out.status).toBe('incomplete');
    expect(out.targets).toMatchObject([{ unit: 'league-999', status: 'failed' }]);
    expect(h.fetchFn).not.toHaveBeenCalled();
    const allowed = await h.run('injuries-league', {
      mode: 'full',
      leagueIds: [999],
      seasons: [2025],
      allowUncatalogued: true,
    });
    expect(allowed.status).toBe('completed');
    expect(h.paths()).toEqual(['/injuries?league=999&season=2025']);
  });

  it('parses allowUncatalogued from the request body', () => {
    const parsed = parseProviderEnrichmentInput({
      dataset: 'injuries-league',
      leagueIds: [999],
      allowUncatalogued: true,
    });
    expect(parsed.ok && parsed.input.allowUncatalogued).toBe(true);
    const plain = parseProviderEnrichmentInput({ dataset: 'injuries-league', leagueIds: [999] });
    expect(plain.ok && plain.input.allowUncatalogued).toBeFalsy();
  });

  it('sends one pull as batches of 500 sharing a sync id, final_batch on the last only', async () => {
    const h = harness({
      respond: (req, now) =>
        req.path === '/injuries' ? injuriesEnvelope(88, 2026, ids(1, 1_200), now + DAY) : undefined,
    });
    const out = await h.run('injuries-league', { leagueIds: [88] });
    expect(out.status).toBe('completed');
    expect(out.rowsIngested).toBe(1_200);
    expect(h.availability.map((r) => r.rows.length)).toEqual([500, 500, 200]);
    expect(h.availability.map((r) => r.finalBatch)).toEqual([false, false, true]);
    const syncIds = new Set(h.availability.map((r) => r.syncId));
    expect(syncIds.size).toBe(1);
    for (const request of h.availability) {
      expect(request.replaceScope).toMatchObject({
        providerCompetitionId: '88',
        seasonYear: 2026,
        source: AvailabilitySource.INJURIES,
      });
      expect(timestampMs(request.syncStartedAt!)).toBe(T0);
      expect(request.clearScope).toBe(false);
    }
  });

  it('sends nothing for an empty list, so nothing is deleted', async () => {
    const h = harness({
      respond: (req) => (req.path === '/injuries' ? { errors: [], response: [] } : undefined),
    });
    const out = await h.run('injuries-league', { leagueIds: [88] });
    expect(out.status).toBe('completed');
    expect(h.availability).toHaveLength(0);
  });

  it('upserts without a replace scope when the provider flags errors, and retries next run', async () => {
    const h = harness({
      respond: (req, now) =>
        req.path === '/injuries'
          ? { ...injuriesEnvelope(88, 2026, [1, 2], now + DAY), errors: { bug: 'partial' } }
          : undefined,
    });
    const out = await h.run('injuries-league', { leagueIds: [88] });
    expect(out.targets[0]?.status).toBe('failed');
    expect(h.availability).toHaveLength(1);
    expect(h.availability[0]?.replaceScope).toBeUndefined();
    expect(h.availability[0]?.finalBatch).toBe(false);
    expect(await h.cache.get(unitMarkerKey('injuries-league', 'league-88-season-2026'))).toBe(
      undefined
    );
  });

  it('never sends final_batch after a failed batch', async () => {
    let calls = 0;
    const h = harness({
      respond: (req, now) =>
        req.path === '/injuries' ? injuriesEnvelope(88, 2026, ids(1, 1_200), now + DAY) : undefined,
      ingest: {
        ingestAvailability: vi.fn(async (r: IngestAvailabilityRequest) => {
          calls += 1;
          if (calls === 2) {
            throw new Error('deadline exceeded');
          }
          expect(r.finalBatch).toBe(false);
          return { acceptedCount: r.rows.length } as IngestBatchResponse;
        }),
      },
    });
    const out = await h.run('injuries-league', { leagueIds: [88] });
    expect(calls).toBe(2);
    // The first batch was written; with no final batch nothing is deleted.
    expect(out.targets[0]).toMatchObject({ status: 'failed', rowsIngested: 500 });
    expect(out.status).toBe('incomplete');
  });

  it('is fresh for 2.5h, then pulls again on the next 3-hourly run', async () => {
    const h = harness();
    await h.run('injuries-league', { leagueIds: [88] });
    h.advance(2 * HOUR);
    const retry = await h.run('injuries-league', { leagueIds: [88] });
    expect(retry.targets[0]?.status).toBe('fresh');
    expect(h.urls).toHaveLength(1);
    h.advance(HOUR);
    const next = await h.run('injuries-league', { leagueIds: [88] });
    expect(next.targets[0]?.status).toBe('complete');
    expect(h.urls).toHaveLength(2);
  });

  it('caches no payload: only the unit marker and a small player digest', async () => {
    const h = harness({
      respond: (req, now) =>
        req.path === '/injuries' ? injuriesEnvelope(88, 2026, ids(1, 300), now + DAY) : undefined,
    });
    await h.run('injuries-league', { leagueIds: [88] });
    const keys = h.cacheSet.mock.calls.map((call) => call[0]);
    expect(keys.sort()).toEqual(
      [injuryDigestKey(88, 2026), unitMarkerKey('injuries-league', 'league-88-season-2026')].sort()
    );
    const digest = (await h.cache.get<InjuryPlayerDigest>(injuryDigestKey(88, 2026)))!;
    expect(Object.keys(digest.players)).toHaveLength(300);
    for (const key of keys) {
      expect(key.startsWith('api-football:')).toBe(false);
    }
  });
});

describe('injury player digest', () => {
  it('keeps the latest kickoff per player and drops players past 30 days', () => {
    const now = T0;
    const merged = mergeInjuryDigest(
      { players: { '1': now - 40 * DAY, '2': now - 10 * DAY } },
      [
        { providerPlayerId: '2', fixtureAtMs: now - 20 * DAY },
        { providerPlayerId: '3', fixtureAtMs: now + DAY },
        { providerPlayerId: '4', fixtureAtMs: now - SIDELINED_LOOKBACK_MS - 1 },
      ],
      now
    );
    expect(merged.players).toEqual({ '2': now - 10 * DAY, '3': now + DAY });
  });
});

describe('player-sidelined', () => {
  it('takes its scope from the players injuries listed in the last 30 days', async () => {
    const h = harness({
      respond: (req, now) =>
        req.path === '/injuries'
          ? {
              errors: [],
              response: [
                ...injuriesEnvelope(88, 2026, ids(100, 25), now - 5 * DAY).response,
                ...injuriesEnvelope(88, 2026, [7], now - 45 * DAY).response,
              ],
            }
          : undefined,
    });
    await h.run('injuries-league', { leagueIds: [88] });
    h.urls.length = 0;
    const out = await h.run('player-sidelined');
    expect(out.status).toBe('completed');
    expect(h.paths()).toEqual([
      `/sidelined?players=${ids(100, 20).join('-')}`,
      `/sidelined?players=${ids(120, 5).join('-')}`,
    ]);
    expect(h.availability.slice(-2).every((r) => r.replaceScope === undefined)).toBe(true);
    const rows = h.availability.slice(-2).flatMap((r) => r.rows);
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => r.source === AvailabilitySource.SIDELINED)).toBe(true);
  });

  it('uses explicit playerIds, 20 a call, sorted', async () => {
    const h = harness();
    const out = await h.run('player-sidelined', {
      playerIds: ids(1, 45).reverse().map(String),
    });
    expect(out.callsUsed).toBe(3);
    expect(h.paths()[2]).toBe(`/sidelined?players=${ids(41, 5).join('-')}`);
  });

  it('resumes per player after a stop, however the next scope is batched', async () => {
    const h = harness();
    const first = await h.run('player-sidelined', {
      playerIds: ids(100, 25).map(String),
      limit: 1,
    });
    expect(first.status).toBe('incomplete');
    expect(
      await h.cache.get(unitMarkerKey('player-sidelined', sidelinedMemberKey('100')))
    ).toBeDefined();
    h.urls.length = 0;
    // The scope moved: ten new players sort ahead of the old ones.
    const second = await h.run('player-sidelined', { playerIds: ids(90, 35).map(String) });
    expect(second.status).toBe('completed');
    expect(h.paths()).toEqual([`/sidelined?players=${[...ids(90, 10), ...ids(120, 5)].join('-')}`]);
    h.urls.length = 0;
    const third = await h.run('player-sidelined', { playerIds: ids(90, 35).map(String) });
    expect(third.status).toBe('completed');
    expect(third.reason).toContain('35 players');
    expect(h.urls).toHaveLength(0);
  });

  it('skips when nothing is in scope', async () => {
    const h = harness();
    const out = await h.run('player-sidelined');
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('injuries-league');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});

describe('team-transfers', () => {
  it('scopes to the teams of the cached domestic fixture lists, sorted', async () => {
    const h = harness();
    await h.seedFixtureLists({ 39: [33, 40], 88: [194, 415], 144: [415], 2: [541, 33] });
    const out = await h.run('team-transfers');
    expect(out.status).toBe('completed');
    // The Champions League list (2) is not domestic: 541 is not fetched.
    expect(h.paths()).toEqual([
      '/transfers?team=33',
      '/transfers?team=40',
      '/transfers?team=194',
      '/transfers?team=415',
    ]);
    expect(h.transfers).toHaveLength(4);
    expect(h.transfers[0]?.rows[0]).toMatchObject({
      providerPlayerId: '3300',
      transferDate: '2025-07-01',
      providerTeamInId: '33',
      providerTeamOutId: '9',
      feeText: '€ 5M',
    });
  });

  it('fetches a missing fixture list under the discovery key, then reads it from cache', async () => {
    const h = harness({
      respond: (req) =>
        req.path === '/fixtures'
          ? fixtureList(
              req.params.get('league') === '39'
                ? [33, 40]
                : req.params.get('league') === '88'
                  ? [194]
                  : [3]
            )
          : undefined,
    });
    await h.seedFixtureLists({ 144: [600] });
    const out = await h.run('team-transfers');
    expect(out.status).toBe('completed');
    expect(h.paths()).toEqual([
      '/fixtures?league=39&season=2026',
      '/fixtures?league=88&season=2026',
      '/transfers?team=33',
      '/transfers?team=40',
      '/transfers?team=194',
      '/transfers?team=600',
    ]);
    expect(out.callsUsed).toBe(6);
    // The list is held under the key the live loop's discovery writes, not a new one.
    const key = h.deps.ingestion.cacheKeyFor('fixtures-next-7d', 'league-39-season-2026');
    expect(h.cacheSet.mock.calls.some((call) => call[0] === key)).toBe(true);
    for (const call of h.cacheSet.mock.calls) {
      const name = String(call[0]);
      expect(name.startsWith('enrich:') || name.includes('fixtures-next-7d')).toBe(true);
    }
    h.urls.length = 0;
    h.advance(HOUR);
    await h.run('team-transfers');
    expect(h.paths().filter((p) => p.startsWith('/fixtures'))).toEqual([]);
  });

  it('lists a league without a fixture list as failed and ends incomplete', async () => {
    const h = harness({
      respond: (req) =>
        req.path === '/fixtures'
          ? req.params.get('league') === '88'
            ? { errors: { requests: 'limit' }, response: [] }
            : fixtureList([33, 40])
          : undefined,
    });
    const out = await h.run('team-transfers');
    expect(out.status).toBe('incomplete');
    const gap = out.targets.find((t) => t.unit === 'fixtures-league-88-season-2026');
    expect(gap).toMatchObject({ status: 'failed', leagueId: 88, season: 2026 });
    expect(out.targets.filter((t) => t.status === 'complete').map((t) => t.unit)).toEqual([
      'team-33',
      'team-40',
    ]);
  });

  it('a dry run reports a missing fixture list without fetching it', async () => {
    const h = harness();
    await h.seedFixtureLists({ 39: [33], 144: [600] });
    const out = await h.run('team-transfers', { dryRun: true });
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(out.targets.map((t) => `${t.unit}:${t.status}`)).toEqual([
      'fixtures-league-88-season-2026:failed',
      'team-33:planned',
      'team-600:planned',
    ]);
  });

  it('splits a large team into ingest calls of 500', async () => {
    const h = harness({
      respond: (req) => (req.path === '/transfers' ? transfersEnvelope('5', 1_100) : undefined),
    });
    await h.run('team-transfers', { teamIds: ['5'] });
    expect(h.transfers.map((r) => r.rows.length)).toEqual([500, 500, 100]);
  });

  it('stops at the call limit and resumes with the rest', async () => {
    const h = harness();
    const first = await h.run('team-transfers', { teamIds: ['1', '2', '3'], limit: 2 });
    expect(first.status).toBe('incomplete');
    expect(first.reason).toContain('call limit 2');
    expect(first.targets.map((t) => t.status)).toEqual(['complete', 'complete', 'not-started']);
    const second = await h.run('team-transfers', { teamIds: ['1', '2', '3'], limit: 2 });
    expect(second.status).toBe('completed');
    expect(second.targets.map((t) => t.status)).toEqual(['fresh', 'fresh', 'complete']);
    expect(h.urls).toHaveLength(3);
  });
});

describe('trophies', () => {
  it('fetches a squad, then its players 20 at a time, with names from the squad', async () => {
    const h = harness({ squadSize: 45 });
    const out = await h.run('trophies', { teamIds: ['7'] });
    expect(out.status).toBe('completed');
    expect(h.paths()).toEqual([
      '/players/squads?team=7',
      `/trophies?players=${ids(7000, 20).join('-')}`,
      `/trophies?players=${ids(7020, 20).join('-')}`,
      `/trophies?players=${ids(7040, 5).join('-')}`,
    ]);
    expect(out.targets[0]).toMatchObject({ unit: 'squad-7', pagesFetched: 4, pagesTotal: 4 });
    const rows = h.trophies.flatMap((r) => r.rows);
    expect(rows).toHaveLength(45);
    expect(rows[0]?.subjectSnapshot?.label).toBe('S7000');
  });

  it('covers the teams whose id mod 4 is the partition', async () => {
    const h = harness({ squadSize: 1 });
    await h.seedFixtureLists({ 39: [1, 2, 3, 4], 88: [5, 6, 7, 8], 144: [13] });
    await h.run('trophies', { partition: 1 });
    expect(h.paths().filter((p) => p.startsWith('/players/squads'))).toEqual([
      '/players/squads?team=1',
      '/players/squads?team=5',
      '/players/squads?team=13',
    ]);
  });

  it('keeps a team in its partition when the team list changes', async () => {
    const squads = (h: ReturnType<typeof harness>) =>
      h.paths().filter((p) => p.startsWith('/players/squads'));
    const before = harness({ squadSize: 1 });
    await before.seedFixtureLists({ 39: [1, 2, 3, 4], 88: [5, 6, 7, 8] });
    await before.run('trophies', { partition: 2 });
    // Next week a league is cold and a team is promoted: membership holds.
    const after = harness({ squadSize: 1 });
    await after.seedFixtureLists({ 39: [1, 2, 3, 4, 10] });
    await after.run('trophies', { partition: 2 });
    expect(squads(before)).toEqual(['/players/squads?team=2', '/players/squads?team=6']);
    expect(squads(after)).toEqual(['/players/squads?team=2', '/players/squads?team=10']);
    expect(teamTrophiesPartition('194')).toBe(2);
  });

  it('steps the week counter every Monday, across a 53-week year', () => {
    const monday = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
    // 2026-12-28 is the Monday of ISO week 53, 2027-01-04 of ISO week 1.
    const w53 = trophiesWeek(monday(2026, 12, 28));
    expect(trophiesWeek(monday(2027, 1, 4))).toBe(w53 + 1);
    expect(trophiesWeek(monday(2027, 1, 4) - 1)).toBe(w53);
    expect(trophiesWeek(monday(2026, 12, 28) + 6 * DAY + 23 * HOUR)).toBe(w53);
    expect(trophiesPartition(undefined, monday(2027, 1, 4))).not.toBe(
      trophiesPartition(undefined, monday(2026, 12, 28))
    );
    expect(trophiesPartition(3, T0)).toBe(3);
    expect(trophiesPartition(undefined, T0)).toBe(trophiesWeek(T0) % 4);
  });

  it('packs ingest calls to the server limit of 500 trophies each', async () => {
    const h = harness({
      squadSize: 45,
      respond: (req) =>
        req.path === '/trophies'
          ? trophiesEnvelope((req.params.get('players') ?? '').split('-'), (id) =>
              Number(id) % 2 === 0 ? 70 : 30
            )
          : undefined,
      ingest: {
        // Mirrors game-service validateNestedRows on IngestTrophies.
        ingestTrophies: vi.fn(async (r: IngestTrophiesRequest) => {
          const nested = r.rows.reduce((sum, row) => sum + row.trophies.length, 0);
          if (nested > 500 || r.rows.length > 500) {
            throw new Error(`InvalidArgument: at most 500 trophies per batch, got ${nested}`);
          }
          return { acceptedCount: r.rows.length } as IngestBatchResponse;
        }),
      },
    });
    const out = await h.run('trophies', { teamIds: ['7'] });
    expect(out.status).toBe('completed');
    expect(out.targets[0]).toMatchObject({ status: 'complete', rowsIngested: 45, rowsDropped: 0 });
    // 20 players at 50 on average is 1,000 trophies a provider call: at least 2 ingest calls each.
    expect(vi.mocked(h.ingest.ingestTrophies!).mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('trims one subject over 500 trophies, keeping winners first', async () => {
    const h = harness({
      respond: (req) =>
        req.path === '/trophies'
          ? trophiesEnvelope(['874', '276'], (id) => (id === '874' ? 874 : 10))
          : undefined,
      ingest: {
        ingestTrophies: vi.fn(async (r: IngestTrophiesRequest) => {
          const nested = r.rows.reduce((sum, row) => sum + row.trophies.length, 0);
          if (nested > 500) {
            throw new Error(`InvalidArgument: got ${nested}`);
          }
          h.trophies.push(r);
          return { acceptedCount: r.rows.length } as IngestBatchResponse;
        }),
      },
    });
    const out = await h.run('trophies', { playerIds: ['874', '276'] });
    expect(out.status).toBe('completed');
    const rows = h.trophies.flatMap((r) => r.rows);
    const big = rows.find((row) => row.providerSubjectId === '874')!;
    expect(big.trophies).toHaveLength(MAX_TROPHIES_PER_INGEST);
    // 874 entries, every third a winner: all 292 winners stay.
    expect(big.trophies.filter((t) => t.place === 'Winner')).toHaveLength(292);
    expect(rows.find((row) => row.providerSubjectId === '276')?.trophies).toHaveLength(10);
    expect(out.rowsDropped).toBe(374);
  });

  it('names coaches and players explicitly', async () => {
    const h = harness();
    const out = await h.run('trophies', { playerIds: ['276', '874'], coachIds: ['1', '2'] });
    expect(out.status).toBe('completed');
    expect(h.paths()).toEqual(['/trophies?players=276-874', '/trophies?coachs=1-2']);
    expect(h.trophies.flatMap((r) => r.rows.map((row) => row.providerSubjectId))).toEqual([
      '276',
      '874',
      '1',
      '2',
    ]);
  });

  it('a unit stopped by the limit part way is redone next run', async () => {
    const h = harness({ squadSize: 30 });
    const first = await h.run('trophies', { teamIds: ['7'], limit: 2 });
    expect(first.status).toBe('incomplete');
    expect(first.targets[0]).toMatchObject({ status: 'partial', pagesFetched: 2, pagesTotal: 3 });
    expect(await h.cache.get(unitMarkerKey('trophies', 'squad-7'))).toBeUndefined();
    const second = await h.run('trophies', { teamIds: ['7'] });
    expect(second.targets[0]?.status).toBe('complete');
  });
});

describe('packTrophyRows', () => {
  const row = (id: string, count: number, places: string[] = ['Winner']) =>
    ({
      providerSubjectId: id,
      trophies: Array.from({ length: count }, (_, i) => ({
        competitionName: `C${i}`,
        country: 'X',
        seasonText: '2024',
        place: places[i % places.length]!,
      })),
    }) as unknown as Parameters<typeof packTrophyRows>[0][number];

  it('never splits a subject and never passes 500 trophies a request', () => {
    const rows = [row('1', 300), row('2', 250), row('3', 0), row('4', 200), row('5', 500)];
    const packed = packTrophyRows(rows);
    expect(packed.trimmed).toBe(0);
    expect(packed.batches.map((b) => b.rows.map((r) => r.providerSubjectId))).toEqual([
      ['1'],
      ['2', '3', '4'],
      ['5'],
    ]);
    expect(packed.batches.map((b) => b.start)).toEqual([0, 1, 4]);
  });

  it('drops exact repeats before places other than Winner', () => {
    const repeated = row('9', 400);
    const doubled = {
      ...repeated,
      trophies: [...repeated.trophies, ...repeated.trophies.slice(0, 150)],
    } as typeof repeated;
    const packed = packTrophyRows([doubled]);
    expect(packed.trimmed).toBe(150);
    expect(packed.batches[0]?.rows[0]?.trophies).toHaveLength(400);
  });
});

describe('team-season-stats', () => {
  /** Monday 2026-11-09 03:00 UTC. */
  const MONDAY = '2026-11-09T03:00:00.000Z';
  const seed = (h: ReturnType<typeof harness>) =>
    h.seedFixtureLists({
      39: datedFixtureList([
        { home: 33, away: 40, kickoffMs: T0 - 10 * HOUR, status: 'FT' },
        // Outside the 36h window.
        { home: 41, away: 42, kickoffMs: T0 - 40 * HOUR, status: 'FT' },
        // The cached list is stale: kicked off 3h ago, still shown in play.
        { home: 43, away: 44, kickoffMs: T0 - 3 * HOUR, status: '2H' },
        // In play an hour after kickoff: no final whistle yet.
        { home: 45, away: 46, kickoffMs: T0 - HOUR, status: '1H' },
        { home: 47, away: 48, kickoffMs: T0 - 5 * HOUR, status: 'PST' },
        { home: 49, away: 50, kickoffMs: T0 + DAY, status: 'NS' },
      ]),
      88: datedFixtureList([{ home: 415, away: 194, kickoffMs: T0 - 20 * HOUR, status: 'AET' }]),
      144: datedFixtureList([{ home: 600, away: 601, kickoffMs: T0 + DAY, status: 'NS' }]),
      // Not domestic: never in the scope.
      2: datedFixtureList([{ home: 541, away: 33, kickoffMs: T0 - 5 * HOUR, status: 'FT' }]),
    });

  it('nightly covers the teams with a final whistle in 36h, one call per team in its league', async () => {
    const h = harness();
    await seed(h);
    const out = await h.run('team-season-stats');
    expect(out.status).toBe('completed');
    expect(h.paths()).toEqual([
      '/teams/statistics?league=39&season=2026&team=33',
      '/teams/statistics?league=39&season=2026&team=40',
      '/teams/statistics?league=39&season=2026&team=43',
      '/teams/statistics?league=39&season=2026&team=44',
      '/teams/statistics?league=88&season=2026&team=194',
      '/teams/statistics?league=88&season=2026&team=415',
    ]);
    expect(out.targets.map((t) => t.unit)).toEqual([
      'league-39-season-2026-team-33',
      'league-39-season-2026-team-40',
      'league-39-season-2026-team-43',
      'league-39-season-2026-team-44',
      'league-88-season-2026-team-194',
      'league-88-season-2026-team-415',
    ]);
    expect(out.targets[0]).toMatchObject({ leagueId: 39, season: 2026 });
    expect(h.teamStats).toHaveLength(6);
    expect(h.teamStats[0]?.rows[0]).toMatchObject({
      providerTeamId: '33',
      providerCompetitionId: '39',
      seasonYear: 2026,
      form: 'WDL',
      values: {
        matches_played: 3,
        wins: 1,
        draws: 1,
        losses: 1,
        goals_for: 4,
        goals_against: 3,
        clean_sheets: 1,
      },
    });
    expect(h.teamStats[0]?.rows[0]?.values).not.toHaveProperty('failed_to_score');
    expect(h.teamStats[0]?.metadata?.normalizedBatchId).toBe(
      'api-football:team-season-stats:team-stats-39-2026-33:0'
    );
    // Only "done" markers are written (D9), each with the 20h window.
    expect(h.cacheSet.mock.calls.map((call) => [call[0], call[2]])).toEqual(
      out.targets.map((t) => [unitMarkerKey('team-season-stats', t.unit!), 20 * 60 * 60])
    );
    // A retry inside the window fetches only what is new: 45 v 46 kicked off
    // two hours ago now, so it counts as played even though the list says 1H.
    h.urls.length = 0;
    h.advance(HOUR);
    const again = await h.run('team-season-stats');
    expect(again.targets.filter((t) => t.status !== 'fresh').map((t) => t.unit)).toEqual([
      'league-39-season-2026-team-45',
      'league-39-season-2026-team-46',
    ]);
    expect(h.urls).toHaveLength(2);
  });

  it('reads the final whistle from the cached list without a provider call', () => {
    const list = datedFixtureList([
      { home: 1, away: 2, kickoffMs: T0 - 35 * HOUR, status: 'PEN' },
      { home: 3, away: 4, kickoffMs: T0 - 37 * HOUR, status: 'FT' },
      { home: 5, away: 6, kickoffMs: T0 - 4 * HOUR, status: 'NS' },
      { home: 7, away: 8, kickoffMs: T0 - 4 * HOUR, status: 'CANC' },
      { home: 9, away: 10, kickoffMs: T0 - 90 * 60_000, status: 'FT' },
    ]);
    expect(teamsWithRecentFinalWhistle(list, T0)).toEqual(['1', '2', '5', '6', '9', '10']);
    expect(teamsWithRecentFinalWhistle({ response: 'x' }, T0)).toEqual([]);
  });

  it('covers every domestic team on a Monday and in full mode', async () => {
    expect(teamSeasonStatsCoversAll('nightly', Date.parse(MONDAY))).toBe(true);
    expect(teamSeasonStatsCoversAll('nightly', T0)).toBe(false);
    expect(teamSeasonStatsCoversAll('full', T0)).toBe(true);
    const monday = harness();
    await seed(monday);
    const out = await monday.run('team-season-stats', { nowUtc: MONDAY });
    expect(out.status).toBe('completed');
    const teams = (h: ReturnType<typeof harness>) =>
      h.paths().map((p) => new URLSearchParams(p.split('?')[1]).get('team'));
    expect(teams(monday)).toEqual(
      [33, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 194, 415, 600, 601].map(String)
    );
    const full = harness();
    await seed(full);
    const parsed = parseProviderEnrichmentInput({ dataset: 'team-season-stats', mode: 'full' });
    expect(parsed.ok).toBe(true);
    await full.run('team-season-stats', parsed.ok ? parsed.input : {});
    expect(teams(full)).toEqual(teams(monday));
  });

  it('narrows to named teams and leagues; refuses seasons and unknown leagues', async () => {
    const h = harness();
    await seed(h);
    const out = await h.run('team-season-stats', { teamIds: ['41', '600', '999'] });
    expect(h.paths()).toEqual([
      '/teams/statistics?league=39&season=2026&team=41',
      '/teams/statistics?league=144&season=2026&team=600',
    ]);
    expect(out.status).toBe('completed');
    const byLeague = harness();
    await seed(byLeague);
    const league = await byLeague.run('team-season-stats', { leagueIds: [88, 777] });
    expect(byLeague.paths()).toEqual([
      '/teams/statistics?league=88&season=2026&team=194',
      '/teams/statistics?league=88&season=2026&team=415',
    ]);
    expect(league.status).toBe('incomplete');
    expect(league.targets[0]).toMatchObject({ unit: 'league-777', status: 'failed' });
    expect(parseProviderEnrichmentInput({ dataset: 'team-season-stats', seasons: [2025] })).toEqual(
      { ok: false, reason: 'seasons_not_used_by_dataset' }
    );
    const named = parseProviderEnrichmentInput({ dataset: 'team-season-stats', teamIds: [33] });
    expect(named.ok && named.input.teamIds).toEqual(['33']);
  });

  it('skips with a reason when no team has a recent final whistle', async () => {
    const h = harness();
    await h.seedFixtureLists({
      39: datedFixtureList([{ home: 1, away: 2, kickoffMs: T0 + DAY, status: 'NS' }]),
      88: datedFixtureList([{ home: 3, away: 4, kickoffMs: T0 + DAY, status: 'NS' }]),
      144: datedFixtureList([{ home: 5, away: 6, kickoffMs: T0 + DAY, status: 'NS' }]),
    });
    const out = await h.run('team-season-stats');
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('final whistle');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('completes an empty answer without writing, and fails a provider error', async () => {
    const h = harness({
      respond: (req) =>
        req.path === '/teams/statistics'
          ? req.params.get('team') === '1'
            ? { errors: [], response: [] }
            : { errors: { requests: 'limit' }, response: [] }
          : undefined,
    });
    await h.seedFixtureLists({
      39: datedFixtureList([{ home: 1, away: 2, kickoffMs: T0 - 10 * HOUR, status: 'FT' }]),
    });
    const out = await h.run('team-season-stats', { leagueIds: [39] });
    expect(out.status).toBe('incomplete');
    expect(out.targets.map((t) => `${t.unit}:${t.status}`)).toEqual([
      'league-39-season-2026-team-1:complete',
      'league-39-season-2026-team-2:failed',
    ]);
    expect(h.teamStats).toEqual([]);
  });

  it('skips without a provider call when the ingest method is missing', async () => {
    const h = harness({ ingest: { ingestProviderTeamSeasonStats: undefined } });
    await seed(h);
    const out = await h.run('team-season-stats');
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('ingestProviderTeamSeasonStats');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});

describe('team-coaches', () => {
  it('fetches every domestic and national team once and writes each coach with its career', async () => {
    const h = harness();
    await h.seedFixtureLists({
      39: [33, 40],
      88: [194],
      144: [194],
      2: [541],
      1: [10, 25],
      10: [77],
    });
    const out = await h.run('team-coaches');
    expect(out.status).toBe('completed');
    // The Champions League list (2) is neither domestic nor international, and
    // friendlies (10) are class none: 541 and 77 are not fetched. The World
    // Cup's national teams (1) are.
    expect(h.paths()).toEqual([
      '/coachs?team=10',
      '/coachs?team=25',
      '/coachs?team=33',
      '/coachs?team=40',
      '/coachs?team=194',
    ]);
    expect(h.coaches).toHaveLength(5);
    // Each batch names the team whose whole list it is.
    expect(h.coaches.map((r) => r.providerTeamId)).toEqual(['10', '25', '33', '40', '194']);
    h.coaches.splice(0, 2);
    const rows = h.coaches[0]!.rows;
    expect(rows.map((r) => [r.providerCoachId, r.currentProviderTeamId])).toEqual([
      ['331', ''],
      ['332', '33'],
    ]);
    expect(rows[1]!.career.map((c) => c.providerTeamId)).toEqual(['33', '9']);
    expect(h.coaches[0]!.metadata?.normalizedBatchId).toBe('api-football:team-coaches:team-33:0');
  });

  it('is fresh for 20 hours, then fetches every team again', async () => {
    const h = harness();
    await h.run('team-coaches', { teamIds: ['33'] });
    h.advance(19 * HOUR);
    await h.run('team-coaches', { teamIds: ['33'] });
    expect(h.paths()).toEqual(['/coachs?team=33']);
    h.advance(2 * HOUR);
    await h.run('team-coaches', { teamIds: ['33'] });
    expect(h.paths()).toEqual(['/coachs?team=33', '/coachs?team=33']);
  });

  it('takes named teams and refuses player and coach ids', async () => {
    const h = harness();
    expect((await h.run('team-coaches', { teamIds: ['50', '7'] })).status).toBe('completed');
    expect(h.paths()).toEqual(['/coachs?team=7', '/coachs?team=50']);
    expect(parseProviderEnrichmentInput({ dataset: 'team-coaches', teamIds: [7] }).ok).toBe(true);
    expect(parseProviderEnrichmentInput({ dataset: 'team-coaches', coachIds: [7] })).toEqual({
      ok: false,
      reason: 'ids_not_used_by_dataset',
    });
  });

  it('writes a vacant team: every coach, none current, with the fetch time', async () => {
    const h = harness({
      respond: (req) =>
        req.path === '/coachs'
          ? {
              errors: [],
              response: [
                {
                  id: 25762,
                  name: 'M. Carrick',
                  career: [
                    {
                      team: { id: 33, name: 'Manchester United' },
                      start: '2025-08-01',
                      end: '2026-11-01',
                    },
                  ],
                },
              ],
            }
          : undefined,
    });
    const out = await h.run('team-coaches', { teamIds: ['33'] });
    expect(out.status).toBe('completed');
    expect(h.coaches).toHaveLength(1);
    const [row] = h.coaches[0]!.rows;
    expect(row).toMatchObject({ providerCoachId: '25762', currentProviderTeamId: '' });
    expect(row!.career[0]).toMatchObject({ endDate: '2026-11-01' });
    expect(row!.fetchedAt).toBeDefined();
  });

  it('keeps stored profiles on an empty answer, and fails a provider error', async () => {
    const h = harness({
      respond: (req) =>
        req.path === '/coachs'
          ? req.params.get('team') === '1'
            ? { errors: [], response: [] }
            : { errors: { requests: 'limit' }, response: [] }
          : undefined,
    });
    const out = await h.run('team-coaches', { teamIds: ['1', '2'] });
    expect(out.status).toBe('incomplete');
    expect(out.targets.map((t) => `${t.unit}:${t.status}`)).toEqual([
      'team-1:complete',
      'team-2:failed',
    ]);
    expect(h.coaches).toEqual([]);
  });

  it('skips without a provider call when the ingest method is missing', async () => {
    const h = harness({ ingest: { ingestCoachProfiles: undefined } });
    const out = await h.run('team-coaches', { teamIds: ['5'] });
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('ingestCoachProfiles');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});

describe('shared guards', () => {
  it('spends every call at background priority with the cache bypassed', async () => {
    const h = harness();
    await h.run('trophies', { playerIds: ['1'] });
    await h.run('team-transfers', { teamIds: ['5'] });
    await h.seedFixtureLists({ 39: [33, 40] });
    await h.run('team-season-stats', { teamIds: ['33'], leagueIds: [39] });
    expect(h.reserve).toHaveBeenCalledTimes(3);
    for (const call of h.reserve.mock.calls) {
      expect(call[2]).toBe('background');
    }
    for (const call of h.acquire.mock.calls) {
      expect(call[0]).toBe('background');
    }
    for (const call of h.cacheSet.mock.calls) {
      expect(String(call[0]).startsWith('enrich:')).toBe(true);
    }
  });

  it('stops as incomplete at the background daily cap', async () => {
    const h = harness({ backgroundDailyCap: 2 });
    const out = await h.run('team-transfers', { teamIds: ['1', '2', '3', '4'] });
    expect(out.status).toBe('incomplete');
    expect(out.callsUsed).toBeLessThanOrEqual(2);
    expect(out.degradeFlags.some((f) => f.trigger === 'background-cap')).toBe(true);
  });

  it('aborts at the hard cap', async () => {
    const h = harness({ hardCap: 2, softCap: 2, backgroundDailyCap: 2 });
    const out = await h.run('team-transfers', { teamIds: ['1', '2', '3', '4'] });
    expect(out.status).toBe('aborted');
    expect(h.urls).toHaveLength(2);
  });

  it('aborts after three failed units in a row', async () => {
    const h = harness({
      respond: (req) =>
        req.path === '/transfers' ? { errors: { token: 'bad' }, response: [] } : undefined,
    });
    const out = await h.run('team-transfers', { teamIds: ['1', '2', '3', '4', '5'] });
    expect(out.status).toBe('aborted');
    expect(out.targets.map((t) => t.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'not-started',
      'not-started',
    ]);
    expect(h.urls).toHaveLength(3);
  });

  it('reports a unit another run holds as in-progress', async () => {
    const inFlight = new Set(['team-transfers:team-1']);
    const h = harness({ enrichment: { inFlight } });
    const out = await h.run('team-transfers', { teamIds: ['1', '2'] });
    expect(out.targets.map((t) => t.status)).toEqual(['in-progress', 'complete']);
    expect(h.paths()).toEqual(['/transfers?team=2']);
    expect([...inFlight]).toEqual(['team-transfers:team-1']);
  });

  it('plans without calls on a dry run', async () => {
    const h = harness();
    const out = await h.run('injuries-league', { dryRun: true });
    expect(out.targets.every((t) => t.status === 'planned')).toBe(true);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(providerEnrichmentToWire(out).targets[0]).toMatchObject({
      unit: 'league-39-season-2026',
    });
  });

  it('defaults the per-run limit by dataset', () => {
    expect(clampEnrichmentLimit(undefined, 'injuries-league')).toBe(
      DEFAULT_UNIT_MAX_CALLS_PER_RUN['injuries-league']
    );
    expect(clampEnrichmentLimit(undefined, 'trophies')).toBe(
      DEFAULT_UNIT_MAX_CALLS_PER_RUN.trophies
    );
    expect(clampEnrichmentLimit(7, 'trophies')).toBe(7);
    expect(clampEnrichmentLimit(undefined, 'team-season-stats')).toBe(500);
  });
});

/**
 * Every catalogue league's cached list: `lists` where given, else one long
 * finished fixture (no venue), so the pre-match scope reads every league from
 * cache as it does right after a discovery sweep.
 */
const withQuietLists = (now: number, lists: Record<number, unknown>) => {
  const out: Record<number, unknown> = {};
  for (const c of CATALOGUE) {
    out[c.apiFootballLeagueId] =
      lists[c.apiFootballLeagueId] ??
      preMatchList([{ id: 1, home: 900, away: 901, kickoffMs: now - 30 * DAY, status: 'FT' }]);
  }
  return out;
};

describe('fixture-predictions', () => {
  const lists = (now: number) => ({
    39: preMatchList([
      { id: 101, home: 40, away: 33, kickoffMs: now + 30 * HOUR },
      { id: 102, home: 1, away: 2, kickoffMs: now + 60 * HOUR },
      { id: 103, home: 3, away: 4, kickoffMs: now + 10 * HOUR, status: 'PST' },
      { id: 104, home: 5, away: 6, kickoffMs: now - HOUR, status: 'FT' },
    ]),
    // Friendlies are enrichment class none (owner D3): never asked.
    10: preMatchList([{ id: 201, home: 7, away: 8, kickoffMs: now + 5 * HOUR }]),
  });

  it('asks once inside 48h and once inside 3h, never for a called-off or other-class fixture', async () => {
    const h = harness({ enabled: ['fixture-predictions'] });
    const t0 = h.now();
    // Discovery rewrites the lists every sweep; the kickoffs stay put.
    const sweep = () => h.seedFixtureLists(withQuietLists(t0, lists(t0)));
    await sweep();
    const first = await h.run('fixture-predictions');
    expect(first.status).toBe('completed');
    expect(h.paths()).toEqual(['/predictions?fixture=101']);
    expect(first.targets.map((t) => t.unit)).toEqual(['fixture-101-shot-1']);

    // 20h on: 101's shot 1 is fresh; 102 has entered the 48h window.
    h.advance(20 * HOUR);
    await sweep();
    await h.run('fixture-predictions');
    expect(h.paths()).toEqual(['/predictions?fixture=101', '/predictions?fixture=102']);

    // Inside 3h: the second and last shot.
    h.advance(8 * HOUR);
    await sweep();
    await h.run('fixture-predictions');
    h.advance(HOUR);
    await sweep();
    await h.run('fixture-predictions');
    expect(h.paths()).toEqual([
      '/predictions?fixture=101',
      '/predictions?fixture=102',
      '/predictions?fixture=101',
    ]);

    const row = h.predictions[0]!.rows[0]!;
    expect([row.homeWinPct, row.drawPct, row.awayWinPct]).toEqual([45, 45, 10]);
    expect(row.providerWinnerTeamId).toBe('33');
    expect([row.goalsHomeLine, row.goalsAwayLine]).toEqual(['-1.5', '-2.5']);
    expect(Object.keys(row.payload ?? {}).sort()).toEqual(['comparison', 'predictions']);
    expect(h.predictions[0]!.metadata?.normalizedBatchId).toBe(
      'api-football:fixture-predictions:predictions-101:0'
    );
    // head-to-head is off: the meetings in the response are not written.
    expect(h.headToHead).toHaveLength(0);
  });

  it('stores the pair meetings from the same response when head-to-head is on, so head-to-head asks nothing', async () => {
    const h = harness({ enabled: ['fixture-predictions', 'head-to-head'] });
    await h.seedFixtureLists(withQuietLists(h.now(), lists(h.now())));
    await h.run('fixture-predictions');
    expect(h.headToHead).toHaveLength(1);
    const snapshot = h.headToHead[0]!.snapshots[0]!;
    expect([snapshot.providerTeamLowId, snapshot.providerTeamHighId]).toEqual(['33', '40']);
    expect(snapshot.meetings.map((m) => m.providerFixtureId)).toEqual(['2', '1']);
    expect(snapshot.meetings[0]!.refereeName).toBe('A. Referee');

    const pair = await h.run('head-to-head');
    expect(pair.targets.map((t) => [t.unit, t.status])).toEqual([['pair-33-40', 'fresh']]);
    expect(h.paths()).toEqual(['/predictions?fixture=101']);
  });

  it('runs the pre-match datasets in order, only those switched on', async () => {
    const h = harness({ enabled: ['fixture-predictions', 'head-to-head'] });
    await h.seedFixtureLists(withQuietLists(h.now(), lists(h.now())));
    const outputs = await runPreMatchEnrichment(h.deps);
    expect(outputs.map((o) => o.dataset)).toEqual(['fixture-predictions', 'head-to-head']);
    expect(h.paths()).toEqual(['/predictions?fixture=101']);
  });

  it('takes named fixtures and refuses them on other datasets', async () => {
    const h = harness({ enabled: ['fixture-predictions'] });
    await h.seedFixtureLists(withQuietLists(h.now(), lists(h.now())));
    await h.run('fixture-predictions', { fixtureIds: ['999'] });
    expect(h.paths()).toEqual([]);
    expect(
      parseProviderEnrichmentInput({ dataset: 'fixture-predictions', fixtureIds: [101] }).ok
    ).toBe(true);
    expect(parseProviderEnrichmentInput({ dataset: 'trophies', fixtureIds: [101] })).toEqual({
      ok: false,
      reason: 'ids_not_used_by_dataset',
    });
  });
});

describe('head-to-head', () => {
  it('asks once per pair, low id first, and is fresh for 7 days', async () => {
    const h = harness({ enabled: ['head-to-head'] });
    await h.seedFixtureLists(
      withQuietLists(h.now(), {
        39: preMatchList([
          { id: 101, home: 40, away: 33, kickoffMs: h.now() + 30 * HOUR },
          // The reverse fixture of the same pair inside the window: one call.
          { id: 105, home: 33, away: 40, kickoffMs: h.now() + 40 * HOUR },
        ]),
      })
    );
    await h.run('head-to-head');
    expect(h.paths()).toEqual(['/fixtures/headtohead?h2h=33-40&last=10']);
    expect(headToHeadUnitKey('40', '33')).toBe('pair-33-40');
    expect(h.headToHead[0]!.snapshots[0]!.meetings).toHaveLength(1);
    h.advance(6 * DAY);
    await h.seedFixtureLists(
      withQuietLists(h.now(), {
        39: preMatchList([{ id: 106, home: 40, away: 33, kickoffMs: h.now() + 30 * HOUR }]),
      })
    );
    await h.run('head-to-head');
    expect(h.paths()).toHaveLength(1);
  });
});

describe('venue-detail', () => {
  it('asks each catalogue team record once, then not for 90 days, linking its home ground', async () => {
    const h = harness({ enabled: ['venue-detail'] });
    const lists = {
      39: preMatchList([{ id: 101, home: 68, away: 33, kickoffMs: h.now() - 5 * DAY, venue: 489 }]),
      1: preMatchList([{ id: 102, home: 10, away: 3, kickoffMs: h.now() + DAY, venue: 566 }]),
      10: preMatchList([{ id: 201, home: 7, away: 8, kickoffMs: h.now() + DAY, venue: 99 }]),
    };
    await h.seedFixtureLists(withQuietLists(h.now(), lists));
    await h.run('venue-detail');
    const teams = h.paths().filter((p) => p.startsWith('/teams'));
    // Every team in an enriched list, friendlies (10, class none) left out,
    // and team records before venue records.
    expect(teams).toEqual(['3', '10', '33', '68', '900', '901'].map((id) => `/teams?id=${id}`));
    expect(h.paths().indexOf('/teams?id=901')).toBeLessThan(h.paths().indexOf('/venues?id=489'));
    const england = h.venues.flatMap((r) => r.rows).find((r) => r.homeProviderTeamId === '10')!;
    expect([england.providerVenueId, england.name, england.country, england.capacity]).toEqual([
      '5010',
      'Home of 10',
      'England',
      28_723,
    ]);
    const before = h.paths().length;
    h.advance(89 * DAY);
    await h.seedFixtureLists(withQuietLists(h.now(), lists));
    await h.run('venue-detail');
    expect(h.paths()).toHaveLength(before);
    h.advance(2 * DAY);
    await h.run('venue-detail', { teamIds: ['68'] });
    expect(h.paths().slice(before)).toEqual(['/teams?id=68']);
    expect(parseProviderEnrichmentInput({ dataset: 'venue-detail', teamIds: [68] }).ok).toBe(true);
  });

  it('writes nothing for a team record without a venue id', async () => {
    const h = harness({
      enabled: ['venue-detail'],
      respond: (req) =>
        req.path === '/teams'
          ? {
              errors: [],
              response: [{ team: { id: 70, name: 'Team 70' }, venue: { id: null, name: null } }],
            }
          : undefined,
    });
    const out = await h.run('venue-detail', { teamIds: ['70'] });
    expect(out.status).toBe('completed');
    expect(h.paths()).toEqual(['/teams?id=70']);
    expect(h.venues).toHaveLength(0);
  });

  it('asks each catalogue venue once, then not for 90 days, and skips class none', async () => {
    const h = harness({ enabled: ['venue-detail'] });
    const lists = {
      39: preMatchList([
        { id: 101, home: 40, away: 33, kickoffMs: h.now() - 5 * DAY, venue: 556 },
        { id: 102, home: 1, away: 2, kickoffMs: h.now() + DAY, venue: 1288 },
        { id: 103, home: 3, away: 4, kickoffMs: h.now() + DAY },
      ]),
      88: preMatchList([{ id: 104, home: 5, away: 6, kickoffMs: h.now() + DAY, venue: 556 }]),
      10: preMatchList([{ id: 201, home: 7, away: 8, kickoffMs: h.now() + DAY, venue: 99 }]),
    };
    await h.seedFixtureLists(withQuietLists(h.now(), lists));
    await h.run('venue-detail');
    const venuePaths = () => h.paths().filter((p) => p.startsWith('/venues'));
    expect(venuePaths()).toEqual(['/venues?id=556', '/venues?id=1288']);
    const row = h.venues.flatMap((r) => r.rows).find((r) => r.homeProviderTeamId === '')!;
    expect([row.providerVenueId, row.capacity, row.surface, row.city]).toEqual([
      '556',
      12_815,
      'grass',
      'City',
    ]);
    h.advance(89 * DAY);
    await h.seedFixtureLists(withQuietLists(h.now(), lists));
    await h.run('venue-detail');
    expect(venuePaths()).toHaveLength(2);
    h.advance(2 * DAY);
    await h.run('venue-detail', { venueIds: ['556'] });
    expect(venuePaths()).toEqual(['/venues?id=556', '/venues?id=1288', '/venues?id=556']);
  });

  it('reads venue ids from a cached fixture list', () => {
    const fixtures = fixturesFromListEnvelope(
      preMatchList([{ id: 7, home: 1, away: 2, kickoffMs: T0, venue: 42 }])
    );
    expect(fixtures).toEqual([
      {
        fixtureId: '7',
        kickoffMs: T0,
        status: 'NS',
        homeTeamId: '1',
        awayTeamId: '2',
        venueId: '42',
      },
    ]);
  });
});

describe('coach trophies', () => {
  it('adds one call for the coaches team-coaches listed, only with coach-trophies on', async () => {
    const h = harness({
      enabled: ['team-coaches', 'trophies', 'coach-trophies'] as never,
      squadSize: 2,
    });
    await h.run('team-coaches', { teamIds: ['33'] });
    expect(await h.cache.get(teamCoachsDigestKey('33'))).toEqual({ coachIds: ['331', '332'] });
    const out = await h.run('trophies', { teamIds: ['33'] });
    expect(out.targets[0]).toMatchObject({ unit: 'squad-33', pagesFetched: 3, pagesTotal: 3 });
    expect(h.paths().slice(1)).toEqual([
      '/players/squads?team=33',
      '/trophies?players=33000-33001',
      '/trophies?coachs=331-332',
    ]);
    const coachRows = h.trophies
      .flatMap((r) => r.rows)
      .filter((r) => r.subjectType === SubjectType.COACH);
    expect(coachRows.map((r) => r.providerSubjectId)).toEqual(['331', '332']);
  });

  it('asks no coach without the switch, or before team-coaches listed any', async () => {
    const off = harness({ squadSize: 2 });
    await off.run('team-coaches', { teamIds: ['33'] });
    await off.run('trophies', { teamIds: ['33'] });
    expect(off.paths().some((p) => p.includes('coachs='))).toBe(false);

    const unlisted = harness({ enabled: ['trophies', 'coach-trophies'] as never, squadSize: 2 });
    await unlisted.run('trophies', { teamIds: ['33'] });
    expect(unlisted.paths()).toEqual(['/players/squads?team=33', '/trophies?players=33000-33001']);
  });
});
