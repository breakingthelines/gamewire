import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_MINUTE_CAPS,
  InMemoryMinuteCounterStore,
  ProviderMinuteLimiter,
  RedisMinuteCounterStore,
  backgroundSecondCap,
  createRedisMinuteCounterClient,
  validateMinuteCaps,
  type MinuteCounterStore,
  type ProviderPriority,
  type RedisMinuteCounterClient,
} from './minute-limiter.js';

const MINUTE = 60_000;
// An exact minute boundary, so offsets below are seconds into the minute.
const T0 = 29_000_000 * MINUTE;

const makeClock = (start: number) => {
  let now = start;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
  };
};

const fill = async (
  limiter: ProviderMinuteLimiter,
  priority: ProviderPriority,
  count: number
): Promise<number> => {
  let allowed = 0;
  for (let i = 0; i < count; i += 1) {
    if ((await limiter.tryAcquire(priority)).allowed) {
      allowed += 1;
    }
  }
  return allowed;
};

describe('ProviderMinuteLimiter ceilings', () => {
  it('defaults to 800 live, 650 near-live, 450 background', () => {
    expect(DEFAULT_PROVIDER_MINUTE_CAPS).toEqual({
      live: 800,
      'near-live': 650,
      background: 450,
    });
  });

  it('admits each class up to its own ceiling on the shared bucket', async () => {
    const clock = makeClock(T0);
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      caps: { live: 10, 'near-live': 6, background: 3 },
      clock: clock.now,
    });
    expect(await fill(limiter, 'background', 5)).toBe(3);
    // The bucket holds 3; near-live may take it to 6.
    expect(await fill(limiter, 'near-live', 5)).toBe(3);
    // Live may take it to 10.
    expect(await fill(limiter, 'live', 10)).toBe(4);
    const denied = await limiter.tryAcquire('live');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('minute_cap');
    expect(denied.ceiling).toBe(10);
  });

  it('does not count denied attempts', async () => {
    const clock = makeClock(T0);
    const store = new InMemoryMinuteCounterStore({ clock: clock.now });
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      caps: { live: 2, 'near-live': 2, background: 2 },
      store,
      clock: clock.now,
    });
    await fill(limiter, 'live', 10);
    expect(await store.read(limiter.keyFor(Math.floor(T0 / MINUTE)))).toBe(2);
  });

  it('keys the bucket by namespace, provider and epoch minute', () => {
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', namespace: 'gw' });
    expect(limiter.keyFor(123)).toBe('gw:provider:api-football:minute:123');
  });

  it('rejects ceilings that are out of order or not positive', () => {
    expect(() => validateMinuteCaps({ live: 10, 'near-live': 20, background: 5 })).toThrow(
      /ordered/
    );
    expect(() => validateMinuteCaps({ live: 10, 'near-live': 5, background: 6 })).toThrow(
      /ordered/
    );
    expect(() => validateMinuteCaps({ live: 0, 'near-live': 0, background: 0 })).toThrow(
      /positive/
    );
    expect(
      () =>
        new ProviderMinuteLimiter({
          providerId: 'api-football',
          caps: { background: 900 },
        })
    ).toThrow(/ordered/);
  });
});

describe('ProviderMinuteLimiter window', () => {
  it('reports the time to the next minute boundary', async () => {
    const clock = makeClock(T0 + 45_000);
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', clock: clock.now });
    const result = await limiter.tryAcquire('background');
    expect(result.msUntilNextMinute).toBe(15_000);
  });

  it('weights the previous minute so two ceilings cannot land inside 60 seconds', async () => {
    const clock = makeClock(T0 + 59_000);
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      caps: { live: 10, 'near-live': 10, background: 10 },
      clock: clock.now,
    });
    // A full ceiling at :59.
    expect(await fill(limiter, 'live', 10)).toBe(10);
    // One second later the new bucket is empty, but the previous minute still
    // counts at (1 - 0) weight, so almost nothing more is admitted.
    clock.set(T0 + MINUTE);
    expect(await fill(limiter, 'live', 10)).toBe(0);
    // Halfway through the minute the previous bucket counts for half.
    clock.set(T0 + MINUTE + 30_000);
    expect(await fill(limiter, 'live', 10)).toBe(5);
    // Two minutes on, the old bucket no longer counts.
    clock.set(T0 + 3 * MINUTE);
    expect(await fill(limiter, 'live', 20)).toBe(10);
  });

  it('says when a denied call would fit', async () => {
    const clock = makeClock(T0 + 59_000);
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      caps: { live: 10, 'near-live': 10, background: 10 },
      clock: clock.now,
    });
    await fill(limiter, 'live', 10);
    // Full bucket with no previous minute: room again when this bucket decays
    // in the next minute, at f >= 1 - 9/10, so 1s + 6s.
    const atFull = await limiter.tryAcquire('live');
    expect(atFull.allowed).toBe(false);
    expect(atFull.retryAfterMs).toBe(1_000 + 6_000);
    // Just after the boundary the previous minute decays within this minute:
    // 10 * (1 - f) + 0 + 1 <= 10 at f >= 0.1, so 6s.
    clock.set(T0 + MINUTE);
    const afterBoundary = await limiter.tryAcquire('live');
    expect(afterBoundary.allowed).toBe(false);
    expect(afterBoundary.retryAfterMs).toBe(6_000);
    clock.set(T0 + MINUTE + 6_000);
    expect((await limiter.tryAcquire('live')).allowed).toBe(true);
  });

  it('release returns a token to the bucket it came from', async () => {
    const clock = makeClock(T0);
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      caps: { live: 1, 'near-live': 1, background: 1 },
      clock: clock.now,
    });
    const first = await limiter.tryAcquire('live');
    expect(first.allowed).toBe(true);
    expect((await limiter.tryAcquire('live')).allowed).toBe(false);
    await limiter.release(first);
    expect((await limiter.tryAcquire('live')).allowed).toBe(true);
  });

  it('release ignores denied or fail-open results', async () => {
    const store = new InMemoryMinuteCounterStore();
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', store });
    await limiter.release({
      allowed: false,
      priority: 'live',
      epochMinute: 1,
      estimate: 0,
      ceiling: 1,
      msUntilNextMinute: 0,
    });
    expect(await store.read(limiter.keyFor(1))).toBe(0);
  });
});

describe('ProviderMinuteLimiter provider minute header', () => {
  it('refuses background when the provider reports 50 or fewer left this minute', async () => {
    const clock = makeClock(T0 + 10_000);
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', clock: clock.now });
    limiter.observeProviderMinute({ remaining: 50, limit: 900 });
    const background = await limiter.tryAcquire('background');
    expect(background.allowed).toBe(false);
    expect(background.reason).toBe('provider_minute_header');
    expect((await limiter.tryAcquire('near-live')).allowed).toBe(true);
    expect((await limiter.tryAcquire('live')).allowed).toBe(true);
  });

  it('admits background when the provider reports more than 50 left', async () => {
    const clock = makeClock(T0);
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', clock: clock.now });
    limiter.observeProviderMinute({ remaining: 51 });
    expect((await limiter.tryAcquire('background')).allowed).toBe(true);
  });

  it('forgets the header reading when the minute rolls over', async () => {
    const clock = makeClock(T0 + 50_000);
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', clock: clock.now });
    limiter.observeProviderMinute({ remaining: 0 });
    expect((await limiter.tryAcquire('background')).allowed).toBe(false);
    clock.set(T0 + MINUTE + 1_000);
    expect((await limiter.tryAcquire('background')).allowed).toBe(true);
  });

  it('ignores a response without the minute header', async () => {
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football' });
    limiter.observeProviderMinute({});
    expect((await limiter.tryAcquire('background')).allowed).toBe(true);
  });
});

describe('ProviderMinuteLimiter store failure', () => {
  const brokenStore: MinuteCounterStore = {
    backend: 'redis',
    increment: async () => {
      throw new Error('redis down');
    },
    read: async () => {
      throw new Error('redis down');
    },
  };

  it('fails open for live and near-live, closed for background', async () => {
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', store: brokenStore });
    const live = await limiter.tryAcquire('live');
    expect(live.allowed).toBe(true);
    expect(live.failOpen).toBe(true);
    expect((await limiter.tryAcquire('near-live')).allowed).toBe(true);
    const background = await limiter.tryAcquire('background');
    expect(background.allowed).toBe(false);
    expect(background.reason).toBe('store_unavailable');
  });

  it('release after a fail-open acquire does not touch the store', async () => {
    const limiter = new ProviderMinuteLimiter({ providerId: 'api-football', store: brokenStore });
    const live = await limiter.tryAcquire('live');
    await expect(limiter.release(live)).resolves.toBeUndefined();
  });
});

describe('RedisMinuteCounterStore', () => {
  it('uses INCRBY and EXPIRE 120 on the minute key', async () => {
    const calls: string[] = [];
    const values = new Map<string, number>();
    const client: RedisMinuteCounterClient = {
      get: async (key) => {
        calls.push(`GET ${key}`);
        const value = values.get(key);
        return value === undefined ? null : String(value);
      },
      incrBy: async (key, by) => {
        calls.push(`INCRBY ${key} ${by}`);
        const next = (values.get(key) ?? 0) + by;
        values.set(key, next);
        return next;
      },
      expire: async (key, ttl) => {
        calls.push(`EXPIRE ${key} ${ttl}`);
        return 1;
      },
    };
    const clock = makeClock(T0);
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store: new RedisMinuteCounterStore(client),
      clock: clock.now,
    });
    const minute = Math.floor(T0 / MINUTE);
    expect((await limiter.tryAcquire('live')).allowed).toBe(true);
    expect(calls).toEqual([
      `GET gamewire:provider:api-football:minute:${minute - 1}`,
      `INCRBY gamewire:provider:api-football:minute:${minute} 1`,
      `EXPIRE gamewire:provider:api-football:minute:${minute} 120`,
    ]);
    expect(limiter.backend).toBe('redis');
  });
});

describe('ProviderMinuteLimiter one-second smoothing', () => {
  const smoothed = (clock: ReturnType<typeof makeClock>, background = 450) =>
    new ProviderMinuteLimiter({
      providerId: 'api-football',
      caps: { live: 800, 'near-live': 650, background },
      clock: clock.now,
      smoothBackground: true,
    });

  it('derives the background second cap from the minute cap', () => {
    expect(backgroundSecondCap(DEFAULT_PROVIDER_MINUTE_CAPS)).toBe(8);
    expect(backgroundSecondCap({ live: 120, 'near-live': 120, background: 120 })).toBe(2);
    expect(backgroundSecondCap({ live: 30, 'near-live': 30, background: 30 })).toBe(1);
    const clock = makeClock(T0);
    expect(smoothed(clock).backgroundSecondCap).toBe(8);
    expect(
      new ProviderMinuteLimiter({ providerId: 'api-football', clock: clock.now })
        .backgroundSecondCap
    ).toBeUndefined();
  });

  it('holds background to the second cap and admits it again next second', async () => {
    const clock = makeClock(T0 + 10_250);
    const limiter = smoothed(clock);
    expect(await fill(limiter, 'background', 20)).toBe(8);
    const held = await limiter.tryAcquire('background');
    expect(held).toMatchObject({ allowed: false, reason: 'second_cap', retryAfterMs: 750 });
    clock.set(T0 + 11_000);
    expect(await fill(limiter, 'background', 20)).toBe(8);
  });

  it('a held call is refunded from the minute bucket', async () => {
    const clock = makeClock(T0 + 10_000);
    const store = new InMemoryMinuteCounterStore({ clock: clock.now });
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store,
      clock: clock.now,
      smoothBackground: true,
    });
    await fill(limiter, 'background', 30);
    expect(await store.read(limiter.keyFor(Math.floor(clock.now() / MINUTE)))).toBe(8);
  });

  it('never holds live or near-live, and background yields to them', async () => {
    const clock = makeClock(T0 + 5_000);
    const limiter = smoothed(clock);
    expect(await fill(limiter, 'live', 12)).toBe(12);
    expect(await fill(limiter, 'near-live', 5)).toBe(5);
    expect(await limiter.tryAcquire('background')).toMatchObject({
      allowed: false,
      reason: 'second_cap',
    });
  });

  it('release returns the second token too', async () => {
    const clock = makeClock(T0 + 1_000);
    const store = new InMemoryMinuteCounterStore({ clock: clock.now });
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store,
      clock: clock.now,
      smoothBackground: true,
    });
    const token = await limiter.tryAcquire('background');
    expect(token.epochSecond).toBe(Math.floor(clock.now() / 1_000));
    await limiter.release(token);
    expect(await store.read(limiter.secondKeyFor(token.epochSecond!))).toBe(0);
  });
});

describe('createRedisMinuteCounterClient', () => {
  it('maps the counter calls onto raw Redis commands', async () => {
    const sent: string[] = [];
    const client = createRedisMinuteCounterClient({
      send: async (command, args) => {
        sent.push(`${command} ${args.join(' ')}`);
        if (command === 'GET') {
          return args[0] === 'present' ? '7' : null;
        }
        return 3;
      },
    });
    expect(await client.get('present')).toBe('7');
    expect(await client.get('absent')).toBeNull();
    expect(await client.incrBy('k', -1)).toBe(3);
    expect(await client.expire('k', 5)).toBe(3);
    expect(sent).toEqual(['GET present', 'GET absent', 'INCRBY k -1', 'EXPIRE k 5']);
  });
});
