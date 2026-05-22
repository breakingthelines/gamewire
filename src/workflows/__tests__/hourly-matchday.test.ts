import { describe, expect, it, vi } from 'vitest';

import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
  IngestionWorkload,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import { hourlyMatchdayWorkflow } from '../hourly-matchday.js';
import type { CompetitionEntry, WorkflowDeps } from '../types.js';

const SATURDAY_15UTC = new Date('2026-05-23T15:00:00Z');
const MONDAY_03UTC = new Date('2026-05-25T03:00:00Z');

const inWindowComp: CompetitionEntry = {
  key: 'in-window',
  label: 'In Window',
  apiFootballLeagueId: 39,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const outOfWindowComp: CompetitionEntry = {
  key: 'out-of-window',
  label: 'Out of Window',
  apiFootballLeagueId: 40,
  season: 2025,
  calendar: [{ utcWeekday: 2, utcHourStart: 18, utcHourEnd: 22 }],
  tier: 'domestic',
};

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-05-22',
  calls: 200,
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
  data: { response: [{ fixture: { id: 1, date: '2026-05-23T15:00:00Z' } }] },
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

describe('hourlyMatchdayWorkflow', () => {
  it('short-circuits with no in-window competitions', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(),
    };
    const deps = buildDeps(ingestion, [outOfWindowComp]);
    const result = await hourlyMatchdayWorkflow(
      { nowUtc: MONDAY_03UTC.toISOString() },
      deps
    );

    expect(result.inWindow).toEqual([]);
    expect(result.skipped).toEqual(['out-of-window']);
    expect(result.competitions).toEqual([]);
    expect(result.callsBudgeted).toBe(0);
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  it('refreshes standings + next-24h fixtures for in-window competitions', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options);
        return buildResult(options.workload, options.resourceId);
      }),
    };
    const deps = buildDeps(ingestion, [inWindowComp, outOfWindowComp]);
    const result = await hourlyMatchdayWorkflow(
      { nowUtc: SATURDAY_15UTC.toISOString() },
      deps
    );

    expect(result.inWindow).toEqual(['in-window']);
    expect(result.skipped).toEqual(['out-of-window']);
    expect(result.competitions).toHaveLength(1);
    const paths = calls.map((c) => c.path);
    expect(paths.some((p) => p?.includes('/standings'))).toBe(true);
    expect(paths.some((p) => p?.includes('/fixtures?league=39'))).toBe(true);
    expect(paths.some((p) => p?.includes('from='))).toBe(true);
  });

  it('aborts further competitions once hard cap hit', async () => {
    let count = 0;
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        count += 1;
        return buildResult(options.workload, options.resourceId, {
          quota: baseQuota({
            calls: 70_000,
            posture: 'hard_cap_reached',
          }),
          data: { response: [] },
        });
      }),
    };
    const second: CompetitionEntry = { ...inWindowComp, key: 'second', apiFootballLeagueId: 78 };
    const deps = buildDeps(ingestion, [inWindowComp, second]);
    const result = await hourlyMatchdayWorkflow(
      { nowUtc: SATURDAY_15UTC.toISOString() },
      deps
    );

    expect(count).toBeGreaterThan(0);
    expect(result.competitions).toHaveLength(1);
    expect(result.degradeFlags.some((f) => f.trigger === 'hard-cap')).toBe(true);
  });

  it('counts fixtures from next-24h response.length', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        if (options.path?.includes('/standings')) {
          return buildResult(options.workload, options.resourceId, { data: { response: [] } });
        }
        return buildResult(options.workload, options.resourceId, {
          data: { response: [{ fixture: { id: 1 } }, { fixture: { id: 2 } }, { fixture: { id: 3 } }] },
        });
      }),
    };
    const deps = buildDeps(ingestion, [inWindowComp]);
    const result = await hourlyMatchdayWorkflow(
      { nowUtc: SATURDAY_15UTC.toISOString() },
      deps
    );
    expect(result.fixturesIngested).toBe(3);
  });
});
