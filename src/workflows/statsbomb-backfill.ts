/**
 * StatsBomb Open Data backfill workflow.
 *
 * Imports rich, freeze-frame-bearing match events from the StatsBomb Open Data
 * set into game-service. The reference target is the 2022 World Cup
 * (competition 43, season 106), whose 64 matches all ship `shot.freeze_frame`
 * plus a separate 360 feed — the exact data the platform's "Moment" block
 * (shot freeze-frame + lit camera `visible_area`) renders.
 *
 * Why a separate workflow (not the api-football season-backfill)
 * --------------------------------------------------------------
 * StatsBomb Open Data is a STATIC FILE SET on GitHub, not the api-football
 * HTTP provider. It has no per-day quota, no provider key, and no live cadence.
 * So it deliberately does NOT flow through the `fetchWorkload`
 * (cache → singleflight → quota → provider-HTTP) pipeline that the
 * daily-anchor / season-backfill workflows share — that pipeline is bound to
 * the api-football key and the 70k/day quota tracker. Instead, this workflow
 * pulls the open-data JSON files directly via an injected {@link StatsBombFetch}
 * boundary (defaulting to the global `fetch`), exactly as the adapter's own
 * tests do.
 *
 * What it reuses
 * --------------
 *   - The StatsBomb adapter (`fromStatsBombOpen`) for the events → occurrences
 *     mapping, including the new freeze_frame + 360 `visible_area` handling.
 *   - The same game-service crosswalk the match-concluded bridge uses:
 *     `LookupGameByFixture` (`deps.gameLookup`) to resolve a provider fixture
 *     id → canonical BTL `game_id`, then `IngestGameOccurrences`
 *     (`deps.gameService`). The crosswalk lives in `provider_game_mappings`,
 *     populated by the api-football `IngestGames` path — so a StatsBomb match
 *     must be mapped to its api-football fixture id first (see the static map
 *     below).
 *
 * Idempotency
 * -----------
 * Occurrence ids are the stable StatsBomb event UUIDs (`GameOccurrence.id =
 * event.id` in the adapter). game-service upserts occurrences `ON CONFLICT
 * (id)`, so re-running the backfill re-feeds the same UUIDs and updates in
 * place — no duplicates.
 *
 * Mapping caveat (follow-on data task)
 * ------------------------------------
 * The canonical-id lookup is keyed by `(provider, provider_fixture_id)`, and
 * the crosswalk is populated under the api-football provider. StatsBomb match
 * ids are NOT api-football fixture ids, so we need a
 * `statsbomb_match_id → api_football_fixture_id` map to resolve the canonical
 * game. {@link WC2022_STATSBOMB_TO_API_FOOTBALL} is a TODO-marked STUB; until
 * it is populated, matches without a mapping are reported `skipped`
 * (`reason: 'no_fixture_mapping'`) and nothing is ingested for them. Populating
 * the full WC2022 crosswalk is a separate data task.
 *
 * This workflow does NOT need to be RUN against a live stack to land; it is
 * authored to compile + typecheck and mirror the season-backfill structure.
 *
 * Triggering
 * ----------
 * POST /workflows/statsbomb-backfill with a service-principal auth-context
 * header. Body is optional (defaults to the full WC2022 competition):
 *
 *   curl -X POST https://gamewire-worker/workflows/statsbomb-backfill \
 *     -H 'x-btl-auth-context: <token>' \
 *     -H 'content-type: application/json' \
 *     -d '{"matchIds":[3869685]}'
 */
import { create } from '@bufbuild/protobuf';

import { LookupGameByFixtureRequestSchema } from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import {
  fromStatsBombOpen,
  STATSBOMB_OPEN_PROVIDER_ID,
  type StatsBombEvent,
  type StatsBombThreeSixtyFrame,
} from '../adapters/statsbomb-open/index.js';
import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import type {
  StatsBombBackfillInput,
  StatsBombBackfillMatchResult,
  StatsBombBackfillOutput,
  StatsBombFetch,
  WorkflowDeps,
} from './types.js';

/** Default public StatsBomb open-data raw host. */
const DEFAULT_STATSBOMB_BASE_URL =
  'https://raw.githubusercontent.com/statsbomb/open-data/master/data';

/** FIFA World Cup competition id in the StatsBomb open-data set. */
const WC_COMPETITION_ID = 43;
/** 2022 season id in the StatsBomb open-data set. */
const WC_SEASON_ID = 106;

/** Default cap on matches processed per run (a full World Cup is 64). */
const DEFAULT_MAX_MATCHES_PER_RUN = 64;

/**
 * STUB: `statsbomb_match_id → api_football_fixture_id` for WC2022.
 *
 * The canonical game lookup (`LookupGameByFixture`) is keyed by the
 * api-football provider fixture id (that is the id the api-football ingest
 * path wrote into `provider_game_mappings`). StatsBomb match ids are a
 * different id space, so each StatsBomb match must be mapped to the
 * api-football fixture id for the same real-world game.
 *
 * This map is intentionally a small stub: populating the full 64-match WC2022
 * crosswalk (by matching `home_team`/`away_team`/`match_date` against the
 * api-football WC2022 fixtures) is a FOLLOW-ON DATA TASK, not part of this
 * code change. The single seeded entry (the WC2022 final, StatsBomb 3869685)
 * is a placeholder shape — `0` marks it as not-yet-verified so the workflow
 * skips it rather than ingesting against a wrong fixture.
 *
 * TODO(data): populate WC2022 statsbomb→api-football fixture id crosswalk.
 */
export const WC2022_STATSBOMB_TO_API_FOOTBALL: Readonly<Record<number, number>> = {
  // 3869685: <api_football_fixture_id>, // WC2022 final — TODO verify
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const matchesPath = (baseUrl: string, competitionId: number, seasonId: number): string =>
  `${baseUrl}/matches/${competitionId}/${seasonId}.json`;

const eventsPath = (baseUrl: string, matchId: number): string =>
  `${baseUrl}/events/${matchId}.json`;

const threeSixtyPath = (baseUrl: string, matchId: number): string =>
  `${baseUrl}/three-sixty/${matchId}.json`;

/**
 * Fetch + parse a StatsBomb open-data JSON file. Returns `undefined` on any
 * non-OK response or parse failure so a single missing file (e.g. a match with
 * no 360 feed) never aborts the run. `optional` toggles whether a miss is
 * logged as an error or a quiet skip.
 */
const fetchJson = async (fetcher: StatsBombFetch, url: string): Promise<unknown | undefined> => {
  try {
    const response = await fetcher(url);
    if (!response.ok) {
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  }
};

/**
 * Extract StatsBomb match ids from a `matches/<comp>/<season>.json` envelope
 * (a flat array of match objects, each with a numeric `match_id`).
 */
export const matchIdsFromMatchesEnvelope = (data: unknown): readonly number[] => {
  if (!Array.isArray(data)) {
    return [];
  }
  const ids: number[] = [];
  for (const item of data) {
    if (!isRecord(item)) {
      continue;
    }
    const raw = item.match_id;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      ids.push(raw);
    }
  }
  return ids;
};

/** Narrow an unknown parsed events payload to the adapter's event array. */
const eventsFromPayload = (data: unknown): StatsBombEvent[] => {
  if (!Array.isArray(data)) {
    return [];
  }
  // The adapter is defensive per-event; we only need the array shape here.
  return data as StatsBombEvent[];
};

/** Narrow an unknown parsed 360 payload to the adapter's frame array. */
const threeSixtyFromPayload = (data: unknown): StatsBombThreeSixtyFrame[] | undefined => {
  if (!Array.isArray(data)) {
    return undefined;
  }
  return data as StatsBombThreeSixtyFrame[];
};

/**
 * Main StatsBomb Open Data backfill workflow.
 *
 * Enumerates WC2022 matches (or an explicit `matchIds` list), and for each:
 *   1. maps the StatsBomb match id → api-football fixture id (static stub),
 *   2. resolves that fixture id → canonical BTL `game_id` via
 *      `LookupGameByFixture`,
 *   3. fetches `events/<id>.json` + `three-sixty/<id>.json`,
 *   4. runs `fromStatsBombOpen` (occurrences + freeze_frame + 360 visible_area),
 *   5. calls `IngestGameOccurrences` under the canonical game id.
 *
 * Sequential per-match (the open-data files are large); the per-match delay is
 * 0 by default since there is no provider quota to respect.
 */
export const statsbombBackfillWorkflow = async (
  input: StatsBombBackfillInput,
  deps: WorkflowDeps
): Promise<StatsBombBackfillOutput> => {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const startedAt = input.nowUtc ? new Date(input.nowUtc) : clock();
  const fetcher: StatsBombFetch =
    deps.statsbombFetch ?? ((url: string) => fetch(url) as ReturnType<StatsBombFetch>);
  const baseUrl = (input.baseUrl ?? DEFAULT_STATSBOMB_BASE_URL).replace(/\/+$/, '');
  const competitionId = input.competitionId ?? WC_COMPETITION_ID;
  const seasonId = input.seasonId ?? WC_SEASON_ID;
  const maxMatchesPerRun =
    input.maxMatchesPerRun && input.maxMatchesPerRun > 0
      ? input.maxMatchesPerRun
      : DEFAULT_MAX_MATCHES_PER_RUN;
  const intercallDelayMs = input.intercallDelayMs !== undefined ? input.intercallDelayMs : 0;
  const dryRun = input.dryRun ?? false;
  // Input mappings win over the built-in static stub so an operator can
  // exercise specific matches before the full crosswalk data task lands.
  const fixtureMap: Readonly<Record<string, number>> = {
    ...WC2022_STATSBOMB_TO_API_FOOTBALL,
    ...input.fixtureMap,
  };

  log({
    event: 'statsbomb_backfill.started',
    workflow: 'statsbomb-backfill',
    reason: input.matchIds
      ? `explicit ${input.matchIds.length} match(es)`
      : `competition ${competitionId} season ${seasonId}`,
  });

  // 1. Enumerate match ids.
  let matchIds: readonly number[];
  if (input.matchIds && input.matchIds.length > 0) {
    matchIds = dedupeMatchIds(input.matchIds);
  } else {
    const matchesData = await fetchJson(fetcher, matchesPath(baseUrl, competitionId, seasonId));
    matchIds = matchIdsFromMatchesEnvelope(matchesData);
  }

  if (matchIds.length > maxMatchesPerRun) {
    matchIds = matchIds.slice(0, maxMatchesPerRun);
  }

  log({
    event: 'statsbomb_backfill.matches_enumerated',
    workflow: 'statsbomb-backfill',
    reason: `${matchIds.length} match(es) to import`,
  });

  const matchResults: StatsBombBackfillMatchResult[] = [];
  let matchesOk = 0;
  let matchesFailed = 0;
  let matchesSkipped = 0;

  for (const statsbombMatchId of matchIds) {
    const result = await processMatch({
      statsbombMatchId,
      apiFootballFixtureId: fixtureMap[statsbombMatchId],
      deps,
      fetcher,
      baseUrl,
      dryRun,
      log,
    });
    matchResults.push(result);
    if (result.status === 'ok') {
      matchesOk += 1;
    } else if (result.status === 'failed') {
      matchesFailed += 1;
    } else {
      matchesSkipped += 1;
    }

    if (intercallDelayMs > 0) {
      await sleep(intercallDelayMs);
    }
  }

  const finishedAt = clock();
  const status: StatsBombBackfillOutput['status'] = matchesFailed > 0 ? 'partial' : 'completed';

  log({
    event: 'statsbomb_backfill.finished',
    workflow: 'statsbomb-backfill',
    status,
    reason: `ok=${matchesOk} failed=${matchesFailed} skipped=${matchesSkipped}`,
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    matchesDiscovered: matchIds.length,
    matchesProcessed: matchResults.length,
    matchesOk,
    matchesFailed,
    matchesSkipped,
    matches: matchResults,
    dryRun,
  };
};

interface ProcessMatchArgs {
  readonly statsbombMatchId: number;
  /** api-football fixture id this match maps to (from the merged crosswalk). */
  readonly apiFootballFixtureId: number | undefined;
  readonly deps: WorkflowDeps;
  readonly fetcher: StatsBombFetch;
  readonly baseUrl: string;
  readonly dryRun: boolean;
  readonly log: NonNullable<WorkflowDeps['logger']>;
}

const processMatch = async (args: ProcessMatchArgs): Promise<StatsBombBackfillMatchResult> => {
  const { statsbombMatchId, apiFootballFixtureId, deps, fetcher, baseUrl, dryRun, log } = args;

  // Map StatsBomb match id → api-football fixture id (the crosswalk key).
  if (apiFootballFixtureId === undefined || apiFootballFixtureId <= 0) {
    log({
      event: 'statsbomb_backfill.match_skipped',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId}: no_fixture_mapping`,
    });
    return {
      statsbombMatchId,
      status: 'skipped',
      reason: 'no_fixture_mapping',
    };
  }
  const providerFixtureId = String(apiFootballFixtureId);

  // Resolve the canonical BTL game id via the same crosswalk the
  // match-concluded bridge uses (LookupGameByFixture, keyed under the
  // api-football provider).
  if (!deps.gameLookup) {
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      status: 'skipped',
      reason: 'game_lookup_not_wired',
    };
  }
  let gameId: string;
  try {
    const lookup = await deps.gameLookup.lookupGameByFixture(
      create(LookupGameByFixtureRequestSchema, {
        provider: API_FOOTBALL_PROVIDER_ID,
        providerFixtureId,
      })
    );
    if (!lookup.found || !lookup.gameId) {
      log({
        event: 'statsbomb_backfill.game_not_found',
        workflow: 'statsbomb-backfill',
        reason: `statsbombMatchId=${statsbombMatchId} fixtureId=${providerFixtureId}`,
      });
      return {
        statsbombMatchId,
        apiFootballFixtureId: providerFixtureId,
        status: 'skipped',
        reason: 'game_not_found',
      };
    }
    gameId = lookup.gameId;
  } catch (err) {
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (dryRun) {
    log({
      event: 'statsbomb_backfill.match_dry_run',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId} gameId=${gameId}`,
    });
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      gameId,
      status: 'skipped',
      reason: 'dry_run',
    };
  }

  // Fetch events (required) + 360 frames (optional).
  const eventsData = await fetchJson(fetcher, eventsPath(baseUrl, statsbombMatchId));
  const events = eventsFromPayload(eventsData);
  if (events.length === 0) {
    log({
      event: 'statsbomb_backfill.events_missing',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId}: empty_or_missing_events`,
    });
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      gameId,
      status: 'failed',
      reason: 'empty_or_missing_events',
    };
  }
  const threeSixtyData = await fetchJson(fetcher, threeSixtyPath(baseUrl, statsbombMatchId));
  const threeSixtyFrames = threeSixtyFromPayload(threeSixtyData);

  // Map → occurrences (with freeze_frame + 360 visible_area). Occurrence ids
  // are the stable StatsBomb event UUIDs, so ingest is idempotent.
  const request = fromStatsBombOpen(events, {
    gameId,
    replayId: `statsbomb-open:wc2022:${statsbombMatchId}`,
    rawPayloadRef: eventsPath(baseUrl, statsbombMatchId),
    threeSixtyFrames,
  });
  if (request.occurrences.length === 0) {
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      gameId,
      status: 'skipped',
      reason: 'no_normalized_occurrences',
      threeSixtyApplied: false,
    };
  }

  if (!deps.gameService) {
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      gameId,
      status: 'skipped',
      reason: 'game_service_not_wired',
    };
  }

  try {
    const response = await deps.gameService.ingestGameOccurrences(request);
    log({
      event: 'statsbomb_backfill.match_ingested',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId} gameId=${gameId} provider=${STATSBOMB_OPEN_PROVIDER_ID} accepted=${response.acceptedCount} updated=${response.updatedCount}`,
    });
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      gameId,
      status: 'ok',
      acceptedCount: response.acceptedCount,
      updatedCount: response.updatedCount,
      threeSixtyApplied: threeSixtyFrames !== undefined && threeSixtyFrames.length > 0,
    };
  } catch (err) {
    return {
      statsbombMatchId,
      apiFootballFixtureId: providerFixtureId,
      gameId,
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

const dedupeMatchIds = (ids: readonly number[]): readonly number[] => {
  const seen = new Set<number>();
  for (const id of ids) {
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
      seen.add(id);
    }
  }
  return [...seen];
};

/** Test-only exports. */
export const __test = {
  matchIdsFromMatchesEnvelope,
  WC2022_STATSBOMB_TO_API_FOOTBALL,
  WC_COMPETITION_ID,
  WC_SEASON_ID,
  DEFAULT_MAX_MATCHES_PER_RUN,
  DEFAULT_STATSBOMB_BASE_URL,
};
