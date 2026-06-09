import { createClient, type Interceptor } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';

import {
  GameService,
  type IngestBatchResponse,
  type IngestFootballLineupsRequest,
  type IngestFootballSquadListsRequest,
  type IngestFootballStandingsRequest,
  type IngestGameOccurrencesRequest,
  type IngestGamesRequest,
  type IngestPlayerMatchStatsRequest,
  type IngestTeamMatchStatsRequest,
  type ListProviderConfigsRequest,
  type ListProviderConfigsResponse,
  type ListGamesMissingPayloadsRequest,
  type ListGamesMissingPayloadsResponse,
  type LookupGameByFixtureRequest,
  type LookupGameByFixtureResponse,
  type RecordRatingRequest,
  type RecordRatingResponse,
  type ReportProviderHealthRequest,
  type ReportProviderHealthResponse,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

export interface GameServiceIngestClient {
  ingestGames(request: IngestGamesRequest): Promise<IngestBatchResponse>;
  ingestFootballLineups(request: IngestFootballLineupsRequest): Promise<IngestBatchResponse>;
  ingestFootballSquadLists(request: IngestFootballSquadListsRequest): Promise<IngestBatchResponse>;
  ingestFootballStandings(request: IngestFootballStandingsRequest): Promise<IngestBatchResponse>;
  ingestGameOccurrences(request: IngestGameOccurrencesRequest): Promise<IngestBatchResponse>;
  ingestTeamMatchStats(request: IngestTeamMatchStatsRequest): Promise<IngestBatchResponse>;
  ingestPlayerMatchStats(request: IngestPlayerMatchStatsRequest): Promise<IngestBatchResponse>;
  listProviderConfigs(request: ListProviderConfigsRequest): Promise<ListProviderConfigsResponse>;
  reportProviderHealth(request: ReportProviderHealthRequest): Promise<ReportProviderHealthResponse>;
}

export interface GameServiceIngestClientOptions {
  baseUrl: string;
}

export const createGameServiceIngestClientBoundary = (
  options: GameServiceIngestClientOptions
): GameServiceIngestClientOptions => ({
  baseUrl: options.baseUrl,
});

/**
 * Downstream rating aggregation entrypoint. The consumer side of the
 * RatingSubmitted event bus calls this on each event, folding the value
 * into `rating_aggregates` + `rating_distributions` server-side.
 *
 * Kept narrow on purpose: the consumer never needs the rest of the
 * GameService surface, so we avoid widening the boundary contract.
 */
export interface GameServiceRecordRatingClient {
  recordRating(request: RecordRatingRequest): Promise<RecordRatingResponse>;
}

export interface GameServiceRecordRatingClientOptions {
  baseUrl: string;
}

export const createGameServiceRecordRatingClientBoundary = (
  options: GameServiceRecordRatingClientOptions
): GameServiceRecordRatingClientOptions => ({
  baseUrl: options.baseUrl,
});

/**
 * Read-only client boundary for the game-service `LookupGameByFixture` RPC.
 *
 * The match-concluded ingestion bridge calls this to translate a provider
 * fixture id (e.g. an API-Football `fixture.id`) into the BTL canonical
 * `game_id`. The crosswalk lives in `provider_game_mappings` on
 * game-service, populated by `IngestGames` — identity-server runs on a
 * read-only SQLite snapshot and does not carry fixture-level mappings.
 *
 * Kept narrow on purpose: ingestion bridges only need provider fixture lookup
 * plus the game/event/lineup ingest RPCs. Entity crosswalks continue to use
 * `FootballIdentityLookupClient` against identity-server.
 */
export interface FootballGameLookupClient {
  lookupGameByFixture(request: LookupGameByFixtureRequest): Promise<LookupGameByFixtureResponse>;
}

/**
 * Backfill-sweep client boundary for the game-service `ListGamesMissingPayloads` RPC.
 *
 * The sweep-missing-payloads workflow uses this to enumerate finished games whose
 * specified payload (team-match-stats, player-match-stats, events, lineups) was
 * never ingested. It is intentionally a separate boundary from the ingest +
 * lookup surfaces so consumers that only need to discover gaps can depend on a
 * narrow client (and so tests can mock the RPC without standing up the wider
 * ingest surface).
 */
export interface FootballGameMissingPayloadsClient {
  listGamesMissingPayloads(
    request: ListGamesMissingPayloadsRequest
  ): Promise<ListGamesMissingPayloadsResponse>;
}

export interface FootballGameIngestClient {
  ingestGames(request: IngestGamesRequest): Promise<IngestBatchResponse>;
  ingestGameOccurrences(request: IngestGameOccurrencesRequest): Promise<IngestBatchResponse>;
  ingestFootballLineups(request: IngestFootballLineupsRequest): Promise<IngestBatchResponse>;
  ingestFootballSquadLists(request: IngestFootballSquadListsRequest): Promise<IngestBatchResponse>;
  ingestTeamMatchStats(request: IngestTeamMatchStatsRequest): Promise<IngestBatchResponse>;
  ingestPlayerMatchStats(request: IngestPlayerMatchStatsRequest): Promise<IngestBatchResponse>;
}

export type FootballGameBridgeClient = FootballGameLookupClient &
  FootballGameIngestClient &
  FootballGameMissingPayloadsClient;

export interface FetchFootballGameLookupClientOptions {
  /** Base URL of the game-service gRPC server, e.g. `http://game-service:50059`. */
  readonly baseUrl: string;
  /** Hard request timeout in ms. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
  /**
   * Optional Connect interceptors applied to the transport. Production wires
   * zero interceptors so the client ships a bare gRPC call: the mesh
   * (Envoy + auth-service ext_authz) is responsible for stamping
   * `btl-auth-context` on the user-service inbound listener. This hook
   * exists so tests can install a capture interceptor that asserts no
   * client-side auth headers (`authorization`, `btl-auth-context`,
   * `x-spiffe-id`, or any `btl-*` key) ever leave the worker.
   */
  readonly interceptors?: readonly Interceptor[];
}

const DEFAULT_GAME_SERVICE_TIMEOUT_MS = 5_000;

/**
 * Build a `FootballGameLookupClient` backed by a real gRPC transport.
 * game-service exposes native gRPC on the mesh port, not Connect-over-HTTP,
 * so the worker must use `createGrpcTransport` here.
 *
 * The client is intentionally bare: it never attaches `authorization`,
 * `btl-auth-context`, `x-spiffe-id`, or any other auth metadata. SP-tokens
 * for cross-service auth are minted INLINE by auth-service's ext_authz
 * Envoy extension on the user-service inbound listener; the gamewire-worker
 * does not mint, sign, or attach anything client-side. The interceptors
 * hook on the options is reserved for test capture, not for production
 * auth wiring.
 */
export const createFetchFootballGameLookupClient = (
  options: FetchFootballGameLookupClientOptions
): FootballGameBridgeClient => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GAME_SERVICE_TIMEOUT_MS;
  const interceptors = options.interceptors;
  const transport = createGrpcTransport({
    baseUrl: stripTrailingSlash(options.baseUrl),
    ...(interceptors && interceptors.length > 0 ? { interceptors: [...interceptors] } : {}),
  });
  const client = createClient(GameService, transport);

  return {
    ingestGames(request: IngestGamesRequest): Promise<IngestBatchResponse> {
      return client.ingestGames(request, { timeoutMs });
    },
    ingestGameOccurrences(request: IngestGameOccurrencesRequest): Promise<IngestBatchResponse> {
      return client.ingestGameOccurrences(request, { timeoutMs });
    },
    ingestFootballLineups(request: IngestFootballLineupsRequest): Promise<IngestBatchResponse> {
      return client.ingestFootballLineups(request, { timeoutMs });
    },
    ingestFootballSquadLists(
      request: IngestFootballSquadListsRequest
    ): Promise<IngestBatchResponse> {
      return client.ingestFootballSquadLists(request, { timeoutMs });
    },
    ingestTeamMatchStats(request: IngestTeamMatchStatsRequest): Promise<IngestBatchResponse> {
      return client.ingestTeamMatchStats(request, { timeoutMs });
    },
    ingestPlayerMatchStats(request: IngestPlayerMatchStatsRequest): Promise<IngestBatchResponse> {
      return client.ingestPlayerMatchStats(request, { timeoutMs });
    },
    lookupGameByFixture(request: LookupGameByFixtureRequest): Promise<LookupGameByFixtureResponse> {
      return client.lookupGameByFixture(request, { timeoutMs });
    },
    listGamesMissingPayloads(
      request: ListGamesMissingPayloadsRequest
    ): Promise<ListGamesMissingPayloadsResponse> {
      return client.listGamesMissingPayloads(request, { timeoutMs });
    },
  };
};

const stripTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;
