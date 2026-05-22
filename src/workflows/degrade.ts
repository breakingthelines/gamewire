/**
 * Seven failure-mode degradations from `.planning/onboarding-launch/plans/backfill-cadence.md`.
 *
 * Each handler is a pure function that consumes a single observation
 * (quota snapshot, miss rate, error count, ...) and returns the
 * action the workflow should take. Workflows act on the action;
 * they do not implement posture switching themselves.
 *
 *   normal               -> 'continue'
 *   soft cap reached     -> 'cached-only'
 *   hard cap reached     -> 'abort'
 *   reep miss spike      -> 'skip-non-essential' (resolver chain still works)
 *   provider 5xx burst   -> 'circuit-open' (caller backs off)
 *   webhook stall        -> 'continue' (poller picks up the slack)
 *   provider outage      -> 'cached-only'
 *   identity outage      -> 'skip-non-essential'
 *
 * Each handler also returns a `DegradeFlag` (with optional detail
 * string) which the workflow aggregates into its output, so the
 * operator sees exactly why the workflow degraded and when.
 */
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import type { DegradeAction, DegradeFlag } from './types.js';

export interface DegradeResult {
  readonly action: DegradeAction;
  readonly flag?: DegradeFlag;
}

const CONTINUE: DegradeResult = { action: 'continue' };

export const handleQuotaPosture = (snapshot: ProviderQuotaSnapshot): DegradeResult => {
  if (snapshot.posture === 'hard_cap_reached') {
    return {
      action: 'abort',
      flag: {
        trigger: 'hard-cap',
        action: 'abort',
        detail: `${snapshot.calls}/${snapshot.hardCap} calls used`,
      },
    };
  }
  if (snapshot.posture === 'soft_cap_reached' || snapshot.cachedOnlyMode) {
    return {
      action: 'cached-only',
      flag: {
        trigger: 'soft-cap',
        action: 'cached-only',
        detail: `${snapshot.calls}/${snapshot.softCap} soft cap reached`,
      },
    };
  }
  return CONTINUE;
};

/**
 * Spike threshold: more than 25% of identity lookups in a tick missed
 * the cache and the snapshot stays. Below the threshold, the resolver
 * chain still does its job through fallbacks, so workflows continue.
 */
export const REEP_MISS_RATE_THRESHOLD = 0.25;

export const handleReepMissSpike = (input: {
  readonly totalLookups: number;
  readonly missedLookups: number;
}): DegradeResult => {
  if (input.totalLookups === 0) {
    return CONTINUE;
  }
  const rate = input.missedLookups / input.totalLookups;
  if (rate < REEP_MISS_RATE_THRESHOLD) {
    return CONTINUE;
  }
  return {
    action: 'skip-non-essential',
    flag: {
      trigger: 'reep-miss-spike',
      action: 'skip-non-essential',
      detail: `${(rate * 100).toFixed(1)}% identity miss rate (${input.missedLookups}/${input.totalLookups})`,
    },
  };
};

/** Three consecutive 5xx responses opens the circuit for this tick. */
export const PROVIDER_5XX_CIRCUIT_THRESHOLD = 3;

export const handleProvider5xx = (input: { readonly consecutive5xx: number }): DegradeResult => {
  if (input.consecutive5xx < PROVIDER_5XX_CIRCUIT_THRESHOLD) {
    return CONTINUE;
  }
  return {
    action: 'circuit-open',
    flag: {
      trigger: 'provider-5xx',
      action: 'circuit-open',
      detail: `${input.consecutive5xx} consecutive 5xx responses from provider`,
    },
  };
};

/**
 * Webhook stall: API-Football has no webhook, so this guards the
 * scheduled fallback path. If the fallback hasn't run within
 * `staleMs`, the workflow continues but emits a flag so the operator
 * sees the stall in the run output. Stall is not fatal: the polling
 * cadence still sweeps fixtures.
 */
export const handleWebhookStall = (input: {
  readonly staleMs: number;
  readonly thresholdMs: number;
}): DegradeResult => {
  if (input.staleMs <= input.thresholdMs) {
    return CONTINUE;
  }
  return {
    action: 'continue',
    flag: {
      trigger: 'webhook-stall',
      action: 'continue',
      detail: `webhook fallback ${input.staleMs}ms stale (threshold ${input.thresholdMs}ms)`,
    },
  };
};

/**
 * Provider outage: when `IngestionFetchResult.fallbackReason ===
 * 'PROVIDER_OUTAGE'` we know the loop already flipped to cached-only.
 * The workflow mirrors that into the run output.
 */
export const handleProviderOutage = (input: {
  readonly fallbackReason?: 'PROVIDER_OUTAGE';
}): DegradeResult => {
  if (input.fallbackReason !== 'PROVIDER_OUTAGE') {
    return CONTINUE;
  }
  return {
    action: 'cached-only',
    flag: {
      trigger: 'provider-outage',
      action: 'cached-only',
      detail: 'ingestion loop reported PROVIDER_OUTAGE',
    },
  };
};

/**
 * Identity-service unreachable: workflow keeps fetching provider data
 * (so the cache stays warm) but tells callers to skip non-essential
 * crosswalk lookups. game-service still receives raw provider
 * payloads via the bridge.
 */
export const handleIdentityOutage = (input: {
  readonly identityErrors: number;
}): DegradeResult => {
  if (input.identityErrors === 0) {
    return CONTINUE;
  }
  return {
    action: 'skip-non-essential',
    flag: {
      trigger: 'identity-outage',
      action: 'skip-non-essential',
      detail: `${input.identityErrors} identity lookup errors observed`,
    },
  };
};

/**
 * Resolves the most restrictive action among many degrade observations.
 * Order of restrictiveness: abort > circuit-open > cached-only >
 * skip-non-essential > continue.
 */
export const mostRestrictive = (actions: readonly DegradeAction[]): DegradeAction => {
  const order: DegradeAction[] = [
    'abort',
    'circuit-open',
    'cached-only',
    'skip-non-essential',
    'continue',
  ];
  for (const action of order) {
    if (actions.includes(action)) {
      return action;
    }
  }
  return 'continue';
};
