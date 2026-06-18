/**
 * StatsBomb Open Data backfill workflow.
 *
 * Imports rich, freeze-frame-bearing match events from the StatsBomb Open Data
 * set into game-service. The reference target is the 2022 World Cup
 * (competition 43, season 106), whose 64 matches all ship `shot.freeze_frame`
 * plus a separate 360 feed — the exact data the platform's "Moment" block
 * (shot freeze-frame + lit camera `visible_area`) renders.
 *
 * StatsBomb is a STANDALONE data source
 * -------------------------------------
 * StatsBomb mints its OWN canonical game; it does not depend on api-football
 * having ingested the match first. Earlier this workflow resolved the canonical
 * game id by mapping each StatsBomb match to an api-football fixture id and
 * calling `LookupGameByFixture('api-football', …)` — but api-football has NO
 * WC2022 data, so that lookup always missed and nothing ingested. StatsBomb
 * ships everything needed to mint the game (match metadata + the two teams), so
 * per match the workflow now:
 *   1. `IngestGames([gameFromStatsBombOpen(match)])` — game-service `IngestGames`
 *      is find-or-mint (a Game with resolved participants either attaches to an
 *      existing canonical game or mints a new one),
 *   2. `LookupGameByFixture('statsbomb-open', String(match_id))` — read back the
 *      canonical id game-service assigned (the crosswalk row `IngestGames` just
 *      wrote under the `statsbomb-open` provider),
 *   3. fetch `events/<id>.json` + `three-sixty/<id>.json`,
 *   4. run `fromStatsBombOpen` (occurrences + freeze_frame + 360 visible_area),
 *   5. `IngestGameOccurrences` under that canonical game id.
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
 *   - `gameFromStatsBombOpen` for the match-envelope → canonical `Game`
 *     (IngestGames) mapping, with both teams as unresolved provider refs that
 *     game-service resolves to BTL teams + crests via the identity crosswalk.
 *   - The StatsBomb adapter (`fromStatsBombOpen`) for the events → occurrences
 *     mapping, including the freeze_frame + 360 `visible_area` handling.
 *   - `IngestGameOccurrences` (`deps.gameService`) under the canonical id.
 *
 * Idempotency
 * -----------
 * `Game.provider_game_id = String(match_id)` and the crosswalk key
 * `(statsbomb-open, match_id)` are stable, so re-ingesting a match finds the
 * same canonical game (upsert) rather than minting a duplicate. Occurrence ids
 * are the stable StatsBomb event UUIDs (`GameOccurrence.id = event.id`); both
 * IngestGames and IngestGameOccurrences upsert `ON CONFLICT`, so re-running the
 * backfill updates in place.
 *
 * Triggering
 * ----------
 * POST /workflows/statsbomb-backfill with a service-principal auth-context
 * header. Body is optional (defaults to the full WC2022 competition); pass
 * `matchIds` to run just a slice (e.g. the final, match_id 3869685):
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
  gameFromStatsBombOpen,
  STATSBOMB_OPEN_PROVIDER_ID,
  type StatsBombEvent,
  type StatsBombMatch,
  type StatsBombThreeSixtyFrame,
} from '../adapters/statsbomb-open/index.js';
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
 * no 360 feed) never aborts the run.
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
 * Parse a `matches/<comp>/<season>.json` envelope (a flat array of match
 * objects) into match-id → {@link StatsBombMatch} entries. Tolerant of
 * malformed elements (non-object, missing/invalid `match_id`) — those are
 * skipped so one bad row never breaks enumeration.
 */
export const matchesFromEnvelope = (data: unknown): ReadonlyMap<number, StatsBombMatch> => {
  const byId = new Map<number, StatsBombMatch>();
  if (!Array.isArray(data)) {
    return byId;
  }
  for (const item of data) {
    if (!isRecord(item)) {
      continue;
    }
    const raw = item.match_id;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      byId.set(raw, item as unknown as StatsBombMatch);
    }
  }
  return byId;
};

/**
 * Extract StatsBomb match ids from a matches envelope (kept for callers /
 * tests that only need the id list). Order follows the envelope.
 */
export const matchIdsFromMatchesEnvelope = (data: unknown): readonly number[] => [
  ...matchesFromEnvelope(data).keys(),
];

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
 * Enumerates the WC2022 matches file into match metadata, optionally filters to
 * an explicit `matchIds` slice, and for each match mints its canonical game
 * (IngestGames find-or-mint), reads back the canonical id
 * (`LookupGameByFixture('statsbomb-open', …)`), fetches events + 360, and
 * ingests occurrences under that id.
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

  log({
    event: 'statsbomb_backfill.started',
    workflow: 'statsbomb-backfill',
    reason: input.matchIds
      ? `explicit ${input.matchIds.length} match(es)`
      : `competition ${competitionId} season ${seasonId}`,
  });

  // 1. Enumerate match metadata from the matches file. StatsBomb mints its own
  //    canonical game from this metadata, so the matches envelope is always
  //    required (the optional `matchIds` is a FILTER over it, not a way to skip
  //    the fetch — we need each match's teams/competition/kickoff to mint).
  const matchesData = await fetchJson(fetcher, matchesPath(baseUrl, competitionId, seasonId));
  const matchesById = matchesFromEnvelope(matchesData);

  // Optional matchIds filter (e.g. just the final). Preserves the input order
  // for an explicit slice; otherwise follows the envelope order. Filter ids
  // with no metadata in the file are dropped (cannot mint without metadata).
  const filterIds = dedupeMatchIds(input.matchIds ?? []);
  let matchIds: readonly number[] =
    filterIds.length > 0 ? filterIds.filter((id) => matchesById.has(id)) : [...matchesById.keys()];

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
    const match = matchesById.get(statsbombMatchId);
    const result = await processMatch({
      statsbombMatchId,
      match,
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
  /** Match metadata from the matches file (undefined if the row was missing). */
  readonly match: StatsBombMatch | undefined;
  readonly deps: WorkflowDeps;
  readonly fetcher: StatsBombFetch;
  readonly baseUrl: string;
  readonly dryRun: boolean;
  readonly log: NonNullable<WorkflowDeps['logger']>;
}

const processMatch = async (args: ProcessMatchArgs): Promise<StatsBombBackfillMatchResult> => {
  const { statsbombMatchId, match, deps, fetcher, baseUrl, dryRun, log } = args;

  // Need the match metadata to mint the canonical game. A filter id with no
  // row in the matches file (or a malformed row) can't be minted.
  if (match === undefined) {
    log({
      event: 'statsbomb_backfill.match_skipped',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId}: no_match_metadata`,
    });
    return {
      statsbombMatchId,
      status: 'skipped',
      reason: 'no_match_metadata',
    };
  }

  // The game-service clients gate the whole mint→lookup→ingest flow; without
  // them there is nothing to do.
  if (!deps.gameService) {
    return {
      statsbombMatchId,
      status: 'skipped',
      reason: 'game_service_not_wired',
    };
  }
  if (!deps.gameLookup) {
    return {
      statsbombMatchId,
      status: 'skipped',
      reason: 'game_lookup_not_wired',
    };
  }

  // 1. Mint (find-or-mint) the canonical game from the StatsBomb match envelope.
  //    A malformed match yields an empty games array; treat that as a skip.
  const ingestGamesRequest = gameFromStatsBombOpen(match, {
    replayId: `statsbomb-open:wc2022:game:${statsbombMatchId}`,
    rawPayloadRef: matchesPathForMatch(baseUrl, match),
  });
  if (ingestGamesRequest.games.length === 0) {
    log({
      event: 'statsbomb_backfill.match_skipped',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId}: unmintable_match`,
    });
    return {
      statsbombMatchId,
      status: 'skipped',
      reason: 'unmintable_match',
    };
  }
  try {
    await deps.gameService.ingestGames(ingestGamesRequest);
    log({
      event: 'statsbomb_backfill.game_minted',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId} provider=${STATSBOMB_OPEN_PROVIDER_ID}`,
    });
  } catch (err) {
    return {
      statsbombMatchId,
      status: 'failed',
      reason: `ingest_games: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Read back the canonical id game-service assigned, via the crosswalk row
  //    IngestGames just wrote under the statsbomb-open provider.
  const providerFixtureId = String(statsbombMatchId);
  let gameId: string;
  try {
    const lookup = await deps.gameLookup.lookupGameByFixture(
      create(LookupGameByFixtureRequestSchema, {
        provider: STATSBOMB_OPEN_PROVIDER_ID,
        providerFixtureId,
      })
    );
    if (!lookup.found || !lookup.gameId) {
      log({
        event: 'statsbomb_backfill.game_not_found',
        workflow: 'statsbomb-backfill',
        reason: `statsbombMatchId=${statsbombMatchId} provider=${STATSBOMB_OPEN_PROVIDER_ID}`,
      });
      return {
        statsbombMatchId,
        status: 'skipped',
        reason: 'game_not_found',
      };
    }
    gameId = lookup.gameId;
  } catch (err) {
    return {
      statsbombMatchId,
      status: 'failed',
      reason: `lookup_game: ${err instanceof Error ? err.message : String(err)}`,
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
      gameId,
      status: 'skipped',
      reason: 'dry_run',
    };
  }

  // 3. Fetch events (required) + 360 frames (optional).
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
      gameId,
      status: 'failed',
      reason: 'empty_or_missing_events',
    };
  }
  const threeSixtyData = await fetchJson(fetcher, threeSixtyPath(baseUrl, statsbombMatchId));
  const threeSixtyFrames = threeSixtyFromPayload(threeSixtyData);

  // 4. Map → occurrences (with freeze_frame + 360 visible_area). Occurrence ids
  //    are the stable StatsBomb event UUIDs, so ingest is idempotent.
  const request = fromStatsBombOpen(events, {
    gameId,
    replayId: `statsbomb-open:wc2022:${statsbombMatchId}`,
    rawPayloadRef: eventsPath(baseUrl, statsbombMatchId),
    threeSixtyFrames,
  });
  if (request.occurrences.length === 0) {
    return {
      statsbombMatchId,
      gameId,
      status: 'skipped',
      reason: 'no_normalized_occurrences',
      threeSixtyApplied: false,
    };
  }

  // 5. Ingest occurrences under the canonical game id.
  try {
    const response = await deps.gameService.ingestGameOccurrences(request);
    log({
      event: 'statsbomb_backfill.match_ingested',
      workflow: 'statsbomb-backfill',
      reason: `statsbombMatchId=${statsbombMatchId} gameId=${gameId} provider=${STATSBOMB_OPEN_PROVIDER_ID} accepted=${response.acceptedCount} updated=${response.updatedCount}`,
    });
    return {
      statsbombMatchId,
      gameId,
      status: 'ok',
      acceptedCount: response.acceptedCount,
      updatedCount: response.updatedCount,
      threeSixtyApplied: threeSixtyFrames !== undefined && threeSixtyFrames.length > 0,
    };
  } catch (err) {
    return {
      statsbombMatchId,
      gameId,
      status: 'failed',
      reason: `ingest_occurrences: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * The raw-payload pointer for a match's source row. Points at the matches file
 * the match metadata was read from (the canonical-game source), distinct from
 * the per-match events file pointer used for occurrences.
 */
const matchesPathForMatch = (baseUrl: string, match: StatsBombMatch): string => {
  const competitionId = match.competition?.competition_id ?? WC_COMPETITION_ID;
  const seasonId = match.season?.season_id ?? WC_SEASON_ID;
  return matchesPath(baseUrl, competitionId, seasonId);
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
  matchesFromEnvelope,
  matchIdsFromMatchesEnvelope,
  WC_COMPETITION_ID,
  WC_SEASON_ID,
  DEFAULT_MAX_MATCHES_PER_RUN,
  DEFAULT_STATSBOMB_BASE_URL,
};
