/**
 * Bridge: ingestion loop → match-concluded publisher.
 *
 * The {@link ApiFootballIngestionLoop} owns the polling cadence and the
 * cache/quota machinery. The {@link MatchConcludedPublisher} owns the
 * Redis Streams XADD and the emit-once gate. This module is the thin
 * adapter between them:
 *
 *   1. Decode an API-Football `/fixtures?id=<id>` response envelope.
 *   2. Resolve provider teams/players/competition/seasons through identity
 *      where possible, preserving unresolved provider refs when identity misses.
 *   3. Resolve the provider fixture id → BTL canonical `game_id` via
 *      `game-service.LookupGameByFixture` (the crosswalk lives in
 *      `provider_game_mappings`, populated by `IngestGames`).
 *   4. Hand the resulting envelope to `publisher.observe(fixture)`.
 *
 * Why game-service and not identity-server: identity-server runs on a
 * read-only SQLite snapshot (release-asset distribution) and does not
 * carry fixture-level crosswalks; its `Resolve(GAME, ...)` calls will
 * always miss. The live crosswalk is on game-service. The
 * identity-client is used for provider participant/entity resolution, but
 * only the GAME read path resolves through game-service.
 *
 * The bridge NEVER throws — every failure path logs a structured event
 * and returns. Back-pressure on ingest would defeat the worker's call
 * budget guarantees, and the publisher already records non-terminal /
 * already-emitted observations as benign outcomes.
 *
 * Scope intentionally narrow:
 *   - No fixture polling here (that's the loop's `start()` path).
 *   - No status correction handling (publisher's emit-once gate stays
 *     authoritative; the consumer on game-service owns rescore).
 *   - No new transport layers (the game-service client is injected;
 *     see `clients/game-service.ts` for the fetch-based default).
 */

import { create } from '@bufbuild/protobuf';

import {
  type LookupGameByFixtureResponse,
  LookupGameByFixtureRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  type ResolveResponse,
  ResolveRequestSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import {
  apiFootballIngestGamesRequestFromFixtures,
  apiFootballIngestLineupsRequestFromLineups,
  apiFootballIngestOccurrencesRequestFromEvents,
  apiFootballIngestPlayerMatchStatsRequestFromPlayers,
  apiFootballIngestSquadListRequestFromSquads,
  apiFootballIngestTeamMatchStatsRequestFromStatistics,
  apiFootballSeasonProviderId,
  type ApiFootballEntityKind,
  type ApiFootballEntityResolutionMap,
  type ApiFootballResolvedEntity,
  type ApiFootballEventResponse,
  type ApiFootballFixtureResponse,
  type ApiFootballLineupResponse,
  type ApiFootballPlayersResponse,
  type ApiFootballSquadResponse,
  type ApiFootballStatisticsResponse,
  type ApiFootballTeamRef,
} from '../adapters/api-football/index.js';
import type { FootballGameBridgeClient } from './clients/game-service.js';
import type { FootballIdentityLookupClient } from './clients/identity.js';
import type { IngestionWorkload } from './ingestion.js';
import type {
  MatchConcludedObserveOutcome,
  MatchConcludedPublisher,
  MatchFixtureObservation,
} from './match-concluded-publisher.js';

/**
 * Callback shape consumed by the ingestion loop. Fired after every
 * successful `fetchWorkload` for a fixture-scoped workload that returned
 * either freshly-fetched or cached JSON.
 */
export type OnFixtureFetched = (input: {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly data: unknown;
}) => Promise<void> | void;

export interface MatchConcludedBridgeLogEntry {
  readonly event: string;
  readonly workload?: IngestionWorkload;
  readonly resourceId?: string;
  readonly providerFixtureId?: string;
  readonly providerId?: string;
  readonly providerStatus?: string;
  readonly gameId?: string;
  readonly outcome?: MatchConcludedObserveOutcome['outcome'];
  readonly message?: string;
  readonly reason?: string;
  readonly acceptedCount?: number;
  readonly updatedCount?: number;
  readonly skippedCount?: number;
  readonly attempts?: number;
}

export type MatchConcludedBridgeLogger = (entry: MatchConcludedBridgeLogEntry) => void;

const defaultBridgeLogger: MatchConcludedBridgeLogger = (entry) => {
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
};

/**
 * Workloads whose response payload is a single-fixture envelope. The
 * match-concluded observation ignores any other workload to keep that contract
 * obvious. Event and lineup workloads are handled by separate ingest branches.
 */
const FIXTURE_DETAIL_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set([
  'fixture-detail-preKO',
  'fixture-detail-live',
  'fixture-detail-fullTime',
]);

const EVENT_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set(['events-post-final']);
const LINEUP_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set(['lineups-post-confirm']);
const SQUAD_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set(['squad-list-fallback']);
const TEAM_STATS_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set(['team-match-stats']);
const PLAYER_STATS_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set(['player-match-stats']);
const GAME_LOOKUP_RETRY_DELAYS_MS = [100, 500, 1_000] as const;

export const isFixtureDetailWorkload = (workload: IngestionWorkload): boolean =>
  FIXTURE_DETAIL_WORKLOADS.has(workload);

export interface MatchConcludedBridgeOptions {
  /** Publisher that owns the emit-once gate + XADD. */
  readonly publisher: MatchConcludedPublisher;
  /**
   * Game-service lookup boundary. Used to resolve fixture id → BTL
   * canonical `game_id` via `LookupGameByFixture`. This is the live
   * crosswalk; identity-server cannot serve it (read-only snapshot).
   */
  readonly gameService: FootballGameBridgeClient;
  /**
   * Identity-server lookup boundary for provider teams, players,
   * competitions, and seasons. GAME ids still resolve through
   * `gameService.LookupGameByFixture` above.
   */
  readonly identity: FootballIdentityLookupClient;
  /** Provider id used both for the lookup + observation envelope. */
  readonly providerId: string;
  /** Override the bridge log sink. */
  readonly logger?: MatchConcludedBridgeLogger;
  /** Wall clock; defaulted for tests. */
  readonly clock?: () => number;
  /**
   * Short retry window for event/lineup workloads that can race fixture-detail
   * ingestion during an immediate boot tick.
   */
  readonly gameLookupRetryDelaysMs?: readonly number[];
}

/**
 * Build a bridge callback. The returned function is safe to drop into
 * `IngestionLoopOptions.onFixtureFetched` and is a no-op for non-fixture
 * workloads or unparseable payloads.
 */
export const createMatchConcludedBridge = (
  options: MatchConcludedBridgeOptions
): OnFixtureFetched => {
  const log = options.logger ?? defaultBridgeLogger;
  const clock = options.clock ?? Date.now;
  const publisher = options.publisher;
  const gameService = options.gameService;
  const identity = options.identity;
  const providerId = options.providerId;
  const gameLookupRetryDelaysMs = options.gameLookupRetryDelaysMs ?? GAME_LOOKUP_RETRY_DELAYS_MS;

  return async ({ workload, resourceId, data }) => {
    if (EVENT_WORKLOADS.has(workload)) {
      await ingestEvents({
        workload,
        resourceId,
        data,
        providerId,
        gameService,
        identity,
        log,
        clock,
        gameLookupRetryDelaysMs,
      });
      return;
    }

    if (LINEUP_WORKLOADS.has(workload)) {
      await ingestLineups({
        workload,
        resourceId,
        data,
        providerId,
        gameService,
        identity,
        log,
        clock,
        gameLookupRetryDelaysMs,
      });
      return;
    }

    if (SQUAD_WORKLOADS.has(workload)) {
      await ingestSquadList({
        workload,
        resourceId,
        data,
        providerId,
        gameService,
        identity,
        log,
        clock,
        gameLookupRetryDelaysMs,
      });
      return;
    }

    if (TEAM_STATS_WORKLOADS.has(workload)) {
      await ingestTeamStats({
        workload,
        resourceId,
        data,
        providerId,
        gameService,
        identity,
        log,
        clock,
        gameLookupRetryDelaysMs,
      });
      return;
    }

    if (PLAYER_STATS_WORKLOADS.has(workload)) {
      await ingestPlayerStats({
        workload,
        resourceId,
        data,
        providerId,
        gameService,
        identity,
        log,
        clock,
        gameLookupRetryDelaysMs,
      });
      return;
    }

    if (!FIXTURE_DETAIL_WORKLOADS.has(workload)) {
      return;
    }

    const decoded = decodeFixtureEnvelope(data);
    if (!decoded) {
      log({
        event: 'bridge_decode_skipped',
        workload,
        resourceId,
        reason: 'malformed_response',
      });
      return;
    }

    const { providerFixtureId, providerStatus, concludedAtMs } = decoded;
    const entityResolutions = await resolveFixtureEntities(identity, providerId, data, log, {
      workload,
      resourceId,
      providerFixtureId,
      providerStatus,
    });

    const ingestRequest = apiFootballIngestGamesRequestFromFixtures({
      provider: providerId,
      replayId: `live:${workload}:${resourceId}`,
      resourceId,
      envelope: data,
      entityResolutions,
      fetchedAtMs: clock(),
    });
    if (ingestRequest.games.length > 0) {
      try {
        const ingestResponse = await gameService.ingestGames(ingestRequest);
        log({
          event: 'bridge_game_ingested',
          workload,
          resourceId,
          providerFixtureId,
          providerStatus,
          providerId,
          acceptedCount: ingestResponse.acceptedCount,
          updatedCount: ingestResponse.updatedCount,
        });
      } catch (err) {
        log({
          event: 'bridge_game_ingest_error',
          workload,
          resourceId,
          providerFixtureId,
          providerStatus,
          providerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let lookupResponse: LookupGameByFixtureResponse;
    try {
      lookupResponse = await gameService.lookupGameByFixture(
        create(LookupGameByFixtureRequestSchema, {
          provider: providerId,
          providerFixtureId,
        })
      );
    } catch (err) {
      log({
        event: 'bridge_game_lookup_error',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!lookupResponse.found || !lookupResponse.gameId) {
      log({
        event: 'bridge_game_not_found',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
      });
      return;
    }

    const observation: MatchFixtureObservation = {
      providerFixtureId,
      gameId: lookupResponse.gameId,
      providerStatus,
      concludedAtMs: concludedAtMs ?? clock(),
      providerId,
    };

    try {
      const outcome = await publisher.observe(observation);
      log({
        event: 'bridge_observed',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
        gameId: observation.gameId,
        outcome: outcome.outcome,
      });
    } catch (err) {
      // observe() is documented as no-throw, but defend against an
      // unexpected client error so the ingestion tick is never poisoned.
      log({
        event: 'bridge_observe_failed',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
        gameId: observation.gameId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
};

interface ProviderResourceBridgeInput {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly data: unknown;
  readonly providerId: string;
  readonly gameService: FootballGameBridgeClient;
  readonly identity: FootballIdentityLookupClient;
  readonly log: MatchConcludedBridgeLogger;
  readonly clock: () => number;
  readonly gameLookupRetryDelaysMs: readonly number[];
}

const ingestEvents = async (input: ProviderResourceBridgeInput): Promise<void> => {
  const events = decodeEventEnvelope(input.data);
  if (events.length === 0) {
    input.log({
      event: 'bridge_events_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'empty_provider_response',
    });
    return;
  }
  const gameId = await lookupGameId(input);
  if (!gameId) {
    return;
  }
  const entityResolutions = await resolveEventEntities(
    input.identity,
    input.providerId,
    events,
    input.log,
    {
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
    }
  );
  const request = apiFootballIngestOccurrencesRequestFromEvents({
    provider: input.providerId,
    replayId: `live:${input.workload}:${input.resourceId}`,
    resourceId: input.resourceId,
    gameId,
    envelope: input.data,
    entityResolutions,
    fetchedAtMs: input.clock(),
  });
  if (request.occurrences.length === 0) {
    input.log({
      event: 'bridge_events_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'no_normalized_occurrences',
    });
    return;
  }
  try {
    const response = await input.gameService.ingestGameOccurrences(request);
    input.log({
      event: 'bridge_events_ingested',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      acceptedCount: response.acceptedCount,
      updatedCount: response.updatedCount,
    });
  } catch (err) {
    input.log({
      event: 'bridge_events_ingest_error',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

const ingestLineups = async (input: ProviderResourceBridgeInput): Promise<void> => {
  const lineups = decodeLineupEnvelope(input.data);
  if (lineups.length === 0) {
    input.log({
      event: 'bridge_lineups_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'empty_provider_response',
    });
    return;
  }
  const gameId = await lookupGameId(input);
  if (!gameId) {
    return;
  }
  const entityResolutions = await resolveLineupEntities(
    input.identity,
    input.providerId,
    lineups,
    input.log,
    {
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
    }
  );
  const request = apiFootballIngestLineupsRequestFromLineups({
    provider: input.providerId,
    replayId: `live:${input.workload}:${input.resourceId}`,
    resourceId: input.resourceId,
    gameId,
    envelope: input.data,
    entityResolutions,
    fetchedAtMs: input.clock(),
  });
  if (request.lineups.length === 0) {
    input.log({
      event: 'bridge_lineups_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'no_normalized_lineups',
    });
    return;
  }
  try {
    const response = await input.gameService.ingestFootballLineups(request);
    input.log({
      event: 'bridge_lineups_ingested',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      acceptedCount: response.acceptedCount,
      updatedCount: response.updatedCount,
    });
  } catch (err) {
    input.log({
      event: 'bridge_lineups_ingest_error',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

const ingestSquadList = async (input: ProviderResourceBridgeInput): Promise<void> => {
  const resource = parseSquadListResourceId(input.resourceId);
  if (!resource) {
    input.log({
      event: 'bridge_squad_list_skipped',
      workload: input.workload,
      resourceId: input.resourceId,
      providerId: input.providerId,
      reason: 'malformed_resource_id',
    });
    return;
  }
  const squads = decodeSquadEnvelope(input.data);
  if (squads.length === 0) {
    input.log({
      event: 'bridge_squad_list_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: resource.fixtureId,
      providerId: input.providerId,
      reason: 'empty_provider_response',
    });
    return;
  }
  const gameId = await lookupGameId({ ...input, resourceId: resource.fixtureId });
  if (!gameId) {
    return;
  }
  const entityResolutions = await resolveSquadEntities(
    input.identity,
    input.providerId,
    squads,
    input.log,
    {
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: resource.fixtureId,
    }
  );
  const request = apiFootballIngestSquadListRequestFromSquads({
    provider: input.providerId,
    replayId: `live:${input.workload}:${input.resourceId}`,
    resourceId: input.resourceId,
    gameId,
    envelope: input.data,
    entityResolutions,
    fetchedAtMs: input.clock(),
  });
  if (request.squadLists.length === 0) {
    input.log({
      event: 'bridge_squad_list_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: resource.fixtureId,
      providerId: input.providerId,
      reason: 'no_normalized_squad_list',
    });
    return;
  }
  try {
    const response = await input.gameService.ingestFootballSquadLists(request);
    input.log({
      event: 'bridge_squad_list_ingested',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: resource.fixtureId,
      providerId: input.providerId,
      gameId,
      acceptedCount: response.acceptedCount,
      updatedCount: response.updatedCount,
    });
  } catch (err) {
    input.log({
      event: 'bridge_squad_list_ingest_error',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: resource.fixtureId,
      providerId: input.providerId,
      gameId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

const ingestTeamStats = async (input: ProviderResourceBridgeInput): Promise<void> => {
  const statistics = decodeStatisticsEnvelope(input.data);
  if (statistics.length === 0) {
    input.log({
      event: 'bridge_team_stats_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'empty_provider_response',
    });
    return;
  }
  const gameId = await lookupGameId(input);
  if (!gameId) {
    return;
  }
  const entityResolutions = await resolveTeamStatsEntities(
    input.identity,
    input.providerId,
    statistics,
    input.log,
    {
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
    }
  );
  // API-Football returns the statistics array in [home, away] team order;
  // pass the provider team ids through so the mapper can stamp
  // GameParticipantRole without a second fixture-detail fetch.
  const request = apiFootballIngestTeamMatchStatsRequestFromStatistics({
    provider: input.providerId,
    replayId: `live:${input.workload}:${input.resourceId}`,
    resourceId: input.resourceId,
    gameId,
    envelope: input.data,
    entityResolutions,
    homeTeamProviderId: statistics[0] ? String(statistics[0].team.id) : undefined,
    awayTeamProviderId: statistics[1] ? String(statistics[1].team.id) : undefined,
    fetchedAtMs: input.clock(),
  });
  if (request.teamStats.length === 0) {
    input.log({
      event: 'bridge_team_stats_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'no_normalized_team_stats',
    });
    return;
  }
  try {
    const response = await input.gameService.ingestTeamMatchStats(request);
    input.log({
      event: 'bridge_team_stats_ingested',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      acceptedCount: response.acceptedCount,
      updatedCount: response.updatedCount,
    });
  } catch (err) {
    input.log({
      event: 'bridge_team_stats_ingest_error',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

const ingestPlayerStats = async (input: ProviderResourceBridgeInput): Promise<void> => {
  const players = decodePlayersEnvelope(input.data);
  if (players.length === 0) {
    input.log({
      event: 'bridge_player_stats_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'empty_provider_response',
    });
    return;
  }
  const gameId = await lookupGameId(input);
  if (!gameId) {
    return;
  }
  const entityResolutions = await resolvePlayerStatsEntities(
    input.identity,
    input.providerId,
    players,
    input.log,
    {
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
    }
  );
  const request = apiFootballIngestPlayerMatchStatsRequestFromPlayers({
    provider: input.providerId,
    replayId: `live:${input.workload}:${input.resourceId}`,
    resourceId: input.resourceId,
    gameId,
    envelope: input.data,
    entityResolutions,
    fetchedAtMs: input.clock(),
  });
  if (request.playerStats.length === 0) {
    input.log({
      event: 'bridge_player_stats_missing',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      reason: 'no_normalized_player_stats',
    });
    return;
  }
  try {
    const response = await input.gameService.ingestPlayerMatchStats(request);
    input.log({
      event: 'bridge_player_stats_ingested',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      acceptedCount: response.acceptedCount,
      updatedCount: response.updatedCount,
    });
  } catch (err) {
    input.log({
      event: 'bridge_player_stats_ingest_error',
      workload: input.workload,
      resourceId: input.resourceId,
      providerFixtureId: input.resourceId,
      providerId: input.providerId,
      gameId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

const lookupGameId = async (input: ProviderResourceBridgeInput): Promise<string> => {
  for (let attempt = 0; ; attempt += 1) {
    let lookupResponse: LookupGameByFixtureResponse;
    try {
      lookupResponse = await input.gameService.lookupGameByFixture(
        create(LookupGameByFixtureRequestSchema, {
          provider: input.providerId,
          providerFixtureId: input.resourceId,
        })
      );
    } catch (err) {
      input.log({
        event: 'bridge_game_lookup_error',
        workload: input.workload,
        resourceId: input.resourceId,
        providerFixtureId: input.resourceId,
        providerId: input.providerId,
        attempts: attempt + 1,
        message: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
    if (lookupResponse.found && lookupResponse.gameId) {
      return lookupResponse.gameId;
    }

    const delayMs = input.gameLookupRetryDelaysMs[attempt];
    if (delayMs === undefined) {
      input.log({
        event: 'bridge_game_not_found',
        workload: input.workload,
        resourceId: input.resourceId,
        providerFixtureId: input.resourceId,
        providerId: input.providerId,
        attempts: attempt + 1,
      });
      return '';
    }
    await sleep(delayMs);
  }
};

interface DecodedFixture {
  readonly providerFixtureId: string;
  readonly providerStatus: string;
  readonly concludedAtMs?: number;
}

/**
 * Extract the bits the publisher needs from the API-Football fixture
 * detail response. Returns `null` for any malformed shape; the bridge
 * logs and skips so a single bad payload cannot poison the ingest tick.
 *
 * Shape:
 *   { response: [ { fixture: { id, date, status: { short } }, ... } ] }
 */
export const decodeFixtureEnvelope = (data: unknown): DecodedFixture | null => {
  if (!isRecord(data)) {
    return null;
  }
  const list = (data as { response?: unknown }).response;
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  const first = list[0];
  if (!isRecord(first)) {
    return null;
  }
  const fixture = (first as { fixture?: unknown }).fixture;
  if (!isRecord(fixture)) {
    return null;
  }
  const rawId = (fixture as { id?: unknown }).id;
  if (rawId === undefined || rawId === null || rawId === '') {
    return null;
  }
  const status = (fixture as { status?: unknown }).status;
  if (!isRecord(status)) {
    return null;
  }
  const shortRaw = (status as { short?: unknown }).short;
  if (typeof shortRaw !== 'string' || shortRaw.length === 0) {
    return null;
  }
  const rawDate = (fixture as { date?: unknown }).date;
  let concludedAtMs: number | undefined;
  if (typeof rawDate === 'string' && rawDate.length > 0) {
    const parsed = Date.parse(rawDate);
    if (Number.isFinite(parsed)) {
      concludedAtMs = parsed;
    }
  }
  return {
    providerFixtureId: String(rawId),
    providerStatus: shortRaw,
    concludedAtMs,
  };
};

const decodeFixtureResponses = (data: unknown): readonly ApiFootballFixtureResponse[] => {
  const response = responseArray(data);
  return response.filter((item): item is ApiFootballFixtureResponse => {
    if (!isRecord(item) || !isRecord(item.fixture) || !isRecord(item.league)) {
      return false;
    }
    const teams = item.teams;
    return isRecord(teams) && isRecord(teams.home) && isRecord(teams.away);
  });
};

const decodeEventEnvelope = (data: unknown): readonly ApiFootballEventResponse[] => {
  const response = responseArray(data);
  return response.filter((item): item is ApiFootballEventResponse => {
    if (!isRecord(item) || !isRecord(item.time) || !isRecord(item.team)) {
      return false;
    }
    return typeof item.type === 'string' && typeof item.detail === 'string';
  });
};

const decodeLineupEnvelope = (data: unknown): readonly ApiFootballLineupResponse[] => {
  const response = responseArray(data);
  return response.filter((item): item is ApiFootballLineupResponse => {
    if (!isRecord(item) || !isRecord(item.team)) {
      return false;
    }
    return (
      typeof item.formation === 'string' &&
      Array.isArray(item.startXI) &&
      Array.isArray(item.substitutes)
    );
  });
};

const decodeSquadEnvelope = (data: unknown): readonly ApiFootballSquadResponse[] => {
  const response = responseArray(data);
  return response.filter((item): item is ApiFootballSquadResponse => {
    if (!isRecord(item) || !isRecord(item.team) || !Array.isArray(item.players)) {
      return false;
    }
    return item.players.some(
      (entry) => isRecord(entry) && Number.isFinite(entry.id) && typeof entry.name === 'string'
    );
  });
};

const decodeStatisticsEnvelope = (data: unknown): readonly ApiFootballStatisticsResponse[] => {
  const response = responseArray(data);
  return response.filter((item): item is ApiFootballStatisticsResponse => {
    if (!isRecord(item) || !isRecord(item.team) || !Array.isArray(item.statistics)) {
      return false;
    }
    return Number.isFinite((item.team as { id?: unknown }).id);
  });
};

const decodePlayersEnvelope = (data: unknown): readonly ApiFootballPlayersResponse[] => {
  const response = responseArray(data);
  return response.filter((item): item is ApiFootballPlayersResponse => {
    if (!isRecord(item) || !isRecord(item.team) || !Array.isArray(item.players)) {
      return false;
    }
    return Number.isFinite((item.team as { id?: unknown }).id);
  });
};

const responseArray = (data: unknown): readonly unknown[] => {
  if (!isRecord(data)) {
    return [];
  }
  const response = data.response;
  return Array.isArray(response) ? response : [];
};

const parseSquadListResourceId = (
  resourceId: string
): { readonly fixtureId: string; readonly teamId: string } | null => {
  const [fixtureId, teamId, ...rest] = resourceId.split(':');
  if (rest.length > 0 || !fixtureId?.trim() || !teamId?.trim()) {
    return null;
  }
  return { fixtureId: fixtureId.trim(), teamId: teamId.trim() };
};

interface ResolutionLogContext {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly providerFixtureId?: string;
  readonly providerStatus?: string;
}

const resolveFixtureEntities = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  data: unknown,
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<ApiFootballEntityResolutionMap> => {
  const resolutions = emptyResolutionMap();
  const fixture = decodeFixtureResponses(data)[0];
  if (!fixture) {
    return resolutions;
  }
  await addResolvedEntity({
    identity,
    providerId,
    resolutions,
    kind: 'competition',
    entityType: EntityType.COMPETITION,
    providerIds: [String(fixture.league.id)],
    label: fixture.league.name,
    log,
    context,
  });
  await addResolvedEntity({
    identity,
    providerId,
    resolutions,
    kind: 'season',
    entityType: EntityType.SEASON,
    providerIds: [
      apiFootballSeasonProviderId(fixture.league.id, fixture.league.season),
      String(fixture.league.season),
    ],
    label: `${fixture.league.season} ${fixture.league.name}`,
    log,
    context,
  });
  await addResolvedTeam(identity, providerId, resolutions, fixture.teams.home, log, context);
  await addResolvedTeam(identity, providerId, resolutions, fixture.teams.away, log, context);
  return resolutions;
};

const resolveEventEntities = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  events: readonly ApiFootballEventResponse[],
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<ApiFootballEntityResolutionMap> => {
  const resolutions = emptyResolutionMap();
  for (const event of events) {
    await addResolvedTeam(identity, providerId, resolutions, event.team, log, context);
    await addResolvedPlayer(identity, providerId, resolutions, event.player, log, context);
    await addResolvedPlayer(identity, providerId, resolutions, event.assist, log, context);
  }
  return resolutions;
};

const resolveLineupEntities = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  lineups: readonly ApiFootballLineupResponse[],
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<ApiFootballEntityResolutionMap> => {
  const resolutions = emptyResolutionMap();
  for (const lineup of lineups) {
    await addResolvedTeam(identity, providerId, resolutions, lineup.team, log, context);
    for (const entry of [...lineup.startXI, ...lineup.substitutes]) {
      await addResolvedPlayer(identity, providerId, resolutions, entry.player, log, context);
    }
  }
  return resolutions;
};

const resolveSquadEntities = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  squads: readonly ApiFootballSquadResponse[],
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<ApiFootballEntityResolutionMap> => {
  const resolutions = emptyResolutionMap();
  for (const squad of squads) {
    await addResolvedTeam(identity, providerId, resolutions, squad.team, log, context);
    for (const player of squad.players) {
      await addResolvedPlayer(identity, providerId, resolutions, player, log, context);
    }
  }
  return resolutions;
};

const resolveTeamStatsEntities = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  statistics: readonly ApiFootballStatisticsResponse[],
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<ApiFootballEntityResolutionMap> => {
  const resolutions = emptyResolutionMap();
  for (const entry of statistics) {
    await addResolvedTeam(identity, providerId, resolutions, entry.team, log, context);
  }
  return resolutions;
};

const resolvePlayerStatsEntities = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  players: readonly ApiFootballPlayersResponse[],
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<ApiFootballEntityResolutionMap> => {
  const resolutions = emptyResolutionMap();
  for (const teamEntry of players) {
    await addResolvedTeam(identity, providerId, resolutions, teamEntry.team, log, context);
    for (const playerEntry of teamEntry.players) {
      await addResolvedPlayer(identity, providerId, resolutions, playerEntry.player, log, context);
    }
  }
  return resolutions;
};

const addResolvedTeam = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  resolutions: MutableResolutionMap,
  team: ApiFootballTeamRef | null | undefined,
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<void> => {
  if (!team) {
    return;
  }
  await addResolvedEntity({
    identity,
    providerId,
    resolutions,
    kind: 'team',
    entityType: EntityType.TEAM,
    providerIds: [String(team.id)],
    label: team.name,
    log,
    context,
  });
};

const addResolvedPlayer = async (
  identity: FootballIdentityLookupClient,
  providerId: string,
  resolutions: MutableResolutionMap,
  player: { readonly id: number; readonly name: string } | null | undefined,
  log: MatchConcludedBridgeLogger,
  context: ResolutionLogContext
): Promise<void> => {
  if (!player) {
    return;
  }
  await addResolvedEntity({
    identity,
    providerId,
    resolutions,
    kind: 'player',
    entityType: EntityType.PLAYER,
    providerIds: [String(player.id)],
    label: player.name,
    log,
    context,
  });
};

type MutableResolutionMap = {
  competitions: Record<string, ApiFootballResolvedEntity | undefined>;
  seasons: Record<string, ApiFootballResolvedEntity | undefined>;
  teams: Record<string, ApiFootballResolvedEntity | undefined>;
  players: Record<string, ApiFootballResolvedEntity | undefined>;
};

const emptyResolutionMap = (): MutableResolutionMap => ({
  competitions: {},
  seasons: {},
  teams: {},
  players: {},
});

const addResolvedEntity = async (input: {
  readonly identity: FootballIdentityLookupClient;
  readonly providerId: string;
  readonly resolutions: MutableResolutionMap;
  readonly kind: ApiFootballEntityKind;
  readonly entityType: EntityType;
  readonly providerIds: readonly string[];
  readonly label: string;
  readonly log: MatchConcludedBridgeLogger;
  readonly context: ResolutionLogContext;
}): Promise<void> => {
  const primaryProviderId = input.providerIds[0] ?? '';
  if (!primaryProviderId || resolutionBucket(input.resolutions, input.kind)[primaryProviderId]) {
    return;
  }
  for (const providerEntityId of input.providerIds) {
    try {
      const resolved = await input.identity.resolve(
        create(ResolveRequestSchema, {
          entityType: input.entityType,
          provider: input.providerId,
          providerId: providerEntityId,
        })
      );
      if (resolved.found && resolved.entityId) {
        resolutionBucket(input.resolutions, input.kind)[primaryProviderId] = {
          entityId: resolved.entityId,
          label: labelFromResolveResponse(resolved) || input.label,
        };
        return;
      }
    } catch (err) {
      input.log({
        event: 'bridge_identity_resolve_error',
        workload: input.context.workload,
        resourceId: input.context.resourceId,
        providerFixtureId: input.context.providerFixtureId,
        providerStatus: input.context.providerStatus,
        providerId: input.providerId,
        reason: `${input.kind}:${providerEntityId}`,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }
};

const resolutionBucket = (
  resolutions: MutableResolutionMap,
  kind: ApiFootballEntityKind
): Record<string, ApiFootballResolvedEntity | undefined> => {
  switch (kind) {
    case 'competition':
      return resolutions.competitions;
    case 'season':
      return resolutions.seasons;
    case 'team':
      return resolutions.teams;
    case 'player':
      return resolutions.players;
  }
};

const labelFromResolveResponse = (response: ResolveResponse): string => {
  const entity = response.entity?.entity;
  switch (entity?.case) {
    case 'player':
      return entity.value.commonName || entity.value.fullName;
    case 'team':
      return entity.value.shortName || entity.value.name || entity.value.fullName;
    case 'competition':
      return entity.value.shortName || entity.value.name;
    case 'season':
      return entity.value.label;
    default:
      return '';
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Test-only exports. */
export const __test = {
  FIXTURE_DETAIL_WORKLOADS,
};
