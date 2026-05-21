import { create } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromMs } from '@bufbuild/protobuf/wkt';

import {
  IngestFootballLineupsRequestSchema,
  IngestFootballSquadListsRequestSchema,
  IngestFootballStandingsRequestSchema,
  IngestGameOccurrencesRequestSchema,
  IngestGamesRequestSchema,
  IngestMetadataSchema,
  type GameFilter,
  type IngestFootballLineupsRequest,
  type IngestFootballSquadListsRequest,
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
  EntityResolutionRefSchema,
  GameTimelinePayloadSchema,
  OccurrenceRevisionState,
  ParticipantScoreSchema,
  ProviderEntitySnapshotSchema,
  ProviderRefSchema,
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
  FootballSquadListPlayerSchema,
  FootballSquadListSchema,
  FootballSquadListTeamSchema,
  FootballStandingEntrySchema,
  FootballStandingsSchema,
  FootballTeamSheetPlayerSchema,
  FootballTeamSheetSchema,
  FootballTimelineEventType,
  FootballTimelinePayloadSchema,
  ShotEventDataSchema,
  ShotOutcome,
} from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';

import {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_PROVIDER_ID,
  type ApiFootballEnvelope,
  type ApiFootballEventResponse,
  type ApiFootballLeagueRef,
  type ApiFootballCompetitionPlan,
  type ApiFootballFixtureResponse,
  type ApiFootballLineupResponse,
  type ApiFootballSquadPlayer,
  type ApiFootballSquadResponse,
  type ApiFootballTeamRef,
} from './types.js';

export const API_FOOTBALL_REPLAY_ID = 'api-football:replay:arsenal-chelsea-2026-05-11';
export const API_FOOTBALL_REPLAY_GAME_ID = 'btl_football_game_api_football_1917';
export const API_FOOTBALL_REPLAY_COMPETITION_ID = 'btl_football_competition_lb3d230cb';
export const API_FOOTBALL_REPLAY_SEASON_ID = 'btl_football_season_sdc8762eb';
export const API_FOOTBALL_REPLAY_HOME_TEAM_ID = 'btl_football_team_t8596499a';
export const API_FOOTBALL_REPLAY_AWAY_TEAM_ID = 'btl_football_team_ta544eb41';
export const API_FOOTBALL_REPLAY_FIXTURE_ID = 1917;

export type ApiFootballEntityKind = 'competition' | 'season' | 'team' | 'player';

export interface ApiFootballResolvedEntity {
  readonly entityId: string;
  readonly label?: string;
  readonly slug?: string;
}

export interface ApiFootballEntityResolutionMap {
  readonly competitions?: Readonly<Record<string, ApiFootballResolvedEntity | undefined>>;
  readonly seasons?: Readonly<Record<string, ApiFootballResolvedEntity | undefined>>;
  readonly teams?: Readonly<Record<string, ApiFootballResolvedEntity | undefined>>;
  readonly players?: Readonly<Record<string, ApiFootballResolvedEntity | undefined>>;
}

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

export function apiFootballSeasonProviderId(
  leagueId: number | string,
  season: number | string
): string {
  return `${leagueId}:${season}`;
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

export function apiFootballSquadPath(teamId: string): string {
  return `/players/squads?team=${encodeURIComponent(teamId)}`;
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
  readonly entityResolutions?: ApiFootballEntityResolutionMap;
  readonly fetchedAtMs?: number;
}): IngestGamesRequest {
  const providerId = options.provider ?? API_FOOTBALL_PROVIDER_ID;
  const games = apiFootballFixturesFromEnvelope(options.envelope)
    .map((fixture) =>
      liveGame(fixture, {
        providerId,
        entityResolutions: options.entityResolutions,
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

export function apiFootballIngestOccurrencesRequestFromEvents(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly resourceId: string;
  readonly gameId: string;
  readonly envelope: ApiFootballEnvelope<readonly ApiFootballEventResponse[]> | unknown;
  readonly entityResolutions?: ApiFootballEntityResolutionMap;
  readonly fetchedAtMs?: number;
}): IngestGameOccurrencesRequest {
  const providerId = options.provider ?? API_FOOTBALL_PROVIDER_ID;
  const events = apiFootballEventsFromEnvelope(options.envelope);
  const occurrences = events.map((event, index) =>
    occurrenceFromEvent(event, {
      providerId,
      providerFixtureId: options.resourceId,
      gameId: options.gameId,
      sequence: index + 1,
      entityResolutions: options.entityResolutions,
      fetchedAtMs: options.fetchedAtMs ?? Date.now(),
    })
  );

  return create(IngestGameOccurrencesRequestSchema, {
    metadata: metadata(
      providerId,
      options.replayId,
      'events',
      options.resourceId,
      `provider://${providerId}/fixtures/events/${options.resourceId}`
    ),
    gameId: options.gameId,
    occurrences,
  });
}

export function apiFootballIngestLineupsRequestFromLineups(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly resourceId: string;
  readonly gameId: string;
  readonly envelope: ApiFootballEnvelope<readonly ApiFootballLineupResponse[]> | unknown;
  readonly entityResolutions?: ApiFootballEntityResolutionMap;
  readonly fetchedAtMs?: number;
}): IngestFootballLineupsRequest {
  const providerId = options.provider ?? API_FOOTBALL_PROVIDER_ID;
  const lineups = apiFootballLineupsFromEnvelope(options.envelope);
  const teamSheets = lineups.map((lineup) =>
    teamSheetFromLineup(lineup, {
      providerId,
      entityResolutions: options.entityResolutions,
    })
  );

  return create(IngestFootballLineupsRequestSchema, {
    metadata: metadata(
      providerId,
      options.replayId,
      'lineups',
      options.resourceId,
      `provider://${providerId}/fixtures/lineups/${options.resourceId}`
    ),
    lineups:
      teamSheets.length > 0
        ? [
            create(FootballLineupsSchema, {
              gameId: options.gameId,
              teamSheets,
              updatedAt: create(
                TimestampSchema,
                timestampFromMs(options.fetchedAtMs ?? Date.now())
              ),
            }),
          ]
        : [],
  });
}

export function apiFootballIngestSquadListRequestFromSquads(options: {
  readonly provider?: string;
  readonly replayId: string;
  readonly resourceId: string;
  readonly gameId: string;
  readonly envelope: ApiFootballEnvelope<readonly ApiFootballSquadResponse[]> | unknown;
  readonly entityResolutions?: ApiFootballEntityResolutionMap;
  readonly fetchedAtMs?: number;
}): IngestFootballSquadListsRequest {
  const providerId = options.provider ?? API_FOOTBALL_PROVIDER_ID;
  const squads = apiFootballSquadsFromEnvelope(options.envelope);
  const teams = squads.map((squad) =>
    squadListTeamFromSquad(squad, {
      providerId,
      entityResolutions: options.entityResolutions,
    })
  );

  return create(IngestFootballSquadListsRequestSchema, {
    metadata: metadata(
      providerId,
      options.replayId,
      'squads',
      options.resourceId,
      `provider://${providerId}/players/squads/${options.resourceId}`
    ),
    squadLists:
      teams.length > 0
        ? [
            create(FootballSquadListSchema, {
              gameId: options.gameId,
              teams,
              updatedAt: create(
                TimestampSchema,
                timestampFromMs(options.fetchedAtMs ?? Date.now())
              ),
            }),
          ]
        : [],
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

function apiFootballEventsFromEnvelope(
  envelope: ApiFootballEnvelope<readonly ApiFootballEventResponse[]> | unknown
): readonly ApiFootballEventResponse[] {
  if (!isRecord(envelope)) {
    return [];
  }
  const response = (envelope as { response?: unknown }).response;
  if (!Array.isArray(response)) {
    return [];
  }
  return response.filter(isApiFootballEventResponse);
}

function apiFootballLineupsFromEnvelope(
  envelope: ApiFootballEnvelope<readonly ApiFootballLineupResponse[]> | unknown
): readonly ApiFootballLineupResponse[] {
  if (!isRecord(envelope)) {
    return [];
  }
  const response = (envelope as { response?: unknown }).response;
  if (!Array.isArray(response)) {
    return [];
  }
  return response.filter(isApiFootballLineupResponse);
}

function apiFootballSquadsFromEnvelope(
  envelope: ApiFootballEnvelope<readonly ApiFootballSquadResponse[]> | unknown
): readonly ApiFootballSquadResponse[] {
  if (!isRecord(envelope)) {
    return [];
  }
  const response = (envelope as { response?: unknown }).response;
  if (!Array.isArray(response)) {
    return [];
  }
  return response.filter(isApiFootballSquadResponse);
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

function isApiFootballEventResponse(value: unknown): value is ApiFootballEventResponse {
  if (!isRecord(value)) {
    return false;
  }
  const time = (value as { time?: unknown }).time;
  const team = (value as { team?: unknown }).team;
  const type = (value as { type?: unknown }).type;
  const detail = (value as { detail?: unknown }).detail;
  return isRecord(time) && isRecord(team) && typeof type === 'string' && typeof detail === 'string';
}

function isApiFootballLineupResponse(value: unknown): value is ApiFootballLineupResponse {
  if (!isRecord(value)) {
    return false;
  }
  const team = (value as { team?: unknown }).team;
  return (
    isRecord(team) &&
    typeof (value as { formation?: unknown }).formation === 'string' &&
    Array.isArray((value as { startXI?: unknown }).startXI) &&
    Array.isArray((value as { substitutes?: unknown }).substitutes)
  );
}

function isApiFootballSquadResponse(value: unknown): value is ApiFootballSquadResponse {
  if (!isRecord(value)) {
    return false;
  }
  const team = (value as { team?: unknown }).team;
  const players = (value as { players?: unknown }).players;
  return isRecord(team) && Array.isArray(players) && players.some(isApiFootballSquadPlayer);
}

function isApiFootballSquadPlayer(value: unknown): value is ApiFootballSquadPlayer {
  return (
    isRecord(value) &&
    Number.isFinite((value as { id?: unknown }).id) &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function liveGame(
  response: ApiFootballFixtureResponse,
  options: {
    readonly providerId: string;
    readonly entityResolutions?: ApiFootballEntityResolutionMap;
    readonly fetchedAtMs: number;
  }
) {
  const providerGameId = providerGameIdFromFixture(response.fixture);
  if (providerGameId === '') {
    return null;
  }
  const scheduledStartMs = Date.parse(response.fixture.date);
  if (!Number.isFinite(scheduledStartMs)) {
    return null;
  }

  const competition = resolvedSubject(
    'competition',
    options.providerId,
    String(response.league.id),
    SubjectType.COMPETITION,
    response.league.name,
    options.entityResolutions,
    competitionSnapshot(response.league)
  );
  const season = resolvedSubject(
    'season',
    options.providerId,
    apiFootballSeasonProviderId(response.league.id, response.league.season),
    SubjectType.SEASON,
    `${response.league.season} ${response.league.name}`,
    options.entityResolutions,
    seasonSnapshot(response.league)
  );
  const home = resolvedSubject(
    'team',
    options.providerId,
    String(response.teams.home.id),
    SubjectType.TEAM,
    response.teams.home.name,
    options.entityResolutions,
    teamSnapshot(response.teams.home)
  );
  const away = resolvedSubject(
    'team',
    options.providerId,
    String(response.teams.away.id),
    SubjectType.TEAM,
    response.teams.away.name,
    options.entityResolutions,
    teamSnapshot(response.teams.away)
  );

  const homeGoals = nullableNumber(response.goals?.home);
  const awayGoals = nullableNumber(response.goals?.away);
  const hasScore = homeGoals !== undefined || awayGoals !== undefined;
  const status = gameStatusFromApiFootball(response.fixture.status.short);
  const finalScore = status === GameStatus.FINISHED || status === GameStatus.AWARDED;
  const gameResolutionRef = entityResolutionRef(
    options.providerId,
    providerGameId,
    'fixture',
    SubjectType.GAME,
    `${response.teams.home.name} v ${response.teams.away.name}`,
    undefined
  );

  return create(GameSchema, {
    sport: Sport.FOOTBALL,
    providerGameId,
    competition: competition.subject,
    season: season.subject,
    participants: [
      create(GameParticipantSchema, {
        subject: home.subject,
        resolutionRef: home.resolutionRef,
        role: GameParticipantRole.HOME,
        sortOrder: 1,
      }),
      create(GameParticipantSchema, {
        subject: away.subject,
        resolutionRef: away.resolutionRef,
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
              participantId:
                home.subject?.id ??
                providerStorageId(options.providerId, 'team', response.teams.home.id),
              score: homeGoals ?? 0,
              display: String(homeGoals ?? 0),
            }),
            create(ParticipantScoreSchema, {
              participantId:
                away.subject?.id ??
                providerStorageId(options.providerId, 'team', response.teams.away.id),
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
    resolutionRef: gameResolutionRef,
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

function occurrenceFromEvent(
  event: ApiFootballEventResponse,
  options: {
    readonly providerId: string;
    readonly providerFixtureId: string;
    readonly gameId: string;
    readonly sequence: number;
    readonly entityResolutions?: ApiFootballEntityResolutionMap;
    readonly fetchedAtMs: number;
  }
) {
  const teamActor = actorFromProviderRef(
    'team',
    options.providerId,
    event.team,
    SubjectType.TEAM,
    options.entityResolutions
  );
  const playerActor = actorFromProviderRef(
    'player',
    options.providerId,
    event.player,
    SubjectType.PLAYER,
    options.entityResolutions
  );
  const assistActor = actorFromProviderRef(
    'player',
    options.providerId,
    event.assist,
    SubjectType.PLAYER,
    options.entityResolutions
  );
  const actors = [teamActor, playerActor, assistActor].filter(
    (actor): actor is NonNullable<typeof actor> => actor !== undefined
  );
  const timelineType = footballTimelineTypeFromApiFootball(event.type, event.detail);
  const kind = occurrenceKindFromApiFootball(event.type, event.detail);
  const clock = clockFromEventTime(event.time);
  const primaryPlayerId = actorEntityId(playerActor);
  const secondaryPlayerId = actorEntityId(assistActor);
  const teamId = actorEntityId(teamActor);

  return create(GameOccurrenceSchema, {
    id: `${options.providerId}:fixture:${options.providerFixtureId}:event:${options.sequence}`,
    gameId: options.gameId,
    sequence: options.sequence,
    clock,
    kind,
    actors,
    resolutionState: occurrenceResolutionState(actors),
    version: 1,
    revisionState: OccurrenceRevisionState.CURRENT,
    source: providerAttribution(options.providerId),
    recordedAt: create(TimestampSchema, timestampFromMs(options.fetchedAtMs)),
    payload: {
      case: 'timeline',
      value: create(GameTimelinePayloadSchema, {
        headline: event.detail || event.type,
        summary: eventSummary(event),
        scoreDelta: isGoalEvent(event) ? 1 : 0,
        sportTimeline: {
          case: 'football',
          value: create(FootballTimelinePayloadSchema, {
            type: timelineType,
            teamId,
            primaryPlayerId,
            secondaryPlayerId,
          }),
        },
      }),
    },
  });
}

function teamSheetFromLineup(
  lineup: ApiFootballLineupResponse,
  options: {
    readonly providerId: string;
    readonly entityResolutions?: ApiFootballEntityResolutionMap;
  }
) {
  const teamSubject = resolvedSubject(
    'team',
    options.providerId,
    String(lineup.team.id),
    SubjectType.TEAM,
    lineup.team.name,
    options.entityResolutions
  );
  const teamId =
    teamSubject.subject?.id ?? providerStorageId(options.providerId, 'team', lineup.team.id);

  return create(FootballTeamSheetSchema, {
    teamId,
    formation: lineup.formation,
    players: [
      ...lineup.startXI.map((entry, index) =>
        lineupsPlayer(entry, {
          providerId: options.providerId,
          entityResolutions: options.entityResolutions,
          isStarter: true,
          fallbackSlot: index + 1,
        })
      ),
      ...lineup.substitutes.map((entry, index) =>
        lineupsPlayer(entry, {
          providerId: options.providerId,
          entityResolutions: options.entityResolutions,
          isStarter: false,
          fallbackSlot: lineup.startXI.length + index + 1,
        })
      ),
    ],
  });
}

function squadListTeamFromSquad(
  squad: ApiFootballSquadResponse,
  options: {
    readonly providerId: string;
    readonly entityResolutions?: ApiFootballEntityResolutionMap;
  }
) {
  const providerTeamId = String(squad.team.id);
  const resolved = resolvedEntity(
    'team',
    providerTeamId,
    squad.team.name,
    options.entityResolutions
  );
  return create(FootballSquadListTeamSchema, {
    teamId: resolved?.entityId ?? providerStorageId(options.providerId, 'team', providerTeamId),
    teamName: resolved?.label ?? squad.team.name,
    logoUrl: stringOrEmpty(squad.team.logo),
    providerTeamId,
    players: squad.players.map((entry) =>
      squadListPlayer(entry, {
        providerId: options.providerId,
        entityResolutions: options.entityResolutions,
      })
    ),
  });
}

function squadListPlayer(
  entry: ApiFootballSquadPlayer,
  options: {
    readonly providerId: string;
    readonly entityResolutions?: ApiFootballEntityResolutionMap;
  }
) {
  const providerPlayerId = String(entry.id);
  const resolved = resolvedEntity(
    'player',
    providerPlayerId,
    entry.name,
    options.entityResolutions
  );
  return create(FootballSquadListPlayerSchema, {
    playerId:
      resolved?.entityId ?? providerStorageId(options.providerId, 'player', providerPlayerId),
    playerName: resolved?.label ?? entry.name,
    shirtNumber: nullableNumber(entry.number) ?? 0,
    positionCode: entry.position ?? '',
    age: nullableNumber(entry.age) ?? 0,
    photoUrl: stringOrEmpty(entry.photo),
    providerPlayerId,
  });
}

function lineupsPlayer(
  entry: ApiFootballLineupResponse['startXI'][number],
  options: {
    readonly providerId: string;
    readonly entityResolutions?: ApiFootballEntityResolutionMap;
    readonly isStarter: boolean;
    readonly fallbackSlot: number;
  }
) {
  const providerPlayerId = String(entry.player.id);
  const resolved = resolvedEntity(
    'player',
    providerPlayerId,
    entry.player.name,
    options.entityResolutions
  );
  return create(FootballTeamSheetPlayerSchema, {
    playerId:
      resolved?.entityId ?? providerStorageId(options.providerId, 'player', providerPlayerId),
    playerName: resolved?.label ?? entry.player.name,
    shirtNumber: nullableNumber(entry.player.number) ?? 0,
    positionCode: entry.player.pos ?? '',
    formationSlot: formationSlot(entry.player.grid, options.fallbackSlot),
    isStarter: options.isStarter,
    isCaptain: false,
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
        resolutionRef: entityResolutionRef(
          API_FOOTBALL_PROVIDER_ID,
          '42',
          'team',
          SubjectType.TEAM,
          'Arsenal F.C.',
          { entityId: API_FOOTBALL_REPLAY_HOME_TEAM_ID, label: 'Arsenal F.C.' }
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
        resolutionRef: entityResolutionRef(
          API_FOOTBALL_PROVIDER_ID,
          '49',
          'team',
          SubjectType.TEAM,
          'Chelsea F.C.',
          { entityId: API_FOOTBALL_REPLAY_AWAY_TEAM_ID, label: 'Chelsea F.C.' }
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
    resolutionRef: entityResolutionRef(
      API_FOOTBALL_PROVIDER_ID,
      providerGameIdFromFixture(fixture),
      'fixture',
      SubjectType.GAME,
      'Arsenal v Chelsea',
      { entityId: API_FOOTBALL_REPLAY_GAME_ID, label: 'Arsenal v Chelsea' }
    ),
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

function providerAttribution(providerId: string) {
  if (providerId === API_FOOTBALL_PROVIDER_ID) {
    return provider;
  }
  return create(ProviderAttributionSchema, {
    provider: providerId,
    name: providerId,
    commercialUseAllowed: true,
    attributionText: `Data from ${providerId}`,
  });
}

function subject(id: string, type: SubjectType, label: string, slug: string, imageUrl = '') {
  return create(SubjectRefSchema, {
    id,
    type,
    sport: Sport.FOOTBALL,
    label,
    slug,
    imageUrl,
  });
}

function resolvedSubject(
  kind: ApiFootballEntityKind,
  providerId: string,
  providerIdValue: string,
  entityType: SubjectType,
  displayLabel: string,
  resolutions: ApiFootballEntityResolutionMap | undefined,
  providerSnapshot?: ReturnType<typeof providerEntitySnapshot>
) {
  const resolved = resolvedEntity(kind, providerIdValue, displayLabel, resolutions);
  const providerResourceType = providerResourceTypeFor(kind);
  const resolutionRef = entityResolutionRef(
    providerId,
    providerIdValue,
    providerResourceType,
    entityType,
    resolved?.label ?? displayLabel,
    resolved,
    providerSnapshot
  );
  return {
    subject: resolved
      ? subject(
          resolved.entityId,
          entityType,
          resolved.label ?? displayLabel,
          resolved.slug ?? slugify(resolved.label ?? displayLabel),
          providerSnapshot?.imageUrl
        )
      : undefined,
    resolutionRef,
  };
}

function resolvedEntity(
  kind: ApiFootballEntityKind,
  providerIdValue: string,
  displayLabel: string,
  resolutions: ApiFootballEntityResolutionMap | undefined
): ApiFootballResolvedEntity | undefined {
  const bucket = resolutionBucket(kind, resolutions);
  const resolved = bucket?.[providerIdValue];
  if (!resolved?.entityId) {
    return undefined;
  }
  return {
    entityId: resolved.entityId,
    label: resolved.label ?? displayLabel,
    slug: resolved.slug,
  };
}

function resolutionBucket(
  kind: ApiFootballEntityKind,
  resolutions: ApiFootballEntityResolutionMap | undefined
) {
  switch (kind) {
    case 'competition':
      return resolutions?.competitions;
    case 'season':
      return resolutions?.seasons;
    case 'team':
      return resolutions?.teams;
    case 'player':
      return resolutions?.players;
  }
}

function entityResolutionRef(
  providerId: string,
  providerIdValue: string,
  providerResourceType: string,
  entityType: SubjectType,
  displayLabel: string,
  resolved: ApiFootballResolvedEntity | undefined,
  providerSnapshot?: ReturnType<typeof providerEntitySnapshot>
) {
  return create(EntityResolutionRefSchema, {
    entityId: resolved?.entityId ?? '',
    entityType,
    state: resolved ? ResolutionState.RESOLVED : ResolutionState.UNRESOLVED_PROVIDER_REF,
    providerRef: create(ProviderRefSchema, {
      provider: providerId,
      providerId: providerIdValue,
      providerResourceType,
    }),
    displayLabel: resolved?.label ?? displayLabel,
    providerSnapshot,
  });
}

function competitionSnapshot(league: ApiFootballLeagueRef) {
  return providerEntitySnapshot({
    label: league.name,
    slug: slugify(league.name),
    imageUrl: stringOrEmpty(league.logo),
    country: stringOrEmpty(league.country),
    attributes: {
      provider_league_id: String(league.id),
      season: String(league.season),
      round: stringOrEmpty(league.round),
      standings: league.standings === undefined ? '' : String(league.standings),
    },
  });
}

function seasonSnapshot(league: ApiFootballLeagueRef) {
  return providerEntitySnapshot({
    label: `${league.season} ${league.name}`,
    slug: slugify(`${league.season} ${league.name}`),
    imageUrl: stringOrEmpty(league.logo),
    country: stringOrEmpty(league.country),
    attributes: {
      provider_league_id: String(league.id),
      season: String(league.season),
      round: stringOrEmpty(league.round),
    },
  });
}

function teamSnapshot(team: ApiFootballTeamRef) {
  return providerEntitySnapshot({
    label: team.name,
    slug: slugify(team.name),
    imageUrl: stringOrEmpty(team.logo),
    country: stringOrEmpty(team.country),
    shortName: stringOrEmpty(team.code),
    attributes: {
      provider_team_id: String(team.id),
      winner: team.winner === undefined || team.winner === null ? '' : String(team.winner),
    },
  });
}

function providerEntitySnapshot(input: {
  readonly label?: string;
  readonly slug?: string;
  readonly imageUrl?: string;
  readonly country?: string;
  readonly shortName?: string;
  readonly providerUrl?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}) {
  const attributes = Object.fromEntries(
    Object.entries(input.attributes ?? {}).filter(([, value]) => value.trim() !== '')
  );
  const hasValue =
    stringOrEmpty(input.label) !== '' ||
    stringOrEmpty(input.slug) !== '' ||
    stringOrEmpty(input.imageUrl) !== '' ||
    stringOrEmpty(input.country) !== '' ||
    stringOrEmpty(input.shortName) !== '' ||
    stringOrEmpty(input.providerUrl) !== '' ||
    Object.keys(attributes).length > 0;
  if (!hasValue) {
    return undefined;
  }
  return create(ProviderEntitySnapshotSchema, {
    label: stringOrEmpty(input.label),
    slug: stringOrEmpty(input.slug),
    imageUrl: stringOrEmpty(input.imageUrl),
    country: stringOrEmpty(input.country),
    shortName: stringOrEmpty(input.shortName),
    providerUrl: stringOrEmpty(input.providerUrl),
    attributes,
  });
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function actorFromProviderRef(
  kind: ApiFootballEntityKind,
  providerId: string,
  ref: ApiFootballTeamRef | null | undefined,
  entityType: SubjectType,
  resolutions: ApiFootballEntityResolutionMap | undefined
) {
  if (!ref || !Number.isFinite(ref.id) || ref.id === 0) {
    return undefined;
  }
  return entityResolutionRef(
    providerId,
    String(ref.id),
    providerResourceTypeFor(kind),
    entityType,
    ref.name,
    resolvedEntity(kind, String(ref.id), ref.name, resolutions),
    kind === 'team' ? teamSnapshot(ref) : providerEntitySnapshot({ label: ref.name })
  );
}

function actorEntityId(actor: ReturnType<typeof actorFromProviderRef> | undefined): string {
  return actor?.state === ResolutionState.RESOLVED ? actor.entityId : '';
}

function providerResourceTypeFor(kind: ApiFootballEntityKind): string {
  switch (kind) {
    case 'competition':
      return 'competition';
    case 'season':
      return 'season';
    case 'team':
      return 'team';
    case 'player':
      return 'player';
  }
}

function providerStorageId(
  providerId: string,
  resourceType: string,
  providerIdValue: unknown
): string {
  return `provider:${providerId}:${resourceType}:${String(providerIdValue).trim()}`;
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

function clockFromEventTime(time: ApiFootballEventResponse['time']) {
  const elapsed = nullableNumber(time.elapsed) ?? 0;
  const stoppage = nullableNumber(time.extra) ?? 0;
  const display = stoppage > 0 ? `${elapsed}+${stoppage}'` : `${elapsed}'`;
  return create(GameClockSchema, {
    display,
    period: footballPeriodFromMinute(elapsed),
    elapsedSeconds: (elapsed + stoppage) * 60,
    running: false,
    sportClock: {
      case: 'football',
      value: create(FootballClockPayloadSchema, {
        period: footballPeriodFromMinute(elapsed),
        minute: elapsed,
        stoppageMinute: stoppage,
      }),
    },
  });
}

function footballPeriodFromMinute(minute: number): FootballPeriod {
  if (minute <= 45) {
    return FootballPeriod.FIRST_HALF;
  }
  if (minute <= 90) {
    return FootballPeriod.SECOND_HALF;
  }
  return FootballPeriod.EXTRA_TIME_FIRST;
}

function occurrenceKindFromApiFootball(type: string, detail: string): GameOccurrenceKind {
  const normalisedType = type.trim().toLowerCase();
  if (normalisedType === 'goal') {
    return GameOccurrenceKind.SCORE_CHANGE;
  }
  if (normalisedType === 'card') {
    return GameOccurrenceKind.DISCIPLINARY;
  }
  if (normalisedType === 'subst') {
    return GameOccurrenceKind.SUBSTITUTION;
  }
  if (detail.trim().toLowerCase().includes('var')) {
    return GameOccurrenceKind.MOMENT;
  }
  return GameOccurrenceKind.MOMENT;
}

function footballTimelineTypeFromApiFootball(
  type: string,
  detail: string
): FootballTimelineEventType {
  const normalisedType = type.trim().toLowerCase();
  const normalisedDetail = detail.trim().toLowerCase();
  if (normalisedType === 'goal') {
    if (normalisedDetail.includes('own')) {
      return FootballTimelineEventType.OWN_GOAL;
    }
    if (normalisedDetail.includes('penalty')) {
      return normalisedDetail.includes('miss')
        ? FootballTimelineEventType.PENALTY_MISSED
        : FootballTimelineEventType.PENALTY_SCORED;
    }
    return FootballTimelineEventType.GOAL;
  }
  if (normalisedType === 'card') {
    if (normalisedDetail.includes('second')) {
      return FootballTimelineEventType.SECOND_YELLOW_CARD;
    }
    if (normalisedDetail.includes('red')) {
      return FootballTimelineEventType.RED_CARD;
    }
    return FootballTimelineEventType.YELLOW_CARD;
  }
  if (normalisedType === 'subst') {
    return FootballTimelineEventType.SUBSTITUTION;
  }
  if (normalisedType === 'var' || normalisedDetail.includes('var')) {
    return FootballTimelineEventType.VAR;
  }
  return FootballTimelineEventType.UNSPECIFIED;
}

function occurrenceResolutionState(
  actors: readonly ReturnType<typeof actorFromProviderRef>[]
): ResolutionState {
  if (actors.length === 0) {
    return ResolutionState.UNRESOLVED_PROVIDER_REF;
  }
  const resolved = actors.filter((actor) => actor?.state === ResolutionState.RESOLVED).length;
  if (resolved === actors.length) {
    return ResolutionState.RESOLVED;
  }
  return resolved > 0 ? ResolutionState.PARTIAL : ResolutionState.UNRESOLVED_PROVIDER_REF;
}

function eventSummary(event: ApiFootballEventResponse): string {
  const parts = [event.player?.name, event.team.name, event.comments].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== ''
  );
  return parts.join(' | ');
}

function isGoalEvent(event: ApiFootballEventResponse): boolean {
  return event.type.trim().toLowerCase() === 'goal' && !event.detail.toLowerCase().includes('miss');
}

function formationSlot(grid: string | null | undefined, fallbackSlot: number): number {
  if (!grid) {
    return fallbackSlot;
  }
  const parts = grid.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) {
    return fallbackSlot;
  }
  const [row = 0, column = 0] = parts;
  return row * 10 + column;
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
