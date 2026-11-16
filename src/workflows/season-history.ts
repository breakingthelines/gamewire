/**
 * season-backfill history modes: `resultsOnly` and `standingsOnly`.
 *
 * Results only (2 calls a target), per league-season:
 *   1. Season guard, no call. Resolve the season through identity exactly as
 *      game-service's binder does (`Resolve(SEASON, "api-football",
 *      "season:<league>:<year>")`), and the competition. game-service binds a
 *      season id the first time it sees the provider ref and never re-decides,
 *      so a season identity does not know yet would stay provider-keyed
 *      forever. A miss holds the target before any call.
 *   2. List, 1 call. `/fixtures?league&season` under `provider-fixture-results`
 *      with the cache bypassed. That workload is outside `BRIDGE_WORKLOADS`, so
 *      the fetch itself mints nothing.
 *   3. Team guard. Every team in the list must resolve through identity, unless
 *      `allowUnresolvedTeams`. A held club is never guessed into a provider id.
 *   4. Already-held guard. game-service ORs the historical flag and never
 *      clears it, so history must never touch a season BTL already holds as
 *      full data. A few of the list's fixtures are looked up through
 *      `LookupGameByFixture`; any hit holds the target.
 *   5. Ingest the list through the bridge's list path
 *      (`ingestFixtureListEnvelope`) with replay id
 *      `history:api-football:<league>:<season>`. game-service marks every game
 *      in that request historical. The list path never publishes a
 *      match-concluded fact, and history mode never fetches fixture detail.
 *   6. Standings, 1 call, through the shared standings ingest.
 *   7. Done marker in the state store (30 days), so a re-run spends nothing on
 *      a finished target. A held or pending target is not marked.
 *
 * Standings only (1 call a target): the season guard, then step 6 and a marker
 * of its own. No list, no games, nothing marked historical.
 */
import { create } from '@bufbuild/protobuf';

import { LookupGameByFixtureRequestSchema } from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import type { ProviderCache } from '../worker/cache.js';
import type { IngestionFetchOptions, IngestionFetchResult } from '../worker/ingestion.js';
import {
  ingestFixtureListEnvelope,
  type MatchConcludedBridgeLogEntry,
} from '../worker/match-concluded-bridge.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { handleProviderOutage, handleQuotaPosture, mostRestrictive } from './degrade.js';
import {
  defaultSleep,
  finalisedFixtureIds,
  listedFixtureCount,
  listedFixtureIds,
  RATE_LIMIT_BACKOFF_MS,
  resolveTeam,
  seasonFixturesPath,
  seasonTeams,
} from './season-list.js';
import {
  ingestStandingsEnvelope,
  STANDINGS_WORKLOAD,
  standingsPath,
  standingsResourceId,
} from './standings-ingest.js';
import type {
  DegradeAction,
  DegradeFlag,
  SeasonBackfillInput,
  SeasonBackfillOutput,
  SeasonBackfillTargetResult,
  SeasonHistoryHoldReason,
  SeasonHistoryRunSummary,
  SeasonHistoryTarget,
  WorkflowDeps,
} from './types.js';
import { WORKFLOW_PROVIDER_PRIORITY } from './types.js';

/** Replay id prefix game-service reads as "mark these games historical". */
export const HISTORY_REPLAY_PREFIX = 'history:';

/** `IngestMetadata.replay_id` of a history list ingest. */
export const historyReplayId = (leagueId: number, season: number): string =>
  `${HISTORY_REPLAY_PREFIX}api-football:${leagueId}:${season}`;

/** State-store key of a finished results-only target. */
export const historyDoneKey = (leagueId: number, season: number): string =>
  `backfill:history:${leagueId}:${season}`;

/** State-store key of a finished standings-only target. */
export const historyStandingsDoneKey = (leagueId: number, season: number): string =>
  `backfill:history-standings:${leagueId}:${season}`;

/** How long a done marker keeps a target from being re-run. */
export const HISTORY_DONE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The identity provider id of a season, as game-service's binder asks for it. */
export const historySeasonProviderId = (leagueId: number, season: number): string =>
  `season:${leagueId}:${season}`;

/**
 * The list workload. Not a bridge workload, and its TTL is 0, so with the
 * cache bypassed the fetch neither mints games nor stays in Redis.
 */
export const HISTORY_LIST_WORKLOAD = 'provider-fixture-results' as const;

/** Fixtures of a list looked up in game-service before ingesting it. */
const ALREADY_HELD_SAMPLE = 3;

const DONE_MARKER_VERSION = 1;

interface DoneMarker {
  readonly version: number;
  readonly doneAt: string;
}

/** Statuses that mean the call got no data for a reason that passes. */
const REFUSED_STATUSES: ReadonlySet<IngestionFetchResult['status']> = new Set([
  'denied',
  'rate_limited',
  'skipped',
]);

export interface HistoryResolvedTarget {
  readonly competitionKey?: string;
  readonly leagueId: number;
  readonly season: number;
}

export interface SeasonHistoryArgs {
  readonly input: SeasonBackfillInput;
  readonly deps: WorkflowDeps;
  readonly targets: readonly HistoryResolvedTarget[];
  readonly startedAt: Date;
  readonly maxCallsPerRun: number;
  readonly log: NonNullable<WorkflowDeps['logger']>;
  readonly clock: () => Date;
}

type TeamOutcome = 'resolved' | 'unresolved' | 'error';

export const seasonHistoryWorkflow = async (
  args: SeasonHistoryArgs
): Promise<SeasonBackfillOutput> => {
  const { input, deps, targets, startedAt, maxCallsPerRun, log, clock } = args;
  const standingsOnly = input.standingsOnly === true;
  const dryRun = input.dryRun === true;
  const mode: SeasonHistoryTarget['mode'] = standingsOnly ? 'standings-only' : 'results-only';
  const plannedCalls = standingsOnly ? 1 : 2;
  const store = deps.stateStore ?? deps.ingestion.cache;
  const sleep = deps.sleep ?? defaultSleep;
  const teamCache = new Map<string, TeamOutcome>();

  const results: SeasonBackfillTargetResult[] = [];
  const degradeFlags: DegradeFlag[] = [];
  let remaining = maxCallsPerRun;
  let callsBudgeted = 0;
  let callsUsed = 0;
  let finalQuota: ProviderQuotaSnapshot | undefined;
  let runMode = 'continue' as DegradeAction;
  let halted = false;

  log({
    event: 'season_history.started',
    workflow: 'season-backfill',
    reason: `${mode} ${targets.length} target(s) dryRun=${dryRun} maxCallsPerRun=${maxCallsPerRun}`,
  });

  for (const target of targets) {
    const { leagueId, season } = target;
    const errors: string[] = [];
    let targetCallsBudgeted = 0;
    let targetCallsUsed = 0;
    let rateLimitRetries = 0;
    let history: SeasonHistoryTarget = { mode, state: 'pending', plannedCalls };

    const finish = (complete: boolean): void => {
      results.push({
        target: `${target.competitionKey ?? `league-${leagueId}`}:${season}`,
        competition: target.competitionKey,
        apiFootballLeagueId: leagueId,
        season,
        fixturesDiscovered: history.fixturesFinalised ?? 0,
        fixturesProcessed: 0,
        cursorIndex: 0,
        complete,
        callsBudgeted: targetCallsBudgeted,
        callsUsed: targetCallsUsed,
        errors,
        ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
        history,
      });
      log({
        event: 'season_history.target',
        workflow: 'season-backfill',
        competition: target.competitionKey,
        leagueId,
        season,
        status: history.state,
        callsBudgeted: targetCallsBudgeted,
        callsUsed: targetCallsUsed,
        reason: history.reason,
      });
    };
    const hold = (reason: SeasonHistoryHoldReason, state: 'held' | 'pending' = 'held'): void => {
      errors.push(reason);
      history = { ...history, state, reason };
      finish(false);
    };

    if (halted) {
      finish(false);
      continue;
    }

    // Finished on an earlier run: no identity lookup, no call.
    const doneKey = standingsOnly
      ? historyStandingsDoneKey(leagueId, season)
      : historyDoneKey(leagueId, season);
    if (!input.reset && (await readDoneMarker(store, doneKey))) {
      history = { ...history, state: 'already-done' };
      finish(true);
      continue;
    }

    // 1. Season guard.
    const guard = await seasonGuard(deps, leagueId, season);
    if (!guard.ok) {
      hold(guard.reason, guard.reason === 'identity-error' ? 'pending' : 'held');
      continue;
    }
    history = { ...history, seasonId: guard.seasonId, competitionId: guard.competitionId };

    if (dryRun && standingsOnly) {
      history = { ...history, state: 'planned' };
      finish(true);
      continue;
    }

    if (remaining < (dryRun ? 1 : plannedCalls)) {
      // Start a target only when the budget covers all its calls, so a run
      // never leaves a list ingested without its standings. A dry run makes
      // the list call only.
      halted = true;
      finish(false);
      continue;
    }

    /** One call with the rate-limit back-off; spends budget on every attempt. */
    const call = async (options: IngestionFetchOptions): Promise<IngestionFetchResult> => {
      const attempt = async () => {
        const result = await deps.ingestion.fetchWorkload(options);
        remaining -= 1;
        callsBudgeted += 1;
        targetCallsBudgeted += 1;
        if (result.status === 'fetched') {
          callsUsed += 1;
          targetCallsUsed += 1;
        }
        return result;
      };
      let result = await attempt();
      for (const waitMs of RATE_LIMIT_BACKOFF_MS) {
        if (result.status !== 'rate_limited' || remaining <= 0) {
          break;
        }
        rateLimitRetries += 1;
        log({
          event: 'season_history.rate_limited',
          workflow: 'season-backfill',
          leagueId,
          season,
          reason: `${options.workload}:${options.resourceId} retry in ${waitMs}ms`,
        });
        await sleep(waitMs);
        result = await attempt();
      }
      finalQuota = result.quota;
      const posture = handleQuotaPosture(result.quota);
      if (posture.flag) {
        degradeFlags.push(posture.flag);
      }
      if (result.fallbackReason) {
        const outage = handleProviderOutage({ fallbackReason: result.fallbackReason });
        if (outage.flag) {
          degradeFlags.push(outage.flag);
        }
      }
      runMode = mostRestrictive([
        runMode,
        posture.action,
        result.fallbackReason === 'PROVIDER_OUTAGE' ? 'cached-only' : 'continue',
      ]);
      if (result.error) {
        errors.push(`${options.workload}:${options.resourceId}:${result.error.message}`);
      }
      if (REFUSED_STATUSES.has(result.status)) {
        // Quota, the minute limiter or a missing key refused the call: later
        // targets would only be refused too.
        halted = true;
      }
      return result;
    };
    const stopNow = (): boolean => runMode !== 'continue' || halted;

    if (!standingsOnly) {
      // 2. List.
      const listResourceId = `history-fixtures-${leagueId}-${season}`;
      const list = await call({
        priority: WORKFLOW_PROVIDER_PRIORITY,
        workload: HISTORY_LIST_WORKLOAD,
        resourceId: listResourceId,
        path: seasonFixturesPath(leagueId, season),
        cache: 'bypass',
      });
      if (runMode === 'abort' || list.data === undefined || list.status === 'failed') {
        if (runMode !== 'continue') {
          halted = true;
        }
        history = { ...history, state: 'pending' };
        finish(false);
        continue;
      }
      const teams = seasonTeams(list.data);
      history = {
        ...history,
        fixturesListed: listedFixtureCount(list.data),
        fixturesFinalised: finalisedFixtureIds(list.data).length,
        teams: teams.length,
      };

      // 3. Team guard.
      const unresolvedTeams: string[] = [];
      let teamLookupErrors = 0;
      for (const team of teams) {
        let outcome = teamCache.get(team.id);
        if (outcome === undefined) {
          outcome = await resolveTeam(deps, team.id);
          teamCache.set(team.id, outcome);
        }
        if (outcome === 'unresolved') {
          unresolvedTeams.push(`${team.id}:${team.name}`);
        } else if (outcome === 'error') {
          teamLookupErrors += 1;
        }
      }
      history = { ...history, unresolvedTeams, teamLookupErrors };

      // 4. Already-held guard.
      const held = await lookupHeldFixtures(deps, sampleFixtureIds(listedFixtureIds(list.data)));
      if (held.ok) {
        history = { ...history, heldFixtureIds: held.found };
      }

      const blocker: { reason: SeasonHistoryHoldReason; state: 'held' | 'pending' } | undefined =
        !held.ok
          ? { reason: held.reason, state: held.reason === 'game-lookup-error' ? 'pending' : 'held' }
          : held.found.length > 0
            ? { reason: 'season-already-held', state: 'held' }
            : unresolvedTeams.length > 0 && input.allowUnresolvedTeams !== true
              ? { reason: 'teams-unresolved', state: 'held' }
              : teamLookupErrors > 0 && input.allowUnresolvedTeams !== true
                ? { reason: 'team-lookup-error', state: 'pending' }
                : !deps.gameService
                  ? { reason: 'game-service-not-wired', state: 'held' }
                  : undefined;

      if (dryRun) {
        if (blocker) {
          errors.push(blocker.reason);
        }
        history = { ...history, state: 'planned', ...(blocker ? { reason: blocker.reason } : {}) };
        finish(true);
        if (stopNow()) {
          halted = true;
        }
        continue;
      }
      if (blocker) {
        hold(blocker.reason, blocker.state);
        if (stopNow()) {
          halted = true;
        }
        continue;
      }

      // 5. Ingest the list as history.
      const ingested = await ingestFixtureListEnvelope({
        workload: HISTORY_LIST_WORKLOAD,
        resourceId: listResourceId,
        replayId: historyReplayId(leagueId, season),
        data: list.data,
        providerId: API_FOOTBALL_PROVIDER_ID,
        // Checked in the blocker above.
        gameService: deps.gameService!,
        identity: deps.identity!,
        log: bridgeLogger(log, leagueId, season),
        clock: () => clock().getTime(),
      });
      history = {
        ...history,
        gamesSent: ingested.gamesSent,
        gamesAccepted: ingested.accepted,
        gamesUpdated: ingested.updated,
      };
      if (ingested.error !== undefined) {
        errors.push(`IngestGames:${ingested.error}`);
        history = { ...history, state: 'pending' };
        finish(false);
        continue;
      }
      if (stopNow()) {
        // The list is in; the standings call would be refused. A re-run lists
        // again (1 call) and re-ingests the same games, which is idempotent.
        halted = true;
        finish(false);
        continue;
      }
    } else if (!deps.gameService) {
      hold('game-service-not-wired');
      continue;
    }

    // 6. Standings.
    const standingsResource = standingsResourceId(leagueId, season);
    const standings = await call({
      priority: WORKFLOW_PROVIDER_PRIORITY,
      workload: STANDINGS_WORKLOAD,
      resourceId: standingsResource,
      path: standingsPath(leagueId, season),
      cache: 'bypass',
    });
    if (standings.data === undefined || standings.status === 'failed') {
      if (runMode !== 'continue') {
        halted = true;
      }
      finish(false);
      continue;
    }
    const tables = await ingestStandingsEnvelope({
      leagueId,
      resourceId: standingsResource,
      data: standings.data,
      gameService: deps.gameService,
      identity: deps.identity,
      nowMs: clock().getTime(),
    });
    if (tables.status === 'error' || tables.status === 'not-wired') {
      errors.push(
        `IngestFootballStandings:${tables.status === 'error' ? tables.message : 'game service not wired'}`
      );
      history = { ...history, standingsTables: 0 };
      finish(false);
      if (runMode !== 'continue') {
        halted = true;
      }
      continue;
    }
    history = {
      ...history,
      standingsTables: tables.tables,
      ...(tables.status === 'ingested'
        ? { standingsAccepted: tables.accepted, standingsUpdated: tables.updated }
        : {}),
      state: 'done',
    };

    // 7. Done marker.
    await writeDoneMarker(store, doneKey, clock());
    finish(true);
    if (runMode !== 'continue') {
      halted = true;
    }
  }

  const summary = summarise(results);
  const status: SeasonBackfillOutput['status'] =
    runMode === 'abort' ? 'aborted' : results.every((t) => t.complete) ? 'complete' : 'incomplete';

  log({
    event: 'season_history.finished',
    workflow: 'season-backfill',
    status,
    callsBudgeted,
    callsUsed,
    reason: `done=${summary.done} alreadyDone=${summary.alreadyDone} held=${summary.held} pending=${summary.pending} planned=${summary.planned}`,
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: clock().toISOString(),
    status,
    callsBudgeted,
    callsUsed,
    fixturesProcessed: 0,
    targets: results,
    degradeFlags,
    finalQuota,
    history: summary,
  };
};

const summarise = (results: readonly SeasonBackfillTargetResult[]): SeasonHistoryRunSummary => {
  const count = (state: SeasonHistoryTarget['state']) =>
    results.filter((r) => r.history?.state === state).length;
  return {
    done: count('done'),
    alreadyDone: count('already-done'),
    held: count('held'),
    pending: count('pending'),
    planned: count('planned'),
  };
};

type SeasonGuard =
  | { readonly ok: true; readonly seasonId: string; readonly competitionId: string }
  | { readonly ok: false; readonly reason: SeasonHistoryHoldReason };

/**
 * Resolve the season (`season:<league>:<year>`, the key game-service's binder
 * asks identity for) and the competition. No provider call.
 */
const seasonGuard = async (
  deps: WorkflowDeps,
  leagueId: number,
  season: number
): Promise<SeasonGuard> => {
  if (!deps.identity) {
    return { ok: false, reason: 'identity-not-wired' };
  }
  try {
    const seasonResponse = await deps.identity.resolve(
      create(ResolveRequestSchema, {
        entityType: EntityType.SEASON,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId: historySeasonProviderId(leagueId, season),
      })
    );
    if (!seasonResponse.found || !seasonResponse.entityId) {
      return { ok: false, reason: 'season-unresolved' };
    }
    const competitionResponse = await deps.identity.resolve(
      create(ResolveRequestSchema, {
        entityType: EntityType.COMPETITION,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId: String(leagueId),
      })
    );
    if (!competitionResponse.found || !competitionResponse.entityId) {
      return { ok: false, reason: 'competition-unresolved' };
    }
    return {
      ok: true,
      seasonId: seasonResponse.entityId,
      competitionId: competitionResponse.entityId,
    };
  } catch {
    return { ok: false, reason: 'identity-error' };
  }
};

/** First, middle and last fixture of the list. */
const sampleFixtureIds = (ids: readonly string[]): readonly string[] => {
  if (ids.length <= ALREADY_HELD_SAMPLE) {
    return ids;
  }
  return [...new Set([ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]])].filter(
    (id): id is string => id !== undefined
  );
};

type HeldLookup =
  | { readonly ok: true; readonly found: readonly string[] }
  | { readonly ok: false; readonly reason: 'game-lookup-error' | 'game-lookup-not-wired' };

const lookupHeldFixtures = async (
  deps: WorkflowDeps,
  fixtureIds: readonly string[]
): Promise<HeldLookup> => {
  if (!deps.gameLookup) {
    return { ok: false, reason: 'game-lookup-not-wired' };
  }
  const found: string[] = [];
  for (const providerFixtureId of fixtureIds) {
    try {
      const response = await deps.gameLookup.lookupGameByFixture(
        create(LookupGameByFixtureRequestSchema, {
          provider: API_FOOTBALL_PROVIDER_ID,
          providerFixtureId,
        })
      );
      if (response.found && response.gameId) {
        found.push(providerFixtureId);
      }
    } catch {
      return { ok: false, reason: 'game-lookup-error' };
    }
  }
  return { ok: true, found };
};

const readDoneMarker = async (store: ProviderCache, key: string): Promise<boolean> => {
  const raw = await store.get<DoneMarker>(key);
  return (
    raw !== undefined &&
    raw !== null &&
    typeof raw === 'object' &&
    (raw as DoneMarker).version === DONE_MARKER_VERSION
  );
};

const writeDoneMarker = async (store: ProviderCache, key: string, now: Date): Promise<void> => {
  const marker: DoneMarker = { version: DONE_MARKER_VERSION, doneAt: now.toISOString() };
  await store.set(key, marker, HISTORY_DONE_TTL_SECONDS);
};

const bridgeLogger =
  (log: NonNullable<WorkflowDeps['logger']>, leagueId: number, season: number) =>
  (entry: MatchConcludedBridgeLogEntry): void => {
    log({
      event: `season_history.${entry.event}`,
      workflow: 'season-backfill',
      leagueId,
      season,
      workload: entry.workload,
      reason:
        entry.reason ??
        entry.message ??
        (entry.acceptedCount !== undefined
          ? `accepted=${entry.acceptedCount} updated=${entry.updatedCount ?? 0}`
          : undefined),
    });
  };
