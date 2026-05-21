/**
 * `game.match.concluded` fact publisher for gamewire-worker.
 *
 * # Why this exists
 *
 * API-Football reports fixture status via the `fixture.status.short` field.
 * When that status transitions into a terminal state we need to fire a
 * one-shot `game.match.concluded` PlatformFact onto the bus so game-service
 * (the consumer, owned by a sibling agent on `prediction-scoring-lane`) can
 * run prediction scoring, lock ratings, and any other end-of-match work
 * that needs to happen exactly once per fixture.
 *
 * # Wire contract (LOAD-BEARING — must match the consumer on game-service)
 *
 * The contract mirrors the game-service publisher documented in
 * `redis-stream-consumer.ts`. Any change here is a breaking change for
 * the sibling lane.
 *
 * - **Stream name:** `btl:facts:game.match.concluded`
 * - **MAXLEN:** `MAXLEN ~ 10000` (approximate cap, not exact). The bus
 *   is a fan-out window; backfills come from gamewire's own state +
 *   game-service's source-of-truth tables, not from the stream.
 * - **XADD fields per entry:**
 *   - `data` — `toBinary(PlatformFactSchema, fact)` raw bytes.
 *   - `event_id` — `fact.id` (string) for retry / dedupe accounting
 *     without parsing the proto.
 *   - `fact_type` — `fact.type` (string), always
 *     `"game.match.concluded"`.
 *
 * # PlatformFact shape
 *
 * - `type` = `"game.match.concluded"`
 * - `source_service` = `"gamewire-worker"`
 * - `source_record_id` = BTL canonical `game_id` (resolved upstream)
 * - `metadata` = JSON object with:
 *   - `game_id` (string)
 *   - `provider_status` (`"FT"`, `"AET"`, `"PEN"`, `"PST"`, `"ABD"`, `"AWD"`, `"WO"`)
 *   - `void_reason` (string or null — null for result statuses,
 *     `provider_status` echo for void statuses)
 *   - `provider_fixture_id` (string, for traceability)
 *   - `concluded_at` (ISO-8601 string at which the terminal status was
 *     observed)
 * - `occurred_at` = the concluded_at timestamp (proto Timestamp)
 * - `emitted_at` = now()
 * - `idempotency_key` = `"match-concluded:<provider_fixture_id>:<provider_status>"`
 * - `id` = same as idempotency_key (no proto-level id source available;
 *   the consumer's dedupe path uses either field).
 *
 * # Emit-once semantics
 *
 * A fixture transitions to a terminal state AT MOST ONCE. We gate
 * emissions on an {@link EmittedFixtureStore}; the in-memory default
 * remembers the (provider, fixture_id) tuple in-process. A future
 * Redis-backed implementation can survive worker restarts; until then
 * the store is best-effort per replica.
 *
 * If a provider correction flips a fixture back to non-terminal (e.g.
 * `PST` → `NS` after a reschedule) we deliberately do NOT clear the
 * marker. The consumer on game-service is responsible for handling
 * un-conclusion via its rescore path. Our job is the one-shot signal.
 *
 * # Why this layer is thin
 *
 * The detector / publisher does not own fixture polling, identity
 * resolution, or business logic. It exposes a single `observe(fixture)`
 * method that the ingestion side wires in once it has a normalised
 * fixture envelope (status + BTL game_id + provider id + concluded_at).
 */

import { create, toBinary, type JsonObject } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromMs } from '@bufbuild/protobuf/wkt';

import {
  type PlatformFact,
  PlatformFactSchema,
} from '@breakingthelines/protos/btl/context/v1/context_pb';

/** Fact type emitted onto `btl:facts:game.match.concluded`. */
export const MATCH_CONCLUDED_FACT_TYPE = 'game.match.concluded';

/** Source service identifier carried inside the PlatformFact envelope. */
export const MATCH_CONCLUDED_SOURCE_SERVICE = 'gamewire-worker';

/**
 * Stream name — load-bearing constant shared with the consumer lane.
 * Do NOT change without coordinating with game-service.
 */
export const MATCH_CONCLUDED_STREAM_NAME = `btl:facts:${MATCH_CONCLUDED_FACT_TYPE}`;

/**
 * Approximate stream length cap. `~` makes Redis pick an efficient
 * trim boundary near 10k entries — the bus is a fan-out window, not a
 * historical archive.
 */
export const MATCH_CONCLUDED_STREAM_MAXLEN = 10_000;

/**
 * Classification of an API-Football fixture status code.
 *
 * - `terminal-result`: regulation finish (`FT`), extra time (`AET`),
 *   penalty shootout (`PEN`). The match was played to a result.
 * - `terminal-void`: cancelled in some way — postponed (`PST`),
 *   abandoned (`ABD`), awarded by walkover (`WO`) or technical loss
 *   (`AWD`). The match did not produce a normal result and predictions
 *   that depend on a result must void.
 * - `null`: the status is non-terminal or unknown; no fact should
 *   emit.
 */
export type MatchTerminalClassification = 'terminal-result' | 'terminal-void';

/**
 * API-Football status codes that map to a terminal-result classification.
 * Source: https://www.api-football.com/documentation-v3#section/Endpoints/Fixtures
 */
export const TERMINAL_RESULT_STATUSES: ReadonlySet<string> = new Set(['FT', 'AET', 'PEN']);

/**
 * API-Football status codes that map to a terminal-void classification.
 * `PST`/`ABD`/`AWD`/`WO` all mean "no normal result"; their distinction
 * is preserved in `metadata.void_reason` so the consumer can branch on
 * the exact reason (e.g. a postponed fixture may be rescheduled later
 * and re-emerge as `NS`).
 */
export const TERMINAL_VOID_STATUSES: ReadonlySet<string> = new Set(['PST', 'ABD', 'AWD', 'WO']);

/**
 * Classify a raw API-Football `fixture.status.short` value. Returns
 * `null` for non-terminal or unrecognised statuses; the caller must
 * suppress emission in that case.
 *
 * Input is normalised to upper-case so provider-side casing drift
 * cannot silently drop fixtures.
 */
export const classifyApiFootballStatus = (
  statusShort: string | null | undefined
): MatchTerminalClassification | null => {
  if (typeof statusShort !== 'string') {
    return null;
  }
  const normalised = statusShort.trim().toUpperCase();
  if (TERMINAL_RESULT_STATUSES.has(normalised)) {
    return 'terminal-result';
  }
  if (TERMINAL_VOID_STATUSES.has(normalised)) {
    return 'terminal-void';
  }
  return null;
};

/**
 * Normalised, identity-resolved fixture observation passed into the
 * publisher. The caller (ingestion pipeline) is responsible for:
 *   - extracting `providerStatus` from the API-Football payload
 *   - resolving `gameId` via the identity service
 *   - choosing `concludedAt` (typically the `fixture.date` field on the
 *     first observed terminal status, falling back to now() if the
 *     provider gives us nothing)
 *
 * Keeping this struct provider-agnostic means a future Sportmonks /
 * Hudl adapter can build the same shape and reuse the publisher.
 */
export interface MatchFixtureObservation {
  /** API-Football fixture id (or provider-specific id). String for safety. */
  readonly providerFixtureId: string;
  /** BTL canonical game id resolved via identity-server. */
  readonly gameId: string;
  /** Raw provider status code, e.g. "FT". Will be normalised to upper-case. */
  readonly providerStatus: string;
  /**
   * Timestamp (ms since epoch) at which the terminal status was
   * observed. Used for `metadata.concluded_at` (ISO-8601) and the
   * `occurred_at` proto timestamp.
   */
  readonly concludedAtMs: number;
  /**
   * Provider id (e.g. "api-football"). Combined with `providerFixtureId`
   * to form the per-fixture dedupe key. Defaults are not provided so
   * the caller MUST decide which provider observed the transition.
   */
  readonly providerId: string;
}

/**
 * Outcome of an `observe()` call. Surfaced primarily so tests and the
 * worker boot log can confirm what the publisher did with each call.
 */
export type MatchConcludedObserveOutcome =
  | { readonly outcome: 'published'; readonly fact: PlatformFact }
  | { readonly outcome: 'already_emitted' }
  | { readonly outcome: 'not_terminal' }
  | {
      readonly outcome: 'publish_failed';
      readonly error: { readonly message: string };
    };

/**
 * Persistence boundary for the per-fixture emit-once marker.
 *
 * Implementations:
 *   - {@link InMemoryEmittedFixtureStore} — process-local Map, default
 *     for tests and the worker boot. Restarts reset the marker; the
 *     spec accepts this for MVP.
 *   - (future) Redis-backed `SET NX EX` so the marker survives
 *     restarts.
 */
export interface EmittedFixtureStore {
  /**
   * Return true if the fixture has already emitted `game.match.concluded`.
   * Returning true MUST be a strong "skip the publish" signal.
   */
  hasEmitted(providerId: string, providerFixtureId: string): Promise<boolean> | boolean;

  /**
   * Mark the fixture as emitted. The store should make this idempotent
   * — repeated calls for the same key are not an error.
   */
  markEmitted(providerId: string, providerFixtureId: string): Promise<void> | void;

  /**
   * Optional probe used in logs.
   */
  readonly backend: 'memory' | 'redis';
}

/**
 * Process-local emit-once store. Bounded so a long-running worker
 * cannot grow without bound; eviction is oldest-insertion-first.
 *
 * 50k entries is approximately a full season of top-five fixtures
 * across all competitions, so the eviction path should not trigger in
 * practice during normal operation.
 */
export class InMemoryEmittedFixtureStore implements EmittedFixtureStore {
  readonly backend = 'memory' as const;
  readonly #max: number;
  readonly #seen = new Set<string>();

  constructor(max = 50_000) {
    this.#max = Math.max(1, max);
  }

  hasEmitted(providerId: string, providerFixtureId: string): boolean {
    return this.#seen.has(this.#key(providerId, providerFixtureId));
  }

  markEmitted(providerId: string, providerFixtureId: string): void {
    const key = this.#key(providerId, providerFixtureId);
    if (this.#seen.has(key)) {
      return;
    }
    this.#seen.add(key);
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

  reset(): void {
    this.#seen.clear();
  }

  #key(providerId: string, providerFixtureId: string): string {
    return `${providerId}:${providerFixtureId}`;
  }
}

/**
 * Minimal Bun.redis shape we depend on. Mirrors the BunRedisLike type
 * exposed by the consumer module so the same client can be passed to
 * both — no need to construct a second Redis connection.
 */
export interface BunRedisStreamPublisher {
  send(command: string, args: string[]): Promise<unknown>;
}

/**
 * Stream-publish boundary. The default implementation issues a single
 * `XADD <stream> MAXLEN ~ <maxlen> * field value ...` call against Bun.redis.
 * Tests inject a stub that records the args and returns a synthetic
 * stream id.
 */
export interface MatchConcludedStreamClient {
  publish(
    fields: Record<string, string | Uint8Array>,
    options: { readonly stream: string; readonly maxLen: number }
  ): Promise<string>;
  readonly backend: 'redis' | 'memory';
}

/**
 * In-memory stream client. Records every publish call so tests can
 * assert the shape without going near a real Redis. The recorded
 * payload is exposed via {@link InMemoryMatchConcludedStreamClient.published}.
 */
export class InMemoryMatchConcludedStreamClient implements MatchConcludedStreamClient {
  readonly backend = 'memory' as const;
  readonly #published: {
    stream: string;
    maxLen: number;
    fields: Record<string, string | Uint8Array>;
  }[] = [];
  #nextId = 1;
  #failNext = false;

  async publish(
    fields: Record<string, string | Uint8Array>,
    options: { readonly stream: string; readonly maxLen: number }
  ): Promise<string> {
    if (this.#failNext) {
      this.#failNext = false;
      throw new Error('in-memory stream client: forced failure');
    }
    this.#published.push({ stream: options.stream, maxLen: options.maxLen, fields: { ...fields } });
    const id = `${Date.now()}-${this.#nextId}`;
    this.#nextId += 1;
    return id;
  }

  failNext(): void {
    this.#failNext = true;
  }

  get published(): readonly {
    stream: string;
    maxLen: number;
    fields: Record<string, string | Uint8Array>;
  }[] {
    return this.#published;
  }

  reset(): void {
    this.#published.length = 0;
    this.#nextId = 1;
    this.#failNext = false;
  }
}

/**
 * Bun-backed implementation. Single `XADD` per fact with `MAXLEN ~`
 * trimming approximate (matches the wire contract documented in the
 * sibling lane handoff).
 *
 * Field encoding matches the consumer's expectation: binary data is
 * sent as a Latin-1-encoded string because `Bun.redis.send()` round-
 * trips bytes that way in RESP2 mode.
 */
export const createBunMatchConcludedStreamClient = (
  client: BunRedisStreamPublisher
): MatchConcludedStreamClient => ({
  backend: 'redis' as const,
  async publish(fields, options) {
    const args: string[] = [options.stream, 'MAXLEN', '~', String(options.maxLen), '*'];
    for (const [key, value] of Object.entries(fields)) {
      args.push(key);
      args.push(typeof value === 'string' ? value : uint8ArrayToBinaryString(value));
    }
    const raw = await client.send('XADD', args);
    return typeof raw === 'string' ? raw : String(raw ?? '');
  },
});

/**
 * Light counters mirroring the shape used by the consumer / ingestion
 * loop so /metrics surfaces them with the same JSON layout. Names
 * follow the `bus_facts_published_*` convention introduced in the
 * publisher on game-service.
 */
export class MatchConcludedPublisherMetrics {
  #published = 0;
  #alreadyEmitted = 0;
  #notTerminal = 0;
  #failed = 0;

  recordPublished(): void {
    this.#published += 1;
  }

  recordAlreadyEmitted(): void {
    this.#alreadyEmitted += 1;
  }

  recordNotTerminal(): void {
    this.#notTerminal += 1;
  }

  recordFailed(): void {
    this.#failed += 1;
  }

  snapshot(): {
    readonly published: number;
    readonly alreadyEmitted: number;
    readonly notTerminal: number;
    readonly failed: number;
  } {
    return {
      published: this.#published,
      alreadyEmitted: this.#alreadyEmitted,
      notTerminal: this.#notTerminal,
      failed: this.#failed,
    };
  }

  reset(): void {
    this.#published = 0;
    this.#alreadyEmitted = 0;
    this.#notTerminal = 0;
    this.#failed = 0;
  }
}

export interface MatchConcludedPublisherLogEntry {
  readonly event: string;
  readonly providerFixtureId?: string;
  readonly providerId?: string;
  readonly providerStatus?: string;
  readonly gameId?: string;
  readonly classification?: MatchTerminalClassification;
  readonly streamId?: string;
  readonly message?: string;
}

export type MatchConcludedPublisherLogger = (entry: MatchConcludedPublisherLogEntry) => void;

const defaultLogger: MatchConcludedPublisherLogger = (entry) => {
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
};

export interface MatchConcludedPublisherOptions {
  readonly stream: MatchConcludedStreamClient;
  readonly emitted?: EmittedFixtureStore;
  readonly metrics?: MatchConcludedPublisherMetrics;
  readonly logger?: MatchConcludedPublisherLogger;
  /** Wall clock; defaulted for tests. */
  readonly now?: () => number;
  /** Override MAXLEN for tests. Production should use the default. */
  readonly maxLen?: number;
  /** Override stream name for tests. Production should use the default. */
  readonly streamName?: string;
}

/**
 * Observe + publish boundary used by the ingestion side.
 *
 * The ingestion loop hands every observed fixture to {@link observe}.
 * The publisher decides whether the fixture is terminal, whether
 * we have already emitted, and (if appropriate) builds + publishes
 * the fact onto Redis Streams.
 *
 * Failures are logged + counted; the loop NEVER throws because that
 * would back-pressure ingest. Recovery for a missed publish is a
 * manual ops task today (the source of truth is the API-Football
 * fixture cache + the game-service `games` table).
 */
export class MatchConcludedPublisher {
  readonly #stream: MatchConcludedStreamClient;
  readonly #emitted: EmittedFixtureStore;
  readonly #metrics: MatchConcludedPublisherMetrics;
  readonly #log: MatchConcludedPublisherLogger;
  readonly #now: () => number;
  readonly #maxLen: number;
  readonly #streamName: string;

  constructor(options: MatchConcludedPublisherOptions) {
    this.#stream = options.stream;
    this.#emitted = options.emitted ?? new InMemoryEmittedFixtureStore();
    this.#metrics = options.metrics ?? new MatchConcludedPublisherMetrics();
    this.#log = options.logger ?? defaultLogger;
    this.#now = options.now ?? Date.now;
    this.#maxLen = options.maxLen ?? MATCH_CONCLUDED_STREAM_MAXLEN;
    this.#streamName = options.streamName ?? MATCH_CONCLUDED_STREAM_NAME;
  }

  get metrics(): MatchConcludedPublisherMetrics {
    return this.#metrics;
  }

  get streamName(): string {
    return this.#streamName;
  }

  get maxLen(): number {
    return this.#maxLen;
  }

  /**
   * Process a single fixture observation.
   *
   * The method classifies the status, gates on the emit-once store,
   * builds the PlatformFact, and pushes it onto the stream. The
   * returned outcome lets the caller log or count without re-doing the
   * classification work.
   */
  async observe(fixture: MatchFixtureObservation): Promise<MatchConcludedObserveOutcome> {
    const classification = classifyApiFootballStatus(fixture.providerStatus);
    if (classification === null) {
      this.#metrics.recordNotTerminal();
      return { outcome: 'not_terminal' };
    }

    const already = await Promise.resolve(
      this.#emitted.hasEmitted(fixture.providerId, fixture.providerFixtureId)
    );
    if (already) {
      this.#metrics.recordAlreadyEmitted();
      this.#log({
        event: 'match_concluded_already_emitted',
        providerFixtureId: fixture.providerFixtureId,
        providerId: fixture.providerId,
        providerStatus: fixture.providerStatus,
        classification,
        gameId: fixture.gameId,
      });
      return { outcome: 'already_emitted' };
    }

    const fact = buildMatchConcludedFact({
      providerFixtureId: fixture.providerFixtureId,
      providerId: fixture.providerId,
      providerStatus: fixture.providerStatus,
      classification,
      gameId: fixture.gameId,
      concludedAtMs: fixture.concludedAtMs,
      emittedAtMs: this.#now(),
    });

    const fields: Record<string, string | Uint8Array> = {
      data: toBinary(PlatformFactSchema, fact),
      event_id: fact.id,
      fact_type: fact.type,
    };

    try {
      const streamId = await this.#stream.publish(fields, {
        stream: this.#streamName,
        maxLen: this.#maxLen,
      });
      // Mark AFTER a successful publish so a failed XADD is naturally
      // retried on the next observation of the same terminal status.
      // Tests for the emit-once gate rely on this ordering.
      await Promise.resolve(
        this.#emitted.markEmitted(fixture.providerId, fixture.providerFixtureId)
      );
      this.#metrics.recordPublished();
      this.#log({
        event: 'match_concluded_published',
        providerFixtureId: fixture.providerFixtureId,
        providerId: fixture.providerId,
        providerStatus: fixture.providerStatus,
        classification,
        gameId: fixture.gameId,
        streamId,
      });
      return { outcome: 'published', fact };
    } catch (err) {
      this.#metrics.recordFailed();
      const message = err instanceof Error ? err.message : String(err);
      this.#log({
        event: 'match_concluded_publish_failed',
        providerFixtureId: fixture.providerFixtureId,
        providerId: fixture.providerId,
        providerStatus: fixture.providerStatus,
        classification,
        gameId: fixture.gameId,
        message,
      });
      return { outcome: 'publish_failed', error: { message } };
    }
  }
}

/**
 * Build the idempotency key carried inside the fact envelope. The
 * shape is shared with the consumer so it can dedupe on the same key
 * without parsing the metadata payload.
 *
 * Format: `match-concluded:<provider_fixture_id>:<provider_status>`.
 * The provider status is included so a fixture that transitioned via
 * a result then was re-emitted with a different terminal status (rare:
 * e.g. AET-resolved match later corrected to PEN) would carry a
 * distinct key. In practice the emit-once store prevents this, but
 * the key remains uniquely traceable.
 */
export const buildMatchConcludedIdempotencyKey = (
  providerFixtureId: string,
  providerStatus: string
): string => `match-concluded:${providerFixtureId}:${providerStatus.trim().toUpperCase()}`;

/**
 * Construct the PlatformFact for emission. Exposed so callers
 * (tests, replay scripts) can build a fact without going through the
 * full `observe()` machinery.
 *
 * Pure function — no side effects, no I/O.
 */
export const buildMatchConcludedFact = (input: {
  readonly providerFixtureId: string;
  readonly providerId: string;
  readonly providerStatus: string;
  readonly classification: MatchTerminalClassification;
  readonly gameId: string;
  readonly concludedAtMs: number;
  readonly emittedAtMs: number;
}): PlatformFact => {
  const normalisedStatus = input.providerStatus.trim().toUpperCase();
  const idempotencyKey = buildMatchConcludedIdempotencyKey(
    input.providerFixtureId,
    normalisedStatus
  );
  const voidReason = input.classification === 'terminal-void' ? normalisedStatus : null;
  const concludedAtIso = new Date(input.concludedAtMs).toISOString();

  const metadata: JsonObject = {
    game_id: input.gameId,
    provider_status: normalisedStatus,
    void_reason: voidReason,
    provider_fixture_id: input.providerFixtureId,
    concluded_at: concludedAtIso,
  };

  return create(PlatformFactSchema, {
    id: idempotencyKey,
    type: MATCH_CONCLUDED_FACT_TYPE,
    sourceService: MATCH_CONCLUDED_SOURCE_SERVICE,
    sourceRecordId: input.gameId,
    metadata,
    occurredAt: create(TimestampSchema, timestampFromMs(input.concludedAtMs)),
    emittedAt: create(TimestampSchema, timestampFromMs(input.emittedAtMs)),
    idempotencyKey,
  });
};

const uint8ArrayToBinaryString = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
};

/** Test-only exports for the internal helpers. */
export const __test = {
  uint8ArrayToBinaryString,
};
