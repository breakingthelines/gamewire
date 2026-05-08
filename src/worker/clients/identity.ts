import type {
  LookupRequest,
  LookupResponse,
  ResolveRequest,
  ResolveResponse,
  SearchRequest,
  SearchResponse,
  StatsRequest,
  StatsResponse,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

export interface FootballIdentityLookupClient {
  lookup(request: LookupRequest): Promise<LookupResponse>;
  resolve(request: ResolveRequest): Promise<ResolveResponse>;
  search(request: SearchRequest): Promise<SearchResponse>;
  stats(request: StatsRequest): Promise<StatsResponse>;
}

export interface FootballIdentityLookupClientOptions {
  baseUrl: string;
  providerId: string;
}

export const createFootballIdentityLookupBoundary = (
  options: FootballIdentityLookupClientOptions
): FootballIdentityLookupClientOptions => ({
  baseUrl: options.baseUrl,
  providerId: options.providerId,
});
