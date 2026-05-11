import { API_FOOTBALL_BETA_COMPETITIONS } from '../adapters/api-football/index.js';

export interface MatchdayBudgetAssumptions {
  readonly competitions: number;
  readonly fixturesPerMatchday: number;
  readonly simultaneousLiveGames: number;
  readonly fixtureWindowDays: number;
}

export interface CallBudgetLine {
  readonly workload: string;
  readonly strategy: string;
  readonly estimatedCalls: number;
  readonly period: 'day' | 'hour' | 'match';
}

export interface CallBudgetEstimate {
  readonly provider: string;
  readonly assumptions: MatchdayBudgetAssumptions;
  readonly lines: readonly CallBudgetLine[];
  readonly warnings: readonly string[];
}

const defaultAssumptions: MatchdayBudgetAssumptions = {
  competitions: API_FOOTBALL_BETA_COMPETITIONS.length,
  fixturesPerMatchday: 50,
  simultaneousLiveGames: 20,
  fixtureWindowDays: 7,
};

export function estimateMatchdayCallBudget(
  provider: string,
  assumptions: Partial<MatchdayBudgetAssumptions> = {}
): CallBudgetEstimate {
  const merged = { ...defaultAssumptions, ...assumptions };
  const globalLivePollsPerHour = 60 * 4;
  const perMatchLivePollsPerHour = merged.simultaneousLiveGames * 60 * 2;

  return {
    provider,
    assumptions: merged,
    lines: [
      {
        workload: 'fixtures',
        strategy: 'competition date-range sync with changed-window refresh',
        estimatedCalls: merged.competitions * 2,
        period: 'day',
      },
      {
        workload: 'live',
        strategy: 'global/latest-updated feed every 15 seconds',
        estimatedCalls: globalLivePollsPerHour,
        period: 'hour',
      },
      {
        workload: 'lineups',
        strategy: 'T-90 every 10 minutes until present, then cache',
        estimatedCalls: 6,
        period: 'match',
      },
      {
        workload: 'standings',
        strategy: 'scheduled 6h competition refresh plus post-final affected refresh',
        estimatedCalls: merged.competitions * 4,
        period: 'day',
      },
      {
        workload: 'timeline',
        strategy: 'fixture/live includes or state-change and full-time fetches',
        estimatedCalls: 3,
        period: 'match',
      },
      {
        workload: 'rich-actions',
        strategy: 'selected fixtures and replay/post-match backfills only',
        estimatedCalls: 1,
        period: 'match',
      },
    ],
    warnings:
      perMatchLivePollsPerHour > globalLivePollsPerHour * 4
        ? [
            `Per-match live polling would be about ${perMatchLivePollsPerHour}/hour; prefer global/latest-updated feeds or webhooks.`,
          ]
        : [],
  };
}
