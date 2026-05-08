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
  providerId: 'identity-data-football',
  providerKind: 'football',
  identityProviderId: 'identity-data-football',
  webhookPath: '/webhooks/gamewire',
  logLevel: 'info',
};

describe('gamewire-worker activities', () => {
  it('builds typed fixture ingest stubs without provider calls', async () => {
    const result = await FetchFixtures({ replayId: 'replay-1' }, { config: testConfig });

    expect(result.activity).toBe('FetchFixtures');
    expect(result.status).toBe('stubbed');
    expect(result.request.metadata?.provider).toBe('identity-data-football');
    expect(result.request.metadata?.replayId).toBe('replay-1');
    expect(result.request.games).toEqual([]);
    expect(result.response.replayId).toBe('replay-1');
  });

  it('builds typed game, lineup, occurrence, and standings stubs', async () => {
    const game = await FetchGame(
      { gameId: 'btl_football_game_1', replayId: 'game-replay' },
      { config: testConfig }
    );
    const lineup = await FetchLineup(
      { gameId: 'btl_football_game_1', replayId: 'lineup-replay' },
      { config: testConfig }
    );
    const occurrences = await FetchOccurrences(
      { gameId: 'btl_football_game_1', replayId: 'occurrence-replay' },
      { config: testConfig }
    );
    const standings = await FetchStandings(
      { competitionId: 'premier-league', seasonId: '2026', replayId: 'standings-replay' },
      { config: testConfig }
    );

    expect(game.request.games).toHaveLength(0);
    expect(lineup.request.lineups).toHaveLength(0);
    expect(occurrences.request.gameId).toBe('btl_football_game_1');
    expect(occurrences.request.occurrences).toHaveLength(0);
    expect(standings.request.standings).toHaveLength(0);
  });

  it('builds typed live polling and provider config boundary requests', async () => {
    const live = await PollLiveGame({ gameId: 'btl_football_game_1' }, { config: testConfig });
    const providerConfig = listProviderConfigRequestFor('football');

    expect(live.request.gameIds).toEqual(['btl_football_game_1']);
    expect(live.response.liveCount).toBe(0);
    expect(live.response.changedCount).toBe(0);
    expect(providerConfig.kind).toBe('football');
    expect(providerConfig.includeDisabled).toBe(false);
  });
});
