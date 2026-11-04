import { describe, expect, it, vi } from 'vitest';

import type { GamewireWorkerConfig } from './config.js';
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  fetchApiFootballJson,
  parseRateLimitHeaders,
  summarizeProviderJson,
} from './provider-http.js';

const baseConfig: GamewireWorkerConfig = {
  port: 8095,
  gameServiceUrl: 'http://game-service:9090',
  identityServiceUrl: 'http://identity:9090',
  providerId: 'api-football',
  providerKind: 'football',
  providerMode: 'replay',
  providerBaseUrl: 'https://v3.football.api-sports.io',
  identityProviderId: 'identity-data-football',
  webhookPath: '/webhooks/gamewire',
  logLevel: 'info',
  redisNamespace: 'gamewire',
  providerHardCap: 70_000,
  providerSoftCap: 60_000,
  ingestionEnabled: false,
  providerFixtureResultsEnabled: false,
  bootstrapFixtureIds: [],
  ingestionRunImmediateTick: false,
  authContextJwksUrl: 'https://auth.test/.well-known/jwks.json',
  authContextIssuer: 'auth-service-test',
  authContextAudience: 'gamewire-worker',
  authContextRequiredScope: 'gamewire.workflow.invoke',
  // Asset mirror disabled (no content bucket) — irrelevant to these tests.
  assetMirror: { region: 'auto' },
};

describe('API-Football provider HTTP boundary', () => {
  it('keeps replay mode offline', async () => {
    const fetchFn = vi.fn();
    const result = await fetchApiFootballJson({
      config: baseConfig,
      workload: 'status',
      resourceId: 'account',
      replayId: 'replay-smoke',
      fetchFn,
    });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('replay_mode');
    expect(result.runtime.request.path).toBe('/status');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('requires a live API key before fetching', async () => {
    const fetchFn = vi.fn();
    const result = await fetchApiFootballJson({
      config: { ...baseConfig, providerMode: 'live' },
      workload: 'status',
      resourceId: 'account',
      replayId: 'missing-key-smoke',
      fetchFn,
    });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('missing_api_key');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends API-Football keys only as x-apisports-key and redacts reports', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({
        get: 'status',
        results: 1,
        response: {
          account: {},
        },
      }),
    });
    const result = await fetchApiFootballJson({
      config: {
        ...baseConfig,
        providerMode: 'live',
        providerApiKey: 'sample-api-football-key',
      },
      workload: 'status',
      resourceId: 'account',
      replayId: 'live-smoke',
      fetchFn,
      clock: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_042),
    });

    expect(result.status).toBe('fetched');
    expect(fetchFn).toHaveBeenCalledWith(new URL('https://v3.football.api-sports.io/status'), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-apisports-key': 'sample-api-football-key',
      },
      signal: expect.any(AbortSignal),
    });
    expect(result.request.redactedHeaders['x-apisports-key']).toBe('[REDACTED]');
    expect(result.response?.durationMs).toBe(42);
    expect(JSON.stringify(result.request)).not.toContain('sample-api-football-key');
    expect(JSON.stringify(result.runtime)).not.toContain('sample-api-football-key');
  });

  it('flags api-football rate-limit envelopes (HTTP 200 with errors.rateLimit) as rate_limited', async () => {
    // api-football's free + Pro plans return this shape on per-minute-cap
    // breach. The body MUST NOT be promoted to `fetched` because downstream
    // ingestion will cache the empty response array and poison every
    // subsequent read.
    const rateLimitedBody = {
      get: 'fixtures/statistics',
      parameters: { fixture: '1391188' },
      results: 0,
      response: [],
      errors: { rateLimit: 'Too many requests, retry in 1 minute' },
    };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => rateLimitedBody,
    });
    const result = await fetchApiFootballJson({
      config: {
        ...baseConfig,
        providerMode: 'live',
        providerApiKey: 'sample-api-football-key',
      },
      workload: 'team-match-stats',
      resourceId: '1391188',
      replayId: 'rate-limit-smoke',
      fetchFn,
    });

    expect(result.status).toBe('rate_limited');
    expect(result.rateLimitMessage).toBe('Too many requests, retry in 1 minute');
    expect(result.response?.status).toBe(200);
    expect(result.json).toEqual(rateLimitedBody);
  });

  it('treats normal HTTP 200 envelopes as fetched', async () => {
    const goodBody = {
      get: 'fixtures/statistics',
      parameters: { fixture: '1391188' },
      results: 2,
      response: [{ team: { id: 50 }, statistics: [] }],
      errors: [],
    };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => goodBody,
    });
    const result = await fetchApiFootballJson({
      config: {
        ...baseConfig,
        providerMode: 'live',
        providerApiKey: 'sample-api-football-key',
      },
      workload: 'team-match-stats',
      resourceId: '1391188',
      replayId: 'happy-path-smoke',
      fetchFn,
    });

    expect(result.status).toBe('fetched');
    expect(result.rateLimitMessage).toBeUndefined();
    expect(result.json).toEqual(goodBody);
  });

  it('does NOT misclassify `errors: []` (the empty-errors shape) as rate-limited', async () => {
    // Regression guard: api-football returns `errors: []` (an array) when there
    // are no errors. A naive `errors?.rateLimit` check on an array would still
    // be undefined and so behave correctly, but a "any non-empty errors object"
    // check would false-positive on legitimately empty results lists. Pin the
    // contract: only `errors` being a non-array object WITH a string
    // `rateLimit` key triggers the new branch.
    const emptyButValidBody = {
      get: 'fixtures/statistics',
      parameters: { fixture: '1538961' },
      results: 0,
      response: [],
      errors: [],
    };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => emptyButValidBody,
    });
    const result = await fetchApiFootballJson({
      config: {
        ...baseConfig,
        providerMode: 'live',
        providerApiKey: 'sample-api-football-key',
      },
      workload: 'team-match-stats',
      resourceId: '1538961',
      replayId: 'empty-but-valid-smoke',
      fetchFn,
    });

    expect(result.status).toBe('fetched');
    expect(result.rateLimitMessage).toBeUndefined();
  });

  it('summarizes provider JSON without echoing account values', () => {
    const summary = summarizeProviderJson({
      get: 'status',
      results: 1,
      response: {
        account: { email: 'ops@example.test' },
        requests: { current: 1 },
      },
    });

    expect(summary).toEqual({
      rootType: 'object',
      topLevelKeys: ['get', 'response', 'results'],
      results: 1,
      responseType: 'object',
      responseKeys: ['account', 'requests'],
      responseLength: undefined,
    });
    expect(JSON.stringify(summary)).not.toContain('ops@example.test');
  });
});

describe('API-Football request timeout', () => {
  const liveConfig = { ...baseConfig, providerMode: 'live' as const, providerApiKey: 'k-secret' };

  it('defaults to 10 seconds', () => {
    expect(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('aborts a request that never answers and reports it as failed', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: string | URL, init?: { readonly signal?: AbortSignal }) => {
      signal = init?.signal;
      return new Promise<never>(() => undefined);
    });
    const result = await fetchApiFootballJson({
      config: liveConfig,
      workload: 'status',
      resourceId: 'account',
      replayId: 'timeout',
      fetchFn,
      timeoutMs: 20,
    });
    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.error?.message).toBe('Provider request timed out after 20ms');
    expect(signal?.aborted).toBe(true);
  });

  it('times out a body that stalls after the headers', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => new Promise<never>(() => undefined),
    }));
    const result = await fetchApiFootballJson({
      config: { ...liveConfig, providerRequestTimeoutMs: 20 },
      workload: 'status',
      resourceId: 'account',
      replayId: 'timeout-body',
      fetchFn,
    });
    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(true);
  });

  it('a request that fails for another reason is not marked as timed out', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const result = await fetchApiFootballJson({
      config: liveConfig,
      workload: 'status',
      resourceId: 'account',
      replayId: 'reset',
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe('failed');
    expect(result.timedOut).toBeUndefined();
    expect(result.error?.message).toBe('connection reset');
  });
});

describe('API-Football quota headers', () => {
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });

  it('parses the daily and per-minute headers', () => {
    expect(
      parseRateLimitHeaders(
        headers({
          'x-ratelimit-requests-limit': '150000',
          'x-ratelimit-requests-remaining': '149123',
          'x-ratelimit-limit': '900',
          'x-ratelimit-remaining': '873',
        })
      )
    ).toEqual({
      dailyLimit: 150_000,
      dailyRemaining: 149_123,
      minuteLimit: 900,
      minuteRemaining: 873,
    });
  });

  it('returns undefined when no quota header is present', () => {
    expect(parseRateLimitHeaders(headers({ 'content-type': 'application/json' }))).toBeUndefined();
  });

  it('drops values that are not non-negative integers', () => {
    expect(
      parseRateLimitHeaders(
        headers({
          'x-ratelimit-requests-limit': 'unlimited',
          'x-ratelimit-requests-remaining': '-4',
          'x-ratelimit-remaining': ' 12 ',
        })
      )
    ).toEqual({
      dailyLimit: undefined,
      dailyRemaining: undefined,
      minuteLimit: undefined,
      minuteRemaining: 12,
    });
  });

  it('carries the parsed headers on fetched and rate-limited results', async () => {
    const quotaHeaders = headers({
      'content-type': 'application/json',
      'x-ratelimit-requests-limit': '150000',
      'x-ratelimit-requests-remaining': '100',
      'x-ratelimit-remaining': '0',
    });
    const config = { ...baseConfig, providerMode: 'live' as const, providerApiKey: 'k' };
    const fetched = await fetchApiFootballJson({
      config,
      workload: 'fixture-detail-live',
      resourceId: '1',
      replayId: 'r',
      path: '/fixtures?id=1',
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: quotaHeaders,
        json: async () => ({ response: [] }),
      }),
    });
    expect(fetched.status).toBe('fetched');
    expect(fetched.rateLimit?.dailyRemaining).toBe(100);

    const limited = await fetchApiFootballJson({
      config,
      workload: 'fixture-detail-live',
      resourceId: '1',
      replayId: 'r',
      path: '/fixtures?id=1',
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: quotaHeaders,
        json: async () => ({ response: [], errors: { rateLimit: 'Too many requests' } }),
      }),
    });
    expect(limited.status).toBe('rate_limited');
    expect(limited.rateLimit?.minuteRemaining).toBe(0);
  });
});
