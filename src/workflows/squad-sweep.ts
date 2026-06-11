/**
 * Squad-sweep workflow.
 *
 * Ingests EVERY club's CURRENT SQUAD (standing roster) into game-service so
 * `GetTeamSquad` (and the Arena "Popular players" strip) works for any club,
 * not just the ~28 that happened to receive a fixture lineup.
 *
 * Motivation
 * ----------
 * The existing `squad-list-fallback` workload only fires as a per-fixture
 * fallback when a lineup is missing. That path ties a squad list to a
 * specific game_id so it reaches `football_squad_lists`, not the standing
 * `team_squad_rosters` table. The Arena "Popular players" strip calls
 * `GetTeamSquad` which prefers `team_squad_rosters` (source="squad_list")
 * over the derived-from-lineups path. Without a standing roster the strip
 * only works for teams that happened to appear in a gamewire-tracked fixture.
 *
 * Approach
 * --------
 * 1. Enumerate provider team ids.
 *    Default: every UNIQUE provider team id seen in the Phase A competition
 *    catalogue's fixture responses (discovered by the daily-anchor sweep and
 *    cached in Redis under the `api-football:fixtures-next-7d:<key>` keys).
 *    Override: an explicit `teamIds` list in the workflow input.
 *
 * 2. For each provider team id:
 *    a. Resolve provider team id -> canonical `btl_football_team_*` via
 *       identity-server (reuse the bridge's `resolve` path).
 *    b. Fetch `/players/squads?team=<providerTeamId>` through the ingestion
 *       loop (cache -> singleflight -> quota -> provider-HTTP -> cache).
 *    c. Map the response to an `IngestFootballSquadListsRequest` with:
 *         - `game_id = ""` (standing sentinel, routes to team_squad_rosters)
 *         - `team_id = <canonicalId>` on each team entry (so
 *           `team_squad_rosters.canonical_team_id` is populated and
 *           `GetTeamSquad` finds it by canonical lookup)
 *         - `provider_team_id` on each team entry (required for the upsert key)
 *    d. Call game-service `IngestFootballSquadLists`.
 *
 * 3. Sequential per-team, not parallel: the API-Football Pro plan allows up
 *    to 75k req/day but has per-minute burst limits. Sequential execution
 *    with the existing quota-gating in `fetchWorkload` is the safe choice.
 *    An optional `intercallDelayMs` (default 200ms) can be dialled via
 *    environment or workflow input.
 *
 * Idempotency
 * -----------
 * Re-running upserts (ON CONFLICT provider_code + provider_team_id). Safe to
 * re-run at any time; the canonical_team_id is only overwritten when non-empty,
 * so a resolution that was missing at first ingest is picked up on re-run.
 *
 * Quota
 * -----
 * One `/players/squads` call per team. A top-five league sweep (~100 teams)
 * costs ~100 quota units, well within the 75k/day budget. The quota hard cap
 * and soft cap degrade identically to every other workflow.
 *
 * Triggering
 * ----------
 * POST /workflows/squad-sweep with a service-principal auth-context header.
 * Body is optional (defaults to all known teams); pass `{"teamIds":["42","49"]}`
 * for an explicit subset. Register in kernel-service as a one-shot or periodic
 * Temporal schedule.
 *
 *   curl -X POST https://gamewire-worker/workflows/squad-sweep \
 *     -H 'btl-auth-context: <token>' \
 *     -H 'content-type: application/json' \
 *     -d '{}'
 */
import { create } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromMs } from '@bufbuild/protobuf/wkt';

import {
  IngestFootballSquadListsRequestSchema,
  IngestMetadataSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  FootballSquadListSchema,
  FootballSquadListPlayerSchema,
  FootballSquadListTeamSchema,
} from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import type { IngestionFetchResult } from '../worker/ingestion.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import { handleProviderOutage, handleQuotaPosture, mostRestrictive } from './degrade.js';
import type {
  DegradeAction,
  DegradeFlag,
  SquadSweepInput,
  SquadSweepOutput,
  SquadSweepTeamResult,
  WorkflowDeps,
} from './types.js';

/** Environment variable or input override for per-team inter-call delay. */
const SWEEP_INTER_CALL_DELAY_MS = Number(
  typeof process !== 'undefined' ? (process.env.SQUAD_SWEEP_INTER_CALL_DELAY_MS ?? '200') : '200'
);

/**
 * Default maximum provider team ids to process per run. A single sweep of
 * Phase A top-five leagues is ~120 teams; 500 is a safe ceiling that handles
 * the full WC + qualifier squad universe without risk of hitting the daily
 * budget in a single run.
 */
const DEFAULT_MAX_TEAMS_PER_RUN = 500;

/**
 * Extract UNIQUE provider team ids from a cached `/fixtures?league&season`
 * envelope (the shape cached under `api-football:fixtures-next-7d:<key>`).
 * Mirrors `teamIdsFromFixtureDetail` in ingestion.ts but operates on the
 * list envelope shape.
 */
const teamIdsFromFixtureListEnvelope = (data: unknown): readonly string[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data.response) {
    if (!isRecord(item) || !isRecord(item.teams)) {
      continue;
    }
    for (const role of ['home', 'away'] as const) {
      const team = (item.teams as Record<string, unknown>)[role];
      if (!isRecord(team)) {
        continue;
      }
      const id = team.id;
      if ((typeof id === 'number' && Number.isFinite(id) && id > 0) || typeof id === 'string') {
        const str = String(id).trim();
        if (str !== '' && str !== '0') {
          ids.add(str);
        }
      }
    }
  }
  return [...ids];
};

/**
 * Enumerate all provider team ids known to gamewire by reading every
 * competition's cached fixture-list envelope from the ingestion loop. This
 * is the broadest feasible enumeration without a live provider call: the
 * daily-anchor sweep already cached these envelopes so we get a free team
 * list on every re-run. Falls back to an empty array when caches are cold
 * (e.g. first boot before the anchor ran).
 */
const enumerateKnownTeamIds = async (deps: WorkflowDeps): Promise<readonly string[]> => {
  const seen = new Set<string>();

  for (const competition of deps.competitions) {
    const resourceId = `league-${competition.apiFootballLeagueId}-season-${competition.season}`;
    const cacheKey = `${API_FOOTBALL_PROVIDER_ID}:fixtures-next-7d:${resourceId}`;
    const cached = await deps.ingestion.cache.get<unknown>(cacheKey);
    if (cached === undefined) {
      continue;
    }
    for (const id of teamIdsFromFixtureListEnvelope(cached)) {
      seen.add(id);
    }
  }

  return [...seen];
};

/**
 * Resolve a provider team id to a canonical BTL entity id via identity-server.
 * Returns '' when identity has no match (provider ref will be stored as-is;
 * game-service can resolve at read time).
 */
const resolveCanonicalTeamId = async (
  deps: WorkflowDeps,
  providerTeamId: string
): Promise<string> => {
  if (!deps.identity) {
    return '';
  }
  try {
    const response = await deps.identity.resolve(
      create(ResolveRequestSchema, {
        entityType: EntityType.TEAM,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId: providerTeamId,
      })
    );
    return response.found && response.entityId ? response.entityId : '';
  } catch {
    return '';
  }
};

/**
 * Build a standing `IngestFootballSquadListsRequest` from a
 * `/players/squads?team=<id>` envelope. The key difference from the per-fixture
 * fallback path is `game_id = ""` (the standing sentinel) and the canonical
 * `team_id` populated on each `FootballSquadListTeam` entry.
 */
const buildStandingSquadRequest = (options: {
  readonly providerTeamId: string;
  readonly canonicalTeamId: string;
  readonly envelope: unknown;
  readonly fetchedAtMs: number;
}) => {
  const { providerTeamId, canonicalTeamId, envelope, fetchedAtMs } = options;
  const providerId = API_FOOTBALL_PROVIDER_ID;
  const resourceId = `squad-sweep-${providerTeamId}`;
  const replayId = `squad-sweep:${providerTeamId}:${fetchedAtMs}`;

  const teams = extractSquadTeams(envelope, canonicalTeamId, providerId);
  if (teams.length === 0) {
    return null;
  }

  return create(IngestFootballSquadListsRequestSchema, {
    metadata: create(IngestMetadataSchema, {
      provider: providerId,
      replayId,
      rawPayloadRef: `provider://${providerId}/players/squads/${providerTeamId}`,
      normalizedBatchId: `${providerId}:squad-sweep:${resourceId}`,
      idempotencyKey: `${providerId}:squad-sweep:${resourceId}:${replayId}`,
    }),
    squadLists: [
      create(FootballSquadListSchema, {
        // game_id = "" is the standing sentinel. game-service routes this to
        // team_squad_rosters, NOT football_squad_lists.
        gameId: '',
        teams,
        updatedAt: create(TimestampSchema, timestampFromMs(fetchedAtMs)),
      }),
    ],
  });
};

/**
 * Extract teams from a `/players/squads` envelope, populating:
 *   - `teamId`: the canonical `btl_football_team_*` id (or empty if unresolved)
 *   - `providerTeamId`: the API-Football team id (the upsert key)
 *   - `players[]`: squad players with provider refs
 */
const extractSquadTeams = (
  envelope: unknown,
  canonicalTeamId: string,
  providerId: string
): ReturnType<typeof create<typeof FootballSquadListTeamSchema>>[] => {
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return [];
  }
  const teams: ReturnType<typeof create<typeof FootballSquadListTeamSchema>>[] = [];
  for (const item of envelope.response) {
    if (!isRecord(item) || !isRecord(item.team) || !Array.isArray(item.players)) {
      continue;
    }
    const providerTeamId = String(
      typeof item.team.id === 'number' ? item.team.id : (item.team.id ?? '')
    ).trim();
    if (providerTeamId === '' || providerTeamId === '0') {
      continue;
    }
    if (!item.players.some((p) => isRecord(p) && Number.isFinite(p.id))) {
      continue;
    }
    const players = item.players
      .filter((p): p is Record<string, unknown> => isRecord(p) && Number.isFinite(p.id))
      .map((p) => {
        const providerPlayerId = String(p.id).trim();
        const playerName = typeof p.name === 'string' ? p.name.trim() : '';
        const shirtNumber =
          typeof p.number === 'number' && Number.isFinite(p.number) ? p.number : 0;
        const position = typeof p.position === 'string' ? p.position.trim() : '';
        const age = typeof p.age === 'number' && Number.isFinite(p.age) ? p.age : 0;
        const photo = typeof p.photo === 'string' ? p.photo.trim() : '';
        return create(FootballSquadListPlayerSchema, {
          // player_id as a provider-namespaced sentinel when not yet resolved;
          // game-service resolves it at read time via provider_player_id
          playerId: `provider:${providerId}:player:${providerPlayerId}`,
          playerName,
          shirtNumber,
          positionCode: position,
          age,
          photoUrl: photo,
          providerPlayerId,
        });
      });

    if (players.length === 0) {
      continue;
    }
    const teamName = typeof item.team.name === 'string' ? item.team.name.trim() : '';
    const logoUrl = typeof item.team.logo === 'string' ? item.team.logo.trim() : '';
    teams.push(
      create(FootballSquadListTeamSchema, {
        // teamId carries the canonical btl_football_team_* id.
        // When non-empty, upsertTeamSquadRoster stores it in canonical_team_id
        // so GetTeamSquad can find the row by canonical lookup.
        teamId: canonicalTeamId,
        teamName,
        logoUrl,
        providerTeamId,
        players,
      })
    );
  }
  return teams;
};

/**
 * Main squad-sweep workflow.
 *
 * Input
 * -----
 * `teamIds`         — explicit provider team id list; when omitted, all teams
 *                     known from the cached fixture envelopes are used.
 * `maxTeamsPerRun`  — hard ceiling on teams processed this invocation.
 * `intercallDelayMs`— per-team delay in ms (default: env SQUAD_SWEEP_INTER_CALL_DELAY_MS or 200).
 * `dryRun`          — enumerate + resolve but skip provider fetch and ingest.
 * `nowUtc`          — ISO-8601 instant used as "now" for fetch metadata.
 *
 * Output
 * ------
 * Returns a `SquadSweepOutput` with per-team results, degrade flags, and
 * the final quota snapshot.
 */
export const squadSweepWorkflow = async (
  input: SquadSweepInput,
  deps: WorkflowDeps
): Promise<SquadSweepOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const startedAt = input.nowUtc ? new Date(input.nowUtc) : clock();
  const maxTeamsPerRun =
    input.maxTeamsPerRun && input.maxTeamsPerRun > 0
      ? input.maxTeamsPerRun
      : DEFAULT_MAX_TEAMS_PER_RUN;
  const intercallDelayMs =
    input.intercallDelayMs !== undefined ? input.intercallDelayMs : SWEEP_INTER_CALL_DELAY_MS;
  const dryRun = input.dryRun ?? false;

  log({
    event: 'squad_sweep.started',
    workflow: 'squad-sweep',
    reason: input.teamIds
      ? `explicit ${input.teamIds.length} team(s)`
      : 'enumerate from fixture cache',
  });

  // 1. Enumerate provider team ids.
  let providerTeamIds: readonly string[];
  if (input.teamIds && input.teamIds.length > 0) {
    providerTeamIds = normaliseIds(input.teamIds);
  } else {
    providerTeamIds = await enumerateKnownTeamIds(deps);
  }

  // Cap to maxTeamsPerRun.
  if (providerTeamIds.length > maxTeamsPerRun) {
    providerTeamIds = providerTeamIds.slice(0, maxTeamsPerRun);
  }

  log({
    event: 'squad_sweep.teams_enumerated',
    workflow: 'squad-sweep',
    reason: `${providerTeamIds.length} team(s) to sweep`,
  });

  const teamResults: SquadSweepTeamResult[] = [];
  const degradeFlags: DegradeFlag[] = [];
  let teamsOk = 0;
  let teamsFailed = 0;
  let teamsSkipped = 0;
  let callsUsed = 0;
  let finalQuota: ProviderQuotaSnapshot | undefined;
  let mode: DegradeAction = 'continue';

  // 2. Process each team sequentially.
  for (const providerTeamId of providerTeamIds) {
    if (mode === 'abort' || mode === 'circuit-open') {
      teamResults.push({
        providerTeamId,
        canonicalTeamId: '',
        status: 'skipped',
        reason: 'degrade_mode',
      });
      teamsSkipped++;
      continue;
    }

    // 2a. Resolve provider -> canonical team id.
    const canonicalTeamId = await resolveCanonicalTeamId(deps, providerTeamId);

    if (dryRun) {
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'skipped',
        reason: 'dry_run',
      });
      teamsSkipped++;
      log({
        event: 'squad_sweep.team_dry_run',
        workflow: 'squad-sweep',
        reason: `dry_run: providerTeamId=${providerTeamId} canonicalTeamId=${canonicalTeamId || '(unresolved)'}`,
      });
      continue;
    }

    // 2b. Fetch `/players/squads?team=<providerTeamId>` via the ingestion loop.
    const resourceId = `sweep-squad-${providerTeamId}`;
    let fetchResult: IngestionFetchResult;
    try {
      fetchResult = await deps.ingestion.fetchWorkload({
        workload: 'squad-list-fallback',
        resourceId,
        path: `/players/squads?team=${encodeURIComponent(providerTeamId)}`,
      });
    } catch (err) {
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      teamsFailed++;
      log({
        event: 'squad_sweep.team_fetch_error',
        workflow: 'squad-sweep',
        reason: `providerTeamId=${providerTeamId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Track quota and degrade state.
    if (fetchResult.quota) {
      finalQuota = fetchResult.quota;
      const quotaResult = handleQuotaPosture(fetchResult.quota);
      if (quotaResult.flag) {
        degradeFlags.push(quotaResult.flag);
      }
      if (fetchResult.fallbackReason) {
        const outage = handleProviderOutage({ fallbackReason: fetchResult.fallbackReason });
        if (outage.flag) {
          degradeFlags.push(outage.flag);
        }
      }
      mode = mostRestrictive([
        mode,
        quotaResult.action,
        fetchResult.fallbackReason === 'PROVIDER_OUTAGE' ? 'cached-only' : 'continue',
      ]);
    }

    if (fetchResult.status === 'fetched') {
      callsUsed++;
    }

    if (fetchResult.status === 'denied') {
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'skipped',
        reason: 'quota_denied',
      });
      teamsSkipped++;
      continue;
    }

    if (fetchResult.status === 'failed' || fetchResult.data === undefined) {
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'failed',
        reason: fetchResult.error?.message ?? 'no_data',
      });
      teamsFailed++;
      continue;
    }

    // 2c. Build the standing IngestFootballSquadListsRequest.
    const request = buildStandingSquadRequest({
      providerTeamId,
      canonicalTeamId,
      envelope: fetchResult.data,
      fetchedAtMs: Date.now(),
    });

    if (!request || request.squadLists.length === 0) {
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'skipped',
        reason: 'empty_squad_response',
      });
      teamsSkipped++;
      log({
        event: 'squad_sweep.team_empty_squad',
        workflow: 'squad-sweep',
        reason: `providerTeamId=${providerTeamId}: no players in response`,
      });
      continue;
    }

    // 2d. Call game-service IngestFootballSquadLists.
    if (!deps.gameService) {
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'skipped',
        reason: 'game_service_not_wired',
      });
      teamsSkipped++;
      continue;
    }
    try {
      const response = await deps.gameService.ingestFootballSquadLists(request);
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'ok',
        acceptedCount: response.acceptedCount,
        updatedCount: response.updatedCount,
      });
      teamsOk++;
      log({
        event: 'squad_sweep.team_ingested',
        workflow: 'squad-sweep',
        reason: `providerTeamId=${providerTeamId} canonicalTeamId=${canonicalTeamId || '(unresolved)'} accepted=${response.acceptedCount} updated=${response.updatedCount}`,
      });
    } catch (err) {
      teamResults.push({
        providerTeamId,
        canonicalTeamId,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      teamsFailed++;
      log({
        event: 'squad_sweep.team_ingest_error',
        workflow: 'squad-sweep',
        reason: `providerTeamId=${providerTeamId}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Respect inter-call delay.
    if (intercallDelayMs > 0) {
      await sleep(intercallDelayMs);
    }
  }

  const finishedAt = clock();
  const status: SquadSweepOutput['status'] =
    mode === 'abort' || mode === 'circuit-open'
      ? 'aborted'
      : teamsFailed > 0
        ? 'partial'
        : 'completed';

  log({
    event: 'squad_sweep.finished',
    workflow: 'squad-sweep',
    status,
    reason: `ok=${teamsOk} failed=${teamsFailed} skipped=${teamsSkipped} callsUsed=${callsUsed}`,
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    teamsDiscovered: providerTeamIds.length,
    teamsOk,
    teamsFailed,
    teamsSkipped,
    callsUsed,
    degradeFlags,
    finalQuota,
    teams: teamResults,
    dryRun,
  };
};

const normaliseIds = (ids: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const id of ids) {
    const t = String(id).trim();
    if (t !== '' && t !== '0') {
      seen.add(t);
    }
  }
  return [...seen];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Test-only exports. */
export const __test = {
  enumerateKnownTeamIds,
  extractSquadTeams,
  buildStandingSquadRequest,
  teamIdsFromFixtureListEnvelope,
  DEFAULT_MAX_TEAMS_PER_RUN,
};
