import { create } from '@bufbuild/protobuf';

import {
  IngestFootballLineupsRequestSchema,
  IngestFootballStandingsRequestSchema,
  IngestGameOccurrencesRequestSchema,
  IngestGamesRequestSchema,
  IngestMetadataSchema,
  type GameFilter,
  type IngestFootballLineupsRequest,
  type IngestFootballStandingsRequest,
  type IngestGameOccurrencesRequest,
  type IngestGamesRequest,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  Sport,
  SubjectRefSchema,
  SubjectType,
} from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  GameClockSchema,
  GameOccurrenceKind,
  GameOccurrenceSchema,
  GameParticipantRole,
  GameParticipantSchema,
  GameSchema,
  GameStatus,
  OccurrenceRevisionState,
  ProviderAttributionSchema,
  ResolutionState,
  SportActionPayloadSchema,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import {
  FootballActionPayloadSchema,
  FootballActionType,
  FootballClockPayloadSchema,
  FootballGamePayloadSchema,
  FootballLineupsSchema,
  FootballPeriod,
  FootballStandingEntrySchema,
  FootballStandingsSchema,
  FootballTeamSheetPlayerSchema,
  FootballTeamSheetSchema,
  ShotEventDataSchema,
  ShotOutcome,
} from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';

import {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_PROVIDER_ID,
  type ApiFootballCompetitionPlan,
} from './types.js';

export const API_FOOTBALL_REPLAY_ID = 'api-football:replay:arsenal-chelsea-2026-05-11';
export const API_FOOTBALL_REPLAY_GAME_ID = 'btl_football_game_api_football_1917';
export const API_FOOTBALL_REPLAY_COMPETITION_ID = 'btl_football_competition_lb3d230cb';
export const API_FOOTBALL_REPLAY_SEASON_ID = 'btl_football_season_sdc8762eb';
export const API_FOOTBALL_REPLAY_HOME_TEAM_ID = 'btl_football_team_t8596499a';
export const API_FOOTBALL_REPLAY_AWAY_TEAM_ID = 'btl_football_team_ta544eb41';

const provider = create(ProviderAttributionSchema, {
  provider: API_FOOTBALL_PROVIDER_ID,
  name: 'API-Football',
  url: 'https://www.api-football.com/',
  license: 'commercial',
  commercialUseAllowed: true,
  attributionText: 'Data from API-Football replay fixture',
});

export function apiFootballCompetitionKey(competition: ApiFootballCompetitionPlan): string {
  return `league-${competition.leagueId}-season-${competition.season}`;
}

export function apiFootballFixtureSyncPaths(
  competitions: readonly ApiFootballCompetitionPlan[] = API_FOOTBALL_BETA_COMPETITIONS
): readonly string[] {
  return competitions.map(
    (competition) => `/fixtures?league=${competition.leagueId}&season=${competition.season}`
  );
}

export function apiFootballStandingSyncPaths(
  competitions: readonly ApiFootballCompetitionPlan[] = API_FOOTBALL_BETA_COMPETITIONS
): readonly string[] {
  return competitions.map(
    (competition) => `/standings?league=${competition.leagueId}&season=${competition.season}`
  );
}

export function apiFootballLivePath(): string {
  return '/fixtures?live=all';
}

export function apiFootballFixturePath(fixtureId: string): string {
  return `/fixtures?id=${encodeURIComponent(fixtureId)}`;
}

export function apiFootballLineupPath(fixtureId: string): string {
  return `/fixtures/lineups?fixture=${encodeURIComponent(fixtureId)}`;
}

export function apiFootballEventPath(fixtureId: string): string {
  return `/fixtures/events?fixture=${encodeURIComponent(fixtureId)}`;
}

export function apiFootballReplayFixturesRequest(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly filter?: GameFilter;
}): IngestGamesRequest {
  return create(IngestGamesRequestSchema, {
    metadata: metadata(options.provider ?? API_FOOTBALL_PROVIDER_ID, options.replayId, 'fixtures', 'league-39-season-2025'),
    games: [game()],
  });
}

export function apiFootballReplayGameRequest(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly gameId: string;
}): IngestGamesRequest {
  const replayGame = game();
  return create(IngestGamesRequestSchema, {
    metadata: metadata(options.provider ?? API_FOOTBALL_PROVIDER_ID, options.replayId, 'game', options.gameId),
    games: replayGame.id === options.gameId ? [replayGame] : [],
  });
}

export function apiFootballReplayLineupsRequest(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly gameId: string;
}): IngestFootballLineupsRequest {
  return create(IngestFootballLineupsRequestSchema, {
    metadata: metadata(options.provider ?? API_FOOTBALL_PROVIDER_ID, options.replayId, 'lineups', options.gameId),
    lineups: [
      create(FootballLineupsSchema, {
        gameId: options.gameId,
        teamSheets: [
          create(FootballTeamSheetSchema, {
            teamId: API_FOOTBALL_REPLAY_HOME_TEAM_ID,
            formation: '4-3-3',
            players: [player('btl_football_player_p6e54e01f', 'Bukayo Saka', 7, 'RW', 11, true)],
          }),
          create(FootballTeamSheetSchema, {
            teamId: API_FOOTBALL_REPLAY_AWAY_TEAM_ID,
            formation: '4-2-3-1',
            players: [player('btl_football_player_p2804f5db', 'Cole Palmer', 20, 'AM', 8, true, true)],
          }),
        ],
      }),
    ],
  });
}

export function apiFootballReplayOccurrencesRequest(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly gameId: string;
}): IngestGameOccurrencesRequest {
  return create(IngestGameOccurrencesRequestSchema, {
    metadata: metadata(options.provider ?? API_FOOTBALL_PROVIDER_ID, options.replayId, 'events', options.gameId),
    gameId: options.gameId,
    occurrences: [
      create(GameOccurrenceSchema, {
        id: 'api-football:event:1917:1',
        gameId: options.gameId,
        sequence: 1,
        clock: create(GameClockSchema, {
          display: "27'",
          period: 1,
          elapsedSeconds: 27 * 60,
          running: false,
          sportClock: {
            case: 'football',
            value: create(FootballClockPayloadSchema, {
              period: FootballPeriod.FIRST_HALF,
              minute: 27,
            }),
          },
        }),
        kind: GameOccurrenceKind.ACTION,
        resolutionState: ResolutionState.RESOLVED,
        version: 1,
        revisionState: OccurrenceRevisionState.CURRENT,
        source: provider,
        payload: {
          case: 'action',
          value: create(SportActionPayloadSchema, {
            action: {
              case: 'football',
              value: create(FootballActionPayloadSchema, {
                type: FootballActionType.SHOT,
                teamId: API_FOOTBALL_REPLAY_AWAY_TEAM_ID,
                playerId: 'btl_football_player_p2804f5db',
                actionData: {
                  case: 'shot',
                  value: create(ShotEventDataSchema, {
                    xg: 0.21,
                    outcome: ShotOutcome.GOAL,
                  }),
                },
                meta: {
                  provider_event_type: 'Goal',
                  provider_fixture_id: '1917',
                  provider_player_id: '152982',
                  provider_team_id: '49',
                },
              }),
            },
          }),
        },
      }),
    ],
  });
}

export function apiFootballReplayStandingsRequest(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly competitionId?: string;
  readonly seasonId?: string;
}): IngestFootballStandingsRequest {
  const competitionId = options.competitionId ?? API_FOOTBALL_REPLAY_COMPETITION_ID;
  const seasonId = options.seasonId ?? API_FOOTBALL_REPLAY_SEASON_ID;
  return create(IngestFootballStandingsRequestSchema, {
    metadata: metadata(options.provider ?? API_FOOTBALL_PROVIDER_ID, options.replayId, 'standings', 'league-39-season-2025'),
    standings: [
      create(FootballStandingsSchema, {
        competitionId,
        seasonId,
        entries: [
          standing(API_FOOTBALL_REPLAY_HOME_TEAM_ID, 'Arsenal F.C.', 1, 10, 7, 2, 1, 22, 9, 23),
          standing(API_FOOTBALL_REPLAY_AWAY_TEAM_ID, 'Chelsea F.C.', 4, 10, 5, 3, 2, 18, 12, 18),
        ],
      }),
    ],
  });
}

function game() {
  return create(GameSchema, {
    id: API_FOOTBALL_REPLAY_GAME_ID,
    slug: 'arsenal-v-chelsea-2026-05-11',
    sport: Sport.FOOTBALL,
    competition: subject(API_FOOTBALL_REPLAY_COMPETITION_ID, SubjectType.COMPETITION, 'Premier League', 'premier-league'),
    season: subject(
      API_FOOTBALL_REPLAY_SEASON_ID,
      SubjectType.SEASON,
      '2025-26 Premier League',
      '2025-26-premier-league'
    ),
    participants: [
      create(GameParticipantSchema, {
        subject: subject(API_FOOTBALL_REPLAY_HOME_TEAM_ID, SubjectType.TEAM, 'Arsenal F.C.', 'arsenal'),
        role: GameParticipantRole.HOME,
        sortOrder: 1,
      }),
      create(GameParticipantSchema, {
        subject: subject(API_FOOTBALL_REPLAY_AWAY_TEAM_ID, SubjectType.TEAM, 'Chelsea F.C.', 'chelsea'),
        role: GameParticipantRole.AWAY,
        sortOrder: 2,
      }),
    ],
    status: GameStatus.SCHEDULED,
    hasLineups: true,
    hasTimeline: true,
    hasRichActions: false,
    fallbackReasons: [],
    provenance: [],
    sportPayload: {
      case: 'football',
      value: create(FootballGamePayloadSchema, {
        matchday: 1,
        stage: 'regular-season',
      }),
    },
    updatedAt: undefined,
  });
}

function metadata(providerId: string, replayId: string, activity: string, resourceId: string) {
  return create(IngestMetadataSchema, {
    provider: providerId,
    replayId,
    rawPayloadRef: `replay://${providerId}/${activity}/${resourceId}`,
    normalizedBatchId: `${providerId}:${activity}:${resourceId}`,
    idempotencyKey: `${providerId}:${activity}:${resourceId}:${replayId}`,
  });
}

function subject(id: string, type: SubjectType, label: string, slug: string) {
  return create(SubjectRefSchema, {
    id,
    type,
    sport: Sport.FOOTBALL,
    label,
    slug,
  });
}

function player(
  playerId: string,
  playerName: string,
  shirtNumber: number,
  positionCode: string,
  formationSlot: number,
  isStarter: boolean,
  isCaptain = false
) {
  return create(FootballTeamSheetPlayerSchema, {
    playerId,
    playerName,
    shirtNumber,
    positionCode,
    formationSlot,
    isStarter,
    isCaptain,
  });
}

function standing(
  teamId: string,
  teamName: string,
  rank: number,
  played: number,
  won: number,
  drawn: number,
  lost: number,
  goalsFor: number,
  goalsAgainst: number,
  points: number
) {
  return create(FootballStandingEntrySchema, {
    teamId,
    teamName,
    rank,
    played,
    won,
    drawn,
    lost,
    goalsFor,
    goalsAgainst,
    goalDifference: goalsFor - goalsAgainst,
    points,
  });
}
