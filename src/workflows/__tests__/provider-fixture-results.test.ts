import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  gameService?: MockGameService
): WorkflowDeps => ({
  ingestion: ingestion as unknown as ApiFootballIngestionLoop,
  competitions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gameService: gameService as any,
});

const run = (
  ingestion: MockIngestion,
  competitions: readonly CompetitionEntry[],
  input: ProviderFixtureResultsInput,
  gameService?: MockGameService
) => providerFixtureResultsWorkflow(input, buildDeps(ingestion, competitions, gameService));

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

  it('calls /fixtures?league=L&date=yesterday for each resolved league, at background priority', async () => {
    ingestion.setPayload('provider-fixture-results-nightly-88', sampleEnvelope);

    const result = await run(
      ingestion,
      [],
      { mode: 'nightly', nightlyLeagueIds: [88] },
      gameService
    );

    expect(result.mode).toBe('nightly');
    expect(result.leagues[0]?.season).toBeUndefined();
    expect(ingestion.calls[0]?.path).toBe('/fixtures?league=88&date=yesterday');
    expect(ingestion.calls[0]?.priority).toBe('background');
    expect(result.rowsAccepted).toBe(5);
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
