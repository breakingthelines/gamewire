/**
 * RatingSubmitted event consumer for gamewire-worker.
 *
 * Upstream contract:
 *   - game-service emits `PlatformFact` envelopes typed
 *     `"game.rating.submitted"` whenever `SubmitRating` succeeds.
 *   - The fact carries the rating's identity (`source_record_id` -> rating_id),
 *     the actor principal, and the rating payload in `metadata`.
 *
 * Downstream contract:
 *   - For each event, call `GameService.RecordRating` over Connect/gRPC
 *     with `rating_id` reused as the idempotency key. Server-side this
 *     upserts the rating row, writes a `rating_logs` entry, and recomputes
 *     `rating_aggregates` + `rating_distributions` atomically.
 *
 * Failure model:
 *   - Transient errors (UNAVAILABLE, DEADLINE_EXCEEDED, ABORTED, INTERNAL,
 *     UNKNOWN, RESOURCE_EXHAUSTED, plus thrown JS errors that aren't
 *     ConnectError) retry with exponential backoff up to a configurable
 *     bound. After the bound is exhausted the event is dead-lettered for
 *     manual reconciliation.
 *   - Permanent errors (INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED,
 *     UNAUTHENTICATED, FAILED_PRECONDITION, OUT_OF_RANGE, UNIMPLEMENTED)
 *     skip retries and dead-letter immediately.
 *   - Already-applied facts (by rating_id) are deduped in-process and
 *     short-circuited so retries cannot double-count.
 *
 * Transport is intentionally pluggable: this module owns the consumer logic
 * and never touches the wire shape. A separate adapter (NATS, Redis Stream,
 * Connect server-streaming, etc.) feeds parsed `PlatformFact` envelopes into
 * `RatingConsumer.handle`. The fact type constant matches game-service's
 * `engagementdomain.PlatformFactTypeRatingSubmitted`, which IS the channel /
 * topic identifier.
 */

import { create } from '@bufbuild/protobuf';
import { type Timestamp, TimestampSchema } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';

import type { PlatformFact } from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  type RecordRatingRequest,
  type RecordRatingResponse,
  RecordRatingRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  RatingScale,
  RatingScopeType,
  RatingSubjectSchema,
  RatingSubjectType,
  type RatingSubject,
} from '@breakingthelines/protos/btl/game/v1/types/engagement_pb';

import type { GameServiceRecordRatingClient } from './clients/game-service.js';

/** Topic / fact-type emitted by game-service for rating submissions. */
export const RATING_SUBMITTED_FACT_TYPE = 'game.rating.submitted';

/**
 * Default backoff schedule: 100 ms, 500 ms, 2 s, 8 s, 30 s.
 * Total bound ~40 s. Matches the existing provider backoff envelope in
 * runtime.ts so an operator only has one mental model to keep.
 */
export const DEFAULT_RATING_BACKOFF_MS: readonly number[] = [100, 500, 2_000, 8_000, 30_000];

/** Wall-clock + sleep boundary so tests can drive the consumer deterministically. */
export interface RatingConsumerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const defaultRatingConsumerClock: RatingConsumerClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Per-event outcome surfaced to the caller and the metrics counters. */
export type RatingConsumerOutcome =
  | 'applied'
  | 'duplicate'
  | 'ignored'
  | 'dead_letter_permanent'
  | 'dead_letter_exhausted';

export interface RatingConsumerResult {
  readonly outcome: RatingConsumerOutcome;
  readonly factId: string;
  readonly ratingId: string;
  readonly attempts: number;
  readonly response?: RecordRatingResponse;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
    readonly permanent: boolean;
  };
}

export interface RatingConsumerMetricsSnapshot {
  readonly received: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly ignored: number;
  readonly retried: number;
  readonly deadLetteredPermanent: number;
  readonly deadLetteredExhausted: number;
}

/**
 * Lightweight counters mirroring the IngestionMetrics shape so an operator
 * gets one consistent /metrics surface across the worker.
 */
export class RatingConsumerMetrics {
  #received = 0;
  #applied = 0;
  #duplicates = 0;
  #ignored = 0;
  #retried = 0;
  #deadLetterPermanent = 0;
  #deadLetterExhausted = 0;

  recordReceived(): void {
    this.#received += 1;
  }

  recordOutcome(outcome: RatingConsumerOutcome): void {
    switch (outcome) {
      case 'applied':
        this.#applied += 1;
        break;
      case 'duplicate':
        this.#duplicates += 1;
        break;
      case 'ignored':
        this.#ignored += 1;
        break;
      case 'dead_letter_permanent':
        this.#deadLetterPermanent += 1;
        break;
      case 'dead_letter_exhausted':
        this.#deadLetterExhausted += 1;
        break;
    }
  }

  recordRetry(): void {
    this.#retried += 1;
  }

  snapshot(): RatingConsumerMetricsSnapshot {
    return {
      received: this.#received,
      applied: this.#applied,
      duplicates: this.#duplicates,
      ignored: this.#ignored,
      retried: this.#retried,
      deadLetteredPermanent: this.#deadLetterPermanent,
      deadLetteredExhausted: this.#deadLetterExhausted,
    };
  }

  reset(): void {
    this.#received = 0;
    this.#applied = 0;
    this.#duplicates = 0;
    this.#ignored = 0;
    this.#retried = 0;
    this.#deadLetterPermanent = 0;
    this.#deadLetterExhausted = 0;
  }
}

/**
 * Dead-letter sink for events that cannot be applied. Production wires
 * this to either a Postgres `rating_dead_letter` table or a structured
 * log channel; the consumer module itself stays pure.
 */
export interface RatingDeadLetterSink {
  capture(entry: RatingDeadLetterEntry): Promise<void> | void;
}

export interface RatingDeadLetterEntry {
  readonly factId: string;
  readonly ratingId: string;
  readonly reason: 'permanent_error' | 'retries_exhausted' | 'malformed_event';
  readonly attempts: number;
  readonly fact: PlatformFact;
  readonly request?: RecordRatingRequest;
  readonly error: {
    readonly message: string;
    readonly code?: string;
  };
}

/**
 * In-memory dead-letter sink. Production deployments swap this out for a
 * Postgres-backed sink or a structured-log adapter; in-process retention
 * is bounded so the worker cannot OOM on a sustained failure.
 */
export class InMemoryRatingDeadLetterSink implements RatingDeadLetterSink {
  readonly #max: number;
  readonly #entries: RatingDeadLetterEntry[] = [];

  constructor(max = 1_000) {
    this.#max = Math.max(1, max);
  }

  capture(entry: RatingDeadLetterEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) {
      this.#entries.splice(0, this.#entries.length - this.#max);
    }
  }

  entries(): readonly RatingDeadLetterEntry[] {
    return [...this.#entries];
  }

  size(): number {
    return this.#entries.length;
  }

  clear(): void {
    this.#entries.length = 0;
  }
}

export interface RatingDedupeStore {
  has(ratingId: string): Promise<boolean> | boolean;
  remember(ratingId: string): Promise<void> | void;
}

/**
 * In-memory dedupe by rating_id. Bounded so a long-running worker cannot
 * grow without bound; eviction is LRU-ish (oldest-insertion-first).
 *
 * Idempotency is also enforced server-side (`Client.RecordRating` upserts
 * keyed on rating_id), so this store is a fast in-process short-circuit
 * rather than the source of truth.
 */
export class InMemoryRatingDedupeStore implements RatingDedupeStore {
  readonly #max: number;
  readonly #seen = new Set<string>();

  constructor(max = 10_000) {
    this.#max = Math.max(1, max);
  }

  has(ratingId: string): boolean {
    return this.#seen.has(ratingId);
  }

  remember(ratingId: string): void {
    if (this.#seen.has(ratingId)) {
      return;
    }
    this.#seen.add(ratingId);
    if (this.#seen.size > this.#max) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) {
        this.#seen.delete(oldest);
      }
    }
  }

  size(): number {
    return this.#seen.size;
  }
}

export interface RatingConsumerLogEntry {
  readonly event: string;
  readonly factId?: string;
  readonly ratingId?: string;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly code?: string;
  readonly reason?: string;
  readonly message?: string;
}

export type RatingConsumerLogger = (entry: RatingConsumerLogEntry) => void;

export interface RatingConsumerOptions {
  readonly client: GameServiceRecordRatingClient;
  readonly metrics?: RatingConsumerMetrics;
  readonly deadLetter?: RatingDeadLetterSink;
  readonly dedupe?: RatingDedupeStore;
  readonly clock?: RatingConsumerClock;
  readonly logger?: RatingConsumerLogger;
  /**
   * Backoff schedule in ms. The Nth retry waits `schedule[N - 1]` ms.
   * When all entries are exhausted the event is dead-lettered with
   * reason=`retries_exhausted`.
   */
  readonly backoffMs?: readonly number[];
}

const PERMANENT_CODES: ReadonlySet<Code> = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.AlreadyExists,
  Code.PermissionDenied,
  Code.Unauthenticated,
  Code.FailedPrecondition,
  Code.OutOfRange,
  Code.Unimplemented,
  Code.DataLoss,
  Code.Canceled,
]);

const codeName = (code: Code): string => Code[code] ?? `code_${String(code)}`;

const defaultLogger: RatingConsumerLogger = (entry) => {
  // One structured line per event keeps the consumer parseable by any
  // log shipper without an extra adapter. Mirrors the existing ingestion
  // logger shape.
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
};

/**
 * Owns the consumer loop for `game.rating.submitted` facts.
 *
 * Wire one of these per worker boot, hand each inbound event to
 * {@link RatingConsumer.handle}, and let the consumer take care of
 * idempotency, retries, dead-lettering, and metrics.
 */
export class RatingConsumer {
  readonly #client: GameServiceRecordRatingClient;
  readonly #metrics: RatingConsumerMetrics;
  readonly #deadLetter: RatingDeadLetterSink;
  readonly #dedupe: RatingDedupeStore;
  readonly #clock: RatingConsumerClock;
  readonly #log: RatingConsumerLogger;
  readonly #backoffMs: readonly number[];

  constructor(options: RatingConsumerOptions) {
    this.#client = options.client;
    this.#metrics = options.metrics ?? new RatingConsumerMetrics();
    this.#deadLetter = options.deadLetter ?? new InMemoryRatingDeadLetterSink();
    this.#dedupe = options.dedupe ?? new InMemoryRatingDedupeStore();
    this.#clock = options.clock ?? defaultRatingConsumerClock;
    this.#log = options.logger ?? defaultLogger;
    this.#backoffMs = options.backoffMs ?? DEFAULT_RATING_BACKOFF_MS;
  }

  get metrics(): RatingConsumerMetrics {
    return this.#metrics;
  }

  get deadLetter(): RatingDeadLetterSink {
    return this.#deadLetter;
  }

  /**
   * The fact-type topic this consumer subscribes to. Adapters that wrap
   * a real bus (NATS subject, Redis stream key, etc.) should filter to
   * this string before invoking {@link handle}.
   */
  get topic(): string {
    return RATING_SUBMITTED_FACT_TYPE;
  }

  /**
   * Process a single PlatformFact event.
   *
   * The method never throws: every outcome is reported via the returned
   * {@link RatingConsumerResult}. Adapters that ack/nack the underlying
   * transport should treat any non-`applied` non-`duplicate` result as a
   * signal that the event has already been dead-lettered (so ack the
   * message; do not re-deliver).
   */
  async handle(event: PlatformFact): Promise<RatingConsumerResult> {
    this.#metrics.recordReceived();

    if (event.type !== RATING_SUBMITTED_FACT_TYPE) {
      this.#metrics.recordOutcome('ignored');
      this.#log({
        event: 'rating_consumer_ignored_wrong_type',
        factId: event.id,
        reason: `expected ${RATING_SUBMITTED_FACT_TYPE} got ${event.type}`,
      });
      return {
        outcome: 'ignored',
        factId: event.id,
        ratingId: event.sourceRecordId,
        attempts: 0,
      };
    }

    const parsed = parseRatingSubmittedFact(event);
    if (!parsed.ok) {
      this.#metrics.recordOutcome('dead_letter_permanent');
      const reason = parsed.reason;
      const ratingId = event.sourceRecordId;
      await this.#deadLetter.capture({
        factId: event.id,
        ratingId,
        reason: 'malformed_event',
        attempts: 0,
        fact: event,
        error: { message: reason },
      });
      this.#log({
        event: 'rating_consumer_malformed',
        factId: event.id,
        ratingId,
        reason,
      });
      return {
        outcome: 'dead_letter_permanent',
        factId: event.id,
        ratingId,
        attempts: 0,
        error: { message: reason, permanent: true },
      };
    }

    const ratingId = parsed.payload.ratingId;
    if (await Promise.resolve(this.#dedupe.has(ratingId))) {
      this.#metrics.recordOutcome('duplicate');
      this.#log({
        event: 'rating_consumer_duplicate',
        factId: event.id,
        ratingId,
      });
      return {
        outcome: 'duplicate',
        factId: event.id,
        ratingId,
        attempts: 0,
      };
    }

    const request = buildRecordRatingRequest(parsed.payload);
    const maxAttempts = this.#backoffMs.length + 1; // initial + retries
    let attempt = 0;
    let lastErrorMessage = '';
    let lastErrorCode: string | undefined;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const response = await this.#client.recordRating(request);
        await Promise.resolve(this.#dedupe.remember(ratingId));
        this.#metrics.recordOutcome('applied');
        this.#log({
          event: 'rating_consumer_applied',
          factId: event.id,
          ratingId,
          attempt,
        });
        return {
          outcome: 'applied',
          factId: event.id,
          ratingId,
          attempts: attempt,
          response,
        };
      } catch (error: unknown) {
        const classification = classifyError(error);
        lastErrorMessage = classification.message;
        lastErrorCode = classification.codeName;

        if (classification.permanent) {
          this.#metrics.recordOutcome('dead_letter_permanent');
          await this.#deadLetter.capture({
            factId: event.id,
            ratingId,
            reason: 'permanent_error',
            attempts: attempt,
            fact: event,
            request,
            error: { message: classification.message, code: classification.codeName },
          });
          this.#log({
            event: 'rating_consumer_permanent_error',
            factId: event.id,
            ratingId,
            attempt,
            code: classification.codeName,
            message: classification.message,
          });
          return {
            outcome: 'dead_letter_permanent',
            factId: event.id,
            ratingId,
            attempts: attempt,
            error: {
              message: classification.message,
              code: classification.codeName,
              permanent: true,
            },
          };
        }

        if (attempt >= maxAttempts) {
          break;
        }

        const delayMs = this.#backoffMs[attempt - 1] ?? 0;
        this.#metrics.recordRetry();
        this.#log({
          event: 'rating_consumer_transient_retry',
          factId: event.id,
          ratingId,
          attempt,
          delayMs,
          code: classification.codeName,
          message: classification.message,
        });
        if (delayMs > 0) {
          await this.#clock.sleep(delayMs);
        }
      }
    }

    this.#metrics.recordOutcome('dead_letter_exhausted');
    await this.#deadLetter.capture({
      factId: event.id,
      ratingId,
      reason: 'retries_exhausted',
      attempts: attempt,
      fact: event,
      request,
      error: { message: lastErrorMessage, code: lastErrorCode },
    });
    this.#log({
      event: 'rating_consumer_exhausted',
      factId: event.id,
      ratingId,
      attempt,
      code: lastErrorCode,
      message: lastErrorMessage,
    });
    return {
      outcome: 'dead_letter_exhausted',
      factId: event.id,
      ratingId,
      attempts: attempt,
      error: {
        message: lastErrorMessage,
        code: lastErrorCode,
        permanent: false,
      },
    };
  }
}

export interface RatingSubmittedPayload {
  readonly ratingId: string;
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly subject: RatingSubject;
  readonly scopeType: RatingScopeType;
  readonly scopeId: string;
  readonly scale: RatingScale;
  readonly value: number;
  readonly ratedAt?: Timestamp;
}

export type RatingSubmittedParseResult =
  | { readonly ok: true; readonly payload: RatingSubmittedPayload }
  | { readonly ok: false; readonly reason: string };

/**
 * Decode a `game.rating.submitted` PlatformFact into a strongly typed
 * payload ready to be turned into a {@link RecordRatingRequest}.
 *
 * Returns `ok: false` with a short reason instead of throwing so the
 * consumer can route malformed events into the dead-letter sink without
 * panicking the loop.
 */
export const parseRatingSubmittedFact = (
  fact: PlatformFact
): RatingSubmittedParseResult => {
  if (fact.type !== RATING_SUBMITTED_FACT_TYPE) {
    return { ok: false, reason: `unexpected fact type ${fact.type || '<empty>'}` };
  }

  const ratingId = fact.sourceRecordId.trim();
  if (!ratingId) {
    return { ok: false, reason: 'fact.source_record_id is required' };
  }

  const userId = fact.actor?.id.trim() ?? '';
  if (!userId) {
    return { ok: false, reason: 'fact.actor.id is required' };
  }

  const metadata = fact.metadata ?? {};
  const subjectTypeRaw = readMetadataString(metadata, 'subject_type');
  const subjectType = subjectTypeFromString(subjectTypeRaw);
  if (subjectType === RatingSubjectType.UNSPECIFIED) {
    return {
      ok: false,
      reason: `metadata.subject_type is required, got '${subjectTypeRaw ?? ''}'`,
    };
  }

  const scopeTypeRaw = readMetadataString(metadata, 'scope_type');
  const scopeType = scopeTypeFromString(scopeTypeRaw);
  if (scopeType === RatingScopeType.UNSPECIFIED) {
    return {
      ok: false,
      reason: `metadata.scope_type is required, got '${scopeTypeRaw ?? ''}'`,
    };
  }

  const scaleRaw = readMetadataString(metadata, 'scale');
  const scale = scaleFromString(scaleRaw);
  if (scale === RatingScale.UNSPECIFIED) {
    return {
      ok: false,
      reason: `metadata.scale is required, got '${scaleRaw ?? ''}'`,
    };
  }

  const value = readMetadataNumber(metadata, 'value');
  if (value === undefined) {
    return { ok: false, reason: 'metadata.value is required' };
  }
  if (!Number.isInteger(value) || value <= 0) {
    return {
      ok: false,
      reason: `metadata.value must be a positive integer, got ${String(value)}`,
    };
  }

  const subject = create(RatingSubjectSchema, {
    type: subjectType,
    gameId: readMetadataString(metadata, 'game_id') ?? '',
    teamId: readMetadataString(metadata, 'team_id') ?? '',
    playerId: readMetadataString(metadata, 'player_id') ?? '',
    coachId: readMetadataString(metadata, 'coach_id') ?? '',
    occurrenceId: readMetadataString(metadata, 'occurrence_id') ?? '',
  });

  const ratedAt = chooseRatedAt(fact);
  const idempotencyKey =
    fact.idempotencyKey.trim() ||
    fact.id.trim() ||
    `rating:${ratingId}`;

  return {
    ok: true,
    payload: {
      ratingId,
      idempotencyKey,
      userId,
      subject,
      scopeType,
      scopeId: readMetadataString(metadata, 'scope_id') ?? '',
      scale,
      value,
      ratedAt,
    },
  };
};

/**
 * Convert a parsed payload into the wire-shape RecordRatingRequest used
 * by `GameService.RecordRating`. Kept separate from the parser so callers
 * with payloads produced by a non-fact source (replay scripts, tests) can
 * skip the envelope step.
 */
export const buildRecordRatingRequest = (
  payload: RatingSubmittedPayload
): RecordRatingRequest =>
  create(RecordRatingRequestSchema, {
    ratingId: payload.ratingId,
    userId: payload.userId,
    subject: payload.subject,
    scopeType: payload.scopeType,
    scopeId: payload.scopeId,
    scale: payload.scale,
    value: payload.value,
    ratedAt: payload.ratedAt,
    idempotencyKey: payload.idempotencyKey,
  });

const chooseRatedAt = (fact: PlatformFact): Timestamp | undefined => {
  const occurred = fact.occurredAt;
  if (occurred && isMeaningfulTimestamp(occurred)) {
    return occurred;
  }
  const emitted = fact.emittedAt;
  if (emitted && isMeaningfulTimestamp(emitted)) {
    return emitted;
  }
  return undefined;
};

const isMeaningfulTimestamp = (ts: Timestamp): boolean => {
  const seconds = Number(ts.seconds);
  return Number.isFinite(seconds) && (seconds !== 0 || ts.nanos !== 0);
};

const readMetadataString = (
  metadata: Record<string, unknown>,
  key: string
): string | undefined => {
  const raw = metadata[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  return undefined;
};

const readMetadataNumber = (
  metadata: Record<string, unknown>,
  key: string
): number | undefined => {
  const raw = metadata[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const subjectTypeFromString = (raw: string | undefined): RatingSubjectType => {
  if (!raw) {
    return RatingSubjectType.UNSPECIFIED;
  }
  const normalised = raw.trim().toUpperCase();
  switch (normalised) {
    case 'RATING_SUBJECT_TYPE_GAME':
    case 'GAME':
      return RatingSubjectType.GAME;
    case 'RATING_SUBJECT_TYPE_PLAYER_PERFORMANCE':
    case 'PLAYER_PERFORMANCE':
      return RatingSubjectType.PLAYER_PERFORMANCE;
    case 'RATING_SUBJECT_TYPE_MANAGER_PERFORMANCE':
    case 'MANAGER_PERFORMANCE':
      return RatingSubjectType.MANAGER_PERFORMANCE;
    case 'RATING_SUBJECT_TYPE_MOMENT':
    case 'MOMENT':
      return RatingSubjectType.MOMENT;
    case 'RATING_SUBJECT_TYPE_GAME_OCCURRENCE':
    case 'GAME_OCCURRENCE':
      return RatingSubjectType.GAME_OCCURRENCE;
    default:
      return RatingSubjectType.UNSPECIFIED;
  }
};

const scopeTypeFromString = (raw: string | undefined): RatingScopeType => {
  if (!raw) {
    return RatingScopeType.UNSPECIFIED;
  }
  const normalised = raw.trim().toUpperCase();
  switch (normalised) {
    case 'RATING_SCOPE_TYPE_GLOBAL':
    case 'GLOBAL':
      return RatingScopeType.GLOBAL;
    case 'RATING_SCOPE_TYPE_PRIVATE':
    case 'PRIVATE':
      return RatingScopeType.PRIVATE;
    case 'RATING_SCOPE_TYPE_CAPABILITY_INSTANCE':
    case 'CAPABILITY_INSTANCE':
      return RatingScopeType.CAPABILITY_INSTANCE;
    default:
      return RatingScopeType.UNSPECIFIED;
  }
};

const scaleFromString = (raw: string | undefined): RatingScale => {
  if (!raw) {
    return RatingScale.UNSPECIFIED;
  }
  const normalised = raw.trim().toUpperCase();
  switch (normalised) {
    case 'RATING_SCALE_ONE_TO_TEN':
    case 'ONE_TO_TEN':
      return RatingScale.ONE_TO_TEN;
    case 'RATING_SCALE_LETTER_GRADE':
    case 'LETTER_GRADE':
      return RatingScale.LETTER_GRADE;
    case 'RATING_SCALE_BTL_INVERSE_ONE_TO_SIX':
    case 'BTL_INVERSE_ONE_TO_SIX':
      return RatingScale.BTL_INVERSE_ONE_TO_SIX;
    default:
      return RatingScale.UNSPECIFIED;
  }
};

interface ErrorClassification {
  readonly permanent: boolean;
  readonly message: string;
  readonly codeName?: string;
}

const classifyError = (error: unknown): ErrorClassification => {
  if (error instanceof ConnectError) {
    const codeNameValue = codeName(error.code);
    return {
      permanent: PERMANENT_CODES.has(error.code),
      message: error.rawMessage || error.message,
      codeName: codeNameValue,
    };
  }
  if (error instanceof Error) {
    // Plain JS errors (network, AbortError, JSON parse) are treated as
    // transient unless explicitly thrown as ConnectError. Operators get
    // the original message for triage.
    return { permanent: false, message: error.message };
  }
  return { permanent: false, message: String(error) };
};

export const __test = {
  classifyError,
  codeName,
  isMeaningfulTimestamp,
  readMetadataNumber,
  readMetadataString,
  scaleFromString,
  scopeTypeFromString,
  subjectTypeFromString,
  TimestampSchema,
};
