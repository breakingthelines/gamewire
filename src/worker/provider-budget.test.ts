import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { createProviderBudget } from './provider-budget.js';

const authEnv = (overrides: Record<string, string | undefined> = {}) => ({
  GAMEWIRE_AUTH_CONTEXT_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
  GAMEWIRE_AUTH_CONTEXT_ISSUER: 'auth-service',
  GAMEWIRE_AUTH_CONTEXT_AUDIENCE: 'gamewire-worker',
  GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE: 'gamewire.workflow.invoke',
  ...overrides,
});

const NOW = new Date('2026-11-04T12:00:30.000Z');

// The staging values from infrastructure#277 (STG) and the minute caps the
// follow-up sets. If this wiring breaks, staging silently spends the prod key
// at the code defaults.
const STAGING_ENV = authEnv({
  GAMEWIRE_PROVIDER_HARD_CAP: '5000',
  GAMEWIRE_PROVIDER_SOFT_CAP: '4000',
  GAMEWIRE_PROVIDER_MINUTE_CAP_LIVE: '60',
  GAMEWIRE_PROVIDER_MINUTE_CAP_NEARLIVE: '60',
  GAMEWIRE_PROVIDER_MINUTE_CAP_BACKGROUND: '30',
});

describe('createProviderBudget', () => {
  it('env daily caps reach reserve()', async () => {
    const { quota } = createProviderBudget(loadConfig(STAGING_ENV), { clock: () => NOW });
    expect(quota.backgroundDailyCap).toBe(4_000);

    const first = await quota.reserve(3_999, NOW, 'live');
    expect(first.allowed).toBe(true);
    expect(first.snapshot.hardCap).toBe(5_000);
    expect(first.snapshot.softCap).toBe(4_000);

    // Background stops at min(110k, soft cap) = 4,000.
    expect((await quota.reserve(1, NOW, 'background')).allowed).toBe(true);
    const background = await quota.reserve(1, NOW, 'background');
    expect(background.allowed).toBe(false);
    expect(background.reason).toBe('background_cap');

    // Live runs on to the 5,000 hard cap and no further.
    expect((await quota.reserve(1_000, NOW, 'live')).allowed).toBe(true);
    const live = await quota.reserve(1, NOW, 'live');
    expect(live.allowed).toBe(false);
    expect(live.reason).toBe('hard_cap');
  });

  it('env minute caps reach the limiter', async () => {
    const now = NOW.getTime();
    const { minuteLimiter } = createProviderBudget(loadConfig(STAGING_ENV), {
      minuteClock: () => now,
    });
    expect(minuteLimiter.caps).toEqual({ live: 60, 'near-live': 60, background: 30 });
    for (let i = 0; i < 30; i += 1) {
      expect((await minuteLimiter.tryAcquire('background')).allowed).toBe(true);
    }
    expect((await minuteLimiter.tryAcquire('background')).allowed).toBe(false);
  });

  it('uses the env quota source and an explicit background cap', () => {
    const { quota, summary } = createProviderBudget(
      loadConfig(
        authEnv({
          GAMEWIRE_PROVIDER_QUOTA_SOURCE: 'provider-header',
          GAMEWIRE_PROVIDER_BACKGROUND_DAILY_CAP: '100000',
        })
      )
    );
    expect(quota.quotaSource).toBe('provider-header');
    expect(quota.backgroundDailyCap).toBe(100_000);
    expect(summary).toContain('hardCap=140000');
    expect(summary).toContain('backgroundDailyCap=100000');
  });

  it('warns when the hard cap exceeds the plan ceiling', () => {
    const { warnings } = createProviderBudget(
      loadConfig(authEnv({ GAMEWIRE_PROVIDER_PLAN_CEILING: '75000' }))
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('hard cap 140000 exceeds plan ceiling 75000');
  });
});
