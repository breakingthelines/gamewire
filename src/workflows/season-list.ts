/**
 * Season fixture-list helpers shared by season-backfill's full mode and its
 * history modes (`season-history.ts`): reading a `/fixtures?league&season`
 * envelope, resolving its teams through identity, and the rate-limit
 * back-off schedule.
 */
import { create } from '@bufbuild/protobuf';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import type { WorkflowDeps } from './types.js';

export const seasonFixturesPath = (leagueId: number, season: number): string =>
  `/fixtures?league=${leagueId}&season=${season}`;

/**
 * Back-off before each retry of a call the provider or the minute limiter
 * refused for rate (`rate_limited`). The provider refuses short bursts with
 * "too many requests ... per minute", so a refusal says more about the
 * second it landed in than about the minute: retry soon, then back off. After
 * the last wait the fixture is held and the cursor stays on it.
 */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Finalised provider statuses. Only these fixtures carry a settled
 * scoreline + timeline + lineup worth importing; scheduled/postponed/
 * cancelled fixtures are skipped (they have nothing to ingest and would
 * waste budget). WO = walkover, AWD = technical/awarded result.
 */
export const FINALISED_STATUSES = new Set(['FT', 'AET', 'PEN', 'WO', 'AWD']);

export const resolveTeam = async (
  deps: WorkflowDeps,
  providerTeamId: string
): Promise<'resolved' | 'unresolved' | 'error'> => {
  if (!deps.identity) {
    return 'error';
  }
  try {
    const response = await deps.identity.resolve(
      create(ResolveRequestSchema, {
        entityType: EntityType.TEAM,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId: providerTeamId,
      })
    );
    return response.found && response.entityId ? 'resolved' : 'unresolved';
  } catch {
    return 'error';
  }
};

export const listedFixtureCount = (data: unknown): number =>
  isRecord(data) && Array.isArray(data.response) ? data.response.length : 0;

/** Distinct home and away teams of a season list, in first-seen order. */
export const seasonTeams = (data: unknown): readonly { id: string; name: string }[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const seen = new Map<string, string>();
  for (const item of data.response) {
    const teams = isRecord(item) && isRecord(item.teams) ? item.teams : undefined;
    if (!teams) {
      continue;
    }
    for (const side of [teams.home, teams.away]) {
      if (!isRecord(side)) {
        continue;
      }
      const id =
        typeof side.id === 'number' && Number.isFinite(side.id)
          ? String(side.id)
          : typeof side.id === 'string'
            ? side.id.trim()
            : '';
      if (id === '' || seen.has(id)) {
        continue;
      }
      seen.set(id, typeof side.name === 'string' ? side.name : '');
    }
  }
  return [...seen].map(([id, name]) => ({ id, name }));
};

/**
 * Extract the provider fixture ids of FINALISED fixtures from a
 * `/fixtures?league&season` envelope, preserving provider order and
 * de-duplicating. Mirrors the daily-anchor `extractFixtureItems` shape
 * (response[].fixture.{id,status.short}) but keeps only settled
 * fixtures — the only ones with a timeline/lineup worth importing.
 */
export const finalisedFixtureIds = (data: unknown): readonly string[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data.response) {
    if (!isRecord(item)) {
      continue;
    }
    const fixture = isRecord(item.fixture) ? item.fixture : undefined;
    if (!fixture) {
      continue;
    }
    const rawId = fixture.id;
    const fixtureId =
      typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === 'string'
          ? rawId.trim()
          : '';
    if (fixtureId === '') {
      continue;
    }
    const status = isRecord(fixture.status) ? String(fixture.status.short ?? '').toUpperCase() : '';
    if (!FINALISED_STATUSES.has(status)) {
      continue;
    }
    ids.add(fixtureId);
  }
  return [...ids];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every fixture id of a season list, any status, in provider order. */
export const listedFixtureIds = (data: unknown): readonly string[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data.response) {
    const fixture = isRecord(item) && isRecord(item.fixture) ? item.fixture : undefined;
    const rawId = fixture?.id;
    const id =
      typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === 'string'
          ? rawId.trim()
          : '';
    if (id !== '') {
      ids.add(id);
    }
  }
  return [...ids];
};
