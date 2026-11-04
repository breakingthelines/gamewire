/**
 * Provider call quota tracker for the API-Football daily budget.
 *
 * Contract:
 * - hard cap (`GAMEWIRE_PROVIDER_HARD_CAP`, default 70,000): a reservation that
 *   would pass it is denied.
 * - soft cap (`GAMEWIRE_PROVIDER_SOFT_CAP`, default 60,000): at or above it the
 *   snapshot reports cached-only. Workflows act on that through
 *   `handleQuotaPosture`; the live loop keeps calling until the hard cap.
 * - background daily cap (`GAMEWIRE_PROVIDER_BACKGROUND_DAILY_CAP`): a
 *   `background` reservation at or above it is denied inside {@link reserve},
 *   so backfills and enrichment can never spend the headroom live needs.
 *   Unset, it defaults to min(110,000, soft cap).
 * - quota source (`GAMEWIRE_PROVIDER_QUOTA_SOURCE`): `local` counts only this
 *   worker's calls. `provider-header` gates on max(local, provider-reported
 *   usage), where provider usage is `x-ratelimit-requests-limit -
 *   x-ratelimit-requests-remaining` from the latest response. That counts
 *   every spender on the key (staging, identity tools, manual calls).
 * - reset: UTC midnight; the window is the ISO date string.
 *
 * Backed by Redis INCR + EXPIRE when a Redis store is injected; the default is
 * an in-memory store.
 */

import type { ProviderPriority } from './minute-limiter.js';

export const DEFAULT_PROVIDER_HARD_CAP = 70_000;
export const DEFAULT_PROVIDER_SOFT_CAP = 60_000;
export const DEFAULT_PROVIDER_PLAN_CEILING = 75_000;
/** Background ceiling when the env sets one explicitly but the soft cap is higher. */
export const DEFAULT_PROVIDER_BACKGROUND_DAILY_CAP = 110_000;

export type ProviderQuotaSource = 'local' | 'provider-header';

/**
 * Background daily cap used when none is configured: 110k, but never above the
 * soft cap. Under today's 60k soft cap that is 60k, the point where workflows
 * already switch to cached-only.
 */
export const defaultBackgroundDailyCap = (softCap: number, hardCap: number = softCap): number =>
  Math.min(DEFAULT_PROVIDER_BACKGROUND_DAILY_CAP, softCap, hardCap);

export type ProviderQuotaPosture = 'normal' | 'soft_cap_reached' | 'hard_cap_reached';

export interface ProviderQuotaSnapshot {
  readonly provider: string;
  readonly window: string;
  /**
   * Calls the caps are evaluated against: the local count, or max(local,
   * provider-reported) when the quota source is `provider-header`.
   */
  readonly calls: number;
  readonly hardCap: number;
  readonly softCap: number;
  readonly posture: ProviderQuotaPosture;
  readonly cachedOnlyMode: boolean;
  /** Calls this worker counted itself in the window. */
  readonly localCalls?: number;
  /** Provider-reported usage for the window (limit - remaining), when observed. */
  readonly remoteCalls?: number;
  /** Provider-reported daily limit (`x-ratelimit-requests-limit`), when observed. */
  readonly remoteLimit?: number;
  readonly quotaSource?: ProviderQuotaSource;
  readonly backgroundDailyCap?: number;
  /** True once background reservations are refused for the rest of the window. */
  readonly backgroundCapReached?: boolean;
}

export interface ProviderQuotaCheckResult {
  readonly allowed: boolean;
  readonly snapshot: ProviderQuotaSnapshot;
  readonly reason?: 'soft_cap' | 'hard_cap' | 'background_cap';
}

/** Daily headers from one provider response. */
export interface ProviderDailyQuotaObservation {
  /** `x-ratelimit-requests-limit`. */
  readonly limit?: number;
  /** `x-ratelimit-requests-remaining`. */
  readonly remaining?: number;
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
  /** Background reservations are denied at or above this. Default min(110k, softCap). */
  readonly backgroundDailyCap?: number;
  /** Default `local`. */
  readonly quotaSource?: ProviderQuotaSource;
  readonly clock?: () => Date;
  /** Structured log sink for provider-quota observations. */
  readonly logger?: (entry: Record<string, unknown>) => void;
}

interface RemoteQuotaState {
  readonly window: string;
  readonly used: number;
  readonly limit: number;
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
  readonly #backgroundDailyCap: number;
  readonly #quotaSource: ProviderQuotaSource;
  readonly #clock: () => Date;
  readonly #log: (entry: Record<string, unknown>) => void;
  #remote: RemoteQuotaState | undefined;

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
    this.#backgroundDailyCap =
      options.backgroundDailyCap ?? defaultBackgroundDailyCap(this.#softCap, this.#hardCap);
    if (this.#backgroundDailyCap <= 0) {
      throw new Error('Provider background daily cap must be positive');
    }
    if (this.#backgroundDailyCap > this.#hardCap) {
      throw new Error('Provider background daily cap must not exceed hard cap');
    }
    this.#quotaSource = options.quotaSource ?? 'local';
    this.#clock = options.clock ?? (() => new Date());
    this.#log = options.logger ?? (() => undefined);
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
   * Record the provider's daily headers from one response. Usage is
   * `limit - remaining`, using the limit the provider reports rather than an
   * assumed plan size. A reading without both headers is ignored. Within a
   * window the highest reading wins, so a late, out-of-order response cannot
   * lower it; a drop of more than half is logged as a provider-side reset.
   */
  observeProviderDaily(
    observation: ProviderDailyQuotaObservation,
    now: Date = this.#clock()
  ): void {
    const { limit, remaining } = observation;
    if (
      limit === undefined ||
      remaining === undefined ||
      !Number.isFinite(limit) ||
      !Number.isFinite(remaining) ||
      limit <= 0 ||
      remaining < 0
    ) {
      return;
    }
    const window = this.windowFor(now);
    const used = Math.max(0, limit - remaining);
    const previous = this.#remote;
    if (previous && previous.window === window && used < previous.used) {
      if (used < previous.used / 2) {
        // The provider reset its counter while our UTC window stayed the
        // same: its day boundary is not 00:00 UTC. Logged so the soak can
        // pin the real reset time; the lower reading is adopted.
        this.#log({
          event: 'provider_quota_remote_reset',
          provider: this.#provider,
          window,
          previousUsed: previous.used,
          used,
          limit,
          at: now.toISOString(),
        });
        this.#remote = { window, used, limit };
      }
      return;
    }
    this.#remote = { window, used, limit };
  }

  /**
   * Atomic reservation: increment-and-evaluate. If `cost` would breach the
   * hard cap the reservation is refunded (decremented back) and `allowed`
   * is false.
   */
  async reserve(
    cost = 1,
    now: Date = this.#clock(),
    priority?: ProviderPriority
  ): Promise<ProviderQuotaCheckResult> {
    if (cost <= 0) {
      throw new Error('Provider quota cost must be positive');
    }
    const window = this.windowFor(now);
    const localTotal = await this.#store.increment(window, cost);
    const total = this.#effectiveCalls(window, localTotal);
    if (priority === 'background' && total > this.#backgroundDailyCap) {
      // Background stops at its own ceiling so it can never spend the
      // headroom between it and the hard cap that live scores depend on.
      await this.#store.increment(window, -cost);
      return {
        allowed: false,
        reason: 'background_cap',
        snapshot: this.#snapshotFromCount(window, Math.max(0, localTotal - cost)),
      };
    }
    if (total > this.#hardCap) {
      // Best-effort refund so the meter does not drift permanently when a
      // reservation is denied.
      await this.#store.increment(window, -cost);
      const refunded = Math.max(0, localTotal - cost);
      return {
        allowed: false,
        reason: 'hard_cap',
        snapshot: this.#snapshotFromCount(window, refunded),
      };
    }

    const snapshot = this.#snapshotFromCount(window, localTotal);
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

  get backgroundDailyCap(): number {
    return this.#backgroundDailyCap;
  }

  get quotaSource(): ProviderQuotaSource {
    return this.#quotaSource;
  }

  get provider(): string {
    return this.#provider;
  }

  #remoteFor(window: string): RemoteQuotaState | undefined {
    const remote = this.#remote;
    return remote && remote.window === window ? remote : undefined;
  }

  #effectiveCalls(window: string, localCalls: number): number {
    if (this.#quotaSource !== 'provider-header') {
      return localCalls;
    }
    return Math.max(localCalls, this.#remoteFor(window)?.used ?? 0);
  }

  #snapshotFromCount(window: string, localCalls: number): ProviderQuotaSnapshot {
    const calls = this.#effectiveCalls(window, localCalls);
    const remote = this.#remoteFor(window);
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
      localCalls,
      remoteCalls: remote?.used,
      remoteLimit: remote?.limit,
      quotaSource: this.#quotaSource,
      backgroundDailyCap: this.#backgroundDailyCap,
      backgroundCapReached: calls >= this.#backgroundDailyCap,
    };
  }
}
