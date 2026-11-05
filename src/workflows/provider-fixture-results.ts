/**
 * Provider-fixture-results workflow (PF-GW1).
 *
 * Feeds `game-service`'s player-profile league strength ratings (club Elo +
 * pi-ratings, `profile-spec.md` §2.3, ADR-053 "League strength and
 * adjustment") with finished fixture results for seasons and leagues the
 * `games` table does not hold. It never creates a game — rows land in
 * `provider_fixture_results`, a table outside the games/occurrences graph,
 * via its own `provider-fixture-results` ingestion workload (never
 * `fixtures-next-7d`, which the match-concluded + asset-mirror bridges
 * would otherwise run against) — and it never writes national teams or
 * friendlies (`profile-spec.md` §2.3 step 1, ADR-053; enforced by an
 * ALLOWLIST of reference-set + UEFA league ids, not a denylist).
 *
 * Two modes, selected by `input.mode` with no default — the HTTP layer
 * (`worker/http.ts`) rejects a request with a missing or unknown `mode` as
 * `400`, rather than silently defaulting a scheduled endpoint to the far
 * more expensive `history` run:
 *
 *   - `history`: a one-time backfill over an explicit (or default) league x
 *     season grid, one `/fixtures?league=L&season=S` call per cell. The
 *     default grid is the 20-league reference set
 *     ({@link REFERENCE_LEAGUE_IDS}) plus the three UEFA club competitions
 *     that link it ({@link REFERENCE_UEFA_LEAGUE_IDS}), across
 *     {@link REFERENCE_SEASONS} (2023-2026) — 23 x 4 = 92 calls, matching
 *     the spec's sizing (`profile-spec.md` §7.1, unit PF-GW1).
 *   - `nightly`: `/fixtures?league=L&season=S&from=<D-3>&to=<D-1>` (API-
 *     Football's `date` filter needs a literal `YYYY-MM-DD`, not the string
 *     `"yesterday"` — see {@link nightlyFixturesPath}) for reference-set
 *     leagues that are NOT in `deps.competitions` today, so their current
 *     season's results never land in `games` through any other path.
 *     Computed fresh every run against the live catalogue
 *     ({@link resolveNightlyLeagueIds}), so a league that later joins the
 *     catalogue (e.g. Mega's GW-5) silently drops out of this nightly list
 *     without a code change here. About 11 calls/day today, matching the
 *     spec's "about 10 calls a day".
 *
 * Every call runs at `background` priority ({@link WORKFLOW_PROVIDER_PRIORITY})
 * through `deps.ingestion.fetchWorkload` with `cache: 'bypass'` (verdict D9:
 * no bulk pages in the shared Redis), so the GW-1 singleflight, quota,
 * minute limiter, background daily cap and degrade postures all apply, but
 * nothing is read from or written to the provider cache.
 *
 * The ingest RPC (`deps.gameServiceJobs.ingestProviderFixtureResults`) is
 * served only by the `game-service-profile-jobs` Deployment
 * (`profile-spec.md` §3.4); it is wired separately from `deps.gameService`,
 * which other workflows call against the serving pods.
 *
 * Idempotency. Rows are keyed server-side by `(provider_code,
 * provider_fixture_id)` (an upsert, per `IngestProviderFixtureResultsRequest`'s
 * doc comment), so re-running history or nightly for the same league/season
 * is safe (one provider call per target, an upsert no-op on the ingest
 * side). No persisted cursor is needed: the full default grid is 92
 * calls, far under the per-run budget, and a partial run simply resumes by
 * re-invoking with the same (or default) input.
 */
import { create } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromMs } from '@bufbuild/protobuf/wkt';

import {
  IngestMetadataSchema,
  IngestProviderFixtureResultsRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { ProviderEntitySnapshotSchema } from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import {
  ProviderFixtureResultRowSchema,
  ProviderFixtureResultStatus,
} from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { handleProviderOutage, handleQuotaPosture, mostRestrictive } from './degrade.js';
import type {
  CompetitionEntry,
  DegradeAction,
  DegradeFlag,
  ProviderFixtureResultsInput,
  ProviderFixtureResultsLeagueResult,
  ProviderFixtureResultsOutput,
  WorkflowDeps,
} from './types.js';
import { WORKFLOW_PROVIDER_PRIORITY } from './types.js';

/**
 * The 20-league domestic reference set club Elo + pi-ratings are computed
 * over (`pdata/leaguerate.py:NAMES`, frozen per `method_version`). Every one
 * of these always gets a `league_strength_ratings` row — they define the
 * index, so the link-floor rule (`profile-spec.md` §2.3 step 4) never
 * applies to them.
 */
export const REFERENCE_LEAGUE_IDS: readonly number[] = [
  88, 39, 140, 135, 78, 61, 94, 144, 203, 179, 40, 218, 207, 119, 197, 345, 79, 136, 62, 141,
];

/**
 * UEFA club competitions that cross-link the reference set
 * (`pdata/leaguerate.py:UEFA`). Already in `deps.competitions` today
 * (Champions League, Europa League, Conference League), so they are never a
 * nightly target — only a history one.
 */
export const REFERENCE_UEFA_LEAGUE_IDS: readonly number[] = [2, 3, 848];

/** History mode's default season window (`profile-spec.md` §1.7, PF-GW1: "seasons 2023 to 2026"). */
export const REFERENCE_SEASONS: readonly number[] = [2023, 2024, 2025, 2026];

/**
 * Every league id `leagueIds`/`nightlyLeagueIds` may name: the reference
 * set plus the UEFA cross-link ids. This is an ALLOWLIST, not a denylist —
 * a two-item denylist (formerly just UEFA Nations League 5 and
 * International Friendlies 10) let any other national-team competition
 * (World Cup 1, WC qualifiers 29-34, Euro 4, Copa América 9, ...) through
 * an override untouched. `profile-spec.md` §2.3 requires an explicit
 * rated-competition list; anything not in it is dropped regardless of
 * where it came from (an explicit override or a default).
 */
const ALLOWED_LEAGUE_IDS: ReadonlySet<number> = new Set([
  ...REFERENCE_LEAGUE_IDS,
  ...REFERENCE_UEFA_LEAGUE_IDS,
]);

/** Per-run provider-call ceiling. The default grid is 92 calls; this leaves generous headroom for an operator override without risking the shared daily budget. */
export const DEFAULT_PROVIDER_FIXTURE_RESULTS_MAX_CALLS = 200;

/** At most 500 rows per `IngestProviderFixtureResultsRequest` (proto doc comment on the request). */
const MAX_ROWS_PER_INGEST_BATCH = 500;

/** Finished statuses the league-strength model scores. WO/AWD (walkover/awarded) have no real scoreline and are skipped, matching `pdata/leaguerate.py:load` (`status.short not in (FT, AET, PEN)`). */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['FT', 'AET', 'PEN']);

const STATUS_TO_PROTO: Readonly<Record<string, ProviderFixtureResultStatus>> = {
  FT: ProviderFixtureResultStatus.FULL_TIME,
  AET: ProviderFixtureResultStatus.AFTER_EXTRA_TIME,
  PEN: ProviderFixtureResultStatus.PENALTIES,
};

const seasonFixturesPath = (leagueId: number, season: number): string =>
  `/fixtures?league=${leagueId}&season=${season}`;

/**
 * European-season convention (`pdata/leaguerate.py`, `REFERENCE_SEASONS`):
 * a season starting in July runs July-June and is labelled by its start
 * year. `now`'s UTC month decides which labelled season "yesterday" falls
 * in — this only matters in the handful of days either side of the
 * July rollover.
 */
const seasonYearForDate = (now: Date): number => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed; 6 = July
  return month >= 6 ? year : year - 1;
};

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const addUtcDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

/**
 * `nightly` mode's fixture path (finding PF-GW1 #3). API-Football's
 * `date` filter takes a literal `YYYY-MM-DD`, not the string `"yesterday"`
 * — the old `date=yesterday` call always returned an `errors` envelope
 * with an empty `response`, so every nightly run silently ingested 0 rows
 * while still reporting `ok`.
 *
 * `league=L&season=S&from=<D-3>&to=<D-1>` instead: still one call, an
 * idempotent upsert on the ingest side, and — unlike a single day — it
 * recovers a result missed by an outage, a late settlement, or a skipped
 * night, rather than losing it for good. `season` is passed explicitly
 * (whether `league` is accepted without it is unverified).
 */
const nightlyFixturesPath = (leagueId: number, now: Date): string => {
  const season = seasonYearForDate(now);
  const from = isoDate(addUtcDays(now, -3));
  const to = isoDate(addUtcDays(now, -1));
  return `/fixtures?league=${leagueId}&season=${season}&from=${from}&to=${to}`;
};

export const providerFixtureResultsWorkflow = async (
  input: ProviderFixtureResultsInput,
  deps: WorkflowDeps
): Promise<ProviderFixtureResultsOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const startedAt = input.nowUtc ? new Date(input.nowUtc) : clock();
  const { mode } = input;
  const maxCallsPerRun = clampMaxCallsPerRun(input.maxCallsPerRun);

  const targets: readonly Target[] =
    mode === 'history'
      ? resolveHistoryTargets(input, startedAt)
      : resolveNightlyTargets(input, deps);

  log({
    event: 'provider_fixture_results.started',
    workflow: 'provider-fixture-results',
    reason: `mode=${mode} ${targets.length} target(s), maxCallsPerRun=${maxCallsPerRun}`,
  });

  const leagues: ProviderFixtureResultsLeagueResult[] = [];
  const degradeFlags: DegradeFlag[] = [];
  let callsBudgeted = 0;
  let callsUsed = 0;
  let rowsAccepted = 0;
  let rowsSkipped = 0;
  let finalQuota: ProviderQuotaSnapshot | undefined;
  const budget: RunBudget = { remaining: maxCallsPerRun };
  let halted = false;

  for (const target of targets) {
    if (halted) {
      leagues.push({
        leagueId: target.leagueId,
        season: target.season,
        status: 'skipped',
        fixturesFound: 0,
        rowsAccepted: 0,
        rowsSkipped: 0,
        callsBudgeted: 0,
        callsUsed: 0,
        errors: ['run call budget exhausted before this target started'],
      });
      continue;
    }
    if (budget.remaining <= 0) {
      halted = true;
      leagues.push({
        leagueId: target.leagueId,
        season: target.season,
        status: 'skipped',
        fixturesFound: 0,
        rowsAccepted: 0,
        rowsSkipped: 0,
        callsBudgeted: 0,
        callsUsed: 0,
        errors: ['run call budget exhausted before this target started'],
      });
      continue;
    }

    const result = await runTarget({ target, mode, deps, budget, log, now: startedAt });
    leagues.push(result.summary);
    callsBudgeted += result.summary.callsBudgeted;
    callsUsed += result.summary.callsUsed;
    rowsAccepted += result.summary.rowsAccepted;
    rowsSkipped += result.summary.rowsSkipped;
    finalQuota = result.finalQuota ?? finalQuota;
    degradeFlags.push(...result.flags);
    if (result.action === 'abort') {
      halted = true;
      log({
        event: 'provider_fixture_results.aborted',
        workflow: 'provider-fixture-results',
        leagueId: target.leagueId,
        season: target.season,
        reason: 'quota hard cap',
      });
    }
  }

  const finishedAt = clock();
  // Finding PF-GW1 #5: a target's `status: 'failed'` (ingest rejected,
  // UNIMPLEMENTED, no provider envelope) used to leave the overall status
  // `complete` — only `skipped` (budget exhaustion) downgraded it. A
  // nightly run that failed every league could pass the "3 nights green"
  // gate with nothing written.
  const status: ProviderFixtureResultsOutput['status'] = leagues.every((l) => l.status === 'ok')
    ? 'complete'
    : 'incomplete';

  log({
    event: 'provider_fixture_results.finished',
    workflow: 'provider-fixture-results',
    reason: `mode=${mode} status=${status}`,
    callsBudgeted,
    callsUsed,
  });

  return {
    mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    leagues,
    callsBudgeted,
    callsUsed,
    rowsAccepted,
    rowsSkipped,
    degradeFlags,
    finalQuota,
  };
};

/**
 * Per-run call ceiling: an operator may lower it, never raise it above
 * {@link DEFAULT_PROVIDER_FIXTURE_RESULTS_MAX_CALLS}.
 */
export const clampMaxCallsPerRun = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), DEFAULT_PROVIDER_FIXTURE_RESULTS_MAX_CALLS)
    : DEFAULT_PROVIDER_FIXTURE_RESULTS_MAX_CALLS;

/** Earliest season `history` mode accepts. */
export const MIN_PROVIDER_FIXTURE_RESULTS_SEASON = 2010;

/** Latest season `history` mode accepts: the current UTC year + 1. */
export const maxProviderFixtureResultsSeason = (now: Date): number => now.getUTCFullYear() + 1;

interface Target {
  readonly leagueId: number;
  /** Set in `history` mode only. */
  readonly season?: number;
}

interface RunBudget {
  remaining: number;
}

/**
 * Expand `history` mode's input into a deduplicated league x season grid.
 * Explicit `leagueIds`/`seasons` win; otherwise the default reference set
 * and season window apply. Any league id outside `ALLOWED_LEAGUE_IDS`, and
 * any season outside 2010 to the current year + 1, is dropped regardless of
 * where it came from.
 */
const resolveHistoryTargets = (
  input: ProviderFixtureResultsInput,
  now: Date
): readonly Target[] => {
  const leagueIds = dedupeLeagueIds(
    input.leagueIds && input.leagueIds.length > 0
      ? input.leagueIds
      : [...REFERENCE_LEAGUE_IDS, ...REFERENCE_UEFA_LEAGUE_IDS]
  );
  const seasons =
    input.seasons && input.seasons.length > 0 ? dedupeNumbers(input.seasons) : REFERENCE_SEASONS;
  const targets: Target[] = [];
  for (const leagueId of leagueIds) {
    for (const season of seasons) {
      if (
        Number.isInteger(season) &&
        season >= MIN_PROVIDER_FIXTURE_RESULTS_SEASON &&
        season <= maxProviderFixtureResultsSeason(now)
      ) {
        targets.push({ leagueId, season });
      }
    }
  }
  return targets;
};

/**
 * `nightly` mode's targets: explicit `nightlyLeagueIds` win; otherwise the
 * reference set (domestic leagues only — the UEFA ids are already in
 * `deps.competitions` today and never reach this branch) minus whatever is
 * already in `deps.competitions`, computed fresh every run
 * ({@link resolveNightlyLeagueIds}).
 */
const resolveNightlyTargets = (
  input: ProviderFixtureResultsInput,
  deps: WorkflowDeps
): readonly Target[] => {
  const leagueIds = dedupeLeagueIds(
    input.nightlyLeagueIds && input.nightlyLeagueIds.length > 0
      ? input.nightlyLeagueIds
      : resolveNightlyLeagueIds(deps.competitions)
  );
  return leagueIds.map((leagueId) => ({ leagueId }));
};

/**
 * Reference-set domestic leagues with no catalogue entry at all — their
 * current season's finished fixtures never land in `games` through any
 * other path, so the nightly {@link nightlyFixturesPath} pull is the only
 * source for them. Self-correcting: a league the catalogue later adds
 * (Mega's GW-5) drops out the next time this runs, with no change needed
 * here.
 */
export const resolveNightlyLeagueIds = (
  competitions: readonly CompetitionEntry[]
): readonly number[] => {
  const catalogued = new Set(competitions.map((c) => c.apiFootballLeagueId));
  return REFERENCE_LEAGUE_IDS.filter((id) => !catalogued.has(id));
};

const dedupeLeagueIds = (ids: readonly number[]): readonly number[] => {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || !ALLOWED_LEAGUE_IDS.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
};

const dedupeNumbers = (values: readonly number[]): readonly number[] => [
  ...new Set(values.filter((v) => Number.isInteger(v) && v > 0)),
];

interface RunTargetArgs {
  readonly target: Target;
  readonly mode: 'history' | 'nightly';
  readonly deps: WorkflowDeps;
  readonly budget: RunBudget;
  readonly log: NonNullable<WorkflowDeps['logger']>;
  /** The run's own "now", used for `nightly`'s date window. */
  readonly now: Date;
}

interface RunTargetOutcome {
  readonly summary: ProviderFixtureResultsLeagueResult;
  readonly flags: readonly DegradeFlag[];
  readonly action: DegradeAction;
  readonly finalQuota?: ProviderQuotaSnapshot;
}

const runTarget = async (args: RunTargetArgs): Promise<RunTargetOutcome> => {
  const { target, mode, deps, budget, log, now } = args;
  const flags: DegradeFlag[] = [];
  const errors: string[] = [];
  let callsBudgeted = 0;
  let callsUsed = 0;
  let lastQuota: ProviderQuotaSnapshot | undefined;

  const path =
    mode === 'history' && target.season !== undefined
      ? seasonFixturesPath(target.leagueId, target.season)
      : nightlyFixturesPath(target.leagueId, now);
  const resourceId =
    mode === 'history'
      ? `provider-fixture-results-${target.leagueId}-${target.season}`
      : `provider-fixture-results-nightly-${target.leagueId}`;

  // PF-GW1 finding #1: this must NEVER be 'fixtures-next-7d'. That workload
  // is a member of `ingestion.ts`'s BRIDGE_WORKLOADS, so every list payload
  // would be re-run through the match-concluded bridge's `ingestFixtureList`
  // (minting canonical `games` rows + crosswalk entries for leagues/seasons
  // the catalogue does not cover — the spec's "never creates a game") and
  // through the asset-mirror bridge. `provider-fixture-results` is its own
  // workload, deliberately excluded from both.
  //
  // `cache: 'bypass'` (verdict D9, as GW-6a's enrichment): the cache key is
  // `provider:workload:resourceId` and ignores `path`, so a cached nightly
  // entry would serve the previous night's window under a fixed resourceId,
  // and history pages (~28 MB) must not sit in the shared Redis, which has
  // no maxmemory.
  const result = await deps.ingestion.fetchWorkload({
    priority: WORKFLOW_PROVIDER_PRIORITY,
    workload: 'provider-fixture-results',
    resourceId,
    path,
    cache: 'bypass',
  });
  callsBudgeted += 1;
  budget.remaining -= 1;
  if (result.status === 'fetched') {
    callsUsed += 1;
  }
  if (result.error) {
    errors.push(result.error.message);
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
  const action = mostRestrictive([
    quotaResult.action,
    result.fallbackReason === 'PROVIDER_OUTAGE'
      ? ('cached-only' satisfies DegradeAction)
      : 'continue',
  ]);

  if (action === 'abort') {
    return {
      summary: {
        leagueId: target.leagueId,
        season: target.season,
        status: 'failed',
        fixturesFound: 0,
        rowsAccepted: 0,
        rowsSkipped: 0,
        callsBudgeted,
        callsUsed,
        errors,
      },
      flags,
      action,
      finalQuota: lastQuota,
    };
  }

  // PF-GW1 finding #8: `deps.clock`, not `Date.now()` — a cache hit must not
  // stamp "now" as the fetch time. `result` carries no fetch-time field of
  // its own, so this is the closest available proxy (the run's clock), and
  // it is deterministic under test fakes.
  const fetchedAtMs = deps.clock ? deps.clock().getTime() : Date.now();
  const rows = fixtureResultRowsFromEnvelope(result.data, target.leagueId, fetchedAtMs);

  log({
    event: 'provider_fixture_results.league_fetched',
    workflow: 'provider-fixture-results',
    leagueId: target.leagueId,
    season: target.season,
    reason: `${rows.length} finished fixture(s)`,
  });

  if (rows.length === 0) {
    // A genuinely empty `{response: []}` (no finished fixtures yet) is
    // `ok`. A missing envelope under a degrade action (`cached-only` with
    // no prior cache to fall back to, under a soft cap or a provider
    // outage) is NOT the same as "nothing to report" — finding PF-GW1 #5:
    // a provider outage used to report 0 rows and `ok`, so a nightly run
    // that wrote nothing could still pass the P2 "green 3 nights" gate.
    const noEnvelope = result.data === undefined && action !== 'continue';
    return {
      summary: {
        leagueId: target.leagueId,
        season: target.season,
        status: noEnvelope ? 'failed' : 'ok',
        fixturesFound: 0,
        rowsAccepted: 0,
        rowsSkipped: 0,
        callsBudgeted,
        callsUsed,
        errors: noEnvelope ? [...errors, 'no_envelope_from_provider'] : errors,
      },
      flags,
      action,
      finalQuota: lastQuota,
    };
  }

  // PF-GW1 finding #4: `IngestProviderFixtureResults` is served only by
  // `game-service-profile-jobs` (`profile-spec.md` §3.4); serving pods
  // return UNIMPLEMENTED. `deps.gameServiceJobs` is wired from a client
  // pointed at that Deployment, separately from `deps.gameService` (which
  // squad-sweep and friends use against the serving pods).
  if (!deps.gameServiceJobs) {
    return {
      summary: {
        leagueId: target.leagueId,
        season: target.season,
        status: 'skipped',
        fixturesFound: rows.length,
        rowsAccepted: 0,
        rowsSkipped: rows.length,
        callsBudgeted,
        callsUsed,
        errors: [...errors, 'game_service_jobs_not_wired'],
      },
      flags,
      action,
      finalQuota: lastQuota,
    };
  }

  let rowsAccepted = 0;
  let rowsSkipped = 0;
  for (const chunk of chunkRows(rows, MAX_ROWS_PER_INGEST_BATCH)) {
    const resourceLabel =
      mode === 'history' ? `${target.leagueId}-${target.season}` : `nightly-${target.leagueId}`;
    const replayId = `provider-fixture-results:${resourceLabel}:${fetchedAtMs}`;
    const request = create(IngestProviderFixtureResultsRequestSchema, {
      metadata: create(IngestMetadataSchema, {
        provider: API_FOOTBALL_PROVIDER_ID,
        replayId,
        rawPayloadRef: `provider://${API_FOOTBALL_PROVIDER_ID}${path}`,
        normalizedBatchId: `${API_FOOTBALL_PROVIDER_ID}:provider-fixture-results:${resourceLabel}`,
        idempotencyKey: `${API_FOOTBALL_PROVIDER_ID}:provider-fixture-results:${resourceLabel}:${replayId}`,
      }),
      rows: chunk,
    });
    try {
      const response = await deps.gameServiceJobs.ingestProviderFixtureResults(request);
      rowsAccepted += response.acceptedCount + response.updatedCount;
      rowsSkipped += response.skippedCount;
      // Rows with an empty fixture or team id are dropped before sending, so
      // any server-side skip means rows were not stored (game-service answers
      // OK with every row skipped while PROFILE_JOBS is off). That is a
      // failed target, not a green one.
      if (response.skippedCount > 0) {
        errors.push(`ingest_skipped:${response.skippedCount}`);
      }
    } catch (err) {
      errors.push(
        `ingestProviderFixtureResults:${err instanceof Error ? err.message : String(err)}`
      );
      rowsSkipped += chunk.length;
    }
  }

  return {
    summary: {
      leagueId: target.leagueId,
      season: target.season,
      status: errors.length > 0 ? 'failed' : 'ok',
      fixturesFound: rows.length,
      rowsAccepted,
      rowsSkipped,
      callsBudgeted,
      callsUsed,
      errors,
    },
    flags,
    action,
    finalQuota: lastQuota,
  };
};

const chunkRows = <T>(rows: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size) as T[]);
  }
  return out;
};

/**
 * Parse a `/fixtures?league=...` envelope into `ProviderFixtureResultRow`
 * messages. Only FT/AET/PEN fixtures with both team ids and a non-null
 * scoreline are kept — everything else (scheduled, postponed, cancelled,
 * walkover/awarded with no real scoreline) has nothing a league-strength
 * model should score. `leagueId` is the request's own league id, used as a
 * fallback when an item's `league.id` is missing. `fetchedAtMs` stamps
 * every row's `fetchedAt` (finding PF-GW1 #8) — it must be the run's own
 * clock, not `Date.now()`, so a cache hit does not claim "fetched now".
 * Defaults to `Date.now()` only so direct callers (tests) need not pass it.
 */
export const fixtureResultRowsFromEnvelope = (
  data: unknown,
  leagueId: number,
  fetchedAtMs: number = Date.now()
): ReturnType<typeof create<typeof ProviderFixtureResultRowSchema>>[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const rows: ReturnType<typeof create<typeof ProviderFixtureResultRowSchema>>[] = [];
  for (const item of data.response) {
    if (!isRecord(item)) {
      continue;
    }
    const fixture = isRecord(item.fixture) ? item.fixture : undefined;
    const league = isRecord(item.league) ? item.league : undefined;
    const teams = isRecord(item.teams) ? item.teams : undefined;
    const goals = isRecord(item.goals) ? item.goals : undefined;
    if (!fixture || !teams || !goals) {
      continue;
    }
    const status = isRecord(fixture.status) ? String(fixture.status.short ?? '').toUpperCase() : '';
    if (!FINISHED_STATUSES.has(status)) {
      continue;
    }
    const fixtureId = idString(fixture.id);
    const home = isRecord(teams.home) ? teams.home : undefined;
    const away = isRecord(teams.away) ? teams.away : undefined;
    const homeTeamId = idString(home?.id);
    const awayTeamId = idString(away?.id);
    const homeGoals = nullableInt(goals.home);
    const awayGoals = nullableInt(goals.away);
    // Mirrors the proto doc comment: a row with an empty fixture id, home
    // team id or away team id is not written. A missing scoreline on a
    // nominally-finished fixture is the same "nothing to score" case.
    if (
      fixtureId === '' ||
      homeTeamId === '' ||
      awayTeamId === '' ||
      homeGoals === undefined ||
      awayGoals === undefined
    ) {
      continue;
    }
    const providerCompetitionId = idString(league?.id) || String(leagueId);
    const seasonYear = nullableInt(league?.season);
    const kickoffMs = kickoffMsFromFixture(fixture);
    rows.push(
      create(ProviderFixtureResultRowSchema, {
        providerFixtureId: fixtureId,
        providerCompetitionId,
        seasonYear: seasonYear ?? 0,
        kickoffAt:
          kickoffMs !== undefined ? create(TimestampSchema, timestampFromMs(kickoffMs)) : undefined,
        providerHomeTeamId: homeTeamId,
        providerAwayTeamId: awayTeamId,
        homeTeamSnapshot: teamSnapshot(home),
        awayTeamSnapshot: teamSnapshot(away),
        homeGoals,
        awayGoals,
        status: STATUS_TO_PROTO[status] ?? ProviderFixtureResultStatus.UNSPECIFIED,
        fetchedAt: create(TimestampSchema, timestampFromMs(fetchedAtMs)),
      })
    );
  }
  return rows;
};

const kickoffMsFromFixture = (fixture: Record<string, unknown>): number | undefined => {
  const timestamp = fixture.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp * 1000;
  }
  const date = fixture.date;
  if (typeof date === 'string' && date.trim() !== '') {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const teamSnapshot = (team: Record<string, unknown> | undefined) => {
  if (!team) {
    return undefined;
  }
  const label = typeof team.name === 'string' ? team.name.trim() : '';
  const imageUrl = typeof team.logo === 'string' ? team.logo.trim() : '';
  if (label === '' && imageUrl === '') {
    return undefined;
  }
  return create(ProviderEntitySnapshotSchema, {
    label,
    slug: label === '' ? '' : slugify(label),
    imageUrl,
    attributes: {
      provider_team_id: idString(team.id),
    },
  });
};

const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const idString = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
};

const nullableInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const __test = {
  resolveHistoryTargets,
  resolveNightlyTargets,
  dedupeLeagueIds,
  fixtureResultRowsFromEnvelope,
  ALLOWED_LEAGUE_IDS,
};
