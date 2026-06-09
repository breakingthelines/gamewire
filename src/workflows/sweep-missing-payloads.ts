/**
 * Sweep-missing-payloads workflow.
 *
 * Phase A api-football ingest dropped stats payloads (team-match-stats,
 * player-match-stats, events, lineups) for thousands of historical fixtures
 * that completed before the post-final stat pulls were wired into the
 * webhook-completed and season-backfill paths. The 2026-06 PL audit
 * counted ~2,239 finished games on staging with no team-match-stats.
 *
 * This is the persistent mechanism to close that gap and any future gap:
 * an operator (or a kernel-side Temporal Schedule) POSTs to
 * `/workflows/sweep-missing-payloads` with a `kind`; the workflow asks
 * game-service which finished fixtures lack that payload, then for each
 * fires the SINGLE provider-facing workload that fills it. There is no
 * point re-fetching fixture detail when team-match-stats is the gap.
 *
 * Idempotency is owned by the existing match-concluded bridge plumbing:
 * `ApiFootballIngestionLoop.fetchWorkload` honours the per-workload TTL
 * cache, singleflight, and quota counter; on the bridge side the
 * game-service `Ingest*` upserts and `RedisEmittedFixtureStore` short
 * any replay. Re-runs are therefore safe.
 *
 * The workflow accepts an explicit `fixtureIds` array as an escape hatch
 * for ops one-shots and tests; when provided it skips the RPC entirely
 * and iterates the list.
 */
import { create } from '@bufbuild/protobuf';
import { type Timestamp, timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  GameMissingPayloadKind,
  ListGamesMissingPayloadsRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import {
  apiFootballEventPath,
  apiFootballFixturePlayersPath,
  apiFootballFixtureStatisticsPath,
  apiFootballLineupPath,
} from '../adapters/api-football/index.js';
import type { IngestionFetchResult, IngestionWorkload } from '../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import {
  handleProviderOutage,
  handleProviderRateLimited,
  handleQuotaPosture,
  mostRestrictive,
} from './degrade.js';
import type {
  DegradeAction,
  DegradeFlag,
  SweepMissingPayloadKind,
  SweepMissingPayloadsInput,
  SweepMissingPayloadsOutput,
  WorkflowDeps,
} from './types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Default inter-call delay between provider fetches inside the sweep loop.
 * The free + Pro tiers of api-football enforce a per-minute cap (Pro =
 * 450/min ≈ 7.5/sec) that a tight `for` loop hitting `fetchWorkload` will
 * burst through and trigger HTTP-200-with-rate-limit-envelope responses; the
 * bridge then logs `bridge_team_stats_missing` for the poisoned payload.
 * 200ms = 5 req/sec ≈ 300/min, which leaves ample headroom for ad-hoc
 * traffic on the same key and keeps the sweep firmly under the per-minute
 * ceiling without artificially slowing the run beyond what the provider
 * allows.
 *
 * Production override: `SWEEP_INTER_CALL_DELAY_MS` env var (read at call
 * time, NOT at module init, so test-setup.ts can pin it to 0).
 * Caller override: `SweepMissingPayloadsInput.intercallDelayMs`, which wins
 * over the env var when set.
 */
const DEFAULT_INTER_CALL_DELAY_MS = 200;

const resolveInterCallDelayMs = (override?: number): number => {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override;
  }
  const raw = Number(process.env.SWEEP_INTER_CALL_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTER_CALL_DELAY_MS;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

interface WorkloadBinding {
  readonly workload: IngestionWorkload;
  readonly path: (fixtureId: string) => string;
  readonly protoKind: GameMissingPayloadKind;
}

/**
 * Per-kind binding: which provider workload to fire, which `/fixtures/*`
 * path to hit, and which proto enum value to send on the
 * ListGamesMissingPayloads request. Centralised here so the kind→workload
 * mapping is verifiable in tests and so a new kind (e.g. ratings, odds)
 * only touches this table.
 */
const KIND_BINDINGS: Record<SweepMissingPayloadKind, WorkloadBinding> = {
  'team-match-stats': {
    workload: 'team-match-stats',
    path: apiFootballFixtureStatisticsPath,
    protoKind: GameMissingPayloadKind.TEAM_MATCH_STATS,
  },
  'player-match-stats': {
    workload: 'player-match-stats',
    path: apiFootballFixturePlayersPath,
    protoKind: GameMissingPayloadKind.PLAYER_MATCH_STATS,
  },
  events: {
    workload: 'events-post-final',
    path: apiFootballEventPath,
    protoKind: GameMissingPayloadKind.EVENTS,
  },
  lineups: {
    workload: 'lineups-post-confirm',
    path: apiFootballLineupPath,
    protoKind: GameMissingPayloadKind.LINEUPS,
  },
};

const SUPPORTED_PROVIDERS = new Set(['api-football']);

const clampLimit = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), MAX_LIMIT);
};

const parseIsoTimestamp = (value: string | undefined): Timestamp | undefined => {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return timestampFromDate(date);
};

/**
 * Page through `GameService.ListGamesMissingPayloads` accumulating
 * provider-fixture ids up to `limit`. Returns ids in the order the server
 * returns them (today: scheduled_start_at descending) so most-recent gaps
 * are filled first when the call budget runs out partway through.
 */
const discoverFixtureIds = async (
  args: {
    readonly providerId: string;
    readonly kind: SweepMissingPayloadKind;
    readonly limit: number;
    readonly since?: string;
    readonly until?: string;
  },
  deps: WorkflowDeps
): Promise<{ readonly ids: readonly string[]; readonly totalCount: number }> => {
  const client = deps.gameServiceMissingPayloads;
  if (!client) {
    throw new Error(
      'sweep-missing-payloads: gameServiceMissingPayloads client not configured; ' +
        'provide an explicit fixtureIds list for ops one-shot mode'
    );
  }
  const binding = KIND_BINDINGS[args.kind];
  const ids: string[] = [];
  let pageToken = '';
  let totalCount = 0;
  while (ids.length < args.limit) {
    const pageSize = Math.min(DEFAULT_PAGE_SIZE, args.limit - ids.length);
    const request = create(ListGamesMissingPayloadsRequestSchema, {
      kind: binding.protoKind,
      pageSize,
      pageToken,
      provider: args.providerId,
    });
    const since = parseIsoTimestamp(args.since);
    if (since) {
      request.since = since;
    }
    const until = parseIsoTimestamp(args.until);
    if (until) {
      request.until = until;
    }
    const response = await client.listGamesMissingPayloads(request);
    // Server returns -1 when total isn't computed; normalise to 0 so the
    // wire shape stays a non-negative count.
    const respTotal = Number(response.totalCount);
    if (Number.isFinite(respTotal) && respTotal > totalCount) {
      totalCount = respTotal;
    }
    for (const entry of response.entries) {
      if (entry.providerFixtureId !== '') {
        ids.push(entry.providerFixtureId);
        if (ids.length >= args.limit) {
          break;
        }
      }
    }
    if (!response.nextPageToken || response.entries.length === 0) {
      break;
    }
    pageToken = response.nextPageToken;
  }
  return { ids, totalCount: totalCount === 0 ? ids.length : totalCount };
};

export const sweepMissingPayloadsWorkflow = async (
  input: SweepMissingPayloadsInput,
  deps: WorkflowDeps
): Promise<SweepMissingPayloadsOutput> => {
  const log = deps.logger ?? (() => undefined);
  const clock = deps.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const dryRun = input.dryRun === true;

  log({
    event: 'sweep_missing_payloads.started',
    workflow: 'sweep-missing-payloads',
    workload: input.kind,
    reason: dryRun ? 'dryRun' : undefined,
  });

  // Reject unsupported providers up front so a misconfigured caller gets a
  // structured skip instead of burning fixtures-discovered cycles.
  if (!SUPPORTED_PROVIDERS.has(input.providerId)) {
    const finishedAt = clock().toISOString();
    return {
      startedAt,
      finishedAt,
      providerId: input.providerId,
      kind: input.kind,
      fixturesDiscovered: 0,
      fixturesProcessed: 0,
      fixturesOk: 0,
      fixturesSkipped: 0,
      fixturesFailed: 0,
      callsUsed: 0,
      status: 'skipped',
      degradeFlags: [],
      finalQuota: undefined,
      errors: [],
      dryRun,
      reason: `unsupported provider ${input.providerId}`,
    };
  }

  const binding = KIND_BINDINGS[input.kind];
  const limit = clampLimit(input.limit);

  let fixtureIds: readonly string[];
  let discoveredTotal: number;
  if (input.fixtureIds !== undefined) {
    // Explicit list: trust the caller, clamp to limit so an ops one-shot
    // can't accidentally drain the daily provider budget.
    const deduped = Array.from(new Set(input.fixtureIds.filter((id) => id !== '')));
    fixtureIds = deduped.slice(0, limit);
    discoveredTotal = deduped.length;
  } else {
    try {
      const discovery = await discoverFixtureIds(
        {
          providerId: input.providerId,
          kind: input.kind,
          limit,
          since: input.since,
          until: input.until,
        },
        deps
      );
      fixtureIds = discovery.ids;
      discoveredTotal = discovery.totalCount;
    } catch (err) {
      const finishedAt = clock().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      log({
        event: 'sweep_missing_payloads.discover_failed',
        workflow: 'sweep-missing-payloads',
        reason: message,
      });
      return {
        startedAt,
        finishedAt,
        providerId: input.providerId,
        kind: input.kind,
        fixturesDiscovered: 0,
        fixturesProcessed: 0,
        fixturesOk: 0,
        fixturesSkipped: 0,
        fixturesFailed: 0,
        callsUsed: 0,
        status: 'aborted',
        degradeFlags: [],
        finalQuota: undefined,
        errors: [message],
        dryRun,
        reason: `discover_failed: ${message}`,
      };
    }
  }

  log({
    event: 'sweep_missing_payloads.discovered',
    workflow: 'sweep-missing-payloads',
    workload: input.kind,
    fixturesIngested: fixtureIds.length,
  });

  if (fixtureIds.length === 0) {
    const finishedAt = clock().toISOString();
    return {
      startedAt,
      finishedAt,
      providerId: input.providerId,
      kind: input.kind,
      fixturesDiscovered: discoveredTotal,
      fixturesProcessed: 0,
      fixturesOk: 0,
      fixturesSkipped: 0,
      fixturesFailed: 0,
      callsUsed: 0,
      status: 'completed',
      degradeFlags: [],
      finalQuota: undefined,
      errors: [],
      dryRun,
    };
  }

  if (dryRun) {
    const finishedAt = clock().toISOString();
    log({
      event: 'sweep_missing_payloads.dry_run_completed',
      workflow: 'sweep-missing-payloads',
      fixturesIngested: fixtureIds.length,
    });
    return {
      startedAt,
      finishedAt,
      providerId: input.providerId,
      kind: input.kind,
      fixturesDiscovered: discoveredTotal,
      fixturesProcessed: 0,
      fixturesOk: 0,
      fixturesSkipped: 0,
      fixturesFailed: 0,
      callsUsed: 0,
      status: 'completed',
      degradeFlags: [],
      finalQuota: undefined,
      errors: [],
      dryRun,
    };
  }

  const flags: DegradeFlag[] = [];
  const errors: string[] = [];
  let lastQuota: ProviderQuotaSnapshot | undefined;
  let mode: DegradeAction = 'continue';
  let callsUsed = 0;
  let processed = 0;
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;

  const accumulate = (
    result: IngestionFetchResult,
    fixtureId: string,
    currentMode: DegradeAction
  ): DegradeAction => {
    lastQuota = result.quota;
    if (result.fetch !== undefined) {
      callsUsed += 1;
    }
    if (result.status === 'fetched' || result.status === 'cached') {
      ok += 1;
    } else if (
      result.status === 'skipped' ||
      result.status === 'denied' ||
      result.status === 'rate_limited'
    ) {
      // Rate-limit responses are soft failures (the provider WILL serve the
      // payload on the next per-minute window) so we count them as `skipped`
      // for ok/failed accounting. The degrade flag below tells ops why.
      skipped += 1;
    } else {
      failed += 1;
    }
    if (result.error) {
      errors.push(`${binding.workload}:${fixtureId}:${result.error.message}`);
    }
    const quotaResult = handleQuotaPosture(result.quota);
    if (quotaResult.flag) {
      flags.push(quotaResult.flag);
    }
    if (result.fallbackReason === 'PROVIDER_OUTAGE') {
      const outage = handleProviderOutage({ fallbackReason: result.fallbackReason });
      if (outage.flag) {
        flags.push(outage.flag);
      }
    } else if (result.fallbackReason === 'PROVIDER_RATE_LIMITED') {
      const rateLimited = handleProviderRateLimited({
        fallbackReason: result.fallbackReason,
        detail: result.error?.message,
      });
      if (rateLimited.flag) {
        flags.push(rateLimited.flag);
      }
    }
    return mostRestrictive([
      currentMode,
      quotaResult.action,
      result.fallbackReason === 'PROVIDER_OUTAGE' ? 'cached-only' : 'continue',
      result.fallbackReason === 'PROVIDER_RATE_LIMITED' ? 'skip-non-essential' : 'continue',
    ]);
  };

  const interCallDelayMs = resolveInterCallDelayMs(input.intercallDelayMs);
  for (let i = 0; i < fixtureIds.length; i += 1) {
    if (mode === 'abort') {
      aborted = true;
      break;
    }
    if (i > 0) {
      // Throttle inter-call cadence so a 500-fixture sweep stays comfortably
      // under api-football's per-minute cap. See DEFAULT_INTER_CALL_DELAY_MS
      // doc-block for the rationale.
      await sleep(interCallDelayMs);
    }
    const fixtureId = fixtureIds[i]!;
    try {
      const result = await deps.ingestion.fetchWorkload({
        workload: binding.workload,
        resourceId: fixtureId,
        path: binding.path(fixtureId),
      });
      processed += 1;
      mode = accumulate(result, fixtureId, mode);
    } catch (err) {
      processed += 1;
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${binding.workload}:${fixtureId}:${message}`);
    }
  }

  const finishedAt = clock().toISOString();
  let status: SweepMissingPayloadsOutput['status'];
  if (aborted) {
    status = 'aborted';
  } else if (ok === 0 && (failed > 0 || skipped > 0)) {
    // All attempts ended in failure or denial — surface as aborted so ops
    // tooling can distinguish "nothing landed" from a normal partial.
    status = 'aborted';
  } else if (failed > 0 || skipped > 0 || processed < fixtureIds.length) {
    // Some fixtures landed, others didn't — partial run. Ops can re-invoke
    // with the same kind to fill the remaining gap (the cache + emit-once
    // gate make replays cheap).
    status = 'partial';
  } else {
    status = 'completed';
  }

  log({
    event: 'sweep_missing_payloads.finished',
    workflow: 'sweep-missing-payloads',
    workload: input.kind,
    status,
    callsUsed,
    fixturesIngested: ok,
  });

  return {
    startedAt,
    finishedAt,
    providerId: input.providerId,
    kind: input.kind,
    fixturesDiscovered: discoveredTotal,
    fixturesProcessed: processed,
    fixturesOk: ok,
    fixturesSkipped: skipped,
    fixturesFailed: failed,
    callsUsed,
    status,
    degradeFlags: flags,
    finalQuota: lastQuota,
    errors,
    dryRun,
    reason: aborted ? 'aborted by degrade posture' : undefined,
  };
};
