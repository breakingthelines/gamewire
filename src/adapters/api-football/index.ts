/**
 * API-Football adapter.
 */

export {
  API_FOOTBALL_REPLAY_AWAY_TEAM_ID,
  API_FOOTBALL_REPLAY_COMPETITION_ID,
  API_FOOTBALL_REPLAY_GAME_ID,
  API_FOOTBALL_REPLAY_HOME_TEAM_ID,
  API_FOOTBALL_REPLAY_ID,
  API_FOOTBALL_REPLAY_SEASON_ID,
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
} from './adapter.js';

export {
  API_FOOTBALL_BETA_COMPETITIONS,
  API_FOOTBALL_PROVIDER_ID,
  type ApiFootballCompetitionPlan,
  type ApiFootballEventResponse,
  type ApiFootballFixtureRef,
  type ApiFootballFixtureResponse,
  type ApiFootballLeagueRef,
  type ApiFootballLineupPlayer,
  type ApiFootballLineupResponse,
  type ApiFootballStandingEntry,
  type ApiFootballStandingResponse,
  type ApiFootballTeamRef,
} from './types.js';
