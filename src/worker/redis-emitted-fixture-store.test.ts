import { describe, expect, it, vi } from 'vitest';

import {
  EMITTED_FIXTURE_DEFAULT_TTL_SECONDS,
  EMITTED_FIXTURE_REDIS_KEY_PREFIX,
  RedisEmittedFixtureStore,
  type BunRedisEmittedFixtureClient,
} from './redis-emitted-fixture-store.js';

/**
 * Faithful in-memory mock of the Bun.redis `send(command, args)` surface
 * used by {@link RedisEmittedFixtureStore}. Implements just enough of
 * EXISTS / SET / TTL semantics to exercise the store under realistic
 * conditions:
 *
 *   - SET NX returns null on a duplicate, "OK" on first set.
 *   - SET EX sets an absolute deadline (ms) so TTL can be read back.
 *   - EXISTS returns 1 / 0.
 *   - TTL returns the remaining seconds, -1 for no-expiry keys, -2 for
 *     missing keys.
 *
 * The mock advances time via an injectable clock so the TTL assertion
 * is deterministic.
 */
class InMemoryBunRedisMock implements BunRedisEmittedFixtureClient {
  readonly #store = new Map<string, { value: string; expiresAtMs: number | null }>();
  readonly #now: () => number;
  readonly calls: { command: string; args: string[] }[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async send(command: string, args: string[]): Promise<unknown> {
    this.calls.push({ command, args: [...args] });
    const upper = command.toUpperCase();
    if (upper === 'SET') {
      return this.#set(args);
    }
    if (upper === 'EXISTS') {
      return this.#exists(args);
    }
    if (upper === 'TTL') {
      return this.#ttl(args);
    }
    throw new Error(`InMemoryBunRedisMock: unsupported command ${command}`);
  }

  /** Test helper: expose the raw store for assertions. */
  get store(): ReadonlyMap<string, { value: string; expiresAtMs: number | null }> {
    return this.#store;
  }

  /** Test helper: delete all keys (simulates flushing a new replica). */
  reset(): void {
    this.#store.clear();
    this.calls.length = 0;
  }

  #set(args: string[]): 'OK' | null {
    const [key, value, ...rest] = args;
    let nx = false;
    let exSeconds: number | null = null;
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i].toUpperCase();
      if (token === 'NX') {
        nx = true;
      } else if (token === 'EX') {
        i += 1;
        exSeconds = Number.parseInt(rest[i], 10);
      }
    }
    this.#purgeIfExpired(key);
    if (nx && this.#store.has(key)) {
      return null;
    }
    const expiresAtMs = exSeconds === null ? null : this.#now() + exSeconds * 1000;
    this.#store.set(key, { value, expiresAtMs });
    return 'OK';
  }

  #exists(args: string[]): number {
    let count = 0;
    for (const key of args) {
      this.#purgeIfExpired(key);
      if (this.#store.has(key)) {
        count += 1;
      }
    }
    return count;
  }

  #ttl(args: string[]): number {
    const key = args[0];
    this.#purgeIfExpired(key);
    const entry = this.#store.get(key);
    if (!entry) {
      return -2;
    }
    if (entry.expiresAtMs === null) {
      return -1;
    }
    const remainingMs = entry.expiresAtMs - this.#now();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  #purgeIfExpired(key: string): void {
    const entry = this.#store.get(key);
    if (!entry || entry.expiresAtMs === null) {
      return;
    }
    if (entry.expiresAtMs <= this.#now()) {
      this.#store.delete(key);
    }
  }
}

describe('RedisEmittedFixtureStore', () => {
  it('first emit returns success and writes the key with the canonical prefix', async () => {
    const redis = new InMemoryBunRedisMock();
    const store = new RedisEmittedFixtureStore({ client: redis });

    expect(await store.hasEmitted('api-football', '1917')).toBe(false);
    await store.markEmitted('api-football', '1917');

    expect(await store.hasEmitted('api-football', '1917')).toBe(true);
    const expectedKey = `${EMITTED_FIXTURE_REDIS_KEY_PREFIX}api-football:1917`;
    expect(redis.store.has(expectedKey)).toBe(true);
    expect(redis.store.get(expectedKey)?.value).toBe('1');
  });

  it('duplicate emit returns "already emitted" without overwriting the original value', async () => {
    const redis = new InMemoryBunRedisMock();
    const store = new RedisEmittedFixtureStore({ client: redis });

    await store.markEmitted('api-football', '1917');
    const setCallsBefore = redis.calls.filter((c) => c.command.toUpperCase() === 'SET').length;

    // Second markEmitted issues the SET NX (so the publisher's
    // post-publish-call site stays a single round-trip) but Redis
    // rejects the overwrite under NX. The store treats this as a no-op
    // by contract.
    await store.markEmitted('api-football', '1917');

    const setCalls = redis.calls.filter((c) => c.command.toUpperCase() === 'SET');
    expect(setCalls.length).toBe(setCallsBefore + 1);
    // Both SET calls used NX so the original value is preserved.
    expect(setCalls.every((c) => c.args.includes('NX'))).toBe(true);

    // hasEmitted still returns true after the duplicate attempt.
    expect(await store.hasEmitted('api-football', '1917')).toBe(true);
  });

  it('TTL is set to ~30d (the documented default) on first write', async () => {
    const baseNow = 1_700_000_000_000;
    const clock = vi.fn(() => baseNow);
    const redis = new InMemoryBunRedisMock(clock);
    const store = new RedisEmittedFixtureStore({ client: redis });

    await store.markEmitted('api-football', '1917');

    const ttl = await store.ttlSeconds('api-football', '1917');
    expect(ttl).toBe(EMITTED_FIXTURE_DEFAULT_TTL_SECONDS);
    expect(EMITTED_FIXTURE_DEFAULT_TTL_SECONDS).toBe(30 * 24 * 60 * 60);

    // Advancing the clock close to the boundary should still leave a
    // positive TTL; the value tracks the deadline minus now().
    clock.mockReturnValue(baseNow + 5 * 24 * 60 * 60 * 1000);
    const ttlLater = await store.ttlSeconds('api-football', '1917');
    expect(ttlLater).toBe(25 * 24 * 60 * 60);
  });

  it('process restart sees prior emits when a new store instance points at the same Redis', async () => {
    const redis = new InMemoryBunRedisMock();
    const firstInstance = new RedisEmittedFixtureStore({ client: redis });
    await firstInstance.markEmitted('api-football', '1917');
    await firstInstance.markEmitted('api-football', '2018');

    // Simulate a worker restart: drop the in-process store, build a new
    // one against the same Redis client. The prior markers must still
    // be visible.
    const secondInstance = new RedisEmittedFixtureStore({ client: redis });
    expect(await secondInstance.hasEmitted('api-football', '1917')).toBe(true);
    expect(await secondInstance.hasEmitted('api-football', '2018')).toBe(true);
    expect(await secondInstance.hasEmitted('api-football', 'never-marked')).toBe(false);
  });

  it('issues `SET key 1 NX EX <ttl>` with the documented argument order', async () => {
    const redis = new InMemoryBunRedisMock();
    const store = new RedisEmittedFixtureStore({ client: redis });

    await store.markEmitted('api-football', '1917');

    const setCall = redis.calls.find((c) => c.command.toUpperCase() === 'SET');
    expect(setCall).toBeDefined();
    expect(setCall?.args).toEqual([
      `${EMITTED_FIXTURE_REDIS_KEY_PREFIX}api-football:1917`,
      '1',
      'NX',
      'EX',
      String(EMITTED_FIXTURE_DEFAULT_TTL_SECONDS),
    ]);
  });

  it('keys by (provider, fixture_id) tuple, not fixture_id alone', async () => {
    const redis = new InMemoryBunRedisMock();
    const store = new RedisEmittedFixtureStore({ client: redis });

    await store.markEmitted('api-football', '1917');

    expect(await store.hasEmitted('api-football', '1917')).toBe(true);
    expect(await store.hasEmitted('sportmonks', '1917')).toBe(false);
  });

  it('respects a custom TTL override', async () => {
    const baseNow = 1_700_000_000_000;
    const clock = vi.fn(() => baseNow);
    const redis = new InMemoryBunRedisMock(clock);
    const store = new RedisEmittedFixtureStore({ client: redis, ttlSeconds: 60 });

    await store.markEmitted('api-football', '1917');

    expect(await store.ttlSeconds('api-football', '1917')).toBe(60);
  });

  it('respects a custom key prefix for test isolation', async () => {
    const redis = new InMemoryBunRedisMock();
    const store = new RedisEmittedFixtureStore({
      client: redis,
      keyPrefix: 'test:emitted:',
    });

    await store.markEmitted('api-football', '1917');

    expect(redis.store.has('test:emitted:api-football:1917')).toBe(true);
    expect(redis.store.has(`${EMITTED_FIXTURE_REDIS_KEY_PREFIX}api-football:1917`)).toBe(false);
  });

  it('reports backend="redis" so the publisher boot log can distinguish stores', () => {
    const redis = new InMemoryBunRedisMock();
    const store = new RedisEmittedFixtureStore({ client: redis });
    expect(store.backend).toBe('redis');
  });

  it('coerces string-typed integer replies (RESP2 protocol variant)', async () => {
    // Some Redis clients return INTEGER replies as strings rather than
    // numbers. The store must tolerate either shape so it can be
    // wired against ioredis / node-redis adapters without bespoke
    // type-coercion at the call site.
    const stringEchoingClient: BunRedisEmittedFixtureClient = {
      send: async (command, _args) => {
        if (command.toUpperCase() === 'EXISTS') {
          return '1';
        }
        if (command.toUpperCase() === 'TTL') {
          return '42';
        }
        return 'OK';
      },
    };
    const store = new RedisEmittedFixtureStore({ client: stringEchoingClient });

    expect(await store.hasEmitted('api-football', '1917')).toBe(true);
    expect(await store.ttlSeconds('api-football', '1917')).toBe(42);
  });
});
