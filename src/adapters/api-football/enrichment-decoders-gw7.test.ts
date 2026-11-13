/**
 * GW-7 and GW-8 decoders: predictions (with the pair's meetings), head-to-head
 * and venues. Shapes follow live API-Football responses read on 2026-11-13.
 */
import { describe, expect, it } from 'vitest';

import { fixtureOfficiating } from './adapter.js';
import {
  apiFootballHeadToHeadPath,
  decodeHeadToHead,
  decodePrediction,
  decodeVenue,
} from './enrichment-decoders.js';

const FETCHED = Date.UTC(2026, 10, 13, 12);

const fixture = (id: number, home: number, away: number, date: string, league = 41) => ({
  fixture: {
    id,
    referee: 'C. Pereira',
    date: `${date}T19:45:00+00:00`,
    periods: { first: 1_794_169_800, second: 1_794_173_400 },
    status: { short: 'FT' },
  },
  league: { id: league, name: 'League One', season: 2025 },
  teams: { home: { id: home, name: `T${home}`, logo: 'x' }, away: { id: away, name: `T${away}` } },
  goals: { home: 1, away: null },
});

describe('decodePrediction', () => {
  const envelope = {
    errors: [],
    response: [
      {
        predictions: {
          winner: { id: 1333, name: 'AFC Wimbledon', comment: 'Win or draw' },
          win_or_draw: true,
          under_over: null,
          goals: { home: '-1.5', away: '-1.5' },
          advice: 'Double chance : AFC Wimbledon or draw',
          percent: { home: '35%', draw: '35%', away: '30%' },
        },
        league: { id: 41 },
        teams: { home: { id: 1333, name: 'AFC Wimbledon' }, away: { id: 1356, name: 'Other' } },
        comparison: { form: { home: '60%', away: '40%' } },
        h2h: [
          fixture(48070, 1356, 1333, '2017-09-02'),
          fixture(1387403, 1333, 1356, '2026-03-11'),
          // Another pair, and a repeat: dropped.
          fixture(5, 1, 2, '2020-01-01'),
          fixture(48070, 1356, 1333, '2017-09-02'),
        ],
      },
    ],
  };

  it('keeps whole percentages, raw goal lines, the winner and a trimmed payload', () => {
    const decoded = decodePrediction(envelope, { fixtureId: '1564403', fetchedAtMs: FETCHED });
    const row = decoded.row!;
    expect([row.homeWinPct, row.drawPct, row.awayWinPct]).toEqual([35, 35, 30]);
    expect(row.providerWinnerTeamId).toBe('1333');
    expect(row.winnerSnapshot?.label).toBe('AFC Wimbledon');
    expect(row.winnerComment).toBe('Win or draw');
    expect([row.goalsHomeLine, row.goalsAwayLine]).toEqual(['-1.5', '-1.5']);
    expect(row.payload).toEqual({
      predictions: envelope.response[0]!.predictions,
      comparison: envelope.response[0]!.comparison,
    });
  });

  it('carries the pair meetings, most recent first, low id first', () => {
    const { headToHead, dropped } = decodePrediction(envelope, {
      fixtureId: '1564403',
      fetchedAtMs: FETCHED,
    });
    expect([headToHead!.providerTeamLowId, headToHead!.providerTeamHighId]).toEqual([
      '1333',
      '1356',
    ]);
    expect(headToHead!.meetings.map((m) => m.providerFixtureId)).toEqual(['1387403', '48070']);
    const latest = headToHead!.meetings[0]!;
    expect([latest.homeGoals, latest.awayGoals, latest.statusShort]).toEqual([1, 0, 'FT']);
    expect([latest.refereeName, latest.competitionName, latest.seasonYear]).toEqual([
      'C. Pereira',
      'League One',
      2025,
    ]);
    expect(Number(latest.firstHalfStartedAt?.seconds)).toBe(1_794_169_800);
    expect(dropped).toBe(2);
  });

  it('writes no row when a percentage is missing', () => {
    const bad = structuredClone(envelope);
    (bad.response[0]!.predictions.percent as Record<string, unknown>).draw = null;
    expect(decodePrediction(bad, { fixtureId: '1', fetchedAtMs: FETCHED }).row).toBeUndefined();
  });

  it('returns provider errors and nothing else for an empty response', () => {
    const decoded = decodePrediction(
      { errors: { fixture: 'unknown' }, response: [] },
      { fixtureId: '1', fetchedAtMs: FETCHED }
    );
    expect(decoded.row).toBeUndefined();
    expect(decoded.providerErrors).toContain('fixture');
  });
});

describe('decodeHeadToHead', () => {
  it('normalises the pair and clears on an explicit empty list', () => {
    expect(apiFootballHeadToHeadPath('1356', '1333')).toBe(
      '/fixtures/headtohead?h2h=1333-1356&last=10'
    );
    const empty = decodeHeadToHead(
      { errors: [], response: [] },
      { teamA: '1356', teamB: '1333', fetchedAtMs: FETCHED }
    );
    expect(empty.snapshot?.clearScope).toBe(true);
    expect(empty.snapshot?.meetings).toHaveLength(0);
    const one = decodeHeadToHead(
      { errors: [], response: [fixture(9, 1333, 1356, '2025-10-04')] },
      { teamA: '1356', teamB: '1333', fetchedAtMs: FETCHED }
    );
    expect(one.snapshot?.clearScope).toBe(false);
    expect(one.snapshot?.meetings[0]?.providerHomeTeamId).toBe('1333');
  });
});

describe('decodeVenue', () => {
  it('reads the venue record, leaving a null capacity unset', () => {
    const venue = (capacity: number | null) => ({
      errors: [],
      response: [
        {
          id: 1288,
          name: 'Estádio do Rio Ave Futebol Clube',
          address: 'Rua Dona Maria Pães Ribeiro',
          city: 'Vila do Conde',
          country: 'Portugal',
          capacity,
          surface: 'grass',
          image: 'https://media.api-sports.io/football/venues/1288.png',
        },
      ],
    });
    const row = decodeVenue(venue(12_815), { venueId: '1288', fetchedAtMs: FETCHED }).row!;
    expect([row.name, row.city, row.country, row.capacity, row.surface]).toEqual([
      'Estádio do Rio Ave Futebol Clube',
      'Vila do Conde',
      'Portugal',
      12_815,
      'grass',
    ]);
    expect(row.imageUrl).toContain('1288.png');
    expect(decodeVenue(venue(null), { venueId: '1288', fetchedAtMs: FETCHED }).row?.capacity).toBe(
      undefined
    );
    expect(decodeVenue(venue(1), { venueId: '7', fetchedAtMs: FETCHED }).row).toBeUndefined();
  });
});

describe('fixtureOfficiating (GW-4)', () => {
  it('keeps the referee raw and the half kick-offs from unix seconds', () => {
    const out = fixtureOfficiating({
      referee: ' Michael Oliver, England ',
      periods: { first: 1_794_169_800, second: null },
    });
    expect(out.refereeName).toBe('Michael Oliver, England');
    expect(Number(out.firstHalfStartedAt?.seconds)).toBe(1_794_169_800);
    expect(out.secondHalfStartedAt).toBeUndefined();
  });

  it('is empty before a referee is appointed or a half starts', () => {
    expect(fixtureOfficiating({ referee: null, periods: null })).toEqual({ refereeName: '' });
    expect(fixtureOfficiating({})).toEqual({ refereeName: '' });
  });
});
