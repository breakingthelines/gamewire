import { describe, expect, it } from 'vitest';

import { LIVE_INGESTION_COMPETITIONS } from '../workflows/competitions.js';
import { estimateMatchdayCallBudget } from './call-budget.js';

describe('gamewire-worker call budget model', () => {
  it('defaults to the full unified-catalogue live-ingestion coverage (27 competitions)', () => {
    const estimate = estimateMatchdayCallBudget('api-football');

    expect(estimate.assumptions.competitions).toBe(27);
    expect(LIVE_INGESTION_COMPETITIONS.map((competition) => competition.label)).toEqual([
      'Premier League',
      'EFL Championship',
      'EFL League One',
      'EFL League Two',
      'La Liga',
      'Bundesliga',
      'Serie A',
      'Ligue 1',
      'Eredivisie',
      'Brasileirão Série A',
      'Belgian Pro League',
      'Primeira Liga',
      'UEFA World Cup Qualifiers',
      'CONMEBOL World Cup Qualifiers',
      'AFC World Cup Qualifiers',
      'CAF World Cup Qualifiers',
      'CONCACAF World Cup Qualifiers',
      'FIFA World Cup 2026',
      'FA Cup',
      'EFL Cup',
      'Copa del Rey',
      'Coppa Italia',
      'DFB Pokal',
      'Coupe de France',
      'UEFA Champions League',
      'UEFA Europa League',
      'UEFA Europa Conference League',
    ]);
  });

  it('models efficient matchday calls and flags per-match live polling', () => {
    const estimate = estimateMatchdayCallBudget('api-football', {
      competitions: 30,
      simultaneousLiveGames: 20,
    });

    expect(estimate.lines.find((line) => line.workload === 'fixtures')?.estimatedCalls).toBe(60);
    expect(estimate.lines.find((line) => line.workload === 'live')?.strategy).toContain(
      'global/latest-updated'
    );
    expect(estimate.warnings[0]).toContain('Per-match live polling');
  });
});
