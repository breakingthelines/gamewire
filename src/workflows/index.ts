/**
 * Public surface for the workflow layer. Workflows are pure TS — no
 * Temporal SDK dependency. Schedules live in kernel-service which
 * POSTs to gamewire-worker HTTP endpoints at fire time.
 */
export {
  PHASE_A_COMPETITIONS,
  PHASE_A_COMPETITIONS_BY_KEY,
  isMatchdayWindow,
  phaseAVerifiedFixtureIds,
} from './competitions.js';
export type {
  CompetitionEntry,
  CompetitionRunResult,
  CompetitionRunSummary,
  DailyAnchorInput,
  DailyAnchorOutput,
  DailyAnchorWireResult,
  DegradeAction,
  DegradeFlag,
  HourlyMatchdayInput,
  HourlyMatchdayOutput,
  HourlyMatchdayWireResult,
  MatchdayCalendar,
  MatchdayWindow,
  SeasonBackfillInput,
  SeasonBackfillOutput,
  SeasonBackfillTarget,
  SeasonBackfillTargetResult,
  SeasonBackfillWireResult,
  SquadSweepInput,
  SquadSweepOutput,
  SquadSweepTeamResult,
  SquadSweepWireResult,
  StatsBombBackfillInput,
  StatsBombBackfillMatchResult,
  StatsBombBackfillOutput,
  StatsBombBackfillWireResult,
  StatsBombFetch,
  SweepMissingPayloadKind,
  SweepMissingPayloadsInput,
  SweepMissingPayloadsOutput,
  SweepMissingPayloadsWireResult,
  WebhookCompletedInput,
  WebhookCompletedOutput,
  WebhookCompletedWireResult,
  WorkflowDeps,
  WorkflowLogEntry,
  WorkflowLogger,
} from './types.js';
export {
  dailyAnchorToWire,
  hourlyMatchdayToWire,
  seasonBackfillToWire,
  squadSweepToWire,
  statsbombBackfillToWire,
  sweepMissingPayloadsToWire,
  webhookCompletedToWire,
} from './wire.js';
export {
  handleIdentityOutage,
  handleProvider5xx,
  handleProviderOutage,
  handleQuotaPosture,
  handleReepMissSpike,
  handleWebhookStall,
  mostRestrictive,
  PROVIDER_5XX_CIRCUIT_THRESHOLD,
  REEP_MISS_RATE_THRESHOLD,
} from './degrade.js';
export type { DegradeResult } from './degrade.js';
export { dailyAnchorWorkflow } from './daily-anchor.js';
export { sweepMissingPayloadsWorkflow } from './sweep-missing-payloads.js';
export { hourlyMatchdayWorkflow } from './hourly-matchday.js';
export { webhookCompletedWorkflow } from './webhook-completed.js';
export { DEFAULT_MAX_CALLS_PER_RUN, seasonBackfillWorkflow } from './season-backfill.js';
export { squadSweepWorkflow } from './squad-sweep.js';
export {
  statsbombBackfillWorkflow,
  WC2022_STATSBOMB_TO_API_FOOTBALL,
} from './statsbomb-backfill.js';
