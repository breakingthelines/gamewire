/**
 * API-Football provider types.
 *
 * The competition coverage catalogue lives in `src/workflows/competitions.ts`
 * (`COMPETITIONS`, `LIVE_INGESTION_COMPETITIONS`, `STEADY_STATE_COMPETITIONS`)
 * — not here. This module is provider wire-shape types only.
 *
 * @see https://www.api-football.com/documentation-v3
 */

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
  /**
   * API-Football reports `null` here for a subset of domestic-cup fixtures
   * even when the full XI + substitutes are present — verified live against
   * fixtures 1486145 / 1486143 (Pontevedra, Eibar, Ourense CF, Girona all
   * carried `formation: null` with 11 named starters). Formation is cosmetic
   * annotation, not part of what makes a lineup valid — a lineup is defined
   * by its players. Callers must treat this as optional and degrade to a
   * player list (no pitch/formation viz) rather than discarding the sheet.
   */
  readonly formation: string | null;
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

/**
 * One `seasons[]` entry of a `/leagues?id=<id>` response. The provider lists
 * every season it has coverage for; exactly one carries `current: true`. `year`
 * is the split-season's opening calendar year (e.g. `2025` → the 2025/26
 * season); `start`/`end` are ISO `YYYY-MM-DD` calendar bounds. All fields are
 * defensively optional so a partial/older envelope normalises to "no current
 * season" rather than throwing.
 */
export interface ApiFootballLeagueSeason {
  readonly year?: number | null;
  readonly start?: string | null;
  readonly end?: string | null;
  readonly current?: boolean | null;
}

/**
 * One `response[]` entry of a `/leagues?id=<id>` response:
 *   { league: { id, name, ... }, country: {...}, seasons: [ <season>, ... ] }
 * Only `league.{id,name}` and `seasons` are consumed by the current-season
 * normaliser; the rest of the provider payload is ignored.
 */
export interface ApiFootballLeagueResponse {
  readonly league?: {
    readonly id?: number | null;
    readonly name?: string | null;
  } | null;
  readonly seasons?: readonly ApiFootballLeagueSeason[] | null;
}

export const API_FOOTBALL_PROVIDER_ID = 'api-football';
