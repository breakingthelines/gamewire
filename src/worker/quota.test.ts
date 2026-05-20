import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_HARD_CAP,
  DEFAULT_PROVIDER_SOFT_CAP,
  InMemoryQuotaStore,
  ProviderQuotaTracker,
  RedisQuotaStore,
  type RedisQuotaClient,
} from './quota.js';

describe('ProviderQuotaTracker', () => {
  it('reports a normal posture when below the soft cap', async () => {
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 5,
    });
    const result = await tracker.reserve();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.snapshot.posture).toBe('normal');
    expect(result.snapshot.calls).toBe(1);
    expect(result.snapshot.cachedOnlyMode).toBe(false);
  });

  it('flips to soft_cap_reached at the boundary and reports cached-only', async () => {
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 3,
    });

    await tracker.reserve();
    await tracker.reserve();
    const breach = await tracker.reserve();
    expect(breach.allowed).toBe(true);
    expect(breach.reason).toBe('soft_cap');
    expect(breach.snapshot.posture).toBe('soft_cap_reached');
    expect(breach.snapshot.cachedOnlyMode).toBe(true);
  });

  it('denies and refunds when the hard cap would be breached', async () => {
    const store = new InMemoryQuotaStore();
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 2,
      softCap: 1,
      store,
    });

    await tracker.reserve();
    await tracker.reserve();
    const denied = await tracker.reserve();

    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('hard_cap');
    expect(denied.snapshot.posture).toBe('hard_cap_reached');
    expect(denied.snapshot.calls).toBe(2); // refunded back to the cap
  });

  it('refunds a previous reservation', async () => {
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 5,
    });
    await tracker.reserve();
    await tracker.reserve();
    const refunded = await tracker.refund();
    expect(refunded.calls).toBe(1);
  });

  it('rejects non-positive costs', async () => {
    const tracker = new ProviderQuotaTracker({ provider: 'api-football' });
    await expect(tracker.reserve(0)).rejects.toThrow(/positive/);
    await expect(tracker.refund(0)).rejects.toThrow(/positive/);
  });

  it('rejects construction when soft cap > hard cap', () => {
    expect(
      () =>
        new ProviderQuotaTracker({
          provider: 'api-football',
          hardCap: 5,
          softCap: 6,
        })
    ).toThrow(/soft cap/);
  });

  it('uses UTC ISO date as the window key', () => {
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      clock: () => new Date('2026-05-20T23:59:59.000Z'),
    });
    expect(tracker.windowFor()).toBe('2026-05-20');
  });

  it('exposes default caps when none are provided', () => {
    const tracker = new ProviderQuotaTracker({ provider: 'api-football' });
    expect(tracker.hardCap).toBe(DEFAULT_PROVIDER_HARD_CAP);
    expect(tracker.softCap).toBe(DEFAULT_PROVIDER_SOFT_CAP);
    expect(tracker.provider).toBe('api-football');
  });
});

describe('RedisQuotaStore', () => {
  const buildClient = (): RedisQuotaClient & {
    readonly counters: Map<string, number>;
    readonly expireMock: ReturnType<typeof vi.fn>;
  } => {
    const counters = new Map<string, number>();
    const expireMock = vi.fn(async () => 1);
    return {
      counters,
      expireMock,
      async get(key: string) {
        const value = counters.get(key);
        return value === undefined ? null : String(value);
      },
      async incrBy(key: string, by: number) {
        const next = (counters.get(key) ?? 0) + by;
        counters.set(key, next);
        return next;
      },
      expire: expireMock,
    };
  };

  it('increments under namespaced key and sets TTL on positive bumps', async () => {
    const client = buildClient();
    const store = new RedisQuotaStore({ client, namespace: 'gamewire' });

    const total = await store.increment('2026-05-20', 3);
    expect(total).toBe(3);
    expect(client.counters.get('gamewire:quota:2026-05-20')).toBe(3);
    expect(client.expireMock).toHaveBeenCalledTimes(1);
    expect(client.expireMock).toHaveBeenCalledWith('gamewire:quota:2026-05-20', 36 * 60 * 60);
  });

  it('skips TTL refresh on refunds (non-positive increments)', async () => {
    const client = buildClient();
    const store = new RedisQuotaStore({ client });
    await store.increment('2026-05-20', 2);
    client.expireMock.mockClear();
    await store.increment('2026-05-20', -1);
    expect(client.expireMock).not.toHaveBeenCalled();
  });

  it('reads counters as integers and treats missing as zero', async () => {
    const client = buildClient();
    const store = new RedisQuotaStore({ client });
    expect(await store.read('missing')).toBe(0);
    await store.increment('2026-05-20', 5);
    expect(await store.read('2026-05-20')).toBe(5);
  });
});
