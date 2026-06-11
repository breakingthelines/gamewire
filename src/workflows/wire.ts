/**
 * Wire-projection boundary for the workflow layer.
 *
 * Each workflow's in-process output type may include provider-specific
 * debug detail (today: per-fetch raw provider responses on
 * `IngestionFetchResult.data`/`.fetch`). That detail must not cross
 * the NDJSON `/workflows/*` wire to kernel-service — a single trailing
 * `event: 'completed'` line carrying it can exceed kernel-side
 * `bufio.Scanner.MaxScanTokenSize` and fail the activity
 * deterministically (observed 2026-05-25 on workflow run
 * `019e57ec-…`, after the streaming change in PR #18).
 *
 * Rather than stripping by string-keyed allow/deny lists (which don't
 * scale — every future provider has its own raw-payload shape), each
 * workflow declares an explicit `toWire` projection here. The wire
 * boundary is one file, one function per workflow, type-checked end
 * to end via the `*WireResult` types in `./types.ts`. When a new
 * workflow lands, the author writes its `toWire` next to the others.
 */
import type {
  CompetitionRunResult,
  CompetitionRunSummary,
  DailyAnchorOutput,
  DailyAnchorWireResult,
  HourlyMatchdayOutput,
  HourlyMatchdayWireResult,
  SeasonBackfillOutput,
  SeasonBackfillWireResult,
  SquadSweepOutput,
  SquadSweepWireResult,
  SweepMissingPayloadsOutput,
  SweepMissingPayloadsWireResult,
  WebhookCompletedOutput,
  WebhookCompletedWireResult,
} from './types.js';

const toCompetitionRunSummary = (competition: CompetitionRunResult): CompetitionRunSummary => ({
  competition: competition.competition,
  callsBudgeted: competition.callsBudgeted,
  callsUsed: competition.callsUsed,
  fixturesIngested: competition.fixturesIngested,
  errors: competition.errors,
});

export const dailyAnchorToWire = (output: DailyAnchorOutput): DailyAnchorWireResult => ({
  startedAt: output.startedAt,
  finishedAt: output.finishedAt,
  callsBudgeted: output.callsBudgeted,
  callsUsed: output.callsUsed,
  fixturesIngested: output.fixturesIngested,
  competitions: output.competitions.map(toCompetitionRunSummary),
  degradeFlags: output.degradeFlags,
  finalQuota: output.finalQuota,
});

export const hourlyMatchdayToWire = (output: HourlyMatchdayOutput): HourlyMatchdayWireResult => ({
  startedAt: output.startedAt,
  finishedAt: output.finishedAt,
  inWindow: output.inWindow,
  skipped: output.skipped,
  callsBudgeted: output.callsBudgeted,
  callsUsed: output.callsUsed,
  fixturesIngested: output.fixturesIngested,
  competitions: output.competitions.map(toCompetitionRunSummary),
  degradeFlags: output.degradeFlags,
  finalQuota: output.finalQuota,
});

export const webhookCompletedToWire = (
  output: WebhookCompletedOutput
): WebhookCompletedWireResult => ({
  fixtureId: output.fixtureId,
  providerId: output.providerId,
  status: output.status,
  degradeFlags: output.degradeFlags,
  reason: output.reason,
  finalQuota: output.finalQuota,
});

/**
 * Season-backfill output is already summary-shaped (per-target counters,
 * no raw provider payloads), so the projection is a structural copy. It
 * exists to hold the one-projection-per-workflow invariant and to pin
 * the wire contract independently of the in-process type.
 */
export const seasonBackfillToWire = (output: SeasonBackfillOutput): SeasonBackfillWireResult => ({
  startedAt: output.startedAt,
  finishedAt: output.finishedAt,
  status: output.status,
  callsBudgeted: output.callsBudgeted,
  callsUsed: output.callsUsed,
  fixturesProcessed: output.fixturesProcessed,
  targets: output.targets,
  degradeFlags: output.degradeFlags,
  finalQuota: output.finalQuota,
});

/**
 * Squad-sweep output drops the per-team `teams` list at the wire boundary.
 * A full Phase A sweep (~120 teams) produces one entry per team; that list
 * is too large for a single NDJSON line without risking kernel-side scanner
 * buffer overflow. Per-team detail remains available via the streamed logger
 * events (each line is bounded in size).
 */
export const squadSweepToWire = (output: SquadSweepOutput): SquadSweepWireResult => ({
  startedAt: output.startedAt,
  finishedAt: output.finishedAt,
  status: output.status,
  teamsDiscovered: output.teamsDiscovered,
  teamsOk: output.teamsOk,
  teamsFailed: output.teamsFailed,
  teamsSkipped: output.teamsSkipped,
  callsUsed: output.callsUsed,
  degradeFlags: output.degradeFlags,
  finalQuota: output.finalQuota,
  dryRun: output.dryRun,
});

/**
 * Sweep-missing-payloads output drops the long-tail `errors` list at the
 * wire boundary. A 500-fixture run with every fetch failing would generate
 * hundreds of error strings (`team-match-stats:<fixtureId>:<provider-msg>`);
 * folded into a single trailing NDJSON line that can exceed kernel-side
 * `bufio.Scanner.MaxScanTokenSize` and fail the activity deterministically
 * (same failure mode 2026-05-25 fix addressed for daily-anchor). Per-fixture
 * error detail remains available via the streamed logger events.
 */
export const sweepMissingPayloadsToWire = (
  output: SweepMissingPayloadsOutput
): SweepMissingPayloadsWireResult => ({
  startedAt: output.startedAt,
  finishedAt: output.finishedAt,
  providerId: output.providerId,
  kind: output.kind,
  fixturesDiscovered: output.fixturesDiscovered,
  fixturesProcessed: output.fixturesProcessed,
  fixturesOk: output.fixturesOk,
  fixturesSkipped: output.fixturesSkipped,
  fixturesFailed: output.fixturesFailed,
  callsUsed: output.callsUsed,
  status: output.status,
  degradeFlags: output.degradeFlags,
  finalQuota: output.finalQuota,
  dryRun: output.dryRun,
  reason: output.reason,
});
