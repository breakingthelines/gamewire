/**
 * Provider cache abstraction with TTL semantics.
 *
 * Used by the API-Football ingestion loop to avoid duplicate provider calls.
 * Backed by Redis when REDIS_URL is set; falls back to an in-process map for
 * tests and replay mode (no network coupling).
 *
 * Redis is treated as a shared cache across worker replicas; the in-memory
 * fallback is a per-process best-effort replacement only. The cache stores
 * JSON-encoded payloads keyed by a worker-managed namespace.
 */

export interface ProviderCache {
  /**
   * Read a cached payload. Returns undefined on miss or expired entry.
   */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /**
   * Write a payload with a TTL in seconds. Implementations MUST honour the TTL
   * by clearing the entry after the deadline elapses.
   */
  set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void>;

  /**
   * Optional probe used by the loop to identify the backing store in logs.
   */
  readonly backend: 'redis' | 'memory';
}

export interface InMemoryCacheOptions {
  readonly clock?: () => number;
}

/**
 * Process-local map with TTL expiry. Acceptable for replay mode, single-replica
 * staging, and tests. The Redis-backed driver replaces this in production.
 */
export class InMemoryProviderCache implements ProviderCache {
  readonly backend = 'memory' as const;
  readonly #clock: () => number;
  readonly #entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(options: InMemoryCacheOptions = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      this.#entries.delete(key);
      return;
    }

    this.#entries.set(key, {
      value,
      expiresAt: this.#clock() + ttlSeconds * 1000,
    });
  }

  size(): number {
    return this.#entries.size;
  }

  reset(): void {
    this.#entries.clear();
  }
}

/**
 * Minimal Redis client contract this module relies on. Wider clients
 * (ioredis, node-redis, Bun.Redis) all expose these methods or trivial
 * adapters can be written. Keeping the surface tiny lets us avoid pulling
 * a heavyweight Redis dependency into the worker image.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { readonly EX: number }): Promise<unknown>;
  incrBy(key: string, by: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
}

export interface RedisProviderCacheOptions {
  readonly namespace?: string;
  readonly client: RedisLikeClient;
}

/**
 * Redis-backed cache. Stores JSON-encoded payloads under a `gamewire:` prefix
 * by default so other services using the same Redis instance don't collide.
 */
export class RedisProviderCache implements ProviderCache {
  readonly backend = 'redis' as const;
  readonly #namespace: string;
  readonly #client: RedisLikeClient;

  constructor(options: RedisProviderCacheOptions) {
    this.#namespace = options.namespace ?? 'gamewire';
    this.#client = options.client;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.#client.get(this.#scope(key));
    if (raw === null || raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      return;
    }
    const encoded = JSON.stringify(value ?? null);
    await this.#client.set(this.#scope(key), encoded, { EX: ttlSeconds });
  }

  #scope(key: string): string {
    return `${this.#namespace}:cache:${key}`;
  }
}
