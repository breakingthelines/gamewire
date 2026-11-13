/**
 * Team coaches decoder. The fixture is a real `/coachs?team=33` response
 * (API-Football, cached by identity's backfill in June 2026): ten Hag with a
 * closed spell, Amorim with a stale open spell, Carrick with the latest open
 * spell.
 */
import { readFileSync } from 'node:fs';

import { create } from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { CoachCareerRowSchema } from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';
import { describe, expect, it } from 'vitest';

import {
  apiFootballCoachsTeamPath,
  currentCoachSpell,
  decodeCoachs,
} from './enrichment-decoders.js';

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const FETCHED = Date.UTC(2026, 10, 13, 4, 20, 0);

const spell = (providerTeamId: string, startDate: string, endDate = '') =>
  create(CoachCareerRowSchema, { providerTeamId, startDate, endDate });

describe('decodeCoachs', () => {
  it('builds the path', () => {
    expect(apiFootballCoachsTeamPath('33')).toBe('/coachs?team=33');
  });

  it('decodes every coach with a career, most recent first', () => {
    const decoded = decodeCoachs(load('coachs-team-33.json'), { fetchedAtMs: FETCHED });
    expect(decoded).toMatchObject({ entries: 3, dropped: 0, providerErrors: undefined });
    expect(decoded.rows.map((row) => row.providerCoachId)).toEqual(['1993', '4720', '25762']);

    const tenHag = decoded.rows[0]!;
    expect(tenHag).toMatchObject({
      name: 'E. ten Hag',
      firstname: 'Erik',
      lastname: 'ten Hag',
      birthDate: '1970-02-02',
      birthPlace: 'Haaksbergen',
      birthCountry: 'Netherlands',
      nationality: 'Netherlands',
      currentProviderTeamId: '',
    });
    expect(tenHag.coachSnapshot?.label).toBe('E. ten Hag');
    expect(tenHag.career[0]).toMatchObject({
      providerTeamId: '33',
      teamName: 'Manchester United',
      startDate: '2022-06-01',
      endDate: '2024-10-01',
    });
    const starts = tenHag.career.map((s) => s.startDate);
    expect(starts).toEqual([...starts].sort().reverse());
    expect(timestampMs(tenHag.fetchedAt!)).toBe(FETCHED);
  });

  it('marks both open spells current, so the reader picks the later start', () => {
    const decoded = decodeCoachs(load('coachs-team-33.json'), { fetchedAtMs: FETCHED });
    const byId = new Map(decoded.rows.map((row) => [row.providerCoachId, row]));
    expect(byId.get('4720')?.currentProviderTeamId).toBe('33');
    expect(byId.get('4720')?.career[0]).toMatchObject({ startDate: '2024-11-01', endDate: '' });
    expect(byId.get('25762')?.currentProviderTeamId).toBe('33');
    expect(byId.get('25762')?.career[0]).toMatchObject({ startDate: '2025-08-01', endDate: '' });
  });

  it('drops coaches without an id, duplicates, placeholders and spells without a team', () => {
    const decoded = decodeCoachs(
      {
        errors: [],
        response: [
          { id: null, name: 'Nobody' },
          { id: 7, name: 'Data not available' },
          {
            id: 8,
            name: 'A. Coach',
            birth: { date: 'not a date' },
            career: [
              { team: { id: null, name: 'Unknown' }, start: '2020-01-01', end: null },
              { team: { id: 50, name: 'City' }, start: '2021-07-01', end: null },
            ],
          },
          { id: 8, name: 'A. Coach' },
        ],
      },
      { fetchedAtMs: FETCHED }
    );
    expect(decoded.entries).toBe(4);
    expect(decoded.dropped).toBe(4);
    expect(decoded.rows).toHaveLength(1);
    expect(decoded.rows[0]).toMatchObject({
      providerCoachId: '8',
      birthDate: '',
      currentProviderTeamId: '50',
    });
    expect(decoded.rows[0]!.career).toHaveLength(1);
  });

  it('reports provider errors and a non-list response', () => {
    const decoded = decodeCoachs(
      { errors: { requests: 'limit reached' }, response: [] },
      { fetchedAtMs: FETCHED }
    );
    expect(decoded.rows).toHaveLength(0);
    expect(decoded.providerErrors).toContain('limit');
    expect(decodeCoachs({ response: {} }, { fetchedAtMs: FETCHED }).rows).toHaveLength(0);
  });
});

describe('currentCoachSpell', () => {
  it('takes the latest spell when it is open', () => {
    expect(
      currentCoachSpell([spell('1', '2024-11-01'), spell('2', '2025-08-01')], FETCHED)
        ?.providerTeamId
    ).toBe('2');
  });

  it('returns nothing when every spell has ended (a sacked coach)', () => {
    expect(currentCoachSpell([spell('33', '2025-08-01', '2026-11-01')], FETCHED)).toBeUndefined();
  });

  it('treats an end date after the fetch day as open', () => {
    expect(
      currentCoachSpell([spell('33', '2025-08-01', '2027-06-30')], FETCHED)?.providerTeamId
    ).toBe('33');
  });

  it('ranks an open spell with no start below one with a start', () => {
    expect(
      currentCoachSpell([spell('9', ''), spell('33', '2025-08-01')], FETCHED)?.providerTeamId
    ).toBe('33');
    expect(currentCoachSpell([spell('9', '')], FETCHED)?.providerTeamId).toBe('9');
  });

  it('does not fall back to a stale open spell when the latest spell has ended', () => {
    // Open at 1 since 2019 (never closed), then hired and sacked by 2.
    expect(
      currentCoachSpell([spell('1', '2019-07-01'), spell('2', '2025-08-01', '2026-11-01')], FETCHED)
    ).toBeUndefined();
  });

  it('prefers the open spell when an ended one starts the same month', () => {
    expect(
      currentCoachSpell([spell('1', '2026-11-01', '2026-11-01'), spell('2', '2026-11-01')], FETCHED)
        ?.providerTeamId
    ).toBe('2');
  });

  it('skips an appointment that starts after the fetch day', () => {
    expect(
      currentCoachSpell([spell('1', '2024-07-01'), spell('2', '2026-12-01')], FETCHED)
        ?.providerTeamId
    ).toBe('1');
  });
});

describe('decodeCoachs on a vacancy', () => {
  it('still writes every coach when no one holds an open spell at the team', () => {
    // The fixture after Carrick's spell ends in November 2026: Amorim's stale
    // open spell is older than Carrick's, ten Hag's is closed. Every coach is
    // still written with a fresh fetched_at, which is game-service's evidence
    // that the team was fetched and that its latest spell has ended.
    const envelope = load('coachs-team-33.json');
    const response = envelope.response as Array<{
      id: number;
      career: Array<Record<string, unknown>>;
    }>;
    const carrick = response.find((coach) => coach.id === 25762)!;
    carrick.career[0]!.end = '2026-11-01';
    const decoded = decodeCoachs(envelope, { fetchedAtMs: FETCHED });
    expect(decoded.rows.map((row) => row.providerCoachId)).toEqual(['1993', '4720', '25762']);
    const byId = new Map(decoded.rows.map((row) => [row.providerCoachId, row]));
    expect(byId.get('25762')?.currentProviderTeamId).toBe('');
    expect(byId.get('25762')?.career[0]).toMatchObject({
      startDate: '2025-08-01',
      endDate: '2026-11-01',
    });
    // Amorim's own career cannot show he left; game-service settles that at
    // the team, where Carrick's later spell supersedes his.
    expect(byId.get('4720')?.currentProviderTeamId).toBe('33');
    for (const row of decoded.rows) {
      expect(timestampMs(row.fetchedAt!)).toBe(FETCHED);
    }
  });
});
