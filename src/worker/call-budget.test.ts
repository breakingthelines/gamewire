import { describe, expect, it } from 'vitest';

import { LIVE_INGESTION_COMPETITIONS } from '../workflows/competitions.js';
import {
  CURRENT_LOAD_ASSUMPTIONS,
  MEGA_BUDGET_CAPS,
  MEGA_LOAD_ASSUMPTIONS,
  checkCallBudget,
  estimateCallBudget,
  refreshIntervalSeconds,
  type CallBudgetCaps,
} from './call-budget.js';
import { INGESTION_TICK_INTERVAL_MS, INGESTION_TTL_SECONDS } from './ingestion.js';
import {
  DEFAULT_PROVIDER_MINUTE_CAPS,
  DEFAULT_PROVIDER_MINUTE_CAP_LIVE,
} from './minute-limiter.js';
import {
  DEFAULT_PROVIDER_HARD_CAP,
  DEFAULT_PROVIDER_PLAN_CEILING,
  DEFAULT_PROVIDER_SOFT_CAP,
  DEFAULT_PROVIDER_BACKGROUND_DAILY_CAP,
  defaultBackgroundDailyCap,
} from './quota.js';

/** Prod env today, before INF-1 (infrastructure gamewire-worker config.env). */
const CURRENT_CAPS: CallBudgetCaps = {
  softCap: 60_000,
  hardCap: 70_000,
  planDailyCeiling: 75_000,
  backgroundDailyCap: defaultBackgroundDailyCap(60_000, 70_000),
  minuteCaps: DEFAULT_PROVIDER_MINUTE_CAPS,
  planMinuteCeiling: 900,
};

/** GW-2: live tick 15s, TTL 14s, stats TTL unchanged. */
const GW2_TICK = { liveTickSeconds: 15, liveTtlSeconds: 14 } as const;

describe('live catalogue invariants', () => {
  it('has unique keys and unique API-Football league ids', () => {
    const keys = LIVE_INGESTION_COMPETITIONS.map((c) => c.key);
    const leagueIds = LIVE_INGESTION_COMPETITIONS.map((c) => c.apiFootballLeagueId);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(leagueIds).size).toBe(leagueIds.length);
  });

  it('models the whole live catalogue by default for current load', () => {
    expect(CURRENT_LOAD_ASSUMPTIONS.competitions).toBe(LIVE_INGESTION_COMPETITIONS.length);
    const estimate = estimateCallBudget('api-football', CURRENT_LOAD_ASSUMPTIONS);
    expect(estimate.assumptions.competitions).toBe(LIVE_INGESTION_COMPETITIONS.length);
  });

  it('reads the live tick and TTLs from the ingestion tables', () => {
    expect(CURRENT_LOAD_ASSUMPTIONS.liveTickSeconds).toBe(
      INGESTION_TICK_INTERVAL_MS['fixture-detail-live'] / 1_000
    );
    expect(CURRENT_LOAD_ASSUMPTIONS.liveTtlSeconds).toBe(
      INGESTION_TTL_SECONDS['fixture-detail-live']
    );
    expect(CURRENT_LOAD_ASSUMPTIONS.statsTtlSeconds).toBe(
      INGESTION_TTL_SECONDS['team-match-stats']
    );
  });
});

describe('refreshIntervalSeconds', () => {
  it('refreshes every tick when the TTL is at or below the tick', () => {
    expect(refreshIntervalSeconds(30, 30)).toBe(30);
    expect(refreshIntervalSeconds(15, 14)).toBe(15);
  });

  it('refreshes on the first tick after expiry when the TTL is longer', () => {
    expect(refreshIntervalSeconds(30, 60)).toBe(60);
    expect(refreshIntervalSeconds(15, 60)).toBe(60);
    expect(refreshIntervalSeconds(1, 6)).toBe(6);
    expect(refreshIntervalSeconds(25, 60)).toBe(75);
  });

  it('rejects a non-positive tick', () => {
    expect(() => refreshIntervalSeconds(0, 30)).toThrow(/positive/);
  });
});

describe('per-fixture mechanism', () => {
  it('scales live detail calls with fixtures and live minutes, not a flat global feed', () => {
    const estimate = estimateCallBudget('api-football', {
      ...MEGA_LOAD_ASSUMPTIONS,
      ...GW2_TICK,
    });
    const live = estimate.lines.find((line) => line.workload === 'fixture-detail-live');
    // 115 live minutes at a 15s refresh = 460 calls per fixture.
    expect(live?.avgPerDay).toBeCloseTo(31 * 460);
    expect(live?.peakDay).toBeCloseTo(115 * 460);
    // 63 concurrent fixtures x 4 refreshes a minute.
    expect(live?.peakMinute).toBe(252);
    expect(live?.priority).toBe('live');
  });

  it('keeps stats calls TTL-bound: a faster tick does not double them', () => {
    const at30 = estimateCallBudget('api-football', MEGA_LOAD_ASSUMPTIONS);
    const at15 = estimateCallBudget('api-football', { ...MEGA_LOAD_ASSUMPTIONS, ...GW2_TICK });
    const stats = (e: typeof at30) =>
      e.lines.find((line) => line.workload.startsWith('team-match-stats'));
    expect(stats(at15)?.peakDay).toBe(stats(at30)?.peakDay);
    // 2 calls a minute for 115 minutes.
    expect(stats(at30)?.peakDay).toBeCloseTo(115 * 230);
  });

  it('matches the measured baseline of about 11k calls a day today', () => {
    const estimate = estimateCallBudget('api-football', CURRENT_LOAD_ASSUMPTIONS);
    expect(estimate.totals.avgPerDay).toBeGreaterThan(9_000);
    expect(estimate.totals.avgPerDay).toBeLessThan(14_000);
  });

  it('can leave out the planned enrichment lines', () => {
    const withPlanned = estimateCallBudget('api-football', MEGA_LOAD_ASSUMPTIONS);
    const without = estimateCallBudget('api-football', {
      ...MEGA_LOAD_ASSUMPTIONS,
      includePlanned: false,
    });
    expect(without.lines.some((line) => line.planned)).toBe(false);
    expect(withPlanned.lines.some((line) => line.planned)).toBe(true);
    expect(without.totals.peakDay).toBeLessThan(withPlanned.totals.peakDay);
  });
});

describe('code defaults', () => {
  it('match the Mega plan caps (spec contract 4)', () => {
    expect({
      softCap: DEFAULT_PROVIDER_SOFT_CAP,
      hardCap: DEFAULT_PROVIDER_HARD_CAP,
      planDailyCeiling: DEFAULT_PROVIDER_PLAN_CEILING,
      backgroundDailyCap: defaultBackgroundDailyCap(
        DEFAULT_PROVIDER_SOFT_CAP,
        DEFAULT_PROVIDER_HARD_CAP
      ),
    }).toEqual({
      softCap: MEGA_BUDGET_CAPS.softCap,
      hardCap: MEGA_BUDGET_CAPS.hardCap,
      planDailyCeiling: MEGA_BUDGET_CAPS.planDailyCeiling,
      backgroundDailyCap: DEFAULT_PROVIDER_BACKGROUND_DAILY_CAP,
    });
  });
});

describe('peak assertions', () => {
  it('current load fits the caps prod runs with today', () => {
    const estimate = estimateCallBudget('api-football', CURRENT_LOAD_ASSUMPTIONS, CURRENT_CAPS);
    expect(estimate.warnings).toEqual([]);
    expect(estimate.totals.peakDay).toBeLessThanOrEqual(CURRENT_CAPS.softCap);
    expect(estimate.totals.peakMinute).toBeLessThanOrEqual(DEFAULT_PROVIDER_MINUTE_CAP_LIVE);
  });

  it('a 115-fixture Saturday on the 15s tick stays under the Mega soft cap', () => {
    const estimate = estimateCallBudget('api-football', {
      ...MEGA_LOAD_ASSUMPTIONS,
      ...GW2_TICK,
    });
    expect(estimate.assumptions.peakDayFixtures).toBe(115);
    expect(estimate.totals.peakDay).toBeLessThanOrEqual(MEGA_BUDGET_CAPS.softCap);
    expect(estimate.warnings).toEqual([]);
  });

  it('peak minute on the 15s tick stays at or under the live minute ceiling', () => {
    const estimate = estimateCallBudget('api-football', {
      ...MEGA_LOAD_ASSUMPTIONS,
      ...GW2_TICK,
    });
    expect(estimate.totals.peakMinute).toBeLessThanOrEqual(MEGA_BUDGET_CAPS.minuteCaps.live);
    expect(estimate.totals.overnightWorstMinute).toBeLessThanOrEqual(
      MEGA_BUDGET_CAPS.minuteCaps.live
    );
    expect(MEGA_BUDGET_CAPS.minuteCaps.live).toBeLessThanOrEqual(
      MEGA_BUDGET_CAPS.planMinuteCeiling
    );
  });

  it('background peak day stays under the background daily cap', () => {
    const estimate = estimateCallBudget('api-football', {
      ...MEGA_LOAD_ASSUMPTIONS,
      ...GW2_TICK,
    });
    const background = estimate.lines
      .filter((line) => line.priority === 'background')
      .reduce((total, line) => total + line.peakDay, 0);
    expect(background).toBeLessThanOrEqual(MEGA_BUDGET_CAPS.backgroundDailyCap);
  });

  it('flags a 15s stats TTL: the peak day passes the 150k plan (owner decision D8)', () => {
    const estimate = estimateCallBudget('api-football', {
      ...MEGA_LOAD_ASSUMPTIONS,
      ...GW2_TICK,
      statsTtlSeconds: 15,
    });
    expect(estimate.totals.peakDay).toBeGreaterThan(MEGA_BUDGET_CAPS.planDailyCeiling);
    expect(estimate.warnings.some((w) => w.includes('plan ceiling'))).toBe(true);
    expect(estimate.warnings.some((w) => w.includes('soft cap'))).toBe(true);
  });

  it('flags the Mega load on today prod caps: the leagues need INF-1 first', () => {
    const estimate = estimateCallBudget(
      'api-football',
      { ...MEGA_LOAD_ASSUMPTIONS, ...GW2_TICK },
      CURRENT_CAPS
    );
    expect(estimate.warnings.some((w) => w.includes('soft cap'))).toBe(true);
  });

  it('checkCallBudget reports minute breaches', () => {
    const estimate = estimateCallBudget('api-football', MEGA_LOAD_ASSUMPTIONS);
    const tight: CallBudgetCaps = {
      ...MEGA_BUDGET_CAPS,
      minuteCaps: { live: 300, 'near-live': 250, background: 200 },
    };
    const warnings = checkCallBudget(estimate, tight);
    expect(warnings.some((w) => w.startsWith('Peak minute'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('Overnight worst minute'))).toBe(true);
  });
});
