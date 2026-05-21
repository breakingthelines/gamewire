import { create, type JsonObject } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';

import { PrincipalRefSchema } from '@breakingthelines/protos/btl/common/v1/types_pb';
import {
  type PlatformFact,
  PlatformFactSchema,
} from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  type RecordRatingRequest,
  type RecordRatingResponse,
  RecordRatingResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  RatingAggregateSchema,
  RatingScale,
  RatingScopeType,
  RatingSubjectSchema,
  RatingSubjectType,
} from '@breakingthelines/protos/btl/game/v1/types/engagement_pb';

import type { GameServiceRecordRatingClient } from './clients/game-service.js';
import {
  DEFAULT_RATING_BACKOFF_MS,
  InMemoryRatingDeadLetterSink,
  InMemoryRatingDedupeStore,
  RATING_SUBMITTED_FACT_TYPE,
  RatingConsumer,
  RatingConsumerMetrics,
  __test,
  buildRecordRatingRequest,
  parseRatingSubmittedFact,
  type RatingConsumerClock,
  type RatingConsumerOptions,
  type RatingSubmittedPayload,
} from './rating-consumer.js';

interface FactOverrides {
  readonly id?: string;
  readonly type?: string;
  readonly ratingId?: string;
  readonly userId?: string;
  readonly metadata?: JsonObject;
  readonly idempotencyKey?: string;
}

const buildFact = (overrides: FactOverrides = {}): PlatformFact => {
  const metadata: JsonObject = {
    subject_key: 'game:fixture-1',
    subject_type: 'RATING_SUBJECT_TYPE_GAME',
    game_id: 'fixture-1',
    team_id: '',
    player_id: '',
    coach_id: '',
    occurrence_id: '',
    scope_type: 'RATING_SCOPE_TYPE_GLOBAL',
    scope_id: '',
    scale: 'RATING_SCALE_ONE_TO_TEN',
    value: 8,
    thought_id: '',
    ...overrides.metadata,
  };

  return create(PlatformFactSchema, {
    id: overrides.id ?? 'fact-001',
    type: overrides.type ?? RATING_SUBMITTED_FACT_TYPE,
    sourceService: 'game-service',
    sourceRecordId: overrides.ratingId ?? 'rating-001',
    sourceRecordVersion: '1',
    actor: create(PrincipalRefSchema, {
      id: overrides.userId ?? 'user-abc',
      handle: '@example',
    }),
    metadata,
    idempotencyKey: overrides.idempotencyKey ?? 'rating:rating-001',
  });
};

const buildResponse = (applied = true): RecordRatingResponse =>
  create(RecordRatingResponseSchema, {
    applied,
    aggregate: create(RatingAggregateSchema, {
      subject: create(RatingSubjectSchema, {
        type: RatingSubjectType.GAME,
        gameId: 'fixture-1',
      }),
      scopeType: RatingScopeType.GLOBAL,
      scopeId: '',
      scale: RatingScale.ONE_TO_TEN,
      count: 1,
      sum: 8,
      average: 8,
    }),
  });

interface StubbedClient extends GameServiceRecordRatingClient {
  readonly mock: ReturnType<typeof vi.fn>;
}

const stubClient = (
  impl?: (request: RecordRatingRequest) => Promise<RecordRatingResponse>
): StubbedClient => {
  const fn = impl ? vi.fn(impl) : vi.fn().mockResolvedValue(buildResponse());
  return {
    recordRating: fn as unknown as GameServiceRecordRatingClient['recordRating'],
    mock: fn,
  };
};

const fakeClock = (): RatingConsumerClock & { readonly sleeps: number[] } => {
  const sleeps: number[] = [];
  return {
    now: () => 0,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    sleeps,
  };
};

const noopLogger = () => undefined;

const buildConsumer = (
  overrides: Partial<RatingConsumerOptions> & {
    readonly client: GameServiceRecordRatingClient;
  }
): RatingConsumer =>
  new RatingConsumer({
    metrics: new RatingConsumerMetrics(),
    deadLetter: new InMemoryRatingDeadLetterSink(),
    dedupe: new InMemoryRatingDedupeStore(),
    clock: fakeClock(),
    logger: noopLogger,
    ...overrides,
  });

describe('RatingConsumer.handle - happy path', () => {
  it('calls RecordRating with the parsed payload and marks the rating applied', async () => {
    const client = stubClient();
    const dedupe = new InMemoryRatingDedupeStore();
    const metrics = new RatingConsumerMetrics();
    const consumer = buildConsumer({ client, dedupe, metrics });
    const fact = buildFact();

    const result = await consumer.handle(fact);

    expect(result.outcome).toBe('applied');
    expect(result.factId).toBe(fact.id);
    expect(result.ratingId).toBe('rating-001');
    expect(result.attempts).toBe(1);
    expect(result.response?.applied).toBe(true);
    expect(client.mock).toHaveBeenCalledTimes(1);

    const sent = client.mock.mock.calls[0]?.[0] as RecordRatingRequest;
    expect(sent.ratingId).toBe('rating-001');
    expect(sent.userId).toBe('user-abc');
    expect(sent.scopeType).toBe(RatingScopeType.GLOBAL);
    expect(sent.scale).toBe(RatingScale.ONE_TO_TEN);
    expect(sent.value).toBe(8);
    expect(sent.subject?.type).toBe(RatingSubjectType.GAME);
    expect(sent.subject?.gameId).toBe('fixture-1');
    expect(sent.idempotencyKey).toBe('rating:rating-001');

    expect(dedupe.has('rating-001')).toBe(true);
    const snap = metrics.snapshot();
    expect(snap.received).toBe(1);
    expect(snap.applied).toBe(1);
    expect(snap.retried).toBe(0);
  });

  it('reuses the fact id as idempotency key when fact.idempotency_key is empty', async () => {
    const client = stubClient();
    const consumer = buildConsumer({ client });
    const fact = buildFact({ id: 'fact-xyz', idempotencyKey: '' });

    await consumer.handle(fact);
    const sent = client.mock.mock.calls[0]?.[0] as RecordRatingRequest;
    expect(sent.idempotencyKey).toBe('fact-xyz');
  });
});

describe('RatingConsumer.handle - dedupe', () => {
  it('short-circuits a second event with the same rating_id without calling RecordRating', async () => {
    const client = stubClient();
    const dedupe = new InMemoryRatingDedupeStore();
    const metrics = new RatingConsumerMetrics();
    const consumer = buildConsumer({ client, dedupe, metrics });

    const first = await consumer.handle(buildFact({ id: 'fact-1' }));
    expect(first.outcome).toBe('applied');

    const second = await consumer.handle(buildFact({ id: 'fact-2' }));
    expect(second.outcome).toBe('duplicate');
    expect(second.attempts).toBe(0);
    expect(client.mock).toHaveBeenCalledTimes(1);

    const snap = metrics.snapshot();
    expect(snap.received).toBe(2);
    expect(snap.applied).toBe(1);
    expect(snap.duplicates).toBe(1);
  });
});

describe('RatingConsumer.handle - filtering and validation', () => {
  it('ignores facts with a different type', async () => {
    const client = stubClient();
    const consumer = buildConsumer({ client });
    const result = await consumer.handle(buildFact({ type: 'game.prediction.submitted' }));
    expect(result.outcome).toBe('ignored');
    expect(client.mock).not.toHaveBeenCalled();
  });

  it('dead-letters malformed facts (missing actor.id) without calling RecordRating', async () => {
    const client = stubClient();
    const sink = new InMemoryRatingDeadLetterSink();
    const consumer = buildConsumer({ client, deadLetter: sink });
    const result = await consumer.handle(buildFact({ userId: '' }));

    expect(result.outcome).toBe('dead_letter_permanent');
    expect(result.error?.permanent).toBe(true);
    expect(result.error?.message).toMatch(/actor\.id/);
    expect(client.mock).not.toHaveBeenCalled();
    expect(sink.size()).toBe(1);
    expect(sink.entries()[0]?.reason).toBe('malformed_event');
  });

  it('dead-letters facts with an invalid scale', async () => {
    const client = stubClient();
    const consumer = buildConsumer({ client });
    const result = await consumer.handle(buildFact({ metadata: { scale: 'NOT_A_REAL_SCALE' } }));
    expect(result.outcome).toBe('dead_letter_permanent');
    expect(result.error?.message).toMatch(/scale/);
    expect(client.mock).not.toHaveBeenCalled();
  });

  it('dead-letters facts with a non-positive value', async () => {
    const client = stubClient();
    const consumer = buildConsumer({ client });
    const result = await consumer.handle(buildFact({ metadata: { value: 0 } }));
    expect(result.outcome).toBe('dead_letter_permanent');
    expect(result.error?.message).toMatch(/positive integer/);
  });
});

describe('RatingConsumer.handle - transient errors', () => {
  it('retries with exponential backoff and applies on a later attempt', async () => {
    let attempt = 0;
    const client = stubClient(async () => {
      attempt += 1;
      if (attempt <= 2) {
        throw new ConnectError('upstream', Code.Unavailable);
      }
      return buildResponse();
    });
    const clock = fakeClock();
    const metrics = new RatingConsumerMetrics();
    const consumer = buildConsumer({ client, clock, metrics });

    const result = await consumer.handle(buildFact());

    expect(result.outcome).toBe('applied');
    expect(result.attempts).toBe(3);
    expect(client.mock).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([DEFAULT_RATING_BACKOFF_MS[0], DEFAULT_RATING_BACKOFF_MS[1]]);

    const snap = metrics.snapshot();
    expect(snap.retried).toBe(2);
    expect(snap.applied).toBe(1);
  });

  it('treats a plain Error as transient and retries', async () => {
    let attempt = 0;
    const client = stubClient(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('network glitch');
      }
      return buildResponse();
    });
    const clock = fakeClock();
    const consumer = buildConsumer({ client, clock });

    const result = await consumer.handle(buildFact());
    expect(result.outcome).toBe('applied');
    expect(result.attempts).toBe(2);
    expect(clock.sleeps).toEqual([DEFAULT_RATING_BACKOFF_MS[0]]);
  });

  it('dead-letters with retries_exhausted when every attempt fails transiently', async () => {
    const client = stubClient(async () => {
      throw new ConnectError('still down', Code.Unavailable);
    });
    const backoff = [1, 1, 1] as const;
    const clock = fakeClock();
    const sink = new InMemoryRatingDeadLetterSink();
    const metrics = new RatingConsumerMetrics();
    const consumer = buildConsumer({
      client,
      deadLetter: sink,
      backoffMs: backoff,
      clock,
      metrics,
    });

    const result = await consumer.handle(buildFact());

    expect(result.outcome).toBe('dead_letter_exhausted');
    expect(result.error?.permanent).toBe(false);
    expect(result.error?.code).toBe('Unavailable');
    expect(result.attempts).toBe(backoff.length + 1);
    expect(client.mock).toHaveBeenCalledTimes(backoff.length + 1);
    expect(clock.sleeps).toEqual([1, 1, 1]);

    expect(sink.size()).toBe(1);
    const entry = sink.entries()[0];
    expect(entry?.reason).toBe('retries_exhausted');
    expect(entry?.attempts).toBe(backoff.length + 1);
    expect(entry?.request?.ratingId).toBe('rating-001');

    const snap = metrics.snapshot();
    expect(snap.retried).toBe(backoff.length);
    expect(snap.deadLetteredExhausted).toBe(1);
  });
});

describe('RatingConsumer.handle - permanent errors', () => {
  it.each<[string, Code]>([
    ['InvalidArgument', Code.InvalidArgument],
    ['NotFound', Code.NotFound],
    ['PermissionDenied', Code.PermissionDenied],
    ['Unauthenticated', Code.Unauthenticated],
    ['FailedPrecondition', Code.FailedPrecondition],
    ['OutOfRange', Code.OutOfRange],
    ['Unimplemented', Code.Unimplemented],
  ])('dead-letters %s on the first attempt without retrying', async (_name, code) => {
    const client = stubClient(async () => {
      throw new ConnectError('bad input', code);
    });
    const clock = fakeClock();
    const sink = new InMemoryRatingDeadLetterSink();
    const consumer = buildConsumer({ client, clock, deadLetter: sink });

    const result = await consumer.handle(buildFact());

    expect(result.outcome).toBe('dead_letter_permanent');
    expect(result.attempts).toBe(1);
    expect(result.error?.permanent).toBe(true);
    expect(client.mock).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
    expect(sink.size()).toBe(1);
    expect(sink.entries()[0]?.reason).toBe('permanent_error');
  });

  it('does not remember the rating in the dedupe store on a permanent error', async () => {
    const client = stubClient(async () => {
      throw new ConnectError('nope', Code.InvalidArgument);
    });
    const dedupe = new InMemoryRatingDedupeStore();
    const consumer = buildConsumer({ client, dedupe });

    await consumer.handle(buildFact());
    expect(dedupe.has('rating-001')).toBe(false);
  });
});

describe('parseRatingSubmittedFact', () => {
  it('rejects facts with the wrong type', () => {
    const fact = buildFact({ type: 'unrelated' });
    const result = parseRatingSubmittedFact(fact);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unexpected fact type/);
    }
  });

  it('requires source_record_id', () => {
    const fact = buildFact({ ratingId: '' });
    const result = parseRatingSubmittedFact(fact);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/source_record_id/);
    }
  });

  it('returns a typed payload on a valid fact', () => {
    const fact = buildFact();
    const result = parseRatingSubmittedFact(fact);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.ratingId).toBe('rating-001');
      expect(result.payload.userId).toBe('user-abc');
      expect(result.payload.scopeType).toBe(RatingScopeType.GLOBAL);
      expect(result.payload.scale).toBe(RatingScale.ONE_TO_TEN);
      expect(result.payload.value).toBe(8);
      expect(result.payload.subject.type).toBe(RatingSubjectType.GAME);
      expect(result.payload.subject.gameId).toBe('fixture-1');
    }
  });

  it('accepts both bare and prefixed enum spellings in metadata', () => {
    const fact = buildFact({
      metadata: {
        subject_type: 'PLAYER_PERFORMANCE',
        scope_type: 'PRIVATE',
        scale: 'BTL_INVERSE_ONE_TO_SIX',
        player_id: 'player-99',
        value: 2,
      },
    });
    const result = parseRatingSubmittedFact(fact);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.subject.type).toBe(RatingSubjectType.PLAYER_PERFORMANCE);
      expect(result.payload.scopeType).toBe(RatingScopeType.PRIVATE);
      expect(result.payload.scale).toBe(RatingScale.BTL_INVERSE_ONE_TO_SIX);
      expect(result.payload.subject.playerId).toBe('player-99');
      expect(result.payload.value).toBe(2);
    }
  });

  it('accepts metadata.value supplied as a numeric string', () => {
    const fact = buildFact({ metadata: { value: '7' } });
    const result = parseRatingSubmittedFact(fact);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.value).toBe(7);
    }
  });
});

describe('buildRecordRatingRequest', () => {
  it('mirrors the payload into a RecordRatingRequest', () => {
    const fact = buildFact();
    const parsed = parseRatingSubmittedFact(fact);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const request = buildRecordRatingRequest(parsed.payload as RatingSubmittedPayload);
    expect(request.ratingId).toBe('rating-001');
    expect(request.userId).toBe('user-abc');
    expect(request.scopeType).toBe(RatingScopeType.GLOBAL);
    expect(request.scale).toBe(RatingScale.ONE_TO_TEN);
    expect(request.value).toBe(8);
    expect(request.subject?.type).toBe(RatingSubjectType.GAME);
    expect(request.idempotencyKey).toBe('rating:rating-001');
  });
});

describe('__test.classifyError', () => {
  it('marks ConnectError(Unavailable) as transient', () => {
    const classification = __test.classifyError(new ConnectError('x', Code.Unavailable));
    expect(classification.permanent).toBe(false);
    expect(classification.codeName).toBe('Unavailable');
  });

  it('marks ConnectError(InvalidArgument) as permanent', () => {
    const classification = __test.classifyError(new ConnectError('x', Code.InvalidArgument));
    expect(classification.permanent).toBe(true);
    expect(classification.codeName).toBe('InvalidArgument');
  });

  it('marks bare Error instances as transient', () => {
    const classification = __test.classifyError(new Error('boom'));
    expect(classification.permanent).toBe(false);
    expect(classification.codeName).toBeUndefined();
  });
});

describe('InMemoryRatingDedupeStore', () => {
  it('reports remembered ids as seen and bounds growth', () => {
    const store = new InMemoryRatingDedupeStore(2);
    store.remember('a');
    store.remember('b');
    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(true);
    store.remember('c');
    expect(store.size()).toBe(2);
    expect(store.has('c')).toBe(true);
    // Oldest insertion has been evicted.
    expect(store.has('a')).toBe(false);
  });
});

describe('InMemoryRatingDeadLetterSink', () => {
  it('keeps the most recent entries within the bound', () => {
    const sink = new InMemoryRatingDeadLetterSink(2);
    for (let i = 0; i < 5; i += 1) {
      sink.capture({
        factId: `f-${i}`,
        ratingId: `r-${i}`,
        reason: 'permanent_error',
        attempts: 1,
        fact: buildFact({ id: `f-${i}`, ratingId: `r-${i}` }),
        error: { message: 'x' },
      });
    }
    const entries = sink.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.factId).toBe('f-3');
    expect(entries[1]?.factId).toBe('f-4');
  });
});
