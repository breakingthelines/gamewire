/**
 * API-Football provider types and launch coverage configuration.
 *
 * @see https://www.api-football.com/documentation-v3
 */

export interface ApiFootballCompetitionPlan {
  readonly label: string;
  readonly country: string;
  readonly leagueId: number;
  readonly season: number;
  // `tier` is documentary only — no ingestion behaviour (poll cadence, sweep
  // gating, budget) branches on it. `domestic-top-five` = the original five;
  // `domestic-league` = other covered first divisions; `domestic-cup` = national
  // knockout cups (no league table — the standings sweep returns empty, handled
  // gracefully); `international` = World Cup et al.
  readonly tier: 'domestic-top-five' | 'domestic-league' | 'domestic-cup' | 'international';
}

export interface ApiFootballEnvelope<TResponse = unknown> {
  readonly get?: string;
  readonly parameters?: Record<string, unknown> | readonly unknown[];
  readonly errors?: Record<string, unknown> | readonly unknown[];
  readonly results?: number;
  readonly paging?: {
    readonly current?: number;
    readonly total?: number;
  };
  readonly response: TResponse;
}

export interface ApiFootballFixtureRef {
  readonly id: number;
  readonly date: string;
  readonly status: {
    readonly short: string;
    readonly elapsed?: number | null;
  };
  /**
   * Stadium the fixture is played at. Present on every `/fixtures` response
   * as `fixture.venue.{id, name, city}`; `id`/`city` are occasionally null
   * for neutral or newly-added grounds, and `name` can be null when the
   * provider has not yet attached a venue. Mapped to `Game.venue` (a
   * `btl.context.v1.SubjectRef`, type VENUE) only when `name` is present.
   */
  readonly venue?: {
    readonly id?: number | null;
    readonly name?: string | null;
    readonly city?: string | null;
  } | null;
}

export interface ApiFootballLeagueRef {
  readonly id: number;
  readonly name: string;
  readonly season: number;
  readonly country?: string;
  readonly logo?: string | null;
  readonly flag?: string | null;
  readonly round?: string;
  readonly standings?: boolean;
}

export interface ApiFootballTeamRef {
  readonly id: number;
  readonly name: string;
  readonly code?: string | null;
  readonly country?: string | null;
  readonly logo?: string | null;
  readonly winner?: boolean | null;
}

/** A home/away score pair as API-Football reports each phase under `score`. */
export interface ApiFootballScoreLine {
  readonly home?: number | null;
  readonly away?: number | null;
}

export interface ApiFootballFixtureResponse {
  readonly fixture: ApiFootballFixtureRef;
  readonly league: ApiFootballLeagueRef;
  readonly teams: {
    readonly home: ApiFootballTeamRef;
    readonly away: ApiFootballTeamRef;
  };
  readonly goals?: {
    readonly home?: number | null;
    readonly away?: number | null;
  };
  // Per-phase scores. `penalty` carries the shootout tally for a tie decided on
  // penalties (e.g. {home: 3, away: 4}); null/absent when there was no shootout.
  // `goals` above stays the running/aggregate score (1-1) so the shootout result
  // is surfaced separately rather than folded into the scoreline.
  readonly score?: {
    readonly halftime?: ApiFootballScoreLine | null;
    readonly fulltime?: ApiFootballScoreLine | null;
    readonly extratime?: ApiFootballScoreLine | null;
    readonly penalty?: ApiFootballScoreLine | null;
  };
}

export interface ApiFootballEventResponse {
  readonly time: {
    readonly elapsed: number;
    readonly extra?: number | null;
  };
  readonly team: ApiFootballTeamRef;
  readonly player?: ApiFootballTeamRef | null;
  readonly assist?: ApiFootballTeamRef | null;
  readonly type: string;
  readonly detail: string;
  readonly comments?: string | null;
}

/**
 * Per-fixture kit colours, present only on the `/fixtures/lineups` payload
 * (not `/teams`). API-Football reports them under `team.colors` as 6-digit
 * hex strings without a leading `#` (e.g. Arsenal `e10000`, Man City
 * `abd1f5`). `player` is the outfield kit; `goalkeeper` the keeper kit. Any
 * sub-field can be absent for fixtures the provider has not coloured.
 */
export interface ApiFootballKitColors {
  readonly player?: ApiFootballKitColorSet | null;
  readonly goalkeeper?: ApiFootballKitColorSet | null;
}

export interface ApiFootballKitColorSet {
  readonly primary?: string | null;
  readonly number?: string | null;
  readonly border?: string | null;
}

export interface ApiFootballLineupResponse {
  readonly team: ApiFootballTeamRef & {
    readonly colors?: ApiFootballKitColors | null;
  };
  readonly formation: string;
  readonly startXI: readonly ApiFootballLineupPlayer[];
  readonly substitutes: readonly ApiFootballLineupPlayer[];
}

export interface ApiFootballLineupPlayer {
  readonly player: {
    readonly id: number;
    readonly name: string;
    readonly number?: number | null;
    readonly pos?: string | null;
    readonly grid?: string | null;
  };
}

export interface ApiFootballSquadResponse {
  readonly team: ApiFootballTeamRef;
  readonly players: readonly ApiFootballSquadPlayer[];
}

export interface ApiFootballSquadPlayer {
  readonly id: number;
  readonly name: string;
  readonly age?: number | null;
  readonly number?: number | null;
  readonly position?: string | null;
  readonly photo?: string | null;
}

/**
 * `/fixtures/statistics?fixture=<id>` response item. One entry per team.
 * `statistics` is a flat list of `{ type, value }` pairs; `value` is a
 * number, a percentage string (e.g. `"54%"`), or `null` when the provider
 * did not report the metric for that team. See {@link API_FOOTBALL_TEAM_STAT_TYPES}
 * for the canonical type-string → field mapping.
 */
export interface ApiFootballStatisticsResponse {
  readonly team: ApiFootballTeamRef;
  readonly statistics: readonly ApiFootballStatisticEntry[];
}

export interface ApiFootballStatisticEntry {
  readonly type: string;
  readonly value: number | string | null;
}

/**
 * `/fixtures/players?fixture=<id>` response item. One entry per team, each
 * carrying that team's per-player stat lines under `players`.
 */
export interface ApiFootballPlayersResponse {
  readonly team: ApiFootballTeamRef;
  readonly players: readonly ApiFootballPlayerStatsEntry[];
}

export interface ApiFootballPlayerStatsEntry {
  readonly player: {
    readonly id: number;
    readonly name: string;
    readonly photo?: string | null;
  };
  /**
   * API-Football nests each player's match line in a single-element
   * `statistics` array (the per-fixture endpoint never returns more than
   * one element here, but it is modelled as a list for parity with the
   * season endpoints).
   */
  readonly statistics: readonly ApiFootballPlayerStatistics[];
}

/**
 * One player's per-match statistics block as returned by
 * `/fixtures/players`. Every leaf is optional/nullable — providers omit
 * metrics they do not record (e.g. goalkeeper-only fields for outfielders),
 * and the mapper only emits a `FieldProvenance` entry for the leaves that
 * are actually present.
 */
export interface ApiFootballPlayerStatistics {
  readonly games?: {
    readonly minutes?: number | null;
    readonly number?: number | null;
    readonly position?: string | null;
    readonly rating?: string | number | null;
    readonly captain?: boolean | null;
    readonly substitute?: boolean | null;
  } | null;
  readonly offsides?: number | null;
  readonly shots?: {
    readonly total?: number | null;
    readonly on?: number | null;
  } | null;
  readonly goals?: {
    readonly total?: number | null;
    readonly conceded?: number | null;
    readonly assists?: number | null;
    readonly saves?: number | null;
  } | null;
  readonly passes?: {
    readonly total?: number | null;
    readonly key?: number | null;
    readonly accuracy?: number | string | null;
  } | null;
  readonly tackles?: {
    readonly total?: number | null;
    readonly blocks?: number | null;
    readonly interceptions?: number | null;
  } | null;
  readonly duels?: {
    readonly total?: number | null;
    readonly won?: number | null;
  } | null;
  readonly dribbles?: {
    readonly attempts?: number | null;
    readonly success?: number | null;
    readonly past?: number | null;
  } | null;
  readonly fouls?: {
    readonly drawn?: number | null;
    readonly committed?: number | null;
  } | null;
  readonly cards?: {
    readonly yellow?: number | null;
    readonly red?: number | null;
  } | null;
  readonly penalty?: {
    readonly won?: number | null;
    readonly committed?: number | null;
    readonly scored?: number | null;
    readonly missed?: number | null;
    readonly saved?: number | null;
  } | null;
  readonly expected_goals?: number | string | null;
  readonly expected_assists?: number | string | null;
}

export interface ApiFootballStandingResponse {
  readonly league: ApiFootballLeagueRef & {
    readonly standings: readonly (readonly ApiFootballStandingEntry[])[];
  };
}

export interface ApiFootballStandingEntry {
  readonly rank: number;
  readonly team: ApiFootballTeamRef;
  readonly points: number;
  readonly all: {
    readonly played: number;
    readonly win: number;
    readonly draw: number;
    readonly lose: number;
    readonly goals: {
      readonly for: number;
      readonly against: number;
    };
  };
  readonly goalsDiff: number;
  // group is the standings group label the provider tags each row with, e.g.
  // "Group A" for a World Cup group-phase table or the league name ("Premier
  // League") for a single-table domestic competition. Carried through to
  // FootballStandingEntry.group so the serve path can partition by group.
  readonly group?: string;
}

export const API_FOOTBALL_PROVIDER_ID = 'api-football';

export const API_FOOTBALL_BETA_COMPETITIONS: readonly ApiFootballCompetitionPlan[] = [
  {
    label: 'Premier League',
    country: 'England',
    leagueId: 39,
    season: 2025,
    tier: 'domestic-top-five',
  },
  { label: 'La Liga', country: 'Spain', leagueId: 140, season: 2025, tier: 'domestic-top-five' },
  { label: 'Serie A', country: 'Italy', leagueId: 135, season: 2025, tier: 'domestic-top-five' },
  {
    label: 'Bundesliga',
    country: 'Germany',
    leagueId: 78,
    season: 2025,
    tier: 'domestic-top-five',
  },
  { label: 'Ligue 1', country: 'France', leagueId: 61, season: 2025, tier: 'domestic-top-five' },
  { label: 'FIFA World Cup', country: 'World', leagueId: 1, season: 2026, tier: 'international' },

  // Scope A — additional covered first divisions (clubs enriched in identity
  // v0.24.0). Belgium/Portugal/Netherlands top flights.
  { label: 'Pro League', country: 'Belgium', leagueId: 144, season: 2025, tier: 'domestic-league' },
  {
    label: 'Primeira Liga',
    country: 'Portugal',
    leagueId: 94,
    season: 2025,
    tier: 'domestic-league',
  },
  {
    label: 'Eredivisie',
    country: 'Netherlands',
    leagueId: 88,
    season: 2025,
    tier: 'domestic-league',
  },

  // Scope A — domestic cups. Knockout (no league table): the standings sweep
  // returns an empty table, which the competition page renders gracefully. Their
  // lower-tier clubs are crosswalked in identity v0.24.0 from the round the
  // top-flight clubs enter; earlier-round minnows degrade to monograms.
  { label: 'FA Cup', country: 'England', leagueId: 45, season: 2025, tier: 'domestic-cup' },
  { label: 'EFL Cup', country: 'England', leagueId: 48, season: 2025, tier: 'domestic-cup' },
  { label: 'Copa del Rey', country: 'Spain', leagueId: 143, season: 2025, tier: 'domestic-cup' },
  { label: 'Coppa Italia', country: 'Italy', leagueId: 137, season: 2025, tier: 'domestic-cup' },
  { label: 'DFB Pokal', country: 'Germany', leagueId: 81, season: 2025, tier: 'domestic-cup' },
  { label: 'Coupe de France', country: 'France', leagueId: 66, season: 2025, tier: 'domestic-cup' },
];
