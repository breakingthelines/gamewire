import type { GamewireWorkerConfig } from './config.js';
import { ProviderMinuteLimiter, type MinuteCounterStore } from './minute-limiter.js';
import { ProviderQuotaTracker, type ProviderQuotaStore } from './quota.js';

export interface ProviderBudget {
  readonly quota: ProviderQuotaTracker;
  readonly minuteLimiter: ProviderMinuteLimiter;
  /** One boot log line with the effective caps. */
  readonly summary: string;
  /** Boot warnings, for example a hard cap above the plan ceiling. */
  readonly warnings: readonly string[];
}

export interface ProviderBudgetOptions {
  readonly quotaStore?: ProviderQuotaStore;
  readonly minuteStore?: MinuteCounterStore;
  readonly logger?: (entry: Record<string, unknown>) => void;
  /** Test clocks. */
  readonly clock?: () => Date;
  readonly minuteClock?: () => number;
}

/**
 * Build the daily quota tracker and the per-minute limiter from the loaded
 * config. `server.ts` uses this so every env cap reaches the tracker and the
 * limiter: before GW-1 the tracker was built inside the ingestion loop with no
 * caps, so `GAMEWIRE_PROVIDER_HARD_CAP` and `SOFT_CAP` were logged and ignored.
 */
export function createProviderBudget(
  config: GamewireWorkerConfig,
  options: ProviderBudgetOptions = {}
): ProviderBudget {
  const quota = new ProviderQuotaTracker({
    provider: config.providerId,
    store: options.quotaStore,
    hardCap: config.providerHardCap,
    softCap: config.providerSoftCap,
    backgroundDailyCap: config.providerBackgroundDailyCap,
    quotaSource: config.providerQuotaSource,
    clock: options.clock,
    logger: options.logger,
  });
  // One worker replica (see the prod deployment), so the in-memory counter is
  // the whole picture for this process. Other spenders on the key are counted
  // through the provider headers when GAMEWIRE_PROVIDER_QUOTA_SOURCE=provider-header.
  const minuteLimiter = new ProviderMinuteLimiter({
    providerId: config.providerId,
    namespace: config.redisNamespace,
    caps: config.providerMinuteCaps,
    store: options.minuteStore,
    clock: options.minuteClock,
    smoothBackground: true,
  });
  const summary =
    `[gamewire-worker] provider budget hardCap=${config.providerHardCap} ` +
    `softCap=${config.providerSoftCap} backgroundDailyCap=${quota.backgroundDailyCap} ` +
    `planCeiling=${config.providerPlanCeiling} quotaSource=${quota.quotaSource} ` +
    `minuteCaps=live:${minuteLimiter.caps.live},near-live:${minuteLimiter.caps['near-live']},` +
    `background:${minuteLimiter.caps.background} ` +
    `backgroundPerSecond=${minuteLimiter.backgroundSecondCap} minuteStore=${minuteLimiter.backend} ` +
    `requestTimeoutMs=${config.providerRequestTimeoutMs}`;
  const warnings: string[] = [];
  if (
    config.providerPlanCeiling !== undefined &&
    config.providerHardCap > config.providerPlanCeiling
  ) {
    warnings.push(
      `[gamewire-worker] WARNING hard cap ${config.providerHardCap} exceeds plan ceiling ` +
        `${config.providerPlanCeiling}; set GAMEWIRE_PROVIDER_PLAN_CEILING to the plan size`
    );
  }
  return { quota, minuteLimiter, summary, warnings };
}
