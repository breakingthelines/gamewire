/**
 * Competition-scoped events/lineups backfill.
 *
 * Context: a batch of domestic cups (FA Cup, Coupe de France, Copa del Rey,
 * League Cup, DFB Pokal, Coppa Italia — ~1,011 fixtures, all 2025-07 through
 * 2025-12) entered gamewire's ingest coverage only on 2026-06-30, AFTER their
 * fixtures had already been played. The fixtures themselves were backfilled
 * from the `/fixtures` endpoint (score, status, participants), but the
 * post-final `events` and `lineups` pulls never ran for them — those only
 * fire from the live/daily-anchor loops, which didn't cover these
 * competitions yet at kickoff time. The provider still has the data
 * (verified live against fixtures across four of the six competitions).
 *
 * `sweepMissingPayloadsWorkflow` (`./sweep-missing-payloads.ts`) is the
 * general mechanism for this class of gap and already knows how to fetch
 * `events`/`lineups` idempotently via the existing `events-post-final` /
 * `lineups-post-confirm` ingestion workloads — daily-anchor's own post-final
 * path uses the same two workloads for the steady-state case. This workflow
 * does NOT reimplement any of that provider-calling logic. It only adds the
 * piece the general sweep does not have: discovering which fixtures belong
 * to ONE target competition, so a fix this size can be proven on the
 * smallest competition (Coppa Italia, 20 fixtures) before being pointed at
 * FA Cup's 668. Once fixture ids are selected, this workflow hands them to
 * `sweepMissingPayloadsWorkflow` via its `fixtureIds` escape hatch — the
 * exact same code path ops already uses for one-shot fixture lists — so the
 * fetch, cache, quota, degrade, and idempotency behaviour is identical to
 * the production sweep, not a parallel copy of it.
 *
 * `ListGamesMissingPayloadsRequest` has no competition/league filter field
 * (and this workflow must not touch the protos repo to add one), so
 * competition scoping happens client-side: `GameMissingPayloadEntry` DOES
 * carry a `competition_id` — explicitly documented on the proto as "for
 * filtering / batching by league" — and every game gets one populated at
 * ingest time regardless of whether identity ever resolved it (see
 * `adapter.ts`'s `providerStorageId` fallback comment). So the target
 * competition's candidate id set is: the deterministic provider-storage
 * fallback id (`provider:api-football:competition:<leagueId>`), PLUS the
 * canonical id from an identity resolve when one is available. An entry
 * matches if its `competition_id` is either.
 *
 * Dry run is the default specifically because this is a backfill tool meant
 * to be proven on a small competition first: a bare invocation enumerates and
 * reports what WOULD be fetched but reaches no fetch/ingest code path at
 * all — not merely skips the last step. Set `dryRun: false` to execute.
 */
import { create } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  type GameMissingPayloadEntry,
  GameMissingPayloadKind,
  ListGamesMissingPayloadsRequestSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import { API_FOOTBALL_PROVIDER_ID, providerStorageId } from '../adapters/api-football/index.js';
import type { FootballGameMissingPayloadsClient } from '../worker/clients/game-service.js';
import type { FootballIdentityLookupClient } from '../worker/clients/identity.js';
import { sweepMissingPayloadsWorkflow } from './sweep-missing-payloads.js';
import type {
  CompetitionBackfillKind,
  CompetitionEntry,
  CompetitionPayloadBackfillFixture,
  CompetitionPayloadBackfillInput,
  CompetitionPayloadBackfillOutput,
  WorkflowDeps,
} from './types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Server-side page cap (matches `ListGamesMissingPayloadsRequest.page_size`'s documented 1..500 clamp). */
const DISCOVERY_PAGE_SIZE = 500;
/**
 * Hard ceiling on pages scanned while filtering for the target competition.
 * The known domestic-cup gap this workflow was built for is ~1,011 fixtures
 * total across ALL competitions (2-3 pages at 500/page); 50 pages
 * (≤25,000 entries) is generous headroom for any future gap of similar
 * shape without letting a misconfigured filter (e.g. an id that never
 * matches) spin through the server's entire backlog.
 */
const MAX_PAGES_SCANNED = 50;

const clampLimit = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), MAX_LIMIT);
};

const parseIsoTimestamp = (value: string | undefined): Timestamp | undefined => {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return timestampFromDate(date);
};

const KIND_TO_PROTO: Record<CompetitionBackfillKind, GameMissingPayloadKind> = {
  events: GameMissingPayloadKind.EVENTS,
  lineups: GameMissingPayloadKind.LINEUPS,
};

/** Discovery-shaped projection of a `GameMissingPayloadEntry`, decoupled from the proto type for easy unit testing. */
export interface DiscoveredMissingPayloadEntry {
  readonly gameId: string;
  readonly providerFixtureId: string;
  readonly competitionId: string;
  readonly scheduledStartAtMs?: number;
}

export const toDiscoveredEntry = (
  entry: GameMissingPayloadEntry
): DiscoveredMissingPayloadEntry => ({
  gameId: entry.gameId,
  providerFixtureId: entry.providerFixtureId,
  competitionId: entry.competitionId,
  scheduledStartAtMs: entry.scheduledStartAt
    ? timestampDate(entry.scheduledStartAt).getTime()
    : undefined,
});

/**
 * The selection logic: which discovered entries belong to the target
 * competition, capped at `limit`. Pure and RPC-free by design so it can be
 * unit-tested directly against hand-built entry lists (see
 * `__tests__/competition-payload-backfill.test.ts`) without standing up a
 * mock gRPC client.
 */
export const selectCompetitionFixtures = (
  entries: readonly DiscoveredMissingPayloadEntry[],
  candidateCompetitionIds: ReadonlySet<string>,
  limit: number
): readonly DiscoveredMissingPayloadEntry[] => {
  const matched: DiscoveredMissingPayloadEntry[] = [];
  for (const entry of entries) {
    if (matched.length >= limit) {
      break;
    }
    if (entry.providerFixtureId === '') {
      continue;
    }
    if (candidateCompetitionIds.has(entry.competitionId)) {
      matched.push(entry);
    }
  }
  return matched;
};

interface ResolvedTarget {
  readonly leagueId: number;
  readonly competitionKey?: string;
}

/**
 * Resolve the input's target league id. An explicit `apiFootballLeagueId`
 * always wins over `competitionKey` (mirrors `SeasonBackfillTarget`'s
 * resolution rule); otherwise the key is looked up against the live
 * catalogue passed in `deps.competitions` so a stale/renamed key fails loudly
 * instead of silently resolving to nothing.
 */
export const resolveBackfillTarget = (
  input: Pick<CompetitionPayloadBackfillInput, 'competitionKey' | 'apiFootballLeagueId'>,
  competitions: readonly CompetitionEntry[]
): ResolvedTarget | { readonly error: string } => {
  if (typeof input.apiFootballLeagueId === 'number' && Number.isFinite(input.apiFootballLeagueId)) {
    return { leagueId: input.apiFootballLeagueId, competitionKey: input.competitionKey };
  }
  const key = input.competitionKey;
  if (!key) {
    return { error: 'competitionKey or apiFootballLeagueId is required' };
  }
  const entry = competitions.find((c) => c.key === key);
  if (!entry) {
    return { error: `unknown competition key: ${key}` };
  }
  return { leagueId: entry.apiFootballLeagueId, competitionKey: entry.key };
};

/**
 * Build the set of `competition_id` values that identify the target
 * competition on a `GameMissingPayloadEntry`. Always includes the
 * deterministic provider-storage fallback id (populated on every game
 * regardless of identity resolution status — see `adapter.ts`); adds the
 * canonical identity-resolved id too when `identity` is wired and the
 * resolve succeeds. Never throws: an identity miss/outage just means the
 * canonical id is absent from the set, and matching falls back to the
 * provider-storage id alone.
 */
export const resolveCandidateCompetitionIds = async (
  leagueId: number,
  identity: FootballIdentityLookupClient | undefined
): Promise<ReadonlySet<string>> => {
  const ids = new Set<string>([
    providerStorageId(API_FOOTBALL_PROVIDER_ID, 'competition', String(leagueId)),
  ]);
  if (!identity) {
    return ids;
  }
  try {
    const response = await identity.resolve(
      create(ResolveRequestSchema, {
        entityType: EntityType.COMPETITION,
        provider: API_FOOTBALL_PROVIDER_ID,
        providerId: String(leagueId),
      })
    );
    if (response.found && response.entityId) {
      ids.add(response.entityId);
    }
  } catch {
    // Identity outage/miss: the provider-storage fallback id already covers
    // matching; a canonical-id miss must not fail discovery.
  }
  return ids;
};

interface DiscoveryResult {
  readonly matched: readonly DiscoveredMissingPayloadEntry[];
  readonly entriesScanned: number;
  readonly pagesScanned: number;
  readonly serverTotalCount: number;
  readonly truncated: boolean;
}

/**
 * Page through `ListGamesMissingPayloads` for `kind`, filtering each page to
 * the target competition via `selectCompetitionFixtures`. Requests the
 * server's max page size every time (not a shrinking remaining-budget size
 * like the unscoped sweep) because most entries on any given page will
 * belong to OTHER competitions and get filtered out — sizing the request to
 * "how many more we still need" would starve the loop.
 */
const discoverCompetitionFixtures = async (args: {
  readonly client: FootballGameMissingPayloadsClient;
  readonly kind: CompetitionBackfillKind;
  readonly candidateCompetitionIds: ReadonlySet<string>;
  readonly limit: number;
  readonly since?: string;
  readonly until?: string;
}): Promise<DiscoveryResult> => {
  const matched: DiscoveredMissingPayloadEntry[] = [];
  let entriesScanned = 0;
  let pagesScanned = 0;
  let serverTotalCount = 0;
  let pageToken = '';
  let truncated = false;
  const since = parseIsoTimestamp(args.since);
  const until = parseIsoTimestamp(args.until);

  while (matched.length < args.limit) {
    if (pagesScanned >= MAX_PAGES_SCANNED) {
      truncated = true;
      break;
    }
    const request = create(ListGamesMissingPayloadsRequestSchema, {
      kind: KIND_TO_PROTO[args.kind],
      pageSize: DISCOVERY_PAGE_SIZE,
      pageToken,
      provider: API_FOOTBALL_PROVIDER_ID,
    });
    if (since) {
      request.since = since;
    }
    if (until) {
      request.until = until;
    }
    const response = await args.client.listGamesMissingPayloads(request);
    pagesScanned += 1;
    const respTotal = Number(response.totalCount);
    if (Number.isFinite(respTotal) && respTotal > serverTotalCount) {
      serverTotalCount = respTotal;
    }
    entriesScanned += response.entries.length;
    const discovered = response.entries.map(toDiscoveredEntry);
    const remaining = args.limit - matched.length;
    matched.push(...selectCompetitionFixtures(discovered, args.candidateCompetitionIds, remaining));
    if (!response.nextPageToken || response.entries.length === 0) {
      break;
    }
    pageToken = response.nextPageToken;
  }

  return {
    matched,
    entriesScanned,
    pagesScanned,
    serverTotalCount: serverTotalCount === 0 ? entriesScanned : serverTotalCount,
    truncated,
  };
};

const toFixtureReport = (
  entry: DiscoveredMissingPayloadEntry
): CompetitionPayloadBackfillFixture => ({
  gameId: entry.gameId,
  providerFixtureId: entry.providerFixtureId,
  scheduledStartAt:
    entry.scheduledStartAtMs !== undefined
      ? new Date(entry.scheduledStartAtMs).toISOString()
      : undefined,
});

const emptyOutput = (args: {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly competitionKey: string | undefined;
  readonly apiFootballLeagueId: number;
  readonly kind: CompetitionBackfillKind;
  readonly dryRun: boolean;
  readonly status: CompetitionPayloadBackfillOutput['status'];
  readonly reason?: string;
  readonly fixturesConsidered?: number;
}): CompetitionPayloadBackfillOutput => ({
  startedAt: args.startedAt,
  finishedAt: args.finishedAt,
  competitionKey: args.competitionKey,
  apiFootballLeagueId: args.apiFootballLeagueId,
  kind: args.kind,
  fixturesConsidered: args.fixturesConsidered ?? 0,
  fixturesMatched: 0,
  fixtures: [],
  fixturesProcessed: 0,
  fixturesOk: 0,
  fixturesEmpty: 0,
  fixturesSkipped: 0,
  fixturesFailed: 0,
  callsUsed: 0,
  status: args.status,
  degradeFlags: [],
  finalQuota: undefined,
  errors: [],
  dryRun: args.dryRun,
  reason: args.reason,
});

export const competitionPayloadBackfillWorkflow = async (
  input: CompetitionPayloadBackfillInput,
  deps: WorkflowDeps
): Promise<CompetitionPayloadBackfillOutput> => {
  const log = deps.logger ?? (() => undefined);
  const clock = deps.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  // Dry run is the DEFAULT — the opposite default from
  // `sweepMissingPayloadsWorkflow` — because this tool exists specifically
  // to prove a backfill on a small competition before pointing it at a
  // large one. Only an explicit `dryRun: false` executes.
  const dryRun = input.dryRun !== false;

  log({
    event: 'competition_payload_backfill.started',
    workflow: 'competition-payload-backfill',
    competition: input.competitionKey,
    leagueId: input.apiFootballLeagueId,
    workload: input.kind,
    reason: dryRun ? 'dryRun' : undefined,
  });

  const target = resolveBackfillTarget(input, deps.competitions);
  if ('error' in target) {
    const finishedAt = clock().toISOString();
    log({
      event: 'competition_payload_backfill.target_unresolved',
      workflow: 'competition-payload-backfill',
      competition: input.competitionKey,
      reason: target.error,
    });
    return emptyOutput({
      startedAt,
      finishedAt,
      competitionKey: input.competitionKey,
      apiFootballLeagueId: input.apiFootballLeagueId ?? 0,
      kind: input.kind,
      dryRun,
      status: 'aborted',
      reason: target.error,
    });
  }

  if (!deps.gameServiceMissingPayloads) {
    const finishedAt = clock().toISOString();
    const reason =
      'competition-payload-backfill: gameServiceMissingPayloads client not configured; ' +
      'this workflow has no fixtureIds escape hatch (its entire purpose is competition-scoped discovery)';
    log({
      event: 'competition_payload_backfill.discover_failed',
      workflow: 'competition-payload-backfill',
      competition: target.competitionKey,
      leagueId: target.leagueId,
      reason,
    });
    return emptyOutput({
      startedAt,
      finishedAt,
      competitionKey: target.competitionKey,
      apiFootballLeagueId: target.leagueId,
      kind: input.kind,
      dryRun,
      status: 'aborted',
      reason,
    });
  }

  const limit = clampLimit(input.limit);
  const candidateCompetitionIds = await resolveCandidateCompetitionIds(
    target.leagueId,
    deps.identity
  );

  let discovery: DiscoveryResult;
  try {
    discovery = await discoverCompetitionFixtures({
      client: deps.gameServiceMissingPayloads,
      kind: input.kind,
      candidateCompetitionIds,
      limit,
      since: input.since,
      until: input.until,
    });
  } catch (err) {
    const finishedAt = clock().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    log({
      event: 'competition_payload_backfill.discover_failed',
      workflow: 'competition-payload-backfill',
      competition: target.competitionKey,
      leagueId: target.leagueId,
      reason: message,
    });
    return emptyOutput({
      startedAt,
      finishedAt,
      competitionKey: target.competitionKey,
      apiFootballLeagueId: target.leagueId,
      kind: input.kind,
      dryRun,
      status: 'aborted',
      reason: `discover_failed: ${message}`,
    });
  }

  log({
    event: 'competition_payload_backfill.discovered',
    workflow: 'competition-payload-backfill',
    competition: target.competitionKey,
    leagueId: target.leagueId,
    workload: input.kind,
    fixturesIngested: discovery.matched.length,
    reason: discovery.truncated
      ? `page scan cap (${MAX_PAGES_SCANNED}) reached before exhausting the list; rerun to continue`
      : undefined,
  });

  const fixtures = discovery.matched.map(toFixtureReport);
  for (const fixture of fixtures) {
    log({
      event: dryRun
        ? 'competition_payload_backfill.would_fetch'
        : 'competition_payload_backfill.matched',
      workflow: 'competition-payload-backfill',
      competition: target.competitionKey,
      leagueId: target.leagueId,
      workload: input.kind,
      fixtureId: fixture.providerFixtureId,
    });
  }

  if (discovery.matched.length === 0) {
    const finishedAt = clock().toISOString();
    return emptyOutput({
      startedAt,
      finishedAt,
      competitionKey: target.competitionKey,
      apiFootballLeagueId: target.leagueId,
      kind: input.kind,
      dryRun,
      status: 'completed',
      fixturesConsidered: discovery.entriesScanned,
    });
  }

  if (dryRun) {
    const finishedAt = clock().toISOString();
    log({
      event: 'competition_payload_backfill.dry_run_completed',
      workflow: 'competition-payload-backfill',
      competition: target.competitionKey,
      leagueId: target.leagueId,
      fixturesIngested: fixtures.length,
    });
    return {
      startedAt,
      finishedAt,
      competitionKey: target.competitionKey,
      apiFootballLeagueId: target.leagueId,
      kind: input.kind,
      fixturesConsidered: discovery.entriesScanned,
      fixturesMatched: fixtures.length,
      fixtures,
      fixturesProcessed: 0,
      fixturesOk: 0,
      fixturesEmpty: 0,
      fixturesSkipped: 0,
      fixturesFailed: 0,
      callsUsed: 0,
      status: 'completed',
      degradeFlags: [],
      finalQuota: undefined,
      errors: [],
      dryRun: true,
    };
  }

  // Execute: hand the matched fixture ids to the existing general sweep via
  // its `fixtureIds` escape hatch. This is the ONLY place this workflow
  // touches provider-calling machinery, and it does so by calling the
  // production code path rather than duplicating it — fetch/cache/quota/
  // degrade/idempotency behaviour is identical to any other sweep run.
  const sweepResult = await sweepMissingPayloadsWorkflow(
    {
      providerId: API_FOOTBALL_PROVIDER_ID,
      kind: input.kind,
      fixtureIds: fixtures.map((f) => f.providerFixtureId),
      limit: fixtures.length,
      dryRun: false,
      intercallDelayMs: input.intercallDelayMs,
      nowUtc: input.nowUtc,
    },
    deps
  );

  const finishedAt = sweepResult.finishedAt;
  log({
    event: 'competition_payload_backfill.finished',
    workflow: 'competition-payload-backfill',
    competition: target.competitionKey,
    leagueId: target.leagueId,
    workload: input.kind,
    status: sweepResult.status,
    callsUsed: sweepResult.callsUsed,
    fixturesIngested: sweepResult.fixturesOk,
    fixturesEmpty: sweepResult.fixturesEmpty,
  });

  const status: CompetitionPayloadBackfillOutput['status'] =
    sweepResult.status === 'skipped' ? 'aborted' : sweepResult.status;

  return {
    startedAt,
    finishedAt,
    competitionKey: target.competitionKey,
    apiFootballLeagueId: target.leagueId,
    kind: input.kind,
    fixturesConsidered: discovery.entriesScanned,
    fixturesMatched: fixtures.length,
    fixtures,
    fixturesProcessed: sweepResult.fixturesProcessed,
    fixturesOk: sweepResult.fixturesOk,
    fixturesEmpty: sweepResult.fixturesEmpty,
    fixturesSkipped: sweepResult.fixturesSkipped,
    fixturesFailed: sweepResult.fixturesFailed,
    callsUsed: sweepResult.callsUsed,
    status,
    degradeFlags: sweepResult.degradeFlags,
    finalQuota: sweepResult.finalQuota,
    errors: sweepResult.errors,
    dryRun: false,
    reason: sweepResult.reason,
  };
};
