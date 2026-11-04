import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_BACKGROUND_DAILY_CAP,
  DEFAULT_PROVIDER_HARD_CAP,
  DEFAULT_PROVIDER_SOFT_CAP,
  defaultBackgroundDailyCap,
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

describe('ProviderQuotaTracker background daily cap', () => {
  it('defaults to min(110k, soft cap, hard cap)', () => {
    expect(DEFAULT_PROVIDER_BACKGROUND_DAILY_CAP).toBe(110_000);
    expect(defaultBackgroundDailyCap(60_000, 70_000)).toBe(60_000);
    expect(defaultBackgroundDailyCap(130_000, 140_000)).toBe(110_000);
    expect(defaultBackgroundDailyCap(60_000, 5)).toBe(5);
    const tracker = new ProviderQuotaTracker({ provider: 'api-football' });
    // Mega defaults: 130k soft cap, so the background cap is 110k.
    expect(tracker.backgroundDailyCap).toBe(DEFAULT_PROVIDER_BACKGROUND_DAILY_CAP);
  });

  it('denies only background once the background cap is reached', async () => {
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 8,
      backgroundDailyCap: 3,
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await tracker.reserve(1, undefined, 'background')).allowed).toBe(true);
    }
    const denied = await tracker.reserve(1, undefined, 'background');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('background_cap');
    expect(denied.snapshot.calls).toBe(3); // refunded
    expect(denied.snapshot.backgroundCapReached).toBe(true);
    // Live and near-live keep going until the soft and hard caps.
    expect((await tracker.reserve(1, undefined, 'live')).allowed).toBe(true);
    expect((await tracker.reserve(1, undefined, 'near-live')).allowed).toBe(true);
    const snapshot = await tracker.snapshot();
    expect(snapshot.calls).toBe(5);
    expect(snapshot.posture).toBe('normal');
    expect(snapshot.cachedOnlyMode).toBe(false);
  });

  it('counts live calls toward the background cap', async () => {
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 8,
      backgroundDailyCap: 2,
    });
    await tracker.reserve(1, undefined, 'live');
    await tracker.reserve(1, undefined, 'live');
    expect((await tracker.reserve(1, undefined, 'background')).reason).toBe('background_cap');
  });

  it('the soft cap still reports cached-only for every class', async () => {
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 2,
      backgroundDailyCap: 2,
    });
    await tracker.reserve(1, undefined, 'live');
    const atSoft = await tracker.reserve(1, undefined, 'live');
    expect(atSoft.allowed).toBe(true);
    expect(atSoft.reason).toBe('soft_cap');
    expect(atSoft.snapshot.cachedOnlyMode).toBe(true);
  });

  it('rejects a background cap above the hard cap or not positive', () => {
    expect(
      () =>
        new ProviderQuotaTracker({
          provider: 'api-football',
          hardCap: 10,
          softCap: 5,
          backgroundDailyCap: 11,
        })
    ).toThrow(/background daily cap/);
    expect(
      () =>
        new ProviderQuotaTracker({
          provider: 'api-football',
          backgroundDailyCap: 0,
        })
    ).toThrow(/background daily cap/);
  });
});

describe('ProviderQuotaTracker provider-header source', () => {
  const at = (iso: string) => new Date(iso);

  it('gates on max(local, provider-reported) using the reported limit', async () => {
    const now = at('2026-11-04T12:00:00.000Z');
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 140_000,
      softCap: 130_000,
      backgroundDailyCap: 110_000,
      quotaSource: 'provider-header',
      clock: () => now,
    });
    await tracker.reserve(1, now, 'live');
    // Another spender on the key has used most of the day.
    tracker.observeProviderDaily({ limit: 150_000, remaining: 15_000 }, now);
    const snapshot = await tracker.snapshot(now);
    expect(snapshot.localCalls).toBe(1);
    expect(snapshot.remoteCalls).toBe(135_000);
    expect(snapshot.remoteLimit).toBe(150_000);
    expect(snapshot.calls).toBe(135_000);
    expect(snapshot.posture).toBe('soft_cap_reached');
    expect((await tracker.reserve(1, now, 'background')).reason).toBe('background_cap');
  });

  it('derives usage from the limit header, not an assumed plan size', async () => {
    const now = at('2026-11-04T12:00:00.000Z');
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 8,
      quotaSource: 'provider-header',
      clock: () => now,
    });
    tracker.observeProviderDaily({ limit: 100, remaining: 91 }, now);
    expect((await tracker.snapshot(now)).calls).toBe(9);
    expect((await tracker.reserve(1, now, 'live')).allowed).toBe(true);
    tracker.observeProviderDaily({ limit: 100, remaining: 89 }, now);
    const denied = await tracker.reserve(1, now, 'live');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('hard_cap');
  });

  it('ignores readings without both daily headers', async () => {
    const now = at('2026-11-04T12:00:00.000Z');
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      quotaSource: 'provider-header',
      clock: () => now,
    });
    tracker.observeProviderDaily({ remaining: 10 }, now);
    tracker.observeProviderDaily({ limit: 150_000 }, now);
    tracker.observeProviderDaily({ limit: 0, remaining: 0 }, now);
    const snapshot = await tracker.snapshot(now);
    expect(snapshot.remoteCalls).toBeUndefined();
    expect(snapshot.calls).toBe(0);
  });

  it('keeps the highest reading in a window and logs a provider-side reset', async () => {
    const now = at('2026-11-04T12:00:00.000Z');
    const logs: Record<string, unknown>[] = [];
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      quotaSource: 'provider-header',
      clock: () => now,
      logger: (entry) => logs.push(entry),
    });
    tracker.observeProviderDaily({ limit: 150_000, remaining: 100_000 }, now);
    // A slightly lower, out-of-order reading is ignored.
    tracker.observeProviderDaily({ limit: 150_000, remaining: 100_010 }, now);
    expect((await tracker.snapshot(now)).remoteCalls).toBe(50_000);
    expect(logs).toEqual([]);
    // A drop of more than half is the provider resetting its day.
    tracker.observeProviderDaily({ limit: 150_000, remaining: 149_000 }, now);
    expect((await tracker.snapshot(now)).remoteCalls).toBe(1_000);
    expect(logs[0]?.event).toBe('provider_quota_remote_reset');
  });

  it('drops the provider reading at the UTC window change', async () => {
    const before = at('2026-11-04T23:59:00.000Z');
    const after = at('2026-11-05T00:01:00.000Z');
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      quotaSource: 'provider-header',
    });
    tracker.observeProviderDaily({ limit: 150_000, remaining: 10_000 }, before);
    expect((await tracker.snapshot(before)).calls).toBe(140_000);
    expect((await tracker.snapshot(after)).calls).toBe(0);
  });

  it('the local source records the reading but gates on the local count only', async () => {
    const now = at('2026-11-04T12:00:00.000Z');
    const tracker = new ProviderQuotaTracker({
      provider: 'api-football',
      hardCap: 10,
      softCap: 8,
      clock: () => now,
    });
    expect(tracker.quotaSource).toBe('local');
    tracker.observeProviderDaily({ limit: 150_000, remaining: 0 }, now);
    const snapshot = await tracker.snapshot(now);
    expect(snapshot.remoteCalls).toBe(150_000);
    expect(snapshot.calls).toBe(0);
    expect((await tracker.reserve(1, now, 'live')).allowed).toBe(true);
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
