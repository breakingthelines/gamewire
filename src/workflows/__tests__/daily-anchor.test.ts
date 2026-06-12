import { describe, expect, it, vi } from 'vitest';

import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
  IngestionWorkload,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import { dailyAnchorWorkflow } from '../daily-anchor.js';
import type { CompetitionEntry, WorkflowDeps, WorkflowLogEntry } from '../types.js';

const COMPETITION_A: CompetitionEntry = {
  key: 'comp-a',
  label: 'Competition A',
  apiFootballLeagueId: 999,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const COMPETITION_B: CompetitionEntry = {
  key: 'comp-b',
  label: 'Competition B',
  apiFootballLeagueId: 1000,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-05-22',
  calls: 100,
  softCap: 60_000,
  hardCap: 70_000,
  cachedOnlyMode: false,
  posture: 'normal',
  ...overrides,
});

const buildResult = (
  workload: IngestionWorkload,
  resourceId: string,
  overrides: Partial<IngestionFetchResult> = {}
): IngestionFetchResult => ({
  status: 'fetched',
  workload,
  resourceId,
  cacheKey: `${workload}:${resourceId}`,
  cacheHit: false,
  cachedOnlyMode: false,
  quota: baseQuota(),
  data: {
    response: [
      {
        fixture: {
          id: 1001,
          date: '2026-05-20T15:00:00Z',
          status: { short: 'FT' },
        },
        teams: { home: { id: 50 }, away: { id: 60 } },
      },
    ],
  },
  ...overrides,
});

interface MockIngestion {
  readonly fetchWorkload: ReturnType<typeof vi.fn>;
}

const buildDeps = (
  ingestion: MockIngestion,
  competitions: readonly CompetitionEntry[],
  overrides: Partial<WorkflowDeps> = {}
): WorkflowDeps => ({
  ingestion: ingestion as unknown as ApiFootballIngestionLoop,
  competitions,
  ...overrides,
});

describe('dailyAnchorWorkflow', () => {
  it('iterates per competition and aggregates totals', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options);
        return buildResult(options.workload, options.resourceId);
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A, COMPETITION_B]);
    const result = await dailyAnchorWorkflow({}, deps);

    const compKeys = result.competitions.map((c) => c.competition);
    expect(compKeys).toEqual(['comp-a', 'comp-b']);
    expect(result.callsBudgeted).toBeGreaterThan(0);
    expect(result.callsUsed).toBeGreaterThan(0);
    expect(result.degradeFlags).toEqual([]);
    const paths = calls.map((c) => c.path).filter(Boolean);
    expect(paths.some((p) => p?.includes('league=999'))).toBe(true);
    expect(paths.some((p) => p?.includes('league=1000'))).toBe(true);
  });

  it('halts further competitions once quota hard cap reached', async () => {
    let callCount = 0;
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        callCount += 1;
        const hardCapped = callCount >= 1;
        return buildResult(options.workload, options.resourceId, {
          quota: baseQuota({
            calls: hardCapped ? 70_000 : 100,
            posture: hardCapped ? 'hard_cap_reached' : 'normal',
          }),
          data: {},
        });
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A, COMPETITION_B]);
    const result = await dailyAnchorWorkflow({}, deps);

    expect(result.competitions).toHaveLength(1);
    expect(result.competitions[0]?.competition).toBe('comp-a');
    expect(result.degradeFlags.some((f) => f.trigger === 'hard-cap')).toBe(true);
    expect(result.finalQuota?.posture).toBe('hard_cap_reached');
  });

  it('flags soft cap and PROVIDER_OUTAGE without aborting', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, {
          status: 'cached',
          quota: baseQuota({
            calls: 60_500,
            posture: 'soft_cap_reached',
            cachedOnlyMode: true,
          }),
          fallbackReason: 'PROVIDER_OUTAGE',
          data: {},
        })
      ),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A]);
    const result = await dailyAnchorWorkflow({}, deps);

    const triggers = result.degradeFlags.map((f) => f.trigger);
    expect(triggers).toContain('soft-cap');
    expect(triggers).toContain('provider-outage');
    expect(result.competitions).toHaveLength(1);
  });

  it('captures fetch errors per workload + resourceId', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, {
          status: 'failed',
          error: { message: 'boom' },
          data: { response: [] },
        })
      ),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A]);
    const result = await dailyAnchorWorkflow({}, deps);

    expect(result.competitions[0]?.errors.length).toBeGreaterThan(0);
    expect(result.competitions[0]?.errors[0]).toContain('boom');
  });

  it('filters competitions by input.competitions', async () => {
    const calls: string[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options.resourceId);
        return buildResult(options.workload, options.resourceId, { data: { response: [] } });
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A, COMPETITION_B]);
    const result = await dailyAnchorWorkflow({ competitions: ['comp-b'] }, deps);

    expect(result.competitions.map((c) => c.competition)).toEqual(['comp-b']);
    expect(calls.every((c) => !c.includes('999'))).toBe(true);
  });

  it('scopes the fixtures path to a -1d/+7d window around the anchor time', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options);
        return buildResult(options.workload, options.resourceId, { data: { response: [] } });
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A]);
    await dailyAnchorWorkflow({ nowUtc: '2026-05-24T02:00:00Z' }, deps);

    const fixturesCall = calls.find((c) => c.path?.startsWith('/fixtures?'));
    expect(fixturesCall?.path).toBe(
      '/fixtures?league=999&season=2025&from=2026-05-23&to=2026-05-31'
    );
    expect(fixturesCall?.resourceId).toBe('league-999-season-2025-anchor-2026-05-24');
  });

  it('counts every fixture in the forward window as ingested (incl. all-SCHEDULED competitions)', async () => {
    // Mirrors the WC26 case: the forward window returns only NS fixtures.
    // The ingestion-loop bridge upserts each as a SCHEDULED canonical game,
    // so the sweep must report them as ingested even though none is finalised.
    const scheduledList = {
      response: [
        {
          fixture: { id: 1489369, date: '2026-06-11T19:00:00+00:00', status: { short: 'NS' } },
          league: { id: 1, name: 'World Cup', season: 2026, round: 'Group Stage - 1' },
          teams: { home: { id: 16 }, away: { id: 1531 } },
        },
        {
          fixture: { id: 1538999, date: '2026-06-12T02:00:00+00:00', status: { short: 'NS' } },
          league: { id: 1, name: 'World Cup', season: 2026, round: 'Group Stage - 1' },
          teams: { home: { id: 2380 }, away: { id: 24 } },
        },
      ],
    };
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        // Only the forward-window fixtures fetch returns the list; standings
        // and any other workload return an empty response.
        const data = options.path?.startsWith('/fixtures?') ? scheduledList : { response: [] };
        return buildResult(options.workload, options.resourceId, { data });
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A]);
    const result = await dailyAnchorWorkflow({ nowUtc: '2026-06-05T02:00:00Z' }, deps);

    // Two NS fixtures in the window ⇒ fixturesIngested === 2, with no
    // double-count from a post-FT reconciliation pass (there are no FT fixtures).
    expect(result.fixturesIngested).toBe(2);
    expect(result.competitions[0]?.fixturesIngested).toBe(2);
  });

  it('emits structured log events via logger', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, { data: { response: [] } })
      ),
    };
    const logs: WorkflowLogEntry[] = [];
    const deps = buildDeps(ingestion, [COMPETITION_A], {
      logger: (entry) => logs.push(entry),
    });
    await dailyAnchorWorkflow({}, deps);

    expect(logs[0]?.event).toBe('daily_anchor.started');
    expect(logs.at(-1)?.event).toBe('daily_anchor.finished');
  });

  it('resolves + ingests standings via game-service on the standings step', async () => {
    const standingsEnvelope = {
      response: [
        {
          league: {
            id: 999,
            name: 'Competition A',
            season: 2025,
            standings: [
              [
                {
                  rank: 1,
                  team: { id: 42, name: 'Club Forty-Two' },
                  points: 20,
                  goalsDiff: 10,
                  all: { played: 8, win: 6, draw: 2, lose: 0, goals: { for: 18, against: 8 } },
                },
              ],
            ],
          },
        },
      ],
    };

    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        if (options.workload === 'competition-standings') {
          return buildResult(options.workload, options.resourceId, { data: standingsEnvelope });
        }
        return buildResult(options.workload, options.resourceId, { data: { response: [] } });
      }),
    };

    const ingestFootballStandings = vi.fn(async (_request: unknown) => ({
      acceptedCount: 1,
      updatedCount: 0,
      replayId: 'r',
    }));
    const resolve = vi.fn(async (req: { entityType: number; providerId: string }) => {
      // Resolve the competition (league 999) and team 42 to canonical ids; the
      // season stays unresolved to exercise the provider-storage fallback.
      if (req.providerId === '999') {
        return { found: true, entityId: 'btl_football_competition_l999' };
      }
      if (req.providerId === '42') {
        return { found: true, entityId: 'btl_football_team_t42' };
      }
      return { found: false, entityId: '' };
    });

    const logs: WorkflowLogEntry[] = [];
    const deps = buildDeps(ingestion, [COMPETITION_A], {
      logger: (entry) => logs.push(entry),
      gameService: {
        ingestFootballStandings,
      } as unknown as WorkflowDeps['gameService'],
      identity: { resolve } as unknown as WorkflowDeps['identity'],
    });

    await dailyAnchorWorkflow({}, deps);

    // The standings step fetched under the dedicated workload (own resource id
    // + path), NOT the fixtures-next-7d bridge workload.
    const standingsFetchArgs = ingestion.fetchWorkload.mock.calls
      .map((args) => args[0] as IngestionFetchOptions)
      .find((opts) => opts.workload === 'competition-standings');
    expect(standingsFetchArgs?.resourceId).toBe('standings-999-2025');
    expect(standingsFetchArgs?.path).toContain('/standings?league=999');

    // Standings were resolved + ingested exactly once.
    expect(ingestFootballStandings).toHaveBeenCalledTimes(1);
    const request = ingestFootballStandings.mock.calls[0]?.[0] as {
      standings: ReadonlyArray<{
        competitionId: string;
        seasonId: string;
        entries: ReadonlyArray<{ teamId: string; rank: number }>;
      }>;
    };
    expect(request.standings).toHaveLength(1);
    expect(request.standings[0]!.competitionId).toBe('btl_football_competition_l999');
    // Season unresolved → provider-storage fallback.
    expect(request.standings[0]!.seasonId).toBe('provider:api-football:season:999:2025');
    expect(request.standings[0]!.entries[0]!.teamId).toBe('btl_football_team_t42');

    expect(logs.some((l) => l.event === 'daily_anchor.standings_ingested')).toBe(true);
  });

  it('skips standings ingest with a structured log when game-service is not wired', async () => {
    const standingsEnvelope = {
      response: [
        {
          league: {
            id: 999,
            name: 'Competition A',
            season: 2025,
            standings: [
              [
                {
                  rank: 1,
                  team: { id: 42, name: 'C42' },
                  points: 1,
                  goalsDiff: 0,
                  all: { played: 1, win: 0, draw: 1, lose: 0, goals: { for: 0, against: 0 } },
                },
              ],
            ],
          },
        },
      ],
    };
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        options.workload === 'competition-standings'
          ? buildResult(options.workload, options.resourceId, { data: standingsEnvelope })
          : buildResult(options.workload, options.resourceId, { data: { response: [] } })
      ),
    };
    const logs: WorkflowLogEntry[] = [];
    // No gameService in deps → standings ingest must be skipped, not throw.
    const deps = buildDeps(ingestion, [COMPETITION_A], {
      logger: (entry) => logs.push(entry),
    });
    await dailyAnchorWorkflow({}, deps);
    expect(logs.some((l) => l.event === 'daily_anchor.standings_skipped')).toBe(true);
    expect(logs.at(-1)?.event).toBe('daily_anchor.finished');
  });
});
