import { createHmac, timingSafeEqual } from 'node:crypto';

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
import {
  dailyAnchorWorkflow,
  hourlyMatchdayWorkflow,
  PHASE_A_COMPETITIONS,
  webhookCompletedWorkflow,
  type CompetitionEntry,
  type DailyAnchorInput,
  type HourlyMatchdayInput,
  type WebhookCompletedInput,
  type WorkflowDeps,
  type WorkflowLogger,
} from '../workflows/index.js';

export interface WorkerHttpRequest {
  method: string;
  pathname: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  rawBody?: string;
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
  readonly competitions?: readonly CompetitionEntry[];
  readonly workflowLogger?: WorkflowLogger;
}

const HMAC_HEADER = 'x-gamewire-workflow-hmac';

const verifyWorkflowHmac = (
  rawBody: string,
  headerValue: string | undefined,
  secret: string
): boolean => {
  if (!headerValue) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const provided = headerValue.trim().toLowerCase();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
};

const buildWorkflowDeps = (
  options: WorkerHttpHandlerOptions
): WorkflowDeps | undefined => {
  if (!options.ingestion) {
    return undefined;
  }
  return {
    ingestion: options.ingestion,
    competitions: options.competitions ?? PHASE_A_COMPETITIONS,
    logger: options.workflowLogger,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asStringList = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(item);
    }
  }
  return out;
};

const parseDailyAnchorInput = (body: unknown): DailyAnchorInput => {
  if (!isRecord(body)) {
    return {};
  }
  return {
    nowUtc: asString(body.nowUtc),
    competitions: asStringList(body.competitions),
  };
};

const parseHourlyMatchdayInput = (body: unknown): HourlyMatchdayInput => {
  if (!isRecord(body)) {
    return {};
  }
  return {
    nowUtc: asString(body.nowUtc),
    competitions: asStringList(body.competitions),
  };
};

const parseWebhookCompletedInput = (body: unknown): WebhookCompletedInput | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const providerId = asString(body.providerId);
  const fixtureId = asString(body.fixtureId);
  if (providerId === undefined || fixtureId === undefined || fixtureId === '') {
    return undefined;
  }
  return {
    providerId,
    fixtureId,
    nowUtc: asString(body.nowUtc),
  };
};

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

  if (
    request.method === 'POST' &&
    (request.pathname === '/workflows/daily-anchor' ||
      request.pathname === '/workflows/hourly-matchday' ||
      request.pathname === '/workflows/webhook-completed')
  ) {
    if (!cfg.workflowSecret) {
      return jsonResponse(401, {
        status: 'unauthorized',
        reason: 'workflow_secret_unset',
      });
    }
    const rawBody = request.rawBody ?? '';
    const headerValue =
      request.headers?.[HMAC_HEADER] ?? request.headers?.[HMAC_HEADER.toLowerCase()];
    if (!verifyWorkflowHmac(rawBody, headerValue, cfg.workflowSecret)) {
      return jsonResponse(401, {
        status: 'unauthorized',
        reason: 'bad_hmac',
      });
    }
    const deps = buildWorkflowDeps(options);
    if (!deps) {
      return jsonResponse(503, {
        status: 'unavailable',
        reason: 'ingestion_not_started',
      });
    }
    try {
      if (request.pathname === '/workflows/daily-anchor') {
        const input = parseDailyAnchorInput(request.body);
        const result = await dailyAnchorWorkflow(input, deps);
        return jsonResponse(200, { status: 'ok', result });
      }
      if (request.pathname === '/workflows/hourly-matchday') {
        const input = parseHourlyMatchdayInput(request.body);
        const result = await hourlyMatchdayWorkflow(input, deps);
        return jsonResponse(200, { status: 'ok', result });
      }
      const input = parseWebhookCompletedInput(request.body);
      if (!input) {
        return jsonResponse(400, {
          status: 'bad_request',
          reason: 'missing_fixture_id_or_provider_id',
        });
      }
      const result = await webhookCompletedWorkflow(input, deps);
      return jsonResponse(200, { status: 'ok', result });
    } catch (err) {
      return jsonResponse(500, {
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
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
