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
import {
  API_FOOTBALL_REPLAY_GAME_ID,
  API_FOOTBALL_REPLAY_ID,
  apiFootballReplayFixturesRequest,
  apiFootballReplayGameRequest,
  apiFootballReplayLineupsRequest,
  apiFootballReplayOccurrencesRequest,
  apiFootballReplayStandingsRequest,
} from '../adapters/api-football/index.js';

import type { GamewireWorkerConfig } from './config.js';
import { config as defaultConfig } from './config.js';
import { createProviderRuntimeReport, type ProviderRuntimeReport } from './runtime.js';

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

export interface ActivityResult<TRequest, TResponse = IngestBatchResponse> {
  activity: GamewireActivityName;
  provider: string;
  status: 'stubbed' | 'replay_ready';
  message: string;
  request: TRequest;
  response: TResponse;
  runtime: ProviderRuntimeReport;
}

const resolveConfig = (context?: GamewireActivityContext): GamewireWorkerConfig =>
  context?.config ?? defaultConfig;

const resolveProvider = (input: ProviderActivityInput, context?: GamewireActivityContext): string =>
  input.provider ?? resolveConfig(context).providerId;

const replayIdFor = (activity: GamewireActivityName, input: ProviderActivityInput): string =>
  input.replayId ??
  (replaySupportsProvider(input.provider ?? '')
    ? replayIdForProvider(input.provider ?? '')
    : `${input.provider ?? 'provider'}:${activity}:stub`);

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

const activityResult = <TRequest, TResponse = IngestBatchResponse>(
  activity: GamewireActivityName,
  provider: string,
  request: TRequest,
  response: TResponse,
  message: string,
  runtime: ProviderRuntimeReport,
  status: ActivityResult<TRequest, TResponse>['status']
): ActivityResult<TRequest, TResponse> => ({
  activity,
  provider,
  status,
  message,
  request,
  response,
  runtime,
});

export const listProviderConfigRequestFor = (kind: string) =>
  message<ListProviderConfigsRequest>('btl.game.v1.ListProviderConfigsRequest', {
    kind,
    includeDisabled: false,
  });

export async function FetchFixtures(
  input: FetchFixturesInput = {},
  context?: GamewireActivityContext
): Promise<ActivityResult<IngestGamesRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchFixtures', { ...input, provider });
  const runtime = runtimeFor('FetchFixtures', provider, replayId, 'fixture-window', context);
  const request = replaySupportsProvider(provider)
    ? replayFixturesRequestFor(provider, replayId, input.filter)
    : message<IngestGamesRequest>('btl.game.v1.IngestGamesRequest', {
        metadata: createIngestMetadata('FetchFixtures', provider, replayId, 'fixtures'),
        games: [],
      });

  return activityResult(
    'FetchFixtures',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    replaySupportsProvider(provider)
      ? 'Fixture replay produced a normalized IngestGames payload; no live provider API call or GameService ingest was performed.'
      : 'Fixture fetch is scaffolded; no provider API call or GameService ingest was performed.',
    runtime,
    replaySupportsProvider(provider) ? 'replay_ready' : 'stubbed'
  );
}

export async function FetchGame(
  input: FetchGameInput,
  context?: GamewireActivityContext
): Promise<ActivityResult<IngestGamesRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchGame', { ...input, provider });
  const gameId = input.gameId || replayGameIdForProvider(provider);
  const runtime = runtimeFor('FetchGame', provider, replayId, gameId, context);
  const request = replaySupportsProvider(provider)
    ? replayGameRequestFor(provider, replayId, gameId)
    : message<IngestGamesRequest>('btl.game.v1.IngestGamesRequest', {
        metadata: createIngestMetadata('FetchGame', provider, replayId, input.gameId),
        games: [],
      });

  return activityResult(
    'FetchGame',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    replaySupportsProvider(provider)
      ? 'Game replay produced a normalized IngestGames payload; no live provider API call or GameService ingest was performed.'
      : 'Game fetch is scaffolded; no provider API call or GameService ingest was performed.',
    runtime,
    replaySupportsProvider(provider) ? 'replay_ready' : 'stubbed'
  );
}

export async function FetchLineup(
  input: FetchLineupInput,
  context?: GamewireActivityContext
): Promise<ActivityResult<IngestFootballLineupsRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchLineup', { ...input, provider });
  const runtime = runtimeFor('FetchLineup', provider, replayId, input.gameId, context);
  const request = replaySupportsProvider(provider)
    ? replayLineupsRequestFor(provider, replayId, input.gameId)
    : message<IngestFootballLineupsRequest>('btl.game.v1.IngestFootballLineupsRequest', {
        metadata: createIngestMetadata('FetchLineup', provider, replayId, input.gameId),
        lineups: [],
      });

  return activityResult(
    'FetchLineup',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    replaySupportsProvider(provider)
      ? 'Lineup replay produced a normalized IngestFootballLineups payload; no live provider API call or GameService ingest was performed.'
      : 'Lineup fetch is scaffolded; no provider API call or GameService ingest was performed.',
    runtime,
    replaySupportsProvider(provider) ? 'replay_ready' : 'stubbed'
  );
}

export async function FetchOccurrences(
  input: FetchOccurrencesInput,
  context?: GamewireActivityContext
): Promise<ActivityResult<IngestGameOccurrencesRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchOccurrences', { ...input, provider });
  const runtime = runtimeFor('FetchOccurrences', provider, replayId, input.gameId, context);
  const request = replaySupportsProvider(provider)
    ? replayOccurrencesRequestFor(provider, replayId, input.gameId)
    : message<IngestGameOccurrencesRequest>('btl.game.v1.IngestGameOccurrencesRequest', {
        metadata: createIngestMetadata('FetchOccurrences', provider, replayId, input.gameId),
        gameId: input.gameId,
        occurrences: [],
      });

  return activityResult(
    'FetchOccurrences',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    replaySupportsProvider(provider)
      ? 'Occurrence replay produced a normalized IngestGameOccurrences payload; no live provider API call, event publish, or GameService ingest was performed.'
      : 'Occurrence fetch is scaffolded; no provider API call, event publish, or GameService ingest was performed.',
    runtime,
    replaySupportsProvider(provider) ? 'replay_ready' : 'stubbed'
  );
}

export async function FetchStandings(
  input: FetchStandingsInput = {},
  context?: GamewireActivityContext
): Promise<ActivityResult<IngestFootballStandingsRequest>> {
  const provider = resolveProvider(input, context);
  const replayId = replayIdFor('FetchStandings', { ...input, provider });
  const resourceId = [input.competitionId, input.seasonId].filter(Boolean).join(':') || 'standings';
  const runtime = runtimeFor('FetchStandings', provider, replayId, resourceId, context);
  const request = replaySupportsProvider(provider)
    ? replayStandingsRequestFor(provider, replayId, input.competitionId, input.seasonId)
    : message<IngestFootballStandingsRequest>('btl.game.v1.IngestFootballStandingsRequest', {
        metadata: createIngestMetadata('FetchStandings', provider, replayId, resourceId),
        standings: [],
      });

  return activityResult(
    'FetchStandings',
    provider,
    request,
    createEmptyIngestResponse(replayId),
    replaySupportsProvider(provider)
      ? 'Standings replay produced a normalized IngestFootballStandings payload; no live provider API call or GameService ingest was performed.'
      : 'Standings fetch is scaffolded; no provider API call or GameService ingest was performed.',
    runtime,
    replaySupportsProvider(provider) ? 'replay_ready' : 'stubbed'
  );
}

export async function PollLiveGame(
  input: PollLiveGameInput,
  context?: GamewireActivityContext
): Promise<ActivityResult<PollLiveGamesRequest, PollLiveGamesResponse>> {
  const provider = resolveProvider(input, context);
  const request = message<PollLiveGamesRequest>('btl.game.v1.PollLiveGamesRequest', {
    gameIds: [input.gameId],
  });
  const replayReady = replaySupportsProvider(provider);
  const runtime = runtimeFor(
    'PollLiveGame',
    provider,
    replayIdFor('PollLiveGame', { ...input, provider }),
    input.gameId,
    context
  );
  const response = message<PollLiveGamesResponse>('btl.game.v1.PollLiveGamesResponse', {
    liveCount: replayReady ? 1 : 0,
    changedCount: replayReady ? 1 : 0,
  });

  return activityResult(
    'PollLiveGame',
    provider,
    request,
    response,
    replayReady
      ? 'Live polling replay exercised the latest-updated path; no live provider API call or GameService ingest was performed.'
      : 'Live polling is scaffolded; no provider API call or GameService ingest was performed.',
    runtime,
    replayReady ? 'replay_ready' : 'stubbed'
  );
}

function runtimeFor(
  activity: GamewireActivityName,
  provider: string,
  replayId: string,
  resourceId: string,
  context?: GamewireActivityContext
): ProviderRuntimeReport {
  const cfg = resolveConfig(context);
  return createProviderRuntimeReport({
    provider,
    mode: cfg.providerMode,
    workload: workloadFor(activity),
    resourceId,
    replayId,
  });
}

function workloadFor(activity: GamewireActivityName): string {
  switch (activity) {
    case 'FetchFixtures':
      return 'fixtures';
    case 'FetchGame':
      return 'game';
    case 'FetchLineup':
      return 'lineup';
    case 'FetchOccurrences':
      return 'occurrences';
    case 'FetchStandings':
      return 'standings';
    case 'PollLiveGame':
      return 'live';
  }
}

function replaySupportsProvider(providerId: string): boolean {
  return normaliseProvider(providerId) === 'api-football';
}

function replayIdForProvider(_providerId: string): string {
  return API_FOOTBALL_REPLAY_ID;
}

function replayGameIdForProvider(_providerId: string): string {
  return API_FOOTBALL_REPLAY_GAME_ID;
}

function replayFixturesRequestFor(
  provider: string,
  replayId: string,
  filter?: GameFilter
): IngestGamesRequest {
  return apiFootballReplayFixturesRequest({ provider, replayId, filter });
}

function replayGameRequestFor(
  provider: string,
  replayId: string,
  gameId: string
): IngestGamesRequest {
  return apiFootballReplayGameRequest({ provider, replayId, gameId });
}

function replayLineupsRequestFor(
  provider: string,
  replayId: string,
  gameId: string
): IngestFootballLineupsRequest {
  return apiFootballReplayLineupsRequest({ provider, replayId, gameId });
}

function replayOccurrencesRequestFor(
  provider: string,
  replayId: string,
  gameId: string
): IngestGameOccurrencesRequest {
  return apiFootballReplayOccurrencesRequest({ provider, replayId, gameId });
}

function replayStandingsRequestFor(
  provider: string,
  replayId: string,
  competitionId: string | undefined,
  seasonId: string | undefined
): IngestFootballStandingsRequest {
  return apiFootballReplayStandingsRequest({ provider, replayId, competitionId, seasonId });
}

function normaliseProvider(providerId: string): string {
  return providerId.trim().toLowerCase().replace(/_/g, '-');
}
