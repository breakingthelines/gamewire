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
  /**
   * Provider fixture IDs known to be safe for the verified-rotation
   * bootstrap. The worker seeds these into its ingestion loop on boot
   * (alongside any `GAMEWIRE_BOOTSTRAP_FIXTURE_IDS` overrides) so
   * staging smoke tests touch the full launch-competition set without
   * waiting for the next /fixtures discovery tick.
   *
   * Today only Premier League has an anchor (`1538961`); the rest of
   * the launch set is staged here as empty arrays so operators can
   * curate one verified fixture per competition as IDs are recorded
   * against live data without touching workflow code.
   */
  readonly verifiedFixtureIds?: readonly string[];
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
