import { create, type Message } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  GameMissingPayloadEntrySchema,
  GameMissingPayloadKind,
  type ListGamesMissingPayloadsRequest,
  type ListGamesMissingPayloadsResponse,
  ListGamesMissingPayloadsResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
  IngestionWorkload,
} from '../../worker/ingestion.js';
import type { FootballGameMissingPayloadsClient } from '../../worker/clients/game-service.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import { sweepMissingPayloadsWorkflow } from '../sweep-missing-payloads.js';
import type { CompetitionEntry, SweepMissingPayloadKind, WorkflowDeps } from '../types.js';

const NOOP_COMPETITIONS: readonly CompetitionEntry[] = [];

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-06-09',
  calls: 500,
  softCap: 60_000,
  hardCap: 70_000,
  cachedOnlyMode: false,
  posture: 'normal',
  ...overrides,
});

const buildResult = (
  workload: IngestionWorkload,
  resourceId: string,
  overrides: Partial<IngestionFetchResult> = {}
): IngestionFetchResult => ({
  status: 'fetched',
  workload,
  resourceId,
  cacheKey: `${workload}:${resourceId}`,
  cacheHit: false,
  cachedOnlyMode: false,
  quota: baseQuota(),
  // The presence of `fetch` is what bumps callsUsed, mirroring the real
  // ingestion loop where a provider-side request was actually issued.
  fetch: {
    status: 'fetched',
    request: { url: `https://example.test/${resourceId}` },
    response: { ok: true, status: 200, statusText: 'OK' },
    runtime: { provider: 'api-football', mode: 'live' },
  } as unknown as IngestionFetchResult['fetch'],
  ...overrides,
});

interface MockIngestion {
  readonly fetchWorkload: ReturnType<typeof vi.fn>;
}

const buildIngestion = (
  impl?: (options: IngestionFetchOptions) => Promise<IngestionFetchResult>
): MockIngestion => ({
  fetchWorkload: vi.fn(
    impl ??
      (async (options: IngestionFetchOptions) => buildResult(options.workload, options.resourceId))
  ),
});

const buildClient = (
  pages: readonly ListGamesMissingPayloadsResponse[]
): FootballGameMissingPayloadsClient & {
  readonly calls: ListGamesMissingPayloadsRequest[];
} => {
  let idx = 0;
  const calls: ListGamesMissingPayloadsRequest[] = [];
  return {
    calls,
    listGamesMissingPayloads: async (
      request: ListGamesMissingPayloadsRequest
    ): Promise<ListGamesMissingPayloadsResponse> => {
      calls.push(request);
      const page = pages[idx] ?? create(ListGamesMissingPayloadsResponseSchema, {});
      idx += 1;
      return page;
    },
  };
};

const buildDeps = (args: {
  readonly ingestion: MockIngestion;
  readonly client?: FootballGameMissingPayloadsClient;
}): WorkflowDeps => ({
  ingestion: args.ingestion as unknown as ApiFootballIngestionLoop,
  competitions: NOOP_COMPETITIONS,
  ...(args.client ? { gameServiceMissingPayloads: args.client } : {}),
});

const responseWith = (
  fixtureIds: readonly string[],
  nextPageToken = '',
  totalCount = fixtureIds.length
): ListGamesMissingPayloadsResponse =>
  create(ListGamesMissingPayloadsResponseSchema, {
    entries: fixtureIds.map((id) =>
      create(GameMissingPayloadEntrySchema, {
        gameId: `g-${id}`,
        provider: 'api-football',
        providerFixtureId: id,
      })
    ),
    nextPageToken,
    totalCount: BigInt(totalCount),
  });

describe('sweepMissingPayloadsWorkflow', () => {
  it('returns zero counts when no fixtures are discovered', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([responseWith([])]);
    const deps = buildDeps({ ingestion, client });

    const result = await sweepMissingPayloadsWorkflow(
      { providerId: 'api-football', kind: 'team-match-stats' },
      deps
    );

    expect(result.status).toBe('completed');
    expect(result.fixturesDiscovered).toBe(0);
    expect(result.fixturesProcessed).toBe(0);
    expect(result.fixturesOk).toBe(0);
    expect(result.callsUsed).toBe(0);
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  it('uses explicit fixtureIds and skips the game-service RPC', async () => {
    const ingestion = buildIngestion();
    // The client should not be invoked when fixtureIds is set; constructing
    // one anyway and asserting zero calls pins the contract.
    const client = buildClient([responseWith(['unexpected'])]);
    const deps = buildDeps({ ingestion, client });

    const result = await sweepMissingPayloadsWorkflow(
      {
        providerId: 'api-football',
        kind: 'team-match-stats',
        fixtureIds: ['100', '200', '300'],
      },
      deps
    );

    expect(client.calls).toHaveLength(0);
    expect(ingestion.fetchWorkload).toHaveBeenCalledTimes(3);
    expect(result.fixturesDiscovered).toBe(3);
    expect(result.fixturesProcessed).toBe(3);
    expect(result.fixturesOk).toBe(3);
    expect(result.callsUsed).toBe(3);
    expect(result.status).toBe('completed');
  });

  it('dryRun=true enumerates but fires zero fetches', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([responseWith(['1', '2', '3'])]);
    const deps = buildDeps({ ingestion, client });

    const result = await sweepMissingPayloadsWorkflow(
      {
        providerId: 'api-football',
        kind: 'events',
        dryRun: true,
      },
      deps
    );

    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.fixturesDiscovered).toBe(3);
    expect(result.fixturesProcessed).toBe(0);
    expect(result.fixturesOk).toBe(0);
    expect(result.callsUsed).toBe(0);
    expect(result.status).toBe('completed');
  });

  it('continues past individual fetch failures without aborting the run', async () => {
    let i = 0;
    const ingestion = buildIngestion(async (options) => {
      i += 1;
      if (i === 2) {
        return buildResult(options.workload, options.resourceId, {
          status: 'failed',
          error: { message: 'upstream 500' },
        });
      }
      return buildResult(options.workload, options.resourceId);
    });
    const deps = buildDeps({
      ingestion,
      client: buildClient([responseWith(['10', '11', '12'])]),
    });

    const result = await sweepMissingPayloadsWorkflow(
      { providerId: 'api-football', kind: 'lineups' },
      deps
    );

    expect(ingestion.fetchWorkload).toHaveBeenCalledTimes(3);
    expect(result.fixturesProcessed).toBe(3);
    expect(result.fixturesOk).toBe(2);
    expect(result.fixturesFailed).toBe(1);
    expect(result.status).toBe('partial');
    expect(result.errors.some((e) => e.includes('upstream 500'))).toBe(true);
  });

  it('aborts on hard-cap (provider quota) without consuming the rest of the list', async () => {
    let call = 0;
    const ingestion = buildIngestion(async (options) => {
      call += 1;
      // First fetch succeeds; the second comes back with hard_cap which flips
      // the workflow into abort posture and stops iteration.
      if (call === 1) {
        return buildResult(options.workload, options.resourceId);
      }
      return buildResult(options.workload, options.resourceId, {
        status: 'denied',
        quota: baseQuota({ calls: 70_000, posture: 'hard_cap_reached' }),
      });
    });
    const deps = buildDeps({
      ingestion,
      client: buildClient([responseWith(['1', '2', '3', '4'])]),
    });

    const result = await sweepMissingPayloadsWorkflow(
      { providerId: 'api-football', kind: 'player-match-stats' },
      deps
    );

    // Two fetches were attempted; the third+fourth never ran because the
    // second flipped the mode to `abort` for the next iteration.
    expect(ingestion.fetchWorkload).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('aborted');
  });

  it('skips unsupported providers without touching the ingestion loop', async () => {
    const ingestion = buildIngestion();
    const deps = buildDeps({ ingestion });

    const result = await sweepMissingPayloadsWorkflow(
      { providerId: 'sportmonks', kind: 'team-match-stats' },
      deps
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/unsupported provider/);
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  describe('kind → workload mapping', () => {
    const expectations: ReadonlyArray<{
      readonly kind: SweepMissingPayloadKind;
      readonly workload: IngestionWorkload;
      readonly path: string;
      readonly protoKind: GameMissingPayloadKind;
    }> = [
      {
        kind: 'team-match-stats',
        workload: 'team-match-stats',
        path: '/fixtures/statistics?fixture=42',
        protoKind: GameMissingPayloadKind.TEAM_MATCH_STATS,
      },
      {
        kind: 'player-match-stats',
        workload: 'player-match-stats',
        path: '/fixtures/players?fixture=42',
        protoKind: GameMissingPayloadKind.PLAYER_MATCH_STATS,
      },
      {
        kind: 'events',
        workload: 'events-post-final',
        path: '/fixtures/events?fixture=42',
        protoKind: GameMissingPayloadKind.EVENTS,
      },
      {
        kind: 'lineups',
        workload: 'lineups-post-confirm',
        path: '/fixtures/lineups?fixture=42',
        protoKind: GameMissingPayloadKind.LINEUPS,
      },
    ];

    for (const exp of expectations) {
      it(`maps ${exp.kind} → workload=${exp.workload} via ${exp.path}`, async () => {
        const calls: IngestionFetchOptions[] = [];
        const ingestion = buildIngestion(async (options) => {
          calls.push(options);
          return buildResult(options.workload, options.resourceId);
        });
        const client = buildClient([responseWith(['42'])]);
        const deps = buildDeps({ ingestion, client });

        const result = await sweepMissingPayloadsWorkflow(
          { providerId: 'api-football', kind: exp.kind },
          deps
        );

        expect(client.calls).toHaveLength(1);
        expect(client.calls[0]!.kind).toBe(exp.protoKind);
        expect(client.calls[0]!.provider).toBe('api-football');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.workload).toBe(exp.workload);
        expect(calls[0]!.path).toBe(exp.path);
        expect(calls[0]!.resourceId).toBe('42');
        expect(result.kind).toBe(exp.kind);
        expect(result.status).toBe('completed');
      });
    }
  });

  it('pages through ListGamesMissingPayloads up to the limit', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([
      responseWith(['1', '2'], 'cursor-2', 5),
      responseWith(['3', '4'], 'cursor-4', 5),
      responseWith(['5'], '', 5),
    ]);
    const deps = buildDeps({ ingestion, client });

    const result = await sweepMissingPayloadsWorkflow(
      { providerId: 'api-football', kind: 'team-match-stats', limit: 10 },
      deps
    );

    expect(client.calls).toHaveLength(3);
    expect(client.calls[1]!.pageToken).toBe('cursor-2');
    expect(client.calls[2]!.pageToken).toBe('cursor-4');
    expect(result.fixturesDiscovered).toBe(5);
    expect(result.fixturesProcessed).toBe(5);
    expect(result.fixturesOk).toBe(5);
  });

  it('clamps limit to MAX_LIMIT (500) so an ops one-shot cannot drain the daily budget', async () => {
    const ingestion = buildIngestion();
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    const deps = buildDeps({
      ingestion,
      client: buildClient([responseWith(ids)]),
    });

    const result = await sweepMissingPayloadsWorkflow(
      {
        providerId: 'api-football',
        kind: 'team-match-stats',
        fixtureIds: ids,
        limit: 99_999,
      },
      deps
    );

    // The clamp caps at 500 regardless of caller-supplied limit; ensures the
    // sweep can't accidentally chew the entire daily provider budget on one
    // misconfigured invocation.
    expect(ingestion.fetchWorkload).toHaveBeenCalledTimes(500);
    expect(result.fixturesProcessed).toBe(500);
  });
});

// Silences an unused-export lint warning for the `Message` type guard import.
type _SilenceMessage = Message;
