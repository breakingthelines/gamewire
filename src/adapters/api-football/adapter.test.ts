import { describe, expect, it } from 'vitest';

import {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_REPLAY_GAME_ID,
  apiFootballFixtureSyncPaths,
  apiFootballLivePath,
  apiFootballReplayFixturesRequest,
  apiFootballReplayOccurrencesRequest,
  apiFootballStandingSyncPaths,
  apiFootballStatusPath,
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
});
