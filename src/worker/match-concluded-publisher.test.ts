import { fromBinary, toBinary } from '@bufbuild/protobuf';
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
  __test,
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
    store.markEmitted('api-football', '1917');
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
    store.markEmitted('api-football', '1917');
    store.markEmitted('api-football', '1917');
    store.markEmitted('api-football', '1917');
    expect(store.size()).toBe(1);
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
  it('issues XADD <stream> MAXLEN ~ <maxLen> * field value ... against Bun.redis', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const bun = {
      async send(command: string, args: string[]): Promise<unknown> {
        calls.push({ command, args });
        return '1700000000000-0';
      },
    };

    const client = createBunMatchConcludedStreamClient(bun);
    expect(client.backend).toBe('redis');
    const id = await client.publish(
      {
        data: new Uint8Array([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
        event_id: 'match-concluded:1917:FT',
        fact_type: 'game.match.concluded',
      },
      { stream: MATCH_CONCLUDED_STREAM_NAME, maxLen: 10_000 }
    );

    expect(id).toBe('1700000000000-0');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('XADD');
    expect(calls[0].args[0]).toBe(MATCH_CONCLUDED_STREAM_NAME);
    expect(calls[0].args[1]).toBe('MAXLEN');
    expect(calls[0].args[2]).toBe('~');
    expect(calls[0].args[3]).toBe('10000');
    expect(calls[0].args[4]).toBe('*');
    // Subsequent args are the field/value pairs.
    const trailing = calls[0].args.slice(5);
    expect(trailing).toContain('event_id');
    expect(trailing).toContain('fact_type');
    expect(trailing).toContain('data');
    expect(trailing).toContain('match-concluded:1917:FT');
    expect(trailing).toContain('game.match.concluded');
  });

  it('encodes Uint8Array fields via Latin-1 binary-string round-trip (matches consumer)', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const bun = {
      async send(command: string, args: string[]): Promise<unknown> {
        calls.push({ command, args });
        return '1-0';
      },
    };
    const client = createBunMatchConcludedStreamClient(bun);
    // Byte sequence with a high bit set to verify Latin-1 round-trip.
    const bytes = new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0x01]);
    await client.publish({ data: bytes }, { stream: 'x', maxLen: 1 });
    const dataIndex = calls[0].args.indexOf('data');
    expect(dataIndex).toBeGreaterThan(-1);
    const encoded = calls[0].args[dataIndex + 1];
    expect(typeof encoded).toBe('string');
    // Same algorithm consumer uses to decode.
    const back = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i += 1) {
      back[i] = encoded.charCodeAt(i) & 0xff;
    }
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it('exports a uint8ArrayToBinaryString helper that matches the consumer implementation', () => {
    const bytes = new Uint8Array([0x68, 0x69, 0xfe]);
    expect(__test.uint8ArrayToBinaryString(bytes)).toBe('hiþ');
  });
});
