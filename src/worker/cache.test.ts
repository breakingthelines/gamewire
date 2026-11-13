import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryProviderCache,
  RedisProviderCache,
  createRedisLikeClient,
  type RedisLikeClient,
} from './cache.js';

describe('InMemoryProviderCache', () => {
  it('returns undefined on miss', async () => {
    const cache = new InMemoryProviderCache();
    expect(await cache.get('missing')).toBeUndefined();
    expect(cache.backend).toBe('memory');
  });

  it('respects TTL', async () => {
    let now = 1_000;
    const cache = new InMemoryProviderCache({ clock: () => now });
    await cache.set('k', { a: 1 }, 5);
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
    now = 1_000 + 5_001; // just past 5 seconds
    expect(await cache.get('k')).toBeUndefined();
  });

  it('sweeps expired entries that are never read again', async () => {
    let now = 0;
    const cache = new InMemoryProviderCache({ clock: () => now, sweepIntervalMs: 1_000 });
    await cache.set('finished-fixture', 'v', 1);
    await cache.set('live-fixture', 'v', 60);
    expect(cache.size()).toBe(2);
    now = 2_000;
    await cache.set('another', 'v', 60);
    expect(cache.size()).toBe(2);
    expect(await cache.get('live-fixture')).toBe('v');
  });

  it('treats non-positive TTL as eviction', async () => {
    const cache = new InMemoryProviderCache();
    await cache.set('k', 'v', 10);
    await cache.set('k', 'v', 0);
    expect(await cache.get('k')).toBeUndefined();
  });
});

describe('RedisProviderCache', () => {
  const buildClient = (): RedisLikeClient & {
    readonly store: Map<string, string>;
    readonly setMock: ReturnType<typeof vi.fn>;
  } => {
    const store = new Map<string, string>();
    const setMock = vi.fn(async (key: string, value: string, _options: { EX: number }) => {
      store.set(key, value);
      return 'OK';
    });
    return {
      store,
      setMock,
      async get(key: string) {
        return store.get(key) ?? null;
      },
      set: setMock as unknown as RedisLikeClient['set'],
      async incrBy(key: string, by: number) {
        const next = Number.parseInt(store.get(key) ?? '0', 10) + by;
        store.set(key, String(next));
        return next;
      },
      async expire() {
        return 1;
      },
    };
  };

  it('round-trips JSON-encoded payloads under a namespace', async () => {
    const client = buildClient();
    const cache = new RedisProviderCache({ client, namespace: 'gamewire' });

    await cache.set('fixtures-next-7d:abc', { count: 3 }, 60);
    const result = await cache.get<{ count: number }>('fixtures-next-7d:abc');

    expect(result).toEqual({ count: 3 });
    expect(client.setMock).toHaveBeenCalledWith(
      'gamewire:cache:fixtures-next-7d:abc',
      JSON.stringify({ count: 3 }),
      { EX: 60 }
    );
  });

  it('returns undefined when Redis has no entry', async () => {
    const client = buildClient();
    const cache = new RedisProviderCache({ client });
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('survives malformed JSON in Redis', async () => {
    const client = buildClient();
    client.store.set('gamewire:cache:k', '{not json');
    const cache = new RedisProviderCache({ client });
    expect(await cache.get('k')).toBeUndefined();
  });

  it('skips set when TTL is non-positive', async () => {
    const client = buildClient();
    const cache = new RedisProviderCache({ client });
    await cache.set('k', 'v', 0);
    expect(client.setMock).not.toHaveBeenCalled();
  });
});

describe('createRedisLikeClient', () => {
  it('maps cache calls onto raw Redis commands, with SET EX for the TTL', async () => {
    const sent: string[] = [];
    const store = new Map<string, string>();
    const cache = new RedisProviderCache({
      client: createRedisLikeClient({
        send: async (command, args) => {
          sent.push(`${command} ${args.join(' ')}`);
          if (command === 'SET') {
            store.set(args[0]!, args[1]!);
            return 'OK';
          }
          if (command === 'GET') {
            return store.get(args[0]!) ?? null;
          }
          return 1;
        },
      }),
    });
    await cache.set('backfill:cursor:39:2024', { nextIndex: 194 }, 604_800);
    expect(await cache.get('backfill:cursor:39:2024')).toEqual({ nextIndex: 194 });
    expect(await cache.get('missing')).toBeUndefined();
    expect(sent).toEqual([
      'SET gamewire:cache:backfill:cursor:39:2024 {"nextIndex":194} EX 604800',
      'GET gamewire:cache:backfill:cursor:39:2024',
      'GET gamewire:cache:missing',
    ]);
  });
});
