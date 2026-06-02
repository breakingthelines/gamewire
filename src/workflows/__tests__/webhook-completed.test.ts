import { describe, expect, it, vi } from 'vitest';

import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
  IngestionWorkload,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import { webhookCompletedWorkflow } from '../webhook-completed.js';
import type { CompetitionEntry, WorkflowDeps } from '../types.js';

const NOOP_COMPETITIONS: readonly CompetitionEntry[] = [];

const baseQuota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-05-22',
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
  data: { response: [{ fixture: { id: Number(resourceId) || 1 } }] },
  ...overrides,
});

interface MockIngestion {
  readonly fetchWorkload: ReturnType<typeof vi.fn>;
}

const buildDeps = (ingestion: MockIngestion): WorkflowDeps => ({
  ingestion: ingestion as unknown as ApiFootballIngestionLoop,
  competitions: NOOP_COMPETITIONS,
});

describe('webhookCompletedWorkflow', () => {
  it('fetches fixture-detail + events + lineups + team/player stats for the fixture id', async () => {
    const calls: IngestionFetchOptions[] = [];
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => {
        calls.push(options);
        return buildResult(options.workload, options.resourceId);
      }),
    };
    const deps = buildDeps(ingestion);
    const result = await webhookCompletedWorkflow(
      { providerId: 'api-football', fixtureId: '12345' },
      deps
    );

    const workloads = calls.map((c) => c.workload);
    expect(workloads).toEqual([
      'fixture-detail-fullTime',
      'events-post-final',
      'lineups-post-confirm',
      'team-match-stats',
      'player-match-stats',
    ]);
    // The stats workloads must carry their explicit provider paths so the
    // loop hits /fixtures/statistics + /fixtures/players (not the default
    // /fixtures?id= path).
    expect(calls.find((c) => c.workload === 'team-match-stats')?.path).toBe(
      '/fixtures/statistics?fixture=12345'
    );
    expect(calls.find((c) => c.workload === 'player-match-stats')?.path).toBe(
      '/fixtures/players?fixture=12345'
    );
    expect(calls.every((c) => c.resourceId === '12345')).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.fixtureId).toBe('12345');
  });

  it('skips when provider id is unsupported', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(),
    };
    const deps = buildDeps(ingestion);
    const result = await webhookCompletedWorkflow(
      { providerId: 'sportmonks', fixtureId: '12345' },
      deps
    );
    expect(result.status).toBe('skipped');
    expect(ingestion.fetchWorkload).not.toHaveBeenCalled();
  });

  it('idempotent: replay surfaces "cached" without an additional fetched count', async () => {
    let phase: 'fresh' | 'replay' = 'fresh';
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, {
          status: phase === 'fresh' ? 'fetched' : 'cached',
          cacheHit: phase !== 'fresh',
        })
      ),
    };
    const deps = buildDeps(ingestion);

    const first = await webhookCompletedWorkflow(
      { providerId: 'api-football', fixtureId: '999' },
      deps
    );
    phase = 'replay';
    const second = await webhookCompletedWorkflow(
      { providerId: 'api-football', fixtureId: '999' },
      deps
    );

    expect(first.fetches.every((r) => r.status === 'fetched')).toBe(true);
    expect(second.fetches.every((r) => r.status === 'cached')).toBe(true);
    expect(second.status).toBe('completed');
  });

  it('reports failed when every fetch fails', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, {
          status: 'failed',
          error: { message: 'upstream 500' },
        })
      ),
    };
    const deps = buildDeps(ingestion);
    const result = await webhookCompletedWorkflow(
      { providerId: 'api-football', fixtureId: '7' },
      deps
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('upstream 500');
  });

  it('flags soft cap + cached-only without aborting the workflow', async () => {
    const ingestion: MockIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) =>
        buildResult(options.workload, options.resourceId, {
          status: 'cached',
          quota: baseQuota({ calls: 60_500, posture: 'soft_cap_reached' }),
        })
      ),
    };
    const deps = buildDeps(ingestion);
    const result = await webhookCompletedWorkflow(
      { providerId: 'api-football', fixtureId: '88' },
      deps
    );

    expect(result.status).toBe('completed');
    expect(result.degradeFlags.some((f) => f.trigger === 'soft-cap')).toBe(true);
  });
});
