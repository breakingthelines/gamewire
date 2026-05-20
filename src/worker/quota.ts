/**
 * Provider call quota tracker for API-Football daily budget.
 *
 * Contract:
 * - hard cap: 70,000 calls/day (with 5k headroom under the 75k/day plan ceiling)
 * - soft cap: 60,000 calls/day. Above this the worker MUST emit
 *   FallbackReason=PROVIDER_OUTAGE via game-service and serve cached-only.
 * - reset: at UTC midnight by default; window is identified by ISO date string.
 *
 * Backed by Redis INCR + EXPIRE in production; tests use an in-memory store.
 */

export const DEFAULT_PROVIDER_HARD_CAP = 70_000;
export const DEFAULT_PROVIDER_SOFT_CAP = 60_000;
export const DEFAULT_PROVIDER_PLAN_CEILING = 75_000;

export type ProviderQuotaPosture = 'normal' | 'soft_cap_reached' | 'hard_cap_reached';

export interface ProviderQuotaSnapshot {
  readonly provider: string;
  readonly window: string;
  readonly calls: number;
  readonly hardCap: number;
  readonly softCap: number;
  readonly posture: ProviderQuotaPosture;
  readonly cachedOnlyMode: boolean;
}

export interface ProviderQuotaCheckResult {
  readonly allowed: boolean;
  readonly snapshot: ProviderQuotaSnapshot;
  readonly reason?: 'soft_cap' | 'hard_cap';
}

export interface ProviderQuotaStore {
  /** Atomically increment the counter for the given window and return the new total. */
  increment(window: string, by: number): Promise<number>;
  /** Read the current counter without incrementing. */
  read(window: string): Promise<number>;
  readonly backend: 'redis' | 'memory';
}

export class InMemoryQuotaStore implements ProviderQuotaStore {
  readonly backend = 'memory' as const;
  readonly #counts = new Map<string, number>();

  async increment(window: string, by: number): Promise<number> {
    const next = Math.max(0, (this.#counts.get(window) ?? 0) + by);
    this.#counts.set(window, next);
    return next;
  }

  async read(window: string): Promise<number> {
    return this.#counts.get(window) ?? 0;
  }

  reset(): void {
    this.#counts.clear();
  }
}

export interface RedisQuotaClient {
  get(key: string): Promise<string | null>;
  incrBy(key: string, by: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
}

export interface RedisQuotaStoreOptions {
  readonly client: RedisQuotaClient;
  readonly namespace?: string;
  /** Window expiry in seconds; defaults to 36h so the count survives clock skew. */
  readonly windowTtlSeconds?: number;
}

/**
 * Redis-backed daily counter. Uses INCRBY + EXPIRE to atomically increment
 * the calls counter for the current UTC day. The EXPIRE call is idempotent
 * after the first write; we set a long TTL (36h) so a late refund the day
 * after still has the right key.
 */
export class RedisQuotaStore implements ProviderQuotaStore {
  readonly backend = 'redis' as const;
  readonly #client: RedisQuotaClient;
  readonly #namespace: string;
  readonly #windowTtlSeconds: number;

  constructor(options: RedisQuotaStoreOptions) {
    this.#client = options.client;
    this.#namespace = options.namespace ?? 'gamewire';
    this.#windowTtlSeconds = options.windowTtlSeconds ?? 36 * 60 * 60;
  }

  async increment(window: string, by: number): Promise<number> {
    const key = this.#key(window);
    const total = await this.#client.incrBy(key, by);
    if (by > 0) {
      // Ensure the counter expires so a missed daily reset doesn't pin us
      // at the cap forever. We only set the TTL on positive increments to
      // avoid pushing the expiry on refunds.
      await this.#client.expire(key, this.#windowTtlSeconds);
    }
    return Math.max(0, total);
  }

  async read(window: string): Promise<number> {
    const raw = await this.#client.get(this.#key(window));
    if (!raw) {
      return 0;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  #key(window: string): string {
    return `${this.#namespace}:quota:${window}`;
  }
}

export interface ProviderQuotaTrackerOptions {
  readonly provider: string;
  readonly store?: ProviderQuotaStore;
  readonly hardCap?: number;
  readonly softCap?: number;
  readonly clock?: () => Date;
}

/**
 * Daily provider call counter. Use {@link reserve} before issuing a provider
 * call: if the call would exceed the hard cap it is denied; if it pushes past
 * the soft cap the snapshot reports `cachedOnlyMode=true` so callers can emit
 * the PROVIDER_OUTAGE fallback.
 */
export class ProviderQuotaTracker {
  readonly #provider: string;
  readonly #store: ProviderQuotaStore;
  readonly #hardCap: number;
  readonly #softCap: number;
  readonly #clock: () => Date;

  constructor(options: ProviderQuotaTrackerOptions) {
    if (options.softCap !== undefined && options.hardCap !== undefined) {
      if (options.softCap > options.hardCap) {
        throw new Error('Provider quota soft cap must not exceed hard cap');
      }
    }
    this.#provider = options.provider;
    this.#store = options.store ?? new InMemoryQuotaStore();
    this.#hardCap = options.hardCap ?? DEFAULT_PROVIDER_HARD_CAP;
    this.#softCap = options.softCap ?? DEFAULT_PROVIDER_SOFT_CAP;
    this.#clock = options.clock ?? (() => new Date());
  }

  windowFor(now: Date = this.#clock()): string {
    // UTC calendar date — matches API-Football plan reset cadence.
    const iso = now.toISOString();
    return iso.slice(0, 'YYYY-MM-DD'.length);
  }

  async snapshot(now: Date = this.#clock()): Promise<ProviderQuotaSnapshot> {
    const window = this.windowFor(now);
    const calls = await this.#store.read(window);
    return this.#snapshotFromCount(window, calls);
  }

  /**
   * Atomic reservation: increment-and-evaluate. If `cost` would breach the
   * hard cap the reservation is refunded (decremented back) and `allowed`
   * is false.
   */
  async reserve(cost = 1, now: Date = this.#clock()): Promise<ProviderQuotaCheckResult> {
    if (cost <= 0) {
      throw new Error('Provider quota cost must be positive');
    }
    const window = this.windowFor(now);
    const total = await this.#store.increment(window, cost);
    if (total > this.#hardCap) {
      // Best-effort refund so the meter does not drift permanently when a
      // reservation is denied.
      await this.#store.increment(window, -cost);
      const refunded = Math.max(0, total - cost);
      return {
        allowed: false,
        reason: 'hard_cap',
        snapshot: this.#snapshotFromCount(window, refunded),
      };
    }

    const snapshot = this.#snapshotFromCount(window, total);
    if (snapshot.posture === 'soft_cap_reached') {
      return {
        allowed: true,
        reason: 'soft_cap',
        snapshot,
      };
    }
    return {
      allowed: true,
      snapshot,
    };
  }

  /**
   * Refund a previously-reserved cost. Used when a reservation passed but the
   * underlying provider call was a no-op (replay mode, missing key, etc.).
   * The counter must reflect calls that actually left the worker.
   */
  async refund(cost = 1, now: Date = this.#clock()): Promise<ProviderQuotaSnapshot> {
    if (cost <= 0) {
      throw new Error('Provider quota refund cost must be positive');
    }
    const window = this.windowFor(now);
    const total = await this.#store.increment(window, -cost);
    return this.#snapshotFromCount(window, total);
  }

  get hardCap(): number {
    return this.#hardCap;
  }

  get softCap(): number {
    return this.#softCap;
  }

  get provider(): string {
    return this.#provider;
  }

  #snapshotFromCount(window: string, calls: number): ProviderQuotaSnapshot {
    const posture: ProviderQuotaPosture =
      calls >= this.#hardCap
        ? 'hard_cap_reached'
        : calls >= this.#softCap
          ? 'soft_cap_reached'
          : 'normal';
    return {
      provider: this.#provider,
      window,
      calls,
      hardCap: this.#hardCap,
      softCap: this.#softCap,
      posture,
      cachedOnlyMode: posture !== 'normal',
    };
  }
}
