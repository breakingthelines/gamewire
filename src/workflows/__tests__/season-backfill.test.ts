import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryProviderCache, type ProviderCache } from '../../worker/cache.js';
import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
} from '../../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import { __test, seasonBackfillWorkflow, DEFAULT_MAX_CALLS_PER_RUN } from '../season-backfill.js';
import type { CompetitionEntry, SeasonBackfillInput, WorkflowDeps } from '../types.js';

const COMPETITION_A: CompetitionEntry = {
  key: 'comp-a',
  label: 'Competition A',
  apiFootballLeagueId: 39,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const COMPETITION_B: CompetitionEntry = {
  key: 'comp-b',
  label: 'Competition B',
  apiFootballLeagueId: 140,
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

/**
 * A fixture-list envelope for `/fixtures?league&season`. `finalisedIds`
 * become FT fixtures; `scheduledIds` become NS (not-started) fixtures
 * which the backfill must ignore.
 */
const seasonEnvelope = (
  finalisedIds: readonly number[],
  scheduledIds: readonly number[] = []
): unknown => ({
  response: [
    ...finalisedIds.map((id) => ({
      fixture: { id, date: '2026-05-20T15:00:00Z', status: { short: 'FT' } },
      teams: { home: { id: 50 }, away: { id: 60 } },
    })),
    ...scheduledIds.map((id) => ({
      fixture: { id, date: '2026-08-20T15:00:00Z', status: { short: 'NS' } },
      teams: { home: { id: 50 }, away: { id: 60 } },
    })),
  ],
});

/**
 * Mock ingestion loop that models the real loop's cache-first semantics
 * closely enough to test resume + idempotency:
 *
 *   - the cursor + season-fixtures payloads live in a real
 *     {@link InMemoryProviderCache} so persistence across runs is genuine;
 *   - `fetchWorkload` records every call, serves a provider payload per
 *     (workload,resourceId), and counts a real provider "fetch" only on
 *     the first touch of each cache key (subsequent touches are `cached`),
 *     mirroring the production loop so the test can assert that resumed
 *     runs do not re-hit the provider for fixtures already processed.
 */
class MockIngestion {
  readonly cache: ProviderCache;
  readonly calls: IngestionFetchOptions[] = [];
  /** Provider fetch count per cache key — first touch fetches, rest are cached. */
  private readonly fetched = new Set<string>();
  /** Per-resource provider payloads keyed by workload:resource. */
  private readonly payloads = new Map<string, unknown>();
  /** Optional per-call quota override hook (e.g. to simulate hard cap). */
  quotaFor: (call: IngestionFetchOptions, index: number) => ProviderQuotaSnapshot = () =>
    baseQuota();

  constructor(cache: ProviderCache) {
    this.cache = cache;
  }

  setSeasonFixtures(leagueId: number, season: number, payload: unknown): void {
    this.payloads.set(`season:${leagueId}:${season}`, payload);
  }

  fetchWorkload = vi.fn(async (options: IngestionFetchOptions): Promise<IngestionFetchResult> => {
    const index = this.calls.length;
    this.calls.push(options);
    const key = `${options.workload}:${options.resourceId}`;
    const firstTouch = !this.fetched.has(key);
    this.fetched.add(key);

    // Resolve the payload this call should "return". Season fixture
    // discovery returns the configured season envelope; everything else
    // returns a single-fixture-ish envelope so the workflow keeps moving.
    let data: unknown = { response: [] };
    if (options.resourceId.startsWith('backfill-fixtures-')) {
      const match = /backfill-fixtures-(\d+)-(\d+)/.exec(options.resourceId);
      if (match) {
        data = this.payloads.get(`season:${match[1]}:${match[2]}`) ?? { response: [] };
      }
    } else if (options.resourceId.startsWith('backfill-standings-')) {
      data = { response: [{ league: {} }] };
    } else {
      data = { response: [{ fixture: { id: Number(options.resourceId) || 1 } }] };
    }

    const quota = this.quotaFor(options, index);
    const denied = quota.posture === 'hard_cap_reached';
    return {
      status: denied ? 'denied' : firstTouch ? 'fetched' : 'cached',
      workload: options.workload,
      resourceId: options.resourceId,
      cacheKey: key,
      cacheHit: !firstTouch,
      cachedOnlyMode: quota.cachedOnlyMode,
      quota,
      data: denied ? undefined : data,
      fallbackReason: denied ? 'PROVIDER_OUTAGE' : undefined,
      error: denied
        ? { message: `Provider quota hard_cap reached: ${quota.calls} >= ${quota.hardCap}` }
        : undefined,
    };
  });

  /** Count of calls that actually hit the provider (status fetched). */
  providerFetchCalls(): number {
    return [...this.fetched].length;
  }

  fixtureDetailCallsFor(fixtureId: string): number {
    return this.calls.filter(
      (c) => c.resourceId === fixtureId && c.workload === 'fixture-detail-fullTime'
    ).length;
  }
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

const run = (
  ingestion: MockIngestion,
  competitions: readonly CompetitionEntry[],
  input: SeasonBackfillInput,
  overrides: Partial<WorkflowDeps> = {}
) => seasonBackfillWorkflow(input, buildDeps(ingestion, competitions, overrides));

describe('seasonBackfillWorkflow — target resolution', () => {
  let cache: InMemoryProviderCache;
  beforeEach(() => {
    cache = new InMemoryProviderCache();
  });

  it('expands the catalogue across the requested seasons', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2024, seasonEnvelope([]));
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([]));
    ingestion.setSeasonFixtures(140, 2024, seasonEnvelope([]));
    ingestion.setSeasonFixtures(140, 2025, seasonEnvelope([]));

    const result = await run(ingestion, [COMPETITION_A, COMPETITION_B], { seasons: [2024, 2025] });

    expect(result.targets.map((t) => t.target).sort()).toEqual([
      'comp-a:2024',
      'comp-a:2025',
      'comp-b:2024',
      'comp-b:2025',
    ]);
  });

  it('defaults to each catalogue entry season when seasons omitted', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([]));
    const result = await run(ingestion, [COMPETITION_A], {});
    expect(result.targets.map((t) => t.target)).toEqual(['comp-a:2025']);
    expect(result.targets[0]?.season).toBe(2025);
  });

  it('honours an explicit league id over the catalogue key', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(999, 2023, seasonEnvelope([]));
    const result = await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', apiFootballLeagueId: 999, season: 2023 }],
    });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.apiFootballLeagueId).toBe(999);
    expect(result.targets[0]?.season).toBe(2023);
  });

  it('drops a target whose key is unknown and has no explicit league id', async () => {
    const ingestion = new MockIngestion(cache);
    const result = await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'does-not-exist', season: 2025 }],
    });
    expect(result.targets).toHaveLength(0);
    // No /fixtures?league=0 call should ever be issued.
    expect(ingestion.calls.every((c) => !c.path?.includes('league=0'))).toBe(true);
  });

  it('de-duplicates league+season targets', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([]));
    const result = await run(ingestion, [COMPETITION_A], {
      targets: [
        { competitionKey: 'comp-a', season: 2025 },
        { apiFootballLeagueId: 39, season: 2025 },
      ],
    });
    expect(result.targets).toHaveLength(1);
  });
});

describe('seasonBackfillWorkflow — full season walk', () => {
  let cache: InMemoryProviderCache;
  beforeEach(() => {
    cache = new InMemoryProviderCache();
  });

  it('discovers finalised fixtures and pulls detail+events+lineups for each', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([1001, 1002, 1003], [2001, 2002]));

    const result = await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
    });

    expect(result.status).toBe('complete');
    const target = result.targets[0];
    expect(target?.fixturesDiscovered).toBe(3); // scheduled fixtures excluded
    expect(target?.fixturesProcessed).toBe(3);
    expect(target?.complete).toBe(true);

    // Each finalised fixture got exactly one detail, events, and lineup call.
    for (const id of ['1001', '1002', '1003']) {
      expect(
        ingestion.calls.filter(
          (c) => c.resourceId === id && c.workload === 'fixture-detail-fullTime'
        )
      ).toHaveLength(1);
      expect(
        ingestion.calls.filter((c) => c.resourceId === id && c.workload === 'events-post-final')
      ).toHaveLength(1);
      expect(
        ingestion.calls.filter((c) => c.resourceId === id && c.workload === 'lineups-post-confirm')
      ).toHaveLength(1);
    }
    // Scheduled fixtures were never touched.
    expect(ingestion.calls.some((c) => c.resourceId === '2001')).toBe(false);
  });

  it('uses the unbounded /fixtures?league&season path (full season, not a window)', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([1001]));
    await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
    });

    const fixturesCall = ingestion.calls.find((c) => c.resourceId.startsWith('backfill-fixtures-'));
    expect(fixturesCall?.path).toBe('/fixtures?league=39&season=2025');
    // No from/to window param — this is the whole season.
    expect(fixturesCall?.path).not.toContain('from=');
  });

  it('pulls standings once per season', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([1001]));
    await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
    });
    const standingsCalls = ingestion.calls.filter(
      (c) => c.workload === 'fixtures-next-7d' && c.path?.startsWith('/standings')
    );
    expect(standingsCalls).toHaveLength(1);
    expect(standingsCalls[0]?.path).toBe('/standings?league=39&season=2025');
  });

  it('treats a season with zero finalised fixtures as complete (no re-run forever)', async () => {
    // A future season / not-yet-kicked-off tournament has no settled
    // fixtures. Discovery materialises an empty list; the target must be
    // `complete` so the caller stops re-invoking it.
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2026, seasonEnvelope([], [9001, 9002]));
    const result = await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', season: 2026 }],
    });
    expect(result.status).toBe('complete');
    expect(result.targets[0]?.fixturesDiscovered).toBe(0);
    expect(result.targets[0]?.complete).toBe(true);

    // A re-run with the same cache does not re-discover (discovered flag set).
    const rerun = new MockIngestion(cache);
    rerun.setSeasonFixtures(39, 2026, seasonEnvelope([]));
    await run(rerun, [COMPETITION_A], { targets: [{ competitionKey: 'comp-a', season: 2026 }] });
    expect(rerun.calls.some((c) => c.resourceId.startsWith('backfill-fixtures-'))).toBe(false);
  });

  it('emits started + finished structured log events', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([]));
    const logs: { event: string }[] = [];
    await run(
      ingestion,
      [COMPETITION_A],
      { targets: [{ competitionKey: 'comp-a', season: 2025 }] },
      {
        logger: (entry) => logs.push(entry),
      }
    );
    expect(logs[0]?.event).toBe('season_backfill.started');
    expect(logs.at(-1)?.event).toBe('season_backfill.finished');
  });
});

describe('seasonBackfillWorkflow — pagination / resume via cursor', () => {
  let cache: InMemoryProviderCache;
  beforeEach(() => {
    cache = new InMemoryProviderCache();
  });

  it('checkpoints mid-season under a small per-run budget, then resumes to completion', async () => {
    const finalised = [1001, 1002, 1003, 1004, 1005];
    const target: SeasonBackfillInput = {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
      // Budget: standings (1) + season-discovery (1) + 1 fixture (3) = 5 calls.
      maxCallsPerRun: 5,
    };

    // First run shares the cache so the cursor persists across runs.
    const run1 = new MockIngestion(cache);
    run1.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));
    const out1 = await run(run1, [COMPETITION_A], target);

    expect(out1.status).toBe('incomplete');
    expect(out1.targets[0]?.complete).toBe(false);
    expect(out1.targets[0]?.fixturesDiscovered).toBe(5);
    // Exactly one fixture processed before the budget ran out.
    expect(out1.targets[0]?.fixturesProcessed).toBe(1);
    expect(out1.targets[0]?.cursorIndex).toBe(1);

    // Cursor persisted in the shared cache.
    const cursor = await cache.get<{ nextIndex: number; fixtureIds: string[] }>(
      __test.cursorKey(39, 2025)
    );
    expect(cursor?.nextIndex).toBe(1);
    expect(cursor?.fixtureIds).toEqual(['1001', '1002', '1003', '1004', '1005']);

    // Second run: resumes from the cursor. A fresh ingestion mock with the
    // SAME cache — so the cursor is read, but this mock's provider-fetch
    // counters start fresh, letting us prove resume picks up at fixture #2
    // and does NOT re-fetch fixture #1's detail.
    const run2 = new MockIngestion(cache);
    run2.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));
    const out2 = await run(run2, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
      // No budget cap on the resume run.
    });

    expect(out2.status).toBe('complete');
    expect(out2.targets[0]?.complete).toBe(true);
    expect(out2.targets[0]?.cursorIndex).toBe(5);
    // Resume processed the remaining four fixtures only.
    expect(out2.targets[0]?.fixturesProcessed).toBe(4);

    // Fixture #1 (1001) was NOT re-fetched on the resume run.
    expect(run2.fixtureDetailCallsFor('1001')).toBe(0);
    // Fixtures #2-#5 were fetched on the resume run.
    for (const id of ['1002', '1003', '1004', '1005']) {
      expect(run2.fixtureDetailCallsFor(id)).toBe(1);
    }
    // Resume did NOT re-discover the season (standings + fixtures skipped).
    expect(run2.calls.some((c) => c.resourceId.startsWith('backfill-fixtures-'))).toBe(false);
    expect(run2.calls.some((c) => c.path?.startsWith('/standings'))).toBe(false);
  });

  it('resumes across three runs and processes every fixture exactly once in total', async () => {
    const finalised = [10, 20, 30, 40];
    const detailTouchesPerFixture = new Map<string, number>();
    const recordRun = (ingestion: MockIngestion): void => {
      for (const id of finalised.map(String)) {
        detailTouchesPerFixture.set(
          id,
          (detailTouchesPerFixture.get(id) ?? 0) + ingestion.fixtureDetailCallsFor(id)
        );
      }
    };

    // Each run can do standings(1)+discovery(1)+1 fixture(3) on the first
    // run, then 1 fixture(3) on resumes. Budget 5 keeps it to ~1 fixture/run.
    const input: SeasonBackfillInput = {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
      maxCallsPerRun: 5,
    };

    let lastStatus = '';
    let guard = 0;
    do {
      const ingestion = new MockIngestion(cache);
      ingestion.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));
      const out = await run(ingestion, [COMPETITION_A], input);
      recordRun(ingestion);
      lastStatus = out.status;
      guard += 1;
    } while (lastStatus !== 'complete' && guard < 10);

    expect(lastStatus).toBe('complete');
    // Every fixture's detail was fetched exactly once across all runs.
    for (const id of finalised.map(String)) {
      expect(detailTouchesPerFixture.get(id)).toBe(1);
    }
  });
});

describe('seasonBackfillWorkflow — idempotency', () => {
  let cache: InMemoryProviderCache;
  beforeEach(() => {
    cache = new InMemoryProviderCache();
  });

  it('re-running a completed backfill against the same cache is a no-op (cursor short-circuit)', async () => {
    const finalised = [1001, 1002];
    const input: SeasonBackfillInput = { targets: [{ competitionKey: 'comp-a', season: 2025 }] };

    const run1 = new MockIngestion(cache);
    run1.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));
    const out1 = await run(run1, [COMPETITION_A], input);
    expect(out1.status).toBe('complete');
    expect(out1.targets[0]?.fixturesProcessed).toBe(2);

    // Re-run with a fresh mock but the SAME cache. The cursor says the
    // season is fully processed → no fixture work, no provider fetches.
    const run2 = new MockIngestion(cache);
    run2.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));
    const out2 = await run(run2, [COMPETITION_A], input);

    expect(out2.status).toBe('complete');
    expect(out2.targets[0]?.complete).toBe(true);
    expect(out2.targets[0]?.fixturesProcessed).toBe(0);
    // No fixture-detail calls at all on the idempotent re-run.
    expect(run2.calls.some((c) => c.workload === 'fixture-detail-fullTime')).toBe(false);
  });

  it('reset=true re-walks the full season and drives the same fixture ids again', async () => {
    const finalised = [1001, 1002];
    const input: SeasonBackfillInput = { targets: [{ competitionKey: 'comp-a', season: 2025 }] };

    const run1 = new MockIngestion(cache);
    run1.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));
    await run(run1, [COMPETITION_A], input);

    // reset=true discards the cursor; the season is re-discovered and every
    // fixture is driven through the (idempotent) ingest path again. This is
    // the operator "re-import" lever; correctness is owned by game-service
    // upserts + the emit-once gate, so re-driving the same ids is safe.
    const run2 = new MockIngestion(cache);
    run2.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));
    const out2 = await run(run2, [COMPETITION_A], { ...input, reset: true });

    expect(out2.status).toBe('complete');
    expect(out2.targets[0]?.fixturesProcessed).toBe(2);
    // The SAME fixture ids (1001, 1002) were driven again — no new ids.
    for (const id of ['1001', '1002']) {
      expect(run2.fixtureDetailCallsFor(id)).toBe(1);
    }
    expect(run2.calls.some((c) => c.resourceId === '9999')).toBe(false);
  });

  it('a warm provider cache makes re-driven fixtures cache-hits (no double provider fetch)', async () => {
    const finalised = [1001];
    const input: SeasonBackfillInput = {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
      reset: true,
    };
    // Single ingestion instance (shared provider-fetch counters) re-driven
    // twice with reset: the second pass sees cached fixture payloads.
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope(finalised));

    await run(ingestion, [COMPETITION_A], input);
    const fetchesAfterFirst = ingestion.providerFetchCalls();

    await run(ingestion, [COMPETITION_A], input);
    const fetchesAfterSecond = ingestion.providerFetchCalls();

    // No NEW provider cache keys were minted on the second pass — every
    // re-driven resource was already a known key (a cache hit in prod).
    expect(fetchesAfterSecond).toBe(fetchesAfterFirst);
  });
});

describe('seasonBackfillWorkflow — quota degradation', () => {
  let cache: InMemoryProviderCache;
  beforeEach(() => {
    cache = new InMemoryProviderCache();
  });

  it('aborts on hard cap and checkpoints the cursor for resume', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([1001, 1002, 1003]));
    // Hard-cap every call from the 4th onwards (standings + discovery +
    // fixture#1 detail succeed; fixture#1 events trips the cap).
    let n = 0;
    ingestion.quotaFor = () => {
      n += 1;
      return n >= 4
        ? baseQuota({ calls: 70_000, posture: 'hard_cap_reached', cachedOnlyMode: true })
        : baseQuota();
    };

    const result = await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
    });

    expect(result.status).toBe('aborted');
    expect(result.degradeFlags.some((f) => f.trigger === 'hard-cap')).toBe(true);
    expect(result.targets[0]?.complete).toBe(false);
    // The season fixture list was still discovered + persisted, so a later
    // run (after the daily quota resets) resumes rather than rediscovering.
    const cursor = await cache.get<{ fixtureIds: string[] }>(__test.cursorKey(39, 2025));
    expect(cursor?.fixtureIds).toEqual(['1001', '1002', '1003']);
  });

  it('flags soft-cap / PROVIDER_OUTAGE without aborting', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([1001]));
    ingestion.quotaFor = () =>
      baseQuota({ calls: 60_500, posture: 'soft_cap_reached', cachedOnlyMode: true });

    const result = await run(ingestion, [COMPETITION_A], {
      targets: [{ competitionKey: 'comp-a', season: 2025 }],
    });

    const triggers = result.degradeFlags.map((f) => f.trigger);
    expect(triggers).toContain('soft-cap');
    expect(result.status).not.toBe('aborted');
  });

  it('halts remaining targets once the per-run budget is exhausted', async () => {
    const ingestion = new MockIngestion(cache);
    ingestion.setSeasonFixtures(39, 2025, seasonEnvelope([1001, 1002, 1003, 1004]));
    ingestion.setSeasonFixtures(140, 2025, seasonEnvelope([3001]));

    const result = await run(ingestion, [COMPETITION_A, COMPETITION_B], {
      // Budget only covers the first target's standings + discovery + 1 fixture.
      maxCallsPerRun: 5,
      targets: [
        { competitionKey: 'comp-a', season: 2025 },
        { competitionKey: 'comp-b', season: 2025 },
      ],
    });

    expect(result.status).toBe('incomplete');
    const compB = result.targets.find((t) => t.competition === 'comp-b');
    // comp-b was skipped this run — zero calls spent on it.
    expect(compB?.callsBudgeted).toBe(0);
    expect(compB?.fixturesProcessed).toBe(0);
    // ...and comp-b's season was never discovered.
    expect(ingestion.calls.some((c) => c.path === '/fixtures?league=140&season=2025')).toBe(false);
  });
});

describe('seasonBackfillWorkflow — internals', () => {
  it('finalisedFixtureIds keeps only settled statuses, de-dupes, preserves order', () => {
    const data = {
      response: [
        { fixture: { id: 3, status: { short: 'FT' } } },
        { fixture: { id: 1, status: { short: 'NS' } } }, // scheduled — drop
        { fixture: { id: 2, status: { short: 'AET' } } },
        { fixture: { id: 3, status: { short: 'FT' } } }, // dup — drop
        { fixture: { id: 4, status: { short: 'PEN' } } },
        { fixture: { id: 5, status: { short: 'PST' } } }, // postponed — drop
        { fixture: { id: 6, status: { short: 'WO' } } },
      ],
    };
    expect(__test.finalisedFixtureIds(data)).toEqual(['3', '2', '4', '6']);
  });

  it('finalisedFixtureIds returns [] for malformed envelopes', () => {
    expect(__test.finalisedFixtureIds(undefined)).toEqual([]);
    expect(__test.finalisedFixtureIds({})).toEqual([]);
    expect(__test.finalisedFixtureIds({ response: 'nope' })).toEqual([]);
  });

  it('exposes a sane default per-run budget', () => {
    expect(DEFAULT_MAX_CALLS_PER_RUN).toBeGreaterThan(0);
    expect(DEFAULT_MAX_CALLS_PER_RUN).toBeLessThan(70_000);
  });
});
