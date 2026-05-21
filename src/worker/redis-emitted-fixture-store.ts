/**
 * Redis-backed implementation of {@link EmittedFixtureStore}.
 *
 * # Why this exists
 *
 * The default {@link InMemoryEmittedFixtureStore} keeps the per-fixture
 * emit-once marker in a process-local `Set`. A worker restart between
 * two terminal observations of the same fixture loses the marker and
 * the publisher re-emits. The consumer dedupes by `event_id` so the
 * result is harmless today, but the proper root fix is to persist the
 * marker outside the worker process, across restarts and across
 * replicas.
 *
 * # Wire-level contract
 *
 * Each marker is stored under
 * `btl:fact:emitted:<provider>:<provider_fixture_id>` (the existing
 * tuple key the in-memory store uses, prefixed by a namespace shared
 * with the rest of the fact bus). The value is the literal string `"1"`;
 * we never inspect it, presence is the signal.
 *
 * TTL is fixed at 30 days. A fixture transitions to a terminal status
 * at most once per real-world calendar week of competition; 30 days is
 * long enough that any plausible duplicate observation falls inside the
 * window and short enough that keys for completed seasons age out
 * automatically.
 *
 * # Atomicity
 *
 * `markEmitted` uses `SET key 1 NX EX <ttl>`, a single round-trip that
 * is atomic on the Redis side. The publisher reserves the marker before
 * `XADD`, so concurrent workers or concurrent workload lanes cannot all
 * publish the same terminal fixture. If the publish fails before XADD
 * completes, the publisher calls `clearEmitted` as a best-effort rollback
 * so the next observation can retry.
 */

import type { EmittedFixtureStore } from './match-concluded-publisher.js';

/**
 * Redis key prefix for the per-fixture emit-once marker. Load-bearing
 * constant. Kept narrow so other fact-bus consumers can adopt the same
 * `btl:fact:emitted:` namespace if they grow their own publisher-side
 * dedupe paths.
 */
export const EMITTED_FIXTURE_REDIS_KEY_PREFIX = 'btl:fact:emitted:';

/**
 * Default TTL on a freshly-marked emit. 30 days in seconds. Exported
 * so tests and ops tooling can refer to the same constant rather than
 * re-deriving it.
 */
export const EMITTED_FIXTURE_DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Minimal Bun.redis shape we depend on. Identical surface to the one
 * used by {@link createBunMatchConcludedStreamClient} so the same client
 * instance can be passed to both; no need to construct a second Redis
 * connection on the worker.
 */
export interface BunRedisEmittedFixtureClient {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisEmittedFixtureStoreOptions {
  readonly client: BunRedisEmittedFixtureClient;
  /**
   * TTL in seconds applied to every fresh `SET NX`. Defaults to
   * {@link EMITTED_FIXTURE_DEFAULT_TTL_SECONDS}.
   */
  readonly ttlSeconds?: number;
  /**
   * Override the key prefix. Production should leave this at
   * {@link EMITTED_FIXTURE_REDIS_KEY_PREFIX}. Tests may scope by a
   * per-test prefix to isolate Redis state.
   */
  readonly keyPrefix?: string;
}

/**
 * Redis-backed emit-once store. Same contract as
 * {@link InMemoryEmittedFixtureStore}; markers persist across worker
 * restarts and are visible to every replica that points at the same
 * Redis instance.
 */
export class RedisEmittedFixtureStore implements EmittedFixtureStore {
  readonly backend = 'redis' as const;
  readonly #client: BunRedisEmittedFixtureClient;
  readonly #ttlSeconds: number;
  readonly #keyPrefix: string;

  constructor(options: RedisEmittedFixtureStoreOptions) {
    this.#client = options.client;
    this.#ttlSeconds = Math.max(1, options.ttlSeconds ?? EMITTED_FIXTURE_DEFAULT_TTL_SECONDS);
    this.#keyPrefix = options.keyPrefix ?? EMITTED_FIXTURE_REDIS_KEY_PREFIX;
  }

  async hasEmitted(providerId: string, providerFixtureId: string): Promise<boolean> {
    const raw = await this.#client.send('EXISTS', [this.#key(providerId, providerFixtureId)]);
    return toInteger(raw) === 1;
  }

  async markEmitted(providerId: string, providerFixtureId: string): Promise<boolean> {
    // SET NX is atomic: returns OK on first set, null/nil on duplicate.
    const raw = await this.#client.send('SET', [
      this.#key(providerId, providerFixtureId),
      '1',
      'NX',
      'EX',
      String(this.#ttlSeconds),
    ]);
    return raw === 'OK';
  }

  async clearEmitted(providerId: string, providerFixtureId: string): Promise<void> {
    await this.#client.send('DEL', [this.#key(providerId, providerFixtureId)]);
  }

  /**
   * Exposed for tests. Returns the TTL in seconds for the marker (or
   * -2 if the key does not exist, -1 if it has no expiry, matching the
   * Redis `TTL` reply semantics).
   */
  async ttlSeconds(providerId: string, providerFixtureId: string): Promise<number> {
    const raw = await this.#client.send('TTL', [this.#key(providerId, providerFixtureId)]);
    return toInteger(raw);
  }

  #key(providerId: string, providerFixtureId: string): string {
    return `${this.#keyPrefix}${providerId}:${providerFixtureId}`;
  }
}

/**
 * Best-effort coercion of a Bun.redis numeric reply (integer or string)
 * to a JS number. Redis integer replies arrive as `number` in Bun, but
 * the typed boundary here is `unknown` so we tolerate string responses
 * too. Anything we can't parse falls back to 0.
 */
const toInteger = (raw: unknown): number => {
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'bigint') {
    return Number(raw);
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};
