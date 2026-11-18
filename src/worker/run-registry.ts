/**
 * Run registry for `/workflows/*` and `/runs/*` workflow runs.
 *
 * A workflow run outlives the HTTP request that started it. Kernel starts a
 * run, then polls its status, so a long run no longer depends on one
 * connection staying open. The registry gives each run:
 *
 * - An id and a record (`{ns}:run:rec:{runId}`, 7 days) with status,
 *   heartbeat, progress and the capped wire result.
 * - An idempotency key (`{ns}:run:idem:{key}`). A Temporal retry sends the
 *   same key and attaches to the run it already started instead of starting a
 *   second one. A key whose run failed, was interrupted or was lost starts a
 *   fresh run, which resumes from the workflow's own cursors.
 * - A scope lock (`{ns}:run:lock:{scope}`): one run per workflow scope (for
 *   example one provider-enrichment run per dataset). The lock is a lease
 *   (SET NX PX, 120 s) renewed every 15 s by a compare-and-renew script. A
 *   second request with the same input attaches to the running run; one with
 *   different input is told the scope is busy.
 * - Fencing: a run whose lease renewal finds another owner (or none) is
 *   aborted, so it stops at the next checkpoint instead of writing over the
 *   run that took its place.
 * - A maximum runtime per workflow and cooperative cancellation, both through
 *   the AbortSignal the workflow receives in `deps.signal`.
 *
 * Every Redis command here is short and non-blocking (GET, SET, SET NX PX,
 * EVAL of two tiny scripts), because the store shares the one `Bun.redis`
 * connection with the minute limiters. See the rule at `sharedRedis` in
 * server.ts and no-direct-stream-commands.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { WorkflowLogEntry, WorkflowLogger } from '../workflows/index.js';

export type RunWorkflowName = WorkflowLogEntry['workflow'];

/** Stored status. `lost` is never stored: it is a running record whose lease went stale. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ReportedRunStatus = RunStatus | 'lost';

/** Why a run was asked to stop early. */
export type RunStopReason = 'cancelled' | 'max-runtime' | 'interrupted' | 'lease-lost';

export interface RunRecord {
  readonly runId: string;
  readonly workflow: RunWorkflowName;
  readonly scopeKey: string;
  readonly inputHash: string;
  readonly idempotencyKey?: string;
  readonly pod: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly deadlineAt: string;
  readonly finishedAt?: string;
  /** Workflow log events seen so far. */
  readonly events: number;
  readonly lastEvent?: string;
  readonly lastEventStatus?: string;
  readonly lastEventAt?: string;
  readonly stopRequested?: RunStopReason;
  readonly result?: Record<string, unknown>;
  /** The result was over the size cap; only its top-level scalar fields were kept. */
  readonly resultTruncated?: boolean;
  readonly reason?: string;
}

export interface RunView extends Omit<RunRecord, 'status'> {
  readonly status: ReportedRunStatus;
}

/** Minimal key-value contract the registry needs. All operations are non-blocking. */
export interface RunStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** SET NX PX: true when the key was absent and is now set. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Extend the key's TTL only while it still holds `owner`. */
  renewIfOwner(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Delete the key only while it still holds `owner`. */
  deleteIfOwner(key: string, owner: string): Promise<boolean>;
}

/** Anything that can send a raw Redis command, such as `Bun.redis`. */
export interface RunStoreCommandSender {
  send(command: string, args: string[]): Promise<unknown>;
}

export const RENEW_IF_OWNER_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0";
export const DELETE_IF_OWNER_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/** Adapt a raw command sender (`Bun.redis`) to {@link RunStore}. Short commands only. */
export const createRedisRunStore = (sender: RunStoreCommandSender): RunStore => ({
  async get(key) {
    const raw = await sender.send('GET', [key]);
    return raw === null || raw === undefined ? null : String(raw);
  },
  async set(key, value, ttlMs) {
    await sender.send('SET', [key, value, 'PX', String(Math.max(1, Math.ceil(ttlMs)))]);
  },
  async setIfAbsent(key, value, ttlMs) {
    const reply = await sender.send('SET', [
      key,
      value,
      'NX',
      'PX',
      String(Math.max(1, Math.ceil(ttlMs))),
    ]);
    return reply !== null && reply !== undefined;
  },
  async renewIfOwner(key, owner, ttlMs) {
    const reply = await sender.send('EVAL', [
      RENEW_IF_OWNER_SCRIPT,
      '1',
      key,
      owner,
      String(Math.max(1, Math.ceil(ttlMs))),
    ]);
    return Number(reply) === 1;
  },
  async deleteIfOwner(key, owner) {
    const reply = await sender.send('EVAL', [DELETE_IF_OWNER_SCRIPT, '1', key, owner]);
    return Number(reply) === 1;
  },
});

/** Process-memory {@link RunStore} for tests and runs without Redis. */
export class InMemoryRunStore implements RunStore {
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();
  readonly #clock: () => number;

  constructor(options: { readonly clock?: () => number } = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  #live(key: string): string | null {
    const entry = this.#entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.#live(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: this.#clock() + ttlMs });
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.#live(key) !== null) {
      return false;
    }
    this.#entries.set(key, { value, expiresAt: this.#clock() + ttlMs });
    return true;
  }

  async renewIfOwner(key: string, owner: string, ttlMs: number): Promise<boolean> {
    if (this.#live(key) !== owner) {
      return false;
    }
    this.#entries.set(key, { value: owner, expiresAt: this.#clock() + ttlMs });
    return true;
  }

  async deleteIfOwner(key: string, owner: string): Promise<boolean> {
    if (this.#live(key) !== owner) {
      return false;
    }
    this.#entries.delete(key);
    return true;
  }
}

/** Lock lease. A run whose pod died is reported `lost` once this passes without a renewal. */
export const RUN_LEASE_MS = 120_000;
/** How often a live run renews its lease and writes its heartbeat. */
export const RUN_RENEW_INTERVAL_MS = 15_000;
/** How long run records and idempotency keys are kept. */
export const RUN_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Results larger than this are stored as their top-level scalar fields only. */
export const RUN_MAX_RESULT_BYTES = 1_000_000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Longest a run may go before it is asked to stop. Kernel's activity allows
 * 12 h, so every value sits under that; the workflow stops at its next
 * checkpoint and returns what it has as an `incomplete` result.
 */
export const RUN_MAX_RUNTIME_MS: Readonly<Record<RunWorkflowName, number>> = {
  'daily-anchor': 3 * HOUR_MS,
  'hourly-matchday': 1 * HOUR_MS,
  'webhook-completed': HOUR_MS / 2,
  'season-backfill': 10 * HOUR_MS,
  'sweep-missing-payloads': 6 * HOUR_MS,
  'squad-sweep': 4 * HOUR_MS,
  'statsbomb-backfill': 6 * HOUR_MS,
  'identity-gap-scan': 1 * HOUR_MS,
  'competition-payload-backfill': 6 * HOUR_MS,
  'provider-fixture-results': 6 * HOUR_MS,
  'provider-enrichment': 10 * HOUR_MS,
};

/** Idempotency keys kernel sends are hex digests; allow a safe, bounded alphabet. */
export const isValidIdempotencyKey = (key: string): boolean => /^[A-Za-z0-9._:-]{8,200}$/.test(key);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** Stable hash of a workflow's parsed input, so equal requests attach to one run. */
export const hashRunInput = (workflow: RunWorkflowName, input: unknown): string =>
  createHash('sha256')
    .update(`${workflow}\n${canonicalJson(input)}`)
    .digest('hex');

/**
 * Keep a wire result under the size cap. An oversized result keeps only its
 * top-level scalar fields (status, counters, reason), which is what kernel
 * records; the full detail is in the run's logs.
 */
export const capRunResult = (
  result: Record<string, unknown>,
  maxBytes: number
): { result: Record<string, unknown>; truncated: boolean } => {
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') <= maxBytes) {
    return { result, truncated: false };
  }
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === null || typeof value !== 'object') {
      scalars[key] = value;
    }
  }
  return { result: scalars, truncated: true };
};

export interface RunObserver {
  /** Each workflow log event, in order. */
  readonly onEvent?: (entry: WorkflowLogEntry) => void;
  /** Called once with the final record when the run settles. */
  readonly onDone?: (record: RunRecord) => void;
}

export interface StartRunRequest {
  readonly workflow: RunWorkflowName;
  /** One run per scope at a time, e.g. `provider-enrichment:team-coaches`. */
  readonly scopeKey: string;
  /** The parsed input; equal inputs attach to the same running run. */
  readonly input: unknown;
  readonly idempotencyKey?: string;
  /** Defaults to {@link RUN_MAX_RUNTIME_MS} for the workflow. */
  readonly maxRuntimeMs?: number;
  /** Logger every event is forwarded to (the pod's structured logs). */
  readonly baseLogger?: WorkflowLogger;
  /** Run the workflow and return its wire result. */
  readonly run: (ctx: {
    readonly logger: WorkflowLogger;
    readonly signal: AbortSignal;
  }) => Promise<Record<string, unknown>>;
  /** Subscribe from the first event (the streaming endpoint). */
  readonly observer?: RunObserver;
}

export type StartRunOutcome =
  | { readonly kind: 'started'; readonly run: RunView }
  | {
      readonly kind: 'attached';
      readonly run: RunView;
      /** The request's observer was attached (the run is executing in this process). */
      readonly observed: boolean;
    }
  | {
      readonly kind: 'busy';
      readonly holderRunId: string;
      readonly holder?: RunView;
      /** True when the holder is on its way out (stopped or stale), so a retry soon should get the lock. */
      readonly retryable: boolean;
    };

interface LocalRun {
  record: RunRecord;
  readonly controller: AbortController;
  readonly observers: Set<RunObserver>;
  renewTimer?: ReturnType<typeof setInterval>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  renewing: boolean;
  settled: boolean;
  /** Resolves once the run has settled and its final record is written. */
  done?: Promise<void>;
}

export interface RunRegistryOptions {
  readonly store: RunStore;
  /** Redis key prefix, the worker's `GAMEWIRE_REDIS_NAMESPACE`. */
  readonly namespace?: string;
  /** This pod's name, recorded on each run. */
  readonly pod?: string;
  readonly clock?: () => number;
  readonly leaseMs?: number;
  readonly renewIntervalMs?: number;
  readonly recordTtlMs?: number;
  readonly maxResultBytes?: number;
  readonly newRunId?: () => string;
  /** Start the renew and deadline timers. Tests turn this off and call {@link RunRegistry.renewAll}. */
  readonly timers?: boolean;
  /** Lifecycle log line sink. */
  readonly log?: (message: string) => void;
}

export class RunRegistry {
  readonly #store: RunStore;
  readonly #namespace: string;
  readonly #pod: string;
  readonly #clock: () => number;
  readonly #leaseMs: number;
  readonly #renewIntervalMs: number;
  readonly #recordTtlMs: number;
  readonly #maxResultBytes: number;
  readonly #newRunId: () => string;
  readonly #timers: boolean;
  readonly #log: (message: string) => void;
  readonly #local = new Map<string, LocalRun>();

  constructor(options: RunRegistryOptions) {
    this.#store = options.store;
    this.#namespace = options.namespace ?? 'gamewire';
    this.#pod = options.pod ?? 'local';
    this.#clock = options.clock ?? Date.now;
    this.#leaseMs = options.leaseMs ?? RUN_LEASE_MS;
    this.#renewIntervalMs = options.renewIntervalMs ?? RUN_RENEW_INTERVAL_MS;
    this.#recordTtlMs = options.recordTtlMs ?? RUN_RECORD_TTL_MS;
    this.#maxResultBytes = options.maxResultBytes ?? RUN_MAX_RESULT_BYTES;
    this.#newRunId = options.newRunId ?? randomUUID;
    this.#timers = options.timers ?? true;
    this.#log = options.log ?? (() => undefined);
  }

  #recordKey(runId: string): string {
    return `${this.#namespace}:run:rec:${runId}`;
  }
  #idemKey(key: string): string {
    return `${this.#namespace}:run:idem:${key}`;
  }
  #lockKey(scopeKey: string): string {
    return `${this.#namespace}:run:lock:${scopeKey}`;
  }
  #cancelKey(runId: string): string {
    return `${this.#namespace}:run:cancel:${runId}`;
  }
  #iso(ms = this.#clock()): string {
    return new Date(ms).toISOString();
  }

  /** Runs this process is executing. */
  localRunIds(): string[] {
    return [...this.#local.keys()];
  }

  #view(record: RunRecord): RunView {
    if (
      record.status === 'running' &&
      !this.#local.has(record.runId) &&
      this.#clock() - Date.parse(record.heartbeatAt) > this.#leaseMs
    ) {
      return { ...record, status: 'lost' };
    }
    return record;
  }

  async #readRecord(runId: string): Promise<RunRecord | undefined> {
    const local = this.#local.get(runId);
    if (local) {
      return local.record;
    }
    const raw = await this.#store.get(this.#recordKey(runId));
    if (raw === null) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as RunRecord;
    } catch {
      return undefined;
    }
  }

  async #writeRecord(record: RunRecord): Promise<void> {
    await this.#store.set(this.#recordKey(record.runId), JSON.stringify(record), this.#recordTtlMs);
  }

  /** The run's current view, or undefined when it is unknown (or expired). */
  async status(runId: string): Promise<RunView | undefined> {
    const record = await this.#readRecord(runId);
    return record ? this.#view(record) : undefined;
  }

  /**
   * Start a run, or attach to the one this request already started (same
   * idempotency key) or that is already doing the same work (same scope and
   * input).
   */
  async start(request: StartRunRequest): Promise<StartRunOutcome> {
    const inputHash = hashRunInput(request.workflow, request.input);
    const idemKey = request.idempotencyKey ? this.#idemKey(request.idempotencyKey) : undefined;

    if (idemKey) {
      const previousId = await this.#store.get(idemKey);
      if (previousId !== null) {
        const previous = await this.status(previousId);
        if (
          previous &&
          (previous.status === 'running' ||
            previous.status === 'completed' ||
            previous.status === 'cancelled')
        ) {
          const observed = this.#attachObserver(previous.runId, request.observer);
          return { kind: 'attached', run: previous, observed };
        }
        // Failed, interrupted, lost or expired: start again; the workflow
        // resumes from its own cursors.
      }
    }

    const runId = this.#newRunId();
    const lockKey = this.#lockKey(request.scopeKey);
    let acquired = await this.#store.setIfAbsent(lockKey, runId, this.#leaseMs);
    if (!acquired) {
      const holderId = await this.#store.get(lockKey);
      if (holderId === null) {
        // The lease expired between the two calls.
        acquired = await this.#store.setIfAbsent(lockKey, runId, this.#leaseMs);
      } else {
        const holder = await this.status(holderId);
        if (holder && holder.status === 'running' && holder.inputHash === inputHash) {
          if (idemKey) {
            await this.#store.set(idemKey, holder.runId, this.#recordTtlMs);
          }
          const observed = this.#attachObserver(holder.runId, request.observer);
          return { kind: 'attached', run: holder, observed };
        }
        return {
          kind: 'busy',
          holderRunId: holderId,
          holder,
          retryable: !holder || holder.status !== 'running' || holder.stopRequested !== undefined,
        };
      }
      if (!acquired) {
        const holderId2 = (await this.#store.get(lockKey)) ?? 'unknown';
        return { kind: 'busy', holderRunId: holderId2, retryable: true };
      }
    }

    const now = this.#clock();
    const maxRuntimeMs = request.maxRuntimeMs ?? RUN_MAX_RUNTIME_MS[request.workflow];
    const record: RunRecord = {
      runId,
      workflow: request.workflow,
      scopeKey: request.scopeKey,
      inputHash,
      idempotencyKey: request.idempotencyKey,
      pod: this.#pod,
      status: 'running',
      startedAt: this.#iso(now),
      heartbeatAt: this.#iso(now),
      deadlineAt: this.#iso(now + maxRuntimeMs),
      events: 0,
    };
    const local: LocalRun = {
      record,
      controller: new AbortController(),
      observers: new Set(request.observer ? [request.observer] : []),
      renewing: false,
      settled: false,
    };
    this.#local.set(runId, local);
    try {
      await this.#writeRecord(record);
      if (idemKey) {
        await this.#store.set(idemKey, runId, this.#recordTtlMs);
      }
    } catch (error) {
      this.#local.delete(runId);
      await this.#store.deleteIfOwner(lockKey, runId).catch(() => false);
      throw error;
    }
    this.#log(
      `started run=${runId} workflow=${request.workflow} scope=${request.scopeKey} pod=${this.#pod}`
    );

    if (this.#timers) {
      local.renewTimer = setInterval(
        () => {
          void this.#renew(local);
        },
        this.#renewIntervalMs
      );
      local.renewTimer.unref?.();
      local.deadlineTimer = setTimeout(() => {
        this.#requestStop(local, 'max-runtime');
      }, maxRuntimeMs);
      local.deadlineTimer.unref?.();
    }

    const logger: WorkflowLogger = (entry) => {
      if (request.baseLogger) {
        try {
          request.baseLogger(entry);
        } catch {
          // A logger failure never breaks the workflow.
        }
      }
      local.record = {
        ...local.record,
        events: local.record.events + 1,
        lastEvent: entry.event,
        lastEventStatus: entry.status,
        lastEventAt: this.#iso(),
      };
      for (const observer of local.observers) {
        try {
          observer.onEvent?.(entry);
        } catch {
          // An observer failure never breaks the workflow.
        }
      }
    };

    local.done = Promise.resolve()
      .then(() => request.run({ logger, signal: local.controller.signal }))
      .then(
        (result) => this.#settle(local, 'completed', result),
        (error: unknown) =>
          this.#settle(
            local,
            'failed',
            undefined,
            error instanceof Error ? error.message : String(error)
          )
      );

    return { kind: 'started', run: local.record };
  }

  #attachObserver(runId: string, observer: RunObserver | undefined): boolean {
    const local = this.#local.get(runId);
    if (!local || local.settled || !observer) {
      return false;
    }
    local.observers.add(observer);
    return true;
  }

  /** Subscribe to a run this process executes. Returns false when it is not local. */
  observe(runId: string, observer: RunObserver): boolean {
    return this.#attachObserver(runId, observer);
  }

  #requestStop(local: LocalRun, reason: RunStopReason): void {
    if (local.settled) {
      return;
    }
    if (!local.record.stopRequested) {
      local.record = { ...local.record, stopRequested: reason };
      this.#log(`stop requested run=${local.record.runId} reason=${reason}`);
    }
    if (!local.controller.signal.aborted) {
      local.controller.abort(reason);
    }
  }

  async #renew(local: LocalRun): Promise<void> {
    if (local.settled || local.renewing) {
      return;
    }
    local.renewing = true;
    try {
      const { runId, scopeKey } = local.record;
      const owned = await this.#store.renewIfOwner(this.#lockKey(scopeKey), runId, this.#leaseMs);
      if (!owned) {
        // Fencing: another run owns the scope now (or nobody does). Stop at
        // the next checkpoint rather than write over its progress.
        this.#requestStop(local, 'lease-lost');
      }
      if ((await this.#store.get(this.#cancelKey(runId))) !== null) {
        this.#requestStop(local, 'cancelled');
      }
      if (local.settled) {
        return;
      }
      local.record = { ...local.record, heartbeatAt: this.#iso() };
      await this.#writeRecord(local.record);
    } catch (error) {
      this.#log(
        `renew failed run=${local.record.runId}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      local.renewing = false;
    }
  }

  /** Renew every local run once. The timers call this; tests call it directly. */
  async renewAll(): Promise<void> {
    await Promise.all([...this.#local.values()].map((local) => this.#renew(local)));
  }

  /** Ask a local run to stop for its maximum runtime. Tests use this instead of waiting. */
  expire(runId: string): boolean {
    const local = this.#local.get(runId);
    if (!local) {
      return false;
    }
    this.#requestStop(local, 'max-runtime');
    return true;
  }

  async #settle(
    local: LocalRun,
    outcome: 'completed' | 'failed',
    result: Record<string, unknown> | undefined,
    error?: string
  ): Promise<void> {
    if (local.settled) {
      return;
    }
    local.settled = true;
    if (local.renewTimer) {
      clearInterval(local.renewTimer);
    }
    if (local.deadlineTimer) {
      clearTimeout(local.deadlineTimer);
    }
    const stop = local.record.stopRequested;
    let status: RunStatus = outcome;
    let reason = error;
    if (stop === 'cancelled') {
      status = 'cancelled';
      reason = reason ?? 'cancelled';
    } else if (stop === 'interrupted' || stop === 'lease-lost') {
      status = 'interrupted';
      reason = reason ?? (stop === 'interrupted' ? 'pod shutting down' : 'lease lost');
    } else if (stop === 'max-runtime' && outcome === 'completed') {
      reason = 'max runtime reached';
    }
    const capped = result ? capRunResult(result, this.#maxResultBytes) : undefined;
    local.record = {
      ...local.record,
      status,
      heartbeatAt: this.#iso(),
      finishedAt: this.#iso(),
      result: capped?.result,
      resultTruncated: capped?.truncated || undefined,
      reason,
    };
    this.#log(
      `finished run=${local.record.runId} workflow=${local.record.workflow} status=${status}` +
        (reason ? ` reason=${reason}` : '')
    );
    try {
      await this.#writeRecord(local.record);
    } catch (writeError) {
      this.#log(
        `final record write failed run=${local.record.runId}: ${
          writeError instanceof Error ? writeError.message : String(writeError)
        }`
      );
    }
    try {
      await this.#store.deleteIfOwner(this.#lockKey(local.record.scopeKey), local.record.runId);
    } catch {
      // The lease expires on its own.
    }
    this.#local.delete(local.record.runId);
    for (const observer of local.observers) {
      try {
        observer.onDone?.(local.record);
      } catch {
        // An observer failure never breaks the registry.
      }
    }
  }

  /**
   * Ask a run to stop. A local run is aborted at once; a run on another pod
   * sees the cancel key at its next renewal. Returns undefined for an unknown run.
   */
  async cancel(runId: string): Promise<RunView | undefined> {
    const local = this.#local.get(runId);
    if (local) {
      this.#requestStop(local, 'cancelled');
      await this.#writeRecord(local.record).catch(() => undefined);
      return local.record;
    }
    const view = await this.status(runId);
    if (view && view.status === 'running') {
      await this.#store.set(this.#cancelKey(runId), '1', 24 * HOUR_MS);
    }
    return view;
  }

  /**
   * Wait until every local run has settled (final record written, lock
   * released), or until `timeoutMs` passes. Resolves true when all settled.
   */
  async waitForLocalRuns(timeoutMs: number): Promise<boolean> {
    const pending = [...this.#local.values()].map((local) => local.done ?? Promise.resolve());
    if (pending.length === 0) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const settled = await Promise.race([Promise.all(pending).then(() => true), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
    return settled;
  }

  /**
   * SIGTERM: mark every local run interrupted right away, so a poller retries
   * now instead of waiting for the lease to go stale, and ask each to stop.
   * The lock is released when the run settles, or expires with the lease.
   */
  async interruptAll(): Promise<void> {
    await Promise.all(
      [...this.#local.values()].map(async (local) => {
        this.#requestStop(local, 'interrupted');
        local.record = {
          ...local.record,
          status: 'interrupted',
          reason: 'pod shutting down',
          heartbeatAt: this.#iso(),
        };
        await this.#writeRecord(local.record).catch(() => undefined);
      })
    );
  }
}
