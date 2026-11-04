import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderFixtureResultStatus } from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';

import { COMPETITIONS } from '../competitions.js';
import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import {
  __test,
  DEFAULT_PROVIDER_FIXTURE_RESULTS_MAX_CALLS,
  REFERENCE_LEAGUE_IDS,
  REFERENCE_SEASONS,
  REFERENCE_UEFA_LEAGUE_IDS,
  providerFixtureResultsWorkflow,
  resolveNightlyLeagueIds,
} from '../provider-fixture-results.js';
import type { CompetitionEntry, ProviderFixtureResultsInput, WorkflowDeps } from '../types.js';

import sampleEnvelope from './testdata/provider-fixture-results/88_2024_sample.json' with { type: 'json' };

const { resolveHistoryTargets, dedupeLeagueIds, fixtureResultRowsFromEnvelope } = __test;

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-11-05',
  calls: 100,
  softCap: 130_000,
  hardCap: 140_000,
  cachedOnlyMode: false,
  posture: 'normal',
  ...overrides,
});

/**
 * Mock ingestion loop: every `fetchWorkload` call is recorded; the payload
 * returned for a given resourceId is whatever `setPayload` configured
 * (defaulting to an empty envelope), mirroring season-backfill.test.ts's
 * pattern (`providerFetchCalls` counts real "fetched" touches once per
 * resourceId, the rest are "cached").
 */
class MockIngestion {
  readonly calls: IngestionFetchOptions[] = [];
  private readonly fetched = new Set<string>();
  private readonly payloads = new Map<string, unknown>();
  quotaFor: (call: IngestionFetchOptions, index: number) => ProviderQuotaSnapshot = () =>
    baseQuota();

  setPayload(resourceId: string, payload: unknown): void {
    this.payloads.set(resourceId, payload);
  }

  fetchWorkload = vi.fn(async (options: IngestionFetchOptions): Promise<IngestionFetchResult> => {
    const index = this.calls.length;
    this.calls.push(options);
    const firstTouch = !this.fetched.has(options.resourceId);
    this.fetched.add(options.resourceId);
    const data = this.payloads.get(options.resourceId) ?? { response: [] };
    const quota = this.quotaFor(options, index);
    const denied = quota.posture === 'hard_cap_reached';
    return {
      status: denied ? 'denied' : firstTouch ? 'fetched' : 'cached',
      workload: options.workload,
      resourceId: options.resourceId,
      cacheKey: `${options.workload}:${options.resourceId}`,
      cacheHit: !firstTouch,
      cachedOnlyMode: quota.cachedOnlyMode,
      quota,
      data: denied ? undefined : data,
      fallbackReason: denied ? 'PROVIDER_OUTAGE' : undefined,
      error: denied
        ? { message: `Provider quota hard_cap reached: ${quota.calls} >= ${quota.hardCap}` }
        : undefined,
    };
  });
}

const COMPETITION_PREMIER_LEAGUE: CompetitionEntry = {
  key: 'premier-league',
  label: 'Premier League',
  country: 'England',
  apiFootballLeagueId: 39,
  season: 2026,
  calendar: null,
  tier: 'domestic-top-five',
  liveIngestion: true,
  steadyStateSweep: true,
};

const COMPETITION_EREDIVISIE: CompetitionEntry = {
  key: 'eredivisie',
  label: 'Eredivisie',
  country: 'Netherlands',
  apiFootballLeagueId: 88,
  season: 2026,
  calendar: null,
  tier: 'domestic-league',
  liveIngestion: true,
  steadyStateSweep: true,
};

class MockGameService {
  readonly requests: unknown[] = [];
  acceptedPerRow = 1;
  shouldThrow = false;

  ingestProviderFixtureResults = vi.fn(async (request: { rows: readonly unknown[] }) => {
    this.requests.push(request);
    if (this.shouldThrow) {
      throw new Error('simulated game-service failure');
    }
    return {
      acceptedCount: request.rows.length,
      updatedCount: 0,
      skippedCount: 0,
      conflictCount: 0,
      unmappedIdentityCount: 0,
      unmappedIdentityCandidates: [],
      anomalies: [],
      replayId: '',
    };
  });
}

const buildDeps = (
  ingestion: MockIngestion,
  competitions: readonly CompetitionEntry[],
  gameService?: MockGameService,
  clock?: () => Date
): WorkflowDeps => ({
  ingestion: ingestion as unknown as ApiFootballIngestionLoop,
  competitions,
  // The workflow calls `deps.gameServiceJobs` (profile-spec.md §3.4:
  // IngestProviderFixtureResults is served only by game-service-profile-jobs,
  // never the serving pods `deps.gameService` targets) — see finding #4.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gameServiceJobs: gameService as any,
  clock,
});

const run = (
  ingestion: MockIngestion,
  competitions: readonly CompetitionEntry[],
  input: ProviderFixtureResultsInput,
  gameService?: MockGameService,
  clock?: () => Date
) => providerFixtureResultsWorkflow(input, buildDeps(ingestion, competitions, gameService, clock));

describe('provider-fixture-results — target resolution', () => {
  it('defaults history mode to the 20-league reference set plus UEFA 2/3/848, across 2023-2026', () => {
    const targets = resolveHistoryTargets({});
    expect(targets.length).toBe(
      (REFERENCE_LEAGUE_IDS.length + REFERENCE_UEFA_LEAGUE_IDS.length) * 4
    );
    expect(new Set(targets.map((t: { season?: number }) => t.season))).toEqual(
      new Set(REFERENCE_SEASONS)
    );
    const leagueIds = new Set(targets.map((t: { leagueId: number }) => t.leagueId));
    for (const id of [...REFERENCE_LEAGUE_IDS, ...REFERENCE_UEFA_LEAGUE_IDS]) {
      expect(leagueIds.has(id)).toBe(true);
    }
  });

  it('never includes UEFA Nations League (5) or International Friendlies (10), even when forced through an override', () => {
    const targets = resolveHistoryTargets({ leagueIds: [39, 5, 10], seasons: [2026] });
    expect(targets.map((t: { leagueId: number }) => t.leagueId)).toEqual([39]);
    expect(dedupeLeagueIds([39, 5, 10])).toEqual([39]);
  });

  it('is an ALLOWLIST, not a two-item denylist: any id outside the reference set plus UEFA 2/3/848 is dropped, including other national-team competitions', () => {
    // Finding #6: the old EXCLUDED_LEAGUE_IDS only named 5 and 10, so a
    // caller could smuggle through World Cup (1), a WC qualifier zone
    // (32), Euro, Copa América, or any other id the reference lists never
    // named. 39 (Premier League) is the one id here that is actually in
    // the allowlist.
    expect(dedupeLeagueIds([1, 32, 39])).toEqual([39]);
    const targets = resolveHistoryTargets({ leagueIds: [1, 32, 39], seasons: [2026] });
    expect(targets.map((t: { leagueId: number }) => t.leagueId)).toEqual([39]);
  });

  it('dedupes league ids and drops non-positive/non-integer ids', () => {
    expect(dedupeLeagueIds([39, 39, 0, -1, 1.5, 140])).toEqual([39, 140]);
  });

  it('nightly mode resolves to reference-set leagues missing from the catalogue, recomputed from deps.competitions', () => {
    // Only Premier League (39) and Eredivisie (88) are catalogued here —
    // every other reference-set league is a nightly target.
    const ids = resolveNightlyLeagueIds([COMPETITION_PREMIER_LEAGUE, COMPETITION_EREDIVISIE]);
    expect(ids).not.toContain(39);
    expect(ids).not.toContain(88);
    expect(ids).toContain(203); // Süper Lig
    expect(ids).toContain(179); // Scottish Premiership
    expect(ids.length).toBe(REFERENCE_LEAGUE_IDS.length - 2);
  });

  it('nightly mode drops a league out as soon as it joins the catalogue', () => {
    const before = resolveNightlyLeagueIds([COMPETITION_PREMIER_LEAGUE]);
    expect(before).toContain(88);
    const after = resolveNightlyLeagueIds([COMPETITION_PREMIER_LEAGUE, COMPETITION_EREDIVISIE]);
    expect(after).not.toContain(88);
  });
});

describe('provider-fixture-results — envelope parsing', () => {
  it('keeps only FT/AET/PEN fixtures with both team ids and a scoreline, from a recorded fixture list', () => {
    const rows = fixtureResultRowsFromEnvelope(sampleEnvelope, 88);
    // 3 FT + 1 AET + 1 PEN in the sample; the NS (not-started) entry is dropped.
    expect(rows.length).toBe(5);
    for (const row of rows) {
      expect(row.providerFixtureId).not.toBe('');
      expect(row.providerHomeTeamId).not.toBe('');
      expect(row.providerAwayTeamId).not.toBe('');
      expect(row.providerCompetitionId).toBe('88');
      expect(row.seasonYear).toBe(2024);
    }
  });

  it('returns no rows for an empty or malformed envelope', () => {
    expect(fixtureResultRowsFromEnvelope({ response: [] }, 88)).toEqual([]);
    expect(fixtureResultRowsFromEnvelope({}, 88)).toEqual([]);
    expect(fixtureResultRowsFromEnvelope(undefined, 88)).toEqual([]);
  });

  it('maps an FT row to its exact fixture id, team ids, scoreline, status and kickoff', () => {
    const rows = fixtureResultRowsFromEnvelope(sampleEnvelope, 88, 1_700_000_000_000);
    const row = rows.find((r) => r.providerFixtureId === '1213443');
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      providerFixtureId: '1213443',
      providerHomeTeamId: '413',
      providerAwayTeamId: '415',
      homeGoals: 1,
      awayGoals: 2,
      status: ProviderFixtureResultStatus.FULL_TIME,
    });
    // fixture.timestamp 1723308300 (seconds since epoch).
    expect(row?.kickoffAt?.seconds).toBe(1723308300n);
    // fetchedAt must be the passed-in fetch time, not the real wall clock
    // (finding #8) — the whole point of the parameter.
    expect(row?.fetchedAt?.seconds).toBe(1_700_000_000n);
  });

  it("stores the AET fixture's 1-1 full+extra-time scoreline, not the halftime or fulltime-only score", () => {
    const rows = fixtureResultRowsFromEnvelope(sampleEnvelope, 88);
    const row = rows.find((r) => r.providerFixtureId === '1375153');
    expect(row).toMatchObject({
      homeGoals: 1,
      awayGoals: 1,
      status: ProviderFixtureResultStatus.AFTER_EXTRA_TIME,
    });
  });

  it("stores the PEN fixture's 3-2 scoreline (goals.home/away), never the 5-4 penalty shootout score", () => {
    // Finding #7: the proto's `homeGoals`/`awayGoals` must be the match
    // score the league-strength model trains on (`pdata/leaguerate.py`
    // treats PEN like any other finished match), not the shootout tally.
    const rows = fixtureResultRowsFromEnvelope(sampleEnvelope, 88);
    const row = rows.find((r) => r.providerFixtureId === '1375842');
    expect(row).toMatchObject({
      providerHomeTeamId: '195',
      providerAwayTeamId: '409',
      homeGoals: 3,
      awayGoals: 2,
      status: ProviderFixtureResultStatus.PENALTIES,
    });
  });

  it('defaults fetchedAt to Date.now() only when the caller omits it (production always passes deps.clock)', () => {
    const before = Date.now();
    const rows = fixtureResultRowsFromEnvelope(sampleEnvelope, 88);
    const after = Date.now();
    const seconds = Number(rows[0]?.fetchedAt?.seconds ?? 0n);
    expect(seconds).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(seconds).toBeLessThanOrEqual(Math.ceil(after / 1000));
  });
});

describe('provider-fixture-results — history run', () => {
  let ingestion: MockIngestion;
  let gameService: MockGameService;

  beforeEach(() => {
    ingestion = new MockIngestion();
    gameService = new MockGameService();
  });

  it('fetches one call per league/season cell and ingests the finished fixtures', async () => {
    ingestion.setPayload('provider-fixture-results-88-2024', sampleEnvelope);

    const result = await run(ingestion, [], { leagueIds: [88], seasons: [2024] }, gameService);

    expect(result.mode).toBe('history');
    expect(result.status).toBe('complete');
    expect(result.callsBudgeted).toBe(1);
    expect(result.callsUsed).toBe(1);
    expect(result.rowsAccepted).toBe(5);
    expect(result.rowsSkipped).toBe(0);
    expect(ingestion.calls[0]?.path).toBe('/fixtures?league=88&season=2024');
    expect(ingestion.calls[0]?.priority).toBe('background');
    expect(gameService.ingestProviderFixtureResults).toHaveBeenCalledTimes(1);
    const request = gameService.requests[0] as { rows: readonly unknown[]; metadata: unknown };
    expect(request.rows).toHaveLength(5);
  });

  it("fetches through the 'provider-fixture-results' workload, never 'fixtures-next-7d'", async () => {
    // Finding #1: 'fixtures-next-7d' is a member of ingestion.ts's
    // BRIDGE_WORKLOADS, so using it here would run the match-concluded
    // bridge's ingestFixtureList (minting canonical games + crosswalk
    // rows for leagues/seasons outside the catalogue) and the asset-mirror
    // bridge on every call this workflow makes.
    ingestion.setPayload('provider-fixture-results-88-2024', sampleEnvelope);
    await run(ingestion, [], { leagueIds: [88], seasons: [2024] }, gameService);
    expect(ingestion.calls[0]?.workload).toBe('provider-fixture-results');
  });

  it('stamps every ingested row fetchedAt from deps.clock, not the real wall clock', async () => {
    ingestion.setPayload('provider-fixture-results-88-2024', sampleEnvelope);
    const fixedClock = () => new Date('2026-01-15T00:00:00Z');

    await run(ingestion, [], { leagueIds: [88], seasons: [2024] }, gameService, fixedClock);

    const request = gameService.requests[0] as {
      rows: readonly { fetchedAt?: { seconds: bigint } }[];
    };
    for (const row of request.rows) {
      expect(row.fetchedAt?.seconds).toBe(1768435200n); // 2026-01-15T00:00:00Z
    }
  });

  it('is a no-op ingest-side when the envelope has no finished fixtures (cache hit on re-run)', async () => {
    ingestion.setPayload('provider-fixture-results-88-2024', { response: [] });
    const result = await run(ingestion, [], { leagueIds: [88], seasons: [2024] }, gameService);
    expect(result.rowsAccepted).toBe(0);
    expect(gameService.ingestProviderFixtureResults).not.toHaveBeenCalled();
  });

  it('skips league/season cells and reports status skipped when game-service is not wired', async () => {
    ingestion.setPayload('provider-fixture-results-88-2024', sampleEnvelope);
    const result = await run(ingestion, [], { leagueIds: [88], seasons: [2024] }, undefined);
    expect(result.leagues[0]?.status).toBe('skipped');
    expect(result.leagues[0]?.rowsSkipped).toBe(5);
  });

  it('records a failed league when game-service rejects, without losing other leagues', async () => {
    ingestion.setPayload('provider-fixture-results-88-2024', sampleEnvelope);
    ingestion.setPayload('provider-fixture-results-39-2024', sampleEnvelope);
    gameService.shouldThrow = true;

    const result = await run(ingestion, [], { leagueIds: [88, 39], seasons: [2024] }, gameService);

    expect(result.leagues).toHaveLength(2);
    expect(result.leagues.every((l) => l.status === 'failed')).toBe(true);
    expect(result.rowsSkipped).toBe(10);
  });

  it('stops issuing calls once the per-run budget is spent and reports incomplete', async () => {
    ingestion.setPayload('provider-fixture-results-88-2024', { response: [] });
    ingestion.setPayload('provider-fixture-results-39-2024', { response: [] });

    const result = await run(
      ingestion,
      [],
      { leagueIds: [88, 39], seasons: [2024], maxCallsPerRun: 1 },
      gameService
    );

    expect(result.status).toBe('incomplete');
    expect(result.callsBudgeted).toBe(1);
    expect(result.leagues.some((l) => l.status === 'skipped')).toBe(true);
  });

  it('aborts the run on a hard-cap quota posture', async () => {
    ingestion.setPayload('provider-fixture-results-88-2024', sampleEnvelope);
    ingestion.quotaFor = () => baseQuota({ posture: 'hard_cap_reached', cachedOnlyMode: true });

    const result = await run(ingestion, [], { leagueIds: [88], seasons: [2024] }, gameService);

    expect(result.leagues[0]?.status).toBe('failed');
    expect(result.degradeFlags.some((f) => f.trigger === 'hard-cap')).toBe(true);
    expect(gameService.ingestProviderFixtureResults).not.toHaveBeenCalled();
  });

  it('reports the overall run incomplete, not complete, when a league fails', async () => {
    // Finding #5: a league ingest failure used to leave the overall
    // status 'complete' — only a budget-exhausted 'skipped' target
    // downgraded it. A run that fails every league must not look green.
    ingestion.setPayload('provider-fixture-results-88-2024', sampleEnvelope);
    gameService.shouldThrow = true;

    const result = await run(ingestion, [], { leagueIds: [88], seasons: [2024] }, gameService);

    expect(result.leagues[0]?.status).toBe('failed');
    expect(result.status).toBe('incomplete');
  });

  it('reports a league failed, not ok with 0 rows, when the provider outage leaves no envelope at all', async () => {
    // Finding #5: a provider outage with no prior cache (`cached-only`,
    // `result.data` undefined) used to report fixturesFound: 0 and
    // status: 'ok' — indistinguishable from a league with genuinely no
    // finished fixtures yet. The P2 "nightly run green 3 nights" gate
    // must not pass on silence.
    const outageIngestion = {
      fetchWorkload: vi.fn(
        async (options: IngestionFetchOptions): Promise<IngestionFetchResult> => {
          const quota = baseQuota({ posture: 'soft_cap_reached', cachedOnlyMode: true });
          return {
            status: 'cached',
            workload: options.workload,
            resourceId: options.resourceId,
            cacheKey: `${options.workload}:${options.resourceId}`,
            cacheHit: false,
            cachedOnlyMode: true,
            quota,
            data: undefined,
            fallbackReason: 'PROVIDER_OUTAGE',
          };
        }
      ),
    } as unknown as ApiFootballIngestionLoop;

    const result = await run(
      outageIngestion as unknown as MockIngestion,
      [],
      {
        leagueIds: [88],
        seasons: [2024],
      },
      gameService
    );

    expect(result.leagues[0]?.status).toBe('failed');
    expect(result.leagues[0]?.fixturesFound).toBe(0);
    expect(result.status).toBe('incomplete');
    expect(gameService.ingestProviderFixtureResults).not.toHaveBeenCalled();
  });

  it('defaults to the full ~92-call reference grid when no input is given', async () => {
    // No payloads configured -> every cell resolves to an empty envelope;
    // this only asserts the call volume, matching the spec's sizing.
    const result = await run(ingestion, [], {}, gameService);
    expect(result.callsBudgeted).toBe(
      (REFERENCE_LEAGUE_IDS.length + REFERENCE_UEFA_LEAGUE_IDS.length) * REFERENCE_SEASONS.length
    );
    expect(result.callsBudgeted).toBeLessThan(DEFAULT_PROVIDER_FIXTURE_RESULTS_MAX_CALLS);
  });
});

describe('provider-fixture-results — nightly run', () => {
  let ingestion: MockIngestion;
  let gameService: MockGameService;

  beforeEach(() => {
    ingestion = new MockIngestion();
    gameService = new MockGameService();
  });

  it('calls /fixtures?league=L&season=S&from=D-3&to=D-1 for each resolved league, at background priority', async () => {
    // Finding #3: API-Football's `date` filter needs a literal YYYY-MM-DD,
    // not the string "yesterday" (which always returned an empty `errors`
    // envelope). A fixed `nowUtc` makes the computed window deterministic.
    ingestion.setPayload('provider-fixture-results-nightly-88', sampleEnvelope);

    const result = await run(
      ingestion,
      [],
      { mode: 'nightly', nightlyLeagueIds: [88], nowUtc: '2026-11-05T02:00:00Z' },
      gameService
    );

    expect(result.mode).toBe('nightly');
    expect(result.leagues[0]?.season).toBeUndefined();
    expect(ingestion.calls[0]?.path).toBe(
      '/fixtures?league=88&season=2026&from=2026-11-02&to=2026-11-04'
    );
    expect(ingestion.calls[0]?.priority).toBe('background');
    expect(result.rowsAccepted).toBe(5);
  });

  it('labels the nightly date window by the season that started before the July rollover', async () => {
    ingestion.setPayload('provider-fixture-results-nightly-88', { response: [] });

    const result = await run(
      ingestion,
      [],
      { mode: 'nightly', nightlyLeagueIds: [88], nowUtc: '2026-03-10T02:00:00Z' },
      gameService
    );

    expect(result.mode).toBe('nightly');
    expect(ingestion.calls[0]?.path).toBe(
      '/fixtures?league=88&season=2025&from=2026-03-07&to=2026-03-09'
    );
  });

  it("sizes the default nightly run at about 10 calls against today's real catalogue", async () => {
    const result = await run(ingestion, COMPETITIONS, { mode: 'nightly' }, gameService);
    // Spec sizing: "nightly date=yesterday refresh for rated leagues outside
    // the catalogue (about 10 calls a day)". Today's catalogue (pre-GW-5)
    // leaves 11 of the 20 reference-set leagues uncatalogued.
    expect(result.callsBudgeted).toBe(resolveNightlyLeagueIds(COMPETITIONS).length);
    expect(result.callsBudgeted).toBeGreaterThanOrEqual(8);
    expect(result.callsBudgeted).toBeLessThanOrEqual(12);
  });
});
