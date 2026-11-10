/**
 * Stat wins on the match-stats mappers: player passes completed, dribbled
 * past and captain; team box shots, goals prevented, a derived pass
 * completion rate, and the `half=true` splits.
 *
 * Fixtures: `fixture-1557464-stats-players.json` holds the statistics and
 * players blocks of a live `/fixtures?id=1557464` response (Premier League
 * 2026, no "Passes %" and no half arrays, the legacy shape);
 * `fixture-players-1213441.json` has captains and `dribbles.past` values.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { halfStatistics, teamStatKey } from './adapter.js';
import {
  apiFootballFixtureStatisticsPath,
  apiFootballIngestPlayerMatchStatsRequestFromPlayers,
  apiFootballIngestTeamMatchStatsRequestFromStatistics,
} from './index.js';

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const FETCHED = Date.parse('2026-11-09T12:00:00Z');
const live = load('fixture-1557464-stats-players.json');
const liveStatistics = live.statistics as readonly { readonly statistics: unknown }[];

const teamStats = (envelope: unknown) =>
  apiFootballIngestTeamMatchStatsRequestFromStatistics({
    replayId: 'test',
    resourceId: '1557464',
    gameId: 'btl_football_game_g1557464',
    homeTeamProviderId: '33',
    awayTeamProviderId: '66',
    fetchedAtMs: FETCHED,
    envelope,
  }).teamStats;

const playerStats = (envelope: unknown, resourceId = '1557464') => {
  const lines = apiFootballIngestPlayerMatchStatsRequestFromPlayers({
    replayId: 'test',
    resourceId,
    gameId: `btl_football_game_g${resourceId}`,
    fetchedAtMs: FETCHED,
    envelope,
  }).playerStats;
  return new Map(lines.map((line) => [line.playerResolution?.providerRef?.providerId, line]));
};

const fieldsOf = (line: { readonly provenance: readonly { fieldName: string }[] } | undefined) =>
  line?.provenance.map((p) => p.fieldName) ?? [];

describe('team match stats', () => {
  it('requests the half splits on the same call', () => {
    expect(apiFootballFixtureStatisticsPath('1557464')).toBe(
      '/fixtures/statistics?fixture=1557464&half=true'
    );
  });

  it('types box shots and derives the pass rate when "Passes %" is absent (live payload)', () => {
    const [home, away] = teamStats({ response: live.statistics });
    expect(home?.shotsInsideBox).toBe(14);
    expect(home?.shotsOutsideBox).toBe(12);
    expect((home?.shotsInsideBox ?? 0) + (home?.shotsOutsideBox ?? 0)).toBe(home?.shots);
    expect(away?.shotsInsideBox).toBe(10);
    expect(away?.shotsOutsideBox).toBe(2);
    expect(home?.passesCompleted).toBe(438);
    expect(home?.passes).toBe(502);
    expect(home?.passCompletionPct).toBeCloseTo((100 * 438) / 502);
    const fields = fieldsOf(home);
    expect(fields).toEqual(
      expect.arrayContaining(['shotsInsideBox', 'shotsOutsideBox', 'passCompletionPct'])
    );
    // Not sent in this fixture: 0 and no provenance.
    expect(home?.goalsPrevented).toBe(0);
    expect(fields).not.toContain('goalsPrevented');
    // Typed metrics are no longer extras; the legacy shape adds no half keys.
    expect(Object.keys(home?.extraStats ?? {}).sort()).toEqual(['free-kicks']);
  });

  it('keeps the provider "Passes %" and types goals_prevented', () => {
    const [home] = teamStats({
      response: [
        {
          team: { id: 33, name: 'Manchester United' },
          statistics: [
            { type: 'Total passes', value: 500 },
            { type: 'Passes accurate', value: 400 },
            { type: 'Passes %', value: '81%' },
            { type: 'goals_prevented', value: -0.42 },
          ],
        },
      ],
    });
    expect(home?.passCompletionPct).toBe(81);
    expect(home?.goalsPrevented).toBeCloseTo(-0.42);
    expect(fieldsOf(home)).toContain('goalsPrevented');
    expect(home?.extraStats).toEqual({});
  });

  it('does not derive a rate from zero attempts or a count above the total', () => {
    for (const [total, accurate] of [
      [0, 0],
      [10, 12],
    ] as const) {
      const [home] = teamStats({
        response: [
          {
            team: { id: 33, name: 'Manchester United' },
            statistics: [
              { type: 'Total passes', value: total },
              { type: 'Passes accurate', value: accurate },
            ],
          },
        ],
      });
      expect(home?.passCompletionPct).toBe(0);
      expect(fieldsOf(home)).not.toContain('passCompletionPct');
    }
  });

  it('stores half splits as first-half:<key> and second-half:<key> extras', () => {
    const [home, away] = teamStats({
      response: [
        {
          team: { id: 33, name: 'Manchester United' },
          statistics: liveStatistics[0]?.statistics,
          statistics_1h: [
            { type: 'Shots on Goal', value: 4 },
            { type: 'Shots insidebox', value: 6 },
            { type: 'Ball Possession', value: '52%' },
            { type: 'Passes %', value: '80%' },
            { type: 'expected_goals', value: '1.10' },
            { type: 'Goalkeeper Saves', value: null },
          ],
          statistics_2h: [
            { type: 'Shots on Goal', value: 5 },
            { type: 'Ball Possession', value: '60%' },
          ],
        },
        {
          team: { id: 66, name: 'Aston Villa' },
          statistics: [{ type: 'Total Shots', value: 12 }],
          statistics_1h: null,
        },
      ],
    });
    expect(home?.extraStats).toEqual({
      'free-kicks': 9,
      'first-half:shots-on-goal': 4,
      'first-half:shots-insidebox': 6,
      'first-half:ball-possession': 52,
      'first-half:passes-pct': 80,
      'first-half:expected-goals': 1.1,
      'second-half:shots-on-goal': 5,
      'second-half:ball-possession': 60,
    });
    // The full-match typed fields are unchanged by the splits.
    expect(home?.shotsOnTarget).toBe(9);
    expect(home?.possessionPct).toBe(56);
    expect(fieldsOf(home).some((f) => f.includes('half'))).toBe(false);
    expect(away?.extraStats).toEqual({});
  });

  it('keys every type the same way, full match or half', () => {
    expect(teamStatKey('Shots on Goal')).toBe('shots-on-goal');
    expect(teamStatKey('Passes %')).toBe('passes-pct');
    expect(teamStatKey('expected_goals')).toBe('expected-goals');
    expect(teamStatKey('Free Kicks')).toBe('free-kicks');
    expect(halfStatistics('first-half', undefined)).toEqual({});
    expect(
      halfStatistics('second-half', [
        { type: 'Fouls', value: 7 },
        { type: '', value: 1 },
        { type: 'Offsides', value: null },
      ])
    ).toEqual({ 'second-half:fouls': 7 });
  });
});

describe('player match stats', () => {
  it('reads passes.accuracy as the completed count (live payload)', () => {
    const players = playerStats({ response: live.players });
    const mazraoui = players.get('545');
    expect(mazraoui?.passes).toBe(46);
    expect(mazraoui?.passesCompleted).toBe(39);
    expect(mazraoui?.passCompletionPct).toBeCloseTo((100 * 39) / 46);
    expect(fieldsOf(mazraoui)).toEqual(
      expect.arrayContaining(['passesCompleted', 'passCompletionPct'])
    );
    // dribbles.past is null: 0 and no provenance. captain false is a real value.
    expect(mazraoui?.dribbledPast).toBe(0);
    expect(fieldsOf(mazraoui)).not.toContain('dribbledPast');
    expect(mazraoui?.isCaptain).toBe(false);
    expect(fieldsOf(mazraoui)).toContain('isCaptain');
    // No completion rate is ever above 100.
    for (const line of players.values()) {
      expect(line.passCompletionPct).toBeLessThanOrEqual(100);
    }
  });

  it('a player with no passes has a completed count of 0 and no rate', () => {
    const players = playerStats({ response: live.players });
    const unused = [...players.values()].find((line) => line.passes === 0);
    expect(unused).toBeDefined();
    expect(unused?.passesCompleted).toBe(0);
    expect(fieldsOf(unused)).toContain('passesCompleted');
    expect(fieldsOf(unused)).not.toContain('passCompletionPct');
  });

  it('maps captain and dribbled past (Eredivisie 2024 payload)', () => {
    const players = playerStats(load('fixture-players-1213441.json'), '1213441');
    expect(players.get('18997')?.isCaptain).toBe(true);
    expect(players.get('8900')?.isCaptain).toBe(true);
    expect(players.get('8900')?.dribbledPast).toBe(1);
    expect(fieldsOf(players.get('8900'))).toContain('dribbledPast');
    expect(players.get('454545')?.isCaptain).toBe(false);
    expect(players.get('454545')?.dribbledPast).toBe(1);
    expect(players.get('18997')?.passesCompleted).toBe(56);
  });

  it('handles a percentage, a contradictory count and a missing captain flag', () => {
    const line = (passes: unknown, games: Record<string, unknown> = { minutes: 90 }) =>
      playerStats({
        response: [
          {
            team: { id: 42, name: 'Arsenal' },
            players: [
              {
                player: { id: 7, name: 'P' },
                statistics: [{ games, passes, dribbles: { past: 3 } }],
              },
            ],
          },
        ],
      }).get('7');
    const pct = line({ total: 40, accuracy: '84%' });
    expect(pct?.passCompletionPct).toBe(84);
    expect(fieldsOf(pct)).not.toContain('passesCompleted');
    expect(pct?.dribbledPast).toBe(3);
    // No games.captain sent: false, and no provenance.
    expect(pct?.isCaptain).toBe(false);
    expect(fieldsOf(pct)).not.toContain('isCaptain');
    const contradictory = line({ total: 10, accuracy: '12' });
    expect(fieldsOf(contradictory)).not.toContain('passesCompleted');
    expect(fieldsOf(contradictory)).not.toContain('passCompletionPct');
    const noTotal = line({ accuracy: '12' });
    expect(noTotal?.passesCompleted).toBe(12);
    expect(fieldsOf(noTotal)).not.toContain('passCompletionPct');
  });
});
