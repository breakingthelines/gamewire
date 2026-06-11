/**
 * Tests for the squad-sweep workflow.
 *
 * Covers:
 *   - Team enumeration from fixture cache (the default path)
 *   - Explicit teamIds override
 *   - Provider -> canonical team id resolution (via identity mock)
 *   - Standing squad list construction (game_id = "")
 *   - game-service IngestFootballSquadLists call with canonical team_id populated
 *   - Dry-run mode
 *   - Degrade / quota handling (denied -> skipped)
 *   - Idempotency: re-running upserts the same teams
 *   - teamIdsFromFixtureListEnvelope helper
 *   - extractSquadTeams: correct fields, provider-namespaced player_id, empty response guard
 *   - buildStandingSquadRequest: game_id="", canonical team_id on entry
 */
import { describe, expect, it, vi } from 'vitest';

import { InMemoryProviderCache, type ProviderCache } from '../../worker/cache.js';
import type {
  IngestionFetchOptions,
  IngestionFetchResult,
  ApiFootballIngestionLoop,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import type { FootballIdentityLookupClient } from '../../worker/clients/identity.js';
import type { FootballGameIngestClient } from '../../worker/clients/game-service.js';
import type { IngestBatchResponse } from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import type { FootballSquadListTeam } from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';
import { squadSweepWorkflow, __test } from '../squad-sweep.js';
import type {
  CompetitionEntry,
  SquadSweepInput,
  WorkflowDeps,
} from '../types.js';

const {
  teamIdsFromFixtureListEnvelope,
  extractSquadTeams,
  buildStandingSquadRequest,
  DEFAULT_MAX_TEAMS_PER_RUN,
} = __test;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMP_A: CompetitionEntry = {
  key: 'premier-league',
  label: 'Premier League',
  apiFootballLeagueId: 39,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const COMP_B: CompetitionEntry = {
  key: 'la-liga',
  label: 'La Liga',
  apiFootballLeagueId: 140,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-06-11',
  calls: 50,
  softCap: 60_000,
  hardCap: 70_000,
  cachedOnlyMode: false,
  posture: 'normal',
  ...overrides,
});

/** A /fixtures?league&season envelope with home + away team ids. */
const fixtureListEnvelope = (fixtures: Array<{ homeId: number; awayId: number }>): unknown => ({
  response: fixtures.map(({ homeId, awayId }) => ({
    fixture: { id: 9999, date: '2026-05-01T15:00:00Z', status: { short: 'FT' } },
    league: { id: 39, name: 'Premier League', season: 2025 },
    teams: {
      home: { id: homeId, name: `Team ${homeId}`, logo: '' },
      away: { id: awayId, name: `Team ${awayId}`, logo: '' },
    },
  })),
});

/** A /players/squads?team= envelope with one team and two players. */
const squadEnvelope = (teamId: number, playerIds: number[]): unknown => ({
  response: [
    {
      team: { id: teamId, name: `Team ${teamId}`, logo: 'https://example.com/logo.png' },
      players: playerIds.map((pid) => ({
        id: pid,
        name: `Player ${pid}`,
        number: pid % 30,
        position: 'Midfielder',
        age: 25,
        photo: `https://example.com/player-${pid}.png`,
      })),
    },
  ],
});

// ── Mock helpers ──────────────────────────────────────────────────────────────

class MockIngestion {
  readonly cache: ProviderCache;
  readonly fetchCalls: IngestionFetchOptions[] = [];
  private payloads = new Map<string, unknown>();
  private denySet = new Set<string>();
  quotaSnapshot: ProviderQuotaSnapshot = baseQuota();

  constructor(cache: ProviderCache) {
    this.cache = cache;
  }

  /** Seed a cached fixture-list envelope for a competition. */
  setCachedFixtureList(leagueId: number, season: number, envelope: unknown): void {
    const cacheKey = `api-football:fixtures-next-7d:league-${leagueId}-season-${season}`;
    void this.cache.set(cacheKey, envelope, 86400);
  }

  /** Return a squad envelope for a given team id resource. */
  setSquadPayload(providerTeamId: string, envelope: unknown): void {
    this.payloads.set(`sweep-squad-${providerTeamId}`, envelope);
  }

  /** Simulate quota-denied for a resourceId. */
  deny(resourceId: string): void {
    this.denySet.add(resourceId);
  }

  fetchWorkload = vi.fn(async (options: IngestionFetchOptions): Promise<IngestionFetchResult> => {
    this.fetchCalls.push(options);
    const quota = this.quotaSnapshot;
    if (this.denySet.has(options.resourceId)) {
      return {
        status: 'denied',
        workload: options.workload,
        resourceId: options.resourceId,
        cacheKey: `key:${options.resourceId}`,
        cacheHit: false,
        cachedOnlyMode: true,
        quota: { ...quota, posture: 'hard_cap_reached', cachedOnlyMode: true },
        fallbackReason: 'PROVIDER_OUTAGE',
        error: { message: 'quota hard cap' },
      };
    }
    const data = this.payloads.get(options.resourceId) ?? { response: [] };
    return {
      status: 'fetched',
      workload: options.workload,
      resourceId: options.resourceId,
      cacheKey: `key:${options.resourceId}`,
      cacheHit: false,
      cachedOnlyMode: false,
      quota,
      data,
    };
  });
}

const mockIdentity = (resolutions: Record<string, string> = {}): FootballIdentityLookupClient => ({
  lookup: vi.fn(),
  resolve: vi.fn(async (req) => {
    const canonical = resolutions[req.providerId] ?? '';
    return { found: canonical !== '', entityId: canonical, entity: undefined };
  }),
  search: vi.fn(),
  stats: vi.fn(),
}) as unknown as FootballIdentityLookupClient;

const mockGameService = (): FootballGameIngestClient & {
  squadListCalls: Array<{ gameId: string; teams: Array<{ teamId: string; providerTeamId: string }> }>;
} => {
  const squadListCalls: Array<{
    gameId: string;
    teams: Array<{ teamId: string; providerTeamId: string }>;
  }> = [];
  return {
    squadListCalls,
    ingestGames: vi.fn(),
    ingestGameOccurrences: vi.fn(),
    ingestFootballLineups: vi.fn(),
    ingestFootballSquadLists: vi.fn(async (request) => {
      for (const sl of request.squadLists) {
        squadListCalls.push({
          gameId: sl.gameId,
          teams: sl.teams.map((t: FootballSquadListTeam) => ({ teamId: t.teamId, providerTeamId: t.providerTeamId })),
        });
      }
      const response: IngestBatchResponse = {
        $typeName: 'btl.game.v1.IngestBatchResponse',
        acceptedCount: request.squadLists.length,
        updatedCount: 0,
        skippedCount: 0,
        conflictCount: 0,
        unmappedIdentityCount: 0,
        unmappedIdentityCandidates: [],
        anomalies: [],
        replayId: 'test',
      };
      return response;
    }),
    ingestTeamMatchStats: vi.fn(),
    ingestPlayerMatchStats: vi.fn(),
  } as unknown as FootballGameIngestClient & {
    squadListCalls: Array<{ gameId: string; teams: Array<{ teamId: string; providerTeamId: string }> }>;
  };
};

const buildDeps = (
  ingestion: MockIngestion,
  overrides: Partial<WorkflowDeps> = {}
): WorkflowDeps => ({
  ingestion: ingestion as unknown as ApiFootballIngestionLoop,
  competitions: [COMP_A, COMP_B],
  identity: mockIdentity(),
  ...overrides,
});

// ── Unit tests: helpers ───────────────────────────────────────────────────────

describe('teamIdsFromFixtureListEnvelope', () => {
  it('extracts home and away team ids from a fixture list envelope', () => {
    const envelope = fixtureListEnvelope([
      { homeId: 42, awayId: 49 },
      { homeId: 42, awayId: 50 }, // duplicate home: 42 deduped
    ]);
    const ids = teamIdsFromFixtureListEnvelope(envelope);
    expect(ids).toContain('42');
    expect(ids).toContain('49');
    expect(ids).toContain('50');
    expect(ids.length).toBe(3);
  });

  it('returns empty for a malformed or empty envelope', () => {
    expect(teamIdsFromFixtureListEnvelope(undefined)).toEqual([]);
    expect(teamIdsFromFixtureListEnvelope(null)).toEqual([]);
    expect(teamIdsFromFixtureListEnvelope({ response: [] })).toEqual([]);
    expect(teamIdsFromFixtureListEnvelope({ response: [{ teams: {} }] })).toEqual([]);
  });

  it('skips zero and empty team ids', () => {
    const envelope = {
      response: [
        { teams: { home: { id: 0 }, away: { id: '' } } },
        { teams: { home: { id: 42 }, away: { id: 49 } } },
      ],
    };
    const ids = teamIdsFromFixtureListEnvelope(envelope);
    expect(ids).toEqual(['42', '49']);
  });
});

describe('extractSquadTeams', () => {
  it('populates canonical team_id, provider_team_id, and players', () => {
    const envelope = squadEnvelope(42, [1001, 1002]);
    const teams = extractSquadTeams(envelope, 'btl_football_team_t8596499a', 'api-football');

    expect(teams).toHaveLength(1);
    const team = teams[0]!;
    expect(team.teamId).toBe('btl_football_team_t8596499a');
    expect(team.providerTeamId).toBe('42');
    expect(team.players).toHaveLength(2);
    expect(team.players[0]!.providerPlayerId).toBe('1001');
    expect(team.players[0]!.playerId).toBe('provider:api-football:player:1001');
    expect(team.players[0]!.positionCode).toBe('Midfielder');
  });

  it('leaves teamId empty when canonical id is empty (identity miss)', () => {
    const envelope = squadEnvelope(42, [1001]);
    const teams = extractSquadTeams(envelope, '', 'api-football');
    expect(teams[0]!.teamId).toBe('');
  });

  it('returns empty array for an empty or malformed squad envelope', () => {
    expect(extractSquadTeams({ response: [] }, 'btl_football_team_t123', 'api-football')).toEqual(
      []
    );
    expect(extractSquadTeams(null, 'btl_football_team_t123', 'api-football')).toEqual([]);
    expect(extractSquadTeams({}, 'btl_football_team_t123', 'api-football')).toEqual([]);
  });

  it('skips teams with no valid players', () => {
    const envelope = {
      response: [{ team: { id: 42, name: 'Arsenal', logo: '' }, players: [] }],
    };
    expect(extractSquadTeams(envelope, 'btl_football_team_t123', 'api-football')).toEqual([]);
  });
});

describe('buildStandingSquadRequest', () => {
  it('produces a request with game_id="" (standing sentinel)', () => {
    const envelope = squadEnvelope(42, [1001, 1002]);
    const req = buildStandingSquadRequest({
      providerTeamId: '42',
      canonicalTeamId: 'btl_football_team_t8596499a',
      envelope,
      fetchedAtMs: 1_000_000,
    });

    expect(req).not.toBeNull();
    expect(req!.squadLists).toHaveLength(1);
    const sl = req!.squadLists[0]!;
    // Standing sentinel: game_id must be empty
    expect(sl.gameId).toBe('');
    expect(sl.teams).toHaveLength(1);
    expect(sl.teams[0]!.teamId).toBe('btl_football_team_t8596499a');
    expect(sl.teams[0]!.providerTeamId).toBe('42');
    expect(sl.teams[0]!.players).toHaveLength(2);
  });

  it('returns null when the envelope has no valid teams', () => {
    const req = buildStandingSquadRequest({
      providerTeamId: '42',
      canonicalTeamId: 'btl_football_team_t123',
      envelope: { response: [] },
      fetchedAtMs: 1_000_000,
    });
    expect(req).toBeNull();
  });
});

// ── Integration-style workflow tests ─────────────────────────────────────────

describe('squadSweepWorkflow — team enumeration', () => {
  it('enumerates teams from cached fixture envelopes when no explicit teamIds', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);

    // Seed fixture-list caches for both competitions.
    ingestion.setCachedFixtureList(39, 2025, fixtureListEnvelope([{ homeId: 42, awayId: 49 }]));
    ingestion.setCachedFixtureList(
      140,
      2025,
      fixtureListEnvelope([{ homeId: 101, awayId: 102 }])
    );

    // Each team gets a squad envelope.
    for (const id of ['42', '49', '101', '102']) {
      ingestion.setSquadPayload(id, squadEnvelope(Number(id), [Number(id) * 100]));
    }

    const gameService = mockGameService();
    const deps = buildDeps(ingestion, { gameService: gameService as unknown as FootballGameIngestClient });

    const result = await squadSweepWorkflow({ intercallDelayMs: 0 }, deps);

    expect(result.teamsDiscovered).toBe(4);
    expect(result.teamsOk).toBe(4);
    expect(result.teamsFailed).toBe(0);
    expect(result.status).toBe('completed');
    // All four teams should have been ingested.
    expect(gameService.squadListCalls).toHaveLength(4);
  });

  it('uses explicit teamIds when provided, ignoring the cache', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    // Cache has teams 42 + 49 but we only want team 42.
    ingestion.setCachedFixtureList(39, 2025, fixtureListEnvelope([{ homeId: 42, awayId: 49 }]));
    ingestion.setSquadPayload('42', squadEnvelope(42, [1001, 1002]));

    const gameService = mockGameService();
    const deps = buildDeps(ingestion, { gameService: gameService as unknown as FootballGameIngestClient });
    const input: SquadSweepInput = { teamIds: ['42'], intercallDelayMs: 0 };

    const result = await squadSweepWorkflow(input, deps);

    expect(result.teamsDiscovered).toBe(1);
    expect(result.teamsOk).toBe(1);
    expect(gameService.squadListCalls).toHaveLength(1);
    // fetchWorkload was only called for team 42, not 49.
    const fetchedTeams = ingestion.fetchCalls.map((c) => c.resourceId);
    expect(fetchedTeams).not.toContain('sweep-squad-49');
    expect(fetchedTeams).toContain('sweep-squad-42');
  });

  it('deduplicates team ids in explicit list', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    ingestion.setSquadPayload('42', squadEnvelope(42, [1001]));

    const gameService = mockGameService();
    const deps = buildDeps(ingestion, { gameService: gameService as unknown as FootballGameIngestClient });
    // Pass the same id twice.
    const result = await squadSweepWorkflow({ teamIds: ['42', '42', '42'], intercallDelayMs: 0 }, deps);

    expect(result.teamsDiscovered).toBe(1);
    expect(ingestion.fetchCalls).toHaveLength(1);
  });
});

describe('squadSweepWorkflow — canonical team id resolution', () => {
  it('populates canonical team_id on the ingested squad list team entry', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    ingestion.setSquadPayload('42', squadEnvelope(42, [1001]));

    const identity = mockIdentity({ '42': 'btl_football_team_t8596499a' });
    const gameService = mockGameService();
    const deps = buildDeps(ingestion, {
      identity,
      gameService: gameService as unknown as FootballGameIngestClient,
    });

    await squadSweepWorkflow({ teamIds: ['42'], intercallDelayMs: 0 }, deps);

    expect(gameService.squadListCalls).toHaveLength(1);
    const call = gameService.squadListCalls[0]!;
    // game_id must be "" (standing sentinel)
    expect(call.gameId).toBe('');
    expect(call.teams[0]!.teamId).toBe('btl_football_team_t8596499a');
    expect(call.teams[0]!.providerTeamId).toBe('42');
  });

  it('leaves canonical team_id empty when identity has no match', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    ingestion.setSquadPayload('99', squadEnvelope(99, [2001]));

    const identity = mockIdentity({}); // no resolution for team 99
    const gameService = mockGameService();
    const deps = buildDeps(ingestion, {
      identity,
      gameService: gameService as unknown as FootballGameIngestClient,
    });

    const result = await squadSweepWorkflow({ teamIds: ['99'], intercallDelayMs: 0 }, deps);

    // Should still succeed: missing canonical id is not a hard failure
    expect(result.teamsOk).toBe(1);
    expect(gameService.squadListCalls[0]!.teams[0]!.teamId).toBe('');
    expect(gameService.squadListCalls[0]!.teams[0]!.providerTeamId).toBe('99');
  });
});

describe('squadSweepWorkflow — dry-run', () => {
  it('enumerates and resolves but does not call game-service or the provider', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    ingestion.setCachedFixtureList(39, 2025, fixtureListEnvelope([{ homeId: 42, awayId: 49 }]));
    ingestion.setSquadPayload('42', squadEnvelope(42, [1001]));
    ingestion.setSquadPayload('49', squadEnvelope(49, [1002]));

    const gameService = mockGameService();
    const deps = buildDeps(ingestion, { gameService: gameService as unknown as FootballGameIngestClient });
    const input: SquadSweepInput = { dryRun: true, intercallDelayMs: 0 };

    const result = await squadSweepWorkflow(input, deps);

    expect(result.dryRun).toBe(true);
    expect(result.teamsSkipped).toBe(result.teamsDiscovered);
    expect(result.teamsOk).toBe(0);
    expect(result.callsUsed).toBe(0);
    // No provider calls: dry-run skips fetchWorkload.
    expect(ingestion.fetchCalls).toHaveLength(0);
    // No game-service calls.
    expect(gameService.squadListCalls).toHaveLength(0);
  });
});

describe('squadSweepWorkflow — quota degrade', () => {
  it('skips a team when the provider quota denies the call', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    ingestion.setSquadPayload('42', squadEnvelope(42, [1001]));
    ingestion.setSquadPayload('49', squadEnvelope(49, [1002]));
    // Deny the fetch for team 49.
    ingestion.deny('sweep-squad-49');

    const gameService = mockGameService();
    const deps = buildDeps(ingestion, {
      gameService: gameService as unknown as FootballGameIngestClient,
    });

    const result = await squadSweepWorkflow(
      { teamIds: ['42', '49'], intercallDelayMs: 0 },
      deps
    );

    // Team 42 succeeded; team 49 was denied (skipped).
    expect(result.teamsOk).toBe(1);
    expect(result.teamsSkipped).toBe(1);
    // Denied team did not reach game-service.
    expect(gameService.squadListCalls).toHaveLength(1);
    expect(gameService.squadListCalls[0]!.teams[0]!.providerTeamId).toBe('42');
  });
});

describe('squadSweepWorkflow — empty squad response', () => {
  it('skips the team when the provider returns an empty squad', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    // Empty squad for team 42.
    ingestion.setSquadPayload('42', { response: [] });

    const gameService = mockGameService();
    const deps = buildDeps(ingestion, { gameService: gameService as unknown as FootballGameIngestClient });

    const result = await squadSweepWorkflow({ teamIds: ['42'], intercallDelayMs: 0 }, deps);

    expect(result.teamsSkipped).toBe(1);
    expect(result.teamsOk).toBe(0);
    expect(gameService.squadListCalls).toHaveLength(0);
  });
});

describe('squadSweepWorkflow — maxTeamsPerRun', () => {
  it('caps the team set to maxTeamsPerRun', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    const teamIds = Array.from({ length: 10 }, (_, i) => String(i + 1));
    for (const id of teamIds) {
      ingestion.setSquadPayload(id, squadEnvelope(Number(id), [Number(id) * 100]));
    }

    const gameService = mockGameService();
    const deps = buildDeps(ingestion, { gameService: gameService as unknown as FootballGameIngestClient });

    const result = await squadSweepWorkflow(
      { teamIds, maxTeamsPerRun: 3, intercallDelayMs: 0 },
      deps
    );

    expect(result.teamsDiscovered).toBe(3);
    expect(ingestion.fetchCalls).toHaveLength(3);
  });

  it('has a reasonable default maxTeamsPerRun', () => {
    expect(DEFAULT_MAX_TEAMS_PER_RUN).toBe(500);
  });
});

describe('squadSweepWorkflow — no game-service wired', () => {
  it('skips ingest but still fetches when gameService dep is absent', async () => {
    const cache = new InMemoryProviderCache();
    const ingestion = new MockIngestion(cache);
    ingestion.setSquadPayload('42', squadEnvelope(42, [1001]));

    // No gameService in deps.
    const deps = buildDeps(ingestion);

    const result = await squadSweepWorkflow({ teamIds: ['42'], intercallDelayMs: 0 }, deps);

    // Team was fetched but skipped at ingest (no gameService).
    expect(result.teamsSkipped).toBe(1);
    expect(ingestion.fetchCalls).toHaveLength(1);
  });
});
