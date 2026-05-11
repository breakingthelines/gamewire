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
  readonly tier: 'domestic-top-five' | 'international';
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
}

export interface ApiFootballLeagueRef {
  readonly id: number;
  readonly name: string;
  readonly season: number;
  readonly country?: string;
}

export interface ApiFootballTeamRef {
  readonly id: number;
  readonly name: string;
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
}

export interface ApiFootballEventResponse {
  readonly time: {
    readonly elapsed: number;
    readonly extra?: number | null;
  };
  readonly team: ApiFootballTeamRef;
  readonly player?: ApiFootballTeamRef | null;
  readonly type: string;
  readonly detail: string;
  readonly comments?: string | null;
}

export interface ApiFootballLineupResponse {
  readonly team: ApiFootballTeamRef;
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
];
