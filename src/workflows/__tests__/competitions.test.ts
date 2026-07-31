import { describe, expect, it } from 'vitest';

import {
  COMPETITIONS,
  COMPETITIONS_BY_KEY,
  LIVE_INGESTION_COMPETITIONS,
  STEADY_STATE_COMPETITIONS,
  collectVerifiedFixtureIds,
  isMatchdayWindow,
} from '../competitions.js';
import type { CompetitionEntry } from '../types.js';

describe('COMPETITIONS catalogue', () => {
  it('declares the full launch-competition set with stable kebab keys', () => {
    expect(COMPETITIONS.map((c) => c.key)).toEqual([
      'premier-league',
      'efl-championship',
      'efl-league-one',
      'efl-league-two',
      'la-liga',
      'bundesliga',
      'serie-a',
      'ligue-1',
      'eredivisie',
      'brasileirao-serie-a',
      'jupiler-pro-league',
      'primeira-liga',
      'uefa-qualifiers',
      'conmebol-qualifiers',
      'afc-qualifiers',
      'caf-qualifiers',
      'concacaf-qualifiers',
      'fifa-world-cup-2026',
      'fa-cup',
      'efl-cup',
      'copa-del-rey',
      'coppa-italia',
      'dfb-pokal',
      'coupe-de-france',
    ]);
  });

  it('exposes COMPETITIONS_BY_KEY in sync with the catalogue', () => {
    for (const competition of COMPETITIONS) {
      expect(COMPETITIONS_BY_KEY.get(competition.key)).toBe(competition);
    }
    expect(COMPETITIONS_BY_KEY.size).toBe(COMPETITIONS.length);
  });

  it('anchors Premier League with the verified rotation fixture 1538961', () => {
    const epl = COMPETITIONS_BY_KEY.get('premier-league');
    expect(epl).toBeDefined();
    expect(epl?.verifiedFixtureIds).toContain('1538961');
  });

  it('gives every entry both liveIngestion and steadyStateSweep coverage', () => {
    // This is the entire point of the catalogue collapse: the old split
    // between PHASE_A_COMPETITIONS (24 leagues) and
    // API_FOOTBALL_BETA_COMPETITIONS (15 leagues) left 9 leagues with
    // steady-state sweep coverage but no live ingestion. The unified
    // catalogue closes that gap for every entry.
    for (const competition of COMPETITIONS) {
      expect(competition.liveIngestion).toBe(true);
      expect(competition.steadyStateSweep).toBe(true);
    }
    expect(LIVE_INGESTION_COMPETITIONS).toHaveLength(24);
    expect(STEADY_STATE_COMPETITIONS).toHaveLength(24);
  });

  it('resolves Premier League to a single season across every consumer', () => {
    // Previously PHASE_A_COMPETITIONS had season 2026 for Premier League
    // while API_FOOTBALL_BETA_COMPETITIONS had 2025 — a live season-drift
    // bug. There is now exactly one season value.
    const epl = COMPETITIONS_BY_KEY.get('premier-league');
    expect(epl?.season).toBe(2026);
  });

  it('sets calendar to null only for international windows + Brasileirão', () => {
    const nullCalendarKeys = COMPETITIONS.filter((c) => c.calendar === null).map((c) => c.key);
    expect(nullCalendarKeys.sort()).toEqual(
      [
        'afc-qualifiers',
        'brasileirao-serie-a',
        'caf-qualifiers',
        'concacaf-qualifiers',
        'conmebol-qualifiers',
        'fifa-world-cup-2026',
        'uefa-qualifiers',
      ].sort()
    );
  });
});

describe('isMatchdayWindow', () => {
  it('treats a null calendar as always in-window', () => {
    expect(isMatchdayWindow(new Date('2026-01-01T03:00:00Z'), null)).toBe(true);
    expect(isMatchdayWindow(new Date('2026-07-15T11:59:00Z'), null)).toBe(true);
  });

  it('respects an explicit weekly calendar', () => {
    const calendar = [{ utcWeekday: 6, utcHourStart: 12, utcHourEnd: 22 }];
    expect(isMatchdayWindow(new Date('2026-01-03T13:00:00Z'), calendar)).toBe(true); // Saturday 13:00
    expect(isMatchdayWindow(new Date('2026-01-04T13:00:00Z'), calendar)).toBe(false); // Sunday
  });

  it('returns false for an empty (non-null) calendar', () => {
    expect(isMatchdayWindow(new Date('2026-01-03T13:00:00Z'), [])).toBe(false);
  });
});

describe('collectVerifiedFixtureIds', () => {
  it('returns the union of verified ids declared across the catalogue', () => {
    const ids = collectVerifiedFixtureIds();
    // Premier League is the only entry with a baseline-verified fixture
    // today. The other launch competitions intentionally have no
    // verifiedFixtureIds so this list stays accurate.
    expect(ids).toContain('1538961');
  });

  it('de-duplicates ids across competitions', () => {
    const stub: CompetitionEntry = {
      key: 'stub',
      label: 'Stub',
      country: 'England',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic-league',
      liveIngestion: true,
      steadyStateSweep: true,
      verifiedFixtureIds: ['1', '2', '1'],
    };
    const other: CompetitionEntry = {
      key: 'other',
      label: 'Other',
      country: 'England',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic-league',
      liveIngestion: true,
      steadyStateSweep: true,
      verifiedFixtureIds: ['2', '3'],
    };
    expect(collectVerifiedFixtureIds([stub, other])).toEqual(['1', '2', '3']);
  });

  it('ignores empty entries and whitespace-only ids', () => {
    const entry: CompetitionEntry = {
      key: 'whitespace',
      label: 'Whitespace',
      country: 'England',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic-league',
      liveIngestion: true,
      steadyStateSweep: true,
      verifiedFixtureIds: ['', ' ', '42'],
    };
    expect(collectVerifiedFixtureIds([entry])).toEqual(['42']);
  });

  it('returns an empty list for competitions with no verified ids', () => {
    const entry: CompetitionEntry = {
      key: 'none',
      label: 'None',
      country: 'England',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic-league',
      liveIngestion: true,
      steadyStateSweep: true,
    };
    expect(collectVerifiedFixtureIds([entry])).toEqual([]);
  });
});
