import { create, toBinary, type JsonObject } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import { PrincipalRefSchema } from '@breakingthelines/protos/btl/common/v1/types_pb';
import {
  type PlatformFact,
  PlatformFactSchema,
} from '@breakingthelines/protos/btl/context/v1/context_pb';

import {
  DLQ_STREAM_NAME,
  InMemoryAttemptCounter,
  MAX_RETRIES,
  RedisStreamConsumer,
  RedisStreamConsumerMetrics,
  STREAM_NAME_PREFIX,
  __test,
  createBunRedisStreamClient,
  streamNameFor,
  type RedisStreamClient,
  type StreamEntry,
  type StreamFactHandler,
} from './redis-stream-consumer.js';

const RATING_FACT_TYPE = 'game.rating.submitted';
const RATING_STREAM = streamNameFor(RATING_FACT_TYPE);
const RATING_GROUP = 'gamewire-rating';

const buildFact = (overrides: { id?: string; ratingId?: string } = {}): PlatformFact => {
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
  };
  return create(PlatformFactSchema, {
    id: overrides.id ?? 'fact-001',
    type: RATING_FACT_TYPE,
    sourceService: 'game-service',
    sourceRecordId: overrides.ratingId ?? 'rating-001',
    sourceRecordVersion: '1',
    actor: create(PrincipalRefSchema, { id: 'user-abc', handle: '@example' }),
    metadata,
    idempotencyKey: `rating:${overrides.ratingId ?? 'rating-001'}`,
  });
};

const entryFor = (id: string, fact: PlatformFact): StreamEntry => ({
  id,
  fields: {
    data: toBinary(PlatformFactSchema, fact),
    event_id: new TextEncoder().encode(fact.id),
    fact_type: new TextEncoder().encode(fact.type),
  },
});

interface StubBatch {
  readonly stream: string;
  readonly entries: readonly StreamEntry[];
}

interface StubXAdd {
  readonly stream: string;
  readonly fields: Record<string, string | Uint8Array>;
}

interface BuiltStub {
  client: RedisStreamClient;
  groups: { stream: string; group: string; startId: string }[];
  acks: { stream: string; group: string; id: string }[];
  xadds: StubXAdd[];
  enqueue(batches: readonly StubBatch[]): void;
}

const buildStubClient = (overrides: Partial<RedisStreamClient> = {}): BuiltStub => {
  const groups: { stream: string; group: string; startId: string }[] = [];
  const acks: { stream: string; group: string; id: string }[] = [];
  const xadds: StubXAdd[] = [];
  const queued: (readonly StubBatch[])[] = [];
  const client: RedisStreamClient = {
    async xGroupCreateMkStream(stream, group, startId) {
      groups.push({ stream, group, startId });
    },
    async xReadGroup() {
      return queued.shift() ?? [];
    },
    async xAck(stream, group, id) {
      acks.push({ stream, group, id });
      return 1;
    },
    async xAdd(stream, fields) {
      xadds.push({ stream, fields });
      return '1-0';
    },
    ...overrides,
  };
  return {
    client,
    groups,
    acks,
    xadds,
    enqueue(batches: readonly StubBatch[]) {
      queued.push(batches);
    },
  };
};

describe('RedisStreamConsumer', () => {
  it('ensureGroups calls xGroupCreateMkStream for every subscription', async () => {
    const stub = buildStubClient();
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      logger: () => {},
    });
    consumer.subscribe({
      factType: RATING_FACT_TYPE,
      group: RATING_GROUP,
      handler: async () => true,
    });

    await consumer.ensureGroups();

    expect(stub.groups).toEqual([
      { stream: RATING_STREAM, group: RATING_GROUP, startId: '$' },
    ]);
  });

  it('decodes the data field, calls the handler, and XACKs on success', async () => {
    const stub = buildStubClient();
    const fact = buildFact();
    stub.enqueue([{ stream: RATING_STREAM, entries: [entryFor('100-0', fact)] }]);

    const handler: StreamFactHandler = vi.fn(async () => true);
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      logger: () => {},
    });
    consumer.subscribe({ factType: RATING_FACT_TYPE, group: RATING_GROUP, handler });

    await consumer.tickOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    const call = (handler as ReturnType<typeof vi.fn>).mock.calls[0] as [
      PlatformFact,
      { factType: string; streamId: string; eventId: string; attempt: number },
    ];
    expect(call[0].id).toBe(fact.id);
    expect(call[0].sourceRecordId).toBe(fact.sourceRecordId);
    expect(call[1].factType).toBe(RATING_FACT_TYPE);
    expect(call[1].streamId).toBe('100-0');
    expect(call[1].eventId).toBe(fact.id);
    expect(call[1].attempt).toBe(1);
    expect(stub.acks).toEqual([
      { stream: RATING_STREAM, group: RATING_GROUP, id: '100-0' },
    ]);
    expect(stub.xadds).toEqual([]);
  });

  it('does not ACK and counts the attempt when the handler returns false', async () => {
    const stub = buildStubClient();
    const fact = buildFact();
    stub.enqueue([{ stream: RATING_STREAM, entries: [entryFor('200-0', fact)] }]);

    const handler = vi.fn(async () => false);
    const metrics = new RedisStreamConsumerMetrics();
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      metrics,
      logger: () => {},
    });
    consumer.subscribe({ factType: RATING_FACT_TYPE, group: RATING_GROUP, handler });

    await consumer.tickOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(stub.acks).toEqual([]);
    expect(stub.xadds).toEqual([]);
    const snapshot = metrics.snapshot();
    expect(snapshot.outcomes[RATING_FACT_TYPE]?.error).toBe(1);
    expect(snapshot.outcomes[RATING_FACT_TYPE]?.ok).toBe(0);
  });

  it('treats handler throws as transient errors', async () => {
    const stub = buildStubClient();
    const fact = buildFact();
    stub.enqueue([{ stream: RATING_STREAM, entries: [entryFor('300-0', fact)] }]);

    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      logger: () => {},
    });
    consumer.subscribe({ factType: RATING_FACT_TYPE, group: RATING_GROUP, handler });

    await consumer.tickOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(stub.acks).toEqual([]);
  });

  it('DLQs and ACKs after MAX_RETRIES failures', async () => {
    const stub = buildStubClient();
    const fact = buildFact();
    const handler = vi.fn(async () => false);
    const metrics = new RedisStreamConsumerMetrics();
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      metrics,
      logger: () => {},
    });
    consumer.subscribe({ factType: RATING_FACT_TYPE, group: RATING_GROUP, handler });

    for (let i = 0; i < MAX_RETRIES; i += 1) {
      stub.enqueue([
        { stream: RATING_STREAM, entries: [entryFor(`400-${i}`, fact)] },
      ]);
      // We re-deliver the same fact id MAX_RETRIES times to simulate a
      // claim-and-redeliver loop. The attempt counter is keyed by fact.id
      // so the count climbs even though stream ids differ.
      // The first MAX_RETRIES - 1 calls leave the entry pending; the
      // final one DLQs + ACKs.
      // eslint-disable-next-line no-await-in-loop
      await consumer.tickOnce();
    }

    expect(handler).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(stub.xadds).toHaveLength(1);
    const dlq = stub.xadds[0];
    expect(dlq.stream).toBe(DLQ_STREAM_NAME);
    expect(dlq.fields.original_stream).toBe(RATING_STREAM);
    expect(dlq.fields.fact_type).toBe(RATING_FACT_TYPE);
    expect(dlq.fields.event_id).toBe(fact.id);
    expect(dlq.fields.reason).toBe('retries_exhausted');
    expect(dlq.fields.data).toBeInstanceOf(Uint8Array);
    expect(stub.acks).toEqual([
      { stream: RATING_STREAM, group: RATING_GROUP, id: `400-${MAX_RETRIES - 1}` },
    ]);
    const snapshot = metrics.snapshot();
    expect(snapshot.dlq[RATING_FACT_TYPE]).toBe(1);
  });

  it('DLQs entries whose data field cannot be decoded', async () => {
    const stub = buildStubClient();
    const malformed: StreamEntry = {
      id: '500-0',
      fields: {
        data: new Uint8Array([0xff, 0xff, 0xff]),
        event_id: new TextEncoder().encode('fact-500'),
        fact_type: new TextEncoder().encode(RATING_FACT_TYPE),
      },
    };
    stub.enqueue([{ stream: RATING_STREAM, entries: [malformed] }]);

    const handler = vi.fn(async () => true);
    const metrics = new RedisStreamConsumerMetrics();
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      metrics,
      logger: () => {},
    });
    consumer.subscribe({ factType: RATING_FACT_TYPE, group: RATING_GROUP, handler });

    await consumer.tickOnce();

    expect(handler).not.toHaveBeenCalled();
    expect(stub.xadds).toHaveLength(1);
    expect(stub.xadds[0].fields.reason).toBe('decode_error');
    expect(stub.acks).toEqual([
      { stream: RATING_STREAM, group: RATING_GROUP, id: '500-0' },
    ]);
    expect(metrics.snapshot().outcomes[RATING_FACT_TYPE]?.malformed).toBe(1);
  });

  it('DLQs entries with a missing data field', async () => {
    const stub = buildStubClient();
    const empty: StreamEntry = {
      id: '600-0',
      fields: {
        event_id: new TextEncoder().encode('fact-600'),
        fact_type: new TextEncoder().encode(RATING_FACT_TYPE),
      },
    };
    stub.enqueue([{ stream: RATING_STREAM, entries: [empty] }]);

    const consumer = new RedisStreamConsumer({
      client: stub.client,
      logger: () => {},
    });
    consumer.subscribe({
      factType: RATING_FACT_TYPE,
      group: RATING_GROUP,
      handler: async () => true,
    });

    await consumer.tickOnce();

    expect(stub.xadds).toHaveLength(1);
    expect(stub.xadds[0].fields.reason).toBe('missing_data');
    expect(stub.acks).toEqual([
      { stream: RATING_STREAM, group: RATING_GROUP, id: '600-0' },
    ]);
  });

  it('keeps the entry pending when XACK fails after a DLQ publish', async () => {
    let ackCalled = false;
    const stub = buildStubClient({
      async xAck(_stream, _group, _id) {
        ackCalled = true;
        throw new Error('redis ack down');
      },
    });
    const fact = buildFact();
    stub.enqueue([{ stream: RATING_STREAM, entries: [entryFor('700-0', fact)] }]);

    const consumer = new RedisStreamConsumer({
      client: stub.client,
      logger: () => {},
    });
    consumer.subscribe({
      factType: RATING_FACT_TYPE,
      group: RATING_GROUP,
      handler: async () => true,
    });

    await consumer.tickOnce();

    expect(ackCalled).toBe(true);
    // No throw, no DLQ — the handler succeeded; only the ACK failed.
    expect(stub.xadds).toEqual([]);
  });

  it('rejects double subscription registration after run() has started', () => {
    const stub = buildStubClient();
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      logger: () => {},
    });
    consumer.subscribe({
      factType: RATING_FACT_TYPE,
      group: RATING_GROUP,
      handler: async () => true,
    });
    const controller = new AbortController();
    // Kick off the loop and immediately abort so the test doesn't hang.
    controller.abort();
    return consumer.run(controller.signal).then(() => {
      expect(() =>
        consumer.subscribe({
          factType: 'game.prediction.submitted',
          group: 'gamewire-prediction',
          handler: async () => true,
        })
      ).not.toThrow(); // After run() exits the flag is cleared.
    });
  });

  it('does not retry inline when XREADGROUP throws', async () => {
    const stub = buildStubClient({
      async xReadGroup() {
        throw new Error('redis down');
      },
    });
    const consumer = new RedisStreamConsumer({
      client: stub.client,
      logger: () => {},
    });
    consumer.subscribe({
      factType: RATING_FACT_TYPE,
      group: RATING_GROUP,
      handler: async () => true,
    });

    // tickOnce must not throw even though XREADGROUP did.
    await expect(consumer.tickOnce()).resolves.toBeUndefined();
  });
});

describe('streamNameFor', () => {
  it('joins the prefix with the fact type', () => {
    expect(streamNameFor('game.rating.submitted')).toBe(
      `${STREAM_NAME_PREFIX}game.rating.submitted`
    );
  });
});

describe('InMemoryAttemptCounter', () => {
  it('counts up per event id and resets on demand', () => {
    const counter = new InMemoryAttemptCounter();
    expect(counter.increment('fact-1')).toBe(1);
    expect(counter.increment('fact-1')).toBe(2);
    expect(counter.increment('fact-2')).toBe(1);
    counter.reset('fact-1');
    expect(counter.increment('fact-1')).toBe(1);
  });

  it('evicts oldest entries when the cap is reached', () => {
    const counter = new InMemoryAttemptCounter(2);
    counter.increment('a');
    counter.increment('b');
    counter.increment('c');
    expect(counter.size()).toBe(2);
  });
});

describe('createBunRedisStreamClient', () => {
  const buildBun = () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const queue: unknown[] = [];
    return {
      calls,
      enqueue(value: unknown) {
        queue.push(value);
      },
      client: {
        async send(cmd: string, args: string[]) {
          calls.push({ cmd, args });
          if (queue.length === 0) {
            return null;
          }
          return queue.shift();
        },
      },
    };
  };

  it('swallows BUSYGROUP errors on xGroupCreateMkStream', async () => {
    const bun = buildBun();
    const client = createBunRedisStreamClient({
      async send() {
        const err = new Error('BUSYGROUP Consumer Group name already exists');
        throw err;
      },
    });
    await expect(
      client.xGroupCreateMkStream('btl:facts:test', 'g', '$')
    ).resolves.toBeUndefined();
    void bun;
  });

  it('rethrows non-BUSYGROUP errors on xGroupCreateMkStream', async () => {
    const client = createBunRedisStreamClient({
      async send() {
        throw new Error('connection refused');
      },
    });
    await expect(
      client.xGroupCreateMkStream('btl:facts:test', 'g', '$')
    ).rejects.toThrow('connection refused');
  });

  it('serialises XREADGROUP arguments in the documented order', async () => {
    const bun = buildBun();
    bun.enqueue(null);
    const client = createBunRedisStreamClient(bun.client);
    await client.xReadGroup({
      group: 'gamewire-rating',
      consumer: 'host:42',
      blockMs: 5000,
      count: 16,
      streams: [{ stream: 'btl:facts:game.rating.submitted', id: '>' }],
    });
    expect(bun.calls).toHaveLength(1);
    expect(bun.calls[0].cmd).toBe('XREADGROUP');
    expect(bun.calls[0].args).toEqual([
      'GROUP',
      'gamewire-rating',
      'host:42',
      'COUNT',
      '16',
      'BLOCK',
      '5000',
      'STREAMS',
      'btl:facts:game.rating.submitted',
      '>',
    ]);
  });

  it('round-trips binary stream payloads through XREADGROUP', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0xff, 0xfe]);
    const encoded = __test.uint8ArrayToBinaryString(bytes);
    const decoded = __test.binaryStringToUint8Array(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('parses an XREADGROUP reply into typed StreamEntry objects', () => {
    const reply = [
      [
        'btl:facts:game.rating.submitted',
        [['1-0', ['event_id', 'fact-1', 'data', '\x01\x02\x03']]],
      ],
    ];
    const parsed = __test.parseXReadGroupReply(reply);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].stream).toBe('btl:facts:game.rating.submitted');
    expect(parsed[0].entries).toHaveLength(1);
    expect(parsed[0].entries[0].id).toBe('1-0');
    expect(parsed[0].entries[0].fields.data).toBeInstanceOf(Uint8Array);
    expect(parsed[0].entries[0].fields.event_id).toBeInstanceOf(Uint8Array);
  });
});
