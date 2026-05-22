import { generateKeyPairSync, sign as ed25519Sign, type KeyObject } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { Verifier } from './auth-context.js';
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
  authContextJwksUrl: 'https://auth.test/.well-known/jwks.json',
  authContextIssuer: 'auth-service-test',
  authContextAudience: 'gamewire-worker',
  authContextRequiredScope: 'gamewire.workflow.invoke',
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

describe('gamewire-worker workflow endpoints (btl-auth-context)', () => {
  // Crib of the keypair + token-build helpers from auth-sdk/server.test.ts.
  // We don't depend on the sdk's test fixtures because they're not
  // shipped in the published package; reconstructing them locally keeps
  // the gamewire tests self-contained.
  const ISSUER = config.authContextIssuer;
  const AUDIENCE = config.authContextAudience;
  const SCOPE = config.authContextRequiredScope;

  const base64Url = (input: Buffer | string): string => {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const signToken = (privateKey: KeyObject, payload: Record<string, unknown>): string => {
    const header = { alg: 'EdDSA', typ: 'JWT', kid: 'btl-auth-context-ed25519' };
    const headerB64 = base64Url(JSON.stringify(header));
    const payloadB64 = base64Url(JSON.stringify(payload));
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = ed25519Sign(null, signingInput, privateKey);
    return `${headerB64}.${payloadB64}.${base64Url(signature)}`;
  };

  const defaultServicePayload = (
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      sub: 'spiffe://dc1.consul/ns/default/dc/dc1/svc/kernel-service',
      iat: now,
      exp: now + 3600,
      subject_type: 'SUBJECT_TYPE_SERVICE',
      service_principal: {
        service_name: 'kernel-service',
        instance_id: 'kernel-7',
        mesh_principal: 'spiffe://dc1.consul/ns/default/dc/dc1/svc/kernel-service',
        granted_scopes: [SCOPE],
        audience: AUDIENCE,
      },
      capabilities: [],
      roles: [],
      squad_ids: [],
      email_verified: false,
      ...overrides,
    };
  };

  const defaultUserPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      sub: 'user:abc123',
      iat: now,
      exp: now + 3600,
      subject_type: 'SUBJECT_TYPE_USER',
      subject_user_id: 'abc123',
      session_id: 'sess-1',
      capabilities: ['read.basic'],
      roles: ['FAN'],
      squad_ids: [],
      email_verified: true,
      ...overrides,
    };
  };

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

  const makeVerifier = (): { verifier: Verifier; privateKey: KeyObject } => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { verifier: new Verifier({ publicKey, issuer: ISSUER }), privateKey };
  };

  it('runs daily-anchor when btl-auth-context is valid', async () => {
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const rawBody = JSON.stringify({ nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] });
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      result: { competitions: [{ competition: 'unit-test' }] },
    });
  });

  it('runs hourly-matchday when btl-auth-context is valid', async () => {
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const rawBody = JSON.stringify({ nowUtc: '2026-05-23T15:00:00Z' });
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/hourly-matchday',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      result: { inWindow: ['unit-test'] },
    });
  });

  it('runs webhook-completed when btl-auth-context is valid', async () => {
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const rawBody = JSON.stringify({ providerId: 'api-football', fixtureId: '12345' });
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/webhook-completed',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      result: { fixtureId: '12345', status: 'completed' },
    });
  });

  it('returns 400 when webhook-completed body is missing required fields', async () => {
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/webhook-completed',
        body: {},
        rawBody: '{}',
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(400);
  });

  it('returns 503 when ingestion is not started', async () => {
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'btl-auth-context': token },
      },
      config,
      { authContextVerifier: verifier }
    );
    expect(response.status).toBe(503);
  });

  it('rejects with verifier_not_configured when no verifier is wired in', async () => {
    // Single-mode boot guarantees the verifier is always present in prod
    // (boot fails otherwise). This test pins the defensive HTTP-layer
    // behaviour for the case where the handler is invoked without an
    // `authContextVerifier` option — e.g. by a future caller that forgets
    // to pass it. The client gets a 401 with the same shape as a bad
    // token; only the verbose log carries `verifier_not_configured`.
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: {},
      },
      config,
      { ingestion: buildIngestion(), competitions: [COMPETITION] }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 'unauthorized',
      reason: 'verifier_not_configured',
    });
  });

  it('rejects with bad_auth_context when the btl-auth-context header is missing', async () => {
    const { verifier } = makeVerifier();
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: {},
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 'unauthorized',
      reason: 'bad_auth_context',
    });
  });

  it('rejects a btl-auth-context signed by an untrusted key', async () => {
    const { verifier } = makeVerifier();
    const attackerKeys = generateKeyPairSync('ed25519');
    const forgedToken = signToken(attackerKeys.privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'btl-auth-context': forgedToken },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 'unauthorized',
      reason: 'bad_auth_context',
    });
  });

  it('rejects btl-auth-context with the wrong audience', async () => {
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(
      privateKey,
      defaultServicePayload({
        service_principal: {
          service_name: 'kernel-service',
          granted_scopes: [SCOPE],
          audience: 'some-other-worker',
        },
      })
    );

    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 'unauthorized',
      reason: 'bad_auth_context',
    });
  });

  it('rejects btl-auth-context that is missing the required scope', async () => {
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(
      privateKey,
      defaultServicePayload({
        service_principal: {
          service_name: 'kernel-service',
          granted_scopes: ['some.other.scope'],
          audience: AUDIENCE,
        },
      })
    );

    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 'unauthorized',
      reason: 'bad_auth_context',
    });
  });

  it('rejects a USER btl-auth-context (only SERVICE subjects allowed)', async () => {
    const { verifier, privateKey } = makeVerifier();
    const userToken = signToken(privateKey, defaultUserPayload());

    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'btl-auth-context': userToken },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 'unauthorized',
      reason: 'bad_auth_context',
    });
  });

  it('logs the verbose verifier reason via workflowLogger on 401', async () => {
    const { verifier } = makeVerifier();
    const attackerKeys = generateKeyPairSync('ed25519');
    const forgedToken = signToken(attackerKeys.privateKey, defaultServicePayload());

    const workflowLogger = vi.fn();

    await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { 'btl-auth-context': forgedToken },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
        workflowLogger,
      }
    );
    expect(workflowLogger).toHaveBeenCalledTimes(1);
    const entry = workflowLogger.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry.event).toBe('workflow-auth-rejected');
    expect(entry.workflow).toBe('daily-anchor');
    expect(String(entry.reason)).toMatch(/^auth_context:/);
  });
});
