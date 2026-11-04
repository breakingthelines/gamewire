/**
 * Per-minute provider rate limiter with priority classes.
 *
 * API-Football's Mega plan allows 900 requests per minute per account. The
 * daily {@link ProviderQuotaTracker} cannot see bursts, so this limiter sits in
 * front of it on every provider call.
 *
 * Contract:
 * - One shared counter per provider per epoch minute, under the Redis key
 *   `${namespace}:provider:${providerId}:minute:${epochMinute}` (INCR, EXPIRE
 *   120). Every class spends the same bucket.
 * - Each class has its own ceiling on that shared count: `live` 800,
 *   `near-live` 650, `background` 450 by default. A lower class stops first, so
 *   the headroom above its ceiling is left for the classes above it.
 * - The count is a sliding-window estimate:
 *   `previous * (1 - elapsedFraction) + current`. A plain epoch-minute bucket
 *   lets a full ceiling land at :59 and another at :00, which is two ceilings
 *   inside 60 seconds. If the provider's window is rolling, that breaches it.
 *   The estimate bounds any 60-second span to about one ceiling.
 * - When the provider's own minute header (`x-ratelimit-remaining`) reads at or
 *   below `headerReserve` (default 50) for the current minute, `background` is
 *   refused: other spenders on the same key (staging, identity tools, manual
 *   calls) have used the headroom.
 * - If the counter store fails, `live` and `near-live` are allowed (fail open)
 *   and `background` is refused (fail closed).
 *
 * The limiter only answers "may this call leave now". What a denied caller does
 * (serve the last good payload, or wait for the next minute and retry once) is
 * decided in the ingestion loop.
 */

export type ProviderPriority = 'live' | 'near-live' | 'background';

export const PROVIDER_PRIORITIES: readonly ProviderPriority[] = ['live', 'near-live', 'background'];

export const DEFAULT_PROVIDER_MINUTE_CAP_LIVE = 800;
export const DEFAULT_PROVIDER_MINUTE_CAP_NEARLIVE = 650;
export const DEFAULT_PROVIDER_MINUTE_CAP_BACKGROUND = 450;
/** Remaining-per-minute value at or below which background is refused. */
export const DEFAULT_PROVIDER_MINUTE_HEADER_RESERVE = 50;

export type ProviderMinuteCaps = Readonly<Record<ProviderPriority, number>>;

export const DEFAULT_PROVIDER_MINUTE_CAPS: ProviderMinuteCaps = {
  live: DEFAULT_PROVIDER_MINUTE_CAP_LIVE,
  'near-live': DEFAULT_PROVIDER_MINUTE_CAP_NEARLIVE,
  background: DEFAULT_PROVIDER_MINUTE_CAP_BACKGROUND,
};

const MINUTE_MS = 60_000;
const BUCKET_TTL_SECONDS = 120;

export interface MinuteCounterStore {
  /** Atomically add `by` to `key`, set its expiry, and return the new total. */
  increment(key: string, by: number, ttlSeconds: number): Promise<number>;
  /** Read the current total for `key` (0 when absent). */
  read(key: string): Promise<number>;
  readonly backend: 'redis' | 'memory';
}

export interface InMemoryMinuteCounterStoreOptions {
  readonly clock?: () => number;
}

export class InMemoryMinuteCounterStore implements MinuteCounterStore {
  readonly backend = 'memory' as const;
  readonly #clock: () => number;
  readonly #entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(options: InMemoryMinuteCounterStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  async increment(key: string, by: number, ttlSeconds: number): Promise<number> {
    this.#sweep();
    const now = this.#clock();
    const entry = this.#entries.get(key);
    const count = Math.max(0, (entry && entry.expiresAt > now ? entry.count : 0) + by);
    this.#entries.set(key, { count, expiresAt: now + ttlSeconds * 1_000 });
    return count;
  }

  async read(key: string): Promise<number> {
    const entry = this.#entries.get(key);
    if (!entry || entry.expiresAt <= this.#clock()) {
      return 0;
    }
    return entry.count;
  }

  size(): number {
    return this.#entries.size;
  }

  #sweep(): void {
    const now = this.#clock();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }
}

/** Same minimal client surface as {@link RedisQuotaClient}. */
export interface RedisMinuteCounterClient {
  get(key: string): Promise<string | null>;
  incrBy(key: string, by: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
}

export class RedisMinuteCounterStore implements MinuteCounterStore {
  readonly backend = 'redis' as const;
  readonly #client: RedisMinuteCounterClient;

  constructor(client: RedisMinuteCounterClient) {
    this.#client = client;
  }

  async increment(key: string, by: number, ttlSeconds: number): Promise<number> {
    const total = await this.#client.incrBy(key, by);
    if (by > 0) {
      await this.#client.expire(key, ttlSeconds);
    }
    return Math.max(0, total);
  }

  async read(key: string): Promise<number> {
    const raw = await this.#client.get(key);
    if (!raw) {
      return 0;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
}

export type MinuteDenyReason = 'minute_cap' | 'provider_minute_header' | 'store_unavailable';

export interface MinuteAcquireResult {
  readonly allowed: boolean;
  readonly priority: ProviderPriority;
  /** Epoch minute the token was taken from (used by {@link ProviderMinuteLimiter.release}). */
  readonly epochMinute: number;
  /** Sliding-window estimate of calls in the last 60s, including this one when allowed. */
  readonly estimate: number;
  readonly ceiling: number;
  readonly reason?: MinuteDenyReason;
  /** True when the store failed and the class policy decided the outcome. */
  readonly failOpen?: boolean;
  /** Milliseconds until the next epoch-minute boundary. */
  readonly msUntilNextMinute: number;
  /**
   * For a denied call: milliseconds until the estimate would admit one more
   * call of this class if nothing else were spent meanwhile. The sliding
   * estimate still carries most of a full minute just after the boundary, so
   * this is usually later than {@link msUntilNextMinute}.
   */
  readonly retryAfterMs?: number;
}

export interface ProviderMinuteLimiterOptions {
  readonly providerId: string;
  readonly namespace?: string;
  readonly store?: MinuteCounterStore;
  readonly caps?: Partial<ProviderMinuteCaps>;
  readonly headerReserve?: number;
  readonly clock?: () => number;
}

export class ProviderMinuteLimiter {
  readonly #providerId: string;
  readonly #namespace: string;
  readonly #store: MinuteCounterStore;
  readonly #caps: ProviderMinuteCaps;
  readonly #headerReserve: number;
  readonly #clock: () => number;
  #remoteMinute: { epochMinute: number; remaining: number; limit?: number } | undefined;

  constructor(options: ProviderMinuteLimiterOptions) {
    const caps: ProviderMinuteCaps = { ...DEFAULT_PROVIDER_MINUTE_CAPS, ...options.caps };
    validateMinuteCaps(caps);
    this.#providerId = options.providerId;
    this.#namespace = options.namespace ?? 'gamewire';
    this.#clock = options.clock ?? Date.now;
    this.#store = options.store ?? new InMemoryMinuteCounterStore({ clock: this.#clock });
    this.#caps = caps;
    this.#headerReserve = options.headerReserve ?? DEFAULT_PROVIDER_MINUTE_HEADER_RESERVE;
  }

  get caps(): ProviderMinuteCaps {
    return this.#caps;
  }

  get backend(): MinuteCounterStore['backend'] {
    return this.#store.backend;
  }

  keyFor(epochMinute: number): string {
    return `${this.#namespace}:provider:${this.#providerId}:minute:${epochMinute}`;
  }

  /**
   * Take one token for `priority` if the shared bucket is under that class's
   * ceiling. A denied attempt is refunded so it does not count.
   */
  async tryAcquire(priority: ProviderPriority): Promise<MinuteAcquireResult> {
    const nowMs = this.#clock();
    const epochMinute = Math.floor(nowMs / MINUTE_MS);
    const elapsed = (nowMs - epochMinute * MINUTE_MS) / MINUTE_MS;
    const msUntilNextMinute = (epochMinute + 1) * MINUTE_MS - nowMs;
    const ceiling = this.#caps[priority];
    const base = { priority, epochMinute, ceiling, msUntilNextMinute };

    if (priority === 'background' && this.#providerMinuteExhausted(epochMinute)) {
      return {
        ...base,
        allowed: false,
        estimate: 0,
        reason: 'provider_minute_header',
        retryAfterMs: msUntilNextMinute,
      };
    }

    try {
      const previous = await this.#store.read(this.keyFor(epochMinute - 1));
      const current = await this.#store.increment(this.keyFor(epochMinute), 1, BUCKET_TTL_SECONDS);
      const estimate = previous * (1 - elapsed) + current;
      if (estimate > ceiling) {
        await this.#store.increment(this.keyFor(epochMinute), -1, BUCKET_TTL_SECONDS);
        return {
          ...base,
          allowed: false,
          estimate: estimate - 1,
          reason: 'minute_cap',
          retryAfterMs: retryAfterMs(previous, current - 1, ceiling, elapsed, msUntilNextMinute),
        };
      }
      return { ...base, allowed: true, estimate };
    } catch {
      const allowed = priority !== 'background';
      return {
        ...base,
        allowed,
        estimate: 0,
        failOpen: true,
        reason: allowed ? undefined : 'store_unavailable',
      };
    }
  }

  /**
   * Return a token taken by {@link tryAcquire} for a call that never left the
   * worker (daily quota denied it, replay mode, missing key). Best effort.
   */
  async release(acquired: MinuteAcquireResult): Promise<void> {
    if (!acquired.allowed || acquired.failOpen) {
      return;
    }
    try {
      await this.#store.increment(this.keyFor(acquired.epochMinute), -1, BUCKET_TTL_SECONDS);
    } catch {
      // The bucket expires in 120s regardless.
    }
  }

  /**
   * Record the provider's own per-minute headers from a response. Only the
   * latest reading for the current minute is kept.
   */
  observeProviderMinute(input: { readonly remaining?: number; readonly limit?: number }): void {
    if (input.remaining === undefined) {
      return;
    }
    const epochMinute = Math.floor(this.#clock() / MINUTE_MS);
    this.#remoteMinute = { epochMinute, remaining: input.remaining, limit: input.limit };
  }

  #providerMinuteExhausted(epochMinute: number): boolean {
    const remote = this.#remoteMinute;
    return (
      remote !== undefined &&
      remote.epochMinute === epochMinute &&
      remote.remaining <= this.#headerReserve
    );
  }
}

/**
 * Time until `previous * (1 - f) + current + 1 <= ceiling`, assuming no other
 * calls. First within this minute (the previous bucket keeps decaying), then
 * in the next one, where `current` becomes the decaying bucket.
 */
function retryAfterMs(
  previous: number,
  current: number,
  ceiling: number,
  elapsed: number,
  msUntilNextMinute: number
): number {
  const room = ceiling - current - 1;
  if (previous > 0 && room >= 0) {
    const needed = 1 - room / previous;
    if (needed < 1) {
      return Math.max(0, Math.ceil((needed - elapsed) * MINUTE_MS));
    }
  }
  if (current <= 0) {
    return msUntilNextMinute;
  }
  const nextFraction = Math.max(0, 1 - (ceiling - 1) / current);
  return msUntilNextMinute + Math.ceil(nextFraction * MINUTE_MS);
}

/**
 * Ceilings must be positive and ordered background <= near-live <= live, or a
 * lower class could take headroom reserved for a higher one.
 */
export function validateMinuteCaps(caps: ProviderMinuteCaps): void {
  for (const priority of PROVIDER_PRIORITIES) {
    const value = caps[priority];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Provider minute cap for ${priority} must be a positive integer`);
    }
  }
  if (caps.background > caps['near-live'] || caps['near-live'] > caps.live) {
    throw new Error(
      `Provider minute caps must be ordered background (${caps.background}) <= near-live (${caps['near-live']}) <= live (${caps.live})`
    );
  }
}
