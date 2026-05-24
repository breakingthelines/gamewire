import {
  AUTH_CONTEXT_HEADER,
  MESH_AUTH_CONTEXT_HEADER,
  verifyAuthContextHeader,
  type Verifier,
} from './auth-context.js';
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
  /**
   * When set, the response body is streamed as NDJSON: one JSON object per
   * line, written via Transfer-Encoding: chunked. Used by `/workflows/*`
   * endpoints so each chunk resets the upstream Envoy HCM
   * `stream_idle_timeout` (default 5m) during long-running workflows. See
   * {@link startWorkflowStream} for the event shape; the final line always
   * has `event: 'completed'` and carries `{status, result?, reason?}`.
   */
  stream?: AsyncIterable<Record<string, unknown>>;
}

const jsonResponse = (status: number, body: Record<string, unknown>): WorkerHttpResponse => ({
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body,
});

/**
 * Heartbeat cadence for `/workflows/*` NDJSON streams. The Envoy HCM
 * `stream_idle_timeout` default is 300s and Consul Connect does not expose it
 * via service-resolver / service-defaults (the property-override Envoy
 * extension cannot index into the repeated HCM filter array, see
 * infrastructure PRs #24/#26). A pre-stream synchronous response would
 * therefore be cut at 5m even when the workflow is making progress. By
 * emitting a heartbeat line every 30s — well under any reasonable proxy
 * idle timer and an order of magnitude under Envoy's default — every layer
 * between gamewire-worker and the kernel HTTP client sees continuous
 * activity for the lifetime of the workflow.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Bounded async queue used by {@link startWorkflowStream} to bridge the
 * synchronous {@link WorkflowLogger} callback (called from inside the
 * workflow) and the asynchronous NDJSON iterator (consumed by the HTTP
 * server). Push never blocks; iterator next() blocks only when the queue
 * is empty and the producer has not yet closed it.
 */
class WorkflowStreamQueue implements AsyncIterable<Record<string, unknown>> {
  private readonly queue: Record<string, unknown>[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }
    this.queue.push(item);
    this.wake();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return {
      next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
        while (this.queue.length === 0 && !this.closed) {
          await new Promise<void>((resolve) => {
            this.waiter = resolve;
          });
        }
        if (this.queue.length > 0) {
          return { value: this.queue.shift()!, done: false };
        }
        return { value: undefined as never, done: true };
      },
    };
  }
}

type WorkflowName = 'daily-anchor' | 'hourly-matchday' | 'webhook-completed';

/**
 * Run a workflow in the background and expose its progress as an NDJSON
 * AsyncIterable. Each line on the wire is either:
 *
 *   - a {@link WorkflowLogEntry} forwarded verbatim from the workflow
 *   - a `{event: 'heartbeat', workflow, ts}` keepalive every 30s
 *   - a single `{event: 'completed', workflow, status: 'ok'|'error', result?,
 *     reason?}` line that always closes the stream
 *
 * The handler still returns 200 even when the workflow throws; the error is
 * carried in the trailing `completed` line so the HTTP status reflects "the
 * stream was established" rather than "the workflow result". Kernel-side
 * activity logic in `internal/activityimpl/game_backfill.go` reads the
 * trailing line and treats `status: 'error'` as a retryable failure, which
 * matches the pre-streaming 500-with-body behaviour.
 */
const startWorkflowStream = <T>(args: {
  workflow: WorkflowName;
  baseLogger: WorkflowLogger | undefined;
  run: (logger: WorkflowLogger) => Promise<T>;
}): AsyncIterable<Record<string, unknown>> => {
  const queue = new WorkflowStreamQueue();

  const streamLogger: WorkflowLogger = (entry) => {
    if (args.baseLogger) {
      try {
        args.baseLogger(entry);
      } catch {
        // Never let a downstream logger failure break workflow execution.
      }
    }
    queue.push({ ...entry });
  };

  const heartbeat = setInterval(() => {
    queue.push({
      event: 'heartbeat',
      workflow: args.workflow,
      ts: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === 'function') {
    heartbeat.unref();
  }

  void args
    .run(streamLogger)
    .then((result) => {
      queue.push({
        event: 'completed',
        workflow: args.workflow,
        status: 'ok',
        result: result as Record<string, unknown>,
      });
    })
    .catch((err: unknown) => {
      queue.push({
        event: 'completed',
        workflow: args.workflow,
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      clearInterval(heartbeat);
      queue.close();
    });

  return queue;
};

const streamingResponse = (
  stream: AsyncIterable<Record<string, unknown>>
): WorkerHttpResponse => ({
  status: 200,
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    // node:http sets Transfer-Encoding: chunked automatically when we
    // omit Content-Length and call response.write() before response.end().
  },
  body: {},
  stream,
});

export interface WorkerHttpHandlerOptions {
  readonly fetchProvider?: ProviderFetch;
  readonly ingestion?: ApiFootballIngestionLoop;
  readonly competitions?: readonly CompetitionEntry[];
  readonly workflowLogger?: WorkflowLogger;
  /**
   * btl-auth-context verifier built at boot via
   * {@link createAuthContextVerifier}. Required for `/workflows/*`
   * endpoints; other endpoints (health, metrics, smoke) ignore it.
   */
  readonly authContextVerifier?: Verifier;
}

const readHeader = (
  headers: Record<string, string | undefined> | undefined,
  name: string
): string | undefined => {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()];
};

interface WorkflowAuthOutcome {
  readonly authorised: boolean;
  readonly response?: WorkerHttpResponse;
  readonly reasonForLog?: string;
}

/**
 * Authorise a `/workflows/*` POST request.
 *
 * The only accepted credential is a verified service-principal
 * auth-context header that satisfies the configured audience + required
 * scope claims and is signed by an Ed25519 key in the trusted JWKS set.
 * The verifier is built once at boot; absence here is a misconfiguration
 * and surfaces as 401.
 *
 * Two header names are recognised, in order of preference:
 *
 *   1. `x-btl-auth-context` — the canonical mesh header. auth-service
 *      ext_authz inline-mints this header from the SPIFFE peer identity
 *      and Envoy injects it on the downstream request (see
 *      auth-service `extauthz_mesh.go`). gamewire-worker is a pure mesh
 *      consumer (kernel → mesh → gamewire-worker) so this is the
 *      expected source of truth.
 *
 *   2. `btl-auth-context` — the user-flow header. Accepted as a
 *      defence-in-depth fallback so deployments still in transition
 *      (e.g. a caller that mints client-side) keep working. The
 *      service-principal verifier still requires SERVICE subject + the
 *      audience/scope claims, so a leaked user `btl-auth-context` cannot
 *      authorise a workflow.
 *
 * The `reasonForLog` is the verbose verifier-side reason — the body
 * returned to the client carries only `bad_auth_context` so we don't
 * oracle-leak which claim failed.
 */
const authoriseWorkflowRequest = (
  cfg: GamewireWorkerConfig,
  headers: Record<string, string | undefined> | undefined,
  authContextVerifier: Verifier | undefined
): WorkflowAuthOutcome => {
  if (!authContextVerifier) {
    return {
      authorised: false,
      reasonForLog: 'verifier_not_configured',
      response: jsonResponse(401, {
        status: 'unauthorized',
        reason: 'verifier_not_configured',
      }),
    };
  }

  const authContextHeader =
    readHeader(headers, MESH_AUTH_CONTEXT_HEADER) ?? readHeader(headers, AUTH_CONTEXT_HEADER);
  const result = verifyAuthContextHeader(
    authContextVerifier,
    authContextHeader,
    cfg.authContextAudience,
    cfg.authContextRequiredScope
  );
  if (result.ok) {
    return { authorised: true };
  }
  return {
    authorised: false,
    reasonForLog: `auth_context:${result.error}`,
    response: jsonResponse(401, {
      status: 'unauthorized',
      reason: 'bad_auth_context',
    }),
  };
};

const workflowNameFromPath = (
  pathname: string
): 'daily-anchor' | 'hourly-matchday' | 'webhook-completed' => {
  if (pathname === '/workflows/hourly-matchday') {
    return 'hourly-matchday';
  }
  if (pathname === '/workflows/webhook-completed') {
    return 'webhook-completed';
  }
  return 'daily-anchor';
};

const buildWorkflowDeps = (options: WorkerHttpHandlerOptions): WorkflowDeps | undefined => {
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
    const auth = authoriseWorkflowRequest(cfg, request.headers, options.authContextVerifier);
    if (!auth.authorised) {
      if (options.workflowLogger && auth.reasonForLog) {
        // Log the verbose reason so ops can debug 401s without leaking
        // claim-level detail back to the caller.
        options.workflowLogger({
          event: 'workflow-auth-rejected',
          workflow: workflowNameFromPath(request.pathname),
          reason: auth.reasonForLog,
          message: `gamewire-worker workflow auth rejected: ${auth.reasonForLog}`,
        });
      }
      return auth.response ?? jsonResponse(401, { status: 'unauthorized' });
    }
    const baseDeps = buildWorkflowDeps(options);
    if (!baseDeps) {
      return jsonResponse(503, {
        status: 'unavailable',
        reason: 'ingestion_not_started',
      });
    }
    const workflowName = workflowNameFromPath(request.pathname);

    if (request.pathname === '/workflows/webhook-completed') {
      const input = parseWebhookCompletedInput(request.body);
      if (!input) {
        return jsonResponse(400, {
          status: 'bad_request',
          reason: 'missing_fixture_id_or_provider_id',
        });
      }
      return streamingResponse(
        startWorkflowStream({
          workflow: workflowName,
          baseLogger: options.workflowLogger,
          run: (logger) => webhookCompletedWorkflow(input, { ...baseDeps, logger }),
        })
      );
    }

    if (request.pathname === '/workflows/hourly-matchday') {
      const input = parseHourlyMatchdayInput(request.body);
      return streamingResponse(
        startWorkflowStream({
          workflow: workflowName,
          baseLogger: options.workflowLogger,
          run: (logger) => hourlyMatchdayWorkflow(input, { ...baseDeps, logger }),
        })
      );
    }

    // daily-anchor
    const input = parseDailyAnchorInput(request.body);
    return streamingResponse(
      startWorkflowStream({
        workflow: workflowName,
        baseLogger: options.workflowLogger,
        run: (logger) => dailyAnchorWorkflow(input, { ...baseDeps, logger }),
      })
    );
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
