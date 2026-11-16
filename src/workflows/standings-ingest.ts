/**
 * Shared `/standings` ingest: resolve + map + push a standings envelope into
 * game-service's `football_standings` table via `IngestFootballStandings`.
 *
 * Used by daily-anchor (current season, every run) and season-backfill
 * (each backfilled season once). The `/standings` payload is not a fixture
 * list, so it is fetched under the `competition-standings` workload, outside
 * the ingest bridge's `BRIDGE_WORKLOADS`, and ingested here.
 *
 * The competition and each team are resolved to canonical ids through
 * identity. The canonical `competition_id` is what makes the row
 * discoverable (`GetCompetitionStandings` filters by competition id alone).
 * Team ids fall back to provider-storage ids (game-service re-resolves at
 * read time). Seasons are never resolved: game-service binds them
 * (season_id_bindings, forward-only), so rows carry the provider-storage
 * season id, the same one the games carry.
 *
 * Never throws: a standings failure must not poison the caller's sweep.
 */
import { create } from '@bufbuild/protobuf';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import {
  API_FOOTBALL_PROVIDER_ID,
  apiFootballIngestStandingsRequestFromStandings,
  type ApiFootballEntityResolutionMap,
  type ApiFootballResolvedEntity,
} from '../adapters/api-football/index.js';
import type { FootballGameIngestClient } from '../worker/clients/game-service.js';
import type { FootballIdentityLookupClient } from '../worker/clients/identity.js';
import type { IngestionWorkload } from '../worker/ingestion.js';

/** The workload every `/standings` fetch uses. Not a bridge workload. */
export const STANDINGS_WORKLOAD: IngestionWorkload = 'competition-standings';

/** Resource id of a league-season's standings (the ingestion loop parses this shape). */
export const standingsResourceId = (leagueId: number, season: number): string =>
  `standings-${leagueId}-${season}`;

export const standingsPath = (leagueId: number, season: number): string =>
  `/standings?league=${leagueId}&season=${season}`;

export interface StandingsEnvelopeIngestInput {
  readonly leagueId: number;
  readonly resourceId: string;
  readonly data: unknown;
  readonly gameService?: Pick<FootballGameIngestClient, 'ingestFootballStandings'>;
  readonly identity?: FootballIdentityLookupClient;
  readonly nowMs?: number;
}

export type StandingsIngestOutcome =
  | {
      readonly status: 'ingested';
      readonly tables: number;
      readonly accepted: number;
      readonly updated: number;
    }
  | { readonly status: 'empty'; readonly tables: 0 }
  | { readonly status: 'not-wired'; readonly tables: 0 }
  | { readonly status: 'error'; readonly tables: number; readonly message: string };

/** Map and ingest one `/standings` envelope. */
export const ingestStandingsEnvelope = async (
  input: StandingsEnvelopeIngestInput
): Promise<StandingsIngestOutcome> => {
  if (!input.gameService) {
    return { status: 'not-wired', tables: 0 };
  }
  const entityResolutions = await resolveStandingsEntities(
    input.identity,
    input.leagueId,
    input.data
  );
  const request = apiFootballIngestStandingsRequestFromStandings({
    replayId: `live:${STANDINGS_WORKLOAD}:${input.resourceId}`,
    resourceId: input.resourceId,
    envelope: input.data,
    entityResolutions,
    fetchedAtMs: input.nowMs ?? Date.now(),
  });
  if (request.standings.length === 0) {
    return { status: 'empty', tables: 0 };
  }
  try {
    const response = await input.gameService.ingestFootballStandings(request);
    return {
      status: 'ingested',
      tables: request.standings.length,
      accepted: response.acceptedCount,
      updated: response.updatedCount,
    };
  } catch (err) {
    return {
      status: 'error',
      tables: request.standings.length,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * Build an {@link ApiFootballEntityResolutionMap} for a `/standings` envelope:
 * the competition is resolved once from the provider league id, and every
 * team appearing in any standings group is resolved by its provider team id.
 * Seasons are never resolved (game-service binds them). Identity misses leave
 * the bucket empty and the mapper falls back to provider-storage ids. Returns
 * an empty map when no identity client is wired.
 */
const resolveStandingsEntities = async (
  identity: FootballIdentityLookupClient | undefined,
  leagueId: number,
  data: unknown
): Promise<ApiFootballEntityResolutionMap> => {
  const competitions: Record<string, ApiFootballResolvedEntity | undefined> = {};
  const seasons: Record<string, ApiFootballResolvedEntity | undefined> = {};
  const teams: Record<string, ApiFootballResolvedEntity | undefined> = {};
  if (!identity) {
    return { competitions, seasons, teams, players: {} };
  }

  const league = String(leagueId);
  const competitionResolved = await resolveApiFootballEntity(
    identity,
    EntityType.COMPETITION,
    league
  );
  if (competitionResolved) {
    competitions[league] = competitionResolved;
  }

  for (const providerTeamId of standingsTeamProviderIds(data)) {
    if (teams[providerTeamId] !== undefined) {
      continue;
    }
    teams[providerTeamId] = await resolveApiFootballEntity(
      identity,
      EntityType.TEAM,
      providerTeamId
    );
  }

  return { competitions, seasons, teams, players: {} };
};

/**
 * Resolve one API-Football entity through identity. An identity miss or error
 * returns `undefined`, so callers fall back to a provider-storage id.
 */
export const resolveApiFootballEntity = async (
  identity: FootballIdentityLookupClient,
  entityType: EntityType,
  providerId: string
): Promise<ApiFootballResolvedEntity | undefined> => {
  if (providerId === '') {
    return undefined;
  }
  try {
    const response = await identity.resolve(
      create(ResolveRequestSchema, {
        entityType,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId,
      })
    );
    if (response.found && response.entityId) {
      return { entityId: response.entityId };
    }
  } catch {
    // Identity outage or miss: leave unresolved.
  }
  return undefined;
};

/**
 * Collect the distinct provider team ids appearing across every group of a
 * `/standings` envelope (`response[].league.standings[][].team.id`).
 */
export const standingsTeamProviderIds = (data: unknown): readonly string[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data.response) {
    if (!isRecord(item) || !isRecord(item.league)) {
      continue;
    }
    const groups = (item.league as { standings?: unknown }).standings;
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const entry of group) {
        if (!isRecord(entry) || !isRecord(entry.team)) {
          continue;
        }
        const id = (entry.team as { id?: unknown }).id;
        if ((typeof id === 'number' && Number.isFinite(id)) || typeof id === 'string') {
          const str = String(id).trim();
          if (str !== '' && str !== '0') {
            ids.add(str);
          }
        }
      }
    }
  }
  return [...ids];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
