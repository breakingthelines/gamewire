import type {
  IngestBatchResponse,
  IngestFootballLineupsRequest,
  IngestFootballStandingsRequest,
  IngestGameOccurrencesRequest,
  IngestGamesRequest,
  ListProviderConfigsRequest,
  ListProviderConfigsResponse,
  ReportProviderHealthRequest,
  ReportProviderHealthResponse,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

export interface GameServiceIngestClient {
  ingestGames(request: IngestGamesRequest): Promise<IngestBatchResponse>;
  ingestFootballLineups(request: IngestFootballLineupsRequest): Promise<IngestBatchResponse>;
  ingestFootballStandings(request: IngestFootballStandingsRequest): Promise<IngestBatchResponse>;
  ingestGameOccurrences(request: IngestGameOccurrencesRequest): Promise<IngestBatchResponse>;
  listProviderConfigs(request: ListProviderConfigsRequest): Promise<ListProviderConfigsResponse>;
  reportProviderHealth(request: ReportProviderHealthRequest): Promise<ReportProviderHealthResponse>;
}

export interface GameServiceIngestClientOptions {
  baseUrl: string;
}

export const createGameServiceIngestClientBoundary = (
  options: GameServiceIngestClientOptions
): GameServiceIngestClientOptions => ({
  baseUrl: options.baseUrl,
});
