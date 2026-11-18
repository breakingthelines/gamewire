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
import type {
  FootballGameIngestClient,
  FootballGameLookupClient,
  FootballGameMissingPayloadsClient,
  GameServiceProfileJobsClient,
  ProviderEnrichmentIngestClient,
} from './clients/game-service.js';
import type { ProviderCache } from './cache.js';
import {
  InMemoryRunStore,
  isValidIdempotencyKey,
  RunRegistry,
  type RunView,
  type StartRunOutcome,
} from './run-registry.js';
import type { ProviderMinuteLimiter } from './minute-limiter.js';
import type { FootballIdentityLookupClient } from './clients/identity.js';
import type { MediaObjectStore } from './asset-mirror.js';
import {
  fetchApiFootballJson,
  summarizeProviderJson,
  type ProviderFetch,
  type ProviderJsonFetchResult,
} from './provider-http.js';
import {
  competitionPayloadBackfillToWire,
  competitionPayloadBackfillWorkflow,
  dailyAnchorToWire,
  dailyAnchorWorkflow,
  hourlyMatchdayToWire,
  hourlyMatchdayWorkflow,
  identityGapScanToWire,
  identityGapScanWorkflow,
  MIN_PROVIDER_FIXTURE_RESULTS_SEASON,
  maxProviderFixtureResultsSeason,
  providerFixtureResultsToWire,
  providerFixtureResultsWorkflow,
  PROVIDER_ENRICHMENT_DATASETS,
  PROVIDER_ENRICHMENT_MODES,
  PROVIDER_ENRICHMENT_MODE_ALIASES,
  providerEnrichmentToWire,
  providerEnrichmentWorkflow,
  STEADY_STATE_COMPETITIONS,
  seasonBackfillToWire,
  seasonBackfillWorkflow,
  squadSweepToWire,
  squadSweepWorkflow,
  statsbombBackfillToWire,
  statsbombBackfillWorkflow,
  sweepMissingPayloadsToWire,
  sweepMissingPayloadsWorkflow,
  webhookCompletedToWire,
  webhookCompletedWorkflow,
  type CompetitionBackfillKind,
  type CompetitionEntry,
  type CompetitionPayloadBackfillInput,
  type DailyAnchorInput,
  type HourlyMatchdayInput,
  type IdentityGapScanInput,
  type ProviderFixtureResultsInput,
  type ProviderEnrichmentDataset,
  type ProviderEnrichmentInput,
  type ProviderEnrichmentMode,
  type SeasonBackfillInput,
  type SeasonBackfillTarget,
  type SquadSweepInput,
  type StatsBombBackfillInput,
  type SweepMissingPayloadKind,
  type SweepMissingPayloadsInput,
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
   * {@link streamRegistryRun} for the event shape; the final line always
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
 * Bounded async queue used by {@link streamRegistryRun} to bridge the
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

type WorkflowName =
  | 'daily-anchor'
  | 'hourly-matchday'
  | 'webhook-completed'
  | 'season-backfill'
  | 'sweep-missing-payloads'
  | 'squad-sweep'
  | 'statsbomb-backfill'
  | 'identity-gap-scan'
  | 'competition-payload-backfill'
  | 'provider-fixture-results'
  | 'provider-enrichment';

const WORKFLOW_NAMES: readonly WorkflowName[] = [
  'daily-anchor',
  'hourly-matchday',
  'webhook-completed',
  'season-backfill',
  'sweep-missing-payloads',
  'squad-sweep',
  'statsbomb-backfill',
  'identity-gap-scan',
  'competition-payload-backfill',
  'provider-fixture-results',
  'provider-enrichment',
];

const workflowNameFromSegment = (segment: string): WorkflowName | undefined =>
  WORKFLOW_NAMES.find((name) => name === segment);

/**
 * A parsed workflow request, ready for the run registry: the input (hashed so
 * equal requests attach to one run), the scope it locks, and the run itself,
 * which returns the workflow's wire result.
 *
 * Each workflow declares its own wire projection in `workflows/wire.ts`. The
 * in-process output may carry provider debug payloads (raw
 * `IngestionFetchResult` arrays) that must not cross the wire: one oversized
 * completed line once failed the kernel activity deterministically
 * (2026-05-25, run 019e57ec-…).
 */
interface ResolvedWorkflowRun {
  readonly ok: true;
  readonly input: unknown;
  readonly scopeKey: string;
  readonly run: (deps: WorkflowDeps) => Promise<Record<string, unknown>>;
}

type WorkflowResolution =
  | ResolvedWorkflowRun
  | { readonly ok: false; readonly response: WorkerHttpResponse };

const wire =
  <T, W>(
    run: (deps: WorkflowDeps) => Promise<T>,
    toWire: (result: T) => W
  ): ((deps: WorkflowDeps) => Promise<Record<string, unknown>>) =>
  async (deps) =>
    toWire(await run(deps)) as Record<string, unknown>;

const badRequest = (reason: string): WorkflowResolution => ({
  ok: false,
  response: jsonResponse(400, { status: 'bad_request', reason }),
});

/**
 * Parse a workflow request body. The scope key is what one run at a time may
 * hold: per dataset, payload kind or mode where the workflow has one, else the
 * workflow itself.
 */
const resolveWorkflowRun = (workflow: WorkflowName, body: unknown): WorkflowResolution => {
  switch (workflow) {
    case 'webhook-completed': {
      const input = parseWebhookCompletedInput(body);
      if (!input) {
        return badRequest('missing_fixture_id_or_provider_id');
      }
      return {
        ok: true,
        input,
        scopeKey: `webhook-completed:${input.providerId}:${input.fixtureId}`,
        run: wire((deps) => webhookCompletedWorkflow(input, deps), webhookCompletedToWire),
      };
    }
    case 'hourly-matchday': {
      const input = parseHourlyMatchdayInput(body);
      return {
        ok: true,
        input,
        scopeKey: workflow,
        run: wire((deps) => hourlyMatchdayWorkflow(input, deps), hourlyMatchdayToWire),
      };
    }
    case 'sweep-missing-payloads': {
      const input = parseSweepMissingPayloadsInput(body);
      if (!input) {
        return badRequest('missing_or_invalid_provider_kind');
      }
      return {
        ok: true,
        input,
        scopeKey: `sweep-missing-payloads:${input.kind}`,
        run: wire((deps) => sweepMissingPayloadsWorkflow(input, deps), sweepMissingPayloadsToWire),
      };
    }
    case 'season-backfill': {
      const input = parseSeasonBackfillInput(body);
      return {
        ok: true,
        input,
        scopeKey: workflow,
        run: wire((deps) => seasonBackfillWorkflow(input, deps), seasonBackfillToWire),
      };
    }
    case 'squad-sweep': {
      const input = parseSquadSweepInput(body);
      return {
        ok: true,
        input,
        scopeKey: workflow,
        run: wire((deps) => squadSweepWorkflow(input, deps), squadSweepToWire),
      };
    }
    case 'statsbomb-backfill': {
      const input = parseStatsBombBackfillInput(body);
      return {
        ok: true,
        input,
        scopeKey: workflow,
        run: wire((deps) => statsbombBackfillWorkflow(input, deps), statsbombBackfillToWire),
      };
    }
    case 'identity-gap-scan': {
      const input = parseIdentityGapScanInput(body);
      return {
        ok: true,
        input,
        scopeKey: workflow,
        run: wire((deps) => identityGapScanWorkflow(input, deps), identityGapScanToWire),
      };
    }
    case 'competition-payload-backfill': {
      const input = parseCompetitionPayloadBackfillInput(body);
      if (!input) {
        return badRequest('missing_or_invalid_kind');
      }
      return {
        ok: true,
        input,
        scopeKey: `competition-payload-backfill:${input.kind}`,
        run: wire(
          (deps) => competitionPayloadBackfillWorkflow(input, deps),
          competitionPayloadBackfillToWire
        ),
      };
    }
    case 'provider-fixture-results': {
      const parsed = parseProviderFixtureResultsInput(body, new Date());
      if (!parsed.ok) {
        return badRequest(parsed.reason);
      }
      const { input } = parsed;
      return {
        ok: true,
        input,
        scopeKey: `provider-fixture-results:${input.mode}`,
        run: wire(
          (deps) => providerFixtureResultsWorkflow(input, deps),
          providerFixtureResultsToWire
        ),
      };
    }
    case 'provider-enrichment': {
      const parsed = parseProviderEnrichmentInput(body);
      if (!parsed.ok) {
        return badRequest(parsed.reason);
      }
      const { input } = parsed;
      return {
        ok: true,
        input,
        scopeKey: `provider-enrichment:${input.dataset}`,
        run: wire((deps) => providerEnrichmentWorkflow(input, deps), providerEnrichmentToWire),
      };
    }
    case 'daily-anchor': {
      const input = parseDailyAnchorInput(body);
      return {
        ok: true,
        input,
        scopeKey: workflow,
        run: wire((deps) => dailyAnchorWorkflow(input, deps), dailyAnchorToWire),
      };
    }
  }
};

/**
 * Start a workflow run through the registry and stream its progress as NDJSON
 * (the `/workflows/*` endpoints, used by operators and by kernel before the
 * `/runs` endpoints). Each line on the wire is either:
 *
 *   - `{event: 'run.started' | 'run.attached', workflow, runId}` first
 *   - a {@link WorkflowLogEntry} forwarded verbatim from the workflow
 *   - a `{event: 'heartbeat', workflow, ts}` keepalive every 30s
 *   - a single `{event: 'completed', workflow, runId, status: 'ok'|'error',
 *     result?, reason?}` line that always closes the stream
 *
 * The response is 200 even when the workflow throws; the error is carried in
 * the trailing `completed` line. A cancelled or interrupted run also ends
 * with `status: 'error'`, so a caller retries instead of recording a partial
 * result as done. The run itself does not depend on the connection: a client
 * that disconnects leaves it running, and a retry with the same input
 * attaches to it. When the scope is held by a run with different input, or by
 * a run on another pod, the answer is 409 with the holder's run id.
 */
const streamRegistryRun = async (
  registry: RunRegistry,
  workflow: WorkflowName,
  resolved: ResolvedWorkflowRun,
  deps: WorkflowDeps,
  baseLogger: WorkflowLogger | undefined
): Promise<WorkerHttpResponse> => {
  const queue = new WorkflowStreamQueue();
  const heartbeat = setInterval(() => {
    queue.push({ event: 'heartbeat', workflow, ts: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === 'function') {
    heartbeat.unref();
  }
  const close = (record: RunView): void => {
    clearInterval(heartbeat);
    queue.push(completedLine(record));
    queue.close();
  };
  const head: Record<string, unknown>[] = [];

  let outcome: StartRunOutcome;
  try {
    outcome = await registry.start({
      workflow,
      scopeKey: resolved.scopeKey,
      input: resolved.input,
      baseLogger,
      run: ({ logger, signal }) => resolved.run({ ...deps, logger, signal }),
      observer: {
        onEvent: (entry) => queue.push({ ...entry }),
        onDone: (record) => close(record),
      },
    });
  } catch (error) {
    clearInterval(heartbeat);
    return jsonResponse(503, {
      status: 'unavailable',
      reason: 'run_registry_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (outcome.kind === 'busy') {
    clearInterval(heartbeat);
    return jsonResponse(409, busyBody(outcome));
  }
  if (outcome.kind === 'attached' && !outcome.observed) {
    if (outcome.run.status === 'running') {
      clearInterval(heartbeat);
      return jsonResponse(409, {
        status: 'busy',
        reason: 'running_on_another_pod',
        holderRunId: outcome.run.runId,
        retryable: false,
      });
    }
    head.push({ event: 'run.attached', workflow, runId: outcome.run.runId });
    close(outcome.run);
    return streamingResponse(prepend(head, queue));
  }
  head.push({
    event: outcome.kind === 'started' ? 'run.started' : 'run.attached',
    workflow,
    runId: outcome.run.runId,
  });
  return streamingResponse(prepend(head, queue));
};

/** Yield `head` first, then everything from `rest`. */
async function* prepend(
  head: readonly Record<string, unknown>[],
  rest: AsyncIterable<Record<string, unknown>>
): AsyncIterable<Record<string, unknown>> {
  yield* head;
  yield* rest;
}

/** The trailing NDJSON line for a settled (or attached, finished) run. */
const completedLine = (record: RunView): Record<string, unknown> => {
  const base = { event: 'completed', workflow: record.workflow, runId: record.runId };
  if (record.status === 'completed') {
    return {
      ...base,
      status: 'ok',
      result: record.result,
      ...(record.resultTruncated ? { resultTruncated: true } : {}),
    };
  }
  return {
    ...base,
    status: 'error',
    reason: `${record.status}${record.reason ? `: ${record.reason}` : ''}`,
  };
};

const busyBody = (
  outcome: Extract<StartRunOutcome, { kind: 'busy' }>
): Record<string, unknown> => ({
  status: 'busy',
  reason: outcome.retryable ? 'scope_releasing' : 'scope_held_by_another_run',
  holderRunId: outcome.holderRunId,
  holderStatus: outcome.holder?.status,
  holderWorkflow: outcome.holder?.workflow,
  holderStartedAt: outcome.holder?.startedAt,
  retryable: outcome.retryable,
});

const streamingResponse = (stream: AsyncIterable<Record<string, unknown>>): WorkerHttpResponse => ({
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
   * Optional game-service client used by the sweep-missing-payloads
   * workflow to enumerate finished games whose specified payload was
   * never ingested. When unset the sweep workflow still works for
   * explicit `fixtureIds` lists (ops one-shot mode).
   */
  readonly gameServiceMissingPayloads?: FootballGameMissingPayloadsClient;
  /**
   * Game-service ingest client used by the squad-sweep workflow to push
   * standing squad rosters via IngestFootballSquadLists.
   */
  readonly gameService?: FootballGameIngestClient;
  /**
   * game-service client used by the provider-fixture-results workflow's
   * `IngestProviderFixtureResults` call. Wired separately from
   * `gameService`: that RPC is served only by `game-service-profile-jobs`,
   * never the serving pods `gameService` targets.
   */
  readonly gameServiceJobs?: GameServiceProfileJobsClient;
  /**
   * Game-service lookup client used by the statsbomb-backfill workflow to
   * resolve a provider fixture id to the canonical BTL game id via
   * LookupGameByFixture.
   */
  readonly gameLookup?: FootballGameLookupClient;
  /**
   * Identity-server client used by the squad-sweep workflow to resolve
   * provider team ids to canonical btl_football_team_* ids.
   */
  readonly identity?: FootballIdentityLookupClient;
  /**
   * GS-2 ingest client for the provider-enrichment workflow. Without it the
   * workflow returns `skipped` before any provider call.
   */
  readonly providerEnrichmentIngest?: ProviderEnrichmentIngestClient;
  /**
   * Process-wide enrichment minute limiter (`GAMEWIRE_ENRICHMENT_MINUTE_CAP`),
   * shared by every provider-enrichment run so two runs cannot each take the
   * full ceiling.
   */
  readonly enrichmentLimiter?: ProviderMinuteLimiter;
  /** Sleep used by the provider-enrichment workflow. Tests inject a fake. */
  readonly enrichmentSleep?: (ms: number) => Promise<void>;
  /**
   * Content bucket store for the `coach-photos` dataset (the asset mirror's
   * R2 config). Unset means the dataset completes as `skipped`.
   */
  readonly coachPhotoStore?: MediaObjectStore;
  /** Durable workflow state (the season-backfill cursor). Redis in production. */
  readonly workflowStateStore?: ProviderCache;
  /**
   * Run registry for `/runs/*` and `/workflows/*` (Redis-backed in
   * production). Without one, `/runs/*` answers 503 and each `/workflows/*`
   * stream gets a private in-memory registry.
   */
  readonly runRegistry?: RunRegistry;
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
/**
 * Header the inbound Linkerd proxy stamps with the caller's verified mTLS
 * identity (e.g. `kernel-service.btl-prod.serviceaccount.identity.linkerd.cluster.local`).
 * Client-supplied values are stripped by the proxy, so on a Linkerd mesh this
 * header is trustworthy; it is simply absent on non-Linkerd meshes.
 */
const L5D_CLIENT_ID_HEADER = 'l5d-client-id';

const authoriseWorkflowRequest = (
  cfg: GamewireWorkerConfig,
  headers: Record<string, string | undefined> | undefined,
  authContextVerifier: Verifier | undefined
): WorkflowAuthOutcome => {
  // Mesh-identity fast path. Where the inbound doesn't mint a btl-auth-context
  // JWT — Linkerd (prod) has no ext_authz extension, unlike staging's Envoy —
  // authorise the caller by its verified service-mesh identity instead. The
  // allow-list is empty on meshes that DO stamp the JWT (staging), so this is
  // a no-op there and the JWT below remains the only accepted credential.
  const trustedMeshIdentities = cfg.authContextTrustedMeshIdentities ?? [];
  if (trustedMeshIdentities.length > 0) {
    const meshIdentity = readHeader(headers, L5D_CLIENT_ID_HEADER);
    if (meshIdentity !== undefined && trustedMeshIdentities.includes(meshIdentity)) {
      return { authorised: true, reasonForLog: `mesh_identity:${meshIdentity}` };
    }
  }

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

export const buildWorkflowDeps = (
  options: WorkerHttpHandlerOptions,
  cfg: GamewireWorkerConfig
): WorkflowDeps | undefined => {
  if (!options.ingestion) {
    return undefined;
  }
  return {
    ingestion: options.ingestion,
    competitions: options.competitions ?? STEADY_STATE_COMPETITIONS,
    logger: options.workflowLogger,
    gameServiceMissingPayloads: options.gameServiceMissingPayloads,
    gameService: options.gameService,
    gameServiceJobs: options.gameServiceJobs,
    gameLookup: options.gameLookup,
    identity: options.identity,
    enrichment: {
      enabledDatasets: cfg.enrichmentDatasets ?? [],
      ingest: options.providerEnrichmentIngest,
      limiter: options.enrichmentLimiter,
      minuteCap: cfg.enrichmentMinuteCap,
      sleep: options.enrichmentSleep,
    },
    stateStore: options.workflowStateStore,
    coachPhotos: options.coachPhotoStore ? { store: options.coachPhotoStore } : undefined,
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

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asNumberList = (value: unknown): readonly number[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      out.push(item);
    }
  }
  return out;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const parseSeasonBackfillTargets = (
  value: unknown
): readonly SeasonBackfillTarget[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: SeasonBackfillTarget[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const season = asNumber(item.season);
    if (season === undefined) {
      // A target without a season is unusable; skip it rather than
      // defaulting to a wrong season silently.
      continue;
    }
    out.push({
      competitionKey: asString(item.competitionKey),
      apiFootballLeagueId: asNumber(item.apiFootballLeagueId),
      season,
    });
  }
  return out;
};

const parseSeasonBackfillInput = (body: unknown): SeasonBackfillInput => {
  if (!isRecord(body)) {
    return {};
  }
  return {
    targets: parseSeasonBackfillTargets(body.targets),
    seasons: asNumberList(body.seasons),
    competitions: asStringList(body.competitions),
    maxCallsPerRun: asNumber(body.maxCallsPerRun),
    reset: asBoolean(body.reset),
    skipPlayerStats: asBoolean(body.skipPlayerStats),
    skipLineups: asBoolean(body.skipLineups),
    bypassCache: asBoolean(body.bypassCache),
    dryRun: asBoolean(body.dryRun),
    resultsOnly: asBoolean(body.resultsOnly),
    standingsOnly: asBoolean(body.standingsOnly),
    allowUnresolvedTeams: asBoolean(body.allowUnresolvedTeams),
    nowUtc: asString(body.nowUtc),
  };
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

const SWEEP_MISSING_PAYLOAD_KINDS: readonly SweepMissingPayloadKind[] = [
  'team-match-stats',
  'player-match-stats',
  'events',
  'lineups',
];

const parseSweepMissingPayloadKind = (value: unknown): SweepMissingPayloadKind | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  for (const kind of SWEEP_MISSING_PAYLOAD_KINDS) {
    if (kind === value) {
      return kind;
    }
  }
  return undefined;
};

const parseSweepMissingPayloadsInput = (body: unknown): SweepMissingPayloadsInput | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const providerId = asString(body.providerId);
  const kind = parseSweepMissingPayloadKind(body.kind);
  if (providerId === undefined || providerId === '' || kind === undefined) {
    return undefined;
  }
  return {
    providerId,
    kind,
    limit: asNumber(body.limit),
    since: asString(body.since),
    until: asString(body.until),
    dryRun: asBoolean(body.dryRun),
    fixtureIds: asStringList(body.fixtureIds),
    nowUtc: asString(body.nowUtc),
  };
};

const parseSquadSweepInput = (body: unknown): SquadSweepInput => {
  if (!isRecord(body)) {
    return {};
  }
  return {
    teamIds: asStringList(body.teamIds),
    maxTeamsPerRun: asNumber(body.maxTeamsPerRun),
    intercallDelayMs: asNumber(body.intercallDelayMs),
    dryRun: asBoolean(body.dryRun),
    nowUtc: asString(body.nowUtc),
  };
};

const parseStatsBombBackfillInput = (body: unknown): StatsBombBackfillInput => {
  if (!isRecord(body)) {
    return {};
  }
  return {
    matchIds: asNumberList(body.matchIds),
    competitionId: asNumber(body.competitionId),
    seasonId: asNumber(body.seasonId),
    maxMatchesPerRun: asNumber(body.maxMatchesPerRun),
    intercallDelayMs: asNumber(body.intercallDelayMs),
    dryRun: asBoolean(body.dryRun),
    baseUrl: asString(body.baseUrl),
    nowUtc: asString(body.nowUtc),
  };
};

const parseIdentityGapScanInput = (body: unknown): IdentityGapScanInput => {
  if (!isRecord(body)) {
    return {};
  }
  return {
    maxEntitiesPerRun: asNumber(body.maxEntitiesPerRun),
    nowUtc: asString(body.nowUtc),
  };
};

/** Integers from a JSON list; numeric strings are accepted (kernel inputs pass through Go maps). */
const asIntList = (value: unknown): readonly number[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: number[] = [];
  for (const item of value) {
    const parsed =
      typeof item === 'number' ? item : typeof item === 'string' ? Number(item.trim()) : NaN;
    if (!Number.isInteger(parsed)) {
      return undefined;
    }
    out.push(parsed);
  }
  return out;
};

/** Most ids one enrichment request may name. */
const MAX_ENRICHMENT_IDS = 2_000;

/**
 * Parse a provider id list (`playerIds`, `coachIds`, `teamIds`): numbers or
 * numeric strings, each a positive integer. undefined when absent, null when
 * malformed.
 */
const parseEnrichmentIdList = (value: unknown): string[] | undefined | null => {
  if (value === undefined) {
    return undefined;
  }
  const ids = asIntList(value);
  if (ids === undefined || ids.length > MAX_ENRICHMENT_IDS || ids.some((id) => id <= 0)) {
    return null;
  }
  return ids.map(String);
};

const MIN_ENRICHMENT_SEASON = 2000;
const MAX_ENRICHMENT_SEASON = 2100;

type ProviderEnrichmentParse =
  | { readonly ok: true; readonly input: ProviderEnrichmentInput }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse `/workflows/provider-enrichment`. `dataset` is required; `mode`
 * defaults to `nightly`. The spec's `auto` and `dirty` (the K-2 schedule body)
 * are accepted as `nightly`. `full` requires non-empty `leagueIds` and
 * `seasons` for the league-season datasets, and `playerIds`, `coachIds` or
 * `teamIds` for the others except `team-season-stats`, whose `full` is every
 * catalogue domestic team. Id lists are accepted only by the datasets that
 * use them.
 */
export const parseProviderEnrichmentInput = (body: unknown): ProviderEnrichmentParse => {
  if (!isRecord(body)) {
    return { ok: false, reason: 'missing_body' };
  }
  const dataset = PROVIDER_ENRICHMENT_DATASETS.find((name) => name === body.dataset);
  if (dataset === undefined) {
    return { ok: false, reason: 'unknown_dataset' };
  }
  const mode: ProviderEnrichmentMode | undefined =
    body.mode === undefined
      ? 'nightly'
      : (PROVIDER_ENRICHMENT_MODES.find((name) => name === body.mode) ??
        (typeof body.mode === 'string' ? PROVIDER_ENRICHMENT_MODE_ALIASES[body.mode] : undefined));
  if (mode === undefined) {
    return { ok: false, reason: 'invalid_mode' };
  }
  const leagueIds = body.leagueIds === undefined ? undefined : asIntList(body.leagueIds);
  if (
    body.leagueIds !== undefined &&
    (leagueIds === undefined || leagueIds.some((id) => id <= 0))
  ) {
    return { ok: false, reason: 'invalid_league_ids' };
  }
  const seasons = body.seasons === undefined ? undefined : asIntList(body.seasons);
  if (
    body.seasons !== undefined &&
    (seasons === undefined ||
      seasons.some((s) => s < MIN_ENRICHMENT_SEASON || s > MAX_ENRICHMENT_SEASON))
  ) {
    return { ok: false, reason: 'invalid_seasons' };
  }
  const playerIds = parseEnrichmentIdList(body.playerIds);
  const coachIds = parseEnrichmentIdList(body.coachIds);
  const teamIds = parseEnrichmentIdList(body.teamIds);
  const fixtureIds = parseEnrichmentIdList(body.fixtureIds);
  const venueIds = parseEnrichmentIdList(body.venueIds);
  if (
    playerIds === null ||
    coachIds === null ||
    teamIds === null ||
    fixtureIds === null ||
    venueIds === null
  ) {
    return { ok: false, reason: 'invalid_ids' };
  }
  if (
    (playerIds && dataset !== 'player-sidelined' && dataset !== 'trophies') ||
    (coachIds && dataset !== 'trophies' && dataset !== 'coach-photos') ||
    (teamIds &&
      dataset !== 'team-transfers' &&
      dataset !== 'team-coaches' &&
      dataset !== 'coach-photos' &&
      dataset !== 'trophies' &&
      dataset !== 'team-season-stats' &&
      dataset !== 'venue-detail') ||
    (fixtureIds && dataset !== 'fixture-predictions' && dataset !== 'head-to-head') ||
    (venueIds && dataset !== 'venue-detail')
  ) {
    return { ok: false, reason: 'ids_not_used_by_dataset' };
  }
  if (seasons && dataset === 'team-season-stats' && mode !== 'full') {
    // `nightly` reads teams from the catalogue season's cached fixture list,
    // so a named season cannot be honoured. `full` with `seasons` reads each
    // named league-season's list (one call each, outside the ingest bridge).
    return { ok: false, reason: 'seasons_not_used_by_dataset' };
  }
  // K-2 sends `partition: "auto"`, which is the default (week counter mod 4).
  const partition =
    body.partition === undefined || body.partition === 'auto'
      ? undefined
      : asNumber(body.partition);
  if (
    body.partition !== undefined &&
    body.partition !== 'auto' &&
    (partition === undefined || !Number.isInteger(partition) || partition < 0 || partition > 3)
  ) {
    return { ok: false, reason: 'invalid_partition' };
  }
  if (mode === 'full') {
    // `full` never falls back to a default scope: the request names it.
    if (dataset === 'player-season-stats' || dataset === 'injuries-league') {
      if (!leagueIds?.length || !seasons?.length) {
        return { ok: false, reason: 'full_mode_needs_league_ids_and_seasons' };
      }
    } else if (
      dataset !== 'team-season-stats' &&
      !playerIds?.length &&
      !coachIds?.length &&
      !teamIds?.length &&
      !fixtureIds?.length &&
      !venueIds?.length
    ) {
      // `team-season-stats` `full` is every catalogue domestic team (spec GW-6).
      return { ok: false, reason: 'full_mode_needs_ids' };
    }
  }
  if (
    body.limit !== undefined &&
    (asNumber(body.limit) === undefined || (body.limit as number) <= 0)
  ) {
    return { ok: false, reason: 'invalid_limit' };
  }
  return {
    ok: true,
    input: {
      dataset: dataset satisfies ProviderEnrichmentDataset,
      mode,
      leagueIds,
      seasons,
      limit: asNumber(body.limit),
      playerIds,
      coachIds,
      teamIds,
      fixtureIds,
      venueIds,
      partition,
      allowUncatalogued: asBoolean(body.allowUncatalogued),
      reset: asBoolean(body.reset),
      dryRun: asBoolean(body.dryRun),
      nowUtc: asString(body.nowUtc),
    },
  };
};

const COMPETITION_BACKFILL_KINDS: readonly CompetitionBackfillKind[] = ['events', 'lineups'];

const parseCompetitionBackfillKind = (value: unknown): CompetitionBackfillKind | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  for (const kind of COMPETITION_BACKFILL_KINDS) {
    if (kind === value) {
      return kind;
    }
  }
  return undefined;
};

const parseCompetitionPayloadBackfillInput = (
  body: unknown
): CompetitionPayloadBackfillInput | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const kind = parseCompetitionBackfillKind(body.kind);
  if (kind === undefined) {
    return undefined;
  }
  return {
    competitionKey: asString(body.competitionKey),
    apiFootballLeagueId: asNumber(body.apiFootballLeagueId),
    kind,
    limit: asNumber(body.limit),
    since: asString(body.since),
    until: asString(body.until),
    dryRun: asBoolean(body.dryRun),
    intercallDelayMs: asNumber(body.intercallDelayMs),
    nowUtc: asString(body.nowUtc),
  };
};

const parseProviderFixtureResultsMode = (
  value: unknown
): ProviderFixtureResultsInput['mode'] | undefined => {
  if (value === 'history' || value === 'nightly') {
    return value;
  }
  return undefined;
};

/**
 * A missing or unknown `mode` is a 400, never a fall-through to the ~92-call
 * `history` run: kernel's schedule posts this body every night, and a mode
 * string kernel and gamewire disagree on must fail loudly. `seasons`, when
 * given, must be integers from 2010 to the current UTC year + 1.
 */
const parseProviderFixtureResultsInput = (
  body: unknown,
  now: Date
):
  | { readonly ok: true; readonly input: ProviderFixtureResultsInput }
  | { readonly ok: false; readonly reason: string } => {
  if (!isRecord(body)) {
    return { ok: false, reason: 'missing_or_invalid_mode' };
  }
  const mode = parseProviderFixtureResultsMode(body.mode);
  if (mode === undefined) {
    return { ok: false, reason: 'missing_or_invalid_mode' };
  }
  if (body.seasons !== undefined) {
    const maxSeason = maxProviderFixtureResultsSeason(now);
    if (
      !Array.isArray(body.seasons) ||
      !body.seasons.every(
        (season) =>
          typeof season === 'number' &&
          Number.isInteger(season) &&
          season >= MIN_PROVIDER_FIXTURE_RESULTS_SEASON &&
          season <= maxSeason
      )
    ) {
      return { ok: false, reason: 'invalid_seasons' };
    }
  }
  return {
    ok: true,
    input: {
      mode,
      leagueIds: asNumberList(body.leagueIds),
      seasons: asNumberList(body.seasons),
      nightlyLeagueIds: asNumberList(body.nightlyLeagueIds),
      maxCallsPerRun: asNumber(body.maxCallsPerRun),
      nowUtc: asString(body.nowUtc),
    },
  };
};

type WorkflowGate =
  | { readonly ok: true; readonly baseDeps: WorkflowDeps }
  | { readonly ok: false; readonly response: WorkerHttpResponse };

/**
 * Auth, ingestion readiness and kill switches shared by `/workflows/*` and
 * `POST /runs/{workflow}`.
 */
const gateWorkflowRequest = (
  request: WorkerHttpRequest,
  cfg: GamewireWorkerConfig,
  options: WorkerHttpHandlerOptions,
  workflow: WorkflowName
): WorkflowGate => {
  const auth = authoriseWorkflowRequest(cfg, request.headers, options.authContextVerifier);
  if (!auth.authorised) {
    if (options.workflowLogger && auth.reasonForLog) {
      // Log the verbose reason so ops can debug 401s without leaking
      // claim-level detail back to the caller.
      options.workflowLogger({
        event: 'workflow-auth-rejected',
        workflow,
        reason: auth.reasonForLog,
        message: `gamewire-worker workflow auth rejected: ${auth.reasonForLog}`,
      });
    }
    return { ok: false, response: auth.response ?? jsonResponse(401, { status: 'unauthorized' }) };
  }
  if (options.workflowLogger && auth.reasonForLog) {
    // Audit a successful invocation authorised by a non-JWT credential (a
    // trusted mesh identity). JWT-authorised calls return no reason and stay
    // unlogged, matching prior behaviour.
    options.workflowLogger({
      event: 'workflow-auth-accepted',
      workflow,
      reason: auth.reasonForLog,
      message: `gamewire-worker workflow auth accepted via ${auth.reasonForLog}`,
    });
  }
  const baseDeps = buildWorkflowDeps(options, cfg);
  if (!baseDeps) {
    return {
      ok: false,
      response: jsonResponse(503, { status: 'unavailable', reason: 'ingestion_not_started' }),
    };
  }
  if (workflow === 'provider-fixture-results' && !cfg.providerFixtureResultsEnabled) {
    // Emergency off-switch (PF-GW1): on by default.
    // GAMEWIRE_PROVIDER_FIXTURE_RESULTS=off stops the workflow with an
    // env flip, not a deploy.
    return {
      ok: false,
      response: jsonResponse(503, {
        status: 'unavailable',
        reason: 'feature_disabled',
        feature: 'GAMEWIRE_PROVIDER_FIXTURE_RESULTS',
      }),
    };
  }
  return { ok: true, baseDeps };
};

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * The run endpoints. Kernel starts a run, polls its status every 15 s and
 * cancels it when its Temporal activity is cancelled:
 *
 * - `POST /runs/{workflow}` with an `Idempotency-Key` header: 202 with the
 *   run (`attached: true` when the key or an identical running request
 *   already owns one), 409 when another run holds the scope, 400 on bad
 *   input.
 * - `GET /runs/{runId}`: the run's status, progress and, once finished, its
 *   wire result. `lost` means the run's pod stopped renewing it.
 * - `POST /runs/{runId}/cancel`: ask the run to stop at its next checkpoint.
 */
const handleRunsRequest = async (
  request: WorkerHttpRequest,
  cfg: GamewireWorkerConfig,
  options: WorkerHttpHandlerOptions
): Promise<WorkerHttpResponse> => {
  const parts = request.pathname.slice('/runs/'.length).split('/');
  const registry = options.runRegistry;

  const startWorkflow =
    request.method === 'POST' && parts.length === 1
      ? workflowNameFromSegment(parts[0] ?? '')
      : undefined;
  if (startWorkflow) {
    const gate = gateWorkflowRequest(request, cfg, options, startWorkflow);
    if (!gate.ok) {
      return gate.response;
    }
    if (!registry) {
      return jsonResponse(503, { status: 'unavailable', reason: 'run_registry_not_configured' });
    }
    const idempotencyKey = readHeader(request.headers, IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      return jsonResponse(400, { status: 'bad_request', reason: 'invalid_idempotency_key' });
    }
    const resolved = resolveWorkflowRun(startWorkflow, request.body);
    if (!resolved.ok) {
      return resolved.response;
    }
    let outcome: StartRunOutcome;
    try {
      outcome = await registry.start({
        workflow: startWorkflow,
        scopeKey: resolved.scopeKey,
        input: resolved.input,
        idempotencyKey,
        baseLogger: options.workflowLogger,
        run: ({ logger, signal }) => resolved.run({ ...gate.baseDeps, logger, signal }),
      });
    } catch (error) {
      return jsonResponse(503, {
        status: 'unavailable',
        reason: 'run_registry_unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (outcome.kind === 'busy') {
      return jsonResponse(409, busyBody(outcome));
    }
    return jsonResponse(202, {
      ...runBody(outcome.run),
      attached: outcome.kind === 'attached',
    });
  }

  const runId = parts[0] ?? '';
  const isStatus = request.method === 'GET' && parts.length === 1;
  const isCancel = request.method === 'POST' && parts.length === 2 && parts[1] === 'cancel';
  if (!runId || (!isStatus && !isCancel)) {
    return jsonResponse(404, { status: 'not_found', service: 'gamewire-worker' });
  }
  // Status polls run every 15 s, so they are authorised but not audited.
  const auth = authoriseWorkflowRequest(cfg, request.headers, options.authContextVerifier);
  if (!auth.authorised) {
    return auth.response ?? jsonResponse(401, { status: 'unauthorized' });
  }
  if (!registry) {
    return jsonResponse(503, { status: 'unavailable', reason: 'run_registry_not_configured' });
  }
  try {
    const view = isCancel ? await registry.cancel(runId) : await registry.status(runId);
    if (!view) {
      return jsonResponse(404, { status: 'not_found', reason: 'unknown_run', runId });
    }
    return jsonResponse(isCancel ? 202 : 200, runBody(view));
  } catch (error) {
    return jsonResponse(503, {
      status: 'unavailable',
      reason: 'run_registry_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * A run on the wire. `status` is the run's lifecycle state (`running`,
 * `completed`, `failed`, `cancelled`, `interrupted`, `lost`); the workflow's
 * own outcome (`completed`, `incomplete`, ...) is inside `result`.
 */
const runBody = (run: RunView): Record<string, unknown> => ({
  runId: run.runId,
  workflow: run.workflow,
  scopeKey: run.scopeKey,
  status: run.status,
  pod: run.pod,
  startedAt: run.startedAt,
  heartbeatAt: run.heartbeatAt,
  deadlineAt: run.deadlineAt,
  finishedAt: run.finishedAt,
  events: run.events,
  lastEvent: run.lastEvent,
  lastEventStatus: run.lastEventStatus,
  lastEventAt: run.lastEventAt,
  stopRequested: run.stopRequested,
  reason: run.reason,
  result: run.result,
  resultTruncated: run.resultTruncated,
});

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

  const streamWorkflow =
    request.method === 'POST' && request.pathname.startsWith('/workflows/')
      ? workflowNameFromSegment(request.pathname.slice('/workflows/'.length))
      : undefined;
  if (streamWorkflow) {
    const gate = gateWorkflowRequest(request, cfg, options, streamWorkflow);
    if (!gate.ok) {
      return gate.response;
    }
    const resolved = resolveWorkflowRun(streamWorkflow, request.body);
    if (!resolved.ok) {
      return resolved.response;
    }
    // Without a registry (tests, local tools) each stream gets its own, so
    // the stream still runs through the same lifecycle code.
    const registry =
      options.runRegistry ?? new RunRegistry({ store: new InMemoryRunStore(), timers: false });
    return streamRegistryRun(
      registry,
      streamWorkflow,
      resolved,
      gate.baseDeps,
      options.workflowLogger
    );
  }

  if (request.pathname.startsWith('/runs/')) {
    return handleRunsRequest(request, cfg, options);
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
