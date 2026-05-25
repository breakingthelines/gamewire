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
