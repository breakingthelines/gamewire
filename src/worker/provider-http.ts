import type { ApiFootballEnvelope } from '../adapters/api-football/index.js';
import type { GamewireWorkerConfig } from './config.js';
import { createProviderRuntimeReport, type ProviderRuntimeReport } from './runtime.js';

export interface ProviderFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

export type ProviderFetch = (
  input: string | URL,
  init?: {
    readonly method?: 'GET';
    readonly headers?: Record<string, string>;
  }
) => Promise<ProviderFetchResponse>;

export type ProviderJsonFetchStatus = 'skipped' | 'fetched' | 'failed';
export type ProviderJsonFetchSkipReason =
  | 'replay_mode'
  | 'missing_api_key'
  | 'unsupported_provider';

export interface ProviderJsonFetchOptions {
  readonly config: GamewireWorkerConfig;
  readonly workload: string;
  readonly resourceId: string;
  readonly replayId: string;
  readonly path?: string;
  readonly fetchFn?: ProviderFetch;
  readonly clock?: () => number;
}

export interface ProviderJsonFetchResult<TResponse = unknown> {
  readonly status: ProviderJsonFetchStatus;
  readonly skipReason?: ProviderJsonFetchSkipReason;
  readonly runtime: ProviderRuntimeReport;
  readonly request: {
    readonly method: 'GET';
    readonly url: string;
    readonly redactedHeaders: Record<string, string>;
  };
  readonly response?: {
    readonly status: number;
    readonly ok: boolean;
    readonly contentType?: string;
    readonly durationMs: number;
  };
  readonly json?: ApiFootballEnvelope<TResponse> | unknown;
  readonly error?: {
    readonly message: string;
  };
}

export interface ProviderJsonSummary {
  readonly rootType: 'array' | 'object' | 'null' | 'primitive';
  readonly topLevelKeys: readonly string[];
  readonly results?: number;
  readonly responseType?: 'array' | 'object' | 'null' | 'primitive';
  readonly responseKeys?: readonly string[];
  readonly responseLength?: number;
}

const API_FOOTBALL_HEADER = 'x-apisports-key';
const DEFAULT_API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';

export async function fetchApiFootballJson<TResponse = unknown>(
  options: ProviderJsonFetchOptions
): Promise<ProviderJsonFetchResult<TResponse>> {
  const cfg = options.config;
  const runtime = createProviderRuntimeReport({
    provider: cfg.providerId,
    mode: cfg.providerMode,
    workload: options.workload,
    resourceId: options.resourceId,
    replayId: options.replayId,
    path: options.path,
    relatedPaths: options.path ? [options.path] : undefined,
  });
  const request = {
    method: 'GET' as const,
    url: '',
    redactedHeaders: redactedHeaders(),
  };

  if (normaliseProvider(cfg.providerId) !== 'api-football') {
    return { status: 'skipped', skipReason: 'unsupported_provider', runtime, request };
  }

  if (cfg.providerMode !== 'live') {
    return { status: 'skipped', skipReason: 'replay_mode', runtime, request };
  }

  if (!cfg.providerApiKey) {
    return { status: 'skipped', skipReason: 'missing_api_key', runtime, request };
  }

  const clock = options.clock ?? Date.now;
  const startedAt = clock();

  try {
    const url = buildProviderUrl(cfg.providerBaseUrl, runtime.request.path);
    const fetchFn = options.fetchFn ?? defaultFetch;
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        [API_FOOTBALL_HEADER]: cfg.providerApiKey,
      },
    });
    const json = (await response.json()) as ApiFootballEnvelope<TResponse> | unknown;

    return {
      status: 'fetched',
      runtime,
      request: {
        ...request,
        url: url.toString(),
      },
      response: {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type') ?? undefined,
        durationMs: Math.max(0, clock() - startedAt),
      },
      json,
    };
  } catch (error) {
    return {
      status: 'failed',
      runtime,
      request,
      error: {
        message: redactSecret(
          error instanceof Error ? error.message : String(error),
          cfg.providerApiKey
        ),
      },
    };
  }
}

export function summarizeProviderJson(json: unknown): ProviderJsonSummary {
  const rootType = jsonType(json);
  if (!isRecord(json)) {
    return { rootType, topLevelKeys: [] };
  }

  const response = json.response;
  const responseType = jsonType(response);
  const responseKeys = isRecord(response) ? Object.keys(response).sort() : undefined;
  const responseLength = Array.isArray(response) ? response.length : undefined;
  const results = typeof json.results === 'number' ? json.results : undefined;

  return {
    rootType,
    topLevelKeys: Object.keys(json).sort(),
    results,
    responseType,
    responseKeys,
    responseLength,
  };
}

function buildProviderUrl(baseUrl: string | undefined, path: string): URL {
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error('Provider request path must be relative');
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalizedPath, baseUrl ?? DEFAULT_API_FOOTBALL_BASE_URL);
}

const defaultFetch: ProviderFetch = async (input, init) => fetch(input, init);

function redactedHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    [API_FOOTBALL_HEADER]: '[REDACTED]',
  };
}

function normaliseProvider(providerId: string): string {
  return providerId.trim().toLowerCase().replace(/_/g, '-');
}

function redactSecret(message: string, secret: string | undefined): string {
  return secret ? message.replaceAll(secret, '[REDACTED]') : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonType(value: unknown): ProviderJsonSummary['rootType'] {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object') {
    return 'object';
  }

  return 'primitive';
}
