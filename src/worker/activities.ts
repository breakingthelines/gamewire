import type {
  GameFilter,
  IngestBatchResponse,
  IngestFootballLineupsRequest,
  IngestFootballStandingsRequest,
  IngestGameOccurrencesRequest,
  IngestGamesRequest,
  IngestMetadata,
  ListProviderConfigsRequest,
  PollLiveGamesRequest,
  PollLiveGamesResponse,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import type { GamewireWorkerConfig } from './config.js';
import { config as defaultConfig } from './config.js';

export type GamewireActivityName =
  | 'FetchFixtures'
  | 'FetchGame'
  | 'FetchLineup'
  | 'FetchOccurrences'
  | 'FetchStandings'
  | 'PollLiveGame';

export interface GamewireActivityContext {
  config?: GamewireWorkerConfig;
}

export interface ProviderActivityInput {
  provider?: string;
  replayId?: string;
}

export interface FetchFixturesInput extends ProviderActivityInput {
  filter?: GameFilter;
}

export interface FetchGameInput extends ProviderActivityInput {
  gameId: string;
}

export interface FetchLineupInput extends ProviderActivityInput {
  gameId: string;
}

export interface FetchOccurrencesInput extends ProviderActivityInput {
  gameId: string;
}

export interface FetchStandingsInput extends ProviderActivityInput {
  competitionId?: string;
  seasonId?: string;
}

export interface PollLiveGameInput extends ProviderActivityInput {
  gameId: string;
}

export interface ActivityStubResult<TRequest, TResponse = IngestBatchResponse> {
  activity: GamewireActivityName;
  provider: string;
  status: 'stubbed';
  message: string;
  request: TRequest;
  response: TResponse;
}

const resolveConfig = (context?: GamewireActivityContext): GamewireWorkerConfig =>
  context?.config ?? defaultConfig;

const resolveProvider = (
  input: ProviderActivityInput,
  context?: GamewireActivityContext
): string => input.provider ?? resolveConfig(context).providerId;

const replayIdFor = (activity: GamewireActivityName, input: ProviderActivityInput): string =>
  input.replayId ?? `${input.provider ?? 'provider'}:${activity}:stub`;

const message = <T extends { readonly $typeName: string }>(
  typeName: T['$typeName'],
  fields: Omit<T, '$typeName' | '$unknown'>
): T =>
  ({
    $typeName: typeName,
    ...fields,
  }) as T;

const createEmptyIngestResponse = (replayId: string): IngestBatchResponse =>
  message<IngestBatchResponse>('btl.game.v1.IngestBatchResponse', {
    acceptedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    conflictCount: 0,
    unmappedIdentityCount: 0,
    unmappedIdentityCandidates: [],
    anomalies: [],
    replayId,
  });

const createIngestMetadata = (
  activity: GamewireActivityName,
  provider: string,
  replayId: string,
  resourceId: string
): IngestMetadata =>
  message<IngestMetadata>('btl.game.v1.IngestMetadata', {
    provider,
    replayId,
    rawPayloadRef: '',
    normalizedBatchId: `${provider}:${activity}:${resourceId}`,
    idempotencyKey: `${provider}:${activity}:${resourceId}:${replayId}`,
  });

const stubResult = <TRequest, TResponse = IngestBatchResponse>(
  activity: GamewireActivityName,
  provider: string,
  request: TRequest,
  response: TResponse,
  message: string
): ActivityStubResult<TRequest, TResponse> => ({
  activity,
  provider,
  status: 'stubbed',
  message,
  request,
  response,
});

export const listProviderConfigRequestFor = (kind: string) =>
  message<ListProviderConfigsRequest>('btl.game.v1.ListProviderConfigsRequest', {
    kind,
    includeDisabled: false,
  });

export async function FetchFixtures(
  input: FetchFixturesInput = {},
  context?: GamewireActivityContext
): Promise<ActivityStubResult<IngestGamesRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchFixtures', { ...input, provider });
  const request = message<IngestGamesRequest>('btl.game.v1.IngestGamesRequest', {
    metadata: createIngestMetadata('FetchFixtures', provider, replayId, 'fixtures'),
    games: [],
  });

  return stubResult(
    'FetchFixtures',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    'Fixture fetch is scaffolded; no provider API call or GameService ingest was performed.'
  );
}

export async function FetchGame(
  input: FetchGameInput,
  context?: GamewireActivityContext
): Promise<ActivityStubResult<IngestGamesRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchGame', { ...input, provider });
  const request = message<IngestGamesRequest>('btl.game.v1.IngestGamesRequest', {
    metadata: createIngestMetadata('FetchGame', provider, replayId, input.gameId),
    games: [],
  });

  return stubResult(
    'FetchGame',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    'Game fetch is scaffolded; no provider API call or GameService ingest was performed.'
  );
}

export async function FetchLineup(
  input: FetchLineupInput,
  context?: GamewireActivityContext
): Promise<ActivityStubResult<IngestFootballLineupsRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchLineup', { ...input, provider });
  const request = message<IngestFootballLineupsRequest>(
    'btl.game.v1.IngestFootballLineupsRequest',
    {
      metadata: createIngestMetadata('FetchLineup', provider, replayId, input.gameId),
      lineups: [],
    }
  );

  return stubResult(
    'FetchLineup',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    'Lineup fetch is scaffolded; no provider API call or GameService ingest was performed.'
  );
}

export async function FetchOccurrences(
  input: FetchOccurrencesInput,
  context?: GamewireActivityContext
): Promise<ActivityStubResult<IngestGameOccurrencesRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchOccurrences', { ...input, provider });
  const request = message<IngestGameOccurrencesRequest>(
    'btl.game.v1.IngestGameOccurrencesRequest',
    {
      metadata: createIngestMetadata('FetchOccurrences', provider, replayId, input.gameId),
      gameId: input.gameId,
      occurrences: [],
    }
  );

  return stubResult(
    'FetchOccurrences',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    'Occurrence fetch is scaffolded; no provider API call, event publish, or GameService ingest was performed.'
  );
}

export async function FetchStandings(
  input: FetchStandingsInput = {},
  context?: GamewireActivityContext
): Promise<ActivityStubResult<IngestFootballStandingsRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchStandings', { ...input, provider });
  const resourceId = [input.competitionId, input.seasonId].filter(Boolean).join(':') || 'standings';
  const request = message<IngestFootballStandingsRequest>(
    'btl.game.v1.IngestFootballStandingsRequest',
    {
      metadata: createIngestMetadata('FetchStandings', provider, replayId, resourceId),
      standings: [],
    }
  );

  return stubResult(
    'FetchStandings',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    'Standings fetch is scaffolded; no provider API call or GameService ingest was performed.'
  );
}

export async function PollLiveGame(
  input: PollLiveGameInput,
  context?: GamewireActivityContext
): Promise<ActivityStubResult<PollLiveGamesRequest, PollLiveGamesResponse>> {
  const provider = resolveProvider(input, context);
  const request = message<PollLiveGamesRequest>('btl.game.v1.PollLiveGamesRequest', {
    gameIds: [input.gameId],
  });
  const response = message<PollLiveGamesResponse>('btl.game.v1.PollLiveGamesResponse', {
    liveCount: 0,
    changedCount: 0,
  });

  return stubResult(
    'PollLiveGame',
    provider,
    request,
    response,
    'Live polling is scaffolded; no provider API call or GameService ingest was performed.'
  );
}
