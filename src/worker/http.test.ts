import { describe, expect, it } from 'vitest';

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
  it('serves health checks', () => {
    const response = handleWorkerRequest({ method: 'GET', pathname: '/health' }, config);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'gamewire-worker',
      provider: 'api-football',
    });
  });

  it('accepts webhook requests as replay-safe work only', () => {
    const response = handleWorkerRequest(
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

  it('rejects unknown routes', () => {
    const response = handleWorkerRequest({ method: 'GET', pathname: '/missing' }, config);

    expect(response.status).toBe(404);
  });
});
