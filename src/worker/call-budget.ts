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
 * not built yet (the rest of GW-6, GW-7, GW-8). They are included by default
 * so the caps are checked against the target load, not today's.
 * `player-season-stats` is built (GW-6a) and modelled from its own mechanism:
 * a nightly refresh of the current season for the domestic leagues, plus an
 * optional history backfill run on the same night
 * ({@link CallBudgetAssumptions.enrichmentBackfillCallsPerDay}). The GW-6b
 * datasets (`injuries-league`, `player-sidelined`, `team-transfers`,
 * `trophies`) are built and modelled from their units: one call per covered
 * league-season, per 20 players, per team, and per squad plus per 20 squad
 * players. `team-season-stats` (GW-6c) is built and modelled as one call per
 * team: every domestic team on Monday, and on other nights the teams with a
 * final whistle in the last 36 hours. `team-coaches` is built and modelled
 * as one `/coachs?team=` call per domestic team a day.
 *
 * `provider-fixture-results` (PF-GW1) is modelled as its steady-state
 * `nightly` mode only (a 3-day `from`/`to` window for reference-set leagues
 * outside the catalogue, ~11/day) as an unconditional (`planned: false`)
 * line, not a planned one: it is built and on by default
 * (`GAMEWIRE_PROVIDER_FIXTURE_RESULTS` is only an off-switch), so
 * `includePlanned: false` must still show this load. Its one-time `history` backfill
 * (~92 calls, the 20-league reference set plus UEFA 2/3/848 across
 * 2023-2026) is a single run outside steady state, the same category as
 * the Mega season-fill history backfill (`mega-spec.md` §1.3) — not part
 * of this per-day model.
 */

import { LIVE_INGESTION_COMPETITIONS } from '../workflows/competitions.js';
import { INGESTION_TICK_INTERVAL_MS, INGESTION_TTL_SECONDS } from './ingestion.js';
import {
  DEFAULT_ENRICHMENT_MINUTE_CAP,
  DEFAULT_PROVIDER_MINUTE_CAPS,
  type ProviderPriority,
} from './minute-limiter.js';

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
  /** Domestic leagues the nightly player-season-stats refresh covers. */
  readonly domesticLeagues: number;
  /** `/players` pages per domestic league-season (20 players a page). */
  readonly playerSeasonPagesPerLeague: number;
  /**
   * Calls a `full` provider-enrichment history run spends on the same day, on
   * top of the nightly refresh. 0 in steady state; at most the per-run limit
   * when the backfill runs.
   */
  readonly enrichmentBackfillCallsPerDay: number;
  /** Catalogue leagues with `coverage.injuries` (the injuries-league scope). */
  readonly injuryCoveredLeagues: number;
  /** injuries-league runs a day (the K-2 schedule: every 3h). */
  readonly injuryPullsPerDay: number;
  /**
   * Players listed by injuries-league in the last 30 days (the weekly
   * sidelined scope). An estimate: Eredivisie 2026 listed 921 player-fixture
   * rows over three months, about 80 players in a 30-day window.
   */
  readonly sidelinedPlayers: number;
  /** Teams in the catalogue's domestic leagues (the transfers and trophies scope). */
  readonly domesticTeams: number;
  /** Players per current squad (`/players/squads`), for the trophies batches. */
  readonly squadPlayersPerTeam: number;
  /**
   * Domestic league matches a team plays in an average week (one round a
   * week, plus the midweek rounds of the 24-team and congested leagues).
   */
  readonly domesticMatchesPerTeamPerWeek: number;
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
  // Twelve catalogue domestic leagues. A finished season is 34 to 57 pages
  // (Premier League 2023 51, 2024 57; Eredivisie 2023 49), so 50 is a
  // full-season figure; early in a season it is lower.
  domesticLeagues: 12,
  playerSeasonPagesPerLeague: 50,
  enrichmentBackfillCallsPerDay: 0,
  // 1, 2, 3, 31, 32, 39, 40, 61, 71, 78, 88, 135, 140 (INJURIES_COVERED_LEAGUE_IDS
  // in the catalogue).
  injuryCoveredLeagues: 13,
  injuryPullsPerDay: 8,
  sidelinedPlayers: 1_000,
  // PL 20, Championship, L1, L2 24 each, La Liga 20, Bundesliga 18, Serie A 20,
  // Ligue 1 18, Eredivisie 18, Brasileirao 20, Jupiler 16, Primeira 18.
  domesticTeams: 240,
  squadPlayersPerTeam: 30,
  domesticMatchesPerTeamPerWeek: 1.15,
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
  // Plus the nine new domestic leagues from GW-5.
  domesticLeagues: 21,
  // Plus Super Lig 203 and MLS 253.
  injuryCoveredLeagues: 15,
  sidelinedPlayers: 1_200,
  // Plus MLS 30, Scottish Premiership 12, Saudi 18, Ligue 2 18, Serie B 20,
  // 2. Bundesliga 18, Segunda 22, Super Lig 18, Liga MX 18.
  domesticTeams: 414,
};

/**
 * The player-season-stats history backfill (profile-spec PF-GW2): seasons 2023
 * to 2025 for the catalogue domestic leagues, about 3,500 calls.
 */
export const PLAYER_SEASON_STATS_HISTORY_CALLS = 3_500;

export interface EnrichmentRunPlan {
  /** Runs needed at the given per-run limit. */
  readonly runs: number;
  /** Least wall time per full run at the per-minute ceiling. */
  readonly minutesPerFullRun: number;
  /** Least wall time for the whole job. */
  readonly totalMinutes: number;
}

/** How a bounded, rate-capped enrichment job spreads over runs. */
export function planEnrichmentRuns(
  totalCalls: number,
  perRunLimit: number,
  minuteCap: number = DEFAULT_ENRICHMENT_MINUTE_CAP
): EnrichmentRunPlan {
  if (perRunLimit <= 0 || minuteCap <= 0) {
    throw new Error('perRunLimit and minuteCap must be positive');
  }
  return {
    runs: Math.ceil(totalCalls / perRunLimit),
    minutesPerFullRun: Math.ceil(Math.min(totalCalls, perRunLimit) / minuteCap),
    totalMinutes: Math.ceil(totalCalls / minuteCap),
  };
}

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
    playerSeasonStatsLine(a),
    ...availabilityTransfersTrophiesLines(a),
    teamSeasonStatsLine(a),
    teamCoachesLine(a),
    ...preMatchLines(a),
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
      // PF-GW1 is built and on by default (GAMEWIRE_PROVIDER_FIXTURE_RESULTS
      // is only an off-switch), not an unbuilt Mega dataset, so it belongs
      // here rather than in `plannedLines()`: `includePlanned:false` must
      // not hide real load.
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

/**
 * GW-6a: the nightly current-season refresh fetches every `/players` page of
 * every domestic league, every night (the cursor window is 20h, so each night
 * starts again from page 1). A history run adds its per-run limit on the
 * nights it runs. Background class, so it never adds to the live peak minute;
 * its own ceiling is {@link DEFAULT_ENRICHMENT_MINUTE_CAP}.
 */
function playerSeasonStatsLine(a: CallBudgetAssumptions): CallBudgetLine {
  const nightly = a.domesticLeagues * a.playerSeasonPagesPerLeague;
  return {
    workload: 'player-season-stats',
    priority: 'background',
    strategy:
      `nightly refresh, ${a.domesticLeagues} domestic leagues x ${a.playerSeasonPagesPerLeague} pages, ` +
      `at most ${DEFAULT_ENRICHMENT_MINUTE_CAP}/min` +
      (a.enrichmentBackfillCallsPerDay > 0
        ? `, plus a ${a.enrichmentBackfillCallsPerDay}-call history run`
        : ''),
    avgPerDay: nightly + a.enrichmentBackfillCallsPerDay,
    peakDay: nightly + a.enrichmentBackfillCallsPerDay,
    peakMinute: 0,
    planned: false,
  };
}

/** Provider calls a batch of ids costs at the 20-ids-a-call limit. */
const PROVIDER_IDS_PER_CALL = 20;

/**
 * GW-6b. Background class, so no peak-minute load; each run is held to the
 * enrichment minute ceiling. The weekly datasets run Tuesday to Thursday
 * (K-2), not on the Saturday peak, so their peak-day figure is 0 and their
 * average is the weekly run spread over seven days.
 */
export function availabilityTransfersTrophiesLines(a: CallBudgetAssumptions): CallBudgetLine[] {
  const weekly = (workload: string, perRun: number, strategy: string): CallBudgetLine => ({
    workload,
    priority: 'background',
    strategy: `${strategy}; ${perRun} calls a week`,
    avgPerDay: perRun / 7,
    peakDay: 0,
    peakMinute: 0,
    planned: false,
  });
  const injuries = a.injuryCoveredLeagues * a.injuryPullsPerDay;
  const trophyTeams = Math.ceil(a.domesticTeams / 4);
  const trophiesRun =
    trophyTeams + trophyTeams * Math.ceil(a.squadPlayersPerTeam / PROVIDER_IDS_PER_CALL);
  return [
    {
      workload: 'injuries-league',
      priority: 'background',
      strategy: `${a.injuryCoveredLeagues} covered league-seasons x ${a.injuryPullsPerDay} pulls a day, one call each`,
      avgPerDay: injuries,
      peakDay: injuries,
      peakMinute: 0,
      planned: false,
    },
    weekly(
      'player-sidelined',
      Math.ceil(a.sidelinedPlayers / PROVIDER_IDS_PER_CALL),
      `weekly, ${a.sidelinedPlayers} players listed in 30 days, 20 a call`
    ),
    weekly(
      'team-transfers',
      a.domesticTeams,
      `weekly, ${a.domesticTeams} domestic teams, one call each`
    ),
    weekly(
      'trophies',
      trophiesRun,
      `weekly quarter partition: ${trophyTeams} squads plus their players 20 a call`
    ),
  ];
}

/**
 * Nightly runs that see one final whistle: the scope window is 36 hours and
 * the team's marker lasts 20, so a match is fetched by one or two runs, 1.5
 * on average.
 */
const TEAM_SEASON_STATS_RUNS_PER_MATCH = 36 / 24;

/**
 * GW-6c `team-season-stats`: one `/teams/statistics` call per team. Monday's
 * run covers every domestic team; the other six nights cover the teams with a
 * final whistle in the last 36 hours. The Saturday peak day is one such
 * nightly run (Monday, the largest day, is not the Saturday peak).
 */
export function teamSeasonStatsLine(a: CallBudgetAssumptions): CallBudgetLine {
  const nightly =
    ((a.domesticTeams * a.domesticMatchesPerTeamPerWeek) / 7) * TEAM_SEASON_STATS_RUNS_PER_MATCH;
  return {
    workload: 'team-season-stats',
    priority: 'background',
    strategy:
      `${a.domesticTeams} domestic teams on Monday, about ${Math.round(nightly)} teams ` +
      'with a final whistle in 36h on other nights, one call each',
    avgPerDay: (a.domesticTeams + 6 * nightly) / 7,
    peakDay: nightly,
    peakMinute: 0,
    planned: false,
  };
}

/**
 * `team-coaches`: one `/coachs?team=` call per domestic team every night, so a
 * manager change reaches game-service within a day of the provider recording
 * it. It runs at 04:20 UTC, so the Saturday peak day carries one full run.
 */
export function teamCoachesLine(a: CallBudgetAssumptions): CallBudgetLine {
  return {
    workload: 'team-coaches',
    priority: 'background',
    strategy: `nightly, ${a.domesticTeams} domestic teams, one call each`,
    avgPerDay: a.domesticTeams,
    peakDay: a.domesticTeams,
    peakMinute: 0,
    planned: false,
  };
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
    background('league-coverage', 1, 1, 'daily, one call'),
    background('competition-leaders', 70, 40, 'daily for leagues played in 36h; full on Monday'),
  ];
}

/**
 * Catalogue venues the venue-detail scope holds (the fixture lists of every
 * enriched competition): 294 distinct venue ids on prod games in the 120 days
 * to 2026-11-13, rounded up.
 */
const CATALOGUE_VENUES = 300;
/** New venue ids a day: promoted clubs, neutral grounds, cup ties at small clubs. */
const NEW_VENUES_PER_DAY = 2;

/**
 * GW-7 and GW-8, run after each discovery sweep (background priority, under
 * the enrichment minute limiter):
 * - `fixture-predictions`: two shots per fixture (the first sweep inside 48h,
 *   the first inside 3h), verdict D17;
 * - `head-to-head`: no call when predictions is on, because `/predictions`
 *   carries the same last-10 meetings and the predictions run stores them; a
 *   standalone pull is one call per pair a week, at most one per fixture;
 * - `venue-detail`: each venue once, then every 90 days, plus new venues. The
 *   first runs after switch-on take the catalogue's venues 150 an hour;
 * - coach trophies (`coach-trophies`, inside the weekly trophies run): one
 *   `/trophies?coachs=` call per team in the week's quarter.
 */
export function preMatchLines(a: CallBudgetAssumptions): CallBudgetLine[] {
  const coachTrophyTeams = Math.ceil(a.domesticTeams / 4);
  return [
    {
      workload: 'fixture-predictions',
      priority: 'background',
      strategy: 'after each discovery sweep: two shots per fixture, inside 48h and inside 3h',
      avgPerDay: a.avgFixturesPerDay * 2,
      peakDay: a.peakDayFixtures * 2,
      peakMinute: 0,
      planned: false,
    },
    {
      workload: 'head-to-head',
      priority: 'background',
      strategy:
        'stored from the predictions response; a standalone pull (predictions off) is one call per pair a week',
      avgPerDay: 0,
      peakDay: 0,
      peakMinute: 0,
      planned: false,
    },
    {
      workload: 'venue-detail',
      priority: 'background',
      strategy: `${CATALOGUE_VENUES} catalogue venues every 90 days plus about ${NEW_VENUES_PER_DAY} new a day`,
      avgPerDay: CATALOGUE_VENUES / 90 + NEW_VENUES_PER_DAY,
      peakDay: CATALOGUE_VENUES / 90 + NEW_VENUES_PER_DAY,
      peakMinute: 0,
      planned: false,
    },
    {
      workload: 'coach-trophies',
      priority: 'background',
      strategy: `weekly quarter partition: ${coachTrophyTeams} teams, one call for each team's coaches`,
      avgPerDay: coachTrophyTeams / 7,
      peakDay: 0,
      peakMinute: 0,
      planned: false,
    },
  ];
}
