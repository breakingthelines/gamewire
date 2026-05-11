import {
  API_FOOTBALL_BETA_COMPETITIONS,
  apiFootballEventPath,
  apiFootballFixturePath,
  apiFootballFixtureSyncPaths,
  apiFootballLineupPath,
  apiFootballLivePath,
  apiFootballStandingSyncPaths,
  apiFootballStatusPath,
} from '../adapters/api-football/index.js';

export type ProviderRuntimeMode = 'replay' | 'live';

export interface ProviderRequestPlan {
  readonly provider: string;
  readonly mode: ProviderRuntimeMode;
  readonly workload: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly cacheKey: string;
  readonly cacheTtlSeconds: number;
  readonly quotaCost: number;
  readonly backoff: {
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly maxAttempts: number;
  };
  readonly redactedHeaders: readonly string[];
  readonly relatedPaths: readonly string[];
}

export interface ProviderRuntimeReport {
  readonly request: ProviderRequestPlan;
  readonly cache: {
    readonly strategy: 'replay' | 'ttl';
    readonly hit: boolean;
  };
  readonly quota: {
    readonly bucket: string;
    readonly cost: number;
    readonly remaining?: number;
  };
  readonly log: {
    readonly event: 'provider_request_planned';
    readonly provider: string;
    readonly workload: string;
    readonly cacheKey: string;
    readonly replayId: string;
  };
}

export interface ProviderWorkloadPlanOptions {
  readonly provider: string;
  readonly mode: ProviderRuntimeMode;
  readonly workload: string;
  readonly resourceId: string;
  readonly replayId: string;
  readonly path?: string;
  readonly relatedPaths?: readonly string[];
}

const cacheTtlByWorkload: Record<string, number> = {
  fixtures: 15 * 60,
  game: 15 * 60,
  lineup: 60 * 60,
  occurrences: 60 * 60,
  standings: 6 * 60 * 60,
  live: 15,
  status: 60,
};

export function createProviderRuntimeReport(
  options: ProviderWorkloadPlanOptions
): ProviderRuntimeReport {
  const request = createProviderRequestPlan(options);
  return {
    request,
    cache: {
      strategy: options.mode === 'replay' ? 'replay' : 'ttl',
      hit: options.mode === 'replay',
    },
    quota: {
      bucket: `${options.provider}:${options.workload}:hour`,
      cost: request.quotaCost,
    },
    log: {
      event: 'provider_request_planned',
      provider: options.provider,
      workload: options.workload,
      cacheKey: request.cacheKey,
      replayId: options.replayId,
    },
  };
}

export function createProviderRequestPlan(
  options: ProviderWorkloadPlanOptions
): ProviderRequestPlan {
  const workload = normaliseWorkload(options.workload);
  return {
    provider: options.provider,
    mode: options.mode,
    workload,
    method: 'GET',
    path: options.path ?? providerPathFor(options.provider, workload, options.resourceId),
    relatedPaths:
      options.relatedPaths ?? relatedPathsFor(options.provider, workload, options.resourceId),
    cacheKey: `${options.provider}:${workload}:${options.resourceId}:${options.replayId}`,
    cacheTtlSeconds: cacheTtlByWorkload[workload] ?? 15 * 60,
    quotaCost: 1,
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: options.mode === 'replay' ? 1 : 4,
    },
    redactedHeaders: ['authorization', 'x-api-key', 'x-apisports-key', 'api-token'],
  };
}

function providerPathFor(provider: string, workload: string, resourceId: string): string {
  if (normaliseProvider(provider) === 'api-football') {
    return apiFootballPathFor(workload, resourceId);
  }
  return genericProviderPathFor(workload, resourceId);
}

function apiFootballPathFor(workload: string, resourceId: string): string {
  switch (workload) {
    case 'fixtures':
      return apiFootballFixtureSyncPaths()[0] ?? '/fixtures';
    case 'game':
      return apiFootballFixturePath(resourceId);
    case 'lineup':
      return apiFootballLineupPath(resourceId);
    case 'occurrences':
      return apiFootballEventPath(resourceId);
    case 'standings':
      return apiFootballStandingSyncPaths()[0] ?? '/standings';
    case 'live':
      return apiFootballLivePath();
    case 'status':
      return apiFootballStatusPath();
    default:
      return `/${workload}?id=${encodeURIComponent(resourceId)}`;
  }
}

function relatedPathsFor(
  provider: string,
  workload: string,
  resourceId: string
): readonly string[] {
  if (normaliseProvider(provider) !== 'api-football') {
    return [];
  }
  switch (workload) {
    case 'fixtures':
      return apiFootballFixtureSyncPaths();
    case 'standings':
      return apiFootballStandingSyncPaths();
    case 'lineup':
      return [apiFootballLineupPath(resourceId)];
    case 'occurrences':
      return [apiFootballEventPath(resourceId)];
    case 'live':
      return [apiFootballLivePath()];
    case 'status':
      return [apiFootballStatusPath()];
    default:
      return [];
  }
}

export function apiFootballBetaCoverageCount(): number {
  return API_FOOTBALL_BETA_COMPETITIONS.length;
}

function genericProviderPathFor(workload: string, resourceId: string): string {
  return `/${workload}?resource=${encodeURIComponent(resourceId)}`;
}

function normaliseWorkload(workload: string): string {
  return workload
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

function normaliseProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/_/g, '-');
}
