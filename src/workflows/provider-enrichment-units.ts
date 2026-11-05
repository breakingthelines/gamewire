/**
 * GW-6b provider enrichment datasets: player availability (injuries and
 * sidelined spells), transfers and trophies.
 *
 * They run on the GW-6a endpoint (`POST /workflows/provider-enrichment`) and
 * under the same rules as `player-season-stats`:
 * - Kill switch: a dataset runs only when `GAMEWIRE_ENRICHMENT_DATASETS` names it.
 * - Explicit scope (verdict D15): league-seasons, teams or players come from
 *   the request or from the catalogue, never from a season's end date.
 * - No bulk caching (D9): every provider call bypasses the cache and its rows
 *   go straight to the GS-2 ingest RPC. What is kept in Redis is a small
 *   "done" marker per unit and, for injuries, a digest of the player ids
 *   listed in the last 30 days (the sidelined scope).
 * - Background priority (D5) through the provider-wide limiter, the shared
 *   enrichment minute limiter in front of it, and a per-run call limit.
 *
 * Work is split into units. A unit is one league-season (injuries), one team
 * (transfers, or a squad plus its players' trophies) or a batch of up to 20
 * player or coach ids (sidelined, trophies). A completed unit writes its
 * marker; a re-run inside the marker window reports it `fresh` and fetches
 * nothing, so a run stopped by the call limit resumes where it stopped.
 */
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';

import {
  IngestAvailabilityRequestSchema,
  IngestMetadataSchema,
  IngestTransfersRequestSchema,
  IngestTrophiesRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  AvailabilityReplaceScopeSchema,
  AvailabilitySource,
  type AvailabilityRow,
  type TransferRow,
  type TrophyRow,
} from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import {
  PROVIDER_MULTI_ID_MAX,
  apiFootballInjuriesLeaguePath,
  apiFootballSidelinedPath,
  apiFootballSquadPath,
  apiFootballTransfersPath,
  apiFootballTrophiesPath,
  decodeInjuries,
  decodeSidelined,
  decodeSquadPlayerIds,
  decodeTransfers,
  decodeTrophies,
  parseProviderId,
  type InjuriesPlayerSighting,
} from '../adapters/api-football/enrichment-decoders.js';
import type { ProviderCache } from '../worker/cache.js';
import type { ProviderEnrichmentIngestClient } from '../worker/clients/game-service.js';
import type { IngestionWorkload } from '../worker/ingestion.js';
import { teamIdsFromFixtureListEnvelope } from './squad-sweep.js';
import type {
  CompetitionEntry,
  ProviderEnrichmentDataset,
  ProviderEnrichmentInput,
  WorkflowDeps,
  WorkflowLogEntry,
} from './types.js';

/** The datasets this module runs. */
export type UnitEnrichmentDataset = Exclude<ProviderEnrichmentDataset, 'player-season-stats'>;

export const UNIT_ENRICHMENT_DATASETS: readonly UnitEnrichmentDataset[] = [
  'injuries-league',
  'player-sidelined',
  'team-transfers',
  'trophies',
];

export const isUnitEnrichmentDataset = (
  dataset: ProviderEnrichmentDataset
): dataset is UnitEnrichmentDataset =>
  (UNIT_ENRICHMENT_DATASETS as readonly string[]).includes(dataset);

/**
 * Leagues whose current season has `coverage.injuries` (API-Football
 * `/leagues?current=true`, 2026-11-04): 15 of the 40 Mega leagues. The
 * injuries default scope is this set intersected with the catalogue. A
 * league-coverage dataset (spec GW-6) would replace this snapshot; until then
 * a league that gains coverage is added here or named in `leagueIds`.
 */
export const INJURIES_COVERED_LEAGUE_IDS: ReadonlySet<number> = new Set([
  1, 2, 3, 31, 32, 39, 40, 61, 71, 78, 88, 135, 140, 203, 253,
]);

/** Catalogue tiers whose teams make up the transfers and trophies team scope. */
const TEAM_SCOPE_TIERS: ReadonlySet<CompetitionEntry['tier']> = new Set([
  'domestic-top-five',
  'domestic-league',
]);

/**
 * Default provider calls per run, sized to one scheduled run of each dataset
 * at the Mega catalogue (see `call-budget.ts`): injuries 15 league-seasons,
 * sidelined about 60 batches, transfers about 415 teams, trophies a quarter
 * of the teams (about 104 squads plus about 160 trophy batches).
 */
export const DEFAULT_UNIT_MAX_CALLS_PER_RUN: Readonly<Record<UnitEnrichmentDataset, number>> = {
  'injuries-league': 60,
  'player-sidelined': 300,
  'team-transfers': 500,
  trophies: 600,
};

/**
 * How long a completed unit counts as fresh. Injuries are pulled every 3h by
 * the K-2 schedule, so 2.5h keeps a retry from repeating a pull without
 * blocking the next scheduled one. The weekly datasets use 6 days. A `full`
 * injuries run (history) keeps its league-seasons for 30 days.
 */
export const UNIT_MARKER_WINDOW_SECONDS: Readonly<
  Record<UnitEnrichmentDataset, { readonly nightly: number; readonly full: number }>
> = {
  'injuries-league': { nightly: 2.5 * 60 * 60, full: 30 * 24 * 60 * 60 },
  'player-sidelined': { nightly: 6 * 24 * 60 * 60, full: 6 * 24 * 60 * 60 },
  'team-transfers': { nightly: 6 * 24 * 60 * 60, full: 6 * 24 * 60 * 60 },
  trophies: { nightly: 6 * 24 * 60 * 60, full: 6 * 24 * 60 * 60 },
};

/** Players listed in an injuries pull this recently are in the sidelined scope. */
export const SIDELINED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
/** The injuries player digest outlives the lookback by a day. */
const INJURY_DIGEST_TTL_SECONDS = 31 * 24 * 60 * 60;
/** Trophies partitions: every team comes round once every four weeks. */
export const TROPHIES_PARTITIONS = 4;

/** Rows per ingest call (GS-2 rejects larger batches). */
export const UNIT_INGEST_BATCH_SIZE = 500;

export const unitMarkerKey = (dataset: UnitEnrichmentDataset, unit: string): string =>
  `enrich:${dataset}:done:${unit}`;

/** Small digest written by each injuries pull: provider player id to latest kickoff (ms). */
export interface InjuryPlayerDigest {
  readonly players: Readonly<Record<string, number>>;
}

export const injuryDigestKey = (leagueId: number, season: number): string =>
  `enrich:injuries-league:players:${leagueId}:${season}`;

/** The marker a completed unit leaves. */
export interface UnitMarker {
  readonly completedAtMs: number;
}

/** What a provider call gave back to a unit. */
export type UnitFetch =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly stopped: true }
  | { readonly ok: false; readonly stopped: false; readonly message: string };

export interface UnitContext {
  /** One provider call at background priority with the cache bypassed. */
  readonly fetch: (args: {
    readonly workload: IngestionWorkload;
    readonly resourceId: string;
    readonly path: string;
  }) => Promise<UnitFetch>;
  readonly ingest: ProviderEnrichmentIngestClient;
  readonly cache: ProviderCache;
  readonly clockMs: () => number;
  readonly nowMs: number;
  readonly log: (entry: Omit<WorkflowLogEntry, 'workflow'>) => void;
}

export interface UnitOutcome {
  /**
   * - `complete`: every call of the unit succeeded and its rows were written.
   * - `partial`: the run stopped (limit, quota, minute limiter) inside the unit.
   * - `failed`: a call or an ingest failed; the unit is retried next run.
   */
  readonly status: 'complete' | 'partial' | 'failed';
  /** Provider calls the unit made. */
  readonly calls: number;
  /** Provider calls the unit needed, as far as it got. */
  readonly callsPlanned: number;
  readonly rowsIngested: number;
  readonly rowsDropped: number;
  readonly errors: readonly string[];
}

export interface EnrichmentUnit {
  /** Stable name, used for the marker and the in-flight guard. */
  readonly key: string;
  readonly leagueId: number;
  readonly season: number;
  readonly run: (ctx: UnitContext) => Promise<UnitOutcome>;
}

export interface UnitPlan {
  readonly units: readonly EnrichmentUnit[];
  /** Why there is nothing to do, when `units` is empty. */
  readonly emptyReason?: string;
  /** Ingest method the dataset needs. */
  readonly needs: 'ingestAvailability' | 'ingestTransfers' | 'ingestTrophies';
}

/**
 * Build the units for a dataset. Reads only the catalogue, cached fixture
 * lists (team scope) and the injuries digest (sidelined scope): no provider call.
 */
export const planUnitDataset = async (
  dataset: UnitEnrichmentDataset,
  input: ProviderEnrichmentInput,
  deps: WorkflowDeps,
  nowMs: number
): Promise<UnitPlan> => {
  switch (dataset) {
    case 'injuries-league':
      return planInjuries(input, deps.competitions);
    case 'player-sidelined':
      return planSidelined(input, deps, nowMs);
    case 'team-transfers':
      return planTransfers(input, deps);
    case 'trophies':
      return planTrophies(input, deps, nowMs);
  }
};

// ── scope ─────────────────────────────────────────────────────────────────

interface LeagueSeason {
  readonly leagueId: number;
  readonly season: number;
}

/**
 * Injuries league-seasons. `full` takes `leagueIds` x `seasons` as given.
 * `nightly` covers `leagueIds` (default: catalogue leagues with injuries
 * coverage) at `seasons` (default: each league's catalogue season).
 */
export const resolveInjuriesTargets = (
  input: Pick<ProviderEnrichmentInput, 'mode' | 'leagueIds' | 'seasons'>,
  competitions: readonly CompetitionEntry[]
): readonly LeagueSeason[] => {
  const leagueIds = uniquePositiveInts(input.leagueIds ?? []);
  const seasons = uniquePositiveInts(input.seasons ?? []).sort((a, b) => b - a);
  if (input.mode === 'full') {
    return seasons.flatMap((season) => leagueIds.map((leagueId) => ({ leagueId, season })));
  }
  const catalogue = new Map(competitions.map((entry) => [entry.apiFootballLeagueId, entry]));
  const leagues =
    leagueIds.length > 0
      ? leagueIds
      : competitions
          .map((entry) => entry.apiFootballLeagueId)
          .filter((id) => INJURIES_COVERED_LEAGUE_IDS.has(id));
  const targets: LeagueSeason[] = [];
  for (const leagueId of uniquePositiveInts(leagues)) {
    if (seasons.length > 0) {
      targets.push(...seasons.map((season) => ({ leagueId, season })));
      continue;
    }
    const entry = catalogue.get(leagueId);
    if (entry) {
      targets.push({ leagueId, season: entry.season });
    }
  }
  return targets;
};

/**
 * Team scope for transfers and trophies: `teamIds` when given, else every
 * team in the cached fixture lists of the catalogue's domestic leagues (or of
 * `leagueIds`). The fixture lists are the daily-anchor discovery payloads the
 * squad sweep also reads, so this costs no provider call. Sorted numerically.
 */
export const resolveTeamScope = async (
  input: Pick<ProviderEnrichmentInput, 'teamIds' | 'leagueIds'>,
  deps: WorkflowDeps
): Promise<readonly string[]> => {
  if (input.teamIds && input.teamIds.length > 0) {
    return sortIds(input.teamIds);
  }
  const leagueFilter = new Set(uniquePositiveInts(input.leagueIds ?? []));
  const entries = deps.competitions.filter((entry) =>
    leagueFilter.size > 0
      ? leagueFilter.has(entry.apiFootballLeagueId)
      : TEAM_SCOPE_TIERS.has(entry.tier)
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = deps.ingestion.cacheKeyFor(
      'fixtures-next-7d',
      `league-${entry.apiFootballLeagueId}-season-${entry.season}`
    );
    const cached = await deps.ingestion.cache.get<unknown>(key);
    if (cached === undefined) {
      continue;
    }
    for (const id of teamIdsFromFixtureListEnvelope(cached)) {
      seen.add(id);
    }
  }
  return sortIds([...seen]);
};

/** ISO-8601 week number (1 to 53) of a UTC instant. */
export const isoWeekNumber = (ms: number): number => {
  const date = new Date(ms);
  const day = date.getUTCDay() || 7;
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - yearStart) / 86_400_000 / 7) + 1;
};

/** The trophies partition for a run: the request's, else ISO week mod 4. */
export const trophiesPartition = (partition: number | undefined, nowMs: number): number =>
  partition !== undefined ? partition : isoWeekNumber(nowMs) % TROPHIES_PARTITIONS;

/** Players listed in the injuries digests within the lookback, sorted. */
export const sidelinedScopeFromDigests = async (
  cache: ProviderCache,
  targets: readonly LeagueSeason[],
  nowMs: number
): Promise<readonly string[]> => {
  const since = nowMs - SIDELINED_LOOKBACK_MS;
  const ids = new Set<string>();
  for (const target of targets) {
    const digest = await cache.get<InjuryPlayerDigest>(
      injuryDigestKey(target.leagueId, target.season)
    );
    for (const [id, lastMs] of Object.entries(digest?.players ?? {})) {
      if (typeof lastMs === 'number' && lastMs >= since) {
        ids.add(id);
      }
    }
  }
  return sortIds([...ids]);
};

/** Merge one pull's sightings into the stored digest, dropping players past the lookback. */
export const mergeInjuryDigest = (
  previous: InjuryPlayerDigest | undefined,
  sightings: readonly InjuriesPlayerSighting[],
  nowMs: number
): InjuryPlayerDigest => {
  const since = nowMs - SIDELINED_LOOKBACK_MS;
  const players: Record<string, number> = {};
  const put = (id: string, ms: number) => {
    if (ms >= since && (players[id] === undefined || players[id] < ms)) {
      players[id] = ms;
    }
  };
  for (const [id, ms] of Object.entries(previous?.players ?? {})) {
    if (typeof ms === 'number') {
      put(id, ms);
    }
  }
  for (const sighting of sightings) {
    put(sighting.providerPlayerId, sighting.fixtureAtMs);
  }
  return { players };
};

// ── plans ─────────────────────────────────────────────────────────────────

const planInjuries = (
  input: ProviderEnrichmentInput,
  competitions: readonly CompetitionEntry[]
): UnitPlan => {
  const targets = resolveInjuriesTargets(input, competitions);
  return {
    needs: 'ingestAvailability',
    units: targets.map((target) => injuriesUnit(target)),
    emptyReason: 'no league-seasons with injuries coverage',
  };
};

const planSidelined = async (
  input: ProviderEnrichmentInput,
  deps: WorkflowDeps,
  nowMs: number
): Promise<UnitPlan> => {
  const playerIds =
    input.playerIds && input.playerIds.length > 0
      ? sortIds(input.playerIds)
      : await sidelinedScopeFromDigests(
          deps.ingestion.cache,
          resolveInjuriesTargets({ ...input, mode: 'nightly' }, deps.competitions),
          nowMs
        );
  return {
    needs: 'ingestAvailability',
    units: chunk(playerIds, PROVIDER_MULTI_ID_MAX).map((ids) => sidelinedUnit(ids)),
    emptyReason:
      'no players listed by injuries-league in the last 30 days; run injuries-league or pass playerIds',
  };
};

const planTransfers = async (
  input: ProviderEnrichmentInput,
  deps: WorkflowDeps
): Promise<UnitPlan> => {
  const teams = await resolveTeamScope(input, deps);
  return {
    needs: 'ingestTransfers',
    units: teams.map((teamId) => transfersUnit(teamId)),
    emptyReason: 'no teams: the catalogue fixture lists are not cached; pass teamIds',
  };
};

const planTrophies = async (
  input: ProviderEnrichmentInput,
  deps: WorkflowDeps,
  nowMs: number
): Promise<UnitPlan> => {
  const units: EnrichmentUnit[] = [];
  const explicitPlayers = sortIds(input.playerIds ?? []);
  const explicitCoaches = sortIds(input.coachIds ?? []);
  for (const ids of chunk(explicitPlayers, PROVIDER_MULTI_ID_MAX)) {
    units.push(trophiesUnit('player', ids));
  }
  for (const ids of chunk(explicitCoaches, PROVIDER_MULTI_ID_MAX)) {
    units.push(trophiesUnit('coach', ids));
  }
  if (explicitPlayers.length > 0 || explicitCoaches.length > 0) {
    return { needs: 'ingestTrophies', units };
  }
  const teams = await resolveTeamScope(input, deps);
  const partition = trophiesPartition(input.partition, nowMs);
  const selected =
    input.teamIds && input.teamIds.length > 0
      ? teams
      : teams.filter((_, index) => index % TROPHIES_PARTITIONS === partition);
  return {
    needs: 'ingestTrophies',
    units: selected.map((teamId) => squadTrophiesUnit(teamId)),
    emptyReason: 'no teams: the catalogue fixture lists are not cached; pass teamIds or playerIds',
  };
};

// ── units ─────────────────────────────────────────────────────────────────

const injuriesUnit = (target: LeagueSeason): EnrichmentUnit => ({
  key: `league-${target.leagueId}-season-${target.season}`,
  leagueId: target.leagueId,
  season: target.season,
  run: async (ctx) => {
    const path = apiFootballInjuriesLeaguePath(target.leagueId, target.season);
    // Taken before the provider call: game-service deletes rows in scope that
    // were last written before this instant (less its clock slack).
    const syncStartedAtMs = ctx.clockMs();
    const result = await ctx.fetch({
      workload: 'injuries-league',
      resourceId: `injuries-${target.leagueId}-${target.season}`,
      path,
    });
    if (!result.ok) {
      return fetchFailure(result, 1);
    }
    const fetchedAtMs = ctx.clockMs();
    const decoded = decodeInjuries(result.data, { ...target, fetchedAtMs });
    if (decoded.providerErrors !== undefined && decoded.rows.length === 0) {
      return failed(1, 1, `provider errors ${decoded.providerErrors}`, decoded.dropped);
    }
    const ingest = ctx.ingest.ingestAvailability!;
    const rows = decoded.rows;
    const resource = `injuries-${target.leagueId}-${target.season}`;
    // A pull the provider flagged with errors upserts what it has but never
    // finalises: without final_batch game-service deletes nothing.
    const replace = decoded.providerErrors === undefined;
    let accepted = 0;
    try {
      for (const [index, batch] of chunk(rows, UNIT_INGEST_BATCH_SIZE).entries()) {
        const start = index * UNIT_INGEST_BATCH_SIZE;
        const response = await ingest(
          create(IngestAvailabilityRequestSchema, {
            metadata: metadata('injuries-league', resource, path, fetchedAtMs, start),
            rows: batch as AvailabilityRow[],
            ...(replace
              ? {
                  replaceScope: create(AvailabilityReplaceScopeSchema, {
                    providerCompetitionId: String(target.leagueId),
                    seasonYear: target.season,
                    source: AvailabilitySource.INJURIES,
                  }),
                  syncId: `injuries-league:${target.leagueId}:${target.season}:${syncStartedAtMs}`,
                  syncStartedAt: timestampFromMs(syncStartedAtMs),
                  finalBatch: start + UNIT_INGEST_BATCH_SIZE >= rows.length,
                }
              : {}),
          })
        );
        accepted += response.acceptedCount;
      }
    } catch (error) {
      return failed(1, 1, `ingest failed: ${errorMessage(error)}`, decoded.dropped, accepted);
    }
    if (rows.length === 0) {
      // An empty list is not proof that nobody is out (the provider answers
      // some failures that way), so nothing is sent and nothing is deleted.
      ctx.log({
        event: 'provider_enrichment.empty_response',
        leagueId: target.leagueId,
        season: target.season,
        reason: 'no injury rows; stored rows kept',
      });
    }
    const digestKey = injuryDigestKey(target.leagueId, target.season);
    const digest = mergeInjuryDigest(
      await ctx.cache.get<InjuryPlayerDigest>(digestKey),
      decoded.sightings,
      ctx.nowMs
    );
    await ctx.cache.set(digestKey, digest, INJURY_DIGEST_TTL_SECONDS);
    if (!replace) {
      return failed(1, 1, `provider errors ${decoded.providerErrors}`, decoded.dropped, accepted);
    }
    return complete(1, 1, accepted, decoded.dropped);
  },
});

const sidelinedUnit = (playerIds: readonly string[]): EnrichmentUnit => ({
  key: `players-${playerIds.join('-')}`,
  leagueId: 0,
  season: 0,
  run: async (ctx) => {
    const path = apiFootballSidelinedPath(playerIds);
    const result = await ctx.fetch({
      workload: 'player-sidelined',
      resourceId: playerIds.join('-'),
      path,
    });
    if (!result.ok) {
      return fetchFailure(result, 1);
    }
    const fetchedAtMs = ctx.clockMs();
    const decoded = decodeSidelined(result.data, { fetchedAtMs });
    if (decoded.providerErrors !== undefined && decoded.entries === 0) {
      return failed(1, 1, `provider errors ${decoded.providerErrors}`, decoded.dropped);
    }
    try {
      const accepted = await ingestInBatches(decoded.rows, async (batch, start) =>
        ctx.ingest.ingestAvailability!(
          create(IngestAvailabilityRequestSchema, {
            metadata: metadata(
              'player-sidelined',
              `sidelined-${playerIds[0]}-${playerIds.length}`,
              path,
              fetchedAtMs,
              start
            ),
            rows: batch,
          })
        )
      );
      return complete(1, 1, accepted, decoded.dropped);
    } catch (error) {
      return failed(1, 1, `ingest failed: ${errorMessage(error)}`, decoded.dropped);
    }
  },
});

const transfersUnit = (teamId: string): EnrichmentUnit => ({
  key: `team-${teamId}`,
  leagueId: 0,
  season: 0,
  run: async (ctx) => {
    const path = apiFootballTransfersPath(teamId);
    const result = await ctx.fetch({ workload: 'team-transfers', resourceId: teamId, path });
    if (!result.ok) {
      return fetchFailure(result, 1);
    }
    const fetchedAtMs = ctx.clockMs();
    const decoded = decodeTransfers(result.data, { fetchedAtMs });
    if (decoded.providerErrors !== undefined && decoded.entries === 0) {
      return failed(1, 1, `provider errors ${decoded.providerErrors}`, decoded.dropped);
    }
    try {
      const accepted = await ingestInBatches(decoded.rows, async (batch, start) =>
        ctx.ingest.ingestTransfers!(
          create(IngestTransfersRequestSchema, {
            metadata: metadata('team-transfers', `team-${teamId}`, path, fetchedAtMs, start),
            rows: batch as TransferRow[],
          })
        )
      );
      return complete(1, 1, accepted, decoded.dropped);
    } catch (error) {
      return failed(1, 1, `ingest failed: ${errorMessage(error)}`, decoded.dropped);
    }
  },
});

/** Fetch trophies for up to 20 ids and write them. */
const fetchAndIngestTrophies = async (
  ctx: UnitContext,
  subject: 'player' | 'coach',
  ids: readonly string[],
  names?: ReadonlyMap<string, string>
): Promise<
  | { readonly ok: true; readonly accepted: number; readonly dropped: number }
  | { readonly ok: false; readonly stopped: boolean; readonly message: string }
> => {
  const path = apiFootballTrophiesPath(subject, ids);
  const result = await ctx.fetch({ workload: 'trophies', resourceId: ids.join('-'), path });
  if (!result.ok) {
    return result.stopped
      ? { ok: false, stopped: true, message: '' }
      : { ok: false, stopped: false, message: result.message };
  }
  const fetchedAtMs = ctx.clockMs();
  const decoded = decodeTrophies(result.data, { subject, fetchedAtMs, names });
  if (decoded.providerErrors !== undefined && decoded.entries === 0) {
    return { ok: false, stopped: false, message: `provider errors ${decoded.providerErrors}` };
  }
  try {
    const accepted = await ingestInBatches(decoded.rows, async (batch, start) =>
      ctx.ingest.ingestTrophies!(
        create(IngestTrophiesRequestSchema, {
          metadata: metadata(
            'trophies',
            `${subject}-${ids[0]}-${ids.length}`,
            path,
            fetchedAtMs,
            start
          ),
          rows: batch as TrophyRow[],
        })
      )
    );
    return { ok: true, accepted, dropped: decoded.dropped };
  } catch (error) {
    return { ok: false, stopped: false, message: `ingest failed: ${errorMessage(error)}` };
  }
};

const trophiesUnit = (subject: 'player' | 'coach', ids: readonly string[]): EnrichmentUnit => ({
  key: `${subject === 'player' ? 'players' : 'coachs'}-${ids.join('-')}`,
  leagueId: 0,
  season: 0,
  run: async (ctx) => {
    const outcome = await fetchAndIngestTrophies(ctx, subject, ids);
    if (!outcome.ok) {
      return outcome.stopped ? partial(0, 1, 0, 0, []) : failed(1, 1, outcome.message, 0);
    }
    return complete(1, 1, outcome.accepted, outcome.dropped);
  },
});

/** One team: its current squad, then its players' trophies in batches of 20. */
const squadTrophiesUnit = (teamId: string): EnrichmentUnit => ({
  key: `squad-${teamId}`,
  leagueId: 0,
  season: 0,
  run: async (ctx) => {
    const squad = await ctx.fetch({
      workload: 'trophies',
      resourceId: `squad-${teamId}`,
      path: apiFootballSquadPath(teamId),
    });
    if (!squad.ok) {
      return fetchFailure(squad, 1);
    }
    const decodedSquad = decodeSquadPlayerIds(squad.data);
    if (decodedSquad.providerErrors !== undefined && decodedSquad.playerIds.length === 0) {
      return failed(1, 1, `squad: provider errors ${decodedSquad.providerErrors}`, 0);
    }
    const batches = chunk(decodedSquad.playerIds, PROVIDER_MULTI_ID_MAX);
    const planned = 1 + batches.length;
    let calls = 1;
    let accepted = 0;
    let dropped = 0;
    for (const ids of batches) {
      const outcome = await fetchAndIngestTrophies(ctx, 'player', ids, decodedSquad.names);
      if (!outcome.ok) {
        if (outcome.stopped) {
          return partial(calls, planned, accepted, dropped, []);
        }
        return failed(calls + 1, planned, outcome.message, dropped, accepted);
      }
      calls += 1;
      accepted += outcome.accepted;
      dropped += outcome.dropped;
    }
    return complete(calls, planned, accepted, dropped);
  },
});

// ── helpers ───────────────────────────────────────────────────────────────

const ingestInBatches = async <TRow>(
  rows: readonly TRow[],
  send: (batch: TRow[], start: number) => Promise<{ readonly acceptedCount: number }>
): Promise<number> => {
  let accepted = 0;
  for (const [index, batch] of chunk(rows, UNIT_INGEST_BATCH_SIZE).entries()) {
    accepted += (await send(batch, index * UNIT_INGEST_BATCH_SIZE)).acceptedCount;
  }
  return accepted;
};

const metadata = (
  dataset: UnitEnrichmentDataset,
  resource: string,
  path: string,
  fetchedAtMs: number,
  start: number
) => {
  const provider = API_FOOTBALL_PROVIDER_ID;
  const replayId = `provider-enrichment:${dataset}:${resource}:${fetchedAtMs}:${start}`;
  return create(IngestMetadataSchema, {
    provider,
    replayId,
    rawPayloadRef: `provider://${provider}${path}`,
    normalizedBatchId: `${provider}:${dataset}:${resource}:${start}`,
    idempotencyKey: `${provider}:${dataset}:${replayId}`,
  });
};

const complete = (
  calls: number,
  callsPlanned: number,
  rowsIngested: number,
  rowsDropped: number
): UnitOutcome => ({
  status: 'complete',
  calls,
  callsPlanned,
  rowsIngested,
  rowsDropped,
  errors: [],
});

const partial = (
  calls: number,
  callsPlanned: number,
  rowsIngested: number,
  rowsDropped: number,
  errors: readonly string[]
): UnitOutcome => ({ status: 'partial', calls, callsPlanned, rowsIngested, rowsDropped, errors });

const failed = (
  calls: number,
  callsPlanned: number,
  message: string,
  rowsDropped: number,
  rowsIngested = 0
): UnitOutcome => ({
  status: 'failed',
  calls,
  callsPlanned,
  rowsIngested,
  rowsDropped,
  errors: [message],
});

const fetchFailure = (
  result: Extract<UnitFetch, { ok: false }>,
  callsPlanned: number
): UnitOutcome =>
  result.stopped ? partial(0, callsPlanned, 0, 0, []) : failed(1, callsPlanned, result.message, 0);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
};

/** Valid provider ids, de-duplicated and sorted numerically. */
export const sortIds = (ids: readonly unknown[]): string[] => {
  const seen = new Set<string>();
  for (const id of ids) {
    const parsed = parseProviderId(id);
    if (parsed !== undefined) {
      seen.add(parsed);
    }
  }
  return [...seen].sort((a, b) => Number(a) - Number(b));
};

const uniquePositiveInts = (values: readonly number[]): number[] => {
  const seen = new Set<number>();
  for (const value of values) {
    if (Number.isInteger(value) && value > 0) {
      seen.add(value);
    }
  }
  return [...seen];
};
