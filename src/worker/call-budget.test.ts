import { describe, expect, it } from 'vitest';

import { LIVE_INGESTION_COMPETITIONS } from '../workflows/competitions.js';
import {
  CURRENT_LOAD_ASSUMPTIONS,
  MEGA_BUDGET_CAPS,
  MEGA_LOAD_ASSUMPTIONS,
  PLAYER_SEASON_STATS_HISTORY_CALLS,
  checkCallBudget,
  estimateCallBudget,
  planEnrichmentRuns,
  refreshIntervalSeconds,
  type CallBudgetCaps,
} from './call-budget.js';
import { INGESTION_TICK_INTERVAL_MS, INGESTION_TTL_SECONDS } from './ingestion.js';
import {
  DEFAULT_ENRICHMENT_MINUTE_CAP,
  DEFAULT_PROVIDER_MINUTE_CAPS,
  DEFAULT_PROVIDER_MINUTE_CAP_LIVE,
} from './minute-limiter.js';
import {
  DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN,
  MAX_ENRICHMENT_CALLS_PER_RUN,
} from '../workflows/provider-enrichment.js';
import {
  DEFAULT_UNIT_MAX_CALLS_PER_RUN,
  INJURIES_COVERED_LEAGUE_IDS,
} from '../workflows/provider-enrichment-units.js';
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

describe('player-season-stats (GW-6a)', () => {
  const mega = () => estimateCallBudget('api-football', { ...MEGA_LOAD_ASSUMPTIONS, ...GW2_TICK });
  const line = (estimate: ReturnType<typeof mega>) =>
    estimate.lines.find((l) => l.workload === 'player-season-stats');

  it('is a built background line: a nightly refresh of every domestic league page', () => {
    const pss = line(mega());
    expect(pss).toMatchObject({ priority: 'background', planned: false, peakMinute: 0 });
    expect(pss?.peakDay).toBe(21 * 50);
    expect(pss?.avgPerDay).toBe(21 * 50);
    // Exactly one line: the planned GW-6 placeholder is gone.
    expect(mega().lines.filter((l) => l.workload === 'player-season-stats')).toHaveLength(1);
  });

  it('a nightly refresh fits one run under the default per-run limit', () => {
    for (const a of [CURRENT_LOAD_ASSUMPTIONS, MEGA_LOAD_ASSUMPTIONS]) {
      expect(a.domesticLeagues * a.playerSeasonPagesPerLeague).toBeLessThanOrEqual(
        DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN
      );
    }
  });

  it('peak: a Saturday with a maximum history run on top stays under every daily cap', () => {
    const estimate = estimateCallBudget('api-football', {
      ...MEGA_LOAD_ASSUMPTIONS,
      ...GW2_TICK,
      enrichmentBackfillCallsPerDay: MAX_ENRICHMENT_CALLS_PER_RUN,
    });
    expect(estimate.warnings).toEqual([]);
    expect(estimate.totals.peakDay).toBeLessThanOrEqual(MEGA_BUDGET_CAPS.softCap);
    const background = estimate.lines
      .filter((l) => l.priority === 'background')
      .reduce((total, l) => total + l.peakDay, 0);
    expect(background).toBeLessThanOrEqual(MEGA_BUDGET_CAPS.backgroundDailyCap);
    expect(line(estimate)?.peakDay).toBe(21 * 50 + MAX_ENRICHMENT_CALLS_PER_RUN);
  });

  it('peak: today caps also absorb a history run (the backfill can run before INF-1)', () => {
    const estimate = estimateCallBudget(
      'api-football',
      { ...CURRENT_LOAD_ASSUMPTIONS, enrichmentBackfillCallsPerDay: MAX_ENRICHMENT_CALLS_PER_RUN },
      CURRENT_CAPS
    );
    expect(estimate.warnings).toEqual([]);
    expect(estimate.totals.peakDay).toBeLessThanOrEqual(CURRENT_CAPS.softCap);
  });

  it('peak minute: the job ceiling sits under the background ceiling, so live keeps its headroom', () => {
    expect(DEFAULT_ENRICHMENT_MINUTE_CAP).toBe(120);
    expect(DEFAULT_ENRICHMENT_MINUTE_CAP).toBeLessThanOrEqual(
      MEGA_BUDGET_CAPS.minuteCaps.background
    );
    const estimate = mega();
    // Worst minute with the job running at its ceiling beside the busiest live minute.
    expect(estimate.totals.peakMinute + DEFAULT_ENRICHMENT_MINUTE_CAP).toBeLessThanOrEqual(
      MEGA_BUDGET_CAPS.minuteCaps.live
    );
    expect(estimate.totals.overnightWorstMinute).toBeLessThanOrEqual(
      MEGA_BUDGET_CAPS.minuteCaps.live
    );
  });

  it('history backfill: about 3,500 calls take three default runs of at least 13 minutes', () => {
    expect(
      planEnrichmentRuns(PLAYER_SEASON_STATS_HISTORY_CALLS, DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN)
    ).toEqual({ runs: 3, minutesPerFullRun: 13, totalMinutes: 30 });
    expect(
      planEnrichmentRuns(PLAYER_SEASON_STATS_HISTORY_CALLS, MAX_ENRICHMENT_CALLS_PER_RUN)
    ).toEqual({
      runs: 1,
      minutesPerFullRun: 30,
      totalMinutes: 30,
    });
    expect(() => planEnrichmentRuns(10, 0)).toThrow(/positive/);
  });
});

describe('GW-6b datasets: injuries, sidelined, transfers, trophies', () => {
  const mega = () => estimateCallBudget('api-football', MEGA_LOAD_ASSUMPTIONS);
  const line = (workload: string) => {
    const found = mega().lines.filter((l) => l.workload === workload);
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  it('models each as built background load, not planned', () => {
    for (const workload of ['injuries-league', 'player-sidelined', 'team-transfers', 'trophies']) {
      expect(line(workload)).toMatchObject({
        priority: 'background',
        peakMinute: 0,
        planned: false,
      });
    }
  });

  it('counts injuries as covered leagues x 8 pulls a day', () => {
    expect(INJURIES_COVERED_LEAGUE_IDS.size).toBe(MEGA_LOAD_ASSUMPTIONS.injuryCoveredLeagues);
    expect(line('injuries-league')).toMatchObject({ avgPerDay: 120, peakDay: 120 });
    const current = estimateCallBudget('api-football', CURRENT_LOAD_ASSUMPTIONS);
    const covered = LIVE_INGESTION_COMPETITIONS.filter((c) =>
      INJURIES_COVERED_LEAGUE_IDS.has(c.apiFootballLeagueId)
    ).length;
    expect(covered).toBe(CURRENT_LOAD_ASSUMPTIONS.injuryCoveredLeagues);
    expect(current.lines.find((l) => l.workload === 'injuries-league')?.avgPerDay).toBe(
      covered * 8
    );
  });

  it('spreads the weekly runs over the week and keeps them off the Saturday peak', () => {
    // 1,200 players / 20; 414 teams; 104 squads + 104 x 2 trophy batches.
    expect(line('player-sidelined').avgPerDay * 7).toBeCloseTo(60);
    expect(line('team-transfers').avgPerDay * 7).toBeCloseTo(414);
    expect(line('trophies').avgPerDay * 7).toBeCloseTo(312);
    for (const workload of ['player-sidelined', 'team-transfers', 'trophies']) {
      expect(line(workload).peakDay).toBe(0);
    }
  });

  it('sizes each default per-run limit to one scheduled run at the Mega catalogue', () => {
    const a = MEGA_LOAD_ASSUMPTIONS;
    const perRun = {
      'injuries-league': a.injuryCoveredLeagues,
      'player-sidelined': Math.ceil(a.sidelinedPlayers / 20),
      'team-transfers': a.domesticTeams,
      trophies: Math.round(line('trophies').avgPerDay * 7),
    } as const;
    for (const [dataset, calls] of Object.entries(perRun)) {
      const limit = DEFAULT_UNIT_MAX_CALLS_PER_RUN[dataset as keyof typeof perRun];
      expect(limit).toBeGreaterThanOrEqual(calls);
      expect(limit).toBeLessThanOrEqual(MAX_ENRICHMENT_CALLS_PER_RUN);
      // A full run fits in under ten minutes at the enrichment minute ceiling.
      expect(planEnrichmentRuns(calls, limit).minutesPerFullRun).toBeLessThanOrEqual(10);
    }
  });

  it('keeps the Mega peak day under the soft cap with the GW-6b lines included', () => {
    const estimate = mega();
    expect(estimate.totals.peakDay).toBeLessThan(MEGA_BUDGET_CAPS.softCap);
    expect(checkCallBudget(estimate, MEGA_BUDGET_CAPS).filter((w) => /exceed/i.test(w))).toEqual(
      []
    );
  });
});

describe('team-season-stats (GW-6c)', () => {
  const line = (a = MEGA_LOAD_ASSUMPTIONS) => {
    const found = estimateCallBudget('api-football', a).lines.filter(
      (l) => l.workload === 'team-season-stats'
    );
    // Exactly one line: the planned placeholder is gone.
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  it('is a built background line: every team on Monday, recent final whistles otherwise', () => {
    const tss = line();
    expect(tss).toMatchObject({ priority: 'background', planned: false, peakMinute: 0 });
    // 414 teams x 1.15 matches a week / 7 x 1.5 runs per match, about 102 a night.
    const nightly = ((414 * 1.15) / 7) * 1.5;
    expect(tss.peakDay).toBeCloseTo(nightly);
    expect(tss.avgPerDay).toBeCloseTo((414 + 6 * nightly) / 7);
    expect(Math.round(tss.avgPerDay)).toBe(147);
  });

  it('fits a Monday run of every domestic team in one default run of under five minutes', () => {
    const calls = MEGA_LOAD_ASSUMPTIONS.domesticTeams;
    const limit = DEFAULT_UNIT_MAX_CALLS_PER_RUN['team-season-stats'];
    expect(limit).toBeGreaterThanOrEqual(calls);
    expect(planEnrichmentRuns(calls, limit)).toEqual({
      runs: 1,
      minutesPerFullRun: 4,
      totalMinutes: 4,
    });
  });

  it('keeps the Mega peak day under the soft cap with the line included', () => {
    const estimate = estimateCallBudget('api-football', MEGA_LOAD_ASSUMPTIONS);
    expect(estimate.totals.peakDay).toBeLessThan(MEGA_BUDGET_CAPS.softCap);
    expect(estimate.warnings).toEqual([]);
  });
});

describe('team-coaches', () => {
  const line = (a = MEGA_LOAD_ASSUMPTIONS) => {
    const found = estimateCallBudget('api-football', a).lines.filter(
      (l) => l.workload === 'team-coaches'
    );
    // Exactly one line: the planned weekly placeholder is gone.
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  it('is a built background line: every domestic and national team every night', () => {
    expect(line()).toMatchObject({
      priority: 'background',
      planned: false,
      peakMinute: 0,
      avgPerDay: 414 + 210,
      peakDay: 414 + 210,
    });
  });

  it('fits every domestic and national team in one default run of under ten minutes', () => {
    const calls = MEGA_LOAD_ASSUMPTIONS.domesticTeams + MEGA_LOAD_ASSUMPTIONS.nationalTeams;
    const limit = DEFAULT_UNIT_MAX_CALLS_PER_RUN['team-coaches'];
    expect(limit).toBeGreaterThanOrEqual(calls);
    expect(planEnrichmentRuns(calls, limit).runs).toBe(1);
    expect(planEnrichmentRuns(calls, limit).minutesPerFullRun).toBeLessThan(10);
  });

  it('keeps the Mega peak day under the soft cap with the line included', () => {
    const estimate = estimateCallBudget('api-football', MEGA_LOAD_ASSUMPTIONS);
    expect(estimate.totals.peakDay).toBeLessThan(MEGA_BUDGET_CAPS.softCap);
    expect(estimate.warnings).toEqual([]);
  });
});
