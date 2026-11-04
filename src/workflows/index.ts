/**
 * Public surface for the workflow layer. Workflows are pure TS — no
 * Temporal SDK dependency. Schedules live in kernel-service which
 * POSTs to gamewire-worker HTTP endpoints at fire time.
 */
export {
  COMPETITIONS,
  COMPETITIONS_BY_KEY,
  LIVE_INGESTION_COMPETITIONS,
  NO_LIVE_INGESTION_ALLOWLIST,
  STEADY_STATE_COMPETITIONS,
  collectVerifiedFixtureIds,
  isMatchdayWindow,
} from './competitions.js';
export type {
  CompetitionBackfillKind,
  CompetitionEntry,
  CompetitionPayloadBackfillFixture,
  CompetitionPayloadBackfillInput,
  CompetitionPayloadBackfillOutput,
  CompetitionPayloadBackfillWireResult,
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
  IdentityGap,
  IdentityGapScanInput,
  IdentityGapScanOutput,
  IdentityGapScanWireResult,
  MatchdayCalendar,
  MatchdayWindow,
  ProviderEnrichmentDataset,
  ProviderEnrichmentDeps,
  ProviderEnrichmentInput,
  ProviderEnrichmentMode,
  ProviderEnrichmentOutput,
  ProviderEnrichmentTargetResult,
  ProviderEnrichmentWireResult,
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
  competitionPayloadBackfillToWire,
  dailyAnchorToWire,
  hourlyMatchdayToWire,
  identityGapScanToWire,
  providerEnrichmentToWire,
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
export { competitionPayloadBackfillWorkflow } from './competition-payload-backfill.js';
export { hourlyMatchdayWorkflow } from './hourly-matchday.js';
export { webhookCompletedWorkflow } from './webhook-completed.js';
export { DEFAULT_MAX_CALLS_PER_RUN, seasonBackfillWorkflow } from './season-backfill.js';
export { squadSweepWorkflow } from './squad-sweep.js';
export { statsbombBackfillWorkflow } from './statsbomb-backfill.js';
export { identityGapScanWorkflow } from './identity-gap-scan.js';
export {
  DEFAULT_ENRICHMENT_MAX_CALLS_PER_RUN,
  DEFAULT_ENRICHMENT_MINUTE_CAP,
  ENRICHMENT_CURSOR_WINDOW_SECONDS,
  ENRICHMENT_INGEST_BATCH_SIZE,
  MAX_ENRICHMENT_CALLS_PER_RUN,
  PROVIDER_ENRICHMENT_DATASETS,
  PROVIDER_ENRICHMENT_MODES,
  clampEnrichmentLimit,
  enrichmentCursorKey,
  providerEnrichmentWorkflow,
  resolveEnrichmentTargets,
} from './provider-enrichment.js';
