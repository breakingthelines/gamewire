/**
 * Phase A competition catalogue.
 *
 * Each entry pairs an API-Football league id + current-season id with
 * a matchday calendar of UTC hour windows. The calendar is used by
 * `hourly-matchday.ts` to decide whether a competition is in-window
 * for a given tick; the daily-anchor sweep ignores the calendar and
 * touches every entry.
 *
 * League ids are sourced from `API_FOOTBALL_BETA_COMPETITIONS` in
 * `src/adapters/api-football/types.ts` where they overlap; EFL tiers,
 * Eredivisie, and the qualifier confederations are added here. WC26
 * ships as a stub today and will be replaced by a dynamic competition
 * during the tournament.
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
 * International qualifier hours. Confederations cluster fixtures on
 * Tue/Wed/Thu/Fri evenings in their respective FIFA windows; this
 * catch-all keeps the worker hot through those weeks without a
 * separate per-confederation calendar. WC26 cron will be overridden
 * dynamically during the tournament.
 */
const INTERNATIONAL_WINDOWS: MatchdayCalendar = [
  { utcWeekday: 2, utcHourStart: 18, utcHourEnd: 23 }, // Tuesday
  { utcWeekday: 3, utcHourStart: 18, utcHourEnd: 23 }, // Wednesday
  { utcWeekday: 4, utcHourStart: 18, utcHourEnd: 23 }, // Thursday
  { utcWeekday: 5, utcHourStart: 18, utcHourEnd: 23 }, // Friday
];

/**
 * Phase A competition catalogue. League ids match API-Football v3.
 * EFL Championship/L1/L2 + UEFA, CONMEBOL, AFC, CAF, CONCACAF
 * qualifiers were verified against the API-Football leagues
 * directory; they may need a refresh once API-Football rotates them
 * for the 2026/27 season.
 */
export const PHASE_A_COMPETITIONS: readonly CompetitionEntry[] = [
  {
    key: 'premier-league',
    label: 'Premier League',
    apiFootballLeagueId: 39,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
    // Baseline verified fixture for the rotation. Used by adapter and
    // match-concluded-bridge tests, and seeded into the worker's
    // ingestion bootstrap so staging smoke covers a known-good
    // Premier League match end-to-end on boot.
    verifiedFixtureIds: ['1538961'],
  },
  {
    key: 'efl-championship',
    label: 'EFL Championship',
    apiFootballLeagueId: 40,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'efl-league-one',
    label: 'EFL League One',
    apiFootballLeagueId: 41,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'efl-league-two',
    label: 'EFL League Two',
    apiFootballLeagueId: 42,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'la-liga',
    label: 'La Liga',
    apiFootballLeagueId: 140,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'bundesliga',
    label: 'Bundesliga',
    apiFootballLeagueId: 78,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'serie-a',
    label: 'Serie A',
    apiFootballLeagueId: 135,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'ligue-1',
    label: 'Ligue 1',
    apiFootballLeagueId: 61,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'eredivisie',
    label: 'Eredivisie',
    apiFootballLeagueId: 88,
    season: 2025,
    calendar: WEEKEND_AND_MIDWEEK,
    tier: 'domestic',
  },
  {
    key: 'uefa-qualifiers',
    label: 'UEFA World Cup Qualifiers',
    apiFootballLeagueId: 32,
    season: 2025,
    calendar: INTERNATIONAL_WINDOWS,
    tier: 'international',
  },
  {
    key: 'conmebol-qualifiers',
    label: 'CONMEBOL World Cup Qualifiers',
    apiFootballLeagueId: 34,
    season: 2025,
    calendar: INTERNATIONAL_WINDOWS,
    tier: 'international',
  },
  {
    key: 'afc-qualifiers',
    label: 'AFC World Cup Qualifiers',
    apiFootballLeagueId: 29,
    season: 2025,
    calendar: INTERNATIONAL_WINDOWS,
    tier: 'international',
  },
  {
    key: 'caf-qualifiers',
    label: 'CAF World Cup Qualifiers',
    apiFootballLeagueId: 31,
    season: 2025,
    calendar: INTERNATIONAL_WINDOWS,
    tier: 'international',
  },
  {
    key: 'concacaf-qualifiers',
    label: 'CONCACAF World Cup Qualifiers',
    apiFootballLeagueId: 30,
    season: 2025,
    calendar: INTERNATIONAL_WINDOWS,
    tier: 'international',
  },
  {
    key: 'fifa-world-cup-2026',
    label: 'FIFA World Cup 2026',
    apiFootballLeagueId: 1,
    season: 2026,
    calendar: INTERNATIONAL_WINDOWS,
    tier: 'international',
  },
];

export const PHASE_A_COMPETITIONS_BY_KEY: ReadonlyMap<string, CompetitionEntry> = new Map(
  PHASE_A_COMPETITIONS.map((entry) => [entry.key, entry])
);

/**
 * True if `nowUtc` falls inside any window of `calendar`. Windows are
 * inclusive-start, exclusive-end on the UTC hour. Empty calendars
 * always return false.
 */
export const isMatchdayWindow = (nowUtc: Date, calendar: MatchdayCalendar): boolean => {
  const weekday = nowUtc.getUTCDay();
  const hour = nowUtc.getUTCHours();
  return calendar.some(
    (window) =>
      window.utcWeekday === weekday && hour >= window.utcHourStart && hour < window.utcHourEnd
  );
};

/**
 * Returns the flattened, de-duplicated list of `verifiedFixtureIds`
 * declared across the Phase A catalogue (or any other competition
 * list supplied by the caller). Used by `worker/server.ts` to seed
 * the ingestion loop's `bootstrapFixtureIds` so staging smoke covers
 * the verified rotation without operator action.
 *
 * Empty entries are skipped, preserving the catalogue-as-source-of-
 * truth invariant: a competition without a verified id contributes
 * nothing and does not block the rotation.
 */
export const phaseAVerifiedFixtureIds = (
  competitions: readonly CompetitionEntry[] = PHASE_A_COMPETITIONS
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
