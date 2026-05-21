import { describe, expect, it } from 'vitest';

import {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_REPLAY_FIXTURE_ID,
  API_FOOTBALL_REPLAY_GAME_ID,
  apiFootballFixtureSyncPaths,
  apiFootballIngestGamesRequestFromFixtures,
  apiFootballIngestLineupsRequestFromLineups,
  apiFootballIngestOccurrencesRequestFromEvents,
  apiFootballLivePath,
  apiFootballReplayFixturesRequest,
  apiFootballReplayGameRequest,
  apiFootballReplayOccurrencesRequest,
  apiFootballStandingSyncPaths,
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
            team: { id: 42, name: 'Arsenal' },
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
});
