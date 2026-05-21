import { fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  type IngestBatchResponse,
  type IngestFootballLineupsRequest,
  type IngestFootballStandingsRequest,
  type IngestGameOccurrencesRequest,
  type IngestGamesRequest,
  type ListProviderConfigsRequest,
  type ListProviderConfigsResponse,
  type LookupGameByFixtureRequest,
  type LookupGameByFixtureResponse,
  LookupGameByFixtureRequestSchema,
  LookupGameByFixtureResponseSchema,
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
 * Kept narrow on purpose: ingestion bridges have no need for the broader
 * GameService surface, so we avoid widening this contract. Future paths
 * (player crosswalks, team metadata, etc.) continue to use
 * `FootballIdentityLookupClient` against identity-server.
 */
export interface FootballGameLookupClient {
  lookupGameByFixture(
    request: LookupGameByFixtureRequest,
  ): Promise<LookupGameByFixtureResponse>;
}

/**
 * Minimal fetch contract used by the game-service client transport.
 * Mirrors the native `fetch` signature so tests can inject a mock without
 * depending on the global. Identical shape to `IdentityFetch` in
 * `clients/identity.ts`.
 */
export type GameServiceFetch = (
  input: string | URL,
  init?: { method: string; headers: Record<string, string>; body: Uint8Array },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

/**
 * Connect-protocol unary endpoint shape:
 *   `<baseUrl>/<package>.<service>/<method>`
 * Always POST with `application/proto` content type carrying the binary
 * request body. game-service is the only consumer here so we keep the
 * transport private to this module rather than pulling in
 * `@connectrpc/connect-node` (not in dependencies).
 */
const GAME_SERVICE_PATH = '/btl.game.v1.GameService';

export interface FetchFootballGameLookupClientOptions {
  /** Base URL of the game-service, e.g. `http://game-service:9090`. */
  readonly baseUrl: string;
  /** Override fetch for tests. Defaults to the global `fetch`. */
  readonly fetchFn?: GameServiceFetch;
  /** Hard request timeout in ms. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_GAME_SERVICE_TIMEOUT_MS = 5_000;

/**
 * Build a `FootballGameLookupClient` backed by native fetch + Connect
 * protocol unary calls. Used by the match-concluded bridge to swap the
 * old identity-server `Resolve` call for the new game-service
 * `LookupGameByFixture` RPC. Other GameService methods are deliberately
 * not surfaced here — keep the boundary narrow.
 */
export const createFetchFootballGameLookupClient = (
  options: FetchFootballGameLookupClientOptions,
): FootballGameLookupClient => {
  const fetchFn = options.fetchFn ?? defaultGameServiceFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GAME_SERVICE_TIMEOUT_MS;
  const baseUrl = stripTrailingSlash(options.baseUrl);

  const callUnary = async <TReq, TRes>(
    method: string,
    request: TReq,
    requestSchema: Parameters<typeof toBinary>[0],
    responseSchema: Parameters<typeof fromBinary>[0],
  ): Promise<TRes> => {
    const url = `${baseUrl}${GAME_SERVICE_PATH}/${method}`;
    const body = toBinary(requestSchema, request as never);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<GameServiceFetch>>;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/proto',
          accept: 'application/proto',
          'connect-protocol-version': '1',
        },
        body,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(
        `game-service ${method} failed: status=${response.status} body=${truncate(text, 200)}`,
      );
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return fromBinary(responseSchema, bytes) as TRes;
  };

  return {
    lookupGameByFixture(
      request: LookupGameByFixtureRequest,
    ): Promise<LookupGameByFixtureResponse> {
      return callUnary<LookupGameByFixtureRequest, LookupGameByFixtureResponse>(
        'LookupGameByFixture',
        request,
        LookupGameByFixtureRequestSchema,
        LookupGameByFixtureResponseSchema,
      );
    },
  };
};

const defaultGameServiceFetch: GameServiceFetch = async (input, init) => {
  const response = await fetch(input as string | URL, init as RequestInit | undefined);
  return response;
};

const stripTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

const safeReadText = async (
  response: { text(): Promise<string> },
): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;
