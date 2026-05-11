/**
 * @breakingthelines/gamewire
 *
 * Transform external provider data into BTL's proto schema.
 */

// Core - proto types and utilities
export * from './core/index.js';

// Adapters
export {
  fromStatsBombOpen,
  type FromStatsBombOpenOptions,
} from './adapters/statsbomb-open/index.js';
export {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_PROVIDER_ID,
  API_FOOTBALL_REPLAY_GAME_ID,
  API_FOOTBALL_REPLAY_ID,
  apiFootballCompetitionKey,
  apiFootballEventPath,
  apiFootballFixturePath,
  apiFootballFixtureSyncPaths,
  apiFootballLineupPath,
  apiFootballLivePath,
  apiFootballReplayFixturesRequest,
  apiFootballReplayGameRequest,
  apiFootballReplayLineupsRequest,
  apiFootballReplayOccurrencesRequest,
  apiFootballReplayStandingsRequest,
  apiFootballStandingSyncPaths,
  type ApiFootballCompetitionPlan,
} from './adapters/api-football/index.js';
