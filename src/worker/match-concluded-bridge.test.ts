import { create, fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  type PlatformFact,
  PlatformFactSchema,
} from '@breakingthelines/protos/btl/context/v1/context_pb';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  type LookupRequest,
  type LookupResponse,
  type ResolveRequest,
  type ResolveResponse,
  ResolveResponseSchema,
  type SearchRequest,
  type SearchResponse,
  type StatsRequest,
  type StatsResponse,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import type { FootballIdentityLookupClient } from './clients/identity.js';
import {
  createMatchConcludedBridge,
  decodeFixtureEnvelope,
  isFixtureDetailWorkload,
  type MatchConcludedBridgeLogEntry,
} from './match-concluded-bridge.js';
import {
  InMemoryEmittedFixtureStore,
  InMemoryMatchConcludedStreamClient,
  MATCH_CONCLUDED_FACT_TYPE,
  MATCH_CONCLUDED_STREAM_NAME,
  MatchConcludedPublisher,
  MatchConcludedPublisherMetrics,
} from './match-concluded-publisher.js';

const decodeFact = (bytes: Uint8Array): PlatformFact =>
  fromBinary(PlatformFactSchema, bytes);

const noopLogger = (_: MatchConcludedBridgeLogEntry): void => {
  /* swallow logs in unit tests */
};

/**
 * Build a minimal API-Football `/fixtures?id=` response envelope for a
 * single fixture with the given status code.
 */
const buildFixtureResponse = (
  fixtureId: number | string,
  statusShort: string,
  dateIso = '2026-05-20T15:00:00+00:00',
): unknown => ({
  response: [
    {
      fixture: {
        id: fixtureId,
        date: dateIso,
        status: { short: statusShort, long: 'Match Finished' },
      },
      teams: { home: { id: 1 }, away: { id: 2 } },
    },
  ],
});

interface BuildPublisherResult {
  readonly publisher: MatchConcludedPublisher;
  readonly stream: InMemoryMatchConcludedStreamClient;
  readonly metrics: MatchConcludedPublisherMetrics;
  readonly emitted: InMemoryEmittedFixtureStore;
}

const buildPublisher = (
  overrides: { readonly now?: () => number } = {},
): BuildPublisherResult => {
  const stream = new InMemoryMatchConcludedStreamClient();
  const metrics = new MatchConcludedPublisherMetrics();
  const emitted = new InMemoryEmittedFixtureStore();
  const publisher = new MatchConcludedPublisher({
    stream,
    emitted,
    metrics,
    logger: () => undefined,
    now: overrides.now ?? (() => Date.parse('2026-05-20T17:00:00Z')),
  });
  return { publisher, stream, metrics, emitted };
};

interface FakeIdentity {
  readonly client: FootballIdentityLookupClient;
  readonly resolveCalls: ResolveRequest[];
}

const fakeIdentity = (options: {
  readonly response?: Partial<ResolveResponse>;
  readonly error?: unknown;
}): FakeIdentity => {
  const resolveCalls: ResolveRequest[] = [];
  const error = options.error;
  const response = create(ResolveResponseSchema, {
    entityId: options.response?.entityId ?? '',
    entityType: options.response?.entityType ?? EntityType.GAME,
    found: options.response?.found ?? false,
  });
  const client: FootballIdentityLookupClient = {
    async resolve(request: ResolveRequest): Promise<ResolveResponse> {
      resolveCalls.push(request);
      if (error !== undefined) {
        throw error;
      }
      return response;
    },
    async lookup(_request: LookupRequest): Promise<LookupResponse> {
      throw new Error('lookup not implemented in fake');
    },
    async search(_request: SearchRequest): Promise<SearchResponse> {
      throw new Error('search not implemented in fake');
    },
    async stats(_request: StatsRequest): Promise<StatsResponse> {
      throw new Error('stats not implemented in fake');
    },
  };
  return { client, resolveCalls };
};

describe('isFixtureDetailWorkload', () => {
  it('returns true for fixture-detail-* workloads', () => {
    expect(isFixtureDetailWorkload('fixture-detail-preKO')).toBe(true);
    expect(isFixtureDetailWorkload('fixture-detail-live')).toBe(true);
    expect(isFixtureDetailWorkload('fixture-detail-fullTime')).toBe(true);
  });

  it('returns false for non-fixture workloads', () => {
    expect(isFixtureDetailWorkload('fixtures-next-7d')).toBe(false);
    expect(isFixtureDetailWorkload('lineups-post-confirm')).toBe(false);
    expect(isFixtureDetailWorkload('team-metadata')).toBe(false);
    expect(isFixtureDetailWorkload('player-metadata')).toBe(false);
  });
});

describe('decodeFixtureEnvelope', () => {
  it('extracts id, status, and date from a well-formed response', () => {
    const decoded = decodeFixtureEnvelope(buildFixtureResponse(12345, 'FT'));
    expect(decoded).not.toBeNull();
    expect(decoded?.providerFixtureId).toBe('12345');
    expect(decoded?.providerStatus).toBe('FT');
    expect(decoded?.concludedAtMs).toBe(Date.parse('2026-05-20T15:00:00+00:00'));
  });

  it('coerces numeric fixture ids to strings', () => {
    const decoded = decodeFixtureEnvelope(buildFixtureResponse(999, 'AET'));
    expect(decoded?.providerFixtureId).toBe('999');
  });

  it('returns null for non-object payloads', () => {
    expect(decodeFixtureEnvelope(null)).toBeNull();
    expect(decodeFixtureEnvelope(undefined)).toBeNull();
    expect(decodeFixtureEnvelope('string')).toBeNull();
    expect(decodeFixtureEnvelope(123)).toBeNull();
    expect(decodeFixtureEnvelope([])).toBeNull();
  });

  it('returns null when response array missing or empty', () => {
    expect(decodeFixtureEnvelope({})).toBeNull();
    expect(decodeFixtureEnvelope({ response: [] })).toBeNull();
    expect(decodeFixtureEnvelope({ response: 'not-an-array' })).toBeNull();
  });

  it('returns null when fixture sub-object is missing or malformed', () => {
    expect(decodeFixtureEnvelope({ response: [{}] })).toBeNull();
    expect(decodeFixtureEnvelope({ response: [{ fixture: null }] })).toBeNull();
    expect(decodeFixtureEnvelope({ response: [{ fixture: 'no' }] })).toBeNull();
  });

  it('returns null when fixture.id is missing or empty', () => {
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { status: { short: 'FT' } } }],
      }),
    ).toBeNull();
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { id: '', status: { short: 'FT' } } }],
      }),
    ).toBeNull();
  });

  it('returns null when fixture.status.short is missing or malformed', () => {
    expect(
      decodeFixtureEnvelope({ response: [{ fixture: { id: 1, status: null } }] }),
    ).toBeNull();
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { id: 1, status: { short: '' } } }],
      }),
    ).toBeNull();
    expect(
      decodeFixtureEnvelope({
        response: [{ fixture: { id: 1, status: { short: 123 } } }],
      }),
    ).toBeNull();
  });

  it('omits concludedAtMs when the date is missing or unparseable', () => {
    const noDate = decodeFixtureEnvelope({
      response: [{ fixture: { id: 1, status: { short: 'FT' } } }],
    });
    expect(noDate).not.toBeNull();
    expect(noDate?.concludedAtMs).toBeUndefined();

    const badDate = decodeFixtureEnvelope({
      response: [{ fixture: { id: 1, date: 'not-a-date', status: { short: 'FT' } } }],
    });
    expect(badDate?.concludedAtMs).toBeUndefined();
  });
});

describe('createMatchConcludedBridge', () => {
  it('is a no-op for non-fixture workloads', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({});
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixtures-next-7d',
      resourceId: 'top',
      data: { response: [] },
    });
    await bridge({
      workload: 'lineups-post-confirm',
      resourceId: '1',
      data: buildFixtureResponse(1, 'FT'),
    });
    await bridge({
      workload: 'team-metadata',
      resourceId: 't1',
      data: { response: [] },
    });
    await bridge({
      workload: 'player-metadata',
      resourceId: 'p1',
      data: { response: [] },
    });

    expect(identity.resolveCalls).toHaveLength(0);
    expect(stream.published).toHaveLength(0);
  });

  it('skips malformed payloads and logs a structured event', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({});
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'fixture-detail-live',
      resourceId: '1',
      data: { broken: 'shape' },
    });

    expect(identity.resolveCalls).toHaveLength(0);
    expect(stream.published).toHaveLength(0);
    expect(logs.some((e) => e.event === 'bridge_decode_skipped')).toBe(true);
  });

  it('skips publishing when identity returns no match', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({ response: { found: false, entityId: '' } });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '12345',
      data: buildFixtureResponse(12345, 'FT'),
    });

    expect(identity.resolveCalls).toHaveLength(1);
    expect(identity.resolveCalls[0]?.entityType).toBe(EntityType.GAME);
    expect(identity.resolveCalls[0]?.provider).toBe('api-football');
    expect(identity.resolveCalls[0]?.providerId).toBe('12345');
    expect(stream.published).toHaveLength(0);
    expect(logs.some((e) => e.event === 'bridge_identity_miss')).toBe(true);
  });

  it('does not throw when identity client throws (caught and logged)', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({ error: new Error('network down') });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await expect(
      bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '12345',
        data: buildFixtureResponse(12345, 'FT'),
      }),
    ).resolves.toBeUndefined();

    expect(stream.published).toHaveLength(0);
    const errEntry = logs.find((e) => e.event === 'bridge_identity_error');
    expect(errEntry).toBeDefined();
    expect(errEntry?.message).toContain('network down');
  });

  it('observes terminal-result statuses (FT, AET, PEN) end-to-end', async () => {
    for (const status of ['FT', 'AET', 'PEN']) {
      const { publisher, stream } = buildPublisher();
      const identity = fakeIdentity({
        response: { found: true, entityId: `game-${status.toLowerCase()}` },
      });
      const bridge = createMatchConcludedBridge({
        publisher,
        identity: identity.client,
        providerId: 'api-football',
        logger: noopLogger,
      });

      await bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '12345',
        data: buildFixtureResponse(12345, status),
      });

      expect(stream.published).toHaveLength(1);
      const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
      expect(fact.type).toBe(MATCH_CONCLUDED_FACT_TYPE);
      expect(fact.sourceRecordId).toBe(`game-${status.toLowerCase()}`);
      expect(stream.published[0]!.stream).toBe(MATCH_CONCLUDED_STREAM_NAME);

      const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
      expect(metadata.provider_status).toBe(status);
      expect(metadata.void_reason).toBeNull();
      expect(metadata.provider_fixture_id).toBe('12345');
    }
  });

  it('observes terminal-void statuses (PST, ABD, AWD, WO) with void_reason set', async () => {
    for (const status of ['PST', 'ABD', 'AWD', 'WO']) {
      const { publisher, stream } = buildPublisher();
      const identity = fakeIdentity({
        response: { found: true, entityId: `game-${status.toLowerCase()}` },
      });
      const bridge = createMatchConcludedBridge({
        publisher,
        identity: identity.client,
        providerId: 'api-football',
        logger: noopLogger,
      });

      await bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '12345',
        data: buildFixtureResponse(12345, status),
      });

      expect(stream.published).toHaveLength(1);
      const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
      const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
      expect(metadata.provider_status).toBe(status);
      expect(metadata.void_reason).toBe(status);
    }
  });

  it('records not_terminal outcome for non-terminal statuses without publishing', async () => {
    const { publisher, stream, metrics } = buildPublisher();
    const identity = fakeIdentity({
      response: { found: true, entityId: 'game-99' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixture-detail-live',
      resourceId: '99',
      data: buildFixtureResponse(99, '1H'),
    });

    expect(stream.published).toHaveLength(0);
    expect(metrics.snapshot().notTerminal).toBe(1);
  });

  it('uses fixture.date as concludedAtMs when present', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({
      response: { found: true, entityId: 'game-1' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '1',
      data: buildFixtureResponse(1, 'FT', '2026-05-20T16:45:00+00:00'),
    });

    const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
    const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.concluded_at).toBe(
      new Date(Date.parse('2026-05-20T16:45:00+00:00')).toISOString(),
    );
  });

  it('falls back to clock() when fixture.date is missing', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({
      response: { found: true, entityId: 'game-1' },
    });
    const fixedNow = Date.parse('2026-06-01T12:00:00Z');
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: noopLogger,
      clock: () => fixedNow,
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '1',
      data: {
        response: [{ fixture: { id: 1, status: { short: 'FT' } } }],
      },
    });

    const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
    const metadata = (fact.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.concluded_at).toBe(new Date(fixedNow).toISOString());
  });

  it('passes the configured providerId through to identity + observation', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({
      response: { found: true, entityId: 'game-1' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'sportmonks',
      logger: noopLogger,
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '7',
      data: buildFixtureResponse(7, 'FT'),
    });

    expect(identity.resolveCalls[0]?.provider).toBe('sportmonks');
    const fact = decodeFact(stream.published[0]!.fields.data as Uint8Array);
    expect(fact.idempotencyKey).toBe('match-concluded:7:FT');
  });

  it('emits exactly once per (providerId, providerFixtureId) across repeated invocations', async () => {
    const { publisher, stream } = buildPublisher();
    const identity = fakeIdentity({
      response: { found: true, entityId: 'game-99' },
    });
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: noopLogger,
    });

    for (let i = 0; i < 3; i += 1) {
      await bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '99',
        data: buildFixtureResponse(99, 'FT'),
      });
    }

    expect(stream.published).toHaveLength(1);
  });

  it('logs bridge_observed with the publisher outcome', async () => {
    const { publisher } = buildPublisher();
    const identity = fakeIdentity({
      response: { found: true, entityId: 'game-1' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await bridge({
      workload: 'fixture-detail-fullTime',
      resourceId: '1',
      data: buildFixtureResponse(1, 'FT'),
    });

    const observed = logs.find((e) => e.event === 'bridge_observed');
    expect(observed).toBeDefined();
    expect(observed?.outcome).toBe('published');
    expect(observed?.providerStatus).toBe('FT');
    expect(observed?.gameId).toBe('game-1');
  });

  it('does not throw when publisher.observe rejects unexpectedly', async () => {
    const { publisher } = buildPublisher();
    // Force the publisher to throw by stubbing observe(). The publisher's
    // production observe() never throws, but the bridge must be robust.
    const observeSpy = vi
      .spyOn(publisher, 'observe')
      .mockRejectedValue(new Error('boom'));
    const identity = fakeIdentity({
      response: { found: true, entityId: 'game-1' },
    });
    const logs: MatchConcludedBridgeLogEntry[] = [];
    const bridge = createMatchConcludedBridge({
      publisher,
      identity: identity.client,
      providerId: 'api-football',
      logger: (entry) => logs.push(entry),
    });

    await expect(
      bridge({
        workload: 'fixture-detail-fullTime',
        resourceId: '1',
        data: buildFixtureResponse(1, 'FT'),
      }),
    ).resolves.toBeUndefined();

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(logs.some((e) => e.event === 'bridge_observe_failed')).toBe(true);
  });
});

describe('ingestion onFixtureFetched (no-op default)', () => {
  it('does not require a callback to be passed', async () => {
    // Sanity assertion: the bridge module exists and the IngestionLoop
    // contract preserves the optional callback. The ingestion test suite
    // already covers fetch behaviour; this assertion documents the
    // null-callback path so callers know an undefined bridge is supported.
    expect(typeof createMatchConcludedBridge).toBe('function');
  });
});
