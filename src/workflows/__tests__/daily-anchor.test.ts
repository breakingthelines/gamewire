import { describe, expect, it, vi } from 'vitest';

import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
  IngestionWorkload,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import { dailyAnchorWorkflow } from '../daily-anchor.js';
import type { CompetitionEntry, WorkflowDeps, WorkflowLogEntry } from '../types.js';

const COMPETITION_A: CompetitionEntry = {
  key: 'comp-a',
  label: 'Competition A',
  apiFootballLeagueId: 999,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const COMPETITION_B: CompetitionEntry = {
  key: 'comp-b',
  label: 'Competition B',
  apiFootballLeagueId: 1000,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-05-22',
  calls: 100,
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
  data: {
    response: [
      {
        fixture: {
          id: 1001,
          date: '2026-05-20T15:00:00Z',
          status: { short: 'FT' },
        },
        teams: { home: { id: 50 }, away: { id: 60 } },
      },
    ],
  },
  ...overrides,
});

interface MockIngestion {
  readonly fetchWorkload: ReturnType<typeof vi.fn>;
}

const buildDeps = (
  ingestion: MockIngestion,
  competitions: readonly CompetitionEntry[],
  overrides: Partial<WorkflowDeps> = {}
): WorkflowDeps => ({
  ingestion: ingestion as unknown as ApiFootballIngestionLoop,
  competitions,
  ...overrides,
});

describe('dailyAnchorWorkflow', () => {
  it('iterates per competition and aggregates totals', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options);
        return buildResult(options.workload, options.resourceId);
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A, COMPETITION_B]);
    const result = await dailyAnchorWorkflow({}, deps);

    const compKeys = result.competitions.map((c) => c.competition);
    expect(compKeys).toEqual(['comp-a', 'comp-b']);
    expect(result.callsBudgeted).toBeGreaterThan(0);
    expect(result.callsUsed).toBeGreaterThan(0);
    expect(result.degradeFlags).toEqual([]);
    const paths = calls.map((c) => c.path).filter(Boolean);
    expect(paths.some((p) => p?.includes('league=999'))).toBe(true);
    expect(paths.some((p) => p?.includes('league=1000'))).toBe(true);
  });

  it('halts further competitions once quota hard cap reached', async () => {
    let callCount = 0;
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        callCount += 1;
        const hardCapped = callCount >= 1;
        return buildResult(options.workload, options.resourceId, {
          quota: baseQuota({
            calls: hardCapped ? 70_000 : 100,
            posture: hardCapped ? 'hard_cap_reached' : 'normal',
          }),
          data: {},
        });
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A, COMPETITION_B]);
    const result = await dailyAnchorWorkflow({}, deps);

    expect(result.competitions).toHaveLength(1);
    expect(result.competitions[0]?.competition).toBe('comp-a');
    expect(result.degradeFlags.some((f) => f.trigger === 'hard-cap')).toBe(true);
    expect(result.finalQuota?.posture).toBe('hard_cap_reached');
  });

  it('flags soft cap and PROVIDER_OUTAGE without aborting', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, {
          status: 'cached',
          quota: baseQuota({
            calls: 60_500,
            posture: 'soft_cap_reached',
            cachedOnlyMode: true,
          }),
          fallbackReason: 'PROVIDER_OUTAGE',
          data: {},
        })
      ),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A]);
    const result = await dailyAnchorWorkflow({}, deps);

    const triggers = result.degradeFlags.map((f) => f.trigger);
    expect(triggers).toContain('soft-cap');
    expect(triggers).toContain('provider-outage');
    expect(result.competitions).toHaveLength(1);
  });

  it('captures fetch errors per workload + resourceId', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, {
          status: 'failed',
          error: { message: 'boom' },
          data: { response: [] },
        })
      ),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A]);
    const result = await dailyAnchorWorkflow({}, deps);

    expect(result.competitions[0]?.errors.length).toBeGreaterThan(0);
    expect(result.competitions[0]?.errors[0]).toContain('boom');
  });

  it('filters competitions by input.competitions', async () => {
    const calls: string[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options.resourceId);
        return buildResult(options.workload, options.resourceId, { data: { response: [] } });
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A, COMPETITION_B]);
    const result = await dailyAnchorWorkflow({ competitions: ['comp-b'] }, deps);

    expect(result.competitions.map((c) => c.competition)).toEqual(['comp-b']);
    expect(calls.every((c) => !c.includes('999'))).toBe(true);
  });

  it('scopes the fixtures path to a -1d/+7d window around the anchor time', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options);
        return buildResult(options.workload, options.resourceId, { data: { response: [] } });
      }),
    };
    const deps = buildDeps(ingestion, [COMPETITION_A]);
    await dailyAnchorWorkflow({ nowUtc: '2026-05-24T02:00:00Z' }, deps);

    const fixturesCall = calls.find((c) => c.path?.startsWith('/fixtures?'));
    expect(fixturesCall?.path).toBe(
      '/fixtures?league=999&season=2025&from=2026-05-23&to=2026-05-31'
    );
    expect(fixturesCall?.resourceId).toBe('league-999-season-2025-anchor-2026-05-24');
  });

  it('emits structured log events via logger', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, { data: { response: [] } })
      ),
    };
    const logs: WorkflowLogEntry[] = [];
    const deps = buildDeps(ingestion, [COMPETITION_A], {
      logger: (entry) => logs.push(entry),
    });
    await dailyAnchorWorkflow({}, deps);

    expect(logs[0]?.event).toBe('daily_anchor.started');
    expect(logs.at(-1)?.event).toBe('daily_anchor.finished');
  });
});
