import { describe, expect, it } from 'vitest';

import {
  FetchFixtures,
  FetchGame,
  FetchLineup,
  FetchOccurrences,
  FetchStandings,
  PollLiveGame,
  listProviderConfigRequestFor,
} from './activities.js';
import type { GamewireWorkerConfig } from './config.js';

const testConfig: GamewireWorkerConfig = {
  port: 8095,
  gameServiceUrl: 'http://game-service:9090',
  identityServiceUrl: 'http://identity:9090',
  providerId: 'api-football',
  providerKind: 'football',
  providerMode: 'replay',
  identityProviderId: 'identity-data-football',
  webhookPath: '/webhooks/gamewire',
  logLevel: 'info',
};

describe('gamewire-worker activities', () => {
  it('builds typed fixture ingest replay without provider calls', async () => {
    const result = await FetchFixtures({ replayId: 'replay-1' }, { config: testConfig });

    expect(result.activity).toBe('FetchFixtures');
    expect(result.status).toBe('replay_ready');
    expect(result.request.metadata?.provider).toBe('api-football');
    expect(result.request.metadata?.replayId).toBe('replay-1');
    expect(result.request.games).toHaveLength(1);
    expect(result.runtime.request.cacheKey).toContain('api-football:fixtures');
    expect(result.runtime.request.path).toBe('/fixtures?league=39&season=2025');
    expect(result.runtime.request.relatedPaths).toEqual([
      '/fixtures?league=39&season=2025',
      '/fixtures?league=140&season=2025',
      '/fixtures?league=135&season=2025',
      '/fixtures?league=78&season=2025',
      '/fixtures?league=61&season=2025',
      '/fixtures?league=1&season=2026',
    ]);
    expect(result.runtime.request.redactedHeaders).toContain('x-apisports-key');
    expect(result.response.replayId).toBe('replay-1');
  });

  it('builds typed game, lineup, occurrence, and standings replay payloads', async () => {
    const game = await FetchGame(
      { gameId: 'btl_football_game_api_football_1917', replayId: 'game-replay' },
      { config: testConfig }
    );
    const lineup = await FetchLineup(
      { gameId: 'btl_football_game_api_football_1917', replayId: 'lineup-replay' },
      { config: testConfig }
    );
    const occurrences = await FetchOccurrences(
      { gameId: 'btl_football_game_api_football_1917', replayId: 'occurrence-replay' },
      { config: testConfig }
    );
    const standings = await FetchStandings(
      { competitionId: 'premier-league', seasonId: '2026', replayId: 'standings-replay' },
      { config: testConfig }
    );

    expect(game.request.games).toHaveLength(1);
    expect(lineup.request.lineups[0]?.teamSheets).toHaveLength(2);
    expect(occurrences.request.gameId).toBe('btl_football_game_api_football_1917');
    expect(occurrences.request.occurrences).toHaveLength(1);
    expect(standings.request.standings[0]?.entries).toHaveLength(2);
  });

  it('builds typed live polling and provider config boundary requests', async () => {
    const live = await PollLiveGame({ gameId: 'btl_football_game_1' }, { config: testConfig });
    const providerConfig = listProviderConfigRequestFor('football');

    expect(live.request.gameIds).toEqual(['btl_football_game_1']);
    expect(live.response.liveCount).toBe(1);
    expect(live.response.changedCount).toBe(1);
    expect(providerConfig.kind).toBe('football');
    expect(providerConfig.includeDisabled).toBe(false);
  });

  it('keeps unknown providers stubbed until an adapter is implemented', async () => {
    const result = await FetchFixtures(
      { provider: 'unapproved-provider', replayId: 'stub-replay' },
      { config: testConfig }
    );

    expect(result.status).toBe('stubbed');
    expect(result.request.games).toHaveLength(0);
    expect(result.runtime.request.redactedHeaders).toContain('api-token');
  });

});
