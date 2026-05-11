import { describe, expect, it, vi } from 'vitest';

import type { GamewireWorkerConfig } from './config.js';
import { fetchApiFootballJson, summarizeProviderJson } from './provider-http.js';

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
    });
    expect(result.request.redactedHeaders['x-apisports-key']).toBe('[REDACTED]');
    expect(result.response?.durationMs).toBe(42);
    expect(JSON.stringify(result.request)).not.toContain('sample-api-football-key');
    expect(JSON.stringify(result.runtime)).not.toContain('sample-api-football-key');
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
