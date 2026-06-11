import { toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  IngestPlayerMatchStatsRequestSchema,
  IngestTeamMatchStatsRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { SubjectType } from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  GameParticipantRole,
  GameStatus,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';

import {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_REPLAY_FIXTURE_ID,
  API_FOOTBALL_REPLAY_GAME_ID,
  apiFootballFixturePlayersPath,
  apiFootballFixtureStatisticsPath,
  apiFootballFixtureSyncPaths,
  apiFootballIngestGamesRequestFromFixtures,
  apiFootballIngestLineupsRequestFromLineups,
  apiFootballIngestOccurrencesRequestFromEvents,
  apiFootballIngestPlayerMatchStatsRequestFromPlayers,
  apiFootballIngestSquadListRequestFromSquads,
  apiFootballIngestTeamMatchStatsRequestFromStatistics,
  apiFootballLivePath,
  apiFootballReplayFixturesRequest,
  apiFootballReplayGameRequest,
  apiFootballReplayOccurrencesRequest,
  apiFootballStandingSyncPaths,
  apiFootballSquadPath,
  apiFootballStatusPath,
  providerGameIdFromFixture,
} from './index.js';

describe('API-Football adapter', () => {
  it('defines the beta top-five plus World Cup coverage plan', () => {
    expect(API_FOOTBALL_BETA_COMPETITIONS.map((competition) => competition.label)).toEqual([
      'Premier League',
      'La Liga',
      'Serie A',
      'Bundesliga',
      'Ligue 1',
      'FIFA World Cup',
    ]);
    expect(apiFootballFixtureSyncPaths()).toHaveLength(6);
    expect(apiFootballStandingSyncPaths()).toHaveLength(6);
    expect(apiFootballLivePath()).toBe('/fixtures?live=all');
    expect(apiFootballStatusPath()).toBe('/status');
    expect(apiFootballSquadPath('10379')).toBe('/players/squads?team=10379');
  });

  it('builds canonical replay ingest requests from provider-shaped data', () => {
    const fixtures = apiFootballReplayFixturesRequest({ replayId: 'api-football:test' });
    const occurrences = apiFootballReplayOccurrencesRequest({
      replayId: 'api-football:test',
      gameId: API_FOOTBALL_REPLAY_GAME_ID,
    });

    expect(fixtures.metadata?.provider).toBe('api-football');
    expect(fixtures.games).toHaveLength(1);
    expect(occurrences.metadata?.provider).toBe('api-football');
    expect(occurrences.occurrences[0]?.source?.provider).toBe('api-football');
  });

  it('populates provider_game_id on the emitted Game from the API-Football fixture id', () => {
    // The replay envelope carries fixture id 1917 (Arsenal v Chelsea). The bridge
    // calls LookupGameByFixture(provider="api-football", providerFixtureId=...)
    // and game-service reads from provider_game_mappings, so this field must
    // round-trip as a string equal to the API-Football fixture id.
    const fixtures = apiFootballReplayFixturesRequest({ replayId: 'api-football:test' });
    const emitted = fixtures.games[0];
    expect(emitted?.providerGameId).toBe(String(API_FOOTBALL_REPLAY_FIXTURE_ID));
    expect(emitted?.providerGameId).toBe('1917');

    const replayGame = apiFootballReplayGameRequest({
      replayId: 'api-football:test',
      gameId: API_FOOTBALL_REPLAY_GAME_ID,
    });
    expect(replayGame.games[0]?.providerGameId).toBe('1917');
  });

  it('stringifies numeric fixture ids defensively', () => {
    expect(providerGameIdFromFixture({ id: 1917 })).toBe('1917');
    expect(providerGameIdFromFixture({ id: '1917' })).toBe('1917');
    expect(providerGameIdFromFixture({ id: '  1917  ' })).toBe('1917');
  });

  it('returns empty provider_game_id when the fixture envelope is malformed or missing the id', () => {
    expect(providerGameIdFromFixture(undefined)).toBe('');
    expect(providerGameIdFromFixture(null)).toBe('');
    expect(providerGameIdFromFixture({})).toBe('');
    expect(providerGameIdFromFixture({ id: 0 })).toBe('');
    expect(providerGameIdFromFixture({ id: '' })).toBe('');
    expect(providerGameIdFromFixture({ id: '0' })).toBe('');
    expect(providerGameIdFromFixture({ id: Number.NaN })).toBe('');
    expect(providerGameIdFromFixture({ id: null })).toBe('');
    expect(providerGameIdFromFixture({ id: undefined })).toBe('');
  });

  it('normalizes live API-Football fixture envelopes into ingestable games', () => {
    const request = apiFootballIngestGamesRequestFromFixtures({
      replayId: 'live:fixture-detail-fullTime:1917',
      resourceId: '1917',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      envelope: {
        response: [
          {
            fixture: {
              id: 1917,
              date: '2026-05-11T19:00:00+00:00',
              status: { short: 'FT', elapsed: 90 },
            },
            league: {
              id: 39,
              name: 'Premier League',
              season: 2025,
              round: 'Regular Season - 1',
            },
            teams: {
              home: {
                id: 42,
                name: 'Arsenal',
                code: 'ARS',
                country: 'England',
                logo: 'https://media.api-sports.io/football/teams/42.png',
              },
              away: {
                id: 49,
                name: 'Chelsea',
                code: 'CHE',
                country: 'England',
                logo: 'https://media.api-sports.io/football/teams/49.png',
              },
            },
            goals: { home: 2, away: 1 },
          },
        ],
      },
    });

    expect(request.metadata?.provider).toBe('api-football');
    expect(request.metadata?.rawPayloadRef).toBe('provider://api-football/fixtures/1917');
    expect(request.games).toHaveLength(1);
    expect(request.games[0]?.id).toBe('');
    expect(request.games[0]?.routeId).toBe('');
    expect(request.games[0]?.slug).toBe('');
    expect(request.games[0]?.providerGameId).toBe('1917');
    expect(request.games[0]?.resolutionRef?.providerRef?.providerId).toBe('1917');
    expect(request.games[0]?.participants[0]?.subject).toBeUndefined();
    expect(request.games[0]?.participants[0]?.resolutionRef?.providerRef?.providerId).toBe('42');
    expect(request.games[0]?.participants[0]?.resolutionRef?.providerSnapshot?.imageUrl).toBe(
      'https://media.api-sports.io/football/teams/42.png'
    );
    expect(request.games[0]?.participants[0]?.resolutionRef?.providerSnapshot?.shortName).toBe(
      'ARS'
    );
    expect(request.games[0]?.score?.display).toBe('2-1');
    expect(request.games[0]?.score?.scores[0]?.participantId).toBe('provider:api-football:team:42');
    expect(request.games[0]?.sportPayload.case).toBe('football');
    expect(request.games[0]?.sportPayload.value?.matchday).toBe(1);
  });

  it('uses identity-resolved subjects when supplied and keeps unresolved provider refs honest', () => {
    const request = apiFootballIngestGamesRequestFromFixtures({
      replayId: 'live:fixture-detail-fullTime:1917',
      resourceId: '1917',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      entityResolutions: {
        teams: {
          '42': { entityId: 'btl_football_team_t8596499a', label: 'Arsenal F.C.' },
        },
        competitions: {
          '39': { entityId: 'btl_football_competition_lb3d230cb', label: 'Premier League' },
        },
        seasons: {
          '39:2025': {
            entityId: 'btl_football_season_sdc8762eb',
            label: '2025-26 Premier League',
          },
        },
      },
      envelope: {
        response: [
          {
            fixture: {
              id: 1917,
              date: '2026-05-11T19:00:00+00:00',
              status: { short: 'FT', elapsed: 90 },
            },
            league: {
              id: 39,
              name: 'Premier League',
              season: 2025,
              round: 'Regular Season - 1',
            },
            teams: {
              home: {
                id: 42,
                name: 'Arsenal',
                logo: 'https://media.api-sports.io/football/teams/42.png',
              },
              away: {
                id: 49,
                name: 'Chelsea',
                logo: 'https://media.api-sports.io/football/teams/49.png',
              },
            },
            goals: { home: 2, away: 1 },
          },
        ],
      },
    });

    const game = request.games[0];
    expect(game?.competition?.id).toBe('btl_football_competition_lb3d230cb');
    expect(game?.season?.id).toBe('btl_football_season_sdc8762eb');
    expect(game?.participants[0]?.subject?.id).toBe('btl_football_team_t8596499a');
    expect(game?.participants[0]?.subject?.imageUrl).toBe(
      'https://media.api-sports.io/football/teams/42.png'
    );
    expect(game?.participants[0]?.resolutionRef?.entityId).toBe('btl_football_team_t8596499a');
    expect(game?.participants[0]?.resolutionRef?.providerSnapshot?.imageUrl).toBe(
      'https://media.api-sports.io/football/teams/42.png'
    );
    expect(game?.participants[1]?.subject).toBeUndefined();
    expect(game?.participants[1]?.resolutionRef?.providerRef?.providerId).toBe('49');
    expect(game?.participants[1]?.resolutionRef?.providerSnapshot?.imageUrl).toBe(
      'https://media.api-sports.io/football/teams/49.png'
    );
  });

  it('falls back to provider-scoped competition + season subjects when identity misses (WC26 case)', () => {
    // Mirrors the live World Cup 2026 ingest on staging: identity has no
    // canonical mapping for league 1 yet, so the bridge supplies no
    // resolutions. The competition + season subjects must still carry a
    // provider-scoped SubjectRef id so game-service populates
    // games.competition_id / season_id (the predict screen filters on
    // competition_id). A later identity backfill re-binds the sentinel to a
    // canonical btl_football_* id on the next ingest.
    const request = apiFootballIngestGamesRequestFromFixtures({
      replayId: 'live:fixtures-next-7d:league-1-season-2026',
      resourceId: 'league-1-season-2026',
      fetchedAtMs: Date.parse('2026-06-05T02:00:00Z'),
      // No entityResolutions — full identity miss.
      envelope: {
        response: [
          {
            fixture: {
              id: 1489369,
              date: '2026-06-11T19:00:00+00:00',
              status: { short: 'NS' },
            },
            league: { id: 1, name: 'World Cup', season: 2026, round: 'Group Stage - 1' },
            teams: {
              home: { id: 16, name: 'Mexico' },
              away: { id: 1531, name: 'South Africa' },
            },
            goals: { home: null, away: null },
          },
        ],
      },
    });

    const game = request.games[0];
    // Provider-scoped sentinel ids — not empty, not canonical yet.
    expect(game?.competition?.id).toBe('provider:api-football:competition:1');
    expect(game?.season?.id).toBe('provider:api-football:season:1:2026');
    // The resolution ref still carries the raw provider id for later rebind.
    expect(game?.competition?.type).toBe(SubjectType.COMPETITION);
    expect(game?.status).toBe(GameStatus.SCHEDULED);
    // No score for an upcoming fixture (goals were null).
    expect(game?.score).toBeUndefined();
  });

  it('maps fixture.venue to Game.venue (the SubjectRef the platform header renders)', () => {
    // Crystal Palace v Arsenal at Selhurst Park — the platform header reads
    // venueLabel(game) off game.venue.label, so the stadium name must survive
    // the mapping with type VENUE. The id mirrors the provider-scoped fallback
    // scheme (provider:<provider>:venue:<id>) since venues have no canonical
    // identity path in this adapter.
    const request = apiFootballIngestGamesRequestFromFixtures({
      replayId: 'live:fixture-detail:1208021',
      resourceId: '1208021',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      envelope: {
        response: [
          {
            fixture: {
              id: 1208021,
              date: '2026-05-11T19:00:00+00:00',
              status: { short: 'NS' },
              venue: { id: 525, name: 'Selhurst Park', city: 'London' },
            },
            league: { id: 39, name: 'Premier League', season: 2025, round: 'Regular Season - 1' },
            teams: {
              home: { id: 52, name: 'Crystal Palace' },
              away: { id: 42, name: 'Arsenal' },
            },
            goals: { home: null, away: null },
          },
        ],
      },
    });

    const game = request.games[0];
    expect(game?.venue?.label).toBe('Selhurst Park');
    expect(game?.venue?.type).toBe(SubjectType.VENUE);
    expect(game?.venue?.id).toBe('provider:api-football:venue:525');
    expect(game?.venue?.slug).toBe('selhurst-park');
  });

  it('emits a label-only Game.venue when the provider supplies no stadium id', () => {
    const request = apiFootballIngestGamesRequestFromFixtures({
      replayId: 'live:fixture-detail:1208022',
      resourceId: '1208022',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      envelope: {
        response: [
          {
            fixture: {
              id: 1208022,
              date: '2026-05-11T19:00:00+00:00',
              status: { short: 'NS' },
              venue: { id: null, name: 'Wembley Stadium', city: null },
            },
            league: { id: 39, name: 'Premier League', season: 2025, round: 'Regular Season - 1' },
            teams: {
              home: { id: 33, name: 'Manchester United' },
              away: { id: 40, name: 'Liverpool' },
            },
            goals: { home: null, away: null },
          },
        ],
      },
    });

    const game = request.games[0];
    expect(game?.venue?.label).toBe('Wembley Stadium');
    expect(game?.venue?.type).toBe(SubjectType.VENUE);
    expect(game?.venue?.id).toBe('');
  });

  it('omits Game.venue when the provider attached no venue name', () => {
    const request = apiFootballIngestGamesRequestFromFixtures({
      replayId: 'live:fixture-detail:1208023',
      resourceId: '1208023',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      envelope: {
        response: [
          {
            fixture: {
              id: 1208023,
              date: '2026-05-11T19:00:00+00:00',
              status: { short: 'NS' },
              venue: { id: null, name: null, city: null },
            },
            league: { id: 39, name: 'Premier League', season: 2025, round: 'Regular Season - 1' },
            teams: {
              home: { id: 47, name: 'Tottenham' },
              away: { id: 50, name: 'Manchester City' },
            },
            goals: { home: null, away: null },
          },
        ],
      },
    });

    expect(request.games[0]?.venue).toBeUndefined();
  });

  it('normalizes API-Football fixture events into timeline occurrences', () => {
    const request = apiFootballIngestOccurrencesRequestFromEvents({
      replayId: 'live:events-post-final:1538961',
      resourceId: '1538961',
      gameId: 'btl_football_game_g1538961',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      envelope: {
        response: [
          {
            time: { elapsed: 45, extra: 2 },
            team: { id: 49, name: 'Chelsea' },
            player: { id: 152982, name: 'Cole Palmer' },
            assist: { id: 1460, name: 'Bukayo Saka' },
            type: 'Goal',
            detail: 'Normal Goal',
            comments: null,
          },
        ],
      },
    });

    expect(request.metadata?.rawPayloadRef).toBe('provider://api-football/fixtures/events/1538961');
    expect(request.gameId).toBe('btl_football_game_g1538961');
    expect(request.occurrences).toHaveLength(1);
    expect(request.occurrences[0]?.clock?.display).toBe("45+2'");
    expect(request.occurrences[0]?.payload.case).toBe('timeline');
    expect(request.occurrences[0]?.actors[0]?.providerRef?.providerResourceType).toBe('team');
    expect(request.occurrences[0]?.actors[1]?.providerRef?.providerResourceType).toBe('player');
  });

  it('normalizes API-Football lineups and leaves fixture 1538961 lineups missing when empty', () => {
    const empty = apiFootballIngestLineupsRequestFromLineups({
      replayId: 'live:lineups-post-confirm:1538961',
      resourceId: '1538961',
      gameId: 'btl_football_game_g1538961',
      envelope: { response: [] },
    });
    expect(empty.lineups).toHaveLength(0);

    const request = apiFootballIngestLineupsRequestFromLineups({
      replayId: 'live:lineups-post-confirm:1917',
      resourceId: '1917',
      gameId: 'btl_football_game_g1917',
      envelope: {
        response: [
          {
            team: {
              id: 42,
              name: 'Arsenal',
              colors: {
                player: { primary: 'e10000', number: 'ffffff', border: 'e10000' },
                goalkeeper: { primary: 'ffd700', number: '000000', border: 'ffd700' },
              },
            },
            formation: '4-3-3',
            startXI: [
              {
                player: {
                  id: 1460,
                  name: 'Bukayo Saka',
                  number: 7,
                  pos: 'RW',
                  grid: '3:3',
                },
              },
            ],
            substitutes: [],
          },
        ],
      },
    });

    expect(request.lineups).toHaveLength(1);
    expect(request.lineups[0]?.teamSheets[0]?.teamId).toBe('provider:api-football:team:42');
    expect(request.lineups[0]?.teamSheets[0]?.players[0]?.playerId).toBe(
      'provider:api-football:player:1460'
    );
  });

  it('normalizes API-Football squad lists as a distinct lineup fallback', () => {
    const request = apiFootballIngestSquadListRequestFromSquads({
      replayId: 'live:squad-list-fallback:1538961:10379',
      resourceId: '1538961:10379',
      gameId: 'btl_football_game_g1538961',
      entityResolutions: {
        teams: {
          '10379': { entityId: 'btl_football_team_t10379', label: 'San Marino U19' },
        },
      },
      envelope: {
        response: [
          {
            team: {
              id: 10379,
              name: 'San Marino U19',
              logo: 'https://media.api-sports.io/football/teams/10379.png',
            },
            players: [
              {
                id: 123,
                name: 'Registered Player',
                age: 18,
                number: 7,
                position: 'Attacker',
                photo: 'https://media.api-sports.io/football/players/123.png',
              },
            ],
          },
        ],
      },
    });

    expect(request.metadata?.rawPayloadRef).toBe(
      'provider://api-football/players/squads/1538961:10379'
    );
    expect(request.squadLists).toHaveLength(1);
    expect(request.squadLists[0]?.gameId).toBe('btl_football_game_g1538961');
    expect(request.squadLists[0]?.teams[0]?.teamId).toBe('btl_football_team_t10379');
    expect(request.squadLists[0]?.teams[0]?.providerTeamId).toBe('10379');
    expect(request.squadLists[0]?.teams[0]?.players[0]?.playerId).toBe(
      'provider:api-football:player:123'
    );
    expect(request.squadLists[0]?.teams[0]?.players[0]?.positionCode).toBe('Attacker');
  });
});

describe('API-Football match-stats mapping', () => {
  const teamStatisticsEnvelope = () => ({
    response: [
      {
        team: {
          id: 42,
          name: 'Arsenal',
          logo: 'https://media.api-sports.io/football/teams/42.png',
        },
        statistics: [
          { type: 'Shots on Goal', value: 7 },
          { type: 'Shots off Goal', value: 4 },
          { type: 'Total Shots', value: 14 },
          { type: 'Blocked Shots', value: 3 },
          { type: 'Fouls', value: 9 },
          { type: 'Corner Kicks', value: 6 },
          { type: 'Offsides', value: 2 },
          { type: 'Ball Possession', value: '58%' },
          { type: 'Yellow Cards', value: 1 },
          // Red Cards present but zero — must still emit a provenance entry so
          // a real 0 is distinguishable from "not reported".
          { type: 'Red Cards', value: 0 },
          { type: 'Goalkeeper Saves', value: 4 },
          { type: 'Total passes', value: 520 },
          { type: 'Passes accurate', value: 470 },
          { type: 'Passes %', value: '90%' },
          { type: 'expected_goals', value: '1.84' },
          // Unknown metric — preserved in extra_stats, not dropped.
          { type: 'Goals Prevented', value: 0.4 },
          // Genuinely not-reported metric — null leaves no field + no provenance.
          { type: 'Passes Through', value: null },
        ],
      },
      {
        team: { id: 49, name: 'Chelsea' },
        statistics: [{ type: 'Ball Possession', value: '42%' }],
      },
    ],
  });

  it('maps /fixtures/statistics into canonical TeamMatchStats with resolved ids + roles', () => {
    const request = apiFootballIngestTeamMatchStatsRequestFromStatistics({
      replayId: 'live:team-match-stats:1917',
      resourceId: '1917',
      gameId: 'btl_football_game_g1917',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      homeTeamProviderId: '42',
      awayTeamProviderId: '49',
      entityResolutions: {
        teams: {
          '42': { entityId: 'btl_football_team_t8596499a', label: 'Arsenal F.C.' },
        },
      },
      envelope: teamStatisticsEnvelope(),
    });

    expect(request.metadata?.rawPayloadRef).toBe(
      'provider://api-football/fixtures/statistics/1917'
    );
    expect(request.metadata?.provider).toBe('api-football');
    expect(request.teamStats).toHaveLength(2);

    const home = request.teamStats[0];
    expect(home?.gameId).toBe('btl_football_game_g1917');
    // Resolved team → canonical SubjectRef populated + RESOLVED resolution ref.
    expect(home?.team?.id).toBe('btl_football_team_t8596499a');
    expect(home?.teamResolution?.entityId).toBe('btl_football_team_t8596499a');
    expect(home?.role).toBe(GameParticipantRole.HOME);
    // Game resolution carries the provider fixture id + canonical game id.
    expect(home?.gameResolution?.providerRef?.providerId).toBe('1917');
    expect(home?.gameResolution?.entityId).toBe('btl_football_game_g1917');
    // Headline metrics.
    expect(home?.shotsOnTarget).toBe(7);
    expect(home?.shotsOffTarget).toBe(4);
    expect(home?.shots).toBe(14);
    expect(home?.shotsBlocked).toBe(3);
    expect(home?.corners).toBe(6);
    expect(home?.fouls).toBe(9);
    expect(home?.offsides).toBe(2);
    expect(home?.possessionPct).toBeCloseTo(58);
    expect(home?.passes).toBe(520);
    expect(home?.passesCompleted).toBe(470);
    expect(home?.passCompletionPct).toBeCloseTo(90);
    expect(home?.expectedGoals).toBeCloseTo(1.84);
    expect(home?.yellowCards).toBe(1);
    expect(home?.redCards).toBe(0);
    expect(home?.saves).toBe(4);
    // Unknown provider metric preserved (slugged) in extra_stats.
    expect(home?.extraStats['goals-prevented']).toBeCloseTo(0.4);
    // Source attribution is the API-Football provider.
    expect(home?.source?.provider).toBe('api-football');
    // Provenance: one entry per SUPPLIED field. Red Cards (=0) is present,
    // but the null "Passes Through" metric is not.
    const provenanceFields = home?.provenance.map((p) => p.fieldName) ?? [];
    expect(provenanceFields).toContain('redCards');
    expect(provenanceFields).toContain('possessionPct');
    expect(provenanceFields).not.toContain('passesThrough');
    expect(home?.provenance.every((p) => p.provider === 'api-football')).toBe(true);
    expect(home?.provenance.every((p) => p.isAuthoritative)).toBe(true);

    // Away team unresolved → no canonical subject, provider ref preserved,
    // and role still set from the away provider id.
    const away = request.teamStats[1];
    expect(away?.team).toBeUndefined();
    expect(away?.teamResolution?.providerRef?.providerId).toBe('49');
    expect(away?.role).toBe(GameParticipantRole.AWAY);
    expect(away?.possessionPct).toBeCloseTo(42);
  });

  it('leaves GameParticipantRole UNSPECIFIED when home/away ids are unknown', () => {
    const request = apiFootballIngestTeamMatchStatsRequestFromStatistics({
      replayId: 'live:team-match-stats:1917',
      resourceId: '1917',
      gameId: 'btl_football_game_g1917',
      envelope: teamStatisticsEnvelope(),
    });
    expect(request.teamStats[0]?.role).toBe(GameParticipantRole.UNSPECIFIED);
  });

  const playersEnvelope = () => ({
    response: [
      {
        team: { id: 42, name: 'Arsenal' },
        players: [
          {
            player: {
              id: 1460,
              name: 'Bukayo Saka',
              photo: 'https://media.api-sports.io/football/players/1460.png',
            },
            statistics: [
              {
                games: {
                  minutes: 90,
                  number: 7,
                  position: 'F',
                  rating: '8.4',
                  captain: false,
                  substitute: false,
                },
                offsides: 1,
                shots: { total: 4, on: 2 },
                goals: { total: 1, conceded: 0, assists: 1, saves: null },
                passes: { total: 58, key: 3, accuracy: '88' },
                tackles: { total: 2, blocks: 0, interceptions: 1 },
                duels: { total: 9, won: 6 },
                dribbles: { attempts: 7, success: 5, past: null },
                fouls: { drawn: 3, committed: 1 },
                cards: { yellow: 0, red: 0 },
                penalty: { won: null, committed: null, scored: null, missed: null, saved: null },
                expected_goals: '0.62',
                expected_assists: '0.31',
              },
            ],
          },
          {
            // Unused substitute: substitute=true, 0 minutes → role UNUSED.
            player: { id: 999, name: 'Unused Sub' },
            statistics: [
              {
                games: { minutes: 0, number: 30, position: 'M', rating: null, substitute: true },
                goals: { total: 0, assists: 0 },
              },
            ],
          },
        ],
      },
    ],
  });

  it('maps /fixtures/players into canonical PlayerMatchStats across the squad', () => {
    const request = apiFootballIngestPlayerMatchStatsRequestFromPlayers({
      replayId: 'live:player-match-stats:1917',
      resourceId: '1917',
      gameId: 'btl_football_game_g1917',
      fetchedAtMs: Date.parse('2026-05-21T12:00:00Z'),
      entityResolutions: {
        players: {
          '1460': { entityId: 'btl_football_player_psaka', label: 'Bukayo Saka' },
        },
      },
      envelope: playersEnvelope(),
    });

    expect(request.metadata?.rawPayloadRef).toBe('provider://api-football/fixtures/players/1917');
    expect(request.playerStats).toHaveLength(2);

    const saka = request.playerStats[0];
    expect(saka?.gameId).toBe('btl_football_game_g1917');
    expect(saka?.player?.id).toBe('btl_football_player_psaka');
    expect(saka?.playerResolution?.entityId).toBe('btl_football_player_psaka');
    // Team unresolved → provider ref preserved on team_resolution.
    expect(saka?.team).toBeUndefined();
    expect(saka?.teamResolution?.providerRef?.providerId).toBe('42');
    expect(saka?.role).toBe('STARTER');
    expect(saka?.isStarter).toBe(true);
    expect(saka?.minutes).toBe(90);
    expect(saka?.shirtNumber).toBe(7);
    expect(saka?.goals).toBe(1);
    expect(saka?.assists).toBe(1);
    expect(saka?.shots).toBe(4);
    expect(saka?.shotsOnTarget).toBe(2);
    expect(saka?.keyPasses).toBe(3);
    expect(saka?.passes).toBe(58);
    expect(saka?.passCompletionPct).toBeCloseTo(88);
    expect(saka?.tackles).toBe(2);
    expect(saka?.interceptions).toBe(1);
    expect(saka?.dribbles).toBe(7);
    expect(saka?.dribblesCompleted).toBe(5);
    expect(saka?.duels).toBe(9);
    expect(saka?.duelsWon).toBe(6);
    expect(saka?.foulsDrawn).toBe(3);
    expect(saka?.foulsCommitted).toBe(1);
    expect(saka?.offsides).toBe(1);
    expect(saka?.rating).toBeCloseTo(8.4);
    expect(saka?.expectedGoals).toBeCloseTo(0.62);
    expect(saka?.expectedAssists).toBeCloseTo(0.31);
    expect(saka?.gameResolution?.providerRef?.providerId).toBe('1917');
    expect(saka?.source?.provider).toBe('api-football');
    // Provenance: cards.yellow/red are 0 but present → provenance entries.
    const fields = saka?.provenance.map((p) => p.fieldName) ?? [];
    expect(fields).toContain('goals');
    expect(fields).toContain('yellowCards');
    // saves is null for an outfielder → no field, no provenance.
    expect(fields).not.toContain('saves');

    const sub = request.playerStats[1];
    expect(sub?.role).toBe('UNUSED');
    expect(sub?.isStarter).toBe(false);
    expect(sub?.minutes).toBe(0);
  });

  it('skips player entries with no statistics block', () => {
    const request = apiFootballIngestPlayerMatchStatsRequestFromPlayers({
      replayId: 'live:player-match-stats:1917',
      resourceId: '1917',
      gameId: 'btl_football_game_g1917',
      envelope: {
        response: [
          {
            team: { id: 42, name: 'Arsenal' },
            players: [{ player: { id: 1460, name: 'Bukayo Saka' }, statistics: [] }],
          },
        ],
      },
    });
    expect(request.playerStats).toHaveLength(0);
  });

  it('returns empty stats batches for malformed or empty envelopes', () => {
    for (const bad of [undefined, null, {}, { response: 'nope' }, { response: [] }]) {
      expect(
        apiFootballIngestTeamMatchStatsRequestFromStatistics({
          replayId: 'r',
          resourceId: '1',
          gameId: 'g',
          envelope: bad,
        }).teamStats
      ).toHaveLength(0);
      expect(
        apiFootballIngestPlayerMatchStatsRequestFromPlayers({
          replayId: 'r',
          resourceId: '1',
          gameId: 'g',
          envelope: bad,
        }).playerStats
      ).toHaveLength(0);
    }
  });

  it('is idempotent: the same envelope maps to byte-identical ingest requests', () => {
    const fetchedAtMs = Date.parse('2026-05-21T12:00:00Z');
    const teamArgs = {
      replayId: 'live:team-match-stats:1917',
      resourceId: '1917',
      gameId: 'btl_football_game_g1917',
      fetchedAtMs,
      homeTeamProviderId: '42',
      awayTeamProviderId: '49',
      envelope: teamStatisticsEnvelope(),
    } as const;
    const teamA = apiFootballIngestTeamMatchStatsRequestFromStatistics(teamArgs);
    const teamB = apiFootballIngestTeamMatchStatsRequestFromStatistics(teamArgs);
    expect(toBinary(IngestTeamMatchStatsRequestSchema, teamB)).toEqual(
      toBinary(IngestTeamMatchStatsRequestSchema, teamA)
    );
    // Idempotency key is stable across runs (game-service upserts on it).
    expect(teamA.metadata?.idempotencyKey).toBe(teamB.metadata?.idempotencyKey);

    const playerArgs = {
      replayId: 'live:player-match-stats:1917',
      resourceId: '1917',
      gameId: 'btl_football_game_g1917',
      fetchedAtMs,
      envelope: playersEnvelope(),
    } as const;
    const playerA = apiFootballIngestPlayerMatchStatsRequestFromPlayers(playerArgs);
    const playerB = apiFootballIngestPlayerMatchStatsRequestFromPlayers(playerArgs);
    expect(toBinary(IngestPlayerMatchStatsRequestSchema, playerB)).toEqual(
      toBinary(IngestPlayerMatchStatsRequestSchema, playerA)
    );
    expect(playerA.metadata?.idempotencyKey).toBe(playerB.metadata?.idempotencyKey);
  });

  it('derives the provider stat paths', () => {
    expect(apiFootballFixtureStatisticsPath('1917')).toBe('/fixtures/statistics?fixture=1917');
    expect(apiFootballFixturePlayersPath('1917')).toBe('/fixtures/players?fixture=1917');
  });
});
