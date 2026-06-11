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
import type {
  FootballGameIngestClient,
  FootballGameMissingPayloadsClient,
} from '../worker/clients/game-service.js';
import type { FootballIdentityLookupClient } from '../worker/clients/identity.js';
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
    | 'provider-rate-limited'
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
  /**
   * Optional game-service client used by {@link sweepMissingPayloadsWorkflow}
   * to enumerate finished games whose specified payload was never ingested.
   * Wired in `worker/server.ts` from the same gRPC transport that backs
   * the match-concluded bridge. When unset, the sweep workflow requires
   * an explicit `fixtureIds` list (ops one-shot mode) instead of paging
   * the RPC.
   */
  readonly gameServiceMissingPayloads?: FootballGameMissingPayloadsClient;
  /**
   * Game-service ingest client used by {@link squadSweepWorkflow} to push
   * standing squad rosters via IngestFootballSquadLists. Wired in
   * `worker/server.ts` from the same gRPC transport used for the bridge.
   * When unset, squad ingest calls are skipped (teams are still enumerated
   * and provider-fetched, but not written to game-service).
   */
  readonly gameService?: FootballGameIngestClient;
  /**
   * Identity-server lookup client used by {@link squadSweepWorkflow} to
   * resolve provider team ids to canonical btl_football_team_* ids before
   * ingesting a standing squad list. Wired in `worker/server.ts`. When
   * unset, the canonical_team_id field is left empty in the ingested row
   * (game-service still stores the roster keyed by provider id and
   * resolves it at read time).
   */
  readonly identity?: FootballIdentityLookupClient;
}

export interface WorkflowLogEntry {
  readonly event: string;
  readonly workflow:
    | 'daily-anchor'
    | 'hourly-matchday'
    | 'webhook-completed'
    | 'season-backfill'
    | 'sweep-missing-payloads'
    | 'squad-sweep';
  readonly competition?: string;
  readonly season?: number;
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

/**
 * A single competition+season the backfill should import. Either a
 * catalogue `competitionKey` (resolved against `deps.competitions`) or
 * an explicit `apiFootballLeagueId` is required; `season` is always
 * required so the same competition can be backfilled across multiple
 * seasons (current + recent) without catalogue edits.
 *
 * When both `competitionKey` and `apiFootballLeagueId` are present the
 * explicit league id wins (the key is then used only as the human label
 * + cursor namespace component).
 */
export interface SeasonBackfillTarget {
  readonly competitionKey?: string;
  readonly apiFootballLeagueId?: number;
  readonly season: number;
}

export interface SeasonBackfillInput {
  /**
   * Explicit list of competition+season targets. When omitted, the
   * workflow expands `deps.competitions` (the Phase A catalogue by
   * default) across {@link SeasonBackfillInput.seasons}.
   */
  readonly targets?: readonly SeasonBackfillTarget[];
  /**
   * Seasons to expand `deps.competitions` over when `targets` is
   * omitted. Defaults to each competition's catalogue `season` only.
   * Example: `[2024, 2025]` backfills the recent + current season for
   * every Phase A competition.
   */
  readonly seasons?: readonly number[];
  /**
   * Subset of competition keys to include when expanding the catalogue.
   * Ignored when `targets` is supplied. Empty/omitted means all.
   */
  readonly competitions?: readonly string[];
  /**
   * Hard ceiling on provider calls this run may budget before
   * checkpointing and returning `incomplete`. This is the per-run
   * throttle that keeps a single backfill invocation from draining the
   * shared daily provider quota and starving the live ingestion loops.
   * The {@link ProviderQuotaTracker} hard cap (70k/day) remains the
   * absolute backstop. Defaults to {@link DEFAULT_MAX_CALLS_PER_RUN}.
   */
  readonly maxCallsPerRun?: number;
  /**
   * When true, discard any persisted cursor and re-discover the full
   * season fixture list from scratch. The ingest path stays idempotent
   * either way (game-service upserts + emit-once gate); this only
   * controls cursor reuse. Defaults to false (resume).
   */
  readonly reset?: boolean;
  /** ISO-8601 instant used as "now" for fetch metadata. Defaults to clock. */
  readonly nowUtc?: string;
}

export interface SeasonBackfillTargetResult {
  /** Human label, e.g. `premier-league:2024` or `league-39:2024`. */
  readonly target: string;
  readonly competition?: string;
  readonly apiFootballLeagueId: number;
  readonly season: number;
  /** Total finalised fixtures discovered for the season. */
  readonly fixturesDiscovered: number;
  /** Fixtures whose detail/events/lineups were touched this run. */
  readonly fixturesProcessed: number;
  /** Cursor index reached this run (next run resumes here). */
  readonly cursorIndex: number;
  /** True once every discovered fixture has been processed. */
  readonly complete: boolean;
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly errors: readonly string[];
}

export interface SeasonBackfillOutput {
  readonly startedAt: string;
  readonly finishedAt: string;
  /** `complete` when every target finished; `incomplete` when the run hit the call budget or a quota posture and checkpointed for resume; `aborted` on hard cap. */
  readonly status: 'complete' | 'incomplete' | 'aborted';
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesProcessed: number;
  readonly targets: readonly SeasonBackfillTargetResult[];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}

/**
 * NDJSON `event: 'completed'` payload for the season-backfill workflow.
 * The in-process {@link SeasonBackfillOutput} is already summary-shaped
 * (no raw `fetches`/`data` arrays are retained — backfill walks a full
 * season and would otherwise accumulate hundreds of MB), so the wire
 * type is structurally identical. It is declared explicitly to keep the
 * one-projection-per-workflow invariant in `wire.ts` and to pin the wire
 * contract independently of the in-process type if the latter grows
 * debug detail later.
 */
export interface SeasonBackfillWireResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: 'complete' | 'incomplete' | 'aborted';
  readonly callsBudgeted: number;
  readonly callsUsed: number;
  readonly fixturesProcessed: number;
  readonly targets: readonly SeasonBackfillTargetResult[];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
}

/**
 * Payload kinds the sweep workflow can backfill. Each maps 1:1 to a single
 * provider-facing workload (no batch detail re-fetch) so the call budget
 * is the smallest possible per fixture.
 */
export type SweepMissingPayloadKind =
  | 'team-match-stats'
  | 'player-match-stats'
  | 'events'
  | 'lineups';

export interface SweepMissingPayloadsInput {
  /** Provider id (e.g. `'api-football'`). Other providers are skipped today. */
  readonly providerId: string;
  /** Which payload kind to sweep. */
  readonly kind: SweepMissingPayloadKind;
  /** Maximum number of fixtures to process this run. Defaults to 100, max 500. */
  readonly limit?: number;
  /** ISO-8601 lower bound on scheduled_start_at. */
  readonly since?: string;
  /** ISO-8601 upper bound on scheduled_start_at. */
  readonly until?: string;
  /** When true, enumerate but skip the per-fixture provider call. */
  readonly dryRun?: boolean;
  /**
   * Optional explicit provider-fixture-id list. When set, the workflow skips
   * the game-service RPC and just iterates the provided ids; useful for ops
   * one-shot runs (`curl /workflows/sweep-missing-payloads ... {"fixtureIds":["1538961"]}`).
   */
  readonly fixtureIds?: readonly string[];
  /** ISO-8601 instant used as "now" for fetch metadata. Defaults to clock. */
  readonly nowUtc?: string;
  /**
   * Override the per-fixture inter-call delay in milliseconds. When unset the
   * workflow reads `SWEEP_INTER_CALL_DELAY_MS` from the environment, falling
   * back to 200ms (≈5 RPS, well under api-football's per-minute cap). Tests
   * inject `0` to keep mocked sweeps sub-second; ops can dial it lower for
   * higher-tier provider keys.
   */
  readonly intercallDelayMs?: number;
}

export interface SweepMissingPayloadsOutput {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly providerId: string;
  readonly kind: SweepMissingPayloadKind;
  readonly fixturesDiscovered: number;
  readonly fixturesProcessed: number;
  readonly fixturesOk: number;
  readonly fixturesSkipped: number;
  readonly fixturesFailed: number;
  readonly callsUsed: number;
  readonly status: 'completed' | 'partial' | 'aborted' | 'skipped';
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
  readonly errors: readonly string[];
  readonly dryRun: boolean;
  readonly reason?: string;
}

/**
 * NDJSON `event: 'completed'` payload for the sweep-missing-payloads workflow.
 * The in-process output is already summary-shaped (no raw `fetches` array is
 * retained — sweeps walk thousands of fixtures and would otherwise OOM the
 * scanner buffer). The wire type drops the long-tail `errors` list so a
 * single trailing line stays well under kernel-side
 * `bufio.Scanner.MaxScanTokenSize` even on a 500-fixture run; per-fixture
 * detail remains available via gamewire-worker logger events (each NDJSON
 * line being its own bounded chunk).
 */
export interface SweepMissingPayloadsWireResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly providerId: string;
  readonly kind: SweepMissingPayloadKind;
  readonly fixturesDiscovered: number;
  readonly fixturesProcessed: number;
  readonly fixturesOk: number;
  readonly fixturesSkipped: number;
  readonly fixturesFailed: number;
  readonly callsUsed: number;
  readonly status: SweepMissingPayloadsOutput['status'];
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
  readonly dryRun: boolean;
  readonly reason?: string;
}

// ── Squad Sweep ───────────────────────────────────────────────────────────────

/**
 * Input for the squad-sweep workflow. All fields are optional; with an empty
 * body the workflow sweeps every team known from the cached fixture envelopes.
 */
export interface SquadSweepInput {
  /**
   * Explicit list of API-Football provider team ids to sweep. When omitted
   * the workflow enumerates all teams known from the cached
   * `api-football:fixtures-next-7d:<key>` Redis entries.
   */
  readonly teamIds?: readonly string[];
  /**
   * Maximum number of teams to process per run. Defaults to 500. A full
   * Phase A sweep is ~120 teams; 500 handles the full WC + qualifier
   * universe in one shot.
   */
  readonly maxTeamsPerRun?: number;
  /**
   * Per-team inter-call delay in milliseconds. Defaults to the
   * `SQUAD_SWEEP_INTER_CALL_DELAY_MS` environment variable or 200ms.
   * Pass 0 in tests.
   */
  readonly intercallDelayMs?: number;
  /**
   * When true, enumerate and resolve teams but skip the provider fetch and
   * game-service ingest. Useful to preview the team set without spending
   * API quota.
   */
  readonly dryRun?: boolean;
  /** ISO-8601 instant used as "now" for fetch metadata. Defaults to clock. */
  readonly nowUtc?: string;
}

/** Per-team result in a squad sweep run. */
export interface SquadSweepTeamResult {
  readonly providerTeamId: string;
  readonly canonicalTeamId: string;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly reason?: string;
  readonly acceptedCount?: number;
  readonly updatedCount?: number;
}

export interface SquadSweepOutput {
  readonly startedAt: string;
  readonly finishedAt: string;
  /** `completed` = all teams attempted with no failures; `partial` = some failures; `aborted` = hard-cap or circuit-open. */
  readonly status: 'completed' | 'partial' | 'aborted';
  readonly teamsDiscovered: number;
  readonly teamsOk: number;
  readonly teamsFailed: number;
  readonly teamsSkipped: number;
  readonly callsUsed: number;
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
  /** Per-team result list. Dropped at the wire boundary to stay under NDJSON scanner limits. */
  readonly teams: readonly SquadSweepTeamResult[];
  readonly dryRun: boolean;
}

/**
 * NDJSON `event: 'completed'` payload for the squad-sweep workflow.
 * The per-team `teams` list is dropped at the wire boundary so a large sweep
 * cannot exceed kernel-side `bufio.Scanner.MaxScanTokenSize`; per-team detail
 * remains available via the streamed logger events.
 */
export interface SquadSweepWireResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: SquadSweepOutput['status'];
  readonly teamsDiscovered: number;
  readonly teamsOk: number;
  readonly teamsFailed: number;
  readonly teamsSkipped: number;
  readonly callsUsed: number;
  readonly degradeFlags: readonly DegradeFlag[];
  readonly finalQuota: ProviderQuotaSnapshot | undefined;
  readonly dryRun: boolean;
}
