/**
 * Backfill workflow types.
 *
 * The workflow layer is pure TypeScript with no Temporal SDK
 * dependency. Schedules live in kernel-service (Go Temporal worker);
 * fire-time POSTs hit the gamewire-worker HTTP endpoints defined in
 * `worker/http.ts`, which deserialise the body and dispatch to the
 * workflow functions in this directory.
 *
 * The seven failure-mode degradations are encoded as a `DegradeAction`
 * enum returned by each handler in `degrade.ts`; workflows act on the
 * action rather than implementing their own posture switching.
 */
import type { ApiFootballIngestionLoop, IngestionFetchResult } from '../worker/ingestion.js';
import type { OnFixtureFetched } from '../worker/match-concluded-bridge.js';
import type { MatchConcludedPublisher } from '../worker/match-concluded-publisher.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';

/**
 * Calendar window for matchday detection. UTC weekday is 0-6 where
 * Sunday is 0 (matches `Date.getUTCDay`). Hours are an inclusive-start,
 * exclusive-end pair in UTC.
 */
export interface MatchdayWindow {
  readonly utcWeekday: number;
  readonly utcHourStart: number;
  readonly utcHourEnd: number;
}

export type MatchdayCalendar = readonly MatchdayWindow[];

export interface CompetitionEntry {
  /** Short kebab key, e.g. `'premier-league'`. Stable across season changes. */
  readonly key: string;
  readonly label: string;
  readonly apiFootballLeagueId: number;
  readonly season: number;
  readonly calendar: MatchdayCalendar;
  readonly tier: 'domestic' | 'international';
}

export type DegradeAction =
  | 'continue'
  | 'skip-non-essential'
  | 'cached-only'
  | 'abort'
  | 'circuit-open';

export interface DegradeFlag {
  readonly trigger:
    | 'soft-cap'
    | 'hard-cap'
    | 'reep-miss-spike'
    | 'provider-5xx'
    | 'webhook-stall'
    | 'provider-outage'
    | 'identity-outage';
  readonly action: DegradeAction;
  readonly detail?: string;
}

/**
 * Dependencies that workflow functions need at runtime. Constructed in
 * `worker/server.ts` from the already-wired ingestion loop, publisher,
 * identity client, and game-service client. Passed as the second
 * argument to each workflow so workflows stay pure with respect to
 * module-level singletons.
 */
export interface WorkflowDeps {
  readonly ingestion: ApiFootballIngestionLoop;
  readonly publisher?: MatchConcludedPublisher;
  readonly onFixtureFetched?: OnFixtureFetched;
  readonly competitions: readonly CompetitionEntry[];
  readonly clock?: () => Date;
  readonly logger?: WorkflowLogger;
}

export interface WorkflowLogEntry {
  readonly event: string;
  readonly workflow: 'daily-anchor' | 'hourly-matchday' | 'webhook-completed';
  readonly competition?: string;
  readonly fixtureId?: string;
  readonly workload?: string;
  readonly status?: string;
  readonly callsBudgeted?: number;
  readonly callsUsed?: number;
  readonly fixturesIngested?: number;
  readonly degrade?: DegradeFlag['trigger'];
  readonly action?: DegradeAction;
  readonly reason?: string;
  readonly message?: string;
}

export type WorkflowLogger = (entry: WorkflowLogEntry) => void;

export interface CompetitionRunResult {
  readonly competition: string;
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesIngested: number;
  readonly errors: readonly string[];
  readonly fetches: readonly IngestionFetchResult[];
}

export interface DailyAnchorInput {
  /** ISO-8601 instant used as "now" for fixture window calculations. Defaults to clock. */
  readonly nowUtc?: string;
  /** Optional subset of competition keys; defaults to all entries in deps.competitions. */
  readonly competitions?: readonly string[];
}

export interface DailyAnchorOutput {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesIngested: number;
  readonly competitions: readonly CompetitionRunResult[];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}

export interface HourlyMatchdayInput {
  readonly nowUtc?: string;
  readonly competitions?: readonly string[];
}

export interface HourlyMatchdayOutput {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly inWindow: readonly string[];
  readonly skipped: readonly string[];
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesIngested: number;
  readonly competitions: readonly CompetitionRunResult[];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}

export interface WebhookCompletedInput {
  readonly providerId: string;
  readonly fixtureId: string;
  readonly nowUtc?: string;
}

export interface WebhookCompletedOutput {
  readonly fixtureId: string;
  readonly providerId: string;
  readonly status: 'completed' | 'skipped' | 'failed';
  readonly fetches: readonly IngestionFetchResult[];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly reason?: string;
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}

/**
 * Wire-facing summary of a single competition run. Drops `fetches`
 * (raw `IngestionFetchResult` array carrying provider responses) which
 * is in-process debug detail; kernel-service only needs the totals and
 * the competition key. See `workflows/wire.ts` for the projection.
 */
export interface CompetitionRunSummary {
  readonly competition: string;
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesIngested: number;
  readonly errors: readonly string[];
}

/**
 * NDJSON `event: 'completed'` payload for the daily-anchor workflow.
 *
 * The full {@link DailyAnchorOutput} embeds per-competition `fetches`
 * arrays whose entries carry raw provider responses (`data`/`fetch`,
 * hundreds of KB each on cold-cache). Aggregated across a Phase A
 * sweep (15 competitions) the single trailing wire line otherwise
 * exceeds kernel-side `bufio.Scanner.MaxScanTokenSize` and fails the
 * activity deterministically. The wire type strips that detail at the
 * workflow boundary; kernel sees only the summary it actually
 * consumes. Per-fetch detail remains available via gamewire-worker
 * logger events (themselves streamed as individual NDJSON lines, each
 * bounded in size).
 */
export interface DailyAnchorWireResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesIngested: number;
  readonly competitions: readonly CompetitionRunSummary[];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}

/**
 * NDJSON `event: 'completed'` payload for the hourly-matchday
 * workflow. Same trimming rationale as {@link DailyAnchorWireResult};
 * the in-window/skipped lists and totals are preserved.
 */
export interface HourlyMatchdayWireResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly inWindow: readonly string[];
  readonly skipped: readonly string[];
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesIngested: number;
  readonly competitions: readonly CompetitionRunSummary[];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}

/**
 * NDJSON `event: 'completed'` payload for the webhook-completed
 * workflow. Drops the top-level `fetches` array; everything else on
 * {@link WebhookCompletedOutput} is summary-shaped and remains.
 */
export interface WebhookCompletedWireResult {
  readonly fixtureId: string;
  readonly providerId: string;
  readonly status: 'completed' | 'skipped' | 'failed';
  readonly degradeFlags: readonly DegradeFlag[];
  readonly reason?: string;
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}
