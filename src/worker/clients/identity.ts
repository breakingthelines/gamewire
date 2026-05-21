import { fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  type LookupRequest,
  type LookupResponse,
  LookupRequestSchema,
  LookupResponseSchema,
  type ResolveRequest,
  type ResolveResponse,
  ResolveRequestSchema,
  ResolveResponseSchema,
  type SearchRequest,
  type SearchResponse,
  SearchRequestSchema,
  SearchResponseSchema,
  type StatsRequest,
  type StatsResponse,
  StatsRequestSchema,
  StatsResponseSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

/**
 * Read-only client boundary for the BTL identity-server. The match-concluded
 * ingestion bridge calls `resolve` to translate API-Football fixture ids into
 * BTL canonical `game_id`s; future paths (player crosswalks, team lookups)
 * use the broader surface.
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
  init?: { method: string; headers: Record<string, string>; body: Uint8Array }
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
 * request body. The identity-server is the only consumer here so we keep
 * the transport private to this module rather than pulling in
 * `@connectrpc/connect-node` (not in dependencies).
 */
const IDENTITY_SERVICE_PATH = '/btl.identity.v1.IdentityService';

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
 * Build a `FootballIdentityLookupClient` backed by native fetch + Connect
 * protocol unary calls. The bridge currently only exercises `resolve`; the
 * other methods are provided so the boundary stays complete and future
 * call sites (player metadata sync, etc.) do not need to re-wire transport.
 */
export const createFetchFootballIdentityLookupClient = (
  options: FetchIdentityClientOptions
): FootballIdentityLookupClient => {
  const fetchFn = options.fetchFn ?? defaultIdentityFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
  const baseUrl = stripTrailingSlash(options.baseUrl);

  const callUnary = async <TReq, TRes>(
    method: string,
    request: TReq,
    requestSchema: Parameters<typeof toBinary>[0],
    responseSchema: Parameters<typeof fromBinary>[0]
  ): Promise<TRes> => {
    const url = `${baseUrl}${IDENTITY_SERVICE_PATH}/${method}`;
    const body = toBinary(requestSchema, request as never);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<IdentityFetch>>;
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
        `identity-server ${method} failed: status=${response.status} body=${truncate(text, 200)}`
      );
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return fromBinary(responseSchema, bytes) as TRes;
  };

  return {
    lookup(request: LookupRequest): Promise<LookupResponse> {
      return callUnary<LookupRequest, LookupResponse>(
        'Lookup',
        request,
        LookupRequestSchema,
        LookupResponseSchema
      );
    },
    resolve(request: ResolveRequest): Promise<ResolveResponse> {
      return callUnary<ResolveRequest, ResolveResponse>(
        'Resolve',
        request,
        ResolveRequestSchema,
        ResolveResponseSchema
      );
    },
    search(request: SearchRequest): Promise<SearchResponse> {
      return callUnary<SearchRequest, SearchResponse>(
        'Search',
        request,
        SearchRequestSchema,
        SearchResponseSchema
      );
    },
    stats(request: StatsRequest): Promise<StatsResponse> {
      return callUnary<StatsRequest, StatsResponse>(
        'Stats',
        request,
        StatsRequestSchema,
        StatsResponseSchema
      );
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
