import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_MINUTE_CAPS,
  InMemoryMinuteCounterStore,
  MINUTE_ACQUIRE_SCRIPT,
  ProviderMinuteLimiter,
  RedisMinuteCounterStore,
  acquireWithCounters,
  backgroundSecondCap,
  createRedisMinuteCounterClient,
  parseMinuteAcquireReply,
  validateMinuteCaps,
  type MinuteAcquireRequest,
  type MinuteCounterStore,
  type ProviderPriority,
  type RedisCommandSender,
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

/**
 * A raw Redis sender whose EVAL decodes {@link MINUTE_ACQUIRE_SCRIPT}'s KEYS
 * and ARGV back into a request and answers it from plain counters, the way
 * the script does on a server (checked against a real Redis by hand: old and
 * new limiter, 12,000 random acquires, identical results and counters). It
 * proves the encoding round-trips and that a token costs one command.
 */
const evalSender = () => {
  const values = new Map<string, number>();
  const ttls = new Map<string, number>();
  const sent: string[] = [];
  const counters = {
    read: async (key: string) => Math.max(0, values.get(key) ?? 0),
    increment: async (key: string, by: number, ttl: number) => {
      const next = (values.get(key) ?? 0) + by;
      values.set(key, next);
      if (by > 0) {
        ttls.set(key, ttl);
      }
      return Math.max(0, next);
    },
  };
  const sender: RedisCommandSender = {
    send: async (command, args) => {
      sent.push(command);
      // release() still refunds with plain commands.
      if (command === 'INCRBY') {
        return counters.increment(args[0]!, Number(args[1]), 0);
      }
      if (command === 'EXPIRE') {
        ttls.set(args[0]!, Number(args[1]));
        return 1;
      }
      if (command !== 'EVAL') {
        throw new Error(`unexpected ${command}`);
      }
      const [script, numKeys, ...rest] = args;
      expect(script).toBe(MINUTE_ACQUIRE_SCRIPT);
      const keys = rest.slice(0, Number(numKeys));
      const [elapsed, ceiling, minuteTtl, secondCap, secondTtl, enforce] = rest.slice(
        Number(numKeys)
      );
      const request: MinuteAcquireRequest = {
        previousMinuteKey: keys[0]!,
        minuteKey: keys[1]!,
        minuteTtlSeconds: Number(minuteTtl),
        elapsed: Number(elapsed),
        ceiling: Number(ceiling),
        ...(Number(secondCap) > 0
          ? {
              second: {
                key: keys[2]!,
                ttlSeconds: Number(secondTtl),
                cap: Number(secondCap),
                enforce: enforce === '1',
              },
            }
          : {}),
      };
      const counts = await acquireWithCounters(counters, request);
      const code = ['allowed', 'minute_cap', 'second_cap'].indexOf(counts.outcome);
      // Bun may hand integers back as numbers or strings; mix both.
      return [code, String(counts.previous), counts.current, counts.inSecond ?? -1];
    },
  };
  return { sender, sent, values, ttls };
};

const evalLimiter = (
  clock: () => number,
  options: { caps?: Partial<Record<ProviderPriority, number>>; smooth?: boolean } = {}
) => {
  const redis = evalSender();
  const limiter = new ProviderMinuteLimiter({
    providerId: 'api-football',
    store: new RedisMinuteCounterStore(createRedisMinuteCounterClient(redis.sender)),
    clock,
    caps: options.caps,
    smoothBackground: options.smooth,
  });
  return { ...redis, limiter };
};

describe('RedisMinuteCounterStore with EVAL', () => {
  it('takes a token in one EVAL with both buckets and their TTLs', async () => {
    const clock = makeClock(T0 + 30_000);
    const sent: string[][] = [];
    const sender: RedisCommandSender = {
      send: async (command, args) => {
        sent.push([command, ...args]);
        return [0, 4, 9, 2];
      },
    };
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store: new RedisMinuteCounterStore(createRedisMinuteCounterClient(sender)),
      clock: clock.now,
      smoothBackground: true,
    });
    const minute = Math.floor(T0 / MINUTE);
    const second = Math.floor((T0 + 30_000) / 1_000);
    const token = await limiter.tryAcquire('background');
    expect(sent).toEqual([
      [
        'EVAL',
        MINUTE_ACQUIRE_SCRIPT,
        '3',
        `gamewire:provider:api-football:minute:${minute - 1}`,
        `gamewire:provider:api-football:minute:${minute}`,
        `gamewire:provider:api-football:second:${second}`,
        '0.5',
        '450',
        '120',
        '8',
        '5',
        '1',
      ],
    ]);
    expect(token).toMatchObject({ allowed: true, estimate: 4 * 0.5 + 9, epochSecond: second });
  });

  it('sends two keys and no second cap without smoothing, and does not enforce it for live', async () => {
    const clock = makeClock(T0 + 15_000);
    const sent: string[][] = [];
    const sender: RedisCommandSender = {
      send: async (command, args) => {
        sent.push([command, ...args]);
        return [0, 0, 1, -1];
      },
    };
    const plain = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store: new RedisMinuteCounterStore(createRedisMinuteCounterClient(sender)),
      clock: clock.now,
    });
    const token = await plain.tryAcquire('live');
    expect(sent[0]?.slice(2, 5)).toEqual([
      '2',
      plain.keyFor(Math.floor(T0 / MINUTE) - 1),
      plain.keyFor(Math.floor(T0 / MINUTE)),
    ]);
    expect(sent[0]?.slice(5)).toEqual(['0.25', '800', '120', '0', '0', '0']);
    expect(token.epochSecond).toBeUndefined();

    const smoothed = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store: new RedisMinuteCounterStore(createRedisMinuteCounterClient(sender)),
      clock: clock.now,
      smoothBackground: true,
    });
    sent.length = 0;
    await smoothed.tryAcquire('live');
    expect(sent[0]?.at(-1)).toBe('0');
  });

  it('admits each class up to its ceiling and refunds the refused call, one command each', async () => {
    const clock = makeClock(T0 + 5_000);
    const { limiter, sent, values } = evalLimiter(clock.now, {
      caps: { live: 6, 'near-live': 4, background: 2 },
    });
    expect(await fill(limiter, 'background', 5)).toBe(2);
    expect(await fill(limiter, 'near-live', 5)).toBe(2);
    expect(await fill(limiter, 'live', 5)).toBe(2);
    expect(sent).toEqual(Array(15).fill('EVAL'));
    expect(values.get(limiter.keyFor(Math.floor(T0 / MINUTE)))).toBe(6);
  });

  it('sets the 120 s minute TTL and the 5 s second TTL', async () => {
    const clock = makeClock(T0 + 1_000);
    const { limiter, ttls } = evalLimiter(clock.now, { smooth: true });
    await limiter.tryAcquire('background');
    expect(ttls.get(limiter.keyFor(Math.floor(T0 / MINUTE)))).toBe(120);
    expect(ttls.get(limiter.secondKeyFor(Math.floor((T0 + 1_000) / 1_000)))).toBe(5);
  });

  it('a store failure or a malformed reply fails open for live and closed for background', async () => {
    const replies: unknown[] = [
      'OK',
      [9, 0, 1, -1],
      [0, 'x', 1, -1],
      null,
      Promise.reject(new Error('down')),
    ];
    for (const reply of replies) {
      const sender: RedisCommandSender = { send: async () => reply };
      const limiter = new ProviderMinuteLimiter({
        providerId: 'api-football',
        store: new RedisMinuteCounterStore(createRedisMinuteCounterClient(sender)),
      });
      expect(await limiter.tryAcquire('live')).toMatchObject({ allowed: true, failOpen: true });
      expect(await limiter.tryAcquire('background')).toMatchObject({
        allowed: false,
        reason: 'store_unavailable',
      });
    }
    // Swallow the rejection the loop created once per limiter.
    await Promise.allSettled(replies.filter((r): r is Promise<unknown> => r instanceof Promise));
  });

  it('decodes the reply, with the second count only when it was taken', () => {
    expect(parseMinuteAcquireReply([0, 3, 7, -1])).toEqual({
      outcome: 'allowed',
      previous: 3,
      current: 7,
    });
    expect(parseMinuteAcquireReply(['2', '0', '5', '9'])).toEqual({
      outcome: 'second_cap',
      previous: 0,
      current: 5,
      inSecond: 9,
    });
    expect(() => parseMinuteAcquireReply([1, 2, 3])).toThrow(/unexpected EVAL reply/);
  });
});

describe('ProviderMinuteLimiter cap edges and rollover (EVAL store)', () => {
  it('admits a call that brings the sliding estimate exactly to the ceiling, and refuses the next', async () => {
    const clock = makeClock(T0 + 30_000);
    const { limiter, values } = evalLimiter(clock.now, {
      caps: { live: 120, 'near-live': 120, background: 120 },
    });
    const minute = Math.floor(T0 / MINUTE);
    // 100 calls last minute weigh 50 halfway through this one.
    values.set(limiter.keyFor(minute - 1), 100);
    expect(await fill(limiter, 'background', 70)).toBe(70);
    const refused = await limiter.tryAcquire('background');
    expect(refused).toMatchObject({ allowed: false, reason: 'minute_cap', estimate: 120 });
    expect(values.get(limiter.keyFor(minute))).toBe(70);
  });

  it('rolls into a new minute bucket at the boundary, and the old one becomes the decaying one', async () => {
    const clock = makeClock(T0 + MINUTE - 1);
    const { limiter, values } = evalLimiter(clock.now, {
      caps: { live: 10, 'near-live': 10, background: 10 },
    });
    const minute = Math.floor(T0 / MINUTE);
    expect(await fill(limiter, 'background', 12)).toBe(10);
    clock.set(T0 + MINUTE);
    // Elapsed 0: the previous minute still weighs its full 10.
    expect(await limiter.tryAcquire('background')).toMatchObject({
      allowed: false,
      reason: 'minute_cap',
      epochMinute: minute + 1,
    });
    clock.set(T0 + MINUTE + 30_000);
    // Halfway: 10 * 0.5 = 5 left, so 5 more fit.
    expect(await fill(limiter, 'background', 8)).toBe(5);
    expect(values.get(limiter.keyFor(minute))).toBe(10);
    expect(values.get(limiter.keyFor(minute + 1))).toBe(5);
  });

  it('rolls the second bucket over at the second boundary', async () => {
    const clock = makeClock(T0 + 10_999);
    const { limiter } = evalLimiter(clock.now, { smooth: true });
    expect(await fill(limiter, 'background', 10)).toBe(8);
    expect(await limiter.tryAcquire('background')).toMatchObject({
      reason: 'second_cap',
      retryAfterMs: 1,
    });
    clock.set(T0 + 11_000);
    expect(await fill(limiter, 'background', 10)).toBe(8);
  });

  it('keys a token by one clock reading, even when the clock moves during the call', async () => {
    let now = T0 + MINUTE - 1;
    const reads: number[] = [];
    const clock = () => {
      reads.push(now);
      return now;
    };
    const requests: MinuteAcquireRequest[] = [];
    const store: MinuteCounterStore = {
      backend: 'redis',
      read: async () => 0,
      increment: async () => 1,
      acquire: async (request) => {
        requests.push(request);
        // The minute and the second both turn over while the call is in flight.
        now += 5_000;
        return { outcome: 'allowed', previous: 0, current: 1, inSecond: 1 };
      },
    };
    const limiter = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store,
      clock,
      smoothBackground: true,
    });
    const token = await limiter.tryAcquire('background');
    expect(reads).toHaveLength(1);
    const minute = Math.floor(T0 / MINUTE);
    const second = Math.floor((T0 + MINUTE - 1) / 1_000);
    expect(requests[0]).toMatchObject({
      previousMinuteKey: limiter.keyFor(minute - 1),
      minuteKey: limiter.keyFor(minute),
      second: { key: limiter.secondKeyFor(second) },
    });
    expect(token).toMatchObject({ epochMinute: minute, epochSecond: second });
  });

  it('matches the in-memory store call for call', async () => {
    const clock = makeClock(T0 + 12_345);
    const { limiter: viaEval } = evalLimiter(clock.now, {
      caps: { live: 9, 'near-live': 6, background: 4 },
      smooth: true,
    });
    const inMemory = new ProviderMinuteLimiter({
      providerId: 'api-football',
      store: new InMemoryMinuteCounterStore({ clock: clock.now }),
      clock: clock.now,
      caps: { live: 9, 'near-live': 6, background: 4 },
      smoothBackground: true,
    });
    const order: ProviderPriority[] = ['background', 'live', 'near-live'];
    for (let i = 0; i < 300; i += 1) {
      clock.set(clock.now() + ((i * 7919) % 2_300));
      const priority = order[i % 3]!;
      const a = await viaEval.tryAcquire(priority);
      const b = await inMemory.tryAcquire(priority);
      expect(a).toEqual(b);
      if (a.allowed && i % 11 === 0) {
        await viaEval.release(a);
        await inMemory.release(b);
      }
    }
  });
});
