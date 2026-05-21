import { create } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromMs } from '@bufbuild/protobuf/wkt';

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
  GameScoreSchema,
  GameSchema,
  GameStatus,
  OccurrenceRevisionState,
  ParticipantScoreSchema,
  ProviderAttributionSchema,
  ResolutionState,
  SportActionPayloadSchema,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import {
  FootballActionPayloadSchema,
  FootballActionType,
  FootballClockPayloadSchema,
  FootballGamePayloadSchema,
  FootballScorePayloadSchema,
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
  type ApiFootballEnvelope,
  type ApiFootballCompetitionPlan,
  type ApiFootballFixtureResponse,
} from './types.js';

export const API_FOOTBALL_REPLAY_ID = 'api-football:replay:arsenal-chelsea-2026-05-11';
export const API_FOOTBALL_REPLAY_GAME_ID = 'btl_football_game_api_football_1917';
export const API_FOOTBALL_REPLAY_COMPETITION_ID = 'btl_football_competition_lb3d230cb';
export const API_FOOTBALL_REPLAY_SEASON_ID = 'btl_football_season_sdc8762eb';
export const API_FOOTBALL_REPLAY_HOME_TEAM_ID = 'btl_football_team_t8596499a';
export const API_FOOTBALL_REPLAY_AWAY_TEAM_ID = 'btl_football_team_ta544eb41';
export const API_FOOTBALL_REPLAY_FIXTURE_ID = 1917;

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

export function apiFootballStatusPath(): string {
  return '/status';
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
    metadata: metadata(
      options.provider ?? API_FOOTBALL_PROVIDER_ID,
      options.replayId,
      'fixtures',
      'league-39-season-2025'
    ),
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
    metadata: metadata(
      options.provider ?? API_FOOTBALL_PROVIDER_ID,
      options.replayId,
      'game',
      options.gameId
    ),
    games: replayGame.id === options.gameId ? [replayGame] : [],
  });
}

export function apiFootballIngestGamesRequestFromFixtures(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly resourceId: string;
  readonly envelope: ApiFootballEnvelope<readonly ApiFootballFixtureResponse[]> | unknown;
  readonly fetchedAtMs?: number;
}): IngestGamesRequest {
  const providerId = options.provider ?? API_FOOTBALL_PROVIDER_ID;
  const games = apiFootballFixturesFromEnvelope(options.envelope)
    .map((fixture) =>
      liveGame(fixture, {
        fetchedAtMs: options.fetchedAtMs ?? Date.now(),
      })
    )
    .filter((game): game is NonNullable<ReturnType<typeof liveGame>> => game !== null);

  return create(IngestGamesRequestSchema, {
    metadata: metadata(
      providerId,
      options.replayId,
      'fixtures',
      options.resourceId,
      `provider://${providerId}/fixtures/${options.resourceId}`
    ),
    games,
  });
}

export function apiFootballReplayLineupsRequest(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly gameId: string;
}): IngestFootballLineupsRequest {
  return create(IngestFootballLineupsRequestSchema, {
    metadata: metadata(
      options.provider ?? API_FOOTBALL_PROVIDER_ID,
      options.replayId,
      'lineups',
      options.gameId
    ),
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
            players: [
              player('btl_football_player_p2804f5db', 'Cole Palmer', 20, 'AM', 8, true, true),
            ],
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
    metadata: metadata(
      options.provider ?? API_FOOTBALL_PROVIDER_ID,
      options.replayId,
      'events',
      options.gameId
    ),
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
    metadata: metadata(
      options.provider ?? API_FOOTBALL_PROVIDER_ID,
      options.replayId,
      'standings',
      'league-39-season-2025'
    ),
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

/**
 * Defensively stringify an API-Football fixture id for the protobuf
 * `Game.provider_game_id` field. API-Football returns numeric ids; the proto
 * field is a string. Returns "" when the id is missing, zero, NaN, or
 * otherwise non-numeric — game-service skip-with-logs on empty, which is the
 * correct steady-state behaviour for malformed envelopes.
 */
export function providerGameIdFromFixture(
  fixture: { readonly id?: unknown } | undefined | null
): string {
  if (!fixture) return '';
  const raw = fixture.id;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw !== 0 ? String(raw) : '';
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '0') return '';
    return trimmed;
  }
  return '';
}

function apiFootballFixturesFromEnvelope(
  envelope: ApiFootballEnvelope<readonly ApiFootballFixtureResponse[]> | unknown
): readonly ApiFootballFixtureResponse[] {
  if (!isRecord(envelope)) {
    return [];
  }
  const response = (envelope as { response?: unknown }).response;
  if (!Array.isArray(response)) {
    return [];
  }
  return response.filter(isApiFootballFixtureResponse);
}

function isApiFootballFixtureResponse(value: unknown): value is ApiFootballFixtureResponse {
  if (!isRecord(value)) {
    return false;
  }
  const fixture = (value as { fixture?: unknown }).fixture;
  const league = (value as { league?: unknown }).league;
  const teams = (value as { teams?: unknown }).teams;
  return isRecord(fixture) && isRecord(league) && isRecord(teams);
}

function liveGame(response: ApiFootballFixtureResponse, options: { readonly fetchedAtMs: number }) {
  const providerGameId = providerGameIdFromFixture(response.fixture);
  if (providerGameId === '') {
    return null;
  }
  const scheduledStartMs = Date.parse(response.fixture.date);
  if (!Number.isFinite(scheduledStartMs)) {
    return null;
  }

  const competition = subject(
    `btl_football_competition_api_football_${response.league.id}`,
    SubjectType.COMPETITION,
    response.league.name,
    slugify(response.league.name || `competition-${response.league.id}`)
  );
  const season = subject(
    `btl_football_season_api_football_${response.league.id}_${response.league.season}`,
    SubjectType.SEASON,
    `${response.league.season} ${response.league.name}`,
    slugify(`${response.league.season}-${response.league.name}`)
  );
  const home = subject(
    `btl_football_team_api_football_${response.teams.home.id}`,
    SubjectType.TEAM,
    response.teams.home.name,
    slugify(response.teams.home.name || `team-${response.teams.home.id}`)
  );
  const away = subject(
    `btl_football_team_api_football_${response.teams.away.id}`,
    SubjectType.TEAM,
    response.teams.away.name,
    slugify(response.teams.away.name || `team-${response.teams.away.id}`)
  );

  const homeGoals = nullableNumber(response.goals?.home);
  const awayGoals = nullableNumber(response.goals?.away);
  const hasScore = homeGoals !== undefined || awayGoals !== undefined;
  const status = gameStatusFromApiFootball(response.fixture.status.short);
  const finalScore = status === GameStatus.FINISHED || status === GameStatus.AWARDED;
  const gameId = `btl_football_game_api_football_${providerGameId}`;
  const routeId = `g3-fixture-${providerGameId}`;
  const slug = slugify(
    `${response.teams.home.name}-vs-${response.teams.away.name}-${new Date(scheduledStartMs)
      .toISOString()
      .slice(0, 10)}`
  );

  return create(GameSchema, {
    id: gameId,
    slug,
    routeId,
    sport: Sport.FOOTBALL,
    providerGameId,
    competition,
    season,
    participants: [
      create(GameParticipantSchema, {
        subject: home,
        role: GameParticipantRole.HOME,
        sortOrder: 1,
      }),
      create(GameParticipantSchema, {
        subject: away,
        role: GameParticipantRole.AWAY,
        sortOrder: 2,
      }),
    ],
    scheduledStart: create(TimestampSchema, timestampFromMs(scheduledStartMs)),
    status,
    clock: clockFromApiFootball(response.fixture.status.short, response.fixture.status.elapsed),
    score: hasScore
      ? create(GameScoreSchema, {
          scores: [
            create(ParticipantScoreSchema, {
              participantId: home.id,
              score: homeGoals ?? 0,
              display: String(homeGoals ?? 0),
            }),
            create(ParticipantScoreSchema, {
              participantId: away.id,
              score: awayGoals ?? 0,
              display: String(awayGoals ?? 0),
            }),
          ],
          display: `${homeGoals ?? 0}-${awayGoals ?? 0}`,
          final: finalScore,
          sportScore: {
            case: 'football',
            value: create(FootballScorePayloadSchema, {
              homeGoals: homeGoals ?? 0,
              awayGoals: awayGoals ?? 0,
            }),
          },
        })
      : undefined,
    hasLineups: false,
    hasTimeline: false,
    hasRichActions: false,
    fallbackReasons: [],
    provenance: [],
    sportPayload: {
      case: 'football',
      value: create(FootballGamePayloadSchema, {
        matchday: matchdayFromRound(response.league.round),
        stage: response.league.round ?? '',
      }),
    },
    updatedAt: create(TimestampSchema, timestampFromMs(options.fetchedAtMs)),
  });
}

function game(fixture: { readonly id?: unknown } = { id: API_FOOTBALL_REPLAY_FIXTURE_ID }) {
  return create(GameSchema, {
    id: API_FOOTBALL_REPLAY_GAME_ID,
    slug: 'arsenal-v-chelsea-2026-05-11',
    routeId: `g3-fixture-${providerGameIdFromFixture(fixture)}`,
    sport: Sport.FOOTBALL,
    providerGameId: providerGameIdFromFixture(fixture),
    competition: subject(
      API_FOOTBALL_REPLAY_COMPETITION_ID,
      SubjectType.COMPETITION,
      'Premier League',
      'premier-league'
    ),
    season: subject(
      API_FOOTBALL_REPLAY_SEASON_ID,
      SubjectType.SEASON,
      '2025-26 Premier League',
      '2025-26-premier-league'
    ),
    participants: [
      create(GameParticipantSchema, {
        subject: subject(
          API_FOOTBALL_REPLAY_HOME_TEAM_ID,
          SubjectType.TEAM,
          'Arsenal F.C.',
          'arsenal'
        ),
        role: GameParticipantRole.HOME,
        sortOrder: 1,
      }),
      create(GameParticipantSchema, {
        subject: subject(
          API_FOOTBALL_REPLAY_AWAY_TEAM_ID,
          SubjectType.TEAM,
          'Chelsea F.C.',
          'chelsea'
        ),
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

function metadata(
  providerId: string,
  replayId: string,
  activity: string,
  resourceId: string,
  rawPayloadRef = `replay://${providerId}/${activity}/${resourceId}`
) {
  return create(IngestMetadataSchema, {
    provider: providerId,
    replayId,
    rawPayloadRef,
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

function clockFromApiFootball(status: string, elapsed: number | null | undefined) {
  if (elapsed === undefined || elapsed === null || elapsed < 0) {
    return undefined;
  }
  const normalised = status.trim().toUpperCase();
  return create(GameClockSchema, {
    display: `${elapsed}'`,
    period: footballPeriodFromStatus(normalised),
    elapsedSeconds: elapsed * 60,
    running: ['1H', '2H', 'ET', 'BT', 'P'].includes(normalised),
    sportClock: {
      case: 'football',
      value: create(FootballClockPayloadSchema, {
        period: footballPeriodFromStatus(normalised),
        minute: elapsed,
      }),
    },
  });
}

function footballPeriodFromStatus(status: string): FootballPeriod {
  switch (status) {
    case '1H':
      return FootballPeriod.FIRST_HALF;
    case 'HT':
      return FootballPeriod.HALF_TIME;
    case '2H':
      return FootballPeriod.SECOND_HALF;
    case 'ET':
    case 'BT':
      return FootballPeriod.EXTRA_TIME_FIRST;
    case 'P':
    case 'PEN':
      return FootballPeriod.SHOOTOUT;
    case 'FT':
    case 'AET':
      return FootballPeriod.FULL_TIME;
    default:
      return FootballPeriod.UNSPECIFIED;
  }
}

function gameStatusFromApiFootball(status: string): GameStatus {
  switch (status.trim().toUpperCase()) {
    case '1H':
    case '2H':
    case 'ET':
    case 'BT':
    case 'P':
    case 'INT':
      return GameStatus.LIVE;
    case 'HT':
      return GameStatus.PAUSED;
    case 'SUSP':
      return GameStatus.SUSPENDED;
    case 'FT':
    case 'AET':
    case 'PEN':
      return GameStatus.FINISHED;
    case 'PST':
      return GameStatus.POSTPONED;
    case 'CANC':
      return GameStatus.CANCELLED;
    case 'ABD':
      return GameStatus.ABANDONED;
    case 'AWD':
    case 'WO':
      return GameStatus.AWARDED;
    case 'NS':
    case 'TBD':
    default:
      return GameStatus.SCHEDULED;
  }
}

function matchdayFromRound(round: string | undefined): number {
  if (!round) {
    return 0;
  }
  const match = round.match(/\b(\d{1,3})\b/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function nullableNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
