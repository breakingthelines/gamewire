import type {
  IngestBatchResponse,
  IngestFootballLineupsRequest,
  IngestFootballStandingsRequest,
  IngestGameOccurrencesRequest,
  IngestGamesRequest,
  ListProviderConfigsRequest,
  ListProviderConfigsResponse,
  RecordRatingRequest,
  RecordRatingResponse,
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

/**
 * Downstream rating aggregation entrypoint. The consumer side of the
 * RatingSubmitted event bus calls this on each event, folding the value
 * into `rating_aggregates` + `rating_distributions` server-side.
 *
 * Kept narrow on purpose: the consumer never needs the rest of the
 * GameService surface, so we avoid widening the boundary contract.
 */
export interface GameServiceRecordRatingClient {
  recordRating(request: RecordRatingRequest): Promise<RecordRatingResponse>;
}

export interface GameServiceRecordRatingClientOptions {
  baseUrl: string;
}

export const createGameServiceRecordRatingClientBoundary = (
  options: GameServiceRecordRatingClientOptions
): GameServiceRecordRatingClientOptions => ({
  baseUrl: options.baseUrl,
});
