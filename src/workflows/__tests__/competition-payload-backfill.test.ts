import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  GameMissingPayloadEntrySchema,
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
import {
  competitionPayloadBackfillWorkflow,
  resolveBackfillTarget,
  resolveCandidateCompetitionIds,
  selectCompetitionFixtures,
  type DiscoveredMissingPayloadEntry,
} from '../competition-payload-backfill.js';
import type { CompetitionEntry, WorkflowDeps, WorkflowLogEntry } from '../types.js';

// ── fixtures shared across the test groups ─────────────────────────────────

const CATALOGUE: readonly CompetitionEntry[] = [
  {
    key: 'coppa-italia',
    label: 'Coppa Italia',
    country: 'Italy',
    apiFootballLeagueId: 137,
    season: 2025,
    calendar: null,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'fa-cup',
    label: 'FA Cup',
    country: 'England',
    apiFootballLeagueId: 45,
    season: 2025,
    calendar: null,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },
];

const COPPA_ITALIA_PROVIDER_STORAGE_ID = 'provider:api-football:competition:137';
const FA_CUP_PROVIDER_STORAGE_ID = 'provider:api-football:competition:45';

const entry = (
  args: Partial<DiscoveredMissingPayloadEntry> & { readonly providerFixtureId: string }
): DiscoveredMissingPayloadEntry => ({
  gameId: `g-${args.providerFixtureId}`,
  competitionId: COPPA_ITALIA_PROVIDER_STORAGE_ID,
  ...args,
});

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-07-31',
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
): FootballGameMissingPayloadsClient & { readonly calls: ListGamesMissingPayloadsRequest[] } => {
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

const responseFrom = (
  entries: readonly DiscoveredMissingPayloadEntry[],
  nextPageToken = ''
): ListGamesMissingPayloadsResponse =>
  create(ListGamesMissingPayloadsResponseSchema, {
    entries: entries.map((e) =>
      create(GameMissingPayloadEntrySchema, {
        gameId: e.gameId,
        provider: 'api-football',
        providerFixtureId: e.providerFixtureId,
        competitionId: e.competitionId,
      })
    ),
    nextPageToken,
    totalCount: BigInt(entries.length),
  });

const buildDeps = (args: {
  readonly ingestion: MockIngestion;
  readonly client?: FootballGameMissingPayloadsClient;
  readonly identity?: WorkflowDeps['identity'];
  readonly logger?: WorkflowDeps['logger'];
}): WorkflowDeps => ({
  ingestion: args.ingestion as unknown as ApiFootballIngestionLoop,
  competitions: CATALOGUE,
  ...(args.client ? { gameServiceMissingPayloads: args.client } : {}),
  ...(args.identity ? { identity: args.identity } : {}),
  ...(args.logger ? { logger: args.logger } : {}),
});

// ── pure selection logic ────────────────────────────────────────────────────

describe('selectCompetitionFixtures', () => {
  const candidates = new Set([COPPA_ITALIA_PROVIDER_STORAGE_ID]);

  it('keeps only entries whose competitionId is in the candidate set', () => {
    const entries = [
      entry({ providerFixtureId: '1', competitionId: COPPA_ITALIA_PROVIDER_STORAGE_ID }),
      entry({ providerFixtureId: '2', competitionId: FA_CUP_PROVIDER_STORAGE_ID }),
      entry({ providerFixtureId: '3', competitionId: COPPA_ITALIA_PROVIDER_STORAGE_ID }),
    ];

    const matched = selectCompetitionFixtures(entries, candidates, 100);

    expect(matched.map((m) => m.providerFixtureId)).toEqual(['1', '3']);
  });

  it('respects the limit even when more entries match', () => {
    const entries = [
      entry({ providerFixtureId: '1' }),
      entry({ providerFixtureId: '2' }),
      entry({ providerFixtureId: '3' }),
    ];

    const matched = selectCompetitionFixtures(entries, candidates, 2);

    expect(matched.map((m) => m.providerFixtureId)).toEqual(['1', '2']);
  });

  it('skips entries with an empty providerFixtureId', () => {
    const entries = [entry({ providerFixtureId: '' }), entry({ providerFixtureId: '1' })];

    const matched = selectCompetitionFixtures(entries, candidates, 100);

    expect(matched.map((m) => m.providerFixtureId)).toEqual(['1']);
  });

  it('matches against any id in a multi-value candidate set (provider-storage OR canonical)', () => {
    const canonical = 'btl_football_competition_lb3d230cb';
    const bothCandidates = new Set([COPPA_ITALIA_PROVIDER_STORAGE_ID, canonical]);
    const entries = [
      entry({ providerFixtureId: '1', competitionId: canonical }),
      entry({ providerFixtureId: '2', competitionId: COPPA_ITALIA_PROVIDER_STORAGE_ID }),
      entry({ providerFixtureId: '3', competitionId: FA_CUP_PROVIDER_STORAGE_ID }),
    ];

    const matched = selectCompetitionFixtures(entries, bothCandidates, 100);

    expect(matched.map((m) => m.providerFixtureId)).toEqual(['1', '2']);
  });
});

// ── target + candidate resolution ──────────────────────────────────────────

describe('resolveBackfillTarget', () => {
  it('resolves a known competitionKey against the supplied catalogue', () => {
    const result = resolveBackfillTarget({ competitionKey: 'coppa-italia' }, CATALOGUE);
    expect(result).toEqual({ leagueId: 137, competitionKey: 'coppa-italia' });
  });

  it('lets an explicit apiFootballLeagueId win over competitionKey', () => {
    const result = resolveBackfillTarget(
      { competitionKey: 'coppa-italia', apiFootballLeagueId: 999 },
      CATALOGUE
    );
    expect(result).toEqual({ leagueId: 999, competitionKey: 'coppa-italia' });
  });

  it('errors on an unknown competitionKey rather than silently matching nothing', () => {
    const result = resolveBackfillTarget({ competitionKey: 'not-a-real-key' }, CATALOGUE);
    expect(result).toEqual({ error: 'unknown competition key: not-a-real-key' });
  });

  it('errors when neither competitionKey nor apiFootballLeagueId is given', () => {
    const result = resolveBackfillTarget({}, CATALOGUE);
    expect(result).toEqual({ error: 'competitionKey or apiFootballLeagueId is required' });
  });
});

describe('resolveCandidateCompetitionIds', () => {
  it('always includes the deterministic provider-storage fallback id', async () => {
    const ids = await resolveCandidateCompetitionIds(137, undefined);
    expect(ids.has(COPPA_ITALIA_PROVIDER_STORAGE_ID)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('adds the canonical identity-resolved id when identity resolves it', async () => {
    const resolve = vi.fn(async () => ({ found: true, entityId: 'btl_football_competition_l137' }));
    const ids = await resolveCandidateCompetitionIds(137, {
      resolve,
    } as unknown as WorkflowDeps['identity']);

    expect(ids.has(COPPA_ITALIA_PROVIDER_STORAGE_ID)).toBe(true);
    expect(ids.has('btl_football_competition_l137')).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('falls back to the provider-storage id alone on an identity miss or outage', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('identity-server unreachable');
    });
    const ids = await resolveCandidateCompetitionIds(137, {
      resolve,
    } as unknown as WorkflowDeps['identity']);

    expect(ids.size).toBe(1);
    expect(ids.has(COPPA_ITALIA_PROVIDER_STORAGE_ID)).toBe(true);
  });
});

// ── full workflow ───────────────────────────────────────────────────────────

describe('competitionPayloadBackfillWorkflow', () => {
  it('defaults to dry run and performs ZERO fetches even when matches are found', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([
      responseFrom([
        entry({ providerFixtureId: '10' }),
        entry({ providerFixtureId: '11', competitionId: FA_CUP_PROVIDER_STORAGE_ID }),
        entry({ providerFixtureId: '12' }),
      ]),
    ]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events' },
      deps
    );

    expect(result.dryRun).toBe(true);
    expect(result.fixturesMatched).toBe(2);
    expect(result.fixtures.map((f) => f.providerFixtureId)).toEqual(['10', '12']);
    expect(result.fixturesProcessed).toBe(0);
    expect(result.status).toBe('completed');
    // The dry-run guarantee: no fetch/write path is ever reached.
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  it('reaches no write path even when dryRun is explicitly passed as true', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([responseFrom([entry({ providerFixtureId: '20' })])]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'lineups', dryRun: true },
      deps
    );

    expect(result.dryRun).toBe(true);
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  it('executes fetches only when dryRun:false is explicit, delegating to the events/lineups workloads', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion = buildIngestion(async (options) => {
      calls.push(options);
      return buildResult(options.workload, options.resourceId);
    });
    const client = buildClient([
      responseFrom([entry({ providerFixtureId: '30' }), entry({ providerFixtureId: '31' })]),
    ]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'lineups', dryRun: false },
      deps
    );

    expect(result.dryRun).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.workload === 'lineups-post-confirm')).toBe(true);
    expect(calls.map((c) => c.resourceId).sort()).toEqual(['30', '31']);
    expect(result.fixturesOk).toBe(2);
    expect(result.callsUsed).toBe(2);
    expect(result.status).toBe('completed');
  });

  it('maps kind=events to the events-post-final workload when executing', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion = buildIngestion(async (options) => {
      calls.push(options);
      return buildResult(options.workload, options.resourceId);
    });
    const client = buildClient([responseFrom([entry({ providerFixtureId: '40' })])]);
    const deps = buildDeps({ ingestion, client });

    await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events', dryRun: false },
      deps
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.workload).toBe('events-post-final');
  });

  it('is idempotent: a fixture no longer listed as missing on a rerun is not touched', async () => {
    // First run: 10, 11, 12 are all missing lineups for Coppa Italia.
    const firstIngestion = buildIngestion();
    const firstClient = buildClient([
      responseFrom([
        entry({ providerFixtureId: '10' }),
        entry({ providerFixtureId: '11' }),
        entry({ providerFixtureId: '12' }),
      ]),
    ]);
    const firstResult = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'lineups', dryRun: false },
      buildDeps({ ingestion: firstIngestion, client: firstClient })
    );
    expect(firstResult.fixtures.map((f) => f.providerFixtureId)).toEqual(['10', '11', '12']);

    // Second run: game-service's ListGamesMissingPayloads reflects that 10 and
    // 12 were filled by the first run (its writes are the source of truth for
    // "missing"), so only 11 is still listed. The selection layer must not
    // re-discover or re-fetch 10/12 — this is what makes the tool safe to
    // stop and re-run.
    const secondIngestion = buildIngestion();
    const secondClient = buildClient([responseFrom([entry({ providerFixtureId: '11' })])]);
    const secondResult = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'lineups', dryRun: false },
      buildDeps({ ingestion: secondIngestion, client: secondClient })
    );

    expect(secondResult.fixtures.map((f) => f.providerFixtureId)).toEqual(['11']);
    expect(secondIngestion.fetchWorkload).toHaveBeenCalledTimes(1);
  });

  it('paginates until the limit is reached, filtering out other competitions along the way', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([
      responseFrom(
        [
          entry({ providerFixtureId: '1' }),
          entry({ providerFixtureId: '2', competitionId: FA_CUP_PROVIDER_STORAGE_ID }),
        ],
        'cursor-2'
      ),
      responseFrom(
        [
          entry({ providerFixtureId: '3', competitionId: FA_CUP_PROVIDER_STORAGE_ID }),
          entry({ providerFixtureId: '4' }),
        ],
        'cursor-4'
      ),
      responseFrom([entry({ providerFixtureId: '5' })], ''),
    ]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events', limit: 3 },
      deps
    );

    // Page 1 yields only 1 match ('1'); page 2 adds '4' (2 matched so far);
    // still short of limit=3, so a third page is fetched for '5'.
    expect(client.calls).toHaveLength(3);
    expect(client.calls[1]!.pageToken).toBe('cursor-2');
    expect(client.calls[2]!.pageToken).toBe('cursor-4');
    // Considered = every entry scanned across pages examined (unfiltered);
    // matched = only the ones that belong to Coppa Italia, capped at limit.
    expect(result.fixturesConsidered).toBe(5);
    expect(result.fixturesMatched).toBe(3);
    expect(result.fixtures.map((f) => f.providerFixtureId)).toEqual(['1', '4', '5']);
  });

  it('returns an aborted status with a reason for an unknown competitionKey, making zero RPC calls', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([responseFrom([entry({ providerFixtureId: '1' })])]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'not-a-real-competition', kind: 'events' },
      deps
    );

    expect(result.status).toBe('aborted');
    expect(result.reason).toMatch(/unknown competition key/);
    expect(client.calls).toHaveLength(0);
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  it('returns aborted when the gameServiceMissingPayloads client is not configured', async () => {
    const ingestion = buildIngestion();
    const deps = buildDeps({ ingestion });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events' },
      deps
    );

    expect(result.status).toBe('aborted');
    expect(result.reason).toMatch(/gameServiceMissingPayloads client not configured/);
  });

  it('reports zero matches (not an error) when the competition has nothing missing', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([
      responseFrom([entry({ providerFixtureId: '1', competitionId: FA_CUP_PROVIDER_STORAGE_ID })]),
    ]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events' },
      deps
    );

    expect(result.status).toBe('completed');
    expect(result.fixturesMatched).toBe(0);
    expect(result.fixturesConsidered).toBe(1);
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  it('clamps limit to MAX_LIMIT (500)', async () => {
    const ingestion = buildIngestion();
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    const client = buildClient([responseFrom(ids.map((id) => entry({ providerFixtureId: id })))]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events', limit: 99_999, dryRun: false },
      deps
    );

    expect(result.fixturesMatched).toBe(500);
    expect(ingestion.fetchWorkload).toHaveBeenCalledTimes(500);
  });

  it('logs one would_fetch event per matched fixture on a dry run', async () => {
    const ingestion = buildIngestion();
    const client = buildClient([
      responseFrom([entry({ providerFixtureId: '10' }), entry({ providerFixtureId: '11' })]),
    ]);
    const logs: WorkflowLogEntry[] = [];
    const deps = buildDeps({ ingestion, client, logger: (e) => logs.push(e) });

    await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events' },
      deps
    );

    const wouldFetch = logs.filter((l) => l.event === 'competition_payload_backfill.would_fetch');
    expect(wouldFetch.map((l) => l.fixtureId).sort()).toEqual(['10', '11']);
  });

  it('surfaces a partial status and per-fixture errors from the underlying sweep on execute', async () => {
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
    const client = buildClient([
      responseFrom([
        entry({ providerFixtureId: '1' }),
        entry({ providerFixtureId: '2' }),
        entry({ providerFixtureId: '3' }),
      ]),
    ]);
    const deps = buildDeps({ ingestion, client });

    const result = await competitionPayloadBackfillWorkflow(
      { competitionKey: 'coppa-italia', kind: 'events', dryRun: false },
      deps
    );

    expect(result.status).toBe('partial');
    expect(result.fixturesOk).toBe(2);
    expect(result.fixturesFailed).toBe(1);
    expect(result.errors.some((e) => e.includes('upstream 500'))).toBe(true);
  });
});
