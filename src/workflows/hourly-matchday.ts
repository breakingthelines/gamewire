/**
 * Hourly matchday workflow.
 *
 * Fires once per UTC hour. For each Phase A competition whose
 * matchday calendar includes the current `(weekday, hour)`, refresh:
 *   1. Standings (so league tables stay current as fixtures conclude).
 *   2. Next-24h fixtures (so the live-fixture loop has a warm fixture
 *      list to walk when kickoffs are imminent).
 *
 * Competitions outside their matchday window are recorded under
 * `skipped` and consume zero calls. If every competition is out of
 * window the workflow short-circuits and returns an empty result.
 *
 * Degrades follow the same progression as `dailyAnchorWorkflow`:
 *   continue -> cached-only -> abort.
 */
import type { IngestionFetchResult, IngestionWorkload } from '../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { isMatchdayWindow } from './competitions.js';
import {
  handleProviderOutage,
  handleQuotaPosture,
  mostRestrictive,
} from './degrade.js';
import type {
  CompetitionEntry,
  CompetitionRunResult,
  DegradeFlag,
  HourlyMatchdayInput,
  HourlyMatchdayOutput,
  WorkflowDeps,
} from './types.js';

type SweepMode = 'continue' | 'cached-only' | 'abort';

const NEXT_24H_MS = 24 * 60 * 60 * 1000;

const FIXTURES_WORKLOAD: IngestionWorkload = 'fixtures-next-7d';
const STANDINGS_WORKLOAD: IngestionWorkload = 'fixtures-next-7d';

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const fixturesNext24hPath = (competition: CompetitionEntry, nowUtc: Date): string => {
  const from = isoDate(nowUtc);
  const to = isoDate(new Date(nowUtc.getTime() + NEXT_24H_MS));
  return `/fixtures?league=${competition.apiFootballLeagueId}&season=${competition.season}&from=${from}&to=${to}`;
};

const standingsPath = (competition: CompetitionEntry): string =>
  `/standings?league=${competition.apiFootballLeagueId}&season=${competition.season}`;

export const hourlyMatchdayWorkflow = async (
  input: HourlyMatchdayInput,
  deps: WorkflowDeps
): Promise<HourlyMatchdayOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const startedAt = input.nowUtc ? new Date(input.nowUtc) : clock();

  const selectedKeys = new Set(input.competitions);
  const competitions = deps.competitions.filter(
    (competition) => selectedKeys.size === 0 || selectedKeys.has(competition.key)
  );

  const inWindow: string[] = [];
  const skipped: string[] = [];
  const inWindowCompetitions: CompetitionEntry[] = [];
  for (const competition of competitions) {
    if (isMatchdayWindow(startedAt, competition.calendar)) {
      inWindow.push(competition.key);
      inWindowCompetitions.push(competition);
    } else {
      skipped.push(competition.key);
    }
  }

  log({
    event: 'hourly_matchday.started',
    workflow: 'hourly-matchday',
    callsBudgeted: 0,
    reason: `${inWindow.length} in-window, ${skipped.length} skipped`,
  });

  if (inWindowCompetitions.length === 0) {
    const finishedAt = clock();
    log({
      event: 'hourly_matchday.no_window',
      workflow: 'hourly-matchday',
    });
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      inWindow,
      skipped,
      callsBudgeted: 0,
      callsUsed: 0,
      fixturesIngested: 0,
      competitions: [],
      degradeFlags: [],
      finalQuota: undefined,
    };
  }

  const competitionResults: CompetitionRunResult[] = [];
  const degradeFlags: DegradeFlag[] = [];
  let totalCallsBudgeted = 0;
  let totalCallsUsed = 0;
  let totalFixturesIngested = 0;
  let finalQuota: ProviderQuotaSnapshot | undefined;
  let aborted = false;

  for (const competition of inWindowCompetitions) {
    if (aborted) {
      break;
    }
    const sweep = await sweepCompetition(competition, startedAt, deps);
    competitionResults.push(sweep.summary);
    totalCallsBudgeted += sweep.summary.callsBudgeted;
    totalCallsUsed += sweep.summary.callsUsed;
    totalFixturesIngested += sweep.summary.fixturesIngested;
    finalQuota = sweep.finalQuota ?? finalQuota;
    degradeFlags.push(...sweep.flags);
    if (sweep.action === 'abort') {
      aborted = true;
      log({
        event: 'hourly_matchday.aborted',
        workflow: 'hourly-matchday',
        competition: competition.key,
        reason: 'quota hard cap',
      });
    }
  }

  const finishedAt = clock();
  log({
    event: 'hourly_matchday.finished',
    workflow: 'hourly-matchday',
    callsBudgeted: totalCallsBudgeted,
    callsUsed: totalCallsUsed,
    fixturesIngested: totalFixturesIngested,
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    inWindow,
    skipped,
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
  readonly action: SweepMode;
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

  // Standings refresh.
  const standingsResource = `standings-${competition.apiFootballLeagueId}-${competition.season}`;
  const standingsResult = await deps.ingestion.fetchWorkload({
    workload: STANDINGS_WORKLOAD,
    resourceId: standingsResource,
    path: standingsPath(competition),
  });
  mode = accumulate(standingsResult, STANDINGS_WORKLOAD, standingsResource, mode);

  if (mode === 'abort') {
    return {
      summary: {
        competition: competition.key,
        callsBudgeted,
        callsUsed,
        fixturesIngested,
        errors,
        fetches,
      },
      flags,
      action: mode,
      finalQuota: lastQuota,
    };
  }

  // Next-24h fixtures refresh.
  const fixturesResource = `next24h-${competition.apiFootballLeagueId}-${competition.season}-${isoDate(startedAt)}`;
  const fixturesResult = await deps.ingestion.fetchWorkload({
    workload: FIXTURES_WORKLOAD,
    resourceId: fixturesResource,
    path: fixturesNext24hPath(competition, startedAt),
  });
  mode = accumulate(fixturesResult, FIXTURES_WORKLOAD, fixturesResource, mode);

  if (fixturesResult.status === 'fetched' || fixturesResult.status === 'cached') {
    fixturesIngested += countFixtures(fixturesResult.data);
  }

  return {
    summary: {
      competition: competition.key,
      callsBudgeted,
      callsUsed,
      fixturesIngested,
      errors,
      fetches,
    },
    flags,
    action: mode,
    finalQuota: lastQuota,
  };
};

const countFixtures = (data: unknown): number => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return 0;
  }
  return data.response.length;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
