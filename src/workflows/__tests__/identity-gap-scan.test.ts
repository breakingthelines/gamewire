/**
 * Tests for the identity-gap-scan workflow.
 *
 * Covers:
 *   - Enumeration of teams + competitions from the cached fixture-list envelopes
 *   - Resolved entities produce NO gap; unresolved ones DO
 *   - gapsByLeague grouping + a clean league seeded at 0
 *   - Read-only: no fetchWorkload (provider) calls are made
 *   - Soft-fail: an identity error reports `partial`, never throws
 */
import { describe, expect, it, vi } from 'vitest';

import { InMemoryProviderCache, type ProviderCache } from '../../worker/cache.js';
import type {
  IngestionFetchOptions,
  IngestionFetchResult,
  ApiFootballIngestionLoop,
} from '../../worker/ingestion.js';
import type { FootballIdentityLookupClient } from '../../worker/clients/identity.js';
import { identityGapScanWorkflow } from '../identity-gap-scan.js';
import type { CompetitionEntry, WorkflowDeps } from '../types.js';

const COMP_A: CompetitionEntry = {
  key: 'premier-league',
  label: 'Premier League',
  apiFootballLeagueId: 39,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

const COMP_CUP: CompetitionEntry = {
  key: 'fa-cup',
  label: 'FA Cup',
  apiFootballLeagueId: 45,
  season: 2025,
  calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
  tier: 'domestic',
};

/** A /fixtures?league&season envelope with home + away team ids. */
const fixtureListEnvelope = (
  leagueId: number,
  fixtures: Array<{ homeId: number; awayId: number }>
): unknown => ({
  response: fixtures.map(({ homeId, awayId }) => ({
    fixture: { id: 9999, date: '2026-05-01T15:00:00Z', status: { short: 'NS' } },
    league: { id: leagueId, name: 'League', season: 2025 },
    teams: {
      home: { id: homeId, name: `Team ${homeId}`, logo: '' },
      away: { id: awayId, name: `Team ${awayId}`, logo: '' },
    },
  })),
});

class MockIngestion {
  readonly cache: ProviderCache;
  readonly fetchCalls: IngestionFetchOptions[] = [];

  constructor(cache: ProviderCache) {
    this.cache = cache;
  }

  setCachedFixtureList(leagueId: number, season: number, envelope: unknown): void {
    void this.cache.set(
      `api-football:fixtures-next-7d:league-${leagueId}-season-${season}`,
      envelope,
      86400
    );
  }

  // The gap-scan must NEVER call the provider. If it does, the test fails.
  fetchWorkload = vi.fn(async (options: IngestionFetchOptions): Promise<IngestionFetchResult> => {
    this.fetchCalls.push(options);
    throw new Error('identity-gap-scan must not call fetchWorkload');
  });
}

/**
 * `resolutions` maps a provider id (team or league) → canonical id. Anything
 * absent resolves found:false. `throwFor` makes resolve throw for a provider id
 * (to exercise the soft-fail path).
 */
const mockIdentity = (
  resolutions: Record<string, string> = {},
  throwFor: Set<string> = new Set()
): FootballIdentityLookupClient =>
  ({
    lookup: vi.fn(),
    resolve: vi.fn(async (req: { providerId: string }) => {
      if (throwFor.has(req.providerId)) {
        throw new Error('identity transient error');
      }
      const canonical = resolutions[req.providerId] ?? '';
      return { found: canonical !== '', entityId: canonical, entity: undefined };
    }),
    search: vi.fn(),
    stats: vi.fn(),
  }) as unknown as FootballIdentityLookupClient;

const buildDeps = (
  ingestion: MockIngestion,
  overrides: Partial<WorkflowDeps> = {}
): WorkflowDeps => ({
  ingestion: ingestion as unknown as ApiFootballIngestionLoop,
  competitions: [COMP_A, COMP_CUP],
  identity: mockIdentity(),
  clock: () => new Date('2026-06-30T00:00:00Z'),
  ...overrides,
});

describe('identityGapScanWorkflow', () => {
  it('reports unresolved teams + competitions as gaps, grouped by league', async () => {
    const ingestion = new MockIngestion(new InMemoryProviderCache());
    // PL (39): both clubs resolve; the comp resolves.
    ingestion.setCachedFixtureList(39, 2025, fixtureListEnvelope(39, [{ homeId: 42, awayId: 50 }]));
    // FA Cup (45): comp resolves, but a lower-league club (1625) does NOT.
    ingestion.setCachedFixtureList(
      45,
      2025,
      fixtureListEnvelope(45, [{ homeId: 42, awayId: 1625 }])
    );

    const identity = mockIdentity({
      '39': 'btl_football_competition_pl',
      '45': 'btl_football_competition_facup',
      '42': 'btl_football_team_arsenal',
      '50': 'btl_football_team_city',
      // 1625 (Plymouth) intentionally absent → a gap.
    });

    const out = await identityGapScanWorkflow({}, buildDeps(ingestion, { identity }));

    expect(out.status).toBe('completed');
    expect(out.gapsFound).toBe(1);
    expect(out.gaps[0]).toMatchObject({ entityType: 'team', providerId: '1625', leagueId: 45 });
    // PL clean (0), FA Cup has the one club gap.
    expect(out.gapsByLeague['39']).toBe(0);
    expect(out.gapsByLeague['45']).toBe(1);
    // Both competitions + three distinct teams (42,50,1625) were checked.
    expect(out.competitionsChecked).toBe(2);
    expect(out.teamsChecked).toBe(3);
  });

  it('is read-only: never calls the provider fetch path', async () => {
    const ingestion = new MockIngestion(new InMemoryProviderCache());
    ingestion.setCachedFixtureList(39, 2025, fixtureListEnvelope(39, [{ homeId: 42, awayId: 50 }]));
    await identityGapScanWorkflow({}, buildDeps(ingestion, { identity: mockIdentity() }));
    expect(ingestion.fetchCalls).toHaveLength(0);
  });

  it('soft-fails to partial when identity errors, never throws', async () => {
    const ingestion = new MockIngestion(new InMemoryProviderCache());
    ingestion.setCachedFixtureList(39, 2025, fixtureListEnvelope(39, [{ homeId: 42, awayId: 50 }]));
    // resolve throws for team 50 → counted as unresolved + errored → partial.
    const identity = mockIdentity({ '39': 'c', '42': 't' }, new Set(['50']));
    const out = await identityGapScanWorkflow({}, buildDeps(ingestion, { identity }));
    expect(out.status).toBe('partial');
    expect(out.gapsFound).toBe(1); // team 50 unresolved
  });

  it('returns no gaps + empty status when caches are cold', async () => {
    const ingestion = new MockIngestion(new InMemoryProviderCache());
    const out = await identityGapScanWorkflow(
      {},
      buildDeps(ingestion, { identity: mockIdentity() })
    );
    expect(out.entitiesChecked).toBe(0);
    expect(out.gapsFound).toBe(0);
    expect(out.status).toBe('completed');
  });
});
