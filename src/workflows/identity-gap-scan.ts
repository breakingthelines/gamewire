/**
 * Identity gap-scan workflow.
 *
 * A READ-ONLY periodic audit: enumerate every provider team + competition
 * gamewire currently knows about (from the cached Phase A fixture-list
 * envelopes the daily-anchor sweep already populated), resolve each through
 * identity-server, and report the ones identity CANNOT resolve — the "gaps"
 * that render as monograms in the UI.
 *
 * Why
 * ---
 * Identity coverage is a baked SQLite artifact; a club/competition either
 * exists in it or resolves `found:false` and degrades to a monogram (the
 * `match-concluded-bridge` preserves the provider ref, never throws). The
 * bridge logs a scattered `bridge_identity_resolve_error` per live miss, but
 * there is no consolidated "what's uncovered right now" view. This workflow is
 * that view: it turns the implicit gap into an explicit, grouped worklist that
 * drives the next identity enrichment pass (and, later, Scope B).
 *
 * What it does NOT do
 * -------------------
 * No provider (api-football) calls — it only reads the existing fixture cache
 * and calls identity.resolve. No writes. No quota spend. Safe to run on any
 * cadence. It does not fix gaps; filling them is a reviewed identity rebuild.
 *
 * Triggering
 * ----------
 * POST /workflows/identity-gap-scan with a service-principal auth-context
 * header. Body optional. Registered in kernel-service as a weekly Temporal
 * schedule (mirrors the squad-sweep registration).
 *
 *   curl -X POST https://gamewire-worker/workflows/identity-gap-scan \
 *     -H 'btl-auth-context: <token>' -H 'content-type: application/json' -d '{}'
 */
import { create } from '@bufbuild/protobuf';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import type {
  IdentityGap,
  IdentityGapScanInput,
  IdentityGapScanOutput,
  WorkflowDeps,
} from './types.js';

const DEFAULT_MAX_ENTITIES_PER_RUN = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A provider entity (team or competition) seen in a fixture envelope. */
interface SeenEntity {
  readonly providerId: string;
  readonly label: string;
  readonly leagueId: number;
}

/**
 * Pull the distinct provider TEAM refs (id + name) from a cached
 * `/fixtures?league&season` envelope, tagged with the league id they were seen
 * under. Mirrors `teamIdsFromFixtureListEnvelope` in squad-sweep but keeps the
 * name + league for the gap report.
 */
const teamsFromFixtureListEnvelope = (data: unknown, leagueId: number): SeenEntity[] => {
  if (!isRecord(data) || !Array.isArray(data.response)) {
    return [];
  }
  const out: SeenEntity[] = [];
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
      const providerId =
        (typeof id === 'number' && Number.isFinite(id) && id > 0) || typeof id === 'string'
          ? String(id).trim()
          : '';
      if (providerId === '' || providerId === '0') {
        continue;
      }
      const label = typeof team.name === 'string' ? team.name : '';
      out.push({ providerId, label, leagueId });
    }
  }
  return out;
};

/**
 * Resolve one provider entity through identity-server. Returns true when
 * identity has a canonical match, false otherwise. Soft-fails closed (a
 * transient identity error counts as "unknown", reported as partial) — never
 * throws.
 */
const isResolved = async (
  deps: WorkflowDeps,
  entityType: EntityType,
  providerId: string
): Promise<{ resolved: boolean; errored: boolean }> => {
  if (!deps.identity) {
    return { resolved: false, errored: true };
  }
  try {
    const response = await deps.identity.resolve(
      create(ResolveRequestSchema, {
        entityType,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId,
      })
    );
    return { resolved: Boolean(response.found && response.entityId), errored: false };
  } catch {
    return { resolved: false, errored: true };
  }
};

/**
 * Enumerate the distinct provider teams + competitions known to gamewire and
 * report those identity cannot resolve. Read-only; no provider calls.
 */
export const identityGapScanWorkflow = async (
  input: IdentityGapScanInput,
  deps: WorkflowDeps
): Promise<IdentityGapScanOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const startedAt = input.nowUtc ? new Date(input.nowUtc) : clock();
  const maxEntities = input.maxEntitiesPerRun ?? DEFAULT_MAX_ENTITIES_PER_RUN;

  // Collect distinct teams (by provider id) + competitions (by league id) from
  // every cached fixture-list envelope. The competition is the league each
  // envelope was fetched for; teams come from the fixtures within.
  const teams = new Map<string, SeenEntity>();
  const competitions = new Map<string, SeenEntity>();

  for (const competition of deps.competitions) {
    const leagueId = competition.apiFootballLeagueId;
    const resourceId = `league-${leagueId}-season-${competition.season}`;
    const cacheKey = `${API_FOOTBALL_PROVIDER_ID}:fixtures-next-7d:${resourceId}`;
    const cached = await deps.ingestion.cache.get<unknown>(cacheKey);
    if (cached === undefined) {
      continue;
    }
    // The competition itself is a resolvable entity (its api-football league id).
    const compProviderId = String(leagueId);
    if (!competitions.has(compProviderId)) {
      competitions.set(compProviderId, {
        providerId: compProviderId,
        label: competition.label,
        leagueId,
      });
    }
    for (const team of teamsFromFixtureListEnvelope(cached, leagueId)) {
      // First-seen wins (keeps a stable league tag for the report).
      if (!teams.has(team.providerId)) {
        teams.set(team.providerId, team);
      }
    }
  }

  const gaps: IdentityGap[] = [];
  const gapsByLeague: Record<string, number> = {};
  let teamsChecked = 0;
  let competitionsChecked = 0;
  let errored = false;

  const recordGap = (gap: IdentityGap): void => {
    gaps.push(gap);
    const key = gap.leagueId === undefined ? 'unknown' : String(gap.leagueId);
    gapsByLeague[key] = (gapsByLeague[key] ?? 0) + 1;
    log({
      event: 'identity_gap',
      workflow: 'identity-gap-scan',
      entityType: gap.entityType,
      providerId: gap.providerId,
      label: gap.label,
      leagueId: gap.leagueId,
    });
  };

  // Seed every known league into gapsByLeague at 0 so a clean league shows up
  // as covered (0 gaps), not just absent from the map.
  for (const competition of deps.competitions) {
    gapsByLeague[String(competition.apiFootballLeagueId)] ??= 0;
  }

  // Resolve competitions first (few), then teams, honouring the entity budget.
  let budget = maxEntities;

  for (const comp of competitions.values()) {
    if (budget <= 0) break;
    budget -= 1;
    competitionsChecked += 1;
    const { resolved, errored: e } = await isResolved(
      deps,
      EntityType.COMPETITION,
      comp.providerId
    );
    errored = errored || e;
    if (!resolved) {
      recordGap({
        entityType: 'competition',
        providerId: comp.providerId,
        label: comp.label,
        leagueId: comp.leagueId,
      });
    }
  }

  for (const team of teams.values()) {
    if (budget <= 0) break;
    budget -= 1;
    teamsChecked += 1;
    const { resolved, errored: e } = await isResolved(deps, EntityType.TEAM, team.providerId);
    errored = errored || e;
    if (!resolved) {
      recordGap({
        entityType: 'team',
        providerId: team.providerId,
        label: team.label,
        leagueId: team.leagueId,
      });
    }
  }

  const finishedAt = clock();
  const output: IdentityGapScanOutput = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: errored ? 'partial' : 'completed',
    entitiesChecked: teamsChecked + competitionsChecked,
    teamsChecked,
    competitionsChecked,
    gapsFound: gaps.length,
    gapsByLeague,
    gaps,
  };

  log({
    event: 'identity_gap_scan_completed',
    workflow: 'identity-gap-scan',
    status: output.status,
    entitiesChecked: output.entitiesChecked,
    gapsFound: output.gapsFound,
    gapsByLeague: output.gapsByLeague,
  });

  return output;
};
