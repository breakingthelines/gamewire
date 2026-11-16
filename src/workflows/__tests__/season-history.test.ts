import { describe, expect, it, vi } from 'vitest';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';

import { InMemoryProviderCache } from '../../worker/cache.js';
import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import { seasonBackfillWorkflow } from '../season-backfill.js';
import {
  HISTORY_DONE_TTL_SECONDS,
  HISTORY_LIST_WORKLOAD,
  HISTORY_REPLAY_PREFIX,
  historyDoneKey,
  historyReplayId,
  historySeasonProviderId,
  historyStandingsDoneKey,
} from '../season-history.js';
import type { SeasonBackfillInput, WorkflowDeps } from '../types.js';
import premiership2014 from './testdata/season-history/premiership-179-2014-trimmed.json' with { type: 'json' };

const LEAGUE = 179;
const SEASON = 2014;
const LIST_TEAMS = new Set(
  premiership2014.response.flatMap((item) => [
    String(item.teams.home.id),
    String(item.teams.away.id),
  ])
);
const FIRST_TEAM = String(premiership2014.response[0]!.teams.home.id);

const quota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-11-16',
  calls: 100,
  softCap: 60_000,
  hardCap: 70_000,
  cachedOnlyMode: false,
  posture: 'normal',
  ...overrides,
});

const standingsEnvelope = (leagueId: number, season: number) => ({
  response: [
    {
      league: {
        id: leagueId,
        name: 'Premiership',
        season,
        standings: [
          [
            {
              rank: 1,
              team: { id: 247, name: 'Celtic' },
              points: 92,
              goalsDiff: 67,
              group: 'Premiership',
              all: { played: 38, win: 29, draw: 5, lose: 4, goals: { for: 84, against: 17 } },
            },
          ],
        ],
      },
    },
  ],
});

interface Harness {
  readonly deps: WorkflowDeps;
  readonly calls: IngestionFetchOptions[];
  readonly ingestGames: ReturnType<typeof vi.fn>;
  readonly ingestFootballStandings: ReturnType<typeof vi.fn>;
  readonly lookupGameByFixture: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
  readonly onFixtureFetched: ReturnType<typeof vi.fn>;
  readonly state: InMemoryProviderCache;
}

interface HarnessOptions {
  readonly unresolvedSeasons?: ReadonlySet<string>;
  readonly unresolvedCompetitions?: ReadonlySet<string>;
  readonly unresolvedTeams?: ReadonlySet<string>;
  readonly heldFixtures?: ReadonlySet<string>;
  readonly ingestGamesError?: Error;
  readonly status?: (options: IngestionFetchOptions) => IngestionFetchResult['status'];
}

const harness = (options: HarnessOptions = {}): Harness => {
  const calls: IngestionFetchOptions[] = [];
  const state = new InMemoryProviderCache();
  const fetchWorkload = vi.fn(
    async (opts: IngestionFetchOptions): Promise<IngestionFetchResult> => {
      calls.push(opts);
      const status = options.status?.(opts) ?? 'fetched';
      const match = /league=(\d+)&season=(\d+)/.exec(opts.path ?? '');
      const leagueId = Number(match?.[1]);
      const season = Number(match?.[2]);
      const data =
        opts.workload === 'competition-standings'
          ? standingsEnvelope(leagueId, season)
          : leagueId === LEAGUE && season === SEASON
            ? premiership2014
            : { response: [] };
      return {
        status,
        workload: opts.workload,
        resourceId: opts.resourceId,
        cacheKey: `${opts.workload}:${opts.resourceId}`,
        cacheHit: false,
        cachedOnlyMode: false,
        quota: quota(),
        data: status === 'fetched' ? data : undefined,
      };
    }
  );
  const resolve = vi.fn(async (req: { entityType: EntityType; providerId: string }) => {
    if (req.entityType === EntityType.SEASON) {
      return options.unresolvedSeasons?.has(req.providerId)
        ? { found: false, entityId: '' }
        : { found: true, entityId: `btl_football_season_${req.providerId}` };
    }
    if (req.entityType === EntityType.COMPETITION) {
      return options.unresolvedCompetitions?.has(req.providerId)
        ? { found: false, entityId: '' }
        : { found: true, entityId: `btl_football_competition_${req.providerId}` };
    }
    return options.unresolvedTeams?.has(req.providerId)
      ? { found: false, entityId: '' }
      : { found: true, entityId: `btl_football_team_${req.providerId}` };
  });
  const ingestGames = vi.fn(async (request: { games: unknown[] }) => {
    if (options.ingestGamesError) {
      throw options.ingestGamesError;
    }
    return { acceptedCount: request.games.length, updatedCount: 0, replayId: '' };
  });
  const ingestFootballStandings = vi.fn(async () => ({
    acceptedCount: 1,
    updatedCount: 0,
    replayId: '',
  }));
  const lookupGameByFixture = vi.fn(async (req: { providerFixtureId: string }) =>
    options.heldFixtures?.has(req.providerFixtureId)
      ? { found: true, gameId: `game-${req.providerFixtureId}` }
      : { found: false, gameId: '' }
  );
  const observe = vi.fn();
  const onFixtureFetched = vi.fn();
  const deps: WorkflowDeps = {
    ingestion: {
      fetchWorkload,
      cache: new InMemoryProviderCache(),
    } as unknown as ApiFootballIngestionLoop,
    competitions: [],
    identity: { resolve } as unknown as WorkflowDeps['identity'],
    gameService: { ingestGames, ingestFootballStandings } as unknown as WorkflowDeps['gameService'],
    gameLookup: { lookupGameByFixture } as unknown as WorkflowDeps['gameLookup'],
    publisher: { observe } as unknown as WorkflowDeps['publisher'],
    onFixtureFetched,
    stateStore: state,
    sleep: async () => undefined,
  };
  return {
    deps,
    calls,
    ingestGames,
    ingestFootballStandings,
    lookupGameByFixture,
    observe,
    onFixtureFetched,
    state,
  };
};

const target = (leagueId = LEAGUE, season = SEASON) => ({ apiFootballLeagueId: leagueId, season });

const history = (h: Harness, input: Partial<SeasonBackfillInput> = {}) =>
  seasonBackfillWorkflow({ targets: [target()], resultsOnly: true, ...input }, h.deps);

describe('season-backfill history mode: contract', () => {
  it('pins the replay id prefix game-service reads as historical', () => {
    expect(HISTORY_REPLAY_PREFIX).toBe('history:');
    expect(historyReplayId(179, 2014)).toBe('history:api-football:179:2014');
  });

  it('asks identity for the season the way game-service binds it', () => {
    // game-service: provider:api-football:season:<league>:<year> is resolved as
    // Resolve(SEASON, "api-football", "season:<league>:<year>").
    expect(historySeasonProviderId(39, 2010)).toBe('season:39:2010');
  });

  it('keeps done markers for 30 days under backfill:history keys', () => {
    expect(historyDoneKey(179, 2014)).toBe('backfill:history:179:2014');
    expect(historyStandingsDoneKey(179, 2014)).toBe('backfill:history-standings:179:2014');
    expect(HISTORY_DONE_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe('season-backfill history mode: results only', () => {
  it('lists, ingests the list as history, stores standings, and marks the target done', async () => {
    const h = harness();
    const result = await history(h);

    expect(result.status).toBe('complete');
    expect(result.callsBudgeted).toBe(2);
    expect(h.calls.map((c) => [c.workload, c.path, c.cache])).toEqual([
      [HISTORY_LIST_WORKLOAD, '/fixtures?league=179&season=2014', 'bypass'],
      ['competition-standings', '/standings?league=179&season=2014', 'bypass'],
    ]);

    expect(h.ingestGames).toHaveBeenCalledTimes(1);
    const request = h.ingestGames.mock.calls[0]![0] as {
      metadata: { replayId: string };
      games: unknown[];
    };
    expect(request.metadata.replayId).toBe('history:api-football:179:2014');
    expect(request.games).toHaveLength(premiership2014.response.length);
    expect(h.ingestFootballStandings).toHaveBeenCalledTimes(1);

    const t = result.targets[0]!;
    expect(t.complete).toBe(true);
    expect(t.history).toMatchObject({
      mode: 'results-only',
      state: 'done',
      seasonId: 'btl_football_season_season:179:2014',
      competitionId: 'btl_football_competition_179',
      plannedCalls: 2,
      fixturesListed: 12,
      fixturesFinalised: 12,
      teams: LIST_TEAMS.size,
      unresolvedTeams: [],
      heldFixtureIds: [],
      gamesSent: 12,
      gamesAccepted: 12,
      gamesUpdated: 0,
      standingsTables: 1,
    });
    expect(result.history).toEqual({ done: 1, alreadyDone: 0, held: 0, pending: 0, planned: 0 });
    expect(await h.state.get(historyDoneKey(LEAGUE, SEASON))).toBeDefined();
  });

  it('never publishes a match-concluded fact or pulls fixture detail', async () => {
    const h = harness();
    await history(h);
    expect(h.observe).not.toHaveBeenCalled();
    // The workflow never drives the bridge callback itself, and neither of its
    // workloads is a bridge workload (asserted in ingestion.test.ts).
    expect(h.onFixtureFetched).not.toHaveBeenCalled();
    expect(
      h.calls.some(
        (c) => c.workload.startsWith('fixture-detail') || c.workload === 'fixtures-next-7d'
      )
    ).toBe(false);
  });

  it('spends 0 calls on a finished target', async () => {
    const h = harness();
    await history(h);
    h.calls.length = 0;
    const again = await history(h);
    expect(h.calls).toHaveLength(0);
    expect(again.callsBudgeted).toBe(0);
    expect(again.status).toBe('complete');
    expect(again.targets[0]!.history?.state).toBe('already-done');
    expect(h.ingestGames).toHaveBeenCalledTimes(1);
  });

  it('skips an unresolved season with no call and no marker', async () => {
    const h = harness({ unresolvedSeasons: new Set(['season:179:2014']) });
    const result = await history(h);
    expect(h.calls).toHaveLength(0);
    expect(result.status).toBe('incomplete');
    expect(result.targets[0]!.errors).toEqual(['season-unresolved']);
    expect(result.targets[0]!.history).toMatchObject({
      state: 'held',
      reason: 'season-unresolved',
    });
    expect(await h.state.get(historyDoneKey(LEAGUE, SEASON))).toBeUndefined();
  });

  it('skips an unresolved competition with no call', async () => {
    const h = harness({ unresolvedCompetitions: new Set(['179']) });
    const result = await history(h);
    expect(h.calls).toHaveLength(0);
    expect(result.targets[0]!.errors).toEqual(['competition-unresolved']);
  });

  it('holds a target with an unresolved team and ingests nothing', async () => {
    const h = harness({ unresolvedTeams: new Set([FIRST_TEAM]) });
    const result = await history(h);
    expect(h.calls.map((c) => c.workload)).toEqual([HISTORY_LIST_WORKLOAD]);
    expect(h.ingestGames).not.toHaveBeenCalled();
    expect(h.ingestFootballStandings).not.toHaveBeenCalled();
    const t = result.targets[0]!;
    expect(t.complete).toBe(false);
    expect(t.history?.state).toBe('held');
    expect(t.history?.reason).toBe('teams-unresolved');
    expect(t.history?.unresolvedTeams).toEqual([
      `${FIRST_TEAM}:${premiership2014.response[0]!.teams.home.name}`,
    ]);
    expect(await h.state.get(historyDoneKey(LEAGUE, SEASON))).toBeUndefined();
  });

  it('ingests despite unresolved teams when allowUnresolvedTeams is set', async () => {
    const h = harness({ unresolvedTeams: new Set([FIRST_TEAM]) });
    const result = await history(h, { allowUnresolvedTeams: true });
    expect(h.ingestGames).toHaveBeenCalledTimes(1);
    expect(result.targets[0]!.history?.state).toBe('done');
  });

  it('holds a season BTL already holds and ingests nothing', async () => {
    const lastId = String(premiership2014.response.at(-1)!.fixture.id);
    const h = harness({ heldFixtures: new Set([lastId]) });
    const result = await history(h);
    expect(h.lookupGameByFixture).toHaveBeenCalledTimes(3);
    expect(h.ingestGames).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(result.targets[0]!.history).toMatchObject({
      state: 'held',
      reason: 'season-already-held',
      heldFixtureIds: [lastId],
    });
  });

  it('leaves the target pending when IngestGames fails', async () => {
    const h = harness({ ingestGamesError: new Error('unavailable') });
    const result = await history(h);
    expect(h.calls).toHaveLength(1);
    expect(result.targets[0]!.history?.state).toBe('pending');
    expect(result.targets[0]!.errors).toEqual(['IngestGames:unavailable']);
    expect(await h.state.get(historyDoneKey(LEAGUE, SEASON))).toBeUndefined();
  });

  it('starts a target only when the budget covers both calls', async () => {
    const h = harness();
    const result = await seasonBackfillWorkflow(
      { targets: [target(), target(LEAGUE, 2015)], resultsOnly: true, maxCallsPerRun: 3 },
      h.deps
    );
    expect(h.calls).toHaveLength(2);
    expect(result.status).toBe('incomplete');
    expect(result.targets.map((t) => t.history?.state)).toEqual(['done', 'pending']);
    expect(result.history?.pending).toBe(1);
  });

  it('stops the run when the provider refuses a call', async () => {
    const h = harness({ status: () => 'denied' });
    const result = await seasonBackfillWorkflow(
      { targets: [target(), target(LEAGUE, 2015)], resultsOnly: true },
      h.deps
    );
    expect(h.calls).toHaveLength(1);
    expect(result.targets.map((t) => t.history?.state)).toEqual(['pending', 'pending']);
    expect(h.ingestGames).not.toHaveBeenCalled();
  });

  it('dry run: guards, lists and resolves teams, writes nothing', async () => {
    const h = harness({ unresolvedTeams: new Set([FIRST_TEAM]) });
    const result = await history(h, { dryRun: true });
    expect(h.calls.map((c) => [c.workload, c.cache])).toEqual([[HISTORY_LIST_WORKLOAD, 'bypass']]);
    expect(h.ingestGames).not.toHaveBeenCalled();
    expect(h.ingestFootballStandings).not.toHaveBeenCalled();
    expect(result.targets[0]!.history).toMatchObject({
      state: 'planned',
      reason: 'teams-unresolved',
      plannedCalls: 2,
      fixturesListed: 12,
      fixturesFinalised: 12,
      seasonId: 'btl_football_season_season:179:2014',
    });
    expect(result.history?.planned).toBe(1);
    expect(await h.state.get(historyDoneKey(LEAGUE, SEASON))).toBeUndefined();
  });
});

describe('season-backfill history mode: dry run budget', () => {
  it('needs one call a target', async () => {
    const h = harness();
    const result = await seasonBackfillWorkflow(
      {
        targets: [target(), target(LEAGUE, 2015)],
        resultsOnly: true,
        dryRun: true,
        maxCallsPerRun: 2,
      },
      h.deps
    );
    expect(h.calls).toHaveLength(2);
    expect(result.history?.planned).toBe(2);
  });
});

describe('season-backfill history mode: standings only', () => {
  it('guards the season, then makes only the standings call', async () => {
    const h = harness();
    const result = await seasonBackfillWorkflow(
      { targets: [target(39, 2023)], standingsOnly: true },
      h.deps
    );
    expect(h.calls.map((c) => [c.workload, c.path])).toEqual([
      ['competition-standings', '/standings?league=39&season=2023'],
    ]);
    expect(h.ingestGames).not.toHaveBeenCalled();
    expect(h.lookupGameByFixture).not.toHaveBeenCalled();
    expect(h.ingestFootballStandings).toHaveBeenCalledTimes(1);
    expect(result.targets[0]!.history).toMatchObject({
      mode: 'standings-only',
      state: 'done',
      plannedCalls: 1,
      standingsTables: 1,
    });
    expect(await h.state.get(historyStandingsDoneKey(39, 2023))).toBeDefined();
    expect(await h.state.get(historyDoneKey(39, 2023))).toBeUndefined();
  });

  it('wins over resultsOnly', async () => {
    const h = harness();
    await seasonBackfillWorkflow(
      { targets: [target()], standingsOnly: true, resultsOnly: true },
      h.deps
    );
    expect(h.calls.map((c) => c.workload)).toEqual(['competition-standings']);
    expect(h.ingestGames).not.toHaveBeenCalled();
  });

  it('dry run makes no call', async () => {
    const h = harness();
    const result = await seasonBackfillWorkflow(
      { targets: [target(39, 2023)], standingsOnly: true, dryRun: true },
      h.deps
    );
    expect(h.calls).toHaveLength(0);
    expect(result.targets[0]!.history?.state).toBe('planned');
  });
});
