import type { GamewireWorkerConfig } from './config.js';
import { config as defaultConfig } from './config.js';
import { apiFootballFixturePath, apiFootballStatusPath } from '../adapters/api-football/index.js';
import type { ApiFootballIngestionLoop } from './ingestion.js';
import {
  fetchApiFootballJson,
  summarizeProviderJson,
  type ProviderFetch,
  type ProviderJsonFetchResult,
} from './provider-http.js';

export interface WorkerHttpRequest {
  method: string;
  pathname: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface WorkerHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const jsonResponse = (status: number, body: Record<string, unknown>): WorkerHttpResponse => ({
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body,
});

export interface WorkerHttpHandlerOptions {
  readonly fetchProvider?: ProviderFetch;
  readonly ingestion?: ApiFootballIngestionLoop;
}

export const activityNames = [
  'FetchFixtures',
  'FetchGame',
  'FetchLineup',
  'FetchOccurrences',
  'FetchStandings',
  'PollLiveGame',
] as const;

export const handleWorkerRequest = async (
  request: WorkerHttpRequest,
  cfg: GamewireWorkerConfig = defaultConfig,
  options: WorkerHttpHandlerOptions = {}
): Promise<WorkerHttpResponse> => {
  if (request.method === 'GET' && request.pathname === '/health') {
    return jsonResponse(200, {
      status: 'ok',
      service: 'gamewire-worker',
      provider: cfg.providerId,
    });
  }

  if (request.method === 'GET' && request.pathname === '/provider/smoke') {
    const fixtureId = request.query?.fixture;
    const path = fixtureId ? apiFootballFixturePath(fixtureId) : apiFootballStatusPath();
    const result = await fetchApiFootballJson({
      config: cfg,
      workload: fixtureId ? 'game' : 'status',
      resourceId: fixtureId ?? 'account',
      replayId: 'provider-smoke',
      path,
      fetchFn: options.fetchProvider,
    });

    return jsonResponse(statusForProviderSmoke(result), {
      status: result.status,
      skipReason: result.skipReason,
      service: 'gamewire-worker',
      provider: cfg.providerId,
      providerMode: cfg.providerMode,
      request: result.request,
      response: result.response,
      runtime: result.runtime,
      jsonSummary: result.json === undefined ? undefined : summarizeProviderJson(result.json),
      error: result.error,
    });
  }

  if (request.method === 'GET' && request.pathname === '/metrics') {
    if (!options.ingestion) {
      return jsonResponse(200, {
        status: 'ok',
        service: 'gamewire-worker',
        provider: cfg.providerId,
        ingestionEnabled: false,
        note: 'Ingestion loop not started; metrics will be empty.',
      });
    }
    const observe = await options.ingestion.observe();
    return jsonResponse(200, {
      status: 'ok',
      service: 'gamewire-worker',
      provider: cfg.providerId,
      ingestionEnabled: true,
      metrics: observe.metrics,
      quota: observe.quota,
      ttlSeconds: observe.ttlSeconds,
    });
  }

  if (request.method === 'POST' && request.pathname === cfg.webhookPath) {
    // API-Football v3 does not push webhooks; this endpoint is retained so
    // ops tooling can probe the receiver shape and so a future provider with
    // push semantics (e.g. BALLDONTLIE-style) can be wired in without
    // breaking the route contract.
    return jsonResponse(202, {
      status: 'accepted',
      service: 'gamewire-worker',
      behavior: cfg.providerMode === 'replay' ? 'replay-safe' : 'live-provider-boundary',
      provider: cfg.providerId,
      providerMode: cfg.providerMode,
      activities: [...activityNames],
      webhookSupport: cfg.providerId === 'api-football' ? 'polling-only' : 'unknown',
    });
  }

  return jsonResponse(404, {
    status: 'not_found',
    service: 'gamewire-worker',
  });
};

function statusForProviderSmoke(result: ProviderJsonFetchResult): number {
  if (result.status === 'fetched') {
    return result.response?.ok ? 200 : 502;
  }

  if (result.status === 'skipped') {
    return result.skipReason === 'missing_api_key' ? 428 : 200;
  }

  return 502;
}
