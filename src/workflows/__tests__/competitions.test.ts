import { describe, expect, it } from 'vitest';

import {
  PHASE_A_COMPETITIONS,
  PHASE_A_COMPETITIONS_BY_KEY,
  phaseAVerifiedFixtureIds,
} from '../competitions.js';
import type { CompetitionEntry } from '../types.js';

describe('PHASE_A_COMPETITIONS catalogue', () => {
  it('declares the full launch-competition set with stable kebab keys', () => {
    expect(PHASE_A_COMPETITIONS.map((c) => c.key)).toEqual([
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
    ]);
  });

  it('exposes PHASE_A_COMPETITIONS_BY_KEY in sync with the catalogue', () => {
    for (const competition of PHASE_A_COMPETITIONS) {
      expect(PHASE_A_COMPETITIONS_BY_KEY.get(competition.key)).toBe(competition);
    }
    expect(PHASE_A_COMPETITIONS_BY_KEY.size).toBe(PHASE_A_COMPETITIONS.length);
  });

  it('anchors Premier League with the verified rotation fixture 1538961', () => {
    const epl = PHASE_A_COMPETITIONS_BY_KEY.get('premier-league');
    expect(epl).toBeDefined();
    expect(epl?.verifiedFixtureIds).toContain('1538961');
  });
});

describe('phaseAVerifiedFixtureIds', () => {
  it('returns the union of verified ids declared across the catalogue', () => {
    const ids = phaseAVerifiedFixtureIds();
    // Premier League is the only entry with a baseline-verified fixture
    // today. The other launch competitions intentionally have no
    // verifiedFixtureIds so this list stays accurate.
    expect(ids).toContain('1538961');
  });

  it('de-duplicates ids across competitions', () => {
    const stub: CompetitionEntry = {
      key: 'stub',
      label: 'Stub',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic',
      verifiedFixtureIds: ['1', '2', '1'],
    };
    const other: CompetitionEntry = {
      key: 'other',
      label: 'Other',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic',
      verifiedFixtureIds: ['2', '3'],
    };
    expect(phaseAVerifiedFixtureIds([stub, other])).toEqual(['1', '2', '3']);
  });

  it('ignores empty entries and whitespace-only ids', () => {
    const entry: CompetitionEntry = {
      key: 'whitespace',
      label: 'Whitespace',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic',
      verifiedFixtureIds: ['', ' ', '42'],
    };
    expect(phaseAVerifiedFixtureIds([entry])).toEqual(['42']);
  });

  it('returns an empty list for competitions with no verified ids', () => {
    const entry: CompetitionEntry = {
      key: 'none',
      label: 'None',
      apiFootballLeagueId: 0,
      season: 2025,
      calendar: [],
      tier: 'domestic',
    };
    expect(phaseAVerifiedFixtureIds([entry])).toEqual([]);
  });
});
