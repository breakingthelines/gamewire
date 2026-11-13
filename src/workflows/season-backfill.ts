/**
 * Historical season-import (backfill) workflow.
 *
 * The steady-state cadence (daily-anchor + hourly-matchday) deliberately
 * touches only a bounded -1d/+7d fixture window so a routine sweep stays
 * cheap. That leaves a competition's *already-played* fixtures — an
 * entire season of finals, timelines, and lineups — unimported. This
 * workflow fills that gap: given a competition+season (or a list of all
 * Phase A competitions across recent + current seasons) it walks the
 * FULL season fixture list and drives each finalised fixture through the
 * same ingestion path the live loops use.
 *
 * It deliberately reuses, rather than reinvents, the existing primitives:
 *   - `deps.ingestion.fetchWorkload(...)` — the single cache → singleflight
 *     → quota → provider-HTTP → cache-write → bridge pipeline. Every fetch
 *     here flows through it, so the quota counter, the 70k hard cap, the
 *     soft-cap PROVIDER_OUTAGE flip, and the cache TTLs all apply unchanged.
 *   - The `onFixtureFetched` bridge wired into the loop at boot — it owns
 *     the canonical-id mint (`IngestGames` → `provider_game_mappings`
 *     crosswalk), the occurrence/lineup ingest, and the emit-once
 *     match-concluded gate. The backfill never calls game-service
 *     directly.
 *   - The degrade handlers in `degrade.ts` — quota posture and provider
 *     outage degrade identically to the other workflows.
 *
 * Idempotency. Re-running the workflow re-feeds the same canonical
 * fixture ids through `fetchWorkload`. A warm cache short-circuits the
 * provider call; game-service `Ingest*` RPCs upsert on the provider
 * fixture id (no duplicate games, no duplicate occurrences/lineups); and
 * the publisher's `RedisEmittedFixtureStore` gate means a fixture's
 * match-concluded fact is emitted at most once. The persisted cursor is a
 * *performance* optimisation on top of that correctness floor: a resumed
 * run skips fixtures it already processed instead of re-walking them.
 *
 * Resumability + throttling. The season fixture list and a `nextIndex`
 * are persisted in `deps.stateStore` (Redis in production, key
 * `gamewire:cache:backfill:cursor:{league}:{season}`), falling back to the
 * ingestion cache when no state store is wired. The ingestion cache is process
 * memory in production, so before the state store a pod restart dropped every
 * cursor and the next run walked each season again from fixture 0. Each invocation processes fixtures
 * until it either finishes the season or hits `maxCallsPerRun` (the
 * per-run throttle that stops one backfill from draining the day's whole
 * provider quota and starving the live loops), then checkpoints and
 * returns `incomplete`. The caller (a Temporal schedule or a one-shot
 * operator POST) simply re-invokes until `status === 'complete'`.
 *
 * This workflow does NOT change the steady-state daily-anchor/hourly cron
 * — it is a separate, on-demand endpoint.
 */
import { create } from '@bufbuild/protobuf';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import {
  API_FOOTBALL_PROVIDER_ID,
  apiFootballEventPath,
  apiFootballFixturePath,
  apiFootballFixturePlayersPath,
  apiFootballFixtureStatisticsPath,
  apiFootballLineupPath,
} from '../adapters/api-football/index.js';
import type { ProviderCache } from '../worker/cache.js';
import type { IngestionFetchResult, IngestionWorkload } from '../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { handleProviderOutage, handleQuotaPosture, mostRestrictive } from './degrade.js';
import type {
  DegradeAction,
  DegradeFlag,
  SeasonBackfillDryRunTarget,
  SeasonBackfillInput,
  SeasonBackfillOutput,
  SeasonBackfillTarget,
  SeasonBackfillTargetResult,
  WorkflowDeps,
} from './types.js';
import { WORKFLOW_PROVIDER_PRIORITY } from './types.js';

/**
 * Default per-run provider-call ceiling. Sized well under the 70k/day
 * hard cap so a backfill run leaves ample headroom for the live
 * ingestion loops and the daily/hourly sweeps on the same UTC day. A
 * full top-five league season is ~380 fixtures × (detail + events +
 * lineups) ≈ 1,140 calls + standings, so this budget completes a typical
 * single-competition season in one run while still capping a worst-case
 * many-competition invocation.
 */
export const DEFAULT_MAX_CALLS_PER_RUN = 5_000;

/** Cursor schema version — bump if the persisted shape changes. */
const CURSOR_VERSION = 1;

/** TTL for a persisted cursor. Long enough to outlive many Temporal
 * retry attempts + operator re-runs, short enough to self-clean a
 * season nobody resumed. */
const CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;

const FIXTURE_DETAIL_WORKLOAD: IngestionWorkload = 'fixture-detail-fullTime';
const EVENTS_WORKLOAD: IngestionWorkload = 'events-post-final';
const LINEUPS_WORKLOAD: IngestionWorkload = 'lineups-post-confirm';
const TEAM_STATS_WORKLOAD: IngestionWorkload = 'team-match-stats';
const PLAYER_STATS_WORKLOAD: IngestionWorkload = 'player-match-stats';
const STANDINGS_WORKLOAD: IngestionWorkload = 'fixtures-next-7d';
const SEASON_FIXTURES_WORKLOAD: IngestionWorkload = 'fixtures-next-7d';
/**
 * A dry run reads the season list under a workload outside the ingest bridge
 * (`BRIDGE_WORKLOADS` in ingestion.ts), so the list mints no games. PF-GW1
 * uses this workload for the same reason.
 */
const DRY_RUN_FIXTURES_WORKLOAD: IngestionWorkload = 'provider-fixture-results';

/**
 * Back-off before each retry of a call the provider or the minute limiter
 * refused for rate (`rate_limited`). The provider refuses short bursts with
 * "too many requests ... per minute", so a refusal says more about the
 * second it landed in than about the minute: retry soon, then back off. After
 * the last wait the fixture is held and the cursor stays on it.
 */
const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Standings + season list, once per target. */
const CALLS_PER_TARGET = 2;
/** Per-fixture pulls: detail, events, lineups, team stats, player stats. */
const CALLS_PER_FIXTURE = 5;

/**
 * Finalised provider statuses. Only these fixtures carry a settled
 * scoreline + timeline + lineup worth importing; scheduled/postponed/
 * cancelled fixtures are skipped (they have nothing to ingest and would
 * waste budget). WO = walkover, AWD = technical/awarded result.
 */
const FINALISED_STATUSES = new Set(['FT', 'AET', 'PEN', 'WO', 'AWD']);

interface SeasonCursor {
  readonly version: number;
  readonly leagueId: number;
  readonly season: number;
  /**
   * True once the season fixture list has been materialised from the
   * provider, even if it yielded zero finalised fixtures. Distinguishes
   * "discovered an empty season" (don't re-spend the /fixtures call on
   * resume) from "not yet discovered".
   */
  readonly discovered: boolean;
  /** Discovered finalised fixture ids, in stable provider order. */
  readonly fixtureIds: readonly string[];
  /** Index into `fixtureIds` of the next fixture to process. */
  readonly nextIndex: number;
  /** Standings already pulled this season — don't re-spend the call. */
  readonly standingsDone: boolean;
}

const cursorKey = (leagueId: number, season: number): string =>
  `backfill:cursor:${leagueId}:${season}`;

const targetLabel = (target: ResolvedTarget): string =>
  `${target.competitionKey ?? `league-${target.leagueId}`}:${target.season}`;

const seasonFixturesPath = (leagueId: number, season: number): string =>
  `/fixtures?league=${leagueId}&season=${season}`;

const standingsPath = (leagueId: number, season: number): string =>
  `/standings?league=${leagueId}&season=${season}`;

const seasonFixturesResourceId = (leagueId: number, season: number): string =>
  `backfill-fixtures-${leagueId}-${season}`;

const standingsResourceId = (leagueId: number, season: number): string =>
  `backfill-standings-${leagueId}-${season}`;

interface ResolvedTarget {
  readonly competitionKey?: string;
  readonly leagueId: number;
  readonly season: number;
}

export const seasonBackfillWorkflow = async (
  input: SeasonBackfillInput,
  deps: WorkflowDeps
): Promise<SeasonBackfillOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const startedAt = input.nowUtc ? new Date(input.nowUtc) : clock();
  const maxCallsPerRun =
    input.maxCallsPerRun && input.maxCallsPerRun > 0
      ? input.maxCallsPerRun
      : DEFAULT_MAX_CALLS_PER_RUN;
  const cache = deps.stateStore ?? deps.ingestion.cache;

  const targets = resolveTargets(input, deps);

  if (input.dryRun) {
    return dryRunWorkflow({ input, deps, targets, startedAt, maxCallsPerRun, log, clock });
  }

  log({
    event: 'season_backfill.started',
    workflow: 'season-backfill',
    reason: `${targets.length} target(s), maxCallsPerRun=${maxCallsPerRun}`,
  });

  const targetResults: SeasonBackfillTargetResult[] = [];
  const degradeFlags: DegradeFlag[] = [];
  let totalCallsBudgeted = 0;
  let totalCallsUsed = 0;
  let totalFixturesProcessed = 0;
  let finalQuota: ProviderQuotaSnapshot | undefined;
  // Run-level budget: shared across every target so the whole invocation
  // honours one ceiling. A target that exhausts the budget checkpoints
  // and later targets are left for a subsequent run.
  const budget: RunBudget = { remaining: maxCallsPerRun };
  let aborted = false;
  let halted = false;

  for (const target of targets) {
    if (aborted || halted) {
      // Carry the untouched target into the result so the caller can see
      // what is still outstanding, without spending any calls on it.
      targetResults.push(skippedTargetResult(target, await readCursor(cache, target, input.reset)));
      continue;
    }
    const result = await backfillTarget({
      target,
      deps,
      cache,
      budget,
      reset: input.reset ?? false,
      skipPlayerStats: input.skipPlayerStats ?? false,
      skipLineups: input.skipLineups ?? false,
      bypassCache: input.bypassCache ?? false,
      log,
    });
    targetResults.push(result.summary);
    totalCallsBudgeted += result.summary.callsBudgeted;
    totalCallsUsed += result.summary.callsUsed;
    totalFixturesProcessed += result.summary.fixturesProcessed;
    finalQuota = result.finalQuota ?? finalQuota;
    degradeFlags.push(...result.flags);
    if (result.action === 'abort') {
      aborted = true;
      log({
        event: 'season_backfill.aborted',
        workflow: 'season-backfill',
        competition: target.competitionKey,
        season: target.season,
        reason: 'quota hard cap',
      });
    } else if (result.action === 'cached-only') {
      // Soft cap or background daily cap: later targets would only be refused.
      halted = true;
      log({
        event: 'season_backfill.halted',
        workflow: 'season-backfill',
        competition: target.competitionKey,
        season: target.season,
        reason: 'quota posture cached-only',
      });
    } else if (budget.remaining <= 0) {
      halted = true;
      log({
        event: 'season_backfill.budget_exhausted',
        workflow: 'season-backfill',
        competition: target.competitionKey,
        season: target.season,
        reason: `per-run call budget ${maxCallsPerRun} exhausted`,
      });
    }
  }

  const finishedAt = clock();
  const status: SeasonBackfillOutput['status'] = aborted
    ? 'aborted'
    : targetResults.every((t) => t.complete)
      ? 'complete'
      : 'incomplete';

  log({
    event: 'season_backfill.finished',
    workflow: 'season-backfill',
    status,
    callsBudgeted: totalCallsBudgeted,
    callsUsed: totalCallsUsed,
    fixturesIngested: totalFixturesProcessed,
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    callsBudgeted: totalCallsBudgeted,
    callsUsed: totalCallsUsed,
    fixturesProcessed: totalFixturesProcessed,
    targets: targetResults,
    degradeFlags,
    finalQuota,
  };
};

interface RunBudget {
  remaining: number;
}

interface BackfillTargetArgs {
  readonly target: ResolvedTarget;
  readonly deps: WorkflowDeps;
  readonly cache: ProviderCache;
  readonly budget: RunBudget;
  readonly reset: boolean;
  readonly skipPlayerStats: boolean;
  readonly skipLineups: boolean;
  readonly bypassCache: boolean;
  readonly log: NonNullable<WorkflowDeps['logger']>;
}

interface BackfillTargetOutcome {
  readonly summary: SeasonBackfillTargetResult;
  readonly flags: readonly DegradeFlag[];
  readonly action: DegradeAction;
  readonly finalQuota?: ProviderQuotaSnapshot;
}

const backfillTarget = async (args: BackfillTargetArgs): Promise<BackfillTargetOutcome> => {
  const { target, deps, cache, budget, log } = args;
  const { leagueId, season } = target;
  const errors: string[] = [];
  const flags: DegradeFlag[] = [];
  let callsBudgeted = 0;
  let callsUsed = 0;
  let fixturesProcessed = 0;
  let lastQuota: ProviderQuotaSnapshot | undefined;
  let mode: DegradeAction = 'continue' as DegradeAction;
  let rateLimitRetries = 0;

  const accumulate = (
    result: IngestionFetchResult,
    workload: IngestionWorkload,
    resourceId: string,
    currentMode: DegradeAction,
    options: AccumulateOptions = {}
  ): DegradeAction => {
    callsBudgeted += 1;
    budget.remaining -= 1;
    if (result.status === 'fetched') {
      callsUsed += 1;
    }
    if (options.quiet) {
      // A refused attempt that will be retried: it spends budget, but it is
      // not an error of the run and raises no degrade flag.
      rateLimitRetries += 1;
      return currentMode;
    }
    if (result.error) {
      errors.push(`${workload}:${resourceId}:${result.error.message}`);
    }
    lastQuota = result.quota;
    const quotaResult = handleQuotaPosture(result.quota);
    if (quotaResult.flag) {
      flags.push(quotaResult.flag);
    }
    if (result.fallbackReason) {
      const outage = handleProviderOutage({ fallbackReason: result.fallbackReason });
      if (outage.flag) {
        flags.push(outage.flag);
      }
    }
    return mostRestrictive([
      currentMode,
      quotaResult.action,
      result.fallbackReason === 'PROVIDER_OUTAGE' ? 'cached-only' : 'continue',
    ]);
  };

  // Load (or initialise) the resumable cursor. `reset` discards any
  // persisted state so a fresh discovery happens; correctness does not
  // depend on it (the ingest path is idempotent), only the resume
  // optimisation does.
  let cursor = await readCursor(cache, target, args.reset);

  log({
    event: 'season_backfill.target_started',
    workflow: 'season-backfill',
    competition: target.competitionKey,
    season,
    reason: `${cursor ? `resume@${cursor.nextIndex}/${cursor.fixtureIds.length}` : 'fresh'} cursorStore=${cache.backend}`,
  });

  // Step 1: standings (once per season). Cheap, warms the league table,
  // and is skipped on resume once recorded in the cursor.
  if (!cursor || !cursor.standingsDone) {
    if (budget.remaining <= 0) {
      return finalize(
        target,
        cursor,
        callsBudgeted,
        callsUsed,
        fixturesProcessed,
        errors,
        flags,
        mode,
        lastQuota,
        rateLimitRetries
      );
    }
    const standingsResult = await deps.ingestion.fetchWorkload({
      priority: WORKFLOW_PROVIDER_PRIORITY,
      workload: STANDINGS_WORKLOAD,
      resourceId: standingsResourceId(leagueId, season),
      path: standingsPath(leagueId, season),
    });
    mode = accumulate(
      standingsResult,
      STANDINGS_WORKLOAD,
      standingsResourceId(leagueId, season),
      mode
    );
    if (mode === 'abort') {
      return finalize(
        target,
        cursor,
        callsBudgeted,
        callsUsed,
        fixturesProcessed,
        errors,
        flags,
        mode,
        lastQuota,
        rateLimitRetries
      );
    }
    // Standings succeeded (or cache-hit/soft-degraded but not aborted);
    // mark it done in the cursor we will persist below.
    cursor = withStandingsDone(cursor, target);
  }

  // Step 2: discover the full season fixture list once. On resume we
  // trust the persisted list rather than re-paginating — API-Football
  // returns the whole season in a single /fixtures?league&season page,
  // so "pagination" here is list materialisation + cursored consumption
  // rather than HTTP page-walking. If the provider ever splits the
  // season across pages, this is the single place that changes. The
  // `discovered` flag (not list length) gates re-discovery so a season
  // that genuinely has zero finalised fixtures is not re-fetched.
  if (!cursor || !cursor.discovered) {
    if (budget.remaining <= 0) {
      return finalize(
        target,
        cursor,
        callsBudgeted,
        callsUsed,
        fixturesProcessed,
        errors,
        flags,
        mode,
        lastQuota,
        rateLimitRetries
      );
    }
    const fixturesResult = await deps.ingestion.fetchWorkload({
      priority: WORKFLOW_PROVIDER_PRIORITY,
      workload: SEASON_FIXTURES_WORKLOAD,
      resourceId: seasonFixturesResourceId(leagueId, season),
      path: seasonFixturesPath(leagueId, season),
    });
    mode = accumulate(
      fixturesResult,
      SEASON_FIXTURES_WORKLOAD,
      seasonFixturesResourceId(leagueId, season),
      mode
    );
    if (mode === 'abort') {
      return finalize(
        target,
        cursor,
        callsBudgeted,
        callsUsed,
        fixturesProcessed,
        errors,
        flags,
        mode,
        lastQuota,
        rateLimitRetries
      );
    }
    const fixtureIds = finalisedFixtureIds(fixturesResult.data);
    cursor = {
      version: CURSOR_VERSION,
      leagueId,
      season,
      discovered: true,
      fixtureIds,
      nextIndex: 0,
      standingsDone: cursor?.standingsDone ?? true,
    };
    await writeCursor(cache, cursor);
    log({
      event: 'season_backfill.fixtures_discovered',
      workflow: 'season-backfill',
      competition: target.competitionKey,
      season,
      fixturesIngested: fixtureIds.length,
    });
  }

  // Step 3: walk the cursor — for each remaining finalised fixture pull
  // detail → events → lineups. The bridge does the canonical mint +
  // ingest + emit. We checkpoint the cursor after each fixture so a
  // budget/quota/crash stop loses at most one fixture's progress.
  let index = cursor.nextIndex;
  const total = cursor.fixtureIds.length;
  let held = false;
  while (index < total) {
    // Stop at the start of a fixture once the per-run budget is spent or
    // a hard cap aborted us — never mid-fixture, so a checkpoint never
    // leaves a fixture half-imported. A fixture in flight may over-run
    // the budget by at most two calls (events + lineups after detail),
    // which is a negligible, bounded slop on a soft throttle.
    if (budget.remaining <= 0 || mode === 'abort') {
      break;
    }
    // Soft cap or background daily cap: the day's provider budget belongs to
    // live and the scheduled sweeps. Checkpoint and let a later run resume.
    if (mode === 'cached-only') {
      break;
    }

    const fixtureId = cursor.fixtureIds[index];
    if (fixtureId === undefined) {
      index += 1;
      continue;
    }

    const outcome = await processFixture({
      fixtureId,
      deps,
      accumulate,
      currentMode: mode,
      skipPlayerStats: args.skipPlayerStats,
      skipLineups: args.skipLineups,
      bypassCache: args.bypassCache,
    });
    mode = outcome.mode;
    if (outcome.held) {
      // Not advancing: a refused call means this fixture was not pulled,
      // and moving the cursor past it would mark it done with no data.
      held = true;
      break;
    }

    index += 1;
    fixturesProcessed += 1;
    // Checkpoint after every fixture: the next run resumes exactly here.
    cursor = { ...cursor, nextIndex: index };
    await writeCursor(cache, cursor);
  }

  if (held) {
    log({
      event: 'season_backfill.held',
      workflow: 'season-backfill',
      competition: target.competitionKey,
      season,
      reason: `call refused at fixture ${index + 1}/${total}; cursor kept there`,
    });
  }

  return finalize(
    target,
    cursor,
    callsBudgeted,
    callsUsed,
    fixturesProcessed,
    errors,
    flags,
    mode,
    lastQuota,
    rateLimitRetries
  );
};

interface AccumulateOptions {
  /** Count the attempt against the budget only (a rate refusal about to be retried). */
  readonly quiet?: boolean;
}

interface ProcessFixtureArgs {
  readonly fixtureId: string;
  readonly deps: WorkflowDeps;
  readonly accumulate: (
    result: IngestionFetchResult,
    workload: IngestionWorkload,
    resourceId: string,
    currentMode: DegradeAction,
    options?: AccumulateOptions
  ) => DegradeAction;
  readonly currentMode: DegradeAction;
  /** Skip the player stats pull (four calls a fixture, no player rows). */
  readonly skipPlayerStats?: boolean;
  /** Skip the lineups pull (no football_lineups rows). */
  readonly skipLineups?: boolean;
  /** Keep the per-fixture payloads out of the shared provider cache. */
  readonly bypassCache?: boolean;
}

/**
 * Pull the five fixture-scoped workloads for one finalised fixture:
 * detail → events → lineups → team stats → player stats. Identical
 * workload sequence to {@link webhookCompletedWorkflow} so the bridge
 * resolves + ingests + emits the same way; the only difference is the
 * driving loop (a season cursor vs a single webhook fixture id). Every
 * fetch flows through `fetchWorkload`, so the quota counter, 70k hard cap,
 * soft-cap PROVIDER_OUTAGE flip, cache TTLs, and singleflight all apply to
 * the stats pulls exactly as they do to detail/events/lineups.
 */
const processFixture = async (args: ProcessFixtureArgs): Promise<FixtureOutcome> => {
  const { fixtureId, deps, accumulate } = args;
  let mode = args.currentMode;
  const cache = args.bypassCache ? ('bypass' as const) : undefined;
  const steps: readonly { workload: IngestionWorkload; path: string }[] = [
    { workload: FIXTURE_DETAIL_WORKLOAD, path: apiFootballFixturePath(fixtureId) },
    { workload: EVENTS_WORKLOAD, path: apiFootballEventPath(fixtureId) },
    ...(args.skipLineups
      ? []
      : [{ workload: LINEUPS_WORKLOAD, path: apiFootballLineupPath(fixtureId) }]),
    { workload: TEAM_STATS_WORKLOAD, path: apiFootballFixtureStatisticsPath(fixtureId) },
    ...(args.skipPlayerStats
      ? []
      : [{ workload: PLAYER_STATS_WORKLOAD, path: apiFootballFixturePlayersPath(fixtureId) }]),
  ];

  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.logger ?? (() => undefined);

  for (const step of steps) {
    const fetchStep = () =>
      deps.ingestion.fetchWorkload({
        priority: WORKFLOW_PROVIDER_PRIORITY,
        workload: step.workload,
        resourceId: fixtureId,
        path: step.path,
        cache,
      });
    let result = await fetchStep();
    // A rate refusal (provider "too many requests", or the minute limiter
    // still full after its own wait) passes: back off and retry the same
    // call instead of ending the walk.
    for (const waitMs of RATE_LIMIT_BACKOFF_MS) {
      if (result.status !== 'rate_limited') {
        break;
      }
      mode = accumulate(result, step.workload, fixtureId, mode, { quiet: true });
      log({
        event: 'season_backfill.rate_limited',
        workflow: 'season-backfill',
        reason: `${step.workload}:${fixtureId} ${result.throttled ? 'limiter' : 'provider'}; retry in ${waitMs}ms`,
      });
      await sleep(waitMs);
      result = await fetchStep();
    }
    mode = accumulate(result, step.workload, fixtureId, mode);
    if (HELD_STATUSES.has(result.status)) {
      // Quota or the minute limiter refused the call: the fixture was not
      // pulled. The caller must not advance past it.
      return { mode, held: true };
    }
    if (mode === 'abort') {
      return { mode, held: false };
    }
  }
  return { mode, held: false };
};

interface FixtureOutcome {
  readonly mode: DegradeAction;
  /** A call was refused (quota, background cap, minute limiter, no key); the fixture is not done. */
  readonly held: boolean;
}

/**
 * Statuses that mean the call never got data for a reason that passes
 * (`denied`: hard or background daily cap; `rate_limited`: minute limiter or
 * provider throttle; `skipped`: no key or replay mode). A `failed` call
 * reached the provider and is recorded as an error, and the walk moves on.
 */
const HELD_STATUSES: ReadonlySet<IngestionFetchResult['status']> = new Set([
  'denied',
  'rate_limited',
  'skipped',
]);

interface DryRunArgs {
  readonly input: SeasonBackfillInput;
  readonly deps: WorkflowDeps;
  readonly targets: readonly ResolvedTarget[];
  readonly startedAt: Date;
  readonly maxCallsPerRun: number;
  readonly log: NonNullable<WorkflowDeps['logger']>;
  readonly clock: () => Date;
}

/**
 * Plan a backfill without writing anything. Each target costs one provider
 * call: the season list, read under {@link DRY_RUN_FIXTURES_WORKLOAD} with the
 * cache bypassed, so no game is minted and nothing is cached. The cursor is
 * not read or written. Every distinct team in the list is resolved through
 * identity (no provider call) and the misses are reported: those teams would
 * land on `provider:api-football:team:<id>` ids in a real run.
 */
const dryRunWorkflow = async (args: DryRunArgs): Promise<SeasonBackfillOutput> => {
  const { input, deps, targets, startedAt, maxCallsPerRun, log, clock } = args;
  const perFixture =
    CALLS_PER_FIXTURE - (input.skipPlayerStats ? 1 : 0) - (input.skipLineups ? 1 : 0);
  const resolveCache = new Map<string, 'resolved' | 'unresolved' | 'error'>();
  const results: SeasonBackfillTargetResult[] = [];
  const degradeFlags: DegradeFlag[] = [];
  let remaining = maxCallsPerRun;
  let callsBudgeted = 0;
  let callsUsed = 0;
  let finalQuota: ProviderQuotaSnapshot | undefined;
  let stopped = false;

  for (const target of targets) {
    if (stopped || remaining <= 0) {
      results.push({ ...emptyTargetResult(target), complete: false });
      continue;
    }
    const resourceId = `${seasonFixturesResourceId(target.leagueId, target.season)}-dryrun`;
    const result = await deps.ingestion.fetchWorkload({
      priority: WORKFLOW_PROVIDER_PRIORITY,
      workload: DRY_RUN_FIXTURES_WORKLOAD,
      resourceId,
      path: seasonFixturesPath(target.leagueId, target.season),
      cache: 'bypass',
    });
    remaining -= 1;
    callsBudgeted += 1;
    if (result.status === 'fetched') {
      callsUsed += 1;
    }
    finalQuota = result.quota;
    const posture = handleQuotaPosture(result.quota);
    if (posture.flag) {
      degradeFlags.push(posture.flag);
    }
    const errors = result.error
      ? [`${DRY_RUN_FIXTURES_WORKLOAD}:${resourceId}:${result.error.message}`]
      : [];
    if (posture.action === 'abort' || result.data === undefined) {
      stopped = posture.action === 'abort';
      results.push({ ...emptyTargetResult(target), complete: false, errors });
      continue;
    }

    const fixturesListed = listedFixtureCount(result.data);
    const fixturesFinalised = finalisedFixtureIds(result.data).length;
    const teams = seasonTeams(result.data);
    const unresolvedTeams: string[] = [];
    let teamLookupErrors = 0;
    for (const team of teams) {
      let outcome = resolveCache.get(team.id);
      if (outcome === undefined) {
        outcome = await resolveTeam(deps, team.id);
        resolveCache.set(team.id, outcome);
      }
      if (outcome === 'unresolved') {
        unresolvedTeams.push(`${team.id}:${team.name}`);
      } else if (outcome === 'error') {
        teamLookupErrors += 1;
      }
    }
    const dryRun: SeasonBackfillDryRunTarget = {
      fixturesListed,
      fixturesFinalised,
      plannedCalls: CALLS_PER_TARGET + fixturesFinalised * perFixture,
      teams: teams.length,
      unresolvedTeams,
      teamLookupErrors,
    };
    log({
      event: 'season_backfill.dry_run_target',
      workflow: 'season-backfill',
      competition: target.competitionKey,
      season: target.season,
      reason: `finalised=${fixturesFinalised} plannedCalls=${dryRun.plannedCalls} unresolvedTeams=${unresolvedTeams.length}`,
    });
    results.push({
      ...emptyTargetResult(target),
      fixturesDiscovered: fixturesFinalised,
      complete: true,
      callsBudgeted: 1,
      callsUsed: result.status === 'fetched' ? 1 : 0,
      errors,
      dryRun,
    });
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: clock().toISOString(),
    status: stopped ? 'aborted' : results.every((t) => t.complete) ? 'complete' : 'incomplete',
    callsBudgeted,
    callsUsed,
    fixturesProcessed: 0,
    targets: results,
    degradeFlags,
    finalQuota,
  };
};

const emptyTargetResult = (target: ResolvedTarget): SeasonBackfillTargetResult => ({
  target: targetLabel(target),
  competition: target.competitionKey,
  apiFootballLeagueId: target.leagueId,
  season: target.season,
  fixturesDiscovered: 0,
  fixturesProcessed: 0,
  cursorIndex: 0,
  complete: false,
  callsBudgeted: 0,
  callsUsed: 0,
  errors: [],
});

const resolveTeam = async (
  deps: WorkflowDeps,
  providerTeamId: string
): Promise<'resolved' | 'unresolved' | 'error'> => {
  if (!deps.identity) {
    return 'error';
  }
  try {
    const response = await deps.identity.resolve(
      create(ResolveRequestSchema, {
        entityType: EntityType.TEAM,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId: providerTeamId,
      })
    );
    return response.found && response.entityId ? 'resolved' : 'unresolved';
  } catch {
    return 'error';
  }
};

const listedFixtureCount = (data: unknown): number =>
  isRecord(data) && Array.isArray(data.response) ? data.response.length : 0;

/** Distinct home and away teams of a season list, in first-seen order. */
export const seasonTeams = (data: unknown): readonly { id: string; name: string }[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const seen = new Map<string, string>();
  for (const item of data.response) {
    const teams = isRecord(item) && isRecord(item.teams) ? item.teams : undefined;
    if (!teams) {
      continue;
    }
    for (const side of [teams.home, teams.away]) {
      if (!isRecord(side)) {
        continue;
      }
      const id =
        typeof side.id === 'number' && Number.isFinite(side.id)
          ? String(side.id)
          : typeof side.id === 'string'
            ? side.id.trim()
            : '';
      if (id === '' || seen.has(id)) {
        continue;
      }
      seen.set(id, typeof side.name === 'string' ? side.name : '');
    }
  }
  return [...seen].map(([id, name]) => ({ id, name }));
};

const finalize = (
  target: ResolvedTarget,
  cursor: SeasonCursor | undefined,
  callsBudgeted: number,
  callsUsed: number,
  fixturesProcessed: number,
  errors: readonly string[],
  flags: readonly DegradeFlag[],
  mode: DegradeAction,
  finalQuota: ProviderQuotaSnapshot | undefined,
  rateLimitRetries = 0
): BackfillTargetOutcome => {
  const fixturesDiscovered = cursor?.fixtureIds.length ?? 0;
  const cursorIndex = cursor?.nextIndex ?? 0;
  const complete = isCursorComplete(cursor) && mode !== 'abort';
  return {
    summary: {
      target: targetLabel(target),
      competition: target.competitionKey,
      apiFootballLeagueId: target.leagueId,
      season: target.season,
      fixturesDiscovered,
      fixturesProcessed,
      cursorIndex,
      complete,
      callsBudgeted,
      callsUsed,
      errors,
      ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
    },
    flags,
    action: mode,
    finalQuota,
  };
};

const skippedTargetResult = (
  target: ResolvedTarget,
  cursor: SeasonCursor | undefined
): SeasonBackfillTargetResult => ({
  target: targetLabel(target),
  competition: target.competitionKey,
  apiFootballLeagueId: target.leagueId,
  season: target.season,
  fixturesDiscovered: cursor?.fixtureIds.length ?? 0,
  fixturesProcessed: 0,
  cursorIndex: cursor?.nextIndex ?? 0,
  complete: isCursorComplete(cursor),
  callsBudgeted: 0,
  callsUsed: 0,
  errors: [],
});

/**
 * A target is complete once its fixture list has been *materialised*
 * (discovery ran — the cursor exists) and the cursor has consumed every
 * discovered fixture. A season that genuinely contains zero finalised
 * fixtures (e.g. a future season, or a tournament that has not kicked
 * off) materialises an empty list and is therefore complete: there is
 * nothing to import, so the caller must not re-invoke it forever. A
 * cursor that is `undefined` (discovery never ran — e.g. the per-run
 * budget was spent before discovery) is NOT complete.
 */
const isCursorComplete = (cursor: SeasonCursor | undefined): boolean =>
  cursor !== undefined && cursor.discovered && cursor.nextIndex >= cursor.fixtureIds.length;

const withStandingsDone = (
  cursor: SeasonCursor | undefined,
  target: ResolvedTarget
): SeasonCursor => ({
  version: CURSOR_VERSION,
  leagueId: target.leagueId,
  season: target.season,
  discovered: cursor?.discovered ?? false,
  fixtureIds: cursor?.fixtureIds ?? [],
  nextIndex: cursor?.nextIndex ?? 0,
  standingsDone: true,
});

/**
 * Expand the workflow input into a concrete, de-duplicated list of
 * league+season targets. Explicit `targets` win; otherwise the catalogue
 * (optionally filtered by `competitions`) is expanded across `seasons`
 * (or each catalogue entry's own season when `seasons` is omitted).
 */
const resolveTargets = (
  input: SeasonBackfillInput,
  deps: WorkflowDeps
): readonly ResolvedTarget[] => {
  const byKey = new Map(deps.competitions.map((c) => [c.key, c]));
  const seen = new Set<string>();
  const out: ResolvedTarget[] = [];

  const push = (resolved: ResolvedTarget): void => {
    if (!Number.isFinite(resolved.leagueId) || resolved.leagueId <= 0) {
      return;
    }
    if (!Number.isFinite(resolved.season) || resolved.season <= 0) {
      return;
    }
    const dedupeKey = `${resolved.leagueId}:${resolved.season}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    out.push(resolved);
  };

  if (input.targets && input.targets.length > 0) {
    for (const target of input.targets) {
      push(resolveOneTarget(target, byKey));
    }
    return out.filter((t) => t.leagueId > 0);
  }

  const keyFilter = new Set(input.competitions ?? []);
  const catalogue = deps.competitions.filter((c) => keyFilter.size === 0 || keyFilter.has(c.key));
  for (const competition of catalogue) {
    const seasons =
      input.seasons && input.seasons.length > 0 ? input.seasons : [competition.season];
    for (const season of seasons) {
      push({
        competitionKey: competition.key,
        leagueId: competition.apiFootballLeagueId,
        season,
      });
    }
  }
  return out;
};

const resolveOneTarget = (
  target: SeasonBackfillTarget,
  byKey: ReadonlyMap<string, { readonly apiFootballLeagueId: number }>
): ResolvedTarget => {
  // Explicit league id wins; otherwise resolve the catalogue key.
  if (target.apiFootballLeagueId !== undefined && target.apiFootballLeagueId > 0) {
    return {
      competitionKey: target.competitionKey,
      leagueId: target.apiFootballLeagueId,
      season: target.season,
    };
  }
  const entry = target.competitionKey ? byKey.get(target.competitionKey) : undefined;
  return {
    competitionKey: target.competitionKey,
    // 0 sentinel → dropped by `push` so an unknown key never produces a
    // bad /fixtures?league=NaN call.
    leagueId: entry?.apiFootballLeagueId ?? 0,
    season: target.season,
  };
};

const readCursor = async (
  cache: ProviderCache,
  target: ResolvedTarget,
  reset: boolean | undefined
): Promise<SeasonCursor | undefined> => {
  if (reset) {
    return undefined;
  }
  const raw = await cache.get<SeasonCursor>(cursorKey(target.leagueId, target.season));
  if (!isValidCursor(raw, target)) {
    return undefined;
  }
  return raw;
};

const writeCursor = async (cache: ProviderCache, cursor: SeasonCursor): Promise<void> => {
  await cache.set(cursorKey(cursor.leagueId, cursor.season), cursor, CURSOR_TTL_SECONDS);
};

const isValidCursor = (value: unknown, target: ResolvedTarget): value is SeasonCursor => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === CURSOR_VERSION &&
    value.leagueId === target.leagueId &&
    value.season === target.season &&
    typeof value.discovered === 'boolean' &&
    Array.isArray(value.fixtureIds) &&
    value.fixtureIds.every((id) => typeof id === 'string') &&
    typeof value.nextIndex === 'number' &&
    typeof value.standingsDone === 'boolean'
  );
};

/**
 * Extract the provider fixture ids of FINALISED fixtures from a
 * `/fixtures?league&season` envelope, preserving provider order and
 * de-duplicating. Mirrors the daily-anchor `extractFixtureItems` shape
 * (response[].fixture.{id,status.short}) but keeps only settled
 * fixtures — the only ones with a timeline/lineup worth importing.
 */
export const finalisedFixtureIds = (data: unknown): readonly string[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data.response) {
    if (!isRecord(item)) {
      continue;
    }
    const fixture = isRecord(item.fixture) ? item.fixture : undefined;
    if (!fixture) {
      continue;
    }
    const rawId = fixture.id;
    const fixtureId =
      typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === 'string'
          ? rawId.trim()
          : '';
    if (fixtureId === '') {
      continue;
    }
    const status = isRecord(fixture.status) ? String(fixture.status.short ?? '').toUpperCase() : '';
    if (!FINALISED_STATUSES.has(status)) {
      continue;
    }
    ids.add(fixtureId);
  }
  return [...ids];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const __test = {
  cursorKey,
  CURSOR_VERSION,
  CURSOR_TTL_SECONDS,
  FINALISED_STATUSES,
  resolveTargets,
  finalisedFixtureIds,
  seasonTeams,
  CALLS_PER_FIXTURE,
};
