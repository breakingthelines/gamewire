/**
 * Webhook-completed workflow.
 *
 * API-Football has no real-time push for match-concluded; this
 * workflow is invoked by the 15-minute Temporal Schedule sweep (and
 * any future webhook bridge) for fixtures past kickoff with no
 * emitted match-concluded fact. It pulls the three workloads the
 * bridge needs:
 *
 *   1. `fixture-detail-fullTime`  → status + scoreline.
 *   2. `events-post-final`        → goals/cards/subs timeline.
 *   3. `lineups-post-confirm`     → starting XI + substitutions.
 *
 * The ingestion loop's internal bridge wiring (`OnFixtureFetched`)
 * does the resolve + ingest + emit automatically when these
 * workloads land. Idempotency is owned by `RedisEmittedFixtureStore`
 * inside the publisher, so re-runs are safe — they'll either short
 * the bridge at the emit-once gate or no-op via the cache.
 */
import { apiFootballFixturePath } from '../adapters/api-football/index.js';
import type { IngestionFetchResult, IngestionWorkload } from '../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { handleProviderOutage, handleQuotaPosture, mostRestrictive } from './degrade.js';
import type {
  DegradeAction,
  DegradeFlag,
  WebhookCompletedInput,
  WebhookCompletedOutput,
  WorkflowDeps,
} from './types.js';

const FIXTURE_DETAIL_WORKLOAD: IngestionWorkload = 'fixture-detail-fullTime';
const EVENTS_WORKLOAD: IngestionWorkload = 'events-post-final';
const LINEUPS_WORKLOAD: IngestionWorkload = 'lineups-post-confirm';

export const webhookCompletedWorkflow = async (
  input: WebhookCompletedInput,
  deps: WorkflowDeps
): Promise<WebhookCompletedOutput> => {
  const log = deps.logger ?? (() => undefined);

  const fetches: IngestionFetchResult[] = [];
  const flags: DegradeFlag[] = [];
  const errors: string[] = [];
  let lastQuota: ProviderQuotaSnapshot | undefined;
  let mode: DegradeAction = 'continue' as DegradeAction;

  const accumulate = (
    result: IngestionFetchResult,
    workload: IngestionWorkload,
    currentMode: DegradeAction
  ): DegradeAction => {
    fetches.push(result);
    if (result.error) {
      errors.push(`${workload}:${input.fixtureId}:${result.error.message}`);
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
    return mostRestrictive([
      currentMode,
      quotaResult.action,
      result.fallbackReason === 'PROVIDER_OUTAGE' ? 'cached-only' : 'continue',
    ]);
  };

  log({
    event: 'webhook_completed.started',
    workflow: 'webhook-completed',
    fixtureId: input.fixtureId,
  });

  if (input.providerId !== '' && input.providerId !== 'api-football') {
    log({
      event: 'webhook_completed.skipped',
      workflow: 'webhook-completed',
      fixtureId: input.fixtureId,
      reason: `unsupported provider ${input.providerId}`,
    });
    return {
      fixtureId: input.fixtureId,
      providerId: input.providerId,
      status: 'skipped',
      fetches,
      degradeFlags: flags,
      reason: `unsupported provider ${input.providerId}`,
      finalQuota: undefined,
    };
  }

  // Fixture detail.
  const detailResult = await deps.ingestion.fetchWorkload({
    workload: FIXTURE_DETAIL_WORKLOAD,
    resourceId: input.fixtureId,
    path: apiFootballFixturePath(input.fixtureId),
  });
  mode = accumulate(detailResult, FIXTURE_DETAIL_WORKLOAD, mode);

  if (mode === 'abort') {
    return finalize(input, fetches, flags, 'failed', lastQuota, 'aborted at fixture detail');
  }

  // Events timeline.
  const eventsResult = await deps.ingestion.fetchWorkload({
    workload: EVENTS_WORKLOAD,
    resourceId: input.fixtureId,
  });
  mode = accumulate(eventsResult, EVENTS_WORKLOAD, mode);

  if (mode === 'abort') {
    return finalize(input, fetches, flags, 'failed', lastQuota, 'aborted at events');
  }

  // Lineups confirmation.
  const lineupsResult = await deps.ingestion.fetchWorkload({
    workload: LINEUPS_WORKLOAD,
    resourceId: input.fixtureId,
  });
  mode = accumulate(lineupsResult, LINEUPS_WORKLOAD, mode);

  const allFailed = fetches.every(
    (result) => result.status === 'failed' || result.status === 'denied' || result.status === 'skipped'
  );
  const status: WebhookCompletedOutput['status'] = allFailed ? 'failed' : 'completed';
  const reason = allFailed ? errors.join('; ') || 'all fetches failed' : undefined;

  log({
    event: 'webhook_completed.finished',
    workflow: 'webhook-completed',
    fixtureId: input.fixtureId,
    status,
  });

  return {
    fixtureId: input.fixtureId,
    providerId: input.providerId,
    status,
    fetches,
    degradeFlags: flags,
    reason,
    finalQuota: lastQuota,
  };
};

const finalize = (
  input: WebhookCompletedInput,
  fetches: readonly IngestionFetchResult[],
  flags: readonly DegradeFlag[],
  status: WebhookCompletedOutput['status'],
  finalQuota: ProviderQuotaSnapshot | undefined,
  reason: string
): WebhookCompletedOutput => ({
  fixtureId: input.fixtureId,
  providerId: input.providerId,
  status,
  fetches,
  degradeFlags: flags,
  reason,
  finalQuota,
});
