/**
 * GW-6b decoders: injuries, sidelined spells, transfers, trophies and squads.
 * The JSON fixtures are trimmed real responses (API-Football, 2026-11-05):
 * `/injuries?league=88&season=2026`, `/sidelined?players=276-874`,
 * `/transfers?team=194`, `/trophies?players=276-874`.
 */
import { readFileSync } from 'node:fs';

import { timestampMs } from '@bufbuild/protobuf/wkt';
import { SubjectType } from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  AvailabilityKind,
  AvailabilitySource,
  AvailabilityStatus,
} from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';
import { describe, expect, it } from 'vitest';

import {
  apiFootballInjuriesLeaguePath,
  apiFootballSidelinedPath,
  apiFootballSquadPath,
  apiFootballTransfersPath,
  apiFootballTrophiesPath,
  availabilityKindFor,
  availabilityStatusFor,
  decodeInjuries,
  decodeSidelined,
  decodeSquadPlayerIds,
  decodeTransfers,
  decodeTrophies,
} from './enrichment-decoders.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const FETCHED = Date.UTC(2026, 10, 5, 3, 0, 0);

describe('paths', () => {
  it('builds the provider paths, multi-id lists joined with "-"', () => {
    expect(apiFootballInjuriesLeaguePath(88, 2026)).toBe('/injuries?league=88&season=2026');
    expect(apiFootballSidelinedPath(['276', '874'])).toBe('/sidelined?players=276-874');
    expect(apiFootballTransfersPath('194')).toBe('/transfers?team=194');
    expect(apiFootballTrophiesPath('player', ['276', '874'])).toBe('/trophies?players=276-874');
    expect(apiFootballTrophiesPath('coach', ['1', '2'])).toBe('/trophies?coachs=1-2');
    expect(apiFootballSquadPath('194')).toBe('/players/squads?team=194');
  });
});

describe('availability mapping', () => {
  it('maps the provider type to a status', () => {
    expect(availabilityStatusFor('Missing Fixture')).toBe(AvailabilityStatus.OUT);
    expect(availabilityStatusFor('Questionable')).toBe(AvailabilityStatus.DOUBTFUL);
    expect(availabilityStatusFor('Something new')).toBe(AvailabilityStatus.UNKNOWN);
    expect(availabilityStatusFor(null)).toBe(AvailabilityStatus.UNKNOWN);
  });

  it.each([
    ['Red Card', AvailabilityKind.SUSPENSION],
    ['Yellow Cards', AvailabilityKind.SUSPENSION],
    ['Suspended', AvailabilityKind.SUSPENSION],
    ['Knee Injury', AvailabilityKind.INJURY],
    ['Knock', AvailabilityKind.INJURY],
    ['Surgery', AvailabilityKind.INJURY],
    ['Broken Leg', AvailabilityKind.INJURY],
    ['Health problems', AvailabilityKind.INJURY],
    ['Illness', AvailabilityKind.INJURY],
    ['Virus', AvailabilityKind.INJURY],
    ['Hamstring', AvailabilityKind.INJURY],
    ['Inactive', AvailabilityKind.OTHER],
    ['Personal Reasons', AvailabilityKind.OTHER],
    ['Lacking Match Fitness', AvailabilityKind.OTHER],
    ['', AvailabilityKind.OTHER],
  ])('maps reason %j', (reason, kind) => {
    expect(availabilityKindFor(reason)).toBe(kind);
  });
});

describe('decodeInjuries', () => {
  it('decodes a real league response into one row per player and fixture', () => {
    const out = decodeInjuries(fixture('injuries-league-88-2026.json'), {
      leagueId: 88,
      season: 2026,
      fetchedAtMs: FETCHED,
    });
    expect(out.entries).toBe(6);
    expect(out.dropped).toBe(0);
    expect(out.providerErrors).toBeUndefined();
    expect(out.rows).toHaveLength(6);
    const moslih = out.rows.find((row) => row.providerPlayerId === '528298');
    expect(moslih).toMatchObject({
      source: AvailabilitySource.INJURIES,
      providerTeamId: '413',
      providerFixtureId: '1552118',
      providerCompetitionId: '88',
      seasonYear: 2026,
      status: AvailabilityStatus.OUT,
      kind: AvailabilityKind.INJURY,
      reason: 'Injury',
      startDate: '2026-08-08',
      endDate: '',
    });
    expect(moslih?.playerSnapshot?.label).toBe('Y. Moslih');
    expect(moslih?.teamSnapshot?.label).toBe('NEC Nijmegen');
    expect(timestampMs(moslih!.fixtureAt!)).toBe(1786199400 * 1_000);
    expect(timestampMs(moslih!.fetchedAt!)).toBe(FETCHED);
    const red = out.rows.find((row) => row.reason === 'Red Card');
    expect(red?.kind).toBe(AvailabilityKind.SUSPENSION);
    expect(out.sightings).toContainEqual({
      providerPlayerId: '528298',
      fixtureAtMs: 1786199400_000,
    });
  });

  it('drops placeholder, id-less and other-league rows, and reads Questionable as doubtful', () => {
    const row = (player: Record<string, unknown>, fixtureId: unknown = 1, league = 88) => ({
      player: { type: 'Questionable', reason: 'Knock', ...player },
      team: { id: 5 },
      fixture: { id: fixtureId, date: '2026-11-08T14:30:00+00:00', timestamp: null },
      league: { id: league },
    });
    const out = decodeInjuries(
      {
        errors: [],
        response: [
          row({ id: 10, name: 'A' }),
          row({ id: 0, name: 'Zero' }),
          row({ id: null, name: 'Null' }),
          row({ id: 11, name: 'Data not available' }),
          row({ id: 12, name: 'No fixture' }, null),
          row({ id: 13, name: 'Other league' }, 1, 39),
        ],
      },
      { leagueId: 88, season: 2026, fetchedAtMs: FETCHED }
    );
    expect(out.rows.map((r) => r.providerPlayerId)).toEqual(['10']);
    expect(out.dropped).toBe(5);
    expect(out.rows[0]?.status).toBe(AvailabilityStatus.DOUBTFUL);
    // No timestamp: the ISO date gives the kickoff.
    expect(out.rows[0]?.startDate).toBe('2026-11-08');
    expect(timestampMs(out.rows[0]!.fixtureAt!)).toBe(Date.parse('2026-11-08T14:30:00+00:00'));
  });

  it('reports provider errors on a 200 reply', () => {
    const out = decodeInjuries(
      { errors: { rateLimit: 'Too many requests' }, response: [] },
      { leagueId: 88, season: 2026, fetchedAtMs: FETCHED }
    );
    expect(out.rows).toHaveLength(0);
    expect(out.providerErrors).toContain('rateLimit');
  });
});

describe('decodeSidelined', () => {
  it('decodes grouped spells, an open spell has no end date', () => {
    const out = decodeSidelined(fixture('sidelined-players.json'), { fetchedAtMs: FETCHED });
    expect(out.subjectsAnswered).toBe(2);
    expect(out.rows).toHaveLength(6);
    const open = out.rows.find((r) => r.providerPlayerId === '276' && r.endDate === '');
    expect(open).toMatchObject({
      source: AvailabilitySource.SIDELINED,
      providerTeamId: '',
      providerFixtureId: '',
      providerCompetitionId: '',
      seasonYear: 0,
      status: AvailabilityStatus.OUT,
      kind: AvailabilityKind.INJURY,
      reason: 'Thigh Injury',
      startDate: '2025-09-19',
    });
    expect(open?.fixtureAt).toBeUndefined();
  });

  it('drops spells with no valid start and entries with no id', () => {
    const out = decodeSidelined(
      {
        errors: [],
        response: [
          { id: 9, sidelined: [{ type: 'Suspended', start: '2026-02-30', end: null }] },
          { id: 9, sidelined: [{ type: 'Suspended', start: '2026-02-03', end: '2026-02-10' }] },
          { id: null, sidelined: [{ type: 'Virus', start: '2026-01-01', end: null }] },
        ],
      },
      { fetchedAtMs: FETCHED }
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      kind: AvailabilityKind.SUSPENSION,
      startDate: '2026-02-03',
      endDate: '2026-02-10',
    });
    expect(out.dropped).toBe(2);
  });
});

describe('decodeTransfers', () => {
  it('keeps fee text raw and a missing club as an empty id', () => {
    const out = decodeTransfers(fixture('transfers-team-194.json'), { fetchedAtMs: FETCHED });
    expect(out.entries).toBe(3);
    expect(out.dropped).toBe(0);
    const free = out.rows.find((r) => r.providerPlayerId === '116223' && r.feeText === 'Free');
    expect(free).toMatchObject({
      transferDate: '2002-01-01',
      providerTeamInId: '',
      providerTeamOutId: '194',
    });
    expect(free?.playerSnapshot?.label).toBe('Mitchell Piqué');
    expect(free?.teamOutSnapshot?.label).toBe('Ajax');
    expect(out.rows.some((r) => r.feeText.startsWith('€'))).toBe(true);
  });

  it('stores a null type as an empty fee and drops bad rows', () => {
    const out = decodeTransfers(
      {
        errors: [],
        response: [
          {
            player: { id: 7, name: 'P' },
            transfers: [
              { date: '2024-07-01', type: null, teams: { in: { id: 1 }, out: { id: 2 } } },
              { date: 'unknown', type: 'Loan', teams: { in: { id: 1 }, out: { id: 2 } } },
            ],
          },
          { player: { id: 0, name: 'Zero' }, transfers: [{ date: '2024-07-01' }] },
          { player: { id: 8, name: 'Data not available' }, transfers: [] },
        ],
      },
      { fetchedAtMs: FETCHED }
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.feeText).toBe('');
    expect(out.dropped).toBe(3);
  });
});

describe('decodeTrophies', () => {
  it('decodes grouped trophies per player; a null season is kept as empty', () => {
    const names = new Map([['276', 'Neymar']]);
    const out = decodeTrophies(fixture('trophies-players.json'), {
      subject: 'player',
      fetchedAtMs: FETCHED,
      names,
    });
    expect(out.rows.map((r) => r.providerSubjectId)).toEqual(['276', '874']);
    const neymar = out.rows[0]!;
    expect(neymar.subjectType).toBe(SubjectType.PLAYER);
    expect(neymar.subjectSnapshot?.label).toBe('Neymar');
    expect(neymar.clearScope).toBe(false);
    expect(neymar.trophies.length).toBe(5);
    expect(neymar.trophies.some((t) => t.seasonText === '')).toBe(true);
    expect(neymar.trophies[1]).toMatchObject({
      competitionName: 'Paulista A1',
      country: 'Brazil',
      seasonText: '2012',
      place: 'Winner',
    });
    expect(out.rows[1]?.subjectSnapshot).toBeUndefined();
  });

  it('clears on an explicit empty list only, and drops nameless entries', () => {
    const out = decodeTrophies(
      {
        errors: [],
        response: [
          { id: 1, trophies: [] },
          { id: 2, trophies: [{ league: null, country: 'X', season: '2020', place: 'Winner' }] },
          { id: null, trophies: [] },
        ],
      },
      { subject: 'coach', fetchedAtMs: FETCHED }
    );
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({ providerSubjectId: '1', clearScope: true });
    expect(out.rows[0]?.subjectType).toBe(SubjectType.COACH);
    // Every entry dropped is not the provider saying "none".
    expect(out.rows[1]).toMatchObject({ providerSubjectId: '2', clearScope: false });
    expect(out.rows[1]?.trophies).toHaveLength(0);
    expect(out.dropped).toBe(2);
  });
});

describe('decodeSquadPlayerIds', () => {
  it('returns unique valid player ids and names in squad order', () => {
    const out = decodeSquadPlayerIds({
      errors: [],
      response: [
        {
          team: { id: 194 },
          players: [
            { id: 3, name: 'C' },
            { id: 1, name: 'A' },
            { id: 3, name: 'C again' },
            { id: 0, name: 'Zero' },
            { id: 4, name: 'Data not available' },
          ],
        },
      ],
    });
    expect(out.playerIds).toEqual(['3', '1']);
    expect(out.names.get('3')).toBe('C');
  });
});
