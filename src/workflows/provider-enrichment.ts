/**
 * Provider enrichment workflow (spec GW-6, built as GW-6a).
 *
 * `POST /workflows/provider-enrichment` pulls an API-Football enrichment
 * dataset and writes it straight to the GS-2 ingest RPC. This build carries
 * one dataset, `player-season-stats` (`/players?league&season&page`), pulled
 * forward for the player profile. Injuries, leaders, team season stats and
 * the rest arrive in GW-6b under the same endpoint.
 *
 * Rules (mega-verdict and profile-spec PF-GW2):
 * - Kill switch: a dataset runs only when it is named in
 *   `GAMEWIRE_ENRICHMENT_DATASETS`. The default is empty, so everything is off.
 * - Seasons are explicit (D15). `full` takes `leagueIds` and `seasons` from the
 *   request; `nightly` defaults to the catalogue's domestic leagues at their
 *   catalogue season. Nothing is gated on a season's end date.
 * - No bulk caching (D9). Pages are fetched with the cache bypassed and go
 *   straight to `IngestProviderPlayerSeasonStats`. The only thing stored is a
 *   small page cursor per league-season, so a run that stops resumes.
 * - Background priority (D5). Every call passes `background` explicitly, so
 *   it is held to the provider-wide background minute ceiling and refused at
 *   the background daily cap.
 * - Its own per-minute ceiling (default 120) in front of that, shared by every
 *   enrichment run in the process, and a per-run call limit.
 * - A provider null stays out of the row's `values` (null is not 0).
 *
 * History backfill (PF-GW2), over two or three nights:
 *
 *   {"dataset":"player-season-stats","mode":"full",
 *    "leagueIds":[39,40,41,42,61,71,78,88,94,135,140,144],
 *    "seasons":[2025,2024,2023],"limit":1500}
 *
 * Nightly current-season refresh (the K-2 schedule's `mode: "auto"` and the
 * spec's `"dirty"` are accepted as `nightly`):
 *
 *   {"dataset":"player-season-stats","mode":"nightly"}
 *
 * A 1,500-call run takes about 13 minutes at 120 a minute, so the K-2
 * activity's StartToClose needs 15 minutes or more. A retry that lands while
 * the first run is still going finds its league-seasons `in-progress`.
 */
import { create } from '@bufbuild/protobuf';

import {
  IngestMetadataSchema,
  IngestProviderPlayerSeasonStatsRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import type { ProviderPlayerSeasonStatsRow } from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import {
  apiFootballPlayerSeasonStatsPath,
  decodePlayerSeasonStatsPage,
} from '../adapters/api-football/enrichment-decoders.js';
import type { ProviderEnrichmentIngestClient } from '../worker/clients/game-service.js';
import type { IngestionFetchResult } from '../worker/ingestion.js';
import { DEFAULT_ENRICHMENT_MINUTE_CAP, ProviderMinuteLimiter } from '../worker/minute-limiter.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { handleQuotaPosture } from './degrade.js';
import type {
  CompetitionEntry,
  DegradeFlag,
  ProviderEnrichmentDataset,
  ProviderEnrichmentInput,
  ProviderEnrichmentMode,
  ProviderEnrichmentOutput,
  ProviderEnrichmentTargetResult,
  WorkflowDeps,
  WorkflowLogEntry,
} from './types.js';
import { WORKFLOW_PROVIDER_PRIORITY } from './types.js';

export const PROVIDER_ENRICHMENT_DATASETS: readonly ProviderEnrichmentDataset[] = [
  'player-season-stats',
];

export const PROVIDER_ENRICHMENT_MODES: readonly ProviderEnrichmentMode[] = ['nightly', 'full'];

/**
 * Spec mode names accepted on the wire. The spec body is
 * `mode: "auto"|"dirty"|"full"` and the K-2 schedule sends `mode: "auto"`.
 * For player season stats both mean the current-season refresh: the spec's
 * Monday "full" is a refresh of every catalogue league, which is what
 * `nightly` already does each night, while `full` here is the history
 * backfill and needs explicit `leagueIds` and `seasons`.
 */
export const PROVIDER_ENRICHMENT_MODE_ALIASES: Readonly<Record<string, ProviderEnrichmentMode>> = {
  auto: 'nightly',
  dirty: 'nightly',
};

/** Default provider calls per run: one nightly refresh of the domestic leagues fits. */
export const DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN = 1_500;
/** Upper bound on `limit`. The history backfill (about 3,500 calls) takes two or more runs. */
export const MAX_ENRICHMENT_CALLS_PER_RUN = 4_000;
export { DEFAULT_ENRICHMENT_MINUTE_CAP };
/** Rows per ingest call (GS-2 rejects larger batches). */
export const ENRICHMENT_INGEST_BATCH_SIZE = 500;
/** Guard against a provider `paging.total` that never ends. */
export const MAX_PAGES_PER_TARGET = 250;
/** Page attempts after the minute limiter held a call back. */
const RATE_LIMITED_ATTEMPTS = 3;
/** Consecutive failed pages that end the run. */
const FAILURE_CIRCUIT_THRESHOLD = 3;
/** Waits for the enrichment minute limiter before the run gives up. */
const MAX_LIMITER_WAITS = 5;
/** Margin past the minute boundary before retrying after a provider rate-limit reply. */
const PROVIDER_RATE_LIMIT_MARGIN_MS = 1_000;

/**
 * League-seasons an enrichment run in this process is working on, keyed by
 * {@link enrichmentTargetKey}. A second run (a Temporal retry after an
 * activity timeout, or a manual run overlapping the nightly one) reports a
 * held target as `in-progress` instead of fetching the same pages again.
 */
const PROCESS_IN_FLIGHT_TARGETS = new Set<string>();

export const enrichmentTargetKey = (
  dataset: ProviderEnrichmentDataset,
  leagueId: number,
  season: number
): string => `${dataset}:${leagueId}:${season}`;

/**
 * How long a completed or in-progress cursor counts. A nightly refresh redoes
 * the current season each night; a finished history season is left alone for
 * 30 days unless the request sets `reset`.
 */
export const ENRICHMENT_CURSOR_WINDOW_SECONDS: Readonly<Record<ProviderEnrichmentMode, number>> = {
  nightly: 20 * 60 * 60,
  full: 30 * 24 * 60 * 60,
};

/** Catalogue tiers the nightly mode covers by default. */
const NIGHTLY_DEFAULT_TIERS: ReadonlySet<CompetitionEntry['tier']> = new Set([
  'domestic-top-five',
  'domestic-league',
]);

/** Small per-league-season progress record. The only enrichment state kept in the cache. */
export interface EnrichmentCursor {
  readonly nextPage: number;
  readonly totalPages: number;
  readonly startedAtMs: number;
  readonly completedAtMs?: number;
}

export const enrichmentCursorKey = (
  dataset: ProviderEnrichmentDataset,
  leagueId: number,
  season: number
): string => `enrich:${dataset}:cursor:${leagueId}:${season}`;

export const clampEnrichmentLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN;
  }
  return Math.min(Math.floor(limit), MAX_ENRICHMENT_CALLS_PER_RUN);
};

interface Target {
  readonly leagueId: number;
  readonly season: number;
}

/**
 * Resolve the league-seasons a run covers. `full` uses the request as given;
 * `nightly` fills in what the request leaves out from the catalogue.
 */
export const resolveEnrichmentTargets = (
  input: Pick<ProviderEnrichmentInput, 'mode' | 'leagueIds' | 'seasons'>,
  competitions: readonly CompetitionEntry[]
): { readonly targets: readonly Target[]; readonly unresolved: readonly number[] } => {
  const leagueIds = uniquePositiveInts(input.leagueIds ?? []);
  const seasons = uniquePositiveInts(input.seasons ?? []);
  const targets: Target[] = [];
  const unresolved: number[] = [];

  if (input.mode === 'full') {
    // Season-major order, latest season first whatever order the request
    // used, so the most useful pools fill first if the run stops part way.
    for (const season of [...seasons].sort((a, b) => b - a)) {
      for (const leagueId of leagueIds) {
        targets.push({ leagueId, season });
      }
    }
    return { targets, unresolved };
  }

  const catalogue = new Map<number, CompetitionEntry>();
  for (const entry of competitions) {
    catalogue.set(entry.apiFootballLeagueId, entry);
  }
  const leagues =
    leagueIds.length > 0
      ? leagueIds
      : competitions
          .filter((entry) => NIGHTLY_DEFAULT_TIERS.has(entry.tier))
          .map((entry) => entry.apiFootballLeagueId);
  for (const leagueId of uniquePositiveInts(leagues)) {
    if (seasons.length > 0) {
      for (const season of seasons) {
        targets.push({ leagueId, season });
      }
      continue;
    }
    const entry = catalogue.get(leagueId);
    if (!entry) {
      unresolved.push(leagueId);
      continue;
    }
    targets.push({ leagueId, season: entry.season });
  }
  return { targets, unresolved };
};

export const providerEnrichmentWorkflow = async (
  input: ProviderEnrichmentInput,
  deps: WorkflowDeps
): Promise<ProviderEnrichmentOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const startedAt = clock();
  const parsedNow = input.nowUtc ? Date.parse(input.nowUtc) : Number.NaN;
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : startedAt.getTime();
  const log = (entry: Omit<WorkflowLogEntry, 'workflow'>) =>
    deps.logger?.({ workflow: 'provider-enrichment', ...entry });
  const limit = clampEnrichmentLimit(input.limit);
  const dryRun = input.dryRun === true;
  const degradeFlags: DegradeFlag[] = [];

  const finish = (
    status: ProviderEnrichmentOutput['status'],
    fields: {
      readonly targets?: readonly ProviderEnrichmentTargetResult[];
      readonly callsUsed?: number;
      readonly finalQuota?: ProviderQuotaSnapshot;
      readonly reason?: string;
    } = {}
  ): ProviderEnrichmentOutput => {
    const targets = fields.targets ?? [];
    const output: ProviderEnrichmentOutput = {
      startedAt: startedAt.toISOString(),
      finishedAt: clock().toISOString(),
      dataset: input.dataset,
      mode: input.mode,
      status,
      callsBudgeted: limit,
      callsUsed: fields.callsUsed ?? 0,
      pagesFetched: targets.reduce((total, t) => total + t.pagesFetched, 0),
      rowsIngested: targets.reduce((total, t) => total + t.rowsIngested, 0),
      rowsDropped: targets.reduce((total, t) => total + t.rowsDropped, 0),
      targets,
      degradeFlags,
      finalQuota: fields.finalQuota,
      dryRun,
      reason: fields.reason,
    };
    log({
      event: 'provider_enrichment.completed',
      status,
      callsBudgeted: limit,
      callsUsed: output.callsUsed,
      reason: fields.reason,
    });
    return output;
  };

  const enabled = deps.enrichment?.enabledDatasets ?? [];
  if (!enabled.includes(input.dataset)) {
    return finish('disabled', { reason: `dataset ${input.dataset} is not enabled` });
  }

  const { targets, unresolved } = resolveEnrichmentTargets(input, deps.competitions);
  for (const leagueId of unresolved) {
    log({
      event: 'provider_enrichment.target_unresolved',
      leagueId,
      reason: 'league is not in the catalogue and the request names no seasons',
    });
  }
  if (targets.length === 0) {
    return finish('skipped', { reason: 'no league-seasons to fetch' });
  }

  const cache = deps.ingestion.cache;
  const windowSeconds = ENRICHMENT_CURSOR_WINDOW_SECONDS[input.mode];
  const readCursor = async (target: Target): Promise<EnrichmentCursor | undefined> => {
    if (input.reset) {
      return undefined;
    }
    const cursor = await cache.get<EnrichmentCursor>(
      enrichmentCursorKey(input.dataset, target.leagueId, target.season)
    );
    if (!cursor || nowMs - cursor.startedAtMs > windowSeconds * 1_000) {
      return undefined;
    }
    return cursor;
  };
  const writeCursor = (target: Target, cursor: EnrichmentCursor) =>
    cache.set(
      enrichmentCursorKey(input.dataset, target.leagueId, target.season),
      cursor,
      windowSeconds
    );

  const inFlight = deps.enrichment?.inFlight ?? PROCESS_IN_FLIGHT_TARGETS;

  if (dryRun) {
    const planned: ProviderEnrichmentTargetResult[] = [];
    for (const target of targets) {
      const cursor = await readCursor(target);
      const held = inFlight.has(enrichmentTargetKey(input.dataset, target.leagueId, target.season));
      planned.push({
        ...target,
        status: held ? 'in-progress' : cursor?.completedAtMs !== undefined ? 'fresh' : 'planned',
        pagesTotal: cursor?.totalPages ?? 0,
        nextPage: cursor?.nextPage ?? 1,
        pagesFetched: 0,
        rowsIngested: 0,
        rowsDropped: 0,
        errors: [],
      });
    }
    return finish('completed', { targets: planned, reason: 'dry run' });
  }

  const ingest = deps.enrichment?.ingest;
  if (!ingest) {
    return finish('skipped', { reason: 'game-service enrichment ingest client is not wired' });
  }

  const minuteCap = deps.enrichment?.minuteCap ?? DEFAULT_ENRICHMENT_MINUTE_CAP;
  const limiter =
    deps.enrichment?.limiter ??
    new ProviderMinuteLimiter({
      providerId: `${API_FOOTBALL_PROVIDER_ID}:enrichment`,
      caps: { live: minuteCap, 'near-live': minuteCap, background: minuteCap },
      clock: () => clock().getTime(),
    });
  const sleep = deps.enrichment?.sleep ?? defaultSleep;

  /** Wait for a token from the enrichment limiter. False when the run should stop. */
  const acquireJobToken = async (): Promise<boolean> => {
    for (let attempt = 0; attempt <= MAX_LIMITER_WAITS; attempt += 1) {
      const token = await limiter.tryAcquire(WORKFLOW_PROVIDER_PRIORITY);
      if (token.allowed) {
        return true;
      }
      if (attempt === MAX_LIMITER_WAITS) {
        break;
      }
      const waitMs = Math.max(250, Math.min(60_000, token.retryAfterMs ?? token.msUntilNextMinute));
      await sleep(waitMs);
    }
    return false;
  };

  const results: ProviderEnrichmentTargetResult[] = [];
  let callsUsed = 0;
  let consecutiveFailures = 0;
  let lastQuota: ProviderQuotaSnapshot | undefined;
  let stop: { status: 'incomplete' | 'aborted'; reason: string } | undefined;

  for (const target of targets) {
    if (stop) {
      const cursor = await readCursor(target);
      results.push({
        ...target,
        status: 'not-started',
        pagesTotal: cursor?.totalPages ?? 0,
        nextPage: cursor?.nextPage ?? 1,
        pagesFetched: 0,
        rowsIngested: 0,
        rowsDropped: 0,
        errors: [],
      });
      continue;
    }

    const targetKey = enrichmentTargetKey(input.dataset, target.leagueId, target.season);
    if (inFlight.has(targetKey)) {
      const cursor = await readCursor(target);
      log({
        event: 'provider_enrichment.target_in_progress',
        leagueId: target.leagueId,
        season: target.season,
        reason: 'another run in this process holds this league-season',
      });
      results.push({
        ...target,
        status: 'in-progress',
        pagesTotal: cursor?.totalPages ?? 0,
        nextPage: cursor?.nextPage ?? 1,
        pagesFetched: 0,
        rowsIngested: 0,
        rowsDropped: 0,
        errors: [],
      });
      continue;
    }
    inFlight.add(targetKey);
    try {
      const existing = await readCursor(target);
      if (existing?.completedAtMs !== undefined) {
        results.push({
          ...target,
          status: 'fresh',
          pagesTotal: existing.totalPages,
          nextPage: existing.nextPage,
          pagesFetched: 0,
          rowsIngested: 0,
          rowsDropped: 0,
          errors: [],
        });
        continue;
      }

      let cursor: EnrichmentCursor = existing ?? {
        nextPage: 1,
        totalPages: 0,
        startedAtMs: nowMs,
      };
      let pagesFetched = 0;
      let rowsIngested = 0;
      let rowsDropped = 0;
      const errors: string[] = [];
      let targetStatus: ProviderEnrichmentTargetResult['status'] = 'partial';

      pages: while (true) {
        if (cursor.totalPages > 0 && cursor.nextPage > cursor.totalPages) {
          cursor = { ...cursor, completedAtMs: clock().getTime() };
          await writeCursor(target, cursor);
          targetStatus = 'complete';
          break;
        }
        if (cursor.nextPage > MAX_PAGES_PER_TARGET) {
          errors.push(`page ${cursor.nextPage} is past the ${MAX_PAGES_PER_TARGET}-page guard`);
          targetStatus = 'failed';
          break;
        }
        if (callsUsed >= limit) {
          stop = { status: 'incomplete', reason: `call limit ${limit} reached` };
          break;
        }

        const page = cursor.nextPage;
        let result: IngestionFetchResult | undefined;
        for (let attempt = 1; attempt <= RATE_LIMITED_ATTEMPTS; attempt += 1) {
          if (!(await acquireJobToken())) {
            stop = { status: 'incomplete', reason: 'enrichment minute limiter stayed full' };
            break pages;
          }
          result = await deps.ingestion.fetchWorkload({
            workload: 'player-season-stats',
            resourceId: `players-${target.leagueId}-${target.season}-${page}`,
            path: apiFootballPlayerSeasonStatsPath(target.leagueId, target.season, page),
            priority: WORKFLOW_PROVIDER_PRIORITY,
            cache: 'bypass',
          });
          if (result.fetch !== undefined && result.status !== 'skipped') {
            callsUsed += 1;
          }
          lastQuota = result.quota;
          if (result.status !== 'rate_limited') {
            break;
          }
          log({
            event: 'provider_enrichment.rate_limited',
            leagueId: target.leagueId,
            season: target.season,
            status: `page ${page} attempt ${attempt}`,
            message: result.error?.message,
          });
          if (callsUsed >= limit || attempt === RATE_LIMITED_ATTEMPTS) {
            break;
          }
          if (result.fetch !== undefined) {
            // The provider itself refused (HTTP 200 with errors.rateLimit). The
            // local throttle already waited inside the ingestion loop; this
            // reply did not, so wait for the provider's next minute before the
            // retry rather than spend another call it will refuse.
            const nowMsLocal = clock().getTime();
            await sleep(60_000 - (nowMsLocal % 60_000) + PROVIDER_RATE_LIMIT_MARGIN_MS);
          }
        }
        if (!result) {
          break;
        }

        if (result.status === 'rate_limited') {
          degradeFlags.push({
            trigger: 'provider-rate-limited',
            action: 'cached-only',
            detail: result.error?.message,
          });
          stop = { status: 'incomplete', reason: 'provider minute limit' };
          break;
        }

        if (result.status === 'denied') {
          const posture = handleQuotaPosture(result.quota);
          const flag = posture.flag ?? {
            trigger: 'background-cap' as const,
            action: 'cached-only' as const,
            detail: result.error?.message,
          };
          degradeFlags.push(flag);
          stop =
            posture.action === 'abort'
              ? { status: 'aborted', reason: 'provider hard cap reached' }
              : { status: 'incomplete', reason: result.error?.message ?? 'quota denied the call' };
          break;
        }

        if (result.status !== 'fetched' || result.data === undefined) {
          const message = `page ${page}: ${result.status}${result.error ? ` ${result.error.message}` : ''}`;
          errors.push(message);
          log({
            event: 'provider_enrichment.page_failed',
            leagueId: target.leagueId,
            season: target.season,
            status: result.status,
            message,
          });
          targetStatus = 'failed';
          consecutiveFailures += 1;
          if (consecutiveFailures >= FAILURE_CIRCUIT_THRESHOLD) {
            degradeFlags.push({
              trigger: 'provider-5xx',
              action: 'circuit-open',
              detail: `${consecutiveFailures} pages failed in a row`,
            });
            stop = { status: 'aborted', reason: `${consecutiveFailures} pages failed in a row` };
          }
          break;
        }

        const fetchedAtMs = clock().getTime();
        const decoded = decodePlayerSeasonStatsPage(result.data, {
          leagueId: target.leagueId,
          season: target.season,
          fetchedAtMs,
        });
        pagesFetched += 1;
        rowsDropped += decoded.dropped;

        // A later page with no `paging` block or `total: 0` keeps the total
        // page 1 reported, so a malformed page cannot end the league-season.
        const totalPages =
          page > 1 && decoded.paging.total === 0 ? cursor.totalPages : decoded.paging.total;
        // An empty page before the last one is a provider fault, not the end of
        // the data: fail it so the cursor stays on it and the run retries it.
        const emptyBeforeEnd = decoded.entries === 0 && page < totalPages;

        if ((decoded.providerErrors !== undefined && decoded.rows.length === 0) || emptyBeforeEnd) {
          const message =
            decoded.providerErrors !== undefined
              ? `page ${page}: provider errors ${decoded.providerErrors}`
              : `page ${page}: empty response before page ${totalPages}`;
          errors.push(message);
          log({
            event: 'provider_enrichment.page_failed',
            leagueId: target.leagueId,
            season: target.season,
            status: 'provider_error',
            message,
          });
          targetStatus = 'failed';
          consecutiveFailures += 1;
          if (consecutiveFailures >= FAILURE_CIRCUIT_THRESHOLD) {
            stop = { status: 'aborted', reason: `${consecutiveFailures} pages failed in a row` };
          }
          break;
        }

        try {
          rowsIngested += await ingestRows(ingest, decoded.rows, {
            leagueId: target.leagueId,
            season: target.season,
            page,
            fetchedAtMs,
          });
        } catch (error) {
          const message = `page ${page}: ingest failed: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          log({
            event: 'provider_enrichment.ingest_failed',
            leagueId: target.leagueId,
            season: target.season,
            message,
          });
          targetStatus = 'failed';
          consecutiveFailures += 1;
          if (consecutiveFailures >= FAILURE_CIRCUIT_THRESHOLD) {
            stop = { status: 'aborted', reason: `${consecutiveFailures} pages failed in a row` };
          }
          break;
        }
        consecutiveFailures = 0;

        // Page 1 sets the total; later pages may revise it upward or downward
        // but never to 0 (handled above). A total of 0 on page 1 means the
        // provider has nothing for this league-season.
        cursor = { ...cursor, nextPage: page + 1, totalPages };
        if (totalPages === 0 || page >= totalPages) {
          cursor = { ...cursor, completedAtMs: clock().getTime() };
          targetStatus = 'complete';
        }
        await writeCursor(target, cursor);
        log({
          event: 'provider_enrichment.page',
          leagueId: target.leagueId,
          season: target.season,
          status: `page ${page}/${totalPages}`,
          callsUsed,
          rowsIngested: decoded.rows.length,
        });
        if (targetStatus === 'complete') {
          break;
        }

        const posture = handleQuotaPosture(result.quota);
        if (posture.action !== 'continue') {
          if (posture.flag) {
            degradeFlags.push(posture.flag);
          }
          stop =
            posture.action === 'abort'
              ? { status: 'aborted', reason: 'provider hard cap reached' }
              : { status: 'incomplete', reason: posture.flag?.detail ?? posture.action };
          break;
        }
      }

      if (stop && targetStatus === 'partial' && pagesFetched === 0) {
        // The run stopped before this league-season fetched anything.
        targetStatus = 'not-started';
      }
      results.push({
        ...target,
        status: targetStatus,
        pagesTotal: cursor.totalPages,
        nextPage: cursor.nextPage,
        pagesFetched,
        rowsIngested,
        rowsDropped,
        errors,
      });
    } finally {
      inFlight.delete(targetKey);
    }
  }

  if (stop) {
    return finish(stop.status, {
      targets: results,
      callsUsed,
      finalQuota: lastQuota,
      reason: stop.reason,
    });
  }
  const allDone = results.every((r) => r.status === 'complete' || r.status === 'fresh');
  return finish(allDone ? 'completed' : 'incomplete', {
    targets: results,
    callsUsed,
    finalQuota: lastQuota,
    reason: allDone ? undefined : 'some league-seasons did not finish',
  });
};

/** Push rows in batches of at most {@link ENRICHMENT_INGEST_BATCH_SIZE}. Returns rows accepted. */
const ingestRows = async (
  ingest: ProviderEnrichmentIngestClient,
  rows: readonly ProviderPlayerSeasonStatsRow[],
  context: {
    readonly leagueId: number;
    readonly season: number;
    readonly page: number;
    readonly fetchedAtMs: number;
  }
): Promise<number> => {
  let accepted = 0;
  const provider = API_FOOTBALL_PROVIDER_ID;
  for (let start = 0; start < rows.length; start += ENRICHMENT_INGEST_BATCH_SIZE) {
    const batch = rows.slice(start, start + ENRICHMENT_INGEST_BATCH_SIZE);
    const resource = `players-${context.leagueId}-${context.season}-${context.page}`;
    const replayId = `provider-enrichment:${resource}:${context.fetchedAtMs}:${start}`;
    const response = await ingest.ingestProviderPlayerSeasonStats(
      create(IngestProviderPlayerSeasonStatsRequestSchema, {
        metadata: create(IngestMetadataSchema, {
          provider,
          replayId,
          rawPayloadRef: `provider://${provider}${apiFootballPlayerSeasonStatsPath(context.leagueId, context.season, context.page)}`,
          normalizedBatchId: `${provider}:player-season-stats:${resource}:${start}`,
          idempotencyKey: `${provider}:player-season-stats:${replayId}`,
        }),
        rows: batch,
      })
    );
    accepted += response.acceptedCount;
  }
  return accepted;
};

const uniquePositiveInts = (values: readonly number[]): number[] => {
  const seen = new Set<number>();
  for (const value of values) {
    if (Number.isInteger(value) && value > 0) {
      seen.add(value);
    }
  }
  return [...seen];
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
