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
  DailyAnchorInput,
  DailyAnchorOutput,
  DegradeAction,
  DegradeFlag,
  HourlyMatchdayInput,
  HourlyMatchdayOutput,
  MatchdayCalendar,
  MatchdayWindow,
  WebhookCompletedInput,
  WebhookCompletedOutput,
  WorkflowDeps,
  WorkflowLogEntry,
  WorkflowLogger,
} from './types.js';
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
export { hourlyMatchdayWorkflow } from './hourly-matchday.js';
export { webhookCompletedWorkflow } from './webhook-completed.js';
