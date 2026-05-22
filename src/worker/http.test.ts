import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { GamewireWorkerConfig } from './config.js';
import { activityNames, handleWorkerRequest } from './http.js';
import type {
  ApiFootballIngestionLoop,
  IngestionFetchOptions,
  IngestionFetchResult,
} from './ingestion.js';
import type { ProviderQuotaSnapshot } from './quota.js';
import type { CompetitionEntry } from '../workflows/index.js';

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
  redisNamespace: 'gamewire',
  providerHardCap: 70_000,
  providerSoftCap: 60_000,
  ingestionEnabled: false,
  bootstrapFixtureIds: [],
  ingestionRunImmediateTick: false,
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

describe('gamewire-worker workflow endpoints', () => {
  const SECRET = 'unit-test-secret';
  const sign = (rawBody: string): string =>
    createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');

  const baseQuota = (): ProviderQuotaSnapshot => ({
    provider: 'api-football',
    window: '2026-05-22',
    calls: 100,
    softCap: 60_000,
    hardCap: 70_000,
    cachedOnlyMode: false,
    posture: 'normal',
  });

  const buildResult = (options: IngestionFetchOptions): IngestionFetchResult => ({
    status: 'fetched',
    workload: options.workload,
    resourceId: options.resourceId,
    cacheKey: `${options.workload}:${options.resourceId}`,
    cacheHit: false,
    cachedOnlyMode: false,
    quota: baseQuota(),
    data: { response: [] },
  });

  const buildIngestion = (): ApiFootballIngestionLoop =>
    ({
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => buildResult(options)),
    }) as unknown as ApiFootballIngestionLoop;

  const COMPETITION: CompetitionEntry = {
    key: 'unit-test',
    label: 'Unit Test League',
    apiFootballLeagueId: 9999,
    season: 2025,
    calendar: [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }],
    tier: 'domestic',
  };

  it('rejects /workflows/* when GAMEWIRE_WORKFLOW_SECRET is unset', async () => {
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'x-gamewire-workflow-hmac': sign('{}') },
      },
      config,
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 'unauthorized',
      reason: 'workflow_secret_unset',
    });
  });

  it('rejects /workflows/* when the HMAC header is missing', async () => {
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: {},
      },
      { ...config, workflowSecret: SECRET },
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ status: 'unauthorized', reason: 'bad_hmac' });
  });

  it('rejects /workflows/* when the HMAC header does not match', async () => {
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'x-gamewire-workflow-hmac': 'deadbeef' },
      },
      { ...config, workflowSecret: SECRET },
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(401);
  });

  it('runs daily-anchor when HMAC is valid', async () => {
    const rawBody = JSON.stringify({ nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] });
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { 'x-gamewire-workflow-hmac': sign(rawBody) },
      },
      { ...config, workflowSecret: SECRET },
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      result: {
        competitions: [{ competition: 'unit-test' }],
      },
    });
  });

  it('runs hourly-matchday when HMAC is valid', async () => {
    const rawBody = JSON.stringify({ nowUtc: '2026-05-23T15:00:00Z' });
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/hourly-matchday',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { 'x-gamewire-workflow-hmac': sign(rawBody) },
      },
      { ...config, workflowSecret: SECRET },
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      result: { inWindow: ['unit-test'] },
    });
  });

  it('runs webhook-completed when HMAC is valid', async () => {
    const rawBody = JSON.stringify({ providerId: 'api-football', fixtureId: '12345' });
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/webhook-completed',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { 'x-gamewire-workflow-hmac': sign(rawBody) },
      },
      { ...config, workflowSecret: SECRET },
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      result: { fixtureId: '12345', status: 'completed' },
    });
  });

  it('returns 400 when webhook-completed body is missing required fields', async () => {
    const rawBody = JSON.stringify({});
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/webhook-completed',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { 'x-gamewire-workflow-hmac': sign(rawBody) },
      },
      { ...config, workflowSecret: SECRET },
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(400);
  });

  it('returns 503 when ingestion is not started', async () => {
    const rawBody = '{}';
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody,
        headers: { 'x-gamewire-workflow-hmac': sign(rawBody) },
      },
      { ...config, workflowSecret: SECRET },
      {}
    );
    expect(response.status).toBe(503);
  });
});
