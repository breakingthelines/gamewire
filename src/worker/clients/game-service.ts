import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';

import {
  GameService,
  type IngestBatchResponse,
  type IngestFootballLineupsRequest,
  type IngestFootballStandingsRequest,
  type IngestGameOccurrencesRequest,
  type IngestGamesRequest,
  type ListProviderConfigsRequest,
  type ListProviderConfigsResponse,
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
  ingestFootballStandings(request: IngestFootballStandingsRequest): Promise<IngestBatchResponse>;
  ingestGameOccurrences(request: IngestGameOccurrencesRequest): Promise<IngestBatchResponse>;
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

export interface FootballGameIngestClient {
  ingestGames(request: IngestGamesRequest): Promise<IngestBatchResponse>;
  ingestGameOccurrences(request: IngestGameOccurrencesRequest): Promise<IngestBatchResponse>;
  ingestFootballLineups(request: IngestFootballLineupsRequest): Promise<IngestBatchResponse>;
}

export type FootballGameBridgeClient = FootballGameLookupClient & FootballGameIngestClient;

export interface FetchFootballGameLookupClientOptions {
  /** Base URL of the game-service gRPC server, e.g. `http://game-service:50059`. */
  readonly baseUrl: string;
  /** Hard request timeout in ms. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_GAME_SERVICE_TIMEOUT_MS = 5_000;

/**
 * Build a `FootballGameLookupClient` backed by a real gRPC transport.
 * game-service exposes native gRPC on the mesh port, not Connect-over-HTTP,
 * so the worker must use `createGrpcTransport` here.
 */
export const createFetchFootballGameLookupClient = (
  options: FetchFootballGameLookupClientOptions
): FootballGameBridgeClient => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GAME_SERVICE_TIMEOUT_MS;
  const transport = createGrpcTransport({
    baseUrl: stripTrailingSlash(options.baseUrl),
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
    lookupGameByFixture(request: LookupGameByFixtureRequest): Promise<LookupGameByFixtureResponse> {
      return client.lookupGameByFixture(request, { timeoutMs });
    },
  };
};

const stripTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;
