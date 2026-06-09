import { describe, expect, it } from 'vitest';

import { IngestionMetrics } from './metrics.js';

describe('IngestionMetrics', () => {
  it('tracks provider call counts per workload and endpoint', () => {
    const metrics = new IngestionMetrics();
    metrics.recordProviderCall('api-football', 'fixtures-next-7d', '/fixtures?league=39');
    metrics.recordProviderCall('api-football', 'fixtures-next-7d', '/fixtures?league=39');
    metrics.recordProviderCall('api-football', 'fixture-detail-live', '/fixtures?id=1');

    const snap = metrics.snapshot();
    expect(snap.providerCallsTotal).toEqual({
      'api-football|fixtures-next-7d': 2,
      'api-football|fixture-detail-live': 1,
    });
    expect(snap.providerEndpointVolume).toEqual({
      'api-football|/fixtures?league=39': 2,
      'api-football|/fixtures?id=1': 1,
    });
  });

  it('computes a cache hit ratio safely when there are no calls', () => {
    const metrics = new IngestionMetrics();
    expect(metrics.snapshot().cacheHitRatio).toBe(0);
  });

  it('computes a cache hit ratio from hit/miss counts', () => {
    const metrics = new IngestionMetrics();
    metrics.recordCacheHit();
    metrics.recordCacheHit();
    metrics.recordCacheHit();
    metrics.recordCacheMiss();
    const snap = metrics.snapshot();
    expect(snap.cacheHits).toBe(3);
    expect(snap.cacheMisses).toBe(1);
    expect(snap.cacheHitRatio).toBe(0.75);
  });

  it('records outcomes and surfaces them in the snapshot', () => {
    const metrics = new IngestionMetrics();
    metrics.recordOutcome('fetched');
    metrics.recordOutcome('fetched');
    metrics.recordOutcome('cached');
    metrics.recordOutcome('skipped');
    metrics.recordOutcome('failed');
    metrics.recordOutcome('denied');
    metrics.recordOutcome('rate_limited');
    expect(metrics.snapshot().callOutcomes).toEqual({
      fetched: 2,
      cached: 1,
      skipped: 1,
      failed: 1,
      denied: 1,
      rate_limited: 1,
    });
  });

  it('records quota posture for exposition', () => {
    const metrics = new IngestionMetrics();
    metrics.recordQuota(58_123, 'normal');
    expect(metrics.snapshot().quotaCallsToday).toBe(58_123);
    expect(metrics.snapshot().quotaPosture).toBe('normal');
    metrics.recordQuota(60_001, 'soft_cap_reached');
    expect(metrics.snapshot().quotaPosture).toBe('soft_cap_reached');
  });

  it('resets all counters', () => {
    const metrics = new IngestionMetrics();
    metrics.recordProviderCall('api-football', 'fixtures-next-7d', '/fixtures');
    metrics.recordCacheHit();
    metrics.recordOutcome('fetched');
    metrics.recordQuota(100, 'normal');
    metrics.reset();
    const snap = metrics.snapshot();
    expect(snap.providerCallsTotal).toEqual({});
    expect(snap.providerEndpointVolume).toEqual({});
    expect(snap.cacheHits).toBe(0);
    expect(snap.cacheMisses).toBe(0);
    expect(snap.callOutcomes).toEqual({
      fetched: 0,
      cached: 0,
      skipped: 0,
      failed: 0,
      denied: 0,
      rate_limited: 0,
    });
    expect(snap.quotaCallsToday).toBe(0);
    expect(snap.quotaPosture).toBe('normal');
  });
});
