import type {
  ResolveRequest,
  ResolveResponse,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import type { FootballIdentityLookupClient } from './identity.js';

/**
 * LRU in front of identity `Resolve` for the ingestion bridges.
 *
 * Every live tick resolves the competition and both teams of every live
 * fixture, so at 30s (or 15s) ticks the bridge asks identity the same few
 * hundred questions over and over. A provider id's canonical id changes only
 * when an identity release ships, so a found answer is kept for hours. A
 * not-found answer is kept briefly, so a crosswalk row added by a new identity
 * release is picked up within minutes. Errors are never cached.
 *
 * Only `resolve` is cached; `lookup`, `search` and `stats` pass through. The
 * identity-gap-scan workflow must keep the raw client: it exists to report
 * current misses, and a cached miss would hide a fix.
 */

export const DEFAULT_IDENTITY_RESOLVE_CACHE_MAX_ENTRIES = 5_000;
export const DEFAULT_IDENTITY_RESOLVE_FOUND_TTL_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_IDENTITY_RESOLVE_MISS_TTL_MS = 10 * 60 * 1_000;

export interface IdentityResolveCacheOptions {
  readonly maxEntries?: number;
  readonly foundTtlMs?: number;
  readonly missTtlMs?: number;
  readonly clock?: () => number;
}

export interface IdentityResolveCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

export interface CachedFootballIdentityLookupClient extends FootballIdentityLookupClient {
  resolveCacheStats(): IdentityResolveCacheStats;
}

export const withIdentityResolveCache = (
  client: FootballIdentityLookupClient,
  options: IdentityResolveCacheOptions = {}
): CachedFootballIdentityLookupClient => {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_IDENTITY_RESOLVE_CACHE_MAX_ENTRIES);
  const foundTtlMs = options.foundTtlMs ?? DEFAULT_IDENTITY_RESOLVE_FOUND_TTL_MS;
  const missTtlMs = options.missTtlMs ?? DEFAULT_IDENTITY_RESOLVE_MISS_TTL_MS;
  const clock = options.clock ?? Date.now;
  // Map iteration order is insertion order: re-inserting on a hit moves the
  // key to the back, so the first key is always the least recently used.
  const entries = new Map<string, { response: ResolveResponse; expiresAt: number }>();
  const inFlight = new Map<string, Promise<ResolveResponse>>();
  let hits = 0;
  let misses = 0;

  const keyFor = (request: ResolveRequest): string =>
    `${request.entityType}|${request.provider}|${request.providerId}`;

  const store = (key: string, response: ResolveResponse): void => {
    const found = response.found && response.entityId !== '';
    entries.delete(key);
    entries.set(key, { response, expiresAt: clock() + (found ? foundTtlMs : missTtlMs) });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      entries.delete(oldest);
    }
  };

  return {
    lookup: (request) => client.lookup(request),
    search: (request) => client.search(request),
    stats: (request) => client.stats(request),
    async resolve(request: ResolveRequest): Promise<ResolveResponse> {
      const key = keyFor(request);
      const entry = entries.get(key);
      if (entry && entry.expiresAt > clock()) {
        hits += 1;
        entries.delete(key);
        entries.set(key, entry);
        return entry.response;
      }
      if (entry) {
        entries.delete(key);
      }
      const pending = inFlight.get(key);
      if (pending) {
        hits += 1;
        return pending;
      }
      misses += 1;
      const call = client
        .resolve(request)
        .then((response) => {
          store(key, response);
          return response;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, call);
      return call;
    },
    resolveCacheStats: () => ({ hits, misses, size: entries.size }),
  };
};
