/**
 * Daily 02:00 UTC anchor sweep.
 *
 * Per competition, in catalogue order:
 *   1. `fixtures-next-7d` — pulls fixtures within a -1d/+7d window so
 *      the ingestion cache stays warm for prematch panels and recent
 *      finals are reconciled.
 *   2. `team-metadata` for any team that appears in the fixture list
 *      and is not yet cached (heuristic: missed cache last 24h).
 *   3. `events-post-final` + `lineups-post-confirm` for any fixture
 *      whose kickoff is older than 30min and whose match-concluded
 *      fact has not been emitted yet (poller fallback).
 *
 * Returns per-competition + aggregated results. Workflow degrades
 * progressively: once `handleQuotaPosture` returns `cached-only`,
 * remaining iterations use cache only; once it returns `abort` the
 * workflow stops and reports the partial result.
 *
 * The workflow is deliberately sequential. Concurrent fanout would
 * burn the singleflight key collisions and double the call budget
 * with no schedule benefit at this cadence.
 */
import { apiFootballFixturePath } from '../adapters/api-football/index.js';
import type { IngestionFetchResult, IngestionWorkload } from '../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { isMatchdayWindow } from './competitions.js';
import { handleProviderOutage, handleQuotaPosture, mostRestrictive } from './degrade.js';
import type {
  CompetitionEntry,
  CompetitionRunResult,
  DailyAnchorInput,
  DailyAnchorOutput,
  DegradeFlag,
  WorkflowDeps,
} from './types.js';

type SweepMode = 'continue' | 'cached-only' | 'abort';

const FIXTURE_FALLBACK_MIN_AGE_MS = 30 * 60 * 1000;
const ANCHOR_BACKWARD_DAYS = 1;
const ANCHOR_FORWARD_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const formatYmd = (date: Date): string => date.toISOString().slice(0, 10);

const FIXTURES_ANCHOR_WINDOW_PATH = (competition: CompetitionEntry, anchorAt: Date): string => {
  const from = formatYmd(new Date(anchorAt.getTime() - ANCHOR_BACKWARD_DAYS * MS_PER_DAY));
  const to = formatYmd(new Date(anchorAt.getTime() + ANCHOR_FORWARD_DAYS * MS_PER_DAY));
  return `/fixtures?league=${competition.apiFootballLeagueId}&season=${competition.season}&from=${from}&to=${to}`;
};

const STANDINGS_PATH = (competition: CompetitionEntry): string =>
  `/standings?league=${competition.apiFootballLeagueId}&season=${competition.season}`;

const TEAM_METADATA_RESOURCE = (competition: CompetitionEntry, teamId: number): string =>
  `${competition.apiFootballLeagueId}:${competition.season}:team:${teamId}`;

const TEAM_METADATA_PATH = (teamId: number): string => `/teams?id=${teamId}`;

const TEAM_METADATA_WORKLOAD: IngestionWorkload = 'team-metadata';
const STANDINGS_WORKLOAD: IngestionWorkload = 'fixtures-next-7d';
const FIXTURES_WORKLOAD: IngestionWorkload = 'fixtures-next-7d';
const EVENTS_WORKLOAD: IngestionWorkload = 'events-post-final';
const LINEUPS_WORKLOAD: IngestionWorkload = 'lineups-post-confirm';
const FIXTURE_DETAIL_WORKLOAD: IngestionWorkload = 'fixture-detail-fullTime';

interface FixtureListItem {
  readonly fixtureId: string;
  readonly scheduledMs: number;
  readonly homeTeamId?: number;
  readonly awayTeamId?: number;
  readonly statusShort?: string;
}

const FT_STATUSES = new Set(['FT', 'AET', 'PEN']);

export const dailyAnchorWorkflow = async (
  input: DailyAnchorInput,
  deps: WorkflowDeps
): Promise<DailyAnchorOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const startedAt = input.nowUtc ? new Date(input.nowUtc) : clock();

  const selectedKeys = new Set(input.competitions);
  const competitions = deps.competitions.filter(
    (competition) => selectedKeys.size === 0 || selectedKeys.has(competition.key)
  );

  const competitionResults: CompetitionRunResult[] = [];
  const degradeFlags: DegradeFlag[] = [];
  let totalCallsBudgeted = 0;
  let totalCallsUsed = 0;
  let totalFixturesIngested = 0;
  let finalQuota: ProviderQuotaSnapshot | undefined;
  let aborted = false;

  log({ event: 'daily_anchor.started', workflow: 'daily-anchor' });

  for (const competition of competitions) {
    if (aborted) {
      break;
    }
    const result = await sweepCompetition(competition, startedAt, deps);
    competitionResults.push(result.summary);
    totalCallsBudgeted += result.summary.callsBudgeted;
    totalCallsUsed += result.summary.callsUsed;
    totalFixturesIngested += result.summary.fixturesIngested;
    finalQuota = result.finalQuota ?? finalQuota;
    degradeFlags.push(...result.flags);
    if (result.action === 'abort') {
      aborted = true;
      log({
        event: 'daily_anchor.aborted',
        workflow: 'daily-anchor',
        competition: competition.key,
        reason: 'quota hard cap',
      });
    }
  }

  const finishedAt = clock();
  log({
    event: 'daily_anchor.finished',
    workflow: 'daily-anchor',
    callsBudgeted: totalCallsBudgeted,
    callsUsed: totalCallsUsed,
    fixturesIngested: totalFixturesIngested,
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    callsBudgeted: totalCallsBudgeted,
    callsUsed: totalCallsUsed,
    fixturesIngested: totalFixturesIngested,
    competitions: competitionResults,
    degradeFlags,
    finalQuota,
  };
};

interface CompetitionSweep {
  readonly summary: CompetitionRunResult;
  readonly flags: readonly DegradeFlag[];
  readonly action: 'continue' | 'cached-only' | 'abort';
  readonly finalQuota?: ProviderQuotaSnapshot;
}

const sweepCompetition = async (
  competition: CompetitionEntry,
  startedAt: Date,
  deps: WorkflowDeps
): Promise<CompetitionSweep> => {
  const fetches: IngestionFetchResult[] = [];
  const errors: string[] = [];
  const flags: DegradeFlag[] = [];
  let callsBudgeted = 0;
  let callsUsed = 0;
  let fixturesIngested = 0;
  let lastQuota: ProviderQuotaSnapshot | undefined;
  let mode: SweepMode = 'continue' as SweepMode;

  const accumulate = (
    result: IngestionFetchResult,
    workload: IngestionWorkload,
    resourceId: string,
    currentMode: SweepMode
  ): SweepMode => {
    fetches.push(result);
    callsBudgeted += 1;
    if (result.status === 'fetched') {
      callsUsed += 1;
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
    const next = mostRestrictive([
      currentMode,
      quotaResult.action,
      result.fallbackReason === 'PROVIDER_OUTAGE' ? 'cached-only' : 'continue',
    ]);
    if (next === 'abort') {
      return 'abort';
    }
    if (next === 'cached-only' || currentMode === 'cached-only') {
      return 'cached-only';
    }
    return 'continue';
  };

  // Step 1: fixtures within the anchor window (yesterday → 7 days out).
  // Bounded window is essential: an unbounded /fixtures?league&season query
  // returns the whole season (~380 fixtures per top-five league) and the
  // per-fixture FT reconciliation below would balloon a 30m sweep budget.
  const anchorYmd = formatYmd(startedAt);
  const fixturesResource = `league-${competition.apiFootballLeagueId}-season-${competition.season}-anchor-${anchorYmd}`;
  const fixturesResult = await deps.ingestion.fetchWorkload({
    workload: FIXTURES_WORKLOAD,
    resourceId: fixturesResource,
    path: FIXTURES_ANCHOR_WINDOW_PATH(competition, startedAt),
  });
  mode = accumulate(fixturesResult, FIXTURES_WORKLOAD, fixturesResource, mode);

  // Every fixture in the forward window — SCHEDULED (NS) ones included — is
  // upserted into game-service as a canonical game by the ingestion loop's
  // match-concluded bridge (the `fixtures-next-7d` list branch). Count the
  // whole window list so a competition whose fixtures are all upcoming (e.g.
  // FIFA World Cup 2026 before its opener) reports the games it actually
  // created, mirroring `hourlyMatchdayWorkflow`'s window count. The post-FT
  // detail/events/lineups reconciliation below operates on a subset of these
  // same fixtures, so it must NOT additionally bump the counter (no double
  // count).
  if (fixturesResult.status === 'fetched' || fixturesResult.status === 'cached') {
    fixturesIngested += countFixtures(fixturesResult.data);
  }

  if (mode === 'abort') {
    return finalSweep(
      competition,
      summary(competition, callsBudgeted, callsUsed, fixturesIngested, errors, fetches),
      flags,
      lastQuota,
      mode
    );
  }

  // Step 2: standings — same workload key reuses the cache TTL but a
  // different resource id + path so the cache doesn't collide.
  const standingsResource = `standings-${competition.apiFootballLeagueId}-${competition.season}`;
  const standingsResult = await deps.ingestion.fetchWorkload({
    workload: STANDINGS_WORKLOAD,
    resourceId: standingsResource,
    path: STANDINGS_PATH(competition),
  });
  mode = accumulate(standingsResult, STANDINGS_WORKLOAD, standingsResource, mode);

  if (mode === 'abort') {
    return finalSweep(
      competition,
      summary(competition, callsBudgeted, callsUsed, fixturesIngested, errors, fetches),
      flags,
      lastQuota,
      mode
    );
  }

  // Step 3: extract fixture list, walk each unfinished + post-FT
  // fixture and refresh team metadata + post-FT events/lineups.
  const fixtureItems = extractFixtureItems(fixturesResult.data);
  const seenTeams = new Set<number>();
  const fallbackCutoffMs = startedAt.getTime() - FIXTURE_FALLBACK_MIN_AGE_MS;
  const matchdayHour = isMatchdayWindow(startedAt, competition.calendar);

  for (const item of fixtureItems) {
    if (mode === 'abort') {
      break;
    }
    // Team metadata refresh: one call per team across the whole sweep.
    for (const teamId of [item.homeTeamId, item.awayTeamId]) {
      if (mode === 'abort') {
        break;
      }
      if (teamId === undefined || seenTeams.has(teamId)) {
        continue;
      }
      seenTeams.add(teamId);
      const teamResource = TEAM_METADATA_RESOURCE(competition, teamId);
      const teamResult = await deps.ingestion.fetchWorkload({
        workload: TEAM_METADATA_WORKLOAD,
        resourceId: teamResource,
        path: TEAM_METADATA_PATH(teamId),
      });
      mode = accumulate(teamResult, TEAM_METADATA_WORKLOAD, teamResource, mode);
    }

    if (mode === 'abort') {
      break;
    }

    // Post-FT poller fallback: if the fixture has reached full-time
    // status (or its scheduled kickoff is older than 30min and we
    // somehow missed the live ladder), pull events + lineups + the
    // detail payload so the match-concluded bridge resolves and
    // emits. The bridge owns idempotency via `RedisEmittedFixtureStore`.
    const finalised =
      FT_STATUSES.has(item.statusShort ?? '') ||
      (Number.isFinite(item.scheduledMs) && item.scheduledMs <= fallbackCutoffMs && matchdayHour);
    if (!finalised) {
      continue;
    }

    const detailResult = await deps.ingestion.fetchWorkload({
      workload: FIXTURE_DETAIL_WORKLOAD,
      resourceId: item.fixtureId,
      path: apiFootballFixturePath(item.fixtureId),
    });
    mode = accumulate(detailResult, FIXTURE_DETAIL_WORKLOAD, item.fixtureId, mode);
    if (mode === 'abort') {
      break;
    }

    const eventsResult = await deps.ingestion.fetchWorkload({
      workload: EVENTS_WORKLOAD,
      resourceId: item.fixtureId,
    });
    mode = accumulate(eventsResult, EVENTS_WORKLOAD, item.fixtureId, mode);
    if (mode === 'abort') {
      break;
    }

    const lineupsResult = await deps.ingestion.fetchWorkload({
      workload: LINEUPS_WORKLOAD,
      resourceId: item.fixtureId,
    });
    mode = accumulate(lineupsResult, LINEUPS_WORKLOAD, item.fixtureId, mode);
    // NOTE: fixturesIngested is counted once from the window list above; the
    // post-FT reconciliation here refreshes detail/events/lineups for the
    // finalised subset but does not re-count those fixtures.
  }

  return finalSweep(
    competition,
    summary(competition, callsBudgeted, callsUsed, fixturesIngested, errors, fetches),
    flags,
    lastQuota,
    mode
  );
};

const summary = (
  competition: CompetitionEntry,
  callsBudgeted: number,
  callsUsed: number,
  fixturesIngested: number,
  errors: readonly string[],
  fetches: readonly IngestionFetchResult[]
): CompetitionRunResult => ({
  competition: competition.key,
  callsBudgeted,
  callsUsed,
  fixturesIngested,
  errors,
  fetches,
});

const finalSweep = (
  _competition: CompetitionEntry,
  competitionSummary: CompetitionRunResult,
  flags: readonly DegradeFlag[],
  finalQuota: ProviderQuotaSnapshot | undefined,
  mode: SweepMode
): CompetitionSweep => ({
  summary: competitionSummary,
  flags,
  action: mode,
  finalQuota,
});

const extractFixtureItems = (data: unknown): readonly FixtureListItem[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const items: FixtureListItem[] = [];
  for (const item of data.response) {
    if (!isRecord(item)) {
      continue;
    }
    const fixture = isRecord(item.fixture) ? item.fixture : undefined;
    const teams = isRecord(item.teams) ? item.teams : undefined;
    if (!fixture) {
      continue;
    }
    const fixtureId = String(fixture.id ?? '');
    if (fixtureId === '') {
      continue;
    }
    const dateRaw = typeof fixture.date === 'string' ? fixture.date : '';
    const scheduledMs = dateRaw === '' ? Number.NaN : Date.parse(dateRaw);
    const status = isRecord(fixture.status) ? String(fixture.status.short ?? '') : '';
    const homeTeam = teams && isRecord(teams.home) ? teams.home : undefined;
    const awayTeam = teams && isRecord(teams.away) ? teams.away : undefined;
    items.push({
      fixtureId,
      scheduledMs,
      statusShort: status,
      homeTeamId: homeTeam && typeof homeTeam.id === 'number' ? homeTeam.id : undefined,
      awayTeamId: awayTeam && typeof awayTeam.id === 'number' ? awayTeam.id : undefined,
    });
  }
  return items;
};

/**
 * Count the fixtures present in a `/fixtures` list envelope. Used as the
 * `fixturesIngested` signal: every fixture in the forward window is upserted
 * into game-service (SCHEDULED ones included) by the ingestion loop's
 * `fixtures-next-7d` bridge branch. Matches `hourlyMatchdayWorkflow`'s
 * `countFixtures`.
 */
const countFixtures = (data: unknown): number => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return 0;
  }
  return data.response.length;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
