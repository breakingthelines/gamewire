/**
 * Provider call budget model for API-Football.
 *
 * Models the mechanism the worker actually runs: one `/fixtures?id=` call per
 * live fixture per live refresh, a team + player stats sidecar on its own TTL,
 * a fixed pre/post-match tail per fixture, hourly discovery per competition,
 * and the kernel-driven sweeps. The live and stats rates are derived from
 * {@link INGESTION_TICK_INTERVAL_MS} and {@link INGESTION_TTL_SECONDS}, so a
 * tick or TTL change shows up here without editing the model.
 *
 * Outputs are calls per average day, per peak day (the busiest Saturday) and
 * per peak minute, per line and in total, plus checks against a set of caps.
 *
 * Planned lines (`planned: true`) are the Mega enrichment datasets that are
 * not built yet (GW-6 to GW-8). They are included by default so the caps are
 * checked against the target load, not today's.
 *
 * `provider-fixture-results` (PF-GW1) is modelled as its steady-state
 * `nightly` mode only (a 3-day `from`/`to` window for reference-set leagues
 * outside the catalogue, ~11/day) as an unconditional (`planned: false`)
 * line, not a planned one: it is built now, off by default behind
 * `GAMEWIRE_PROVIDER_FIXTURE_RESULTS`, so `includePlanned: false` must
 * still show this load once the flag is on. Its one-time `history` backfill
 * (~92 calls, the 20-league reference set plus UEFA 2/3/848 across
 * 2023-2026) is a single run outside steady state, the same category as
 * the Mega season-fill history backfill (`mega-spec.md` §1.3) — not part
 * of this per-day model.
 */

import { LIVE_INGESTION_COMPETITIONS } from '../workflows/competitions.js';
import { INGESTION_TICK_INTERVAL_MS, INGESTION_TTL_SECONDS } from './ingestion.js';
import { DEFAULT_PROVIDER_MINUTE_CAPS, type ProviderPriority } from './minute-limiter.js';

export interface CallBudgetAssumptions {
  /** Competitions in the live catalogue. */
  readonly competitions: number;
  /** Fixtures on an average calendar day. */
  readonly avgFixturesPerDay: number;
  /** Fixtures on the busiest day (a full Saturday). */
  readonly peakDayFixtures: number;
  /** Most fixtures live at the same time. */
  readonly peakConcurrentLive: number;
  /** Live fixtures overlapping the overnight background window (00:15-06:00 UTC). */
  readonly overnightConcurrentLive: number;
  /** Minutes a fixture spends in the live phase (kickoff to final, with stoppage). */
  readonly liveMinutesPerFixture: number;
  readonly liveTickSeconds: number;
  readonly liveTtlSeconds: number;
  readonly statsTtlSeconds: number;
  /** preKO, lineups, fullTime and events calls per fixture. */
  readonly prePostCallsPerFixture: number;
  /** Peak per-minute rate of the pre/post tail across all fixtures. */
  readonly prePostPeakMinute: number;
  /** Share of fixtures in leagues with injuries coverage (15 of 40). */
  readonly injuryCoveredShare: number;
  /** Include the planned enrichment datasets. */
  readonly includePlanned: boolean;
}

export interface CallBudgetLine {
  readonly workload: string;
  readonly priority: ProviderPriority;
  readonly strategy: string;
  readonly avgPerDay: number;
  readonly peakDay: number;
  /** Calls per minute this line adds at the busiest minute. 0 for background lines. */
  readonly peakMinute: number;
  readonly planned: boolean;
}

export interface CallBudgetTotals {
  readonly avgPerDay: number;
  readonly peakDay: number;
  /** Live plus near-live demand at the busiest minute. */
  readonly peakMinute: number;
  readonly peakMinuteByPriority: Readonly<Record<ProviderPriority, number>>;
  /**
   * The overnight worst case: a background sweep running at the background
   * minute ceiling while the overnight live fixtures (MLS, Liga MX) play.
   */
  readonly overnightWorstMinute: number;
}

export interface CallBudgetEstimate {
  readonly provider: string;
  readonly assumptions: CallBudgetAssumptions;
  readonly lines: readonly CallBudgetLine[];
  readonly totals: CallBudgetTotals;
  readonly warnings: readonly string[];
}

export interface CallBudgetCaps {
  readonly softCap: number;
  readonly hardCap: number;
  readonly planDailyCeiling: number;
  readonly backgroundDailyCap: number;
  readonly minuteCaps: Readonly<Record<ProviderPriority, number>>;
  readonly planMinuteCeiling: number;
}

/** The Mega plan caps: the code defaults, and the values INF-1 sets in prod env. */
export const MEGA_BUDGET_CAPS: CallBudgetCaps = {
  softCap: 130_000,
  hardCap: 140_000,
  planDailyCeiling: 150_000,
  backgroundDailyCap: 110_000,
  minuteCaps: DEFAULT_PROVIDER_MINUTE_CAPS,
  planMinuteCeiling: 900,
};

/**
 * Today's catalogue and load, measured from prod over 120 days (spec fact 1):
 * 17.7 fixtures a day, busiest day 75, peak concurrency 41.
 */
export const CURRENT_LOAD_ASSUMPTIONS: CallBudgetAssumptions = {
  competitions: LIVE_INGESTION_COMPETITIONS.length,
  avgFixturesPerDay: 17.7,
  peakDayFixtures: 75,
  peakConcurrentLive: 41,
  overnightConcurrentLive: 4,
  liveMinutesPerFixture: 115,
  liveTickSeconds: INGESTION_TICK_INTERVAL_MS['fixture-detail-live'] / 1_000,
  liveTtlSeconds: INGESTION_TTL_SECONDS['fixture-detail-live'],
  statsTtlSeconds: INGESTION_TTL_SECONDS['team-match-stats'],
  prePostCallsPerFixture: 20,
  prePostPeakMinute: 30,
  injuryCoveredShare: 13 / 27,
  includePlanned: true,
};

/**
 * After the 13 new competitions (spec §1.1, inferred): 31 fixtures a day,
 * busiest day 115, peak concurrency 63, about 12 overnight (MLS, Liga MX).
 */
export const MEGA_LOAD_ASSUMPTIONS: CallBudgetAssumptions = {
  ...CURRENT_LOAD_ASSUMPTIONS,
  competitions: 40,
  avgFixturesPerDay: 31,
  peakDayFixtures: 115,
  peakConcurrentLive: 63,
  overnightConcurrentLive: 12,
  injuryCoveredShare: 15 / 40,
};

/**
 * Seconds between provider refreshes for a workload polled every `tickSeconds`
 * with a cache TTL of `ttlSeconds`. A tick that finds a live cache entry costs
 * nothing, so the refresh happens on the first tick at or after expiry. When
 * the TTL equals the tick the expiry races the tick; this counts it as a
 * refresh every tick, the more expensive reading.
 */
export function refreshIntervalSeconds(tickSeconds: number, ttlSeconds: number): number {
  if (tickSeconds <= 0) {
    throw new Error('tickSeconds must be positive');
  }
  if (ttlSeconds <= tickSeconds) {
    return tickSeconds;
  }
  return tickSeconds * Math.ceil(ttlSeconds / tickSeconds);
}

export function estimateCallBudget(
  provider: string,
  overrides: Partial<CallBudgetAssumptions> = {},
  caps: CallBudgetCaps = MEGA_BUDGET_CAPS
): CallBudgetEstimate {
  const a: CallBudgetAssumptions = { ...MEGA_LOAD_ASSUMPTIONS, ...overrides };
  const liveRefresh = refreshIntervalSeconds(a.liveTickSeconds, a.liveTtlSeconds);
  const statsRefresh = refreshIntervalSeconds(a.liveTickSeconds, a.statsTtlSeconds);
  const liveSeconds = a.liveMinutesPerFixture * 60;
  const livePerFixture = liveSeconds / liveRefresh;
  const statsPerFixture = (2 * liveSeconds) / statsRefresh;
  const perFixture = (calls: number) => ({
    avgPerDay: a.avgFixturesPerDay * calls,
    peakDay: a.peakDayFixtures * calls,
  });

  const lines: CallBudgetLine[] = [
    {
      workload: 'fixture-detail-live',
      priority: 'live',
      strategy: `/fixtures?id= per live fixture, refresh every ${liveRefresh}s (tick ${a.liveTickSeconds}s, TTL ${a.liveTtlSeconds}s)`,
      ...perFixture(livePerFixture),
      peakMinute: (a.peakConcurrentLive * 60) / liveRefresh,
      planned: false,
    },
    {
      workload: 'team-match-stats + player-match-stats',
      priority: 'live',
      strategy: `sidecar off the live tick, 2 calls every ${statsRefresh}s (TTL ${a.statsTtlSeconds}s)`,
      ...perFixture(statsPerFixture),
      peakMinute: (a.peakConcurrentLive * 2 * 60) / statsRefresh,
      planned: false,
    },
    {
      workload: 'preKO / lineups / fullTime / events',
      priority: 'near-live',
      strategy: `${a.prePostCallsPerFixture} calls per fixture around kickoff and full time`,
      ...perFixture(a.prePostCallsPerFixture),
      peakMinute: a.prePostPeakMinute,
      planned: false,
    },
    discoveryLine(a),
    {
      workload: 'hourly-matchday',
      priority: 'background',
      strategy: 'kernel cron, 2 paths per competition, 6h TTL caps it at 4 refreshes a day',
      avgPerDay: (a.competitions * 8 * 4) / 7,
      peakDay: a.competitions * 8,
      peakMinute: 0,
      planned: false,
    },
    {
      workload: 'daily-anchor',
      priority: 'background',
      strategy: '02:00 UTC sweep: fixtures, standings, current season, team metadata',
      avgPerDay: a.competitions * 7.5,
      peakDay: a.competitions * 7.5,
      peakMinute: 0,
      planned: false,
    },
    {
      workload: 'kernel weekly sweeps',
      priority: 'background',
      strategy: 'squad, season-fill, lineups, events on Mondays, amortised to 1,000 a day',
      avgPerDay: 1_000,
      peakDay: 0,
      peakMinute: 0,
      planned: false,
    },
    {
      // PF-GW1 is built now (gated by GAMEWIRE_PROVIDER_FIXTURE_RESULTS,
      // off by default), not an unbuilt Mega dataset, so it belongs here
      // rather than in `plannedLines()` — `includePlanned:false` must not
      // hide real load once the flag flips on (finding #9).
      workload: 'provider-fixture-results',
      priority: 'background',
      strategy:
        'PF-GW1 nightly league=L&season=S&from/to for reference-set leagues outside the catalogue',
      avgPerDay: 11,
      peakDay: 11,
      peakMinute: 0,
      planned: false,
    },
  ];

  if (a.includePlanned) {
    lines.push(...plannedLines(a));
  }

  const sum = (pick: (line: CallBudgetLine) => number, filter?: (l: CallBudgetLine) => boolean) =>
    Math.round(lines.filter(filter ?? (() => true)).reduce((total, line) => total + pick(line), 0));
  const minuteFor = (priority: ProviderPriority) =>
    sum(
      (line) => line.peakMinute,
      (line) => line.priority === priority
    );
  const peakMinuteByPriority = {
    live: minuteFor('live'),
    'near-live': minuteFor('near-live'),
    background: caps.minuteCaps.background,
  };
  const overnightLive =
    (a.overnightConcurrentLive * 60) / liveRefresh +
    (a.overnightConcurrentLive * 2 * 60) / statsRefresh;
  const overnightNearLive =
    a.peakConcurrentLive > 0
      ? (a.prePostPeakMinute * a.overnightConcurrentLive) / a.peakConcurrentLive
      : 0;

  const totals: CallBudgetTotals = {
    avgPerDay: sum((line) => line.avgPerDay),
    peakDay: sum((line) => line.peakDay),
    peakMinute: peakMinuteByPriority.live + peakMinuteByPriority['near-live'],
    peakMinuteByPriority,
    overnightWorstMinute: Math.round(
      caps.minuteCaps.background + overnightLive + overnightNearLive
    ),
  };

  return {
    provider,
    assumptions: a,
    lines,
    totals,
    warnings: checkCallBudget({ provider, assumptions: a, lines, totals, warnings: [] }, caps),
  };
}

/**
 * Compare an estimate with caps. Returns one message per breach; an empty list
 * means the load fits.
 */
export function checkCallBudget(estimate: CallBudgetEstimate, caps: CallBudgetCaps): string[] {
  const { totals, lines } = estimate;
  const out: string[] = [];
  if (totals.peakDay > caps.softCap) {
    out.push(
      `Peak day ${totals.peakDay} exceeds the soft cap ${caps.softCap}: workflows go cached-only on the busiest day.`
    );
  }
  if (totals.peakDay > caps.planDailyCeiling) {
    out.push(
      `Peak day ${totals.peakDay} exceeds the plan ceiling ${caps.planDailyCeiling}: the account stops for the rest of the day.`
    );
  }
  const backgroundPeak = Math.round(
    lines.filter((line) => line.priority === 'background').reduce((t, l) => t + l.peakDay, 0)
  );
  if (backgroundPeak > caps.backgroundDailyCap) {
    out.push(
      `Background peak day ${backgroundPeak} exceeds the background daily cap ${caps.backgroundDailyCap}.`
    );
  }
  if (totals.peakMinute > caps.minuteCaps.live) {
    out.push(
      `Peak minute ${totals.peakMinute} (live + near-live) exceeds the live minute ceiling ${caps.minuteCaps.live}: live calls are throttled at the busiest minute.`
    );
  }
  if (totals.overnightWorstMinute > caps.minuteCaps.live) {
    out.push(
      `Overnight worst minute ${totals.overnightWorstMinute} (background at its ceiling plus overnight live) exceeds the live minute ceiling ${caps.minuteCaps.live}.`
    );
  }
  if (caps.minuteCaps.live > caps.planMinuteCeiling) {
    out.push(
      `Live minute ceiling ${caps.minuteCaps.live} is above the plan's ${caps.planMinuteCeiling}/min.`
    );
  }
  return out;
}

function discoveryLine(a: CallBudgetAssumptions): CallBudgetLine {
  const tickHours = INGESTION_TICK_INTERVAL_MS['fixtures-next-7d'] / 3_600_000;
  const ttlHours = INGESTION_TTL_SECONDS['fixtures-next-7d'] / 3_600;
  const perDay = 24 / refreshIntervalSeconds(tickHours, ttlHours);
  return {
    workload: 'fixtures-next-7d discovery',
    priority: 'near-live',
    strategy: `hourly tick per competition, ${ttlHours}h TTL: ${perDay} refreshes a day, all competitions in the same minute`,
    avgPerDay: a.competitions * perDay,
    peakDay: a.competitions * perDay,
    peakMinute: a.competitions,
    planned: false,
  };
}

/**
 * Mega enrichment (spec §1.2, with verdict D16 and D17 applied: predictions
 * as two shots per fixture, fixture injuries at 2.5 calls per covered
 * fixture).
 */
function plannedLines(a: CallBudgetAssumptions): CallBudgetLine[] {
  const fixtureLine = (
    workload: string,
    callsPerFixture: number,
    peakMinute: number,
    strategy: string
  ): CallBudgetLine => ({
    workload,
    priority: 'near-live',
    strategy,
    avgPerDay: a.avgFixturesPerDay * callsPerFixture,
    peakDay: a.peakDayFixtures * callsPerFixture,
    peakMinute,
    planned: true,
  });
  const background = (
    workload: string,
    avgPerDay: number,
    peakDay: number,
    strategy: string
  ): CallBudgetLine => ({
    workload,
    priority: 'background',
    strategy,
    avgPerDay,
    peakDay,
    peakMinute: 0,
    planned: true,
  });
  return [
    fixtureLine(
      'injuries-fixture',
      2.5 * a.injuryCoveredShare,
      15,
      'pre-kickoff, covered leagues only, 2-3 calls per fixture'
    ),
    fixtureLine('fixture-predictions', 2, 10, 'two shots: T-48h and T-3h'),
    fixtureLine('head-to-head', 1, 10, 'T-48h, pair cached 7d'),
    background('league-coverage', 1, 1, 'daily, one call'),
    background('injuries-league', 120, 120, 'every 3h for 15 covered leagues'),
    background('player-sidelined', 86, 0, 'weekly'),
    background('competition-leaders', 70, 40, 'daily for leagues played in 36h; full on Monday'),
    background('player-season-stats', 610, 200, 'daily for leagues played; full on Monday'),
    background('team-season-stats', 150, 60, 'teams with a final whistle in 36h; full on Monday'),
    background('team-coaches', 90, 0, 'weekly'),
    background('team-transfers', 60, 0, 'weekly'),
    background('trophies', 393, 0, 'weekly, a quarter partition per run'),
    background('venue-detail', 10, 10, 'new venues plus a 90-day refresh'),
  ];
}
