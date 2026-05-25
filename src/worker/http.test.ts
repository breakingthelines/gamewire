import { generateKeyPairSync, sign as ed25519Sign, type KeyObject } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { MESH_AUTH_CONTEXT_HEADER, Verifier } from './auth-context.js';
import type { GamewireWorkerConfig } from './config.js';
import { activityNames, handleWorkerRequest, type WorkerHttpResponse } from './http.js';
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

  // Workflow endpoints stream their progress as NDJSON (one JSON object per
  // line) so each chunk resets Envoy's HCM stream_idle_timeout during long
  // workflow legs. The stream ends with a single `event: 'completed'` line
  // that carries the workflow outcome. These helpers consume the stream
  // synchronously in tests where the mocked ingestion resolves immediately.
  const collectStream = async (
    response: WorkerHttpResponse
  ): Promise<Record<string, unknown>[]> => {
    if (!response.stream) {
      return [];
    }
    const out: Record<string, unknown>[] = [];
    for await (const line of response.stream) {
      out.push(line);
    }
    return out;
  };

  const finalCompleted = async (response: WorkerHttpResponse): Promise<Record<string, unknown>> => {
    const lines = await collectStream(response);
    let completed: Record<string, unknown> | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].event === 'completed') {
        completed = lines[i];
        break;
      }
    }
    if (!completed) {
      throw new Error(`workflow stream ended without a 'completed' line: ${JSON.stringify(lines)}`);
    }
    return completed;
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
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(await finalCompleted(response)).toMatchObject({
      event: 'completed',
      workflow: 'daily-anchor',
      status: 'ok',
      result: { competitions: [{ competition: 'unit-test' }] },
    });
  });

  it('streams workflow logger events as NDJSON before the completed line', async () => {
    // The whole point of the streaming response is real-time progress so the
    // upstream Envoy HCM stream_idle_timeout (default 5m) cannot fire while
    // the workflow is making progress. This test pins the contract:
    //
    //   1. Response is 200 with application/x-ndjson content-type.
    //   2. Each WorkflowLogger entry appears as its own line in the stream.
    //   3. A single `event: 'completed'` line ends the stream and carries the
    //      workflow result.
    //
    // Regressions in any of those three would re-expose the 5m-cutoff bug
    // even though the unit test would still see a "successful" workflow.
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: { nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] },
        rawBody: JSON.stringify({
          nowUtc: '2026-05-23T02:00:00Z',
          competitions: ['unit-test'],
        }),
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
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(response.stream).toBeDefined();

    const lines = await collectStream(response);

    // daily-anchor.ts emits started → finished (and conditionally aborted)
    // before completing. The exact intermediate set is fragile to track —
    // pin only that started and finished show up before the completed line.
    const eventNames = lines.map((line) => line.event);
    expect(eventNames).toContain('daily_anchor.started');
    expect(eventNames).toContain('daily_anchor.finished');
    expect(eventNames[eventNames.length - 1]).toBe('completed');

    const completed = lines[lines.length - 1]!;
    expect(completed).toMatchObject({
      event: 'completed',
      workflow: 'daily-anchor',
      status: 'ok',
    });
  });

  it('still forwards workflow logger events to the base logger while streaming', async () => {
    // The base workflowLogger (wired in server.ts to console.log structured
    // events) must keep receiving every entry — otherwise we lose the
    // ops-visible stdout trail that observability scrapes today. The stream
    // is the wire format; the base logger is the persistent record.
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const workflowLogger = vi.fn();
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: { nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] },
        rawBody: JSON.stringify({
          nowUtc: '2026-05-23T02:00:00Z',
          competitions: ['unit-test'],
        }),
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
        workflowLogger,
      }
    );
    // Drain the stream so the workflow runs to completion.
    await collectStream(response);

    const baseEvents = workflowLogger.mock.calls.map(
      (call) => (call[0] as { event: string }).event
    );
    expect(baseEvents).toContain('daily_anchor.started');
    expect(baseEvents).toContain('daily_anchor.finished');
    // The synthetic stream-only events (`heartbeat`, `completed`) must NOT
    // leak into the base logger — they are wire-level framing, not domain
    // events worth persisting to structured logs.
    expect(baseEvents).not.toContain('heartbeat');
    expect(baseEvents).not.toContain('completed');
  });

  it('strips per-fetch debug detail from the daily-anchor wire result', async () => {
    // Provider-specific raw response data (IngestionFetchResult.data /
    // .fetch) must not cross the NDJSON wire. On 2026-05-25 a Phase A
    // cold-cache daily-anchor sweep produced a completed line over
    // kernel-side bufio.Scanner.MaxScanTokenSize, failing the activity
    // deterministically. The fix is dailyAnchorToWire in workflows/wire.ts;
    // this test pins the contract so future workflow output additions
    // don't accidentally re-leak heavy fields onto the wire.
    //
    // We embed a uniquely-identifiable provider blob in the mocked
    // ingestion result and assert (a) the completed line's per-competition
    // entry has no `fetches` key, and (b) the marker string appears
    // nowhere in the serialised completed payload.
    const HEAVY_MARKER = 'HEAVY_PROVIDER_PAYLOAD_MUST_NOT_REACH_WIRE';
    const heavyIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => ({
        ...buildResult(options),
        data: { response: [{ id: 1, debug: HEAVY_MARKER }] },
      })),
    } as unknown as ApiFootballIngestionLoop;

    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: { nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] },
        rawBody: JSON.stringify({
          nowUtc: '2026-05-23T02:00:00Z',
          competitions: ['unit-test'],
        }),
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: heavyIngestion,
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);

    const completed = await finalCompleted(response);
    const result = completed.result as Record<string, unknown> | undefined;
    expect(result).toBeDefined();

    const competitions = (result?.competitions ?? []) as readonly Record<string, unknown>[];
    expect(competitions.length).toBeGreaterThan(0);
    for (const competition of competitions) {
      expect(competition).not.toHaveProperty('fetches');
      expect(competition).toHaveProperty('competition');
      expect(competition).toHaveProperty('callsUsed');
      expect(competition).toHaveProperty('callsBudgeted');
    }

    // Defence in depth: the marker must not have travelled through any
    // other field in the completed line either (covers future additions
    // like fetches-by-other-name or recursive nesting).
    expect(JSON.stringify(completed)).not.toContain(HEAVY_MARKER);
  });

  it('strips fetches from the webhook-completed wire result', async () => {
    // webhook-completed has fetches at the top level of its output
    // (one webhook = one fixture so there is no per-competition
    // nesting). Pin the same wire contract as daily-anchor.
    const HEAVY_MARKER = 'WEBHOOK_FIXTURE_PAYLOAD_MUST_NOT_REACH_WIRE';
    const heavyIngestion = {
      fetchWorkload: vi.fn(async (options: IngestionFetchOptions) => ({
        ...buildResult(options),
        data: { response: [{ fixture: 'x', debug: HEAVY_MARKER }] },
      })),
    } as unknown as ApiFootballIngestionLoop;

    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/webhook-completed',
        body: { providerId: 'api-football', fixtureId: '12345' },
        rawBody: JSON.stringify({ providerId: 'api-football', fixtureId: '12345' }),
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: heavyIngestion,
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);

    const completed = await finalCompleted(response);
    const result = completed.result as Record<string, unknown> | undefined;
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('fetches');
    expect(result).toHaveProperty('fixtureId', '12345');
    expect(result).toHaveProperty('providerId', 'api-football');
    expect(JSON.stringify(completed)).not.toContain(HEAVY_MARKER);
  });

  it('surfaces workflow exceptions as a status:error completed line', async () => {
    // Pre-streaming, a workflow throw bubbled out as HTTP 500 with the
    // message in the body. Streaming responds 200 (because the response
    // status is committed before the workflow finishes), and the kernel-side
    // activity reads the trailing `status: 'error'` line as a retryable
    // failure. This test pins the on-wire shape.
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const exploding = {
      fetchWorkload: vi.fn(async () => {
        throw new Error('synthetic ingestion failure');
      }),
    } as unknown as ApiFootballIngestionLoop;
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: { nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] },
        rawBody: JSON.stringify({
          nowUtc: '2026-05-23T02:00:00Z',
          competitions: ['unit-test'],
        }),
        headers: { 'btl-auth-context': token },
      },
      config,
      {
        ingestion: exploding,
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);
    const completed = await finalCompleted(response);
    expect(completed).toMatchObject({
      event: 'completed',
      workflow: 'daily-anchor',
      status: 'error',
    });
    expect(String(completed.reason)).toContain('synthetic ingestion failure');
  });

  it('runs daily-anchor when x-btl-auth-context (mesh-mint) is valid', async () => {
    // auth-service ext_authz inline-mints btl-auth-context for SPIFFE
    // mesh callers and Envoy forwards it as the downstream
    // x-btl-auth-context header. gamewire-worker is mesh-only so this is
    // the canonical authorisation path on staging/prod.
    const { verifier, privateKey } = makeVerifier();
    const token = signToken(privateKey, defaultServicePayload());
    const rawBody = JSON.stringify({ nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] });
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: JSON.parse(rawBody),
        rawBody,
        headers: { [MESH_AUTH_CONTEXT_HEADER]: token },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);
    expect(await finalCompleted(response)).toMatchObject({
      event: 'completed',
      status: 'ok',
      result: { competitions: [{ competition: 'unit-test' }] },
    });
  });

  it('prefers x-btl-auth-context over btl-auth-context when both are set', async () => {
    // Belt-and-braces: in practice auth-service mesh-mint skips when an
    // existing btl-auth-context is present, so both headers won't normally
    // appear together. If they do, the mesh header is authoritative
    // because it carries the verified SPIFFE-derived identity from the
    // current hop, whereas btl-auth-context may have travelled further
    // and be more stale.
    const { verifier, privateKey } = makeVerifier();
    const meshToken = signToken(privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: { nowUtc: '2026-05-23T02:00:00Z', competitions: ['unit-test'] },
        rawBody: JSON.stringify({
          nowUtc: '2026-05-23T02:00:00Z',
          competitions: ['unit-test'],
        }),
        headers: {
          [MESH_AUTH_CONTEXT_HEADER]: meshToken,
          'btl-auth-context': 'definitely-not-a-valid-token',
        },
      },
      config,
      {
        ingestion: buildIngestion(),
        competitions: [COMPETITION],
        authContextVerifier: verifier,
      }
    );
    expect(response.status).toBe(200);
    expect(await finalCompleted(response)).toMatchObject({ status: 'ok' });
  });

  it('rejects when x-btl-auth-context is signed by an untrusted key', async () => {
    // Mirror of the existing btl-auth-context untrusted-signer test, but
    // exercises the mesh header path so a typo in the new MESH_AUTH_CONTEXT_HEADER
    // wiring would surface as a 200 here.
    const { verifier } = makeVerifier();
    const attackerKeys = generateKeyPairSync('ed25519');
    const forgedToken = signToken(attackerKeys.privateKey, defaultServicePayload());
    const response = await handleWorkerRequest(
      {
        method: 'POST',
        pathname: '/workflows/daily-anchor',
        body: {},
        rawBody: '{}',
        headers: { [MESH_AUTH_CONTEXT_HEADER]: forgedToken },
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
    expect(await finalCompleted(response)).toMatchObject({
      event: 'completed',
      workflow: 'hourly-matchday',
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
    expect(await finalCompleted(response)).toMatchObject({
      event: 'completed',
      workflow: 'webhook-completed',
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
