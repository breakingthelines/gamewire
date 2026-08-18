/**
 * Unified competition catalogue.
 *
 * The single source of truth for which competitions gamewire covers and how.
 * This used to be two hand-maintained lists — `PHASE_A_COMPETITIONS` (drove
 * daily-anchor/hourly-matchday/squad-sweep/identity-gap-scan) and
 * `API_FOOTBALL_BETA_COMPETITIONS` (drove the always-on live loop) — that
 * silently drifted apart: 9 leagues ended up with steady-state coverage but
 * NO live ingestion, and Premier League carried two different `season`
 * values depending on which list you read. There is now exactly one array,
 * `COMPETITIONS`, and every entry declares both `liveIngestion` and
 * `steadyStateSweep` explicitly — adding or removing a league is a single
 * edit in one place, and the type system (all fields required except
 * `verifiedFixtureIds`) makes it impossible to add an entry that silently
 * omits a coverage decision.
 *
 * `LIVE_INGESTION_COMPETITIONS` and `STEADY_STATE_COMPETITIONS` are derived
 * filters kept for consumers that only care about one axis of coverage.
 */
import type { CompetitionEntry, MatchdayCalendar } from './types.js';

/**
 * Saturday + Sunday domestic matchday hours (12:00-22:00 UTC).
 * Covers Premier League, EFL pyramid, top-five European leagues, and
 * Eredivisie. Tuesday + Wednesday midweek slots (18:00-22:00 UTC) are
 * included because every league mentioned here uses Tue/Wed for cup
 * replays and midweek catch-ups.
 */
const WEEKEND_AND_MIDWEEK: MatchdayCalendar = [
  { utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }, // Saturday
  { utcWeekday: 0, utcHourStart: 12, utcHourEnd: 22 }, // Sunday
  { utcWeekday: 2, utcHourStart: 18, utcHourEnd: 22 }, // Tuesday
  { utcWeekday: 3, utcHourStart: 18, utcHourEnd: 22 }, // Wednesday
];

/**
 * Competitions whose kickoff schedule does not fit a weekly template, so
 * `calendar` is `null` (always in-window for the hourly-matchday sweep;
 * the daily-anchor sweep ignores `calendar` regardless):
 *   - The five World Cup qualifier confederations + the World Cup itself
 *     cluster fixtures inside FIFA windows, not a fixed weekday/hour
 *     template.
 *   - Brasileirão Série A kicks off on a Brazil-local schedule that falls
 *     outside the Euro-tuned `WEEKEND_AND_MIDWEEK` hours.
 * `null` is a deliberate, documented choice, not an oversight — see
 * `CompetitionEntry.calendar` in `types.ts`.
 */

/**
 * Unified competition catalogue. League ids match API-Football v3.
 * EFL Championship/L1/L2 + UEFA, CONMEBOL, AFC, CAF, CONCACAF qualifiers
 * were verified against the API-Football leagues directory; they may need
 * a refresh once API-Football rotates them for the 2026/27 season.
 *
 * Every entry has `liveIngestion: true` and `steadyStateSweep: true` — the
 * catalogue collapse deliberately closes the coverage gap the old
 * BETA/Phase-A split left open (9 leagues had steady-state sweep coverage
 * but no live ingestion). Cost of adding live ingestion for all 27 is
 * negligible: fixture discovery is `competitions * 2` calls/day, and live
 * polling itself is a single global feed, not a per-competition cost. See
 * `NO_LIVE_INGESTION_ALLOWLIST` below for how any future exception must be
 * declared.
 */
export const COMPETITIONS: readonly CompetitionEntry[] = [
  {
    key: 'premier-league',
    label: 'Premier League',
    country: 'England',
    apiFootballLeagueId: 39,
    // 2026/27 season. The steady-state standings poll keys off this literal, so it
    // must advance for gamewire to ingest the new season once api-football publishes
    // it. The domestic leagues and most cups below are now on 2026 too; the FA Cup
    // (45), Copa del Rey (143) and Coupe de France (66) stay on 2025 until api-football
    // publishes their 2026 fixtures, and the 5 World Cup qualifiers stay on 2025 (that
    // cycle is over). Bump those as each new season becomes the front door.
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-top-five',
    liveIngestion: true,
    steadyStateSweep: true,
    // Baseline verified fixture for the rotation. Used by adapter and
    // match-concluded-bridge tests, and seeded into the worker's
    // ingestion bootstrap so staging smoke covers a known-good
    // Premier League match end-to-end on boot.
    verifiedFixtureIds: ['1538961'],
  },
  {
    key: 'efl-championship',
    label: 'EFL Championship',
    country: 'England',
    apiFootballLeagueId: 40,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-league',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'efl-league-one',
    label: 'EFL League One',
    country: 'England',
    apiFootballLeagueId: 41,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-league',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'efl-league-two',
    label: 'EFL League Two',
    country: 'England',
    apiFootballLeagueId: 42,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-league',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'la-liga',
    label: 'La Liga',
    country: 'Spain',
    apiFootballLeagueId: 140,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-top-five',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'bundesliga',
    label: 'Bundesliga',
    country: 'Germany',
    apiFootballLeagueId: 78,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-top-five',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'serie-a',
    label: 'Serie A',
    country: 'Italy',
    apiFootballLeagueId: 135,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-top-five',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'ligue-1',
    label: 'Ligue 1',
    country: 'France',
    apiFootballLeagueId: 61,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-top-five',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'eredivisie',
    label: 'Eredivisie',
    country: 'Netherlands',
    apiFootballLeagueId: 88,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-league',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'brasileirao-serie-a',
    label: 'Brasileirão Série A',
    country: 'Brazil',
    apiFootballLeagueId: 71,
    season: 2026,
    // Brazilian kickoffs fall outside the Euro-tuned WEEKEND_AND_MIDWEEK
    // window, so this competition has no calendar gating (always in-window
    // for hourly-matchday; see CompetitionEntry.calendar).
    calendar: null,
    tier: 'domestic-league',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'jupiler-pro-league',
    label: 'Belgian Pro League',
    country: 'Belgium',
    apiFootballLeagueId: 144,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-league',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'primeira-liga',
    label: 'Primeira Liga',
    country: 'Portugal',
    apiFootballLeagueId: 94,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-league',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'uefa-qualifiers',
    label: 'UEFA World Cup Qualifiers',
    country: 'International',
    apiFootballLeagueId: 32,
    season: 2025,
    // International windows don't fit a weekly template; no calendar gating.
    calendar: null,
    tier: 'international',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'conmebol-qualifiers',
    label: 'CONMEBOL World Cup Qualifiers',
    country: 'International',
    apiFootballLeagueId: 34,
    season: 2025,
    calendar: null,
    tier: 'international',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'afc-qualifiers',
    label: 'AFC World Cup Qualifiers',
    country: 'International',
    apiFootballLeagueId: 29,
    season: 2025,
    calendar: null,
    tier: 'international',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'caf-qualifiers',
    label: 'CAF World Cup Qualifiers',
    country: 'International',
    apiFootballLeagueId: 31,
    season: 2025,
    calendar: null,
    tier: 'international',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'concacaf-qualifiers',
    label: 'CONCACAF World Cup Qualifiers',
    country: 'International',
    apiFootballLeagueId: 30,
    season: 2025,
    calendar: null,
    tier: 'international',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'fifa-world-cup-2026',
    label: 'FIFA World Cup 2026',
    country: 'World',
    apiFootballLeagueId: 1,
    season: 2026,
    calendar: null,
    tier: 'international',
    liveIngestion: true,
    steadyStateSweep: true,
  },

  // Domestic cups. Knockout cups have no league table, so the standings
  // sweep returns an empty table the competition page renders gracefully.
  // Cup ties cluster on weekend + midweek-replay slots, so they share the
  // domestic calendar.
  {
    key: 'fa-cup',
    label: 'FA Cup',
    country: 'England',
    apiFootballLeagueId: 45,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'efl-cup',
    label: 'EFL Cup',
    country: 'England',
    apiFootballLeagueId: 48,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'copa-del-rey',
    label: 'Copa del Rey',
    country: 'Spain',
    apiFootballLeagueId: 143,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'coppa-italia',
    label: 'Coppa Italia',
    country: 'Italy',
    apiFootballLeagueId: 137,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'dfb-pokal',
    label: 'DFB Pokal',
    country: 'Germany',
    apiFootballLeagueId: 81,
    season: 2026,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'coupe-de-france',
    label: 'Coupe de France',
    country: 'France',
    apiFootballLeagueId: 66,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic-cup',
    liveIngestion: true,
    steadyStateSweep: true,
  },

  // UEFA club competitions. Knockout-shaped like the domestic cups above,
  // but kickoffs (Tue/Wed/Thu ties across qualifying rounds and the league
  // phase) don't fit the Euro-tuned WEEKEND_AND_MIDWEEK domestic template,
  // so calendar is null — same always-in-window treatment as the
  // international entries above (see CompetitionEntry.calendar).
  {
    key: 'uefa-champions-league',
    label: 'UEFA Champions League',
    country: 'World',
    apiFootballLeagueId: 2,
    season: 2026,
    calendar: null,
    tier: 'european',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'uefa-europa-league',
    label: 'UEFA Europa League',
    country: 'World',
    apiFootballLeagueId: 3,
    season: 2026,
    calendar: null,
    tier: 'european',
    liveIngestion: true,
    steadyStateSweep: true,
  },
  {
    key: 'uefa-europa-conference-league',
    label: 'UEFA Europa Conference League',
    country: 'World',
    apiFootballLeagueId: 848,
    season: 2026,
    calendar: null,
    tier: 'european',
    liveIngestion: true,
    steadyStateSweep: true,
  },
];

/**
 * Trip-wire allow-list for the one bug this catalogue collapse exists to
 * prevent: a competition that has steady-state sweep coverage but silently
 * lacks live ingestion. It must stay EMPTY. If a future entry genuinely
 * needs `steadyStateSweep: true` with `liveIngestion: false`, that decision
 * has to be made explicit by adding its key here WITH A COMMENT explaining
 * why — never by just setting the field and letting it slide through
 * unnoticed. See `competitions.test.ts` for the regression test that
 * enforces this.
 */
export const NO_LIVE_INGESTION_ALLOWLIST: ReadonlySet<string> = new Set([]);

export const COMPETITIONS_BY_KEY: ReadonlyMap<string, CompetitionEntry> = new Map(
  COMPETITIONS.map((entry) => [entry.key, entry])
);

/** Competitions covered by the always-on live loop (pre-kickoff lineups, live events). */
export const LIVE_INGESTION_COMPETITIONS: readonly CompetitionEntry[] = COMPETITIONS.filter(
  (c) => c.liveIngestion
);

/** Competitions covered by the daily-anchor/hourly-matchday/squad-sweep/identity-gap-scan steady-state sweeps. */
export const STEADY_STATE_COMPETITIONS: readonly CompetitionEntry[] = COMPETITIONS.filter(
  (c) => c.steadyStateSweep
);

/**
 * True if `nowUtc` falls inside any window of `calendar`. Windows are
 * inclusive-start, exclusive-end on the UTC hour. A `null` calendar means
 * the competition has no weekly template and is always considered
 * in-window. Empty (non-null) calendars always return false.
 */
export const isMatchdayWindow = (nowUtc: Date, calendar: MatchdayCalendar | null): boolean => {
  if (calendar === null) {
    return true;
  }
  const weekday = nowUtc.getUTCDay();
  const hour = nowUtc.getUTCHours();
  return calendar.some(
    (window) =>
      window.utcWeekday === weekday && hour >= window.utcHourStart && hour < window.utcHourEnd
  );
};

/**
 * Returns the flattened, de-duplicated list of `verifiedFixtureIds`
 * declared across the competition catalogue (or any other competition list
 * supplied by the caller). Used by `worker/server.ts` to seed the
 * ingestion loop's `bootstrapFixtureIds` so staging smoke covers the
 * verified rotation without operator action.
 *
 * Empty entries are skipped, preserving the catalogue-as-source-of-
 * truth invariant: a competition without a verified id contributes
 * nothing and does not block the rotation.
 */
export const collectVerifiedFixtureIds = (
  competitions: readonly CompetitionEntry[] = COMPETITIONS
): readonly string[] => {
  const seen = new Set<string>();
  for (const competition of competitions) {
    for (const id of competition.verifiedFixtureIds ?? []) {
      const trimmed = id.trim();
      if (trimmed !== '') {
        seen.add(trimmed);
      }
    }
  }
  return [...seen];
};
