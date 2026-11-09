/**
 * GW-6c decoder: team season stats. The fixture is a real
 * `/teams/statistics?league=39&season=2026&team=33` response (API-Football,
 * 2026-11-09).
 */
import { readFileSync } from 'node:fs';

import { timestampMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';

import {
  TEAM_SEASON_STAT_KEYS,
  apiFootballTeamStatisticsPath,
  decodeTeamSeasonStats,
} from './enrichment-decoders.js';

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const FETCHED = Date.UTC(2026, 10, 9, 3, 0, 0);
const options = { leagueId: 39, season: 2026, teamId: '33', fetchedAtMs: FETCHED } as const;

describe('decodeTeamSeasonStats', () => {
  it('builds the path', () => {
    expect(apiFootballTeamStatisticsPath(39, 2026, '33')).toBe(
      '/teams/statistics?league=39&season=2026&team=33'
    );
  });

  it('maps the captured response to TeamSeasonStats keys and form', () => {
    const decoded = decodeTeamSeasonStats(load('teams-statistics-39-2026-33.json'), options);
    expect(decoded).toMatchObject({ entries: 1, dropped: 0, providerErrors: undefined });
    expect(decoded.rows).toHaveLength(1);
    const row = decoded.rows[0]!;
    expect(row).toMatchObject({
      providerTeamId: '33',
      providerCompetitionId: '39',
      seasonYear: 2026,
      form: 'LWDLDDDLLD',
    });
    expect(row.teamSnapshot).toMatchObject({
      label: 'Manchester United',
      imageUrl: 'https://media.api-sports.io/football/teams/33.png',
    });
    expect(row.values).toEqual({
      matches_played: 10,
      wins: 1,
      draws: 5,
      losses: 4,
      goals_for: 14,
      goals_against: 19,
      clean_sheets: 0,
      failed_to_score: 4,
      penalties_scored: 2,
      penalties_missed: 0,
    });
    expect(timestampMs(row.fetchedAt!)).toBe(FETCHED);
  });

  it('every key it writes is in the documented key list', () => {
    const keys = new Set(TEAM_SEASON_STAT_KEYS.map(([key]) => key));
    const row = decodeTeamSeasonStats(load('teams-statistics-39-2026-33.json'), options).rows[0]!;
    for (const key of Object.keys(row.values)) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it('leaves a provider null out of values (null is not 0) and keeps form empty for null', () => {
    const envelope = load('teams-statistics-39-2026-33.json');
    const response = structuredClone(envelope.response) as Record<string, any>;
    response.clean_sheet.total = null;
    response.penalty = null;
    response.fixtures.loses = { home: null, away: null, total: null };
    response.form = null;
    const row = decodeTeamSeasonStats({ ...envelope, response }, options).rows[0]!;
    expect(row.values).not.toHaveProperty('clean_sheets');
    expect(row.values).not.toHaveProperty('penalties_scored');
    expect(row.values).not.toHaveProperty('losses');
    expect(row.values.wins).toBe(1);
    expect(row.form).toBe('');
  });

  it('returns no row for an empty response, with the provider errors', () => {
    expect(decodeTeamSeasonStats({ errors: [], response: [] }, options)).toMatchObject({
      rows: [],
      entries: 0,
      dropped: 0,
    });
    const failed = decodeTeamSeasonStats(
      { errors: { requests: 'You have reached the request limit' }, response: [] },
      options
    );
    expect(failed.rows).toEqual([]);
    expect(failed.providerErrors).toContain('request limit');
  });

  it('drops an answer for another team, league or season', () => {
    const envelope = load('teams-statistics-39-2026-33.json');
    for (const other of [
      { ...options, teamId: '34' },
      { ...options, leagueId: 40 },
      { ...options, season: 2025 },
    ]) {
      expect(decodeTeamSeasonStats(envelope, other)).toMatchObject({
        rows: [],
        entries: 1,
        dropped: 1,
      });
    }
  });
});
