import { readFileSync } from 'node:fs';

import { timestampMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';

import {
  PLAYER_SEASON_STAT_KEYS,
  apiFootballPlayerSeasonStatsPath,
  decodePlayerSeasonStatsPage,
  parseProviderNumber,
  playerSeasonValues,
} from './enrichment-decoders.js';

/**
 * A real `/players?league=88&season=2024&page=1` page (Eredivisie), trimmed to
 * four real players (N. Viergever, the all-null goalkeeper J. Cillessen, K.
 * Lamprou with two clubs, R. Karsdorp with null shots), plus five edge rows
 * built from them: the "Data not available" placeholder, a null player id,
 * another league's block, a null team id, and a string percentage.
 */
const PAGE: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/players-season-page.json', import.meta.url), 'utf8')
);

const FETCHED_AT = Date.UTC(2026, 10, 5, 3, 0, 0);
const decode = (envelope: unknown = PAGE) =>
  decodePlayerSeasonStatsPage(envelope, { leagueId: 88, season: 2024, fetchedAtMs: FETCHED_AT });

const rowFor = (playerId: string, teamId?: string) =>
  decode().rows.find(
    (row) =>
      row.providerPlayerId === playerId && (teamId === undefined || row.providerTeamId === teamId)
  );

describe('apiFootballPlayerSeasonStatsPath', () => {
  it('builds the paged /players path', () => {
    expect(apiFootballPlayerSeasonStatsPath(39, 2025, 3)).toBe(
      '/players?league=39&season=2025&page=3'
    );
  });
});

describe('parseProviderNumber', () => {
  it('parses numbers, decimal strings and percentage strings', () => {
    expect(parseProviderNumber(3)).toBe(3);
    expect(parseProviderNumber(0)).toBe(0);
    expect(parseProviderNumber('1.3')).toBe(1.3);
    expect(parseProviderNumber('7.027272')).toBeCloseTo(7.027272);
    expect(parseProviderNumber('33.33%')).toBe(33.33);
    expect(parseProviderNumber(' 45 % ')).toBe(45);
    expect(parseProviderNumber('-2')).toBe(-2);
  });

  it('returns undefined for null and anything that is not a number', () => {
    for (const value of [
      null,
      undefined,
      '',
      ' ',
      'n/a',
      '1.2.3',
      '1e3',
      NaN,
      Infinity,
      {},
      true,
    ]) {
      expect(parseProviderNumber(value)).toBeUndefined();
    }
  });
});

describe('decodePlayerSeasonStatsPage', () => {
  it('reads paging and counts entries', () => {
    const page = decode();
    expect(page.paging).toEqual({ current: 1, total: 43 });
    expect(page.entries).toBe(9);
    expect(page.providerErrors).toBeUndefined();
  });

  it('writes one row per (player, team) block for the requested league', () => {
    const page = decode();
    const keys = page.rows.map((row) => `${row.providerPlayerId}:${row.providerTeamId}`);
    expect(keys).toEqual(['232:207', '124:413', '525:209', '525:203', '770:197', '999004:207']);
    for (const row of page.rows) {
      expect(row.providerCompetitionId).toBe('88');
      expect(row.seasonYear).toBe(2024);
      expect(row.fetchedAt && timestampMs(row.fetchedAt)).toBe(FETCHED_AT);
    }
  });

  it('drops the placeholder name, a null player id, another league and a null team id', () => {
    const page = decode();
    expect(page.dropped).toBe(4);
    const ids = page.rows.map((row) => row.providerPlayerId);
    expect(ids).not.toContain('999001');
    expect(ids).not.toContain('999002');
    expect(ids).not.toContain('999003');
  });

  it('maps a full season line, string rating included', () => {
    expect(rowFor('232')?.values).toEqual({
      appearances: 33,
      starts: 33,
      minutes: 2951,
      avg_rating: 7.027272,
      goals: 3,
      assists: 1,
      shots: 13,
      shots_on_target: 7,
      key_passes: 7,
      passes_accuracy: 47,
      tackles: 54,
      yellow_cards: 2,
      red_cards: 1,
      substitute_in: 0,
      goals_conceded: 0,
      passes: 1818,
      blocks: 29,
      interceptions: 27,
      duels: 191,
      duels_won: 121,
      dribbles: 5,
      dribbles_completed: 4,
      fouls_drawn: 11,
      fouls_committed: 19,
      penalties_scored: 0,
      penalties_missed: 0,
    });
  });

  it('keeps a provider null out of values and a provider 0 in', () => {
    const karsdorp = rowFor('770')?.values ?? {};
    // shots.total and shots.on are null: absent, never 0.
    expect('shots' in karsdorp).toBe(false);
    expect('shots_on_target' in karsdorp).toBe(false);
    expect('passes_accuracy' in karsdorp).toBe(false);
    expect('saves' in karsdorp).toBe(false);
    // goals.total and yellowred are 0: present as 0.
    expect(karsdorp.goals).toBe(0);
    expect(karsdorp.yellow_red_cards).toBe(0);
    expect(karsdorp.red_cards).toBe(0);
  });

  it('keeps an all-null squad row with no values', () => {
    const goalkeeper = rowFor('124');
    expect(goalkeeper).toBeDefined();
    expect(goalkeeper?.values).toEqual({});
    expect(goalkeeper?.playerSnapshot?.attributes.position).toBe('Goalkeeper');
  });

  it('parses a percentage string and keeps a 0 it reports', () => {
    const row = rowFor('999004');
    expect(row?.values.passes_accuracy).toBe(33.33);
    expect(row?.values.goals).toBe(0);
  });

  it('gives each club its own line for a player who moved within the league', () => {
    const first = rowFor('525', '209');
    const second = rowFor('525', '203');
    expect(first?.teamSnapshot?.label).not.toBe(second?.teamSnapshot?.label);
    expect(first?.values).not.toEqual(second?.values);
  });

  it('fills player and team snapshots from the provider fields', () => {
    const row = rowFor('232');
    expect(row?.playerSnapshot?.label).toBe('N. Viergever');
    expect(row?.playerSnapshot?.country).toBe('Netherlands');
    expect(row?.playerSnapshot?.imageUrl).toContain('/players/232.png');
    expect(row?.playerSnapshot?.attributes).toMatchObject({
      firstname: 'Nick',
      lastname: 'Viergever',
      position: 'Defender',
      captain: 'false',
    });
    expect(row?.teamSnapshot?.label).toBe('Utrecht');
    expect(row?.teamSnapshot?.imageUrl).toContain('/teams/207.png');
  });

  it('never writes xG or xA (BTL computes them)', () => {
    const keys = PLAYER_SEASON_STAT_KEYS.map(([key]) => key);
    expect(keys).not.toContain('expected_goals_total');
    expect(keys).not.toContain('expected_assists_total');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports provider errors on an empty 200', () => {
    const page = decode({
      errors: { requests: 'You have reached the request limit for the day' },
      response: [],
      paging: { current: 1, total: 1 },
    });
    expect(page.rows).toEqual([]);
    expect(page.providerErrors).toContain('request limit');
  });

  it('treats an empty error list as no error', () => {
    expect(decode({ errors: [], response: [], paging: { current: 1, total: 0 } })).toMatchObject({
      rows: [],
      paging: { current: 1, total: 0 },
      providerErrors: undefined,
    });
  });

  it('returns nothing for a malformed envelope', () => {
    for (const envelope of [null, 'x', {}, { response: 'nope' }]) {
      const page = decode(envelope);
      expect(page.rows).toEqual([]);
      expect(page.paging).toEqual({ current: 0, total: 0 });
    }
  });
});

describe('playerSeasonValues', () => {
  it('ignores missing sections', () => {
    expect(playerSeasonValues({ games: { minutes: 90 } })).toEqual({ minutes: 90 });
  });
});

describe('PLAYER_SEASON_STAT_KEYS contract', () => {
  it('names extra keys after the PlayerMatchStats fields they share', () => {
    const keys = new Set(PLAYER_SEASON_STAT_KEYS.map(([key]) => key));
    for (const key of ['passes', 'duels', 'duels_won', 'dribbles', 'dribbles_completed']) {
      expect(keys.has(key)).toBe(true);
    }
    for (const old of ['passes_total', 'duels_total', 'dribbles_attempts', 'dribbles_success']) {
      expect(keys.has(old)).toBe(false);
    }
  });

  it('matches the key table in the README', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const documented = new Map<string, string>();
    for (const match of readme.matchAll(/\|\s*`([a-z_]+)`\s*\|\s*`([a-z]+\.[a-z]+)`/g)) {
      documented.set(match[1]!, match[2]!);
    }
    expect(documented.size).toBe(PLAYER_SEASON_STAT_KEYS.length);
    for (const [key, group, field] of PLAYER_SEASON_STAT_KEYS) {
      expect(documented.get(key)).toBe(`${group}.${field}`);
    }
  });
});
