import { describe, expect, it } from 'vitest';

import { API_FOOTBALL_BETA_COMPETITIONS } from '../adapters/api-football/index.js';
import { estimateMatchdayCallBudget } from './call-budget.js';

describe('gamewire-worker call budget model', () => {
  it('defaults to the top five + World Cup + Scope A leagues and cups coverage', () => {
    const estimate = estimateMatchdayCallBudget('api-football');

    expect(estimate.assumptions.competitions).toBe(15);
    expect(API_FOOTBALL_BETA_COMPETITIONS.map((competition) => competition.label)).toEqual([
      'Premier League',
      'La Liga',
      'Serie A',
      'Bundesliga',
      'Ligue 1',
      'FIFA World Cup',
      'Pro League',
      'Primeira Liga',
      'Eredivisie',
      'FA Cup',
      'EFL Cup',
      'Copa del Rey',
      'Coppa Italia',
      'DFB Pokal',
      'Coupe de France',
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
