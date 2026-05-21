import { describe, expect, it } from 'vitest';

import {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_REPLAY_FIXTURE_ID,
  API_FOOTBALL_REPLAY_GAME_ID,
  apiFootballFixtureSyncPaths,
  apiFootballIngestGamesRequestFromFixtures,
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
              home: { id: 42, name: 'Arsenal' },
              away: { id: 49, name: 'Chelsea' },
            },
            goals: { home: 2, away: 1 },
          },
        ],
      },
    });

    expect(request.metadata?.provider).toBe('api-football');
    expect(request.metadata?.rawPayloadRef).toBe('provider://api-football/fixtures/1917');
    expect(request.games).toHaveLength(1);
    expect(request.games[0]?.id).toBe('btl_football_game_api_football_1917');
    expect(request.games[0]?.routeId).toBe('g3-fixture-1917');
    expect(request.games[0]?.slug).toBe('arsenal-vs-chelsea-2026-05-11');
    expect(request.games[0]?.providerGameId).toBe('1917');
    expect(request.games[0]?.score?.display).toBe('2-1');
    expect(request.games[0]?.sportPayload.case).toBe('football');
    expect(request.games[0]?.sportPayload.value?.matchday).toBe(1);
  });
});
