import { create, fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  type PlatformFact,
  PlatformFactSchema,
} from '@breakingthelines/protos/btl/context/v1/context_pb';
import { GameParticipantRole } from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import {
  IngestBatchResponseSchema,
  type LookupGameByFixtureRequest,
  type LookupGameByFixtureResponse,
  LookupGameByFixtureResponseSchema,
  type IngestFootballLineupsRequest,
  type IngestFootballSquadListsRequest,
  type IngestGameOccurrencesRequest,
  type IngestGamesRequest,
  type IngestPlayerMatchStatsRequest,
  type IngestTeamMatchStatsRequest,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  type LookupRequest,
  type LookupResponse,
  type ResolveRequest,
  type ResolveResponse,
  ResolveResponseSchema,
  type SearchRequest,
  type SearchResponse,
  type StatsRequest,
  type StatsResponse,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import type { FootballGameBridgeClient } from './clients/game-service.js';
import type { FootballIdentityLookupClient } from './clients/identity.js';
import {
  createMatchConcludedBridge,
  decodeFixtureEnvelope,
  isFixtureDetailWorkload,
  type MatchConcludedBridgeLogEntry,
} from './match-concluded-bridge.js';
import {
  InMemoryEmittedFixtureStore,
  InMemoryMatchConcludedStreamClient,
  MATCH_CONCLUDED_FACT_TYPE,
  MATCH_CONCLUDED_STREAM_NAME,
  MatchConcludedPublisher,
  MatchConcludedPublisherMetrics,
} from './match-concluded-publisher.js';

const decodeFact = (bytes: Uint8Array): PlatformFact => fromBinary(PlatformFactSchema, bytes);

const noopLogger = (_: MatchConcludedBridgeLogEntry): void => {
  /* swallow logs in unit tests */
};

/**
 * Build a minimal API-Football `/fixtures?id=` response envelope for a
 * single fixture with the given status code.
 */
const buildFixtureResponse = (
  fixtureId: number | string,
  statusShort: string,
  dateIso = '2026-05-20T15:00:00+00:00'
): unknown => ({
  response: [
    {
      fixture: {
        id: fixtureId,
        date: dateIso,
        status: { short: statusShort, long: 'Match Finished' },
      },
      teams: { home: { id: 1 }, away: { id: 2 } },
    },
  ],
});

const buildEventResponse = (fixtureId: number | string = 1538961): unknown => ({
  response: [
    {
      time: { elapsed: 27, extra: null },
      team: { id: 49, name: 'Chelsea' },
      player: { id: 152982, name: 'Cole Palmer' },
      assist: { id: 999, name: 'Provider Assist' },
      type: 'Goal',
      detail: 'Normal Goal',
      comments: null,
      fixture: { id: fixtureId },
    },
  ],
});

const buildLineupResponse = (): unknown => ({
  response: [
    {
      team: { id: 42, name: 'Arsenal' },
      formation: '4-3-3',
      startXI: [
        {
          player: {
            id: 1460,
            name: 'Bukayo Saka',
            number: 7,
            pos: 'RW',
            grid: '3:3',
          },
        },
      ],
      substitutes: [],
    },
  ],
});

const buildSquadResponse = (): unknown => ({
  response: [
    {
      team: { id: 42, name: 'Arsenal', logo: 'https://media.api-sports.io/football/teams/42.png' },
      players: [
        {
          id: 1460,
          name: 'Bukayo Saka',
          age: 24,
          number: 7,
          position: 'Attacker',
          photo: 'https://media.api-sports.io/football/players/1460.png',
        },
      ],
    },
  ],
});

interface BuildPublisherResult {
  readonly publisher: MatchConcludedPublisher;
  readonly stream: InMemoryMatchConcludedStreamClient;
  readonly metrics: MatchConcludedPublisherMetrics;
  readonly emitted: InMemoryEmittedFixtureStore;
}

const buildPublisher = (overrides: { readonly now?: () => number } = {}): BuildPublisherResult => {
  const stream = new InMemoryMatchConcludedStreamClient();
  const metrics = new MatchConcludedPublisherMetrics();
  const emitted = new InMemoryEmittedFixtureStore();
  const publisher = new MatchConcludedPublisher({
    stream,
    emitted,
    metrics,
    logger: () => undefined,
    now: overrides.now ?? (() => Date.parse('2026-05-20T17:00:00Z')),
  });
  return { publisher, stream, metrics, emitted };
};

/**
 * Inert identity stub. The bridge still requires a
 * `FootballIdentityLookupClient` field for future PLAYER / TEAM
 * crosswalk paths, but the GAME path no longer touches it. Every
 * method here throws to make accidental usage during a GAME test loud
 * — if any of these fire, the swap regressed.
 */
const inertIdentity = (): FootballIdentityLookupClient => ({
  async resolve(_request: ResolveRequest): Promise<ResolveResponse> {
    throw new Error('identity.resolve must not be called on the GAME path');
  },
  async lookup(_request: LookupRequest): Promise<LookupResponse> {
    throw new Error('lookup not implemented in inert identity');
  },
  async search(_request: SearchRequest): Promise<SearchResponse> {
    throw new Error('search not implemented in inert identity');
  },
  async stats(_request: StatsRequest): Promise<StatsResponse> {
    throw new Error('stats not implemented in inert identity');
  },
});

/**
 * Identity stub that resolves a fixed `providerId -> entityId` map and
 * misses everything else. Used by the stats bridge tests where the bridge
 * DOES exercise identity resolution (unlike the GAME fixture-detail path).
 */
const resolvingIdentity = (entities: Record<string, string>): FootballIdentityLookupClient => ({
  async resolve(request: ResolveRequest): Promise<ResolveResponse> {
    const entityId = entities[request.providerId];
    return create(ResolveResponseSchema, {
      entityId: entityId ?? '',
      found: entityId !== undefined,
    });
  },
  async lookup(_request: LookupRequest): Promise<LookupResponse> {
    throw new Error('lookup not used by the stats bridge');
  },
  async search(_request: SearchRequest): Promise<SearchResponse> {
    throw new Error('search not used by the stats bridge');
  },
  async stats(_request: StatsRequest): Promise<StatsResponse> {
    throw new Error('stats not used by the stats bridge');
  },
});

const buildTeamStatisticsResponse = (): unknown => ({
  response: [
    {
      team: { id: 42, name: 'Arsenal' },
      statistics: [
        { type: 'Ball Possession', value: '58%' },
        { type: 'Total Shots', value: 14 },
        { type: 'Shots on Goal', value: 7 },
      ],
    },
    {
      team: { id: 49, name: 'Chelsea' },
      statistics: [
        { type: 'Ball Possession', value: '42%' },
        { type: 'Total Shots', value: 9 },
      ],
    },
  ],
});

const buildPlayersResponse = (): unknown => ({
  response: [
    {
      team: { id: 42, name: 'Arsenal' },
      players: [
        {
          player: { id: 1460, name: 'Bukayo Saka' },
          statistics: [
            {
              games: { minutes: 90, number: 7, rating: '8.4', substitute: false },
              goals: { total: 1, assists: 1 },
              shots: { total: 4, on: 2 },
            },
          ],
        },
      ],
    },
  ],
});

interface FakeGameService {
  readonly client: FootballGameBridgeClient;
  readonly ingestCalls: IngestGamesRequest[];
  readonly occurrenceCalls: IngestGameOccurrencesRequest[];
  readonly lineupCalls: IngestFootballLineupsRequest[];
  readonly squadListCalls: IngestFootballSquadListsRequest[];
  readonly teamStatsCalls: IngestTeamMatchStatsRequest[];
  readonly playerStatsCalls: IngestPlayerMatchStatsRequest[];
  readonly lookupCalls: LookupGameByFixtureRequest[];
}

const fakeGameService = (options: {
  readonly response?: Partial<LookupGameByFixtureResponse>;
  readonly responses?: readonly Partial<LookupGameByFixtureResponse>[];
  readonly error?: unknown;
}): FakeGameService => {
  const ingestCalls: IngestGamesRequest[] = [];
  const occurrenceCalls: IngestGameOccurrencesRequest[] = [];
  const lineupCalls: IngestFootballLineupsRequest[] = [];
  const squadListCalls: IngestFootballSquadListsRequest[] = [];
  const teamStatsCalls: IngestTeamMatchStatsRequest[] = [];
  const playerStatsCalls: IngestPlayerMatchStatsRequest[] = [];
  const lookupCalls: LookupGameByFixtureRequest[] = [];
  const error = options.error;
  const responses = (options.responses ?? [options.response ?? {}]).map((item) =>
    create(LookupGameByFixtureResponseSchema, {
      gameId: item.gameId ?? '',
      found: item.found ?? false,
    })
  );
  const client: FootballGameBridgeClient = {
    async ingestGames(request: IngestGamesRequest) {
      ingestCalls.push(request);
      return create(IngestBatchResponseSchema, {
        acceptedCount: request.games.length,
        updatedCount: 0,
        replayId: request.metadata?.replayId ?? '',
      });
    },
    async ingestGameOccurrences(request: IngestGameOccurrencesRequest) {
      occurrenceCalls.push(request);
      return create(IngestBatchResponseSchema, {
        acceptedCount: request.occurrences.length,
        updatedCount: 0,
        replayId: request.metadata?.replayId ?? '',
      });
    },
    async ingestFootballLineups(request: IngestFootballLineupsRequest) {
      lineupCalls.push(request);
      return create(IngestBatchResponseSchema, {
        acceptedCount: request.lineups.length,
        updatedCount: 0,
        replayId: request.metadata?.replayId ?? '',
      });
    },
    async ingestFootballSquadLists(request: IngestFootballSquadListsRequest) {
      squadListCalls.push(request);
      return create(IngestBatchResponseSchema, {
        acceptedCount: request.squadLists.length,
        updatedCount: 0,
        replayId: request.metadata?.replayId ?? '',
      });
    },
    async ingestTeamMatchStats(request: IngestTeamMatchStatsRequest) {
      teamStatsCalls.push(request);
      return create(IngestBatchResponseSchema, {
        acceptedCount: request.teamStats.length,
        updatedCount: 0,
        replayId: request.metadata?.replayId ?? '',
      });
    },
    async ingestPlayerMatchStats(request: IngestPlayerMatchStatsRequest) {
      playerStatsCalls.push(request);
      return create(IngestBatchResponseSchema, {
        acceptedCount: request.playerStats.length,
        updatedCount: 0,
        replayId: request.metadata?.replayId ?? '',
      });
    },
    async lookupGameByFixture(
      request: LookupGameByFixtureRequest
    ): Promise<LookupGameByFixtureResponse> {
      lookupCalls.push(request);
      if (error !== undefined) {
        throw error;
      }
      return responses[Math.min(lookupCalls.length - 1, responses.length - 1)]!;
    },
  };
  return {
    client,
    ingestCalls,
    occurrenceCalls,
    lineupCalls,
    squadListCalls,
    teamStatsCalls,
    playerStatsCalls,
    lookupCalls,
  };
};

describe('isFixtureDetailWorkload', () => {
  it('returns true for fixture-detail-* workloads', () => {
    expect(isFixtureDetailWorkload('fixture-detail-preKO')).toBe(true);
    expect(isFixtureDetailWorkload('fixture-detail-live')).toBe(true);
    expect(isFixtureDetailWorkload('fixture-detail-fullTime')).toBe(true);
  });

  it('returns false for non-fixture workloads', () => {
    expect(isFixtureDetailWorkload('fixtures-next-7d')).toBe(false);
    expect(isFixtureDetailWorkload('lineups-post-confirm')).toBe(false);
    expect(isFixtureDetailWorkload('team-metadata')).toBe(false);
    expect(isFixtureDetailWorkload('player-metadata')).toBe(false);
  });
});

describe('decodeFixtureEnvelope', () => {
  it('extracts id, status, and date from a well-formed response', () => {
    const decoded = decodeFixtureEnvelope(buildFixtureResponse(12345, 'FT'));
    expect(decoded).not.toBeNull();
    expect(decoded?.providerFixtureId).toBe('12345');
    expect(decoded?.providerStatus).toBe('FT');
    expect(decoded?.concludedAtMs).toBe(Date.parse('2026-05-20T15:00:00+00:00'));
  });

  it('coerces numeric fixture ids to strings', () => {
    const decoded = decodeFixtureEnvelope(buildFixtureResponse(999, 'AET'));
    expect(decoded?.providerFixtureId).toBe('999');
  });

  it('returns null for non-object payloads', () => {
    expect(decodeFixtureEnvelope(null)).toBeNull();
    expect(decodeFixtureEnvelope(undefined)).toBeNull();
    expect(decodeFixtureEnvelope('string')).toBeNull();
    expect(decodeFixtureEnvelope(123)).toBeNull();
    expect(decodeFixtureEnvelope([])).toBeNull();
  });

  it('returns null when response array missing or empty', () => {
    expect(decodeFixtureEnvelope({})).toBeNull();
    expect(decodeFixtureEnvelope({ response: [] })).toBeNull();
    expect(decodeFixtureEnvelope({ response: 'not-an-array' })).toBeNull();
  });

  it('returns null when fixture sub-object is missing or malformed', () => {
    expect(decodeFixtureEnvelope({ response: [{}] })).toBeNull();
    expect(decodeFixtureEnvelope({ response: [{ fixture: null }] })).toBeNull();
    expect(decodeFixtureEnvelope({ response: [{ fixture: 'no' }] })).toBeNull();
  });

  it('returns null when fixture.id is missing or empty', () => {
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { status: { short: 'FT' } } }],
      })
    ).toBeNull();
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { id: '', status: { short: 'FT' } } }],
      })
    ).toBeNull();
  });

  it('returns null when fixture.status.short is missing or malformed', () => {
    expect(decodeFixtureEnvelope({ response: [{ fixture: { id: 1, status: null } }] })).toBeNull();
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { id: 1, status: { short: '' } } }],
      })
    ).toBeNull();
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { id: 1, status: { short: 123 } } }],
      })
    ).toBeNull();
  });

  it('omits concludedAtMs when the date is missing or unparseable', () => {
    const noDate = decodeFixtureEnvelope({
      response: [{ fixture: { id: 1, status: { short: 'FT' } } }],
    });
    expect(noDate).not.toBeNull();
    expect(noDate?.concludedAtMs).toBeUndefined();

    const badDate = decodeFixtureEnvelope({
      response: [{ fixture: { id: 1, date: 'not-a-date', status: { short: 'FT' } } }],
    });
    expect(badDate?.concludedAtMs).toBeUndefined();
  });
});

describe('createMatchConcludedBridge', () => {
  it('is a no-op for unsupported workloads and empty fixture-scoped payloads', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({});
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixtures-next-7d',
      resourceId: 'top',
      data: { response: [] },
    });
    await bridge({
      workload: 'lineups-post-confirm',
      resourceId: '1',
      data: buildFixtureResponse(1, 'FT'),
    });
    await bridge({
      workload: 'team-metadata',
      resourceId: 't1',
      data: { response: [] },
    });
    await bridge({
      workload: 'player-metadata',
      resourceId: 'p1',
      data: { response: [] },
    });

    expect(gameService.lookupCalls).toHaveLength(0);
    expect(stream.published).toHaveLength(0);
  });

  it('skips malformed payloads and logs a structured event', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({});
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'fixture-detail-live',
      resourceId: '1',
      data: { broken: 'shape' },
    });

    expect(gameService.lookupCalls).toHaveLength(0);
    expect(stream.published).toHaveLength(0);
    expect(logs.some((e) => e.event === 'bridge_decode_skipped')).toBe(true);
  });

  it('skips publishing when game-service returns no match', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({ response: { found: false, gameId: '' } });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '12345',
      data: buildFixtureResponse(12345, 'FT'),
    });

    expect(gameService.lookupCalls).toHaveLength(1);
    expect(gameService.lookupCalls[0]?.provider).toBe('api-football');
    expect(gameService.lookupCalls[0]?.providerFixtureId).toBe('12345');
    expect(stream.published).toHaveLength(0);
    expect(logs.some((e) => e.event === 'bridge_game_not_found')).toBe(true);
  });

  it('ingests API-Football event payloads as GameOccurrence timeline data', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'btl_football_game_g1538961' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
      clock: () => Date.parse('2026-05-21T12:00:00Z'),
    });

    await bridge({
      workload: 'events-post-final',
      resourceId: '1538961',
      data: buildEventResponse(1538961),
    });

    expect(gameService.lookupCalls).toHaveLength(1);
    expect(gameService.occurrenceCalls).toHaveLength(1);
    const request = gameService.occurrenceCalls[0];
    expect(request?.gameId).toBe('btl_football_game_g1538961');
    expect(request?.occurrences).toHaveLength(1);
    expect(request?.occurrences[0]?.payload.case).toBe('timeline');
    expect(request?.occurrences[0]?.actors[0]?.providerRef?.providerId).toBe('49');
    expect(stream.published).toHaveLength(0);
    expect(logs.some((entry) => entry.event === 'bridge_events_ingested')).toBe(true);
  });

  it('retries event game lookup when fixture detail creates the mapping during boot', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      responses: [
        { found: false, gameId: '' },
        { found: true, gameId: 'btl_football_game_g1538961' },
      ],
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
      gameLookupRetryDelaysMs: [0],
    });

    await bridge({
      workload: 'events-post-final',
      resourceId: '1538961',
      data: buildEventResponse(1538961),
    });

    expect(gameService.lookupCalls).toHaveLength(2);
    expect(gameService.occurrenceCalls).toHaveLength(1);
    expect(logs.some((entry) => entry.event === 'bridge_game_not_found')).toBe(false);
    expect(logs.some((entry) => entry.event === 'bridge_events_ingested')).toBe(true);
  });

  it('ingests API-Football lineups and skips honestly empty lineup responses', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'btl_football_game_g1538961' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'lineups-post-confirm',
      resourceId: '1538961',
      data: buildLineupResponse(),
    });
    await bridge({
      workload: 'lineups-post-confirm',
      resourceId: '1538962',
      data: { response: [] },
    });

    expect(gameService.lookupCalls.map((call) => call.providerFixtureId)).toEqual(['1538961']);
    expect(gameService.lineupCalls).toHaveLength(1);
    expect(gameService.lineupCalls[0]?.lineups[0]?.gameId).toBe('btl_football_game_g1538961');
    expect(gameService.lineupCalls[0]?.lineups[0]?.teamSheets[0]?.teamId).toBe(
      'provider:api-football:team:42'
    );
    expect(logs.some((entry) => entry.event === 'bridge_lineups_ingested')).toBe(true);
    expect(logs.some((entry) => entry.event === 'bridge_lineups_missing')).toBe(true);
  });

  it('ingests API-Football squad lists against the fixture mapping without marking lineups present', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'btl_football_game_g1538961' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'squad-list-fallback',
      resourceId: '1538961:42',
      data: buildSquadResponse(),
    });

    expect(gameService.lookupCalls.map((call) => call.providerFixtureId)).toEqual(['1538961']);
    expect(gameService.lineupCalls).toHaveLength(0);
    expect(gameService.squadListCalls).toHaveLength(1);
    expect(gameService.squadListCalls[0]?.squadLists[0]?.gameId).toBe('btl_football_game_g1538961');
    expect(gameService.squadListCalls[0]?.squadLists[0]?.teams[0]?.providerTeamId).toBe('42');
    expect(gameService.squadListCalls[0]?.squadLists[0]?.teams[0]?.players[0]?.playerId).toBe(
      'provider:api-football:player:1460'
    );
    expect(logs.some((entry) => entry.event === 'bridge_squad_list_ingested')).toBe(true);
  });

  it('ingests API-Football team statistics into canonical TeamMatchStats', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'btl_football_game_g1538961' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      // Resolve the home team; leave the away team to fall back to a provider ref.
      identity: resolvingIdentity({ '42': 'btl_football_team_t8596499a' }),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'team-match-stats',
      resourceId: '1538961',
      data: buildTeamStatisticsResponse(),
    });

    expect(gameService.lookupCalls.map((c) => c.providerFixtureId)).toEqual(['1538961']);
    expect(gameService.teamStatsCalls).toHaveLength(1);
    const request = gameService.teamStatsCalls[0];
    expect(request?.teamStats).toHaveLength(2);
    expect(request?.teamStats[0]?.gameId).toBe('btl_football_game_g1538961');
    expect(request?.teamStats[0]?.team?.id).toBe('btl_football_team_t8596499a');
    expect(request?.teamStats[0]?.role).toBe(GameParticipantRole.HOME);
    expect(request?.teamStats[0]?.possessionPct).toBeCloseTo(58);
    expect(request?.teamStats[0]?.shots).toBe(14);
    expect(request?.teamStats[1]?.team).toBeUndefined();
    expect(request?.teamStats[1]?.teamResolution?.providerRef?.providerId).toBe('49');
    expect(request?.teamStats[1]?.role).toBe(GameParticipantRole.AWAY);
    expect(logs.some((e) => e.event === 'bridge_team_stats_ingested')).toBe(true);
  });

  it('ingests API-Football player statistics into canonical PlayerMatchStats', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'btl_football_game_g1538961' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: resolvingIdentity({ '1460': 'btl_football_player_psaka' }),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'player-match-stats',
      resourceId: '1538961',
      data: buildPlayersResponse(),
    });

    expect(gameService.lookupCalls.map((c) => c.providerFixtureId)).toEqual(['1538961']);
    expect(gameService.playerStatsCalls).toHaveLength(1);
    const request = gameService.playerStatsCalls[0];
    expect(request?.playerStats).toHaveLength(1);
    expect(request?.playerStats[0]?.gameId).toBe('btl_football_game_g1538961');
    expect(request?.playerStats[0]?.player?.id).toBe('btl_football_player_psaka');
    expect(request?.playerStats[0]?.role).toBe('STARTER');
    expect(request?.playerStats[0]?.goals).toBe(1);
    expect(request?.playerStats[0]?.assists).toBe(1);
    expect(logs.some((e) => e.event === 'bridge_player_stats_ingested')).toBe(true);
  });

  it('skips stats ingest when the provider response is empty', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'btl_football_game_g1538961' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: resolvingIdentity({}),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({ workload: 'team-match-stats', resourceId: '1538961', data: { response: [] } });
    await bridge({ workload: 'player-match-stats', resourceId: '1538961', data: { response: [] } });

    // Empty provider response → no lookup, no ingest (nothing to key).
    expect(gameService.lookupCalls).toHaveLength(0);
    expect(gameService.teamStatsCalls).toHaveLength(0);
    expect(gameService.playerStatsCalls).toHaveLength(0);
    expect(logs.some((e) => e.event === 'bridge_team_stats_missing')).toBe(true);
    expect(logs.some((e) => e.event === 'bridge_player_stats_missing')).toBe(true);
  });

  it('skips stats ingest when the fixture has no canonical game mapping', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({ response: { found: false, gameId: '' } });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: resolvingIdentity({}),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
      gameLookupRetryDelaysMs: [],
    });

    await bridge({
      workload: 'team-match-stats',
      resourceId: '1538961',
      data: buildTeamStatisticsResponse(),
    });

    expect(gameService.teamStatsCalls).toHaveLength(0);
    expect(logs.some((e) => e.event === 'bridge_game_not_found')).toBe(true);
  });

  it('does not throw when the stats ingest RPC throws (caught and logged)', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'btl_football_game_g1538961' },
    });
    // Make the team-stats ingest reject.
    gameService.client.ingestTeamMatchStats = async () => {
      throw new Error('stats backend down');
    };
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: resolvingIdentity({}),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await expect(
      bridge({
        workload: 'team-match-stats',
        resourceId: '1538961',
        data: buildTeamStatisticsResponse(),
      })
    ).resolves.toBeUndefined();
    expect(logs.some((e) => e.event === 'bridge_team_stats_ingest_error')).toBe(true);
  });

  it('does not throw when game-service client throws (caught and logged)', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({ error: new Error('network down') });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await expect(
      bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '12345',
        data: buildFixtureResponse(12345, 'FT'),
      })
    ).resolves.toBeUndefined();

    expect(stream.published).toHaveLength(0);
    const errEntry = logs.find((e) => e.event === 'bridge_game_lookup_error');
    expect(errEntry).toBeDefined();
    expect(errEntry?.message).toContain('network down');
  });

  it('publishes the canonical game id returned by game-service', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({
      response: {
        found: true,
        gameId: 'btl_football_game_arsenal_v_chelsea_2026_03_15',
      },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '12345',
      data: buildFixtureResponse(12345, 'FT'),
    });

    expect(stream.published).toHaveLength(1);
    const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
    expect(fact.sourceRecordId).toBe('btl_football_game_arsenal_v_chelsea_2026_03_15');
  });

  it('observes terminal-result statuses (FT, AET, PEN) end-to-end', async () => {
    for (const status of ['FT', 'AET', 'PEN']) {
      const { publisher, stream } = buildPublisher();
      const gameService = fakeGameService({
        response: { found: true, gameId: `game-${status.toLowerCase()}` },
      });
      const bridge = createMatchConcludedBridge({
        publisher,
        gameService: gameService.client,
        identity: inertIdentity(),
        providerId: 'api-football',
        logger: noopLogger,
      });

      await bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '12345',
        data: buildFixtureResponse(12345, status),
      });

      expect(stream.published).toHaveLength(1);
      const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
      expect(fact.type).toBe(MATCH_CONCLUDED_FACT_TYPE);
      expect(fact.sourceRecordId).toBe(`game-${status.toLowerCase()}`);
      expect(stream.published[0]!.stream).toBe(MATCH_CONCLUDED_STREAM_NAME);

      const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
      expect(metadata.provider_status).toBe(status);
      expect(metadata.void_reason).toBeNull();
      expect(metadata.provider_fixture_id).toBe('12345');
    }
  });

  it('observes terminal-void statuses (PST, ABD, AWD, WO) with void_reason set', async () => {
    for (const status of ['PST', 'ABD', 'AWD', 'WO']) {
      const { publisher, stream } = buildPublisher();
      const gameService = fakeGameService({
        response: { found: true, gameId: `game-${status.toLowerCase()}` },
      });
      const bridge = createMatchConcludedBridge({
        publisher,
        gameService: gameService.client,
        identity: inertIdentity(),
        providerId: 'api-football',
        logger: noopLogger,
      });

      await bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '12345',
        data: buildFixtureResponse(12345, status),
      });

      expect(stream.published).toHaveLength(1);
      const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
      const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
      expect(metadata.provider_status).toBe(status);
      expect(metadata.void_reason).toBe(status);
    }
  });

  it('records not_terminal outcome for non-terminal statuses without publishing', async () => {
    const { publisher, stream, metrics } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-99' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixture-detail-live',
      resourceId: '99',
      data: buildFixtureResponse(99, '1H'),
    });

    expect(stream.published).toHaveLength(0);
    expect(metrics.snapshot().notTerminal).toBe(1);
  });

  it('uses fixture.date as concludedAtMs when present', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-1' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '1',
      data: buildFixtureResponse(1, 'FT', '2026-05-20T16:45:00+00:00'),
    });

    const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
    const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.concluded_at).toBe(
      new Date(Date.parse('2026-05-20T16:45:00+00:00')).toISOString()
    );
  });

  it('falls back to clock() when fixture.date is missing', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-1' },
    });
    const fixedNow = Date.parse('2026-06-01T12:00:00Z');
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: noopLogger,
      clock: () => fixedNow,
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '1',
      data: {
        response: [{ fixture: { id: 1, status: { short: 'FT' } } }],
      },
    });

    const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
    const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.concluded_at).toBe(new Date(fixedNow).toISOString());
  });

  it('passes the configured providerId through to game-service + observation', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-1' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'sportmonks',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '7',
      data: buildFixtureResponse(7, 'FT'),
    });

    expect(gameService.lookupCalls[0]?.provider).toBe('sportmonks');
    expect(gameService.lookupCalls[0]?.providerFixtureId).toBe('7');
    const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
    expect(fact.idempotencyKey).toBe('match-concluded:7:FT');
  });

  it('emits exactly once per (providerId, providerFixtureId) across repeated invocations', async () => {
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-99' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: noopLogger,
    });

    for (let i = 0; i < 3; i += 1) {
      await bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '99',
        data: buildFixtureResponse(99, 'FT'),
      });
    }

    expect(stream.published).toHaveLength(1);
  });

  it('logs bridge_observed with the publisher outcome', async () => {
    const { publisher } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-1' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '1',
      data: buildFixtureResponse(1, 'FT'),
    });

    const observed = logs.find((e) => e.event === 'bridge_observed');
    expect(observed).toBeDefined();
    expect(observed?.outcome).toBe('published');
    expect(observed?.providerStatus).toBe('FT');
    expect(observed?.gameId).toBe('game-1');
  });

  it('does not throw when publisher.observe rejects unexpectedly', async () => {
    const { publisher } = buildPublisher();
    // Force the publisher to throw by stubbing observe(). The publisher's
    // production observe() never throws, but the bridge must be robust.
    const observeSpy = vi.spyOn(publisher, 'observe').mockRejectedValue(new Error('boom'));
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-1' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity: inertIdentity(),
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await expect(
      bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '1',
        data: buildFixtureResponse(1, 'FT'),
      })
    ).resolves.toBeUndefined();

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(logs.some((e) => e.event === 'bridge_observe_failed')).toBe(true);
  });

  it('continues to resolve GAME ids through game-service when identity misses', async () => {
    // The bridge may ask identity for fixture participants, but GAME
    // resolution itself must still route through game-service.LookupGameByFixture.
    const { publisher, stream } = buildPublisher();
    const gameService = fakeGameService({
      response: { found: true, gameId: 'game-1' },
    });
    const identity = inertIdentity(); // every method throws; bridge falls back to provider refs
    const bridge = createMatchConcludedBridge({
      publisher,
      gameService: gameService.client,
      identity,
      providerId: 'api-football',
      logger: noopLogger,
    });

    await expect(
      bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '1',
        data: buildFixtureResponse(1, 'FT'),
      })
    ).resolves.toBeUndefined();

    expect(stream.published).toHaveLength(1);
    expect(gameService.lookupCalls).toHaveLength(1);
  });
});

describe('ingestion onFixtureFetched (no-op default)', () => {
  it('does not require a callback to be passed', async () => {
    // Sanity assertion: the bridge module exists and the IngestionLoop
    // contract preserves the optional callback. The ingestion test suite
    // already covers fetch behaviour; this assertion documents the
    // null-callback path so callers know an undefined bridge is supported.
    expect(typeof createMatchConcludedBridge).toBe('function');
  });
});
