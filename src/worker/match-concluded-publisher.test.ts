import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  type PlatformFact,
  PlatformFactSchema,
} from '@breakingthelines/protos/btl/context/v1/context_pb';

import {
  InMemoryEmittedFixtureStore,
  InMemoryMatchConcludedStreamClient,
  MATCH_CONCLUDED_FACT_TYPE,
  MATCH_CONCLUDED_SOURCE_SERVICE,
  MATCH_CONCLUDED_STREAM_MAXLEN,
  MATCH_CONCLUDED_STREAM_NAME,
  MatchConcludedPublisher,
  MatchConcludedPublisherMetrics,
  TERMINAL_RESULT_STATUSES,
  TERMINAL_VOID_STATUSES,
  buildMatchConcludedFact,
  buildMatchConcludedIdempotencyKey,
  classifyApiFootballStatus,
  createBunMatchConcludedStreamClient,
  factStreamFields,
} from './match-concluded-publisher.js';

const decodeBinary = (bytes: Uint8Array): PlatformFact => fromBinary(PlatformFactSchema, bytes);

const noopLogger = (): void => {
  /* swallow logs in unit tests */
};

describe('classifyApiFootballStatus', () => {
  it('classifies FT, AET, PEN as terminal-result', () => {
    expect(classifyApiFootballStatus('FT')).toBe('terminal-result');
    expect(classifyApiFootballStatus('AET')).toBe('terminal-result');
    expect(classifyApiFootballStatus('PEN')).toBe('terminal-result');
  });

  it('classifies PST, ABD, AWD, WO as terminal-void', () => {
    expect(classifyApiFootballStatus('PST')).toBe('terminal-void');
    expect(classifyApiFootballStatus('ABD')).toBe('terminal-void');
    expect(classifyApiFootballStatus('AWD')).toBe('terminal-void');
    expect(classifyApiFootballStatus('WO')).toBe('terminal-void');
  });

  it('returns null for non-terminal statuses (NS, 1H, HT, 2H, ET, BT, P, SUSP, INT, CANC, TBD)', () => {
    for (const status of ['NS', '1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'CANC', 'TBD']) {
      expect(classifyApiFootballStatus(status)).toBeNull();
    }
  });

  it('normalises casing and whitespace', () => {
    expect(classifyApiFootballStatus(' ft ')).toBe('terminal-result');
    expect(classifyApiFootballStatus('pst')).toBe('terminal-void');
    expect(classifyApiFootballStatus(' AeT')).toBe('terminal-result');
  });

  it('returns null for null/undefined/empty inputs', () => {
    expect(classifyApiFootballStatus(null)).toBeNull();
    expect(classifyApiFootballStatus(undefined)).toBeNull();
    expect(classifyApiFootballStatus('')).toBeNull();
    expect(classifyApiFootballStatus('   ')).toBeNull();
  });

  it('terminal sets do not overlap and together do not include any non-terminal status', () => {
    for (const s of TERMINAL_RESULT_STATUSES) {
      expect(TERMINAL_VOID_STATUSES.has(s)).toBe(false);
    }
    for (const s of TERMINAL_VOID_STATUSES) {
      expect(TERMINAL_RESULT_STATUSES.has(s)).toBe(false);
    }
    for (const non of ['NS', '1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'CANC', 'TBD']) {
      expect(TERMINAL_RESULT_STATUSES.has(non)).toBe(false);
      expect(TERMINAL_VOID_STATUSES.has(non)).toBe(false);
    }
  });
});

describe('buildMatchConcludedIdempotencyKey', () => {
  it('uses the documented format and uppercases the status', () => {
    expect(buildMatchConcludedIdempotencyKey('1917', 'FT')).toBe('match-concluded:1917:FT');
    expect(buildMatchConcludedIdempotencyKey('1917', 'ft')).toBe('match-concluded:1917:FT');
    expect(buildMatchConcludedIdempotencyKey('  42  ', 'pst')).toBe('match-concluded:  42  :PST');
  });
});

describe('buildMatchConcludedFact', () => {
  const baseInput = {
    providerFixtureId: '1917',
    providerId: 'api-football',
    providerStatus: 'FT',
    gameId: 'btl_football_game_api_football_1917',
    concludedAtMs: 1_700_000_000_000,
    emittedAtMs: 1_700_000_030_000,
  } as const;

  it('builds a fact with the correct envelope for terminal-result', () => {
    const fact = buildMatchConcludedFact({
      ...baseInput,
      classification: 'terminal-result',
    });

    expect(fact.type).toBe(MATCH_CONCLUDED_FACT_TYPE);
    expect(fact.sourceService).toBe(MATCH_CONCLUDED_SOURCE_SERVICE);
    expect(fact.sourceRecordId).toBe(baseInput.gameId);
    expect(fact.id).toBe('match-concluded:1917:FT');
    expect(fact.idempotencyKey).toBe('match-concluded:1917:FT');
    expect(fact.metadata?.game_id).toBe(baseInput.gameId);
    expect(fact.metadata?.provider_status).toBe('FT');
    expect(fact.metadata?.void_reason).toBeNull();
    expect(fact.metadata?.provider_fixture_id).toBe('1917');
    expect(typeof fact.metadata?.concluded_at).toBe('string');
    expect(fact.metadata?.concluded_at).toBe(new Date(baseInput.concludedAtMs).toISOString());
    expect(fact.occurredAt?.seconds).toBe(BigInt(baseInput.concludedAtMs / 1000));
    expect(fact.emittedAt?.seconds).toBe(BigInt(baseInput.emittedAtMs / 1000));
  });

  it('sets void_reason to the provider status for terminal-void', () => {
    for (const status of ['PST', 'ABD', 'AWD', 'WO']) {
      const fact = buildMatchConcludedFact({
        ...baseInput,
        providerStatus: status,
        classification: 'terminal-void',
      });
      expect(fact.metadata?.void_reason).toBe(status);
      expect(fact.metadata?.provider_status).toBe(status);
      expect(fact.idempotencyKey).toBe(`match-concluded:1917:${status}`);
    }
  });

  it('round-trips through protobuf binary encoding losslessly', () => {
    const fact = buildMatchConcludedFact({
      ...baseInput,
      classification: 'terminal-result',
    });
    // Marshal/unmarshal cycle proves the consumer side will see the
    // same field values.
    const bin = toBinary(PlatformFactSchema, fact);
    const decoded = decodeBinary(bin);
    expect(decoded.type).toBe(MATCH_CONCLUDED_FACT_TYPE);
    expect(decoded.metadata?.game_id).toBe(baseInput.gameId);
    expect(decoded.metadata?.void_reason).toBeNull();
  });

  it('normalises the status case before placing it in metadata', () => {
    const fact = buildMatchConcludedFact({
      ...baseInput,
      providerStatus: 'ft',
      classification: 'terminal-result',
    });
    expect(fact.metadata?.provider_status).toBe('FT');
    expect(fact.idempotencyKey).toBe('match-concluded:1917:FT');
  });
});

describe('InMemoryEmittedFixtureStore', () => {
  it('returns false until markEmitted is called, then true', () => {
    const store = new InMemoryEmittedFixtureStore();
    expect(store.hasEmitted('api-football', '1917')).toBe(false);
    expect(store.markEmitted('api-football', '1917')).toBe(true);
    expect(store.hasEmitted('api-football', '1917')).toBe(true);
  });

  it('keys by (provider, fixture_id) tuple, not fixture_id alone', () => {
    const store = new InMemoryEmittedFixtureStore();
    store.markEmitted('api-football', '1917');
    expect(store.hasEmitted('api-football', '1917')).toBe(true);
    expect(store.hasEmitted('sportmonks', '1917')).toBe(false);
  });

  it('is idempotent on repeated markEmitted calls', () => {
    const store = new InMemoryEmittedFixtureStore();
    expect(store.markEmitted('api-football', '1917')).toBe(true);
    expect(store.markEmitted('api-football', '1917')).toBe(false);
    expect(store.markEmitted('api-football', '1917')).toBe(false);
    expect(store.size()).toBe(1);
  });

  it('can clear a reserved marker after a failed publish', () => {
    const store = new InMemoryEmittedFixtureStore();
    expect(store.markEmitted('api-football', '1917')).toBe(true);
    expect(store.hasEmitted('api-football', '1917')).toBe(true);

    store.clearEmitted('api-football', '1917');

    expect(store.hasEmitted('api-football', '1917')).toBe(false);
    expect(store.markEmitted('api-football', '1917')).toBe(true);
  });

  it('evicts oldest entry when bound is exceeded', () => {
    const store = new InMemoryEmittedFixtureStore(2);
    store.markEmitted('api-football', '1');
    store.markEmitted('api-football', '2');
    store.markEmitted('api-football', '3');
    expect(store.size()).toBe(2);
    expect(store.hasEmitted('api-football', '1')).toBe(false);
    expect(store.hasEmitted('api-football', '2')).toBe(true);
    expect(store.hasEmitted('api-football', '3')).toBe(true);
  });
});

describe('MatchConcludedPublisher.observe', () => {
  const fixtureObservation = (
    overrides: Partial<{
      providerFixtureId: string;
      gameId: string;
      providerStatus: string;
      concludedAtMs: number;
      providerId: string;
    }> = {}
  ) => ({
    providerFixtureId: overrides.providerFixtureId ?? '1917',
    gameId: overrides.gameId ?? 'btl_football_game_api_football_1917',
    providerStatus: overrides.providerStatus ?? 'FT',
    concludedAtMs: overrides.concludedAtMs ?? 1_700_000_000_000,
    providerId: overrides.providerId ?? 'api-football',
  });

  it('publishes a fact to the canonical stream with the correct MAXLEN cap for terminal-result statuses', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const metrics = new MatchConcludedPublisherMetrics();
    const publisher = new MatchConcludedPublisher({
      stream,
      metrics,
      logger: noopLogger,
      now: () => 1_700_000_030_000,
    });

    const result = await publisher.observe(fixtureObservation({ providerStatus: 'FT' }));

    expect(result.outcome).toBe('published');
    expect(stream.published).toHaveLength(1);
    expect(stream.published[0].stream).toBe(MATCH_CONCLUDED_STREAM_NAME);
    expect(stream.published[0].stream).toBe('btl:facts:game.match.concluded');
    expect(stream.published[0].maxLen).toBe(MATCH_CONCLUDED_STREAM_MAXLEN);
    expect(stream.published[0].maxLen).toBe(10_000);
    expect(metrics.snapshot()).toEqual({
      published: 1,
      alreadyEmitted: 0,
      notTerminal: 0,
      failed: 0,
    });
  });

  it('encodes data/event_id/fact_type fields per the wire contract', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const publisher = new MatchConcludedPublisher({
      stream,
      logger: noopLogger,
      now: () => 1_700_000_030_000,
    });

    await publisher.observe(fixtureObservation({ providerStatus: 'FT' }));

    const entry = stream.published[0];
    expect(entry.fields.event_id).toBe('match-concluded:1917:FT');
    expect(entry.fields.fact_type).toBe(MATCH_CONCLUDED_FACT_TYPE);
    expect(entry.fields.fact_type).toBe('game.match.concluded');
    expect(entry.fields.data).toBeInstanceOf(Uint8Array);

    const fact = decodeBinary(entry.fields.data as Uint8Array);
    expect(fact.type).toBe(MATCH_CONCLUDED_FACT_TYPE);
    expect(fact.sourceService).toBe('gamewire-worker');
    expect(fact.sourceRecordId).toBe('btl_football_game_api_football_1917');
    expect(fact.metadata?.game_id).toBe('btl_football_game_api_football_1917');
    expect(fact.metadata?.provider_status).toBe('FT');
    expect(fact.metadata?.void_reason).toBeNull();
    expect(fact.metadata?.provider_fixture_id).toBe('1917');
  });

  it('sets metadata.void_reason for terminal-void statuses', async () => {
    for (const status of ['PST', 'ABD', 'AWD', 'WO']) {
      const stream = new InMemoryMatchConcludedStreamClient();
      const publisher = new MatchConcludedPublisher({
        stream,
        emitted: new InMemoryEmittedFixtureStore(),
        logger: noopLogger,
      });
      const result = await publisher.observe(
        fixtureObservation({ providerStatus: status, providerFixtureId: `fix-${status}` })
      );
      expect(result.outcome).toBe('published');
      const fact = decodeBinary(stream.published[0].fields.data as Uint8Array);
      expect(fact.metadata?.void_reason).toBe(status);
      expect(fact.metadata?.provider_status).toBe(status);
    }
  });

  it('skips publication for non-terminal statuses', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const metrics = new MatchConcludedPublisherMetrics();
    const publisher = new MatchConcludedPublisher({
      stream,
      metrics,
      logger: noopLogger,
    });

    for (const status of ['NS', '1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'CANC', 'TBD']) {
      const result = await publisher.observe(fixtureObservation({ providerStatus: status }));
      expect(result.outcome).toBe('not_terminal');
    }

    expect(stream.published).toHaveLength(0);
    expect(metrics.snapshot()).toEqual({
      published: 0,
      alreadyEmitted: 0,
      notTerminal: 11,
      failed: 0,
    });
  });

  it('emits at most once per (provider, fixture_id) — second terminal observation is suppressed', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const emitted = new InMemoryEmittedFixtureStore();
    const metrics = new MatchConcludedPublisherMetrics();
    const publisher = new MatchConcludedPublisher({
      stream,
      emitted,
      metrics,
      logger: noopLogger,
    });

    const first = await publisher.observe(fixtureObservation({ providerStatus: 'FT' }));
    const second = await publisher.observe(fixtureObservation({ providerStatus: 'FT' }));

    expect(first.outcome).toBe('published');
    expect(second.outcome).toBe('already_emitted');
    expect(stream.published).toHaveLength(1);
    expect(metrics.snapshot()).toEqual({
      published: 1,
      alreadyEmitted: 1,
      notTerminal: 0,
      failed: 0,
    });
  });

  it('emits once when concurrent workload lanes observe the same terminal fixture', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const metrics = new MatchConcludedPublisherMetrics();
    const publisher = new MatchConcludedPublisher({
      stream,
      emitted: new InMemoryEmittedFixtureStore(),
      metrics,
      logger: noopLogger,
    });

    const results = await Promise.all([
      publisher.observe(fixtureObservation({ providerStatus: 'FT' })),
      publisher.observe(fixtureObservation({ providerStatus: 'FT' })),
      publisher.observe(fixtureObservation({ providerStatus: 'FT' })),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      'already_emitted',
      'already_emitted',
      'published',
    ]);
    expect(stream.published).toHaveLength(1);
    expect(metrics.snapshot()).toMatchObject({
      published: 1,
      alreadyEmitted: 2,
    });
  });

  it('does NOT clear the marker when a fixture transitions back to non-terminal', async () => {
    // The spec calls this out explicitly: provider corrections that
    // flip PST -> NS must NOT make the publisher re-emit. The emit-
    // once gate must hold for the lifetime of the fixture.
    const stream = new InMemoryMatchConcludedStreamClient();
    const emitted = new InMemoryEmittedFixtureStore();
    const publisher = new MatchConcludedPublisher({
      stream,
      emitted,
      logger: noopLogger,
    });

    await publisher.observe(fixtureObservation({ providerStatus: 'PST' }));
    expect(stream.published).toHaveLength(1);

    // Provider correction: fixture rescheduled, status back to NS.
    const reschedule = await publisher.observe(fixtureObservation({ providerStatus: 'NS' }));
    expect(reschedule.outcome).toBe('not_terminal');

    // Even if it later goes back to a terminal status, the marker
    // prevents a second emission. The consumer is responsible for
    // rescore via its own re-emission path.
    const secondTerminal = await publisher.observe(fixtureObservation({ providerStatus: 'FT' }));
    expect(secondTerminal.outcome).toBe('already_emitted');
    expect(stream.published).toHaveLength(1);
  });

  it('still emits the fact for the same fixture id across different providers', async () => {
    // Provider id is part of the dedupe key — a fixture observed via
    // api-football and sportmonks would be two distinct facts (in the
    // unlikely event both providers cover the same fixture).
    const stream = new InMemoryMatchConcludedStreamClient();
    const publisher = new MatchConcludedPublisher({
      stream,
      emitted: new InMemoryEmittedFixtureStore(),
      logger: noopLogger,
    });

    await publisher.observe(fixtureObservation({ providerId: 'api-football' }));
    await publisher.observe(fixtureObservation({ providerId: 'sportmonks' }));
    expect(stream.published).toHaveLength(2);
  });

  it('does NOT mark emitted when the publish fails (so the next observation will retry)', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const emitted = new InMemoryEmittedFixtureStore();
    const metrics = new MatchConcludedPublisherMetrics();
    const publisher = new MatchConcludedPublisher({
      stream,
      emitted,
      metrics,
      logger: noopLogger,
    });

    stream.failNext();
    const failed = await publisher.observe(fixtureObservation({ providerStatus: 'FT' }));
    expect(failed.outcome).toBe('publish_failed');
    expect(emitted.hasEmitted('api-football', '1917')).toBe(false);
    expect(metrics.snapshot()).toMatchObject({ published: 0, failed: 1 });

    // Next observation succeeds because the marker was not set.
    const recovered = await publisher.observe(fixtureObservation({ providerStatus: 'FT' }));
    expect(recovered.outcome).toBe('published');
    expect(emitted.hasEmitted('api-football', '1917')).toBe(true);
    expect(metrics.snapshot()).toMatchObject({ published: 1, failed: 1 });
  });

  it('records the correct outcome counters across a mixed stream of observations', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const metrics = new MatchConcludedPublisherMetrics();
    const publisher = new MatchConcludedPublisher({
      stream,
      emitted: new InMemoryEmittedFixtureStore(),
      metrics,
      logger: noopLogger,
    });

    await publisher.observe(fixtureObservation({ providerFixtureId: 'a', providerStatus: 'NS' }));
    await publisher.observe(fixtureObservation({ providerFixtureId: 'b', providerStatus: 'FT' }));
    await publisher.observe(fixtureObservation({ providerFixtureId: 'b', providerStatus: 'FT' }));
    await publisher.observe(fixtureObservation({ providerFixtureId: 'c', providerStatus: 'PST' }));
    await publisher.observe(fixtureObservation({ providerFixtureId: 'd', providerStatus: 'HT' }));

    expect(metrics.snapshot()).toEqual({
      published: 2,
      alreadyEmitted: 1,
      notTerminal: 2,
      failed: 0,
    });
  });

  it('uses now() for emittedAt and concludedAtMs for occurredAt', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    const now = vi.fn(() => 1_700_000_999_000);
    const publisher = new MatchConcludedPublisher({
      stream,
      logger: noopLogger,
      now,
    });
    await publisher.observe(
      fixtureObservation({
        providerStatus: 'FT',
        concludedAtMs: 1_700_000_000_000,
      })
    );
    const fact = decodeBinary(stream.published[0].fields.data as Uint8Array);
    expect(fact.occurredAt?.seconds).toBe(BigInt(1_700_000_000));
    expect(fact.emittedAt?.seconds).toBe(BigInt(1_700_000_999));
    expect(now).toHaveBeenCalled();
  });
});

describe('createBunMatchConcludedStreamClient', () => {
  const fact = buildMatchConcludedFact({
    providerFixtureId: '1917',
    providerId: 'api-football',
    providerStatus: 'FT',
    classification: 'terminal-result',
    gameId: 'btl_football_game_g1917',
    concludedAtMs: 1_700_000_000_000,
    emittedAtMs: 1_700_000_000_500,
  });

  const recordingClient = () => {
    const calls: { command: string; args: (string | Uint8Array)[] }[] = [];
    return {
      calls,
      bun: {
        async send(command: string, args: (string | Uint8Array)[]): Promise<unknown> {
          calls.push({ command, args });
          return '1700000000000-0';
        },
      },
    };
  };

  it('appends <stream> MAXLEN ~ <maxLen> * data event_id fact_type through the SDK', async () => {
    const { calls, bun } = recordingClient();
    const client = createBunMatchConcludedStreamClient(bun);
    expect(client.backend).toBe('redis');

    const id = await client.publish(fact, { maxLen: MATCH_CONCLUDED_STREAM_MAXLEN });

    expect(id).toBe('1700000000000-0');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('XADD');
    expect(calls[0].args.slice(0, 5)).toEqual([
      MATCH_CONCLUDED_STREAM_NAME,
      'MAXLEN',
      '~',
      '10000',
      '*',
    ]);
    const trailing = calls[0].args.slice(5);
    expect(trailing.filter((_, i) => i % 2 === 0)).toEqual(['data', 'event_id', 'fact_type']);
    expect(trailing[3]).toBe('match-concluded:1917:FT');
    expect(trailing[5]).toBe('game.match.concluded');
  });

  it('passes the proto data field as raw bytes that decode back to the fact', async () => {
    // Regression guard: a JS string arg is sent UTF-8-encoded by Bun.redis,
    // which inflates proto bytes >= 0x80 and makes the payload undecodable by
    // the go-redis consumer (proto.Unmarshal "invalid wire-format data").
    // This silently killed prediction settlement once.
    const { calls, bun } = recordingClient();
    await createBunMatchConcludedStreamClient(bun).publish(fact, { maxLen: 10_000 });
    const encoded = calls[0].args[6];
    expect(calls[0].args[5]).toBe('data');
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(encoded as Uint8Array)).toEqual(
      Array.from(toBinary(PlatformFactSchema, fact))
    );
    expect(decodeBinary(encoded as Uint8Array).idempotencyKey).toBe('match-concluded:1917:FT');
  });

  it('records the same fields in memory as the Redis client sends', async () => {
    const stream = new InMemoryMatchConcludedStreamClient();
    await stream.publish(fact, { maxLen: 10_000 });
    expect(stream.published[0].stream).toBe(MATCH_CONCLUDED_STREAM_NAME);
    expect(stream.published[0].fields).toEqual(factStreamFields(fact));
    expect(stream.published[0].fields.event_id).toBe('match-concluded:1917:FT');
  });

  it('refuses a fact without an idempotency key instead of writing it', async () => {
    const { calls, bun } = recordingClient();
    const keyless = create(PlatformFactSchema, { ...fact, idempotencyKey: '' });
    await expect(
      createBunMatchConcludedStreamClient(bun).publish(keyless, { maxLen: 10_000 })
    ).rejects.toThrow(/idempotency key/);
    expect(calls).toHaveLength(0);
  });
});
