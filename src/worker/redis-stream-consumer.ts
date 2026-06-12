/**
 * Redis Streams consumer for PlatformFact envelopes.
 *
 * # Wire contract (LOAD-BEARING — must match game-service publisher)
 *
 * Streams are named `btl:facts:<fact_type>`, e.g.:
 *   - `btl:facts:game.rating.submitted`
 *   - `btl:facts:game.prediction.submitted`
 *
 * Each XADD entry has three fields:
 *   - `data`      — `proto.Marshal(PlatformFact)` raw bytes. Canonical payload.
 *   - `event_id`  — fact.Id (string). Carried out-of-band so consumers can
 *                   dedupe and count retries without parsing the proto.
 *   - `fact_type` — fact.Type (string). Used for routing / metrics labels.
 *
 * Game-service publishes with `MAXLEN ~ 10_000`. The bus is a fan-out
 * window, not a historical archive; backfills come from the Postgres
 * source-of-truth via game-service.
 *
 * # Delivery model
 *
 * One consumer group per logical handler: `gamewire-rating` consumes the
 * rating stream, `gamewire-prediction` (future) consumes predictions.
 * Each gamewire-worker process registers a unique consumer name
 * (`<hostname>:<pid>`) so multiple replicas can share a group with PEL
 * (Pending Entries List) round-robin.
 *
 * On startup we XGROUP CREATE MKSTREAM lazily, swallowing the BUSYGROUP
 * error that fires when the group already exists. The MKSTREAM flag
 * means the consumer can boot even before the publisher has emitted its
 * first event.
 *
 * # Failure model
 *
 * The handler returns a result; we ACK only on `applied`, `duplicate`,
 * `ignored`, and the two `dead_letter_*` outcomes (those have already
 * been recorded by the inner consumer — re-delivery would be pointless).
 *
 * Transient errors (handler throws, transport blip) leave the entry in
 * the PEL. The next XREADGROUP with `>` will not return it; a future
 * sweep / claim step (not implemented in this iteration) is responsible
 * for re-delivering pending messages.
 *
 * In-process we count attempts per `event_id`. After {@link MAX_RETRIES}
 * consecutive failures we XADD the entry to `btl:facts:dlq` and XACK the
 * original so it stops cycling. This bound is intentionally generous —
 * the inner RatingConsumer already runs its own backoff schedule, so the
 * outer bound is a safety net against pathological transport-level
 * failures rather than the primary retry surface.
 *
 * # Why this layer is thin
 *
 * Business logic lives in `rating-consumer.ts` (and, in time, a
 * `prediction-consumer.ts`). This module only:
 *   1. Pulls bytes off the stream.
 *   2. Decodes them into `PlatformFact`.
 *   3. Dispatches to the inner consumer.
 *   4. ACKs / DLQs based on the outcome.
 *
 * Keep it that way. New fact types should add an inner consumer + a
 * `subscribe()` call from server.ts, NOT new branches in this file.
 */

import { hostname } from 'node:os';

import { fromBinary } from '@bufbuild/protobuf';

import {
  type PlatformFact,
  PlatformFactSchema,
} from '@breakingthelines/protos/btl/context/v1/context_pb';

/** Stream-key prefix shared with the publisher in game-service. */
export const STREAM_NAME_PREFIX = 'btl:facts:';

/** Dead-letter stream key. Single stream for all fact types so an
 * operator only has one place to look. */
export const DLQ_STREAM_NAME = 'btl:facts:dlq';

/**
 * Hard cap on per-event_id attempts before we DLQ + ACK. Tuned high
 * because the inner RatingConsumer already runs its own bounded backoff
 * schedule (DEFAULT_RATING_BACKOFF_MS), so a single delivery from Redis
 * may absorb many internal retries. This outer bound exists for cases
 * where the inner consumer itself throws or the decode step fails.
 */
export const MAX_RETRIES = 5;

/**
 * Default XREADGROUP block timeout in milliseconds. Long enough to
 * avoid hot-looping, short enough that SIGTERM is observed quickly.
 */
export const DEFAULT_BLOCK_MS = 5_000;

/** Default XREADGROUP COUNT — how many entries to receive per call. */
export const DEFAULT_BATCH_COUNT = 16;

/**
 * Compute a fact-type stream key. Exported so tests and prod wiring
 * derive the same names from the same constant.
 */
export const streamNameFor = (factType: string): string => `${STREAM_NAME_PREFIX}${factType}`;

/**
 * Compute the default per-process consumer name. Multiple gamewire-worker
 * replicas booted on different hosts must NOT share a consumer name; the
 * combination of hostname and pid is sufficient for our deployment shape
 * (one process per container, container-id used as hostname).
 */
export const defaultConsumerName = (): string => `${hostname()}:${process.pid}`;

/**
 * A single XREADGROUP entry as we surface it to the dispatcher. Mirrors
 * the shape returned by go-redis / Bun.send, but exposes only what we
 * need so adapters can be swapped without leaking client types.
 */
export interface StreamEntry {
  readonly id: string;
  readonly fields: Record<string, Uint8Array>;
}

/**
 * Minimal Redis surface the consumer relies on. Implemented in production
 * by a tiny Bun.redis adapter (see {@link createBunRedisStreamClient})
 * and in tests by an in-memory stub.
 *
 * The contract is intentionally close to the raw Redis command shape so
 * adapters can be 5-line wrappers around the underlying client's `send`
 * method. We do NOT depend on ioredis or node-redis here.
 */
export interface RedisStreamClient {
  /**
   * Create the consumer group if it doesn't already exist. Implementations
   * MUST swallow the BUSYGROUP error so callers can call this
   * unconditionally on boot.
   */
  xGroupCreateMkStream(stream: string, group: string, startId: string): Promise<void>;

  /**
   * Read new entries for a consumer group. Returns the entries grouped
   * by stream name. Block for up to `blockMs` waiting for entries.
   */
  xReadGroup(args: {
    readonly group: string;
    readonly consumer: string;
    readonly blockMs: number;
    readonly count: number;
    readonly streams: readonly { stream: string; id: string }[];
  }): Promise<readonly { stream: string; entries: readonly StreamEntry[] }[]>;

  /** Acknowledge an entry, removing it from the PEL. */
  xAck(stream: string, group: string, id: string): Promise<number>;

  /**
   * Add an entry to a stream. Used for the DLQ; the gamewire side does
   * not publish PlatformFact streams.
   */
  xAdd(stream: string, fields: Record<string, string | Uint8Array>): Promise<string>;
}

/**
 * Per-event_id attempt counter. Used to drive DLQ-on-exhaustion. We
 * keep this pluggable so production can swap in a Redis-backed counter
 * if we ever want retries to survive worker restarts.
 */
export interface AttemptCounter {
  increment(eventId: string): number;
  reset(eventId: string): void;
  size(): number;
}

/**
 * In-process attempt counter. Bounded by an LRU-ish cap so a sustained
 * failure storm cannot OOM the worker. The bound is generous —
 * 10_000 distinct in-flight event_ids would already indicate a much
 * larger systemic problem.
 */
export class InMemoryAttemptCounter implements AttemptCounter {
  readonly #max: number;
  readonly #counts = new Map<string, number>();

  constructor(max = 10_000) {
    this.#max = Math.max(1, max);
  }

  increment(eventId: string): number {
    const next = (this.#counts.get(eventId) ?? 0) + 1;
    this.#counts.delete(eventId);
    this.#counts.set(eventId, next);
    if (this.#counts.size > this.#max) {
      const oldest = this.#counts.keys().next().value;
      if (oldest !== undefined) {
        this.#counts.delete(oldest);
      }
    }
    return next;
  }

  reset(eventId: string): void {
    this.#counts.delete(eventId);
  }

  size(): number {
    return this.#counts.size;
  }
}

/**
 * Counters mirroring the contract documented in the redis-streams-bus
 * handoff: `bus_facts_consumed_total`, `bus_facts_handler_duration_seconds`,
 * `bus_facts_dlq_total`. The shape stays JSON-friendly so the existing
 * /metrics surface can splice it in without an extra adapter.
 */
export type ConsumeOutcome = 'ok' | 'error' | 'malformed' | 'dlq';

export interface RedisStreamConsumerMetricsSnapshot {
  readonly received: Record<string, number>;
  readonly outcomes: Record<string, Record<ConsumeOutcome, number>>;
  readonly handlerDurationMs: Record<string, number>;
  readonly dlq: Record<string, number>;
}

export class RedisStreamConsumerMetrics {
  readonly #received = new Map<string, number>();
  readonly #outcomes = new Map<string, Record<ConsumeOutcome, number>>();
  readonly #handlerDurationMs = new Map<string, number>();
  readonly #dlq = new Map<string, number>();

  recordReceived(factType: string): void {
    this.#bump(this.#received, factType);
  }

  recordOutcome(factType: string, outcome: ConsumeOutcome): void {
    let row = this.#outcomes.get(factType);
    if (!row) {
      row = { ok: 0, error: 0, malformed: 0, dlq: 0 };
      this.#outcomes.set(factType, row);
    }
    row[outcome] += 1;
  }

  recordHandlerDuration(factType: string, durationMs: number): void {
    this.#handlerDurationMs.set(
      factType,
      (this.#handlerDurationMs.get(factType) ?? 0) + durationMs
    );
  }

  recordDeadLetter(factType: string): void {
    this.#bump(this.#dlq, factType);
  }

  snapshot(): RedisStreamConsumerMetricsSnapshot {
    return {
      received: mapToObject(this.#received),
      outcomes: outcomesToObject(this.#outcomes),
      handlerDurationMs: mapToObject(this.#handlerDurationMs),
      dlq: mapToObject(this.#dlq),
    };
  }

  reset(): void {
    this.#received.clear();
    this.#outcomes.clear();
    this.#handlerDurationMs.clear();
    this.#dlq.clear();
  }

  #bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

/**
 * Per-event handler dispatched by the consumer loop.
 *
 * Returning `false` from a handler signals a TRANSIENT failure: the
 * outer loop will count it against the per-event_id attempt cap and
 * leave the entry pending. Returning `true` or any object signals
 * terminal success (ACK).
 *
 * If a handler THROWS, it is treated the same as returning `false`:
 * counted as a transient error, NOT ACKed. After MAX_RETRIES failures
 * the entry is DLQed and ACKed.
 */
export type StreamFactHandler = (
  fact: PlatformFact,
  context: StreamHandlerContext
) => Promise<boolean | void>;

export interface StreamHandlerContext {
  readonly eventId: string;
  readonly factType: string;
  readonly streamId: string;
  readonly attempt: number;
}

export interface StreamSubscription {
  readonly factType: string;
  readonly group: string;
  readonly handler: StreamFactHandler;
}

export interface RedisStreamConsumerLogEntry {
  readonly event: string;
  readonly factType?: string;
  readonly group?: string;
  readonly stream?: string;
  readonly streamId?: string;
  readonly eventId?: string;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly message?: string;
}

export type RedisStreamConsumerLogger = (entry: RedisStreamConsumerLogEntry) => void;

const defaultLogger: RedisStreamConsumerLogger = (entry) => {
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
};

export interface RedisStreamConsumerOptions {
  readonly client: RedisStreamClient;
  readonly consumerName?: string;
  readonly metrics?: RedisStreamConsumerMetrics;
  readonly attempts?: AttemptCounter;
  readonly logger?: RedisStreamConsumerLogger;
  /** Override the XREADGROUP block timeout (ms). Default 5000. */
  readonly blockMs?: number;
  /** Override the XREADGROUP batch size. Default 16. */
  readonly batchCount?: number;
  /** Override the per-event_id retry cap before DLQ. Default 5. */
  readonly maxRetries?: number;
  /** Override the now() boundary for handler-duration metrics in tests. */
  readonly now?: () => number;
}

/**
 * Long-running XREADGROUP loop. One per worker process; multiple
 * subscriptions multiplex on it (typically one per fact type / consumer
 * group).
 */
export class RedisStreamConsumer {
  readonly #client: RedisStreamClient;
  readonly #consumerName: string;
  readonly #metrics: RedisStreamConsumerMetrics;
  readonly #attempts: AttemptCounter;
  readonly #log: RedisStreamConsumerLogger;
  readonly #blockMs: number;
  readonly #batchCount: number;
  readonly #maxRetries: number;
  readonly #now: () => number;
  readonly #subscriptions = new Map<string, StreamSubscription>();
  #running = false;

  constructor(options: RedisStreamConsumerOptions) {
    this.#client = options.client;
    this.#consumerName = options.consumerName ?? defaultConsumerName();
    this.#metrics = options.metrics ?? new RedisStreamConsumerMetrics();
    this.#attempts = options.attempts ?? new InMemoryAttemptCounter();
    this.#log = options.logger ?? defaultLogger;
    this.#blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
    this.#batchCount = options.batchCount ?? DEFAULT_BATCH_COUNT;
    this.#maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.#now = options.now ?? Date.now;
  }

  get consumerName(): string {
    return this.#consumerName;
  }

  get metrics(): RedisStreamConsumerMetrics {
    return this.#metrics;
  }

  /**
   * Register a handler for a fact type. The stream name is derived from
   * the fact type via {@link streamNameFor}; the consumer group is the
   * caller's responsibility (e.g. `gamewire-rating`).
   *
   * Must be called BEFORE {@link run}.
   */
  subscribe(subscription: StreamSubscription): void {
    if (this.#running) {
      throw new Error('redis-stream-consumer: cannot subscribe after run() has started');
    }
    this.#subscriptions.set(subscription.factType, subscription);
  }

  /**
   * Bootstrap consumer groups for every registered subscription. Idempotent
   * (BUSYGROUP is swallowed). Returns once every group exists.
   */
  async ensureGroups(): Promise<void> {
    for (const sub of this.#subscriptions.values()) {
      const stream = streamNameFor(sub.factType);
      await this.#client.xGroupCreateMkStream(stream, sub.group, '$');
      this.#log({
        event: 'redis_stream_group_ready',
        factType: sub.factType,
        group: sub.group,
        stream,
      });
    }
  }

  /**
   * Run the XREADGROUP loop until `signal.aborted` flips. Caller is
   * expected to wire the signal to SIGINT / SIGTERM.
   *
   * Errors from XREADGROUP itself are logged but NOT thrown — the loop
   * keeps running so a transient Redis blip cannot kill the worker.
   * Caller observes health via the metrics snapshot.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (this.#subscriptions.size === 0) {
      throw new Error('redis-stream-consumer: no subscriptions registered');
    }
    if (this.#running) {
      throw new Error('redis-stream-consumer: already running');
    }
    this.#running = true;
    try {
      await this.ensureGroups();
      while (!signal.aborted) {
        await this.#tick(signal);
      }
    } finally {
      this.#running = false;
    }
  }

  /**
   * Exposed for tests so a single iteration can be driven deterministically
   * without spawning a real loop.
   */
  async tickOnce(signal: AbortSignal = neverAborted()): Promise<void> {
    if (this.#subscriptions.size === 0) {
      throw new Error('redis-stream-consumer: no subscriptions registered');
    }
    await this.#tick(signal);
  }

  async #tick(signal: AbortSignal): Promise<void> {
    const subs = Array.from(this.#subscriptions.values());
    // We XREADGROUP per (group, stream) tuple because Redis requires a
    // single group per call. In our deployment each fact type has its
    // own group, so we issue one call per subscription. Volumes are
    // small enough (single-digit ops/sec at MVP) that the cost is fine.
    for (const sub of subs) {
      if (signal.aborted) {
        return;
      }
      const stream = streamNameFor(sub.factType);
      let batches;
      try {
        batches = await this.#client.xReadGroup({
          group: sub.group,
          consumer: this.#consumerName,
          blockMs: this.#blockMs,
          count: this.#batchCount,
          streams: [{ stream, id: '>' }],
        });
      } catch (err) {
        // Don't crash the worker on transient XREADGROUP failures. Just
        // log and let the next iteration retry. The block timeout means
        // this won't busy-loop even if Redis stays unreachable.
        this.#log({
          event: 'redis_stream_xreadgroup_error',
          factType: sub.factType,
          group: sub.group,
          stream,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      for (const batch of batches) {
        for (const entry of batch.entries) {
          if (signal.aborted) {
            return;
          }
          await this.#handleEntry(sub, batch.stream, entry);
        }
      }
    }
  }

  async #handleEntry(sub: StreamSubscription, stream: string, entry: StreamEntry): Promise<void> {
    const factType = sub.factType;
    this.#metrics.recordReceived(factType);

    const eventIdField = entry.fields.event_id;
    const eventId = eventIdField ? new TextDecoder().decode(eventIdField) : '';

    const dataField = entry.fields.data;
    if (!dataField || dataField.length === 0) {
      // No payload — treat as malformed and DLQ immediately. We use a
      // synthetic event_id (the stream id) as the dedupe key so the
      // attempt counter can't be poisoned by an empty event_id.
      const dedupeKey = eventId || `stream:${entry.id}`;
      await this.#deadLetter(sub, stream, entry, dedupeKey, 'missing_data');
      this.#metrics.recordOutcome(factType, 'malformed');
      return;
    }

    let fact: PlatformFact;
    try {
      fact = fromBinary(PlatformFactSchema, dataField);
    } catch (err) {
      // Same reasoning as missing_data: decode errors are permanent for
      // this entry, so DLQ + ACK and move on. Don't leave it cycling.
      const dedupeKey = eventId || `stream:${entry.id}`;
      await this.#deadLetter(sub, stream, entry, dedupeKey, 'decode_error', err);
      this.#metrics.recordOutcome(factType, 'malformed');
      return;
    }

    // Prefer the proto-level id over the out-of-band event_id field for
    // attempt accounting. The fields agree by construction; this defends
    // against a future publisher that drops the event_id helper field.
    const dedupeKey = fact.id || eventId || `stream:${entry.id}`;
    const attempt = this.#attempts.increment(dedupeKey);

    const handlerStart = this.#now();
    let success = false;
    let threw: unknown;
    try {
      const result = await sub.handler(fact, {
        eventId: dedupeKey,
        factType,
        streamId: entry.id,
        attempt,
      });
      // Default to success on `undefined` so simple handlers that just
      // return can opt into ACK without ceremony. Explicit `false`
      // signals transient failure.
      success = result !== false;
    } catch (err) {
      threw = err;
      success = false;
    }
    this.#metrics.recordHandlerDuration(factType, this.#now() - handlerStart);

    if (success) {
      this.#attempts.reset(dedupeKey);
      await this.#safeXAck(stream, sub.group, entry.id);
      this.#metrics.recordOutcome(factType, 'ok');
      return;
    }

    this.#metrics.recordOutcome(factType, 'error');
    this.#log({
      event: 'redis_stream_handler_failed',
      factType,
      group: sub.group,
      stream,
      streamId: entry.id,
      eventId: dedupeKey,
      attempt,
      message:
        threw instanceof Error ? threw.message : threw === undefined ? undefined : String(threw),
    });

    if (attempt >= this.#maxRetries) {
      await this.#deadLetter(sub, stream, entry, dedupeKey, 'retries_exhausted', threw);
    }
    // else: leave entry in PEL, no ACK. A future claim sweep will
    // re-deliver it. We do NOT redeliver inline — that would block the
    // outer tick on a single bad entry.
  }

  async #deadLetter(
    sub: StreamSubscription,
    stream: string,
    entry: StreamEntry,
    eventId: string,
    reason: string,
    cause?: unknown
  ): Promise<void> {
    const factType = sub.factType;
    const fields: Record<string, string | Uint8Array> = {
      original_stream: stream,
      original_id: entry.id,
      fact_type: factType,
      event_id: eventId,
      reason,
    };
    const dataField = entry.fields.data;
    if (dataField && dataField.length > 0) {
      fields.data = dataField;
    }
    if (cause !== undefined) {
      fields.error = cause instanceof Error ? cause.message : String(cause);
    }
    try {
      await this.#client.xAdd(DLQ_STREAM_NAME, fields);
    } catch (err) {
      // DLQ publish failed. Don't ACK; let the entry sit in the PEL so
      // an operator can recover manually. This is rare enough that we
      // accept the resulting PEL growth.
      this.#log({
        event: 'redis_stream_dlq_publish_failed',
        factType,
        group: sub.group,
        stream,
        streamId: entry.id,
        eventId,
        reason,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.#metrics.recordDeadLetter(factType);
    this.#log({
      event: 'redis_stream_dead_letter',
      factType,
      group: sub.group,
      stream,
      streamId: entry.id,
      eventId,
      reason,
      message:
        cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
    });
    // ACK after a successful DLQ publish — the message is now durable
    // on the dlq stream, so removing it from the PEL is safe.
    this.#attempts.reset(eventId);
    await this.#safeXAck(stream, sub.group, entry.id);
  }

  async #safeXAck(stream: string, group: string, id: string): Promise<void> {
    try {
      await this.#client.xAck(stream, group, id);
    } catch (err) {
      // XACK failure leaves the entry in the PEL. We log but don't
      // retry inline — same reasoning as XREADGROUP errors.
      this.#log({
        event: 'redis_stream_xack_error',
        stream,
        group,
        streamId: id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const neverAborted = (): AbortSignal => new AbortController().signal;

function mapToObject(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of map.entries()) {
    out[key] = value;
  }
  return out;
}

function outcomesToObject(
  map: Map<string, Record<ConsumeOutcome, number>>
): Record<string, Record<ConsumeOutcome, number>> {
  const out: Record<string, Record<ConsumeOutcome, number>> = {};
  for (const [key, value] of map.entries()) {
    out[key] = { ...value };
  }
  return out;
}

/**
 * Bun-based {@link RedisStreamClient} implementation. Uses the raw
 * `.send(cmd, args)` API so we don't bind to a typed client we don't own.
 *
 * Imported lazily from server.ts so the worker module graph doesn't pull
 * the Bun runtime in non-Bun test environments (vitest under node).
 *
 * The shape of the returned XREADGROUP value is `null | [stream, entries]`
 * where each entry is `[id, [field, value, field, value, ...]]`. We
 * normalise this to {@link StreamEntry}.
 */
export interface BunRedisLike {
  // Bun.redis.send transmits a Uint8Array arg as a raw RESP bulk string
  // (byte-for-byte). A JS string arg is sent UTF-8-encoded, which inflates
  // binary proto bytes >= 0x80 — so binary payloads MUST be passed as
  // Uint8Array, never latin1-stringified first (see the XADD note below).
  send(command: string, args: (string | Uint8Array)[]): Promise<unknown>;
}

export const createBunRedisStreamClient = (client: BunRedisLike): RedisStreamClient => ({
  async xGroupCreateMkStream(stream, group, startId) {
    try {
      await client.send('XGROUP', ['CREATE', stream, group, startId, 'MKSTREAM']);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('BUSYGROUP')) {
        return;
      }
      throw err;
    }
  },

  async xReadGroup(args) {
    const cmd = [
      'GROUP',
      args.group,
      args.consumer,
      'COUNT',
      String(args.count),
      'BLOCK',
      String(args.blockMs),
      'STREAMS',
      ...args.streams.map((s) => s.stream),
      ...args.streams.map((s) => s.id),
    ];
    const raw = await client.send('XREADGROUP', cmd);
    if (raw === null || raw === undefined) {
      return [];
    }
    return parseXReadGroupReply(raw);
  },

  async xAck(stream, group, id) {
    const raw = await client.send('XACK', [stream, group, id]);
    return typeof raw === 'number' ? raw : Number(raw ?? 0);
  },

  async xAdd(stream, fields) {
    // Binary values (proto `data`) are passed as raw bytes, NOT
    // latin1-stringified: a JS string arg is sent UTF-8-encoded and inflates
    // bytes >= 0x80, which makes the payload undecodable by the go-redis
    // consumer (proto.Unmarshal "invalid wire-format data"). A raw
    // Uint8Array round-trips byte-identically across Bun and go-redis.
    const args: (string | Uint8Array)[] = [stream, '*'];
    for (const [key, value] of Object.entries(fields)) {
      args.push(key);
      args.push(value);
    }
    const raw = await client.send('XADD', args);
    return typeof raw === 'string' ? raw : String(raw ?? '');
  },
});

/**
 * Decode XREADGROUP reply. The wire shape is nested arrays; we tolerate
 * both Uint8Array and string field values (Bun.redis returns strings for
 * resp3 by default but we want to keep the door open for binary mode).
 */
const parseXReadGroupReply = (
  raw: unknown
): readonly { stream: string; entries: readonly StreamEntry[] }[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: { stream: string; entries: StreamEntry[] }[] = [];
  for (const streamReply of raw) {
    if (!Array.isArray(streamReply) || streamReply.length < 2) {
      continue;
    }
    const [streamName, entries] = streamReply as [unknown, unknown];
    const stream = typeof streamName === 'string' ? streamName : String(streamName);
    if (!Array.isArray(entries)) {
      continue;
    }
    const parsedEntries: StreamEntry[] = [];
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      const [id, fieldList] = entry as [unknown, unknown];
      if (typeof id !== 'string' || !Array.isArray(fieldList)) {
        continue;
      }
      const fields: Record<string, Uint8Array> = {};
      for (let i = 0; i + 1 < fieldList.length; i += 2) {
        const k = fieldList[i];
        const v = fieldList[i + 1];
        const key = typeof k === 'string' ? k : String(k);
        if (v instanceof Uint8Array) {
          fields[key] = v;
        } else if (typeof v === 'string') {
          fields[key] = binaryStringToUint8Array(v);
        }
      }
      parsedEntries.push({ id, fields });
    }
    out.push({ stream, entries: parsedEntries });
  }
  return out;
};

/**
 * Bun.redis.send() returns string values from RESP2 byte payloads via
 * Latin-1 decoding. We round-trip via the same encoding so binary proto
 * bytes survive. If we later flip Bun to RESP3 binary mode this becomes
 * a no-op identity passthrough.
 */
const binaryStringToUint8Array = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
};

const uint8ArrayToBinaryString = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
};

/**
 * Internal export for unit tests that need to exercise the wire-format
 * helpers in isolation.
 */
export const __test = {
  parseXReadGroupReply,
  binaryStringToUint8Array,
  uint8ArrayToBinaryString,
};
