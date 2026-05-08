import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  GameService,
  GetLeaderboardRequestSchema,
  IngestBatchResponseSchema,
  IngestEventsRequestSchema,
  IngestLineupsRequestSchema,
  IngestMatchesRequestSchema,
  IngestMetadataSchema,
  IngestStandingsRequestSchema,
  ListProviderConfigsRequestSchema,
  ProviderConfigSchema,
  ProviderHealthSchema,
  RateRequestSchema,
  ReportProviderHealthRequestSchema,
  SubmitPredictionRequestSchema,
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
  DataSourceSchema,
  EventType,
  FallbackReason,
  MatchEventSchema,
  MatchLineupsSchema,
  MatchSchema,
  MatchStatus,
  StandingEntrySchema,
  StandingsSchema,
  TeamSchema,
  TeamSheetPlayerSchema,
  TeamSheetSchema,
} from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  IdentityService,
  LookupRequestSchema,
  ResolveRequestSchema,
  SearchRequestSchema,
  StatsRequestSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

describe('published Track E proto handoff', () => {
  it('exposes the gamewire-worker ingest and provider config surface from GameService', () => {
    const methods = GameService.method;

    expect(methods.ingestMatches.input.typeName).toBe('btl.game.v1.IngestMatchesRequest');
    expect(methods.ingestLineups.input.typeName).toBe('btl.game.v1.IngestLineupsRequest');
    expect(methods.ingestStandings.input.typeName).toBe('btl.game.v1.IngestStandingsRequest');
    expect(methods.ingestEvents.input.typeName).toBe('btl.game.v1.IngestEventsRequest');
    expect(methods.listProviderConfigs.input.typeName).toBe(
      'btl.game.v1.ListProviderConfigsRequest'
    );
    expect(methods.reportProviderHealth.input.typeName).toBe(
      'btl.game.v1.ReportProviderHealthRequest'
    );

    const source = create(DataSourceSchema, {
      provider: 'sportmonks',
      name: 'Sportmonks',
      license: 'commercial',
      attributionText: 'Data from Sportmonks',
    });
    const homeTeam = create(TeamSchema, { id: 'btl_t_home', name: 'Home FC' });
    const awayTeam = create(TeamSchema, { id: 'btl_t_away', name: 'Away FC' });
    const metadata = create(IngestMetadataSchema, {
      provider: 'sportmonks',
      replayId: 'fixture-sync-2026-05-06',
      idempotencyKey: 'sportmonks:fixtures:2026-05-06',
    });

    const match = create(MatchSchema, {
      id: 'btl_m_matchday_001',
      slug: 'home-fc-v-away-fc-2026-05-06',
      homeTeam,
      awayTeam,
      status: MatchStatus.SCHEDULED,
      hasLineups: false,
      hasEvents: false,
      fallbackReasons: [FallbackReason.LINEUPS_MISSING, FallbackReason.EVENTS_MISSING],
    });

    const ingestMatches = create(IngestMatchesRequestSchema, {
      metadata,
      matches: [match],
    });
    const lineups = create(MatchLineupsSchema, {
      matchId: match.id,
      home: create(TeamSheetSchema, {
        teamId: homeTeam.id,
        formation: '4-3-3',
        players: [
          create(TeamSheetPlayerSchema, {
            playerId: 'btl_p_home_10',
            playerName: 'Home Playmaker',
            shirtNumber: 10,
            positionCode: 'AM',
            formationSlot: 8,
            isStarter: true,
            isCaptain: true,
          }),
        ],
      }),
      away: create(TeamSheetSchema, {
        teamId: awayTeam.id,
        formation: '4-2-3-1',
        players: [
          create(TeamSheetPlayerSchema, {
            playerId: 'btl_p_away_1',
            playerName: 'Away Keeper',
            shirtNumber: 1,
            positionCode: 'GK',
            formationSlot: 1,
            isStarter: true,
          }),
        ],
      }),
      source,
    });
    const standings = create(StandingsSchema, {
      competitionId: 'btl_l_launch_league',
      seasonId: 'btl_s_2026',
      entries: [
        create(StandingEntrySchema, {
          teamId: homeTeam.id,
          teamName: homeTeam.name,
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
      source,
    });
    const ingestLineups = create(IngestLineupsRequestSchema, {
      metadata,
      lineups: [lineups],
    });
    const ingestStandings = create(IngestStandingsRequestSchema, {
      metadata,
      standings: [standings],
    });
    const ingestEvents = create(IngestEventsRequestSchema, {
      metadata,
      matchId: match.id,
      events: [
        create(MatchEventSchema, {
          id: 'sportmonks:event:1',
          type: EventType.SHOT,
          team: homeTeam,
        }),
      ],
    });
    const providerConfigRequest = create(ListProviderConfigsRequestSchema, {
      kind: 'fixture',
      includeDisabled: true,
    });
    const providerConfig = create(ProviderConfigSchema, {
      id: 'sportmonks',
      name: 'Sportmonks',
      kind: 'fixture',
      enabled: true,
      tierPriority: { match: 1, lineup: 1, standings: 1 },
      rateLimitRpm: 120,
      attribution: source,
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
      providerId: 'sm_player_999',
      entityType: 'player',
      displayName: 'Unmapped Trialist',
      raw: { team: homeTeam.name },
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

    expect(ingestMatches.matches[0]?.id).toBe('btl_m_matchday_001');
    expect(ingestLineups.lineups[0]?.home?.players[0]?.positionCode).toBe('AM');
    expect(ingestStandings.standings[0]?.entries[0]?.points).toBe(23);
    expect(ingestEvents.events[0]?.type).toBe(EventType.SHOT);
    expect(source.provider).toBe('sportmonks');
    expect(providerConfigRequest.includeDisabled).toBe(true);
    expect(providerHealthReport.health?.providerId).toBe('sportmonks');
    expect(syncFixtures.replayId).toBe(metadata.replayId);
    expect(ingestResponse.conflictCount).toBe(1);
    expect(ingestResponse.unmappedIdentityCandidates[0]?.displayName).toBe('Unmapped Trialist');
  });

  it('exposes identity lookup RPCs needed by gamewire-worker and browsers', () => {
    const methods = IdentityService.method;

    expect(methods.lookup.input.typeName).toBe('btl.identity.v1.LookupRequest');
    expect(methods.resolve.input.typeName).toBe('btl.identity.v1.ResolveRequest');
    expect(methods.search.input.typeName).toBe('btl.identity.v1.SearchRequest');
    expect(methods.stats.input.typeName).toBe('btl.identity.v1.StatsRequest');

    const lookup = create(LookupRequestSchema, {
      id: 'btl_t_arsenal',
      entityType: EntityType.TEAM,
    });
    const resolve = create(ResolveRequestSchema, {
      entityType: EntityType.PLAYER,
      provider: 'sportmonks',
      providerId: '12345',
    });
    const search = create(SearchRequestSchema, {
      query: 'saka',
      entityType: EntityType.PLAYER,
      limit: 5,
    });
    const stats = create(StatsRequestSchema, { sport: 'football' });

    expect(lookup.entityType).toBe(EntityType.TEAM);
    expect(resolve.provider).toBe('sportmonks');
    expect(search.limit).toBe(5);
    expect(stats.sport).toBe('football');
  });

  it('exposes prediction, rating, and leaderboard contract types for GPL consumers', () => {
    expect(GameService.method.submitPrediction.input.typeName).toBe(
      'btl.game.v1.SubmitPredictionRequest'
    );
    expect(GameService.method.rate.input.typeName).toBe('btl.game.v1.RateRequest');
    expect(GameService.method.getLeaderboard.input.typeName).toBe(
      'btl.game.v1.GetLeaderboardRequest'
    );

    const matchSubject = create(RatingSubjectSchema, {
      type: RatingSubjectType.MATCH,
      id: 'btl_m_matchday_001',
      matchId: 'btl_m_matchday_001',
    });
    const rating = create(RateRequestSchema, {
      userId: 'user_123',
      subject: matchSubject,
      scopeType: RatingScopeType.GLOBAL,
      scale: RatingScale.ONE_TO_TEN,
      value: 8,
    });
    const prediction = create(SubmitPredictionRequestSchema, {
      userId: 'user_123',
      matchId: 'btl_m_matchday_001',
      leagueInstanceId: 'cap_prediction_league_001',
      rubricId: 'rubric_standard',
      idempotencyKey: 'user_123:btl_m_matchday_001:cap_prediction_league_001',
    });
    const leaderboard = create(GetLeaderboardRequestSchema, {
      leagueInstanceId: 'cap_prediction_league_001',
      periodType: LeaderboardPeriodType.SEASON,
      periodId: 'btl_s_2026',
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
      matchId: 'btl_m_matchday_001',
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
      matchId: prediction.matchId,
      leagueInstanceId: prediction.leagueInstanceId,
      state: SettlementState.SETTLED,
      predictionsTotal: 1,
      predictionsSettled: 1,
      idempotencyKey: 'settle:btl_m_matchday_001:cap_prediction_league_001',
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
