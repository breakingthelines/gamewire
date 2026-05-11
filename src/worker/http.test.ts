import { describe, expect, it, vi } from 'vitest';

import type { GamewireWorkerConfig } from './config.js';
import { activityNames, handleWorkerRequest } from './http.js';

const config: GamewireWorkerConfig = {
  port: 8095,
  gameServiceUrl: 'http://game-service:9090',
  identityServiceUrl: 'http://identity:9090',
  providerId: 'api-football',
  providerKind: 'football',
  providerMode: 'replay',
  identityProviderId: 'identity-data-football',
  webhookPath: '/webhooks/gamewire',
  logLevel: 'info',
};

describe('gamewire-worker HTTP handler', () => {
  it('serves health checks', async () => {
    const response = await handleWorkerRequest({ method: 'GET', pathname: '/health' }, config);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'gamewire-worker',
      provider: 'api-football',
    });
  });

  it('accepts webhook requests as replay-safe work only', async () => {
    const response = await handleWorkerRequest(
      { method: 'POST', pathname: '/webhooks/gamewire', body: { fixture: 'stub' } },
      config
    );

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: 'accepted',
      behavior: 'replay-safe',
      activities: [...activityNames],
    });
  });

  it('plans provider smoke checks without live calls in replay mode', async () => {
    const fetchProvider = vi.fn();
    const response = await handleWorkerRequest(
      { method: 'GET', pathname: '/provider/smoke' },
      config,
      { fetchProvider }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'skipped',
      skipReason: 'replay_mode',
      provider: 'api-football',
      providerMode: 'replay',
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it('runs a live provider smoke check with redacted output', async () => {
    const fetchProvider = vi.fn().mockResolvedValue({
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
          requests: {},
        },
      }),
    });
    const response = await handleWorkerRequest(
      { method: 'GET', pathname: '/provider/smoke' },
      {
        ...config,
        providerMode: 'live',
        providerApiKey: 'super-secret-test-key',
        providerBaseUrl: 'https://provider.example.test',
      },
      { fetchProvider }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'fetched',
      request: {
        method: 'GET',
        url: 'https://provider.example.test/status',
        redactedHeaders: {
          'x-apisports-key': '[REDACTED]',
        },
      },
      jsonSummary: {
        topLevelKeys: ['get', 'response', 'results'],
        responseKeys: ['account', 'requests'],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('super-secret-test-key');
  });

  it('rejects unknown routes', async () => {
    const response = await handleWorkerRequest({ method: 'GET', pathname: '/missing' }, config);

    expect(response.status).toBe(404);
  });
});
