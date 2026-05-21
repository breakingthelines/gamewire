import { fromJsonString } from '@bufbuild/protobuf';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  type LookupRequest,
  type LookupResponse,
  LookupResponseSchema,
  type ResolveRequest,
  type ResolveResponse,
  ResolveResponseSchema,
  type SearchRequest,
  type SearchResponse,
  SearchResponseSchema,
  type StatsRequest,
  type StatsResponse,
  StatsResponseSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

/**
 * Read-only client boundary for the BTL identity-server. The API-Football
 * ingestion bridge calls `resolve` for provider teams, players, competitions,
 * and seasons. Provider fixture → canonical game lookup stays on game-service.
 */
export interface FootballIdentityLookupClient {
  lookup(request: LookupRequest): Promise<LookupResponse>;
  resolve(request: ResolveRequest): Promise<ResolveResponse>;
  search(request: SearchRequest): Promise<SearchResponse>;
  stats(request: StatsRequest): Promise<StatsResponse>;
}

export interface FootballIdentityLookupClientOptions {
  baseUrl: string;
  providerId: string;
}

export const createFootballIdentityLookupBoundary = (
  options: FootballIdentityLookupClientOptions
): FootballIdentityLookupClientOptions => ({
  baseUrl: options.baseUrl,
  providerId: options.providerId,
});

/**
 * Minimal fetch contract used by the identity client transport. Mirrors the
 * native `fetch` signature so tests can inject a mock without depending on
 * the global.
 */
export type IdentityFetch = (
  input: string | URL,
  init?: { method: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * The deployed identity-server exposes its read-only surface over simple
 * HTTP GET endpoints that return protobuf JSON. Do not use Connect here:
 * the gRPC server is exposed separately, while the staging worker is wired
 * to the HTTP port.
 */
export interface FetchIdentityClientOptions {
  /** Base URL of the identity-server, e.g. `http://identity:9090`. */
  readonly baseUrl: string;
  /** Override fetch for tests. Defaults to the global `fetch`. */
  readonly fetchFn?: IdentityFetch;
  /** Hard request timeout in ms. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_IDENTITY_TIMEOUT_MS = 5_000;

/**
 * Build a `FootballIdentityLookupClient` backed by native fetch + the
 * identity-server HTTP JSON endpoints. The bridge exercises `resolve`; the
 * other methods are provided so the boundary stays complete for browser/server
 * callers.
 */
export const createFetchFootballIdentityLookupClient = (
  options: FetchIdentityClientOptions
): FootballIdentityLookupClient => {
  const fetchFn = options.fetchFn ?? defaultIdentityFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
  const baseUrl = stripTrailingSlash(options.baseUrl);

  const callJson = async <TRes>(
    path: string,
    params: URLSearchParams,
    responseSchema: Parameters<typeof fromJsonString>[0]
  ): Promise<TRes> => {
    const query = params.toString();
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<IdentityFetch>>;
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(
        `identity-server ${path} failed: status=${response.status} body=${truncate(text, 200)}`
      );
    }
    const text = await response.text();
    return fromJsonString(responseSchema, text, { ignoreUnknownFields: true }) as TRes;
  };

  return {
    lookup(request: LookupRequest): Promise<LookupResponse> {
      const params = new URLSearchParams({ id: request.id });
      appendEntityType(params, request.entityType);
      return callJson<LookupResponse>('/v1/lookup', params, LookupResponseSchema);
    },
    resolve(request: ResolveRequest): Promise<ResolveResponse> {
      const params = new URLSearchParams({
        provider: request.provider,
        provider_id: request.providerId,
      });
      appendEntityType(params, request.entityType);
      return callJson<ResolveResponse>('/v1/resolve', params, ResolveResponseSchema);
    },
    search(request: SearchRequest): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: request.query });
      appendEntityType(params, request.entityType);
      if (request.limit > 0) {
        params.set('limit', String(request.limit));
      }
      return callJson<SearchResponse>('/v1/search', params, SearchResponseSchema);
    },
    stats(request: StatsRequest): Promise<StatsResponse> {
      const params = new URLSearchParams();
      if (request.sport) {
        params.set('sport', request.sport);
      }
      return callJson<StatsResponse>('/v1/stats', params, StatsResponseSchema);
    },
  };
};

const defaultIdentityFetch: IdentityFetch = async (input, init) => {
  const response = await fetch(input as string | URL, init as RequestInit | undefined);
  return response;
};

const stripTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

const safeReadText = async (response: { text(): Promise<string> }): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

const appendEntityType = (params: URLSearchParams, entityType: EntityType): void => {
  const value = entityTypeParam(entityType);
  if (value) {
    params.set('type', value);
  }
};

const entityTypeParam = (entityType: EntityType): string => {
  switch (entityType) {
    case EntityType.PLAYER:
      return 'player';
    case EntityType.TEAM:
      return 'team';
    case EntityType.COACH:
      return 'coach';
    case EntityType.COMPETITION:
      return 'competition';
    case EntityType.SEASON:
      return 'season';
    case EntityType.VENUE:
      return 'venue';
    case EntityType.OFFICIAL:
      return 'official';
    case EntityType.GAME:
      return 'game';
    default:
      return '';
  }
};
