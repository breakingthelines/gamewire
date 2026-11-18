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
 * - With `smoothBackground`, every class also counts into a one-second bucket.
 *   `background` is refused once that second holds `ceil(background / 60)`
 *   calls (8 by default) and `near-live` once it holds `ceil(near-live / 60)`
 *   (11). The provider refuses bursts well under its 900 a minute (about 20
 *   calls inside one second drew "too many requests" in prod; a boot discovery
 *   sweep of ~38 near-live calls had 18 refused), so a minute count alone does
 *   not keep a burst clear of it. Live is never held by the second bucket;
 *   near-live yields to live, and background to both.
 * - On Redis a token is one `EVAL` of {@link MINUTE_ACQUIRE_SCRIPT}: one round
 *   trip, atomic, with every key taken from one clock reading.
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
/**
 * Per-minute ceiling for provider enrichment jobs (`/workflows/provider-enrichment`),
 * applied by a second limiter in front of the background ceiling.
 */
export const DEFAULT_ENRICHMENT_MINUTE_CAP = 120;
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
  /**
   * Take one token in a single step: read the previous minute, count the call
   * into the minute bucket and, when asked, the second bucket, and refund both
   * when a cap refuses it. A store without it gets {@link acquireWithCounters},
   * which makes the same calls one at a time.
   */
  acquire?(request: MinuteAcquireRequest): Promise<MinuteAcquireCounts>;
  /**
   * Take one call back out of each bucket that still holds one. A bucket that
   * has expired is left alone, never recreated: a plain `INCRBY -1` on an
   * expired second bucket used to leave a `-1` key with no TTL behind.
   * A store without it gets {@link refundWithCounters}.
   */
  refund?(buckets: readonly MinuteBucketRef[]): Promise<void>;
  readonly backend: 'redis' | 'memory';
}

/** A minute or second bucket and the TTL it is written with. */
export interface MinuteBucketRef {
  readonly key: string;
  readonly ttlSeconds: number;
}

/** One {@link ProviderMinuteLimiter.tryAcquire}, with every key fixed from one clock reading. */
export interface MinuteAcquireRequest {
  readonly previousMinuteKey: string;
  readonly minuteKey: string;
  readonly minuteTtlSeconds: number;
  /** Fraction of the current minute already gone, in [0, 1). */
  readonly elapsed: number;
  /** The class ceiling on the sliding-window estimate. */
  readonly ceiling: number;
  /** Count into a one-second bucket too (smoothing on). */
  readonly second?: {
    readonly key: string;
    readonly ttlSeconds: number;
    readonly cap: number;
    /** Refuse above `cap`. Only background is held; other classes are counted. */
    readonly enforce: boolean;
  };
}

export interface MinuteAcquireCounts {
  readonly outcome: 'allowed' | 'minute_cap' | 'second_cap';
  /** The previous minute's count. */
  readonly previous: number;
  /** The minute count after this call's increment, before any refund. */
  readonly current: number;
  /** The second count after this call's increment, when the second bucket was counted. */
  readonly inSecond?: number;
}

/** Sliding-window estimate: the previous minute decays as the current one fills. */
const slidingEstimate = (previous: number, current: number, elapsed: number): number =>
  previous * (1 - elapsed) + current;

/**
 * {@link MinuteCounterStore.acquire} from `read` and `increment`, one call at
 * a time. Used by the in-memory store and by any store without its own.
 */
export async function acquireWithCounters(
  store: Pick<MinuteCounterStore, 'read' | 'increment'>,
  request: MinuteAcquireRequest
): Promise<MinuteAcquireCounts> {
  const previous = await store.read(request.previousMinuteKey);
  const current = await store.increment(request.minuteKey, 1, request.minuteTtlSeconds);
  if (slidingEstimate(previous, current, request.elapsed) > request.ceiling) {
    await store.increment(request.minuteKey, -1, request.minuteTtlSeconds);
    return { outcome: 'minute_cap', previous, current };
  }
  const second = request.second;
  if (!second) {
    return { outcome: 'allowed', previous, current };
  }
  const inSecond = await store.increment(second.key, 1, second.ttlSeconds);
  if (second.enforce && inSecond > second.cap) {
    await store.increment(request.minuteKey, -1, request.minuteTtlSeconds);
    await store.increment(second.key, -1, second.ttlSeconds);
    return { outcome: 'second_cap', previous, current, inSecond };
  }
  return { outcome: 'allowed', previous, current, inSecond };
}

/**
 * {@link MinuteCounterStore.refund} from `read` and `increment`: decrement
 * only a bucket that still counts a call. Not atomic; the Redis store uses
 * {@link MINUTE_REFUND_SCRIPT}.
 */
export async function refundWithCounters(
  store: Pick<MinuteCounterStore, 'read' | 'increment'>,
  buckets: readonly MinuteBucketRef[]
): Promise<void> {
  for (const bucket of buckets) {
    if ((await store.read(bucket.key)) > 0) {
      await store.increment(bucket.key, -1, bucket.ttlSeconds);
    }
  }
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

  acquire(request: MinuteAcquireRequest): Promise<MinuteAcquireCounts> {
    return acquireWithCounters(this, request);
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

/** Same minimal client surface as {@link RedisQuotaClient}, plus `EVAL`. */
export interface RedisMinuteCounterClient {
  get(key: string): Promise<string | null>;
  incrBy(key: string, by: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  /** `EVAL script numkeys key... arg...`. Without it the store sends one command per step. */
  eval?(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}

/**
 * {@link acquireWithCounters} as one Lua script, so a token costs one Redis
 * round trip instead of five. Every step a caller waited on before (a 5 s
 * blocking read on the same connection once made each of them cost 5 s, and
 * a provider-enrichment page 50 s) now happens inside one atomic call.
 *
 * KEYS: previous minute, current minute, second (only when ARGV[4] > 0).
 * ARGV: elapsed fraction, ceiling, minute TTL, second cap (0 = no second
 * bucket), second TTL, enforce the second cap (1/0).
 * Reply: { outcome (0 allowed, 1 minute_cap, 2 second_cap), previous,
 * current, inSecond (-1 when not counted) }. `elapsed` is passed as the
 * shortest decimal that round-trips, so Lua's double arithmetic matches the
 * JavaScript estimate exactly.
 */
export const MINUTE_ACQUIRE_SCRIPT = `
local previous = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
if previous < 0 then previous = 0 end
local current = redis.call('INCRBY', KEYS[2], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
if current < 0 then current = 0 end
if previous * (1 - tonumber(ARGV[1])) + current > tonumber(ARGV[2]) then
  redis.call('INCRBY', KEYS[2], -1)
  return {1, previous, current, -1}
end
local secondCap = tonumber(ARGV[4])
if secondCap <= 0 then
  return {0, previous, current, -1}
end
local inSecond = redis.call('INCRBY', KEYS[3], 1)
redis.call('EXPIRE', KEYS[3], ARGV[5])
if inSecond < 0 then inSecond = 0 end
if ARGV[6] == '1' and inSecond > secondCap then
  redis.call('INCRBY', KEYS[2], -1)
  redis.call('INCRBY', KEYS[3], -1)
  return {2, previous, current, inSecond}
end
return {0, previous, current, inSecond}
`;

/**
 * {@link MinuteCounterStore.refund} as one script: `DECR` each key that holds
 * a positive count. `DECR` keeps the key's TTL; a missing (expired) key is
 * not touched, so a late refund can never create a key without one.
 */
export const MINUTE_REFUND_SCRIPT = `
for _, key in ipairs(KEYS) do
  local value = tonumber(redis.call('GET', key) or '0') or 0
  if value > 0 then
    redis.call('DECR', key)
  end
end
return 0
`;

const ACQUIRE_OUTCOMES: readonly MinuteAcquireCounts['outcome'][] = [
  'allowed',
  'minute_cap',
  'second_cap',
];

/** Decode the {@link MINUTE_ACQUIRE_SCRIPT} reply. Throws on anything else. */
export function parseMinuteAcquireReply(raw: unknown): MinuteAcquireCounts {
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error(`minute limiter: unexpected EVAL reply ${JSON.stringify(raw)}`);
  }
  const [code, previous, current, inSecond] = raw.map((value) => Number(value));
  const outcome = ACQUIRE_OUTCOMES[code ?? -1];
  if (
    outcome === undefined ||
    !Number.isFinite(previous) ||
    !Number.isFinite(current) ||
    !Number.isFinite(inSecond)
  ) {
    throw new Error(`minute limiter: unexpected EVAL reply ${JSON.stringify(raw)}`);
  }
  return {
    outcome,
    previous: previous!,
    current: current!,
    ...(inSecond! >= 0 ? { inSecond: inSecond! } : {}),
  };
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

  async acquire(request: MinuteAcquireRequest): Promise<MinuteAcquireCounts> {
    if (!this.#client.eval) {
      return acquireWithCounters(this, request);
    }
    const second = request.second;
    const keys = second
      ? [request.previousMinuteKey, request.minuteKey, second.key]
      : [request.previousMinuteKey, request.minuteKey];
    const raw = await this.#client.eval(MINUTE_ACQUIRE_SCRIPT, keys, [
      String(request.elapsed),
      String(request.ceiling),
      String(request.minuteTtlSeconds),
      String(second?.cap ?? 0),
      String(second?.ttlSeconds ?? 0),
      second?.enforce ? '1' : '0',
    ]);
    return parseMinuteAcquireReply(raw);
  }

  async refund(buckets: readonly MinuteBucketRef[]): Promise<void> {
    if (!this.#client.eval) {
      return refundWithCounters(this, buckets);
    }
    await this.#client.eval(
      MINUTE_REFUND_SCRIPT,
      buckets.map((bucket) => bucket.key),
      []
    );
  }
}

export type MinuteDenyReason =
  | 'minute_cap'
  | 'second_cap'
  | 'provider_minute_header'
  | 'store_unavailable';

export interface MinuteAcquireResult {
  readonly allowed: boolean;
  readonly priority: ProviderPriority;
  /** Epoch minute the token was taken from (used by {@link ProviderMinuteLimiter.release}). */
  readonly epochMinute: number;
  /** Epoch second the token was taken from, when the second bucket was counted. */
  readonly epochSecond?: number;
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
  /**
   * Count every call in a one-second bucket and refuse `background` above
   * `ceil(caps.background / 60)` and `near-live` above
   * `ceil(caps['near-live'] / 60)` calls in that second. Live is never held.
   * Off by default.
   */
  readonly smoothBackground?: boolean;
}

/** One-second ceiling for background when smoothing is on. */
export const backgroundSecondCap = (caps: ProviderMinuteCaps): number =>
  Math.max(1, Math.ceil(caps.background / 60));

/** One-second ceiling for near-live when smoothing is on. */
export const nearLiveSecondCap = (caps: ProviderMinuteCaps): number =>
  Math.max(1, Math.ceil(caps['near-live'] / 60));

const SECOND_BUCKET_TTL_SECONDS = 5;

export class ProviderMinuteLimiter {
  readonly #providerId: string;
  readonly #namespace: string;
  readonly #store: MinuteCounterStore;
  readonly #caps: ProviderMinuteCaps;
  readonly #headerReserve: number;
  readonly #clock: () => number;
  readonly #secondCap: number | undefined;
  readonly #nearLiveSecondCap: number | undefined;
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
    this.#secondCap = options.smoothBackground ? backgroundSecondCap(caps) : undefined;
    this.#nearLiveSecondCap = options.smoothBackground ? nearLiveSecondCap(caps) : undefined;
  }

  /** Background calls allowed in one second, or undefined when smoothing is off. */
  get backgroundSecondCap(): number | undefined {
    return this.#secondCap;
  }

  /** Near-live calls allowed in one second, or undefined when smoothing is off. */
  get nearLiveSecondCap(): number | undefined {
    return this.#nearLiveSecondCap;
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

  secondKeyFor(epochSecond: number): string {
    return `${this.#namespace}:provider:${this.#providerId}:second:${epochSecond}`;
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

    const epochSecond = Math.floor(nowMs / 1_000);
    const request: MinuteAcquireRequest = {
      previousMinuteKey: this.keyFor(epochMinute - 1),
      minuteKey: this.keyFor(epochMinute),
      minuteTtlSeconds: BUCKET_TTL_SECONDS,
      elapsed,
      ceiling,
      ...(this.#secondCap === undefined
        ? {}
        : {
            second: {
              key: this.secondKeyFor(epochSecond),
              ttlSeconds: SECOND_BUCKET_TTL_SECONDS,
              cap:
                priority === 'near-live'
                  ? (this.#nearLiveSecondCap ?? this.#secondCap)
                  : this.#secondCap,
              enforce: priority !== 'live',
            },
          }),
    };

    try {
      const counts = this.#store.acquire
        ? await this.#store.acquire(request)
        : await acquireWithCounters(this.#store, request);
      const { previous, current } = counts;
      const estimate = slidingEstimate(previous, current, elapsed);
      if (counts.outcome === 'minute_cap') {
        return {
          ...base,
          allowed: false,
          estimate: estimate - 1,
          reason: 'minute_cap',
          retryAfterMs: retryAfterMs(previous, current - 1, ceiling, elapsed, msUntilNextMinute),
        };
      }
      if (request.second === undefined) {
        return { ...base, allowed: true, estimate };
      }
      if (counts.outcome === 'second_cap') {
        return {
          ...base,
          allowed: false,
          estimate: estimate - 1,
          reason: 'second_cap',
          retryAfterMs: (epochSecond + 1) * 1_000 - nowMs,
        };
      }
      return { ...base, allowed: true, estimate, epochSecond };
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
    const buckets: MinuteBucketRef[] = [
      { key: this.keyFor(acquired.epochMinute), ttlSeconds: BUCKET_TTL_SECONDS },
    ];
    if (acquired.epochSecond !== undefined) {
      buckets.push({
        key: this.secondKeyFor(acquired.epochSecond),
        ttlSeconds: SECOND_BUCKET_TTL_SECONDS,
      });
    }
    try {
      await (this.#store.refund
        ? this.#store.refund(buckets)
        : refundWithCounters(this.#store, buckets));
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

/** Anything that can send a raw Redis command, such as `Bun.redis`. */
export interface RedisCommandSender {
  send(command: string, args: string[]): Promise<unknown>;
}

/**
 * Adapt a raw command sender (`Bun.redis`) to {@link RedisMinuteCounterClient},
 * so the minute and second buckets are shared by every worker pod and survive
 * a restart.
 */
export const createRedisMinuteCounterClient = (
  sender: RedisCommandSender
): RedisMinuteCounterClient => ({
  async get(key) {
    const raw = await sender.send('GET', [key]);
    return raw === null || raw === undefined ? null : String(raw);
  },
  async incrBy(key, by) {
    return Number(await sender.send('INCRBY', [key, String(by)]));
  },
  async expire(key, ttlSeconds) {
    return Number(await sender.send('EXPIRE', [key, String(ttlSeconds)]));
  },
  async eval(script, keys, args) {
    return sender.send('EVAL', [script, String(keys.length), ...keys, ...args]);
  },
});
