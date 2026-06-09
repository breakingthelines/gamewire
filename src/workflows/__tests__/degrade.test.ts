import { describe, expect, it } from 'vitest';

import type { ProviderQuotaSnapshot } from '../../worker/quota.js';
import {
  handleIdentityOutage,
  handleProvider5xx,
  handleProviderOutage,
  handleProviderRateLimited,
  handleQuotaPosture,
  handleReepMissSpike,
  handleWebhookStall,
  mostRestrictive,
  PROVIDER_5XX_CIRCUIT_THRESHOLD,
  REEP_MISS_RATE_THRESHOLD,
} from '../degrade.js';

const quota = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  provider: 'api-football',
  window: '2026-05-22',
  calls: 0,
  softCap: 60_000,
  hardCap: 70_000,
  cachedOnlyMode: false,
  posture: 'normal',
  ...overrides,
});

describe('handleQuotaPosture', () => {
  it('continues under normal posture', () => {
    expect(handleQuotaPosture(quota()).action).toBe('continue');
  });

  it('flips to cached-only when soft cap reached', () => {
    const result = handleQuotaPosture(quota({ posture: 'soft_cap_reached', calls: 60_000 }));
    expect(result.action).toBe('cached-only');
    expect(result.flag?.trigger).toBe('soft-cap');
  });

  it('flips to cached-only when cachedOnlyMode latched', () => {
    const result = handleQuotaPosture(quota({ cachedOnlyMode: true, calls: 65_000 }));
    expect(result.action).toBe('cached-only');
    expect(result.flag?.trigger).toBe('soft-cap');
  });

  it('aborts on hard cap', () => {
    const result = handleQuotaPosture(quota({ posture: 'hard_cap_reached', calls: 70_000 }));
    expect(result.action).toBe('abort');
    expect(result.flag?.trigger).toBe('hard-cap');
  });
});

describe('handleReepMissSpike', () => {
  it('continues with zero lookups', () => {
    expect(handleReepMissSpike({ totalLookups: 0, missedLookups: 0 }).action).toBe('continue');
  });

  it('continues below 25% threshold', () => {
    expect(handleReepMissSpike({ totalLookups: 100, missedLookups: 24 }).action).toBe('continue');
  });

  it('skips when miss rate crosses the threshold', () => {
    const result = handleReepMissSpike({ totalLookups: 100, missedLookups: 30 });
    expect(result.action).toBe('skip-non-essential');
    expect(result.flag?.trigger).toBe('reep-miss-spike');
  });

  it('threshold constant is 0.25', () => {
    expect(REEP_MISS_RATE_THRESHOLD).toBe(0.25);
  });
});

describe('handleProvider5xx', () => {
  it('continues below the circuit threshold', () => {
    expect(handleProvider5xx({ consecutive5xx: 2 }).action).toBe('continue');
  });

  it('opens the circuit at the threshold', () => {
    const result = handleProvider5xx({ consecutive5xx: PROVIDER_5XX_CIRCUIT_THRESHOLD });
    expect(result.action).toBe('circuit-open');
    expect(result.flag?.trigger).toBe('provider-5xx');
  });
});

describe('handleWebhookStall', () => {
  it('continues without flag inside threshold', () => {
    expect(handleWebhookStall({ staleMs: 1_000, thresholdMs: 2_000 }).action).toBe('continue');
  });

  it('continues with flag when stale exceeds threshold', () => {
    const result = handleWebhookStall({ staleMs: 30_000, thresholdMs: 5_000 });
    expect(result.action).toBe('continue');
    expect(result.flag?.trigger).toBe('webhook-stall');
  });
});

describe('handleProviderOutage', () => {
  it('continues when no fallback reason', () => {
    expect(handleProviderOutage({ fallbackReason: undefined }).action).toBe('continue');
  });

  it('flips to cached-only when PROVIDER_OUTAGE observed', () => {
    const result = handleProviderOutage({ fallbackReason: 'PROVIDER_OUTAGE' });
    expect(result.action).toBe('cached-only');
    expect(result.flag?.trigger).toBe('provider-outage');
  });
});

describe('handleProviderRateLimited', () => {
  it('continues when no fallback reason', () => {
    expect(handleProviderRateLimited({ fallbackReason: undefined }).action).toBe('continue');
  });

  it('continues when fallback reason is the (different) PROVIDER_OUTAGE', () => {
    expect(handleProviderRateLimited({ fallbackReason: 'PROVIDER_OUTAGE' }).action).toBe(
      'continue'
    );
  });

  it('flips to skip-non-essential when PROVIDER_RATE_LIMITED observed', () => {
    const result = handleProviderRateLimited({
      fallbackReason: 'PROVIDER_RATE_LIMITED',
      detail: 'Too many requests, retry in 1 minute',
    });
    expect(result.action).toBe('skip-non-essential');
    expect(result.flag?.trigger).toBe('provider-rate-limited');
    expect(result.flag?.detail).toBe('Too many requests, retry in 1 minute');
  });
});

describe('handleIdentityOutage', () => {
  it('continues when identity errors zero', () => {
    expect(handleIdentityOutage({ identityErrors: 0 }).action).toBe('continue');
  });

  it('skips when identity errors observed', () => {
    const result = handleIdentityOutage({ identityErrors: 3 });
    expect(result.action).toBe('skip-non-essential');
    expect(result.flag?.trigger).toBe('identity-outage');
  });
});

describe('mostRestrictive', () => {
  it('returns abort over all others', () => {
    expect(mostRestrictive(['continue', 'cached-only', 'abort', 'circuit-open'])).toBe('abort');
  });

  it('returns circuit-open over cached-only', () => {
    expect(mostRestrictive(['cached-only', 'circuit-open'])).toBe('circuit-open');
  });

  it('returns cached-only over skip-non-essential and continue', () => {
    expect(mostRestrictive(['continue', 'skip-non-essential', 'cached-only'])).toBe('cached-only');
  });

  it('returns skip-non-essential over continue', () => {
    expect(mostRestrictive(['continue', 'skip-non-essential'])).toBe('skip-non-essential');
  });

  it('returns continue from empty list', () => {
    expect(mostRestrictive([])).toBe('continue');
  });
});
