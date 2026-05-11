import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import { Sport, SubjectRefSchema, SubjectType } from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  GameService,
  GetLeaderboardRequestSchema,
  IngestBatchResponseSchema,
  IngestFootballLineupsRequestSchema,
  IngestFootballStandingsRequestSchema,
  IngestGameOccurrencesRequestSchema,
  IngestGamesRequestSchema,
  IngestMetadataSchema,
  ListProviderConfigsRequestSchema,
  ProviderConfigSchema,
  ProviderHealthSchema,
  ReportProviderHealthRequestSchema,
  SubmitPredictionRequestSchema,
  SubmitRatingRequestSchema,
  SyncFixturesRequestSchema,
  UnmappedIdentityCandidateSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  LeaderboardEntrySchema,
  LeaderboardPeriodType,
  LeaderboardSchema,
  PredictionSchema,
  PredictionSettlementBreakdownSchema,
  PredictionSettlementSchema,
  PredictionState,
  RatingScale,
  RatingScopeType,
  RatingSubjectSchema,
  RatingSubjectType,
  ScoringRubricSchema,
  SettlementState,
} from '@breakingthelines/protos/btl/game/v1/types/engagement_pb';
import {
  FallbackReason,
  GameOccurrenceKind,
  GameOccurrenceSchema,
  GameParticipantRole,
  GameParticipantSchema,
  GameSchema,
  GameStatus,
  ProviderAttributionSchema,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import {
  FootballLineupsSchema,
  FootballStandingEntrySchema,
  FootballStandingsSchema,
  FootballTeamSheetPlayerSchema,
  FootballTeamSheetSchema,
} from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  IdentityService,
  LookupRequestSchema,
  ResolveRequestSchema,
  SearchRequestSchema,
  StatsRequestSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

const provider = create(ProviderAttributionSchema, {
  provider: 'api-football',
  name: 'API-Football',
  license: 'commercial',
  attributionText: 'Data from API-Football',
});

const teamSubject = (id: string, label: string) =>
  create(SubjectRefSchema, {
    id,
    type: SubjectType.TEAM,
    sport: Sport.FOOTBALL,
    label,
  });

describe('published Track E proto handoff', () => {
  it('exposes the gamewire-worker ingest and provider config surface from GameService', () => {
    const methods = GameService.method;

    expect(methods.ingestGames.input.typeName).toBe('btl.game.v1.IngestGamesRequest');
    expect(methods.ingestFootballLineups.input.typeName).toBe(
      'btl.game.v1.IngestFootballLineupsRequest'
    );
    expect(methods.ingestFootballStandings.input.typeName).toBe(
      'btl.game.v1.IngestFootballStandingsRequest'
    );
    expect(methods.ingestGameOccurrences.input.typeName).toBe(
      'btl.game.v1.IngestGameOccurrencesRequest'
    );
    expect(methods.listProviderConfigs.input.typeName).toBe(
      'btl.game.v1.ListProviderConfigsRequest'
    );
    expect(methods.reportProviderHealth.input.typeName).toBe(
      'btl.game.v1.ReportProviderHealthRequest'
    );

    const homeTeam = teamSubject('btl_football_team_home', 'Home FC');
    const awayTeam = teamSubject('btl_football_team_away', 'Away FC');
    const metadata = create(IngestMetadataSchema, {
      provider: provider.provider,
      replayId: 'fixture-sync-2026-05-06',
      idempotencyKey: 'api-football:fixtures:2026-05-06',
    });

    const game = create(GameSchema, {
      id: 'btl_football_game_001',
      slug: 'home-fc-v-away-fc-2026-05-06',
      participants: [
        create(GameParticipantSchema, { subject: homeTeam, role: GameParticipantRole.HOME }),
        create(GameParticipantSchema, { subject: awayTeam, role: GameParticipantRole.AWAY }),
      ],
      status: GameStatus.SCHEDULED,
      hasLineups: false,
      hasTimeline: false,
      fallbackReasons: [FallbackReason.LINEUPS_MISSING, FallbackReason.TIMELINE_MISSING],
      provenance: [],
      sportPayload: { case: 'football', value: { matchday: 1, stage: 'regular' } },
    });

    const ingestGames = create(IngestGamesRequestSchema, {
      metadata,
      games: [game],
    });
    const lineups = create(FootballLineupsSchema, {
      gameId: game.id,
      teamSheets: [
        create(FootballTeamSheetSchema, {
          teamId: homeTeam.id,
          formation: '4-3-3',
          players: [
            create(FootballTeamSheetPlayerSchema, {
              playerId: 'btl_football_player_home_10',
              playerName: 'Home Playmaker',
              shirtNumber: 10,
              positionCode: 'AM',
              formationSlot: 8,
              isStarter: true,
              isCaptain: true,
            }),
          ],
        }),
      ],
    });
    const standings = create(FootballStandingsSchema, {
      competitionId: 'btl_football_competition_launch_league',
      seasonId: 'btl_football_season_2026',
      entries: [
        create(FootballStandingEntrySchema, {
          teamId: homeTeam.id,
          teamName: homeTeam.label,
          rank: 1,
          played: 10,
          won: 7,
          drawn: 2,
          lost: 1,
          goalsFor: 22,
          goalsAgainst: 9,
          goalDifference: 13,
          points: 23,
        }),
      ],
    });
    const ingestLineups = create(IngestFootballLineupsRequestSchema, {
      metadata,
      lineups: [lineups],
    });
    const ingestStandings = create(IngestFootballStandingsRequestSchema, {
      metadata,
      standings: [standings],
    });
    const occurrence = create(GameOccurrenceSchema, {
      id: 'api-football:event:1',
      gameId: game.id,
      sequence: 1,
      kind: GameOccurrenceKind.ACTION,
      source: provider,
    });
    const ingestOccurrences = create(IngestGameOccurrencesRequestSchema, {
      metadata,
      gameId: game.id,
      occurrences: [occurrence],
    });
    const providerConfigRequest = create(ListProviderConfigsRequestSchema, {
      kind: 'fixture',
      includeDisabled: true,
    });
    const providerConfig = create(ProviderConfigSchema, {
      id: provider.provider,
      name: provider.name,
      kind: 'fixture',
      enabled: true,
      tierPriority: { game: 1, lineup: 1, standings: 1 },
      attribution: provider,
    });
    const providerHealth = create(ProviderHealthSchema, {
      providerId: providerConfig.id,
      consecutiveFailures: 0,
      isCircuitOpen: false,
    });
    const providerHealthReport = create(ReportProviderHealthRequestSchema, {
      health: providerHealth,
    });
    const syncFixtures = create(SyncFixturesRequestSchema, {
      provider: providerConfig.id,
      replayId: metadata.replayId,
    });
    const unmappedIdentityCandidate = create(UnmappedIdentityCandidateSchema, {
      provider: providerConfig.id,
      providerId: 'api_player_999',
      entityType: SubjectType.PLAYER,
      displayName: 'Unmapped Trialist',
      raw: { team: homeTeam.label },
    });
    const ingestResponse = create(IngestBatchResponseSchema, {
      acceptedCount: 3,
      updatedCount: 2,
      skippedCount: 1,
      conflictCount: 1,
      unmappedIdentityCount: 1,
      unmappedIdentityCandidates: [unmappedIdentityCandidate],
      replayId: metadata.replayId,
    });

    expect(ingestGames.games[0]?.id).toBe('btl_football_game_001');
    expect(ingestLineups.lineups[0]?.teamSheets[0]?.players[0]?.positionCode).toBe('AM');
    expect(ingestStandings.standings[0]?.entries[0]?.points).toBe(23);
    expect(ingestOccurrences.occurrences[0]?.kind).toBe(GameOccurrenceKind.ACTION);
    expect(providerConfig.attribution?.provider).toBe('api-football');
    expect(providerConfigRequest.includeDisabled).toBe(true);
    expect(providerHealthReport.health?.providerId).toBe('api-football');
    expect(syncFixtures.replayId).toBe(metadata.replayId);
    expect(ingestResponse.conflictCount).toBe(1);
    expect(ingestResponse.unmappedIdentityCandidates[0]?.entityType).toBe(SubjectType.PLAYER);
  });

  it('exposes identity lookup RPCs needed by gamewire-worker and browsers', () => {
    const methods = IdentityService.method;

    expect(methods.lookup.input.typeName).toBe('btl.identity.v1.LookupRequest');
    expect(methods.resolve.input.typeName).toBe('btl.identity.v1.ResolveRequest');
    expect(methods.search.input.typeName).toBe('btl.identity.v1.SearchRequest');
    expect(methods.stats.input.typeName).toBe('btl.identity.v1.StatsRequest');

    const lookup = create(LookupRequestSchema, {
      id: 'btl_football_team_arsenal',
      entityType: EntityType.TEAM,
    });
    const resolve = create(ResolveRequestSchema, {
      entityType: EntityType.PLAYER,
      provider: 'api-football',
      providerId: '12345',
    });
    const search = create(SearchRequestSchema, {
      query: 'saka',
      entityType: EntityType.PLAYER,
      limit: 5,
    });
    const stats = create(StatsRequestSchema, { sport: 'football' });

    expect(lookup.entityType).toBe(EntityType.TEAM);
    expect(resolve.provider).toBe('api-football');
    expect(search.limit).toBe(5);
    expect(stats.sport).toBe('football');
  });

  it('exposes prediction, rating, and leaderboard contract types for GPL consumers', () => {
    expect(GameService.method.submitPrediction.input.typeName).toBe(
      'btl.game.v1.SubmitPredictionRequest'
    );
    expect(GameService.method.submitRating.input.typeName).toBe('btl.game.v1.SubmitRatingRequest');
    expect(GameService.method.getLeaderboard.input.typeName).toBe(
      'btl.game.v1.GetLeaderboardRequest'
    );

    const gameSubject = create(RatingSubjectSchema, {
      type: RatingSubjectType.GAME,
      gameId: 'btl_football_game_001',
      subject: create(SubjectRefSchema, {
        id: 'btl_football_game_001',
        type: SubjectType.GAME,
        sport: Sport.FOOTBALL,
      }),
    });
    const rating = create(SubmitRatingRequestSchema, {
      userId: 'user_123',
      subject: gameSubject,
      scopeType: RatingScopeType.GLOBAL,
      scale: RatingScale.ONE_TO_TEN,
      value: 8,
    });
    const prediction = create(SubmitPredictionRequestSchema, {
      userId: 'user_123',
      gameId: 'btl_football_game_001',
      leagueInstanceId: 'cap_prediction_league_001',
      rubricId: 'rubric_standard',
      idempotencyKey: 'user_123:btl_football_game_001:cap_prediction_league_001',
    });
    const leaderboard = create(GetLeaderboardRequestSchema, {
      leagueInstanceId: 'cap_prediction_league_001',
      periodType: LeaderboardPeriodType.SEASON,
      periodId: 'btl_football_season_2026',
      limit: 20,
    });

    expect(rating.value).toBe(8);
    expect(prediction.leagueInstanceId).toBe('cap_prediction_league_001');
    expect(leaderboard.periodType).toBe(LeaderboardPeriodType.SEASON);
  });

  it('exposes GPL settlement and leaderboard read models for compile-only consumers', () => {
    const rubric = create(ScoringRubricSchema, {
      id: 'rubric_standard',
      name: 'Standard',
      version: 1,
      fields: { exact_score: 5, outcome: 2 },
      isSystem: true,
    });
    const settlementBreakdown = create(PredictionSettlementBreakdownSchema, {
      field: 'outcome',
      points: 2,
      reason: 'correct outcome',
      expected: { home_score: 2, away_score: 1 },
      actual: { home_score: 2, away_score: 0 },
    });
    const prediction = create(PredictionSchema, {
      id: 'prediction_001',
      gameId: 'btl_football_game_001',
      userId: 'user_123',
      leagueInstanceId: 'cap_prediction_league_001',
      rubricId: rubric.id,
      fields: { home_score: 2, away_score: 1 },
      state: PredictionState.SETTLED,
      settledScore: 2,
      breakdown: [settlementBreakdown],
    });
    const settlement = create(PredictionSettlementSchema, {
      id: 'settlement_001',
      gameId: prediction.gameId,
      leagueInstanceId: prediction.leagueInstanceId,
      state: SettlementState.SETTLED,
      predictionsTotal: 1,
      predictionsSettled: 1,
      idempotencyKey: 'settle:btl_football_game_001:cap_prediction_league_001',
    });
    const leaderboardEntry = create(LeaderboardEntrySchema, {
      id: 'leaderboard_entry_001',
      leagueInstanceId: prediction.leagueInstanceId,
      userId: prediction.userId,
      periodType: LeaderboardPeriodType.GAMEWEEK,
      periodId: 'gameweek_001',
      score: prediction.settledScore,
      rank: 1,
      predictionsCount: 1,
      settledCount: 1,
    });
    const leaderboard = create(LeaderboardSchema, {
      leagueInstanceId: prediction.leagueInstanceId,
      periodType: leaderboardEntry.periodType,
      periodId: leaderboardEntry.periodId,
      entries: [leaderboardEntry],
    });

    expect(rubric.isSystem).toBe(true);
    expect(prediction.breakdown[0]?.field).toBe('outcome');
    expect(settlement.state).toBe(SettlementState.SETTLED);
    expect(leaderboard.entries[0]?.rank).toBe(1);
  });
});
