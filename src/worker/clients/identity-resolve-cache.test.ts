import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  ResolveRequestSchema,
  ResolveResponseSchema,
  type ResolveRequest,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import type { FootballIdentityLookupClient } from './identity.js';
import { withIdentityResolveCache } from './identity-resolve-cache.js';

const request = (providerId: string, entityType = EntityType.TEAM): ResolveRequest =>
  create(ResolveRequestSchema, { entityType, provider: 'api-football', providerId });

const found = (entityId: string) => create(ResolveResponseSchema, { found: true, entityId });
const missing = () => create(ResolveResponseSchema, { found: false });

const fakeClient = (resolve: FootballIdentityLookupClient['resolve']) => {
  const client = {
    resolve: vi.fn(resolve),
    lookup: vi.fn(),
    search: vi.fn(),
    stats: vi.fn(),
  };
  return client as typeof client & FootballIdentityLookupClient;
};

describe('withIdentityResolveCache', () => {
  it('answers repeat resolves from the cache', async () => {
    const inner = fakeClient(async (req) => found(`btl_${req.providerId}`));
    const cached = withIdentityResolveCache(inner);
    expect((await cached.resolve(request('33'))).entityId).toBe('btl_33');
    expect((await cached.resolve(request('33'))).entityId).toBe('btl_33');
    expect(inner.resolve).toHaveBeenCalledTimes(1);
    expect(cached.resolveCacheStats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  it('keys by entity type, provider and provider id', async () => {
    const inner = fakeClient(async (req) => found(`${req.entityType}:${req.providerId}`));
    const cached = withIdentityResolveCache(inner);
    await cached.resolve(request('39', EntityType.TEAM));
    await cached.resolve(request('39', EntityType.COMPETITION));
    await cached.resolve(request('40', EntityType.TEAM));
    expect(inner.resolve).toHaveBeenCalledTimes(3);
  });

  it('keeps a found answer for hours and a miss for minutes', async () => {
    let now = 0;
    const answers = new Map([['33', found('btl_33')]]);
    const inner = fakeClient(async (req) => answers.get(req.providerId) ?? missing());
    const cached = withIdentityResolveCache(inner, {
      foundTtlMs: 60 * 60_000,
      missTtlMs: 10 * 60_000,
      clock: () => now,
    });
    await cached.resolve(request('33'));
    await cached.resolve(request('999'));
    now = 11 * 60_000;
    // An identity release adds the crosswalk row for 999.
    answers.set('999', found('btl_999'));
    expect((await cached.resolve(request('999'))).entityId).toBe('btl_999');
    expect((await cached.resolve(request('33'))).entityId).toBe('btl_33');
    expect(inner.resolve).toHaveBeenCalledTimes(3);
    now = 61 * 60_000;
    await cached.resolve(request('33'));
    expect(inner.resolve).toHaveBeenCalledTimes(4);
  });

  it('never caches errors', async () => {
    let fail = true;
    const inner = fakeClient(async () => {
      if (fail) {
        throw new Error('identity down');
      }
      return found('btl_33');
    });
    const cached = withIdentityResolveCache(inner);
    await expect(cached.resolve(request('33'))).rejects.toThrow('identity down');
    fail = false;
    expect((await cached.resolve(request('33'))).entityId).toBe('btl_33');
    expect(inner.resolve).toHaveBeenCalledTimes(2);
  });

  it('shares one call between concurrent resolves of the same key', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = fakeClient(async () => {
      await gate;
      return found('btl_33');
    });
    const cached = withIdentityResolveCache(inner);
    const both = Promise.all([cached.resolve(request('33')), cached.resolve(request('33'))]);
    release?.();
    const [a, b] = await both;
    expect(a.entityId).toBe('btl_33');
    expect(b.entityId).toBe('btl_33');
    expect(inner.resolve).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used entry past the size limit', async () => {
    const inner = fakeClient(async (req) => found(`btl_${req.providerId}`));
    const cached = withIdentityResolveCache(inner, { maxEntries: 2 });
    await cached.resolve(request('1'));
    await cached.resolve(request('2'));
    await cached.resolve(request('1')); // 1 is now most recent
    await cached.resolve(request('3')); // evicts 2
    expect(cached.resolveCacheStats().size).toBe(2);
    await cached.resolve(request('1'));
    expect(inner.resolve).toHaveBeenCalledTimes(3);
    await cached.resolve(request('2'));
    expect(inner.resolve).toHaveBeenCalledTimes(4);
  });

  it('passes lookup, search and stats straight through', async () => {
    const inner = fakeClient(async () => found('x'));
    const cached = withIdentityResolveCache(inner);
    await cached.lookup({} as never);
    await cached.search({} as never);
    await cached.stats({} as never);
    expect(inner.lookup).toHaveBeenCalledTimes(1);
    expect(inner.search).toHaveBeenCalledTimes(1);
    expect(inner.stats).toHaveBeenCalledTimes(1);
  });
});
