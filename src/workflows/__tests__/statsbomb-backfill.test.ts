/**
 * Tests for the StatsBomb Open Data backfill workflow.
 *
 * Covers:
 *   - Match enumeration from a matches/<comp>/<season>.json envelope
 *   - Explicit matchIds override
 *   - skip on no fixture mapping (the default state — static map is a stub)
 *   - Happy path: fixtureMap override -> LookupGameByFixture -> ingest, with
 *     occurrence ids = stable StatsBomb event UUIDs (idempotency contract)
 *   - 360 frames threaded through (visible_area populated)
 *   - Dry-run mode (resolves canonical id, skips fetch + ingest)
 *   - game_lookup_not_wired / game_service_not_wired guards
 *   - matchIdsFromMatchesEnvelope helper
 *
 * No live network: the StatsBombFetch boundary is stubbed with an in-memory
 * URL → JSON map.
 */
import { describe, expect, it, vi } from 'vitest';

import { create } from '@bufbuild/protobuf';
import {
  type IngestBatchResponse,
  type IngestGameOccurrencesRequest,
  type LookupGameByFixtureRequest,
  type LookupGameByFixtureResponse,
  LookupGameByFixtureResponseSchema,
  IngestBatchResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import type {
  FootballGameIngestClient,
  FootballGameLookupClient,
} from '../../worker/clients/game-service.js';
import type { StatsBombBackfillInput, StatsBombFetch, WorkflowDeps } from '../types.js';
import { statsbombBackfillWorkflow, __test } from '../statsbomb-backfill.js';

const { matchIdsFromMatchesEnvelope, DEFAULT_STATSBOMB_BASE_URL } = __test;

// ── Fixtures ────────────────────────────────────────────────────────────────

const GAME_ID = 'btl_football_game_wc2022_final';
const SB_MATCH_ID = 3869685;
const API_FIXTURE_ID = 555111;

/** A matches/<comp>/<season>.json envelope (flat array of match objects). */
const matchesEnvelope = (matchIds: number[]): unknown =>
  matchIds.map((id) => ({
    match_id: id,
    match_date: '2022-12-18',
    home_team: { home_team_id: 1, home_team_name: 'Argentina' },
    away_team: { away_team_id: 2, away_team_name: 'France' },
  }));

/** A minimal events array with one shot bearing a freeze_frame. */
const eventsEnvelope = (): unknown => [
  {
    id: '545c2c84-018f-4570-a01c-753823feaeac',
    index: 1,
    period: 1,
    timestamp: '00:04:40.798',
    minute: 4,
    second: 40,
    type: { id: 16, name: 'Shot' },
    possession: 1,
    possession_team: { id: 779, name: 'Argentina' },
    play_pattern: { id: 1, name: 'Regular Play' },
    team: { id: 779, name: 'Argentina' },
    player: { id: 27886, name: 'Alexis Mac Allister' },
    position: { id: 15, name: 'Left Center Midfield' },
    location: [92.4, 30],
    shot: {
      statsbomb_xg: 0.0245,
      end_location: [117.3, 38.3, 0.8],
      outcome: { id: 100, name: 'Saved' },
      type: { id: 87, name: 'Open Play' },
      body_part: { id: 40, name: 'Right Foot' },
      freeze_frame: [
        {
          location: [117.4, 38.5],
          player: { id: 3099, name: 'Hugo Lloris' },
          position: { id: 1, name: 'Goalkeeper' },
          teammate: false,
        },
      ],
    },
  },
];

/** A 360 frame matching the shot's event uuid, with a visible_area polygon. */
const threeSixtyEnvelope = (): unknown => [
  {
    event_uuid: '545c2c84-018f-4570-a01c-753823feaeac',
    visible_area: [99.5, 74.7, 74.8, 62.7, 89.0, 0, 120, 0],
    freeze_frame: [{ teammate: true, actor: false, keeper: false, location: [76, 60] }],
  },
];

/**
 * Build a stub StatsBombFetch from a URL → JSON map. Unknown URLs resolve to a
 * 404 (ok:false), which the workflow treats as a missing/optional file.
 */
const stubFetch = (byUrl: Record<string, unknown>): StatsBombFetch => {
  return vi.fn(async (url: string) => {
    if (url in byUrl) {
      return { ok: true, status: 200, json: async () => byUrl[url] };
    }
    return { ok: false, status: 404, json: async () => undefined };
  });
};

const okIngestResponse = (): IngestBatchResponse =>
  create(IngestBatchResponseSchema, { acceptedCount: 1, updatedCount: 0 });

const foundLookupResponse = (gameId: string): LookupGameByFixtureResponse =>
  create(LookupGameByFixtureResponseSchema, { found: true, gameId });

interface Mocks {
  readonly lookupGameByFixture: ReturnType<typeof vi.fn>;
  readonly ingestGameOccurrences: ReturnType<typeof vi.fn>;
}

const buildDeps = (
  overrides: {
    readonly fetcher?: StatsBombFetch;
    readonly withLookup?: boolean;
    readonly withGameService?: boolean;
    readonly lookupResponse?: LookupGameByFixtureResponse;
  } = {}
): { deps: WorkflowDeps; mocks: Mocks } => {
  const lookupGameByFixture = vi.fn(
    async (_req: LookupGameByFixtureRequest): Promise<LookupGameByFixtureResponse> =>
      overrides.lookupResponse ?? foundLookupResponse(GAME_ID)
  );
  const ingestGameOccurrences = vi.fn(
    async (_req: IngestGameOccurrencesRequest): Promise<IngestBatchResponse> => okIngestResponse()
  );

  const gameLookup: FootballGameLookupClient | undefined =
    overrides.withLookup === false ? undefined : { lookupGameByFixture };
  const gameService: FootballGameIngestClient | undefined =
    overrides.withGameService === false
      ? undefined
      : ({
          ingestGameOccurrences,
        } as unknown as FootballGameIngestClient);

  const deps: WorkflowDeps = {
    // ingestion is required by the type but unused on the StatsBomb path.
    ingestion: {} as unknown as WorkflowDeps['ingestion'],
    competitions: [],
    statsbombFetch: overrides.fetcher,
    gameLookup,
    gameService,
    clock: () => new Date('2026-06-18T00:00:00.000Z'),
  };
  return { deps, mocks: { lookupGameByFixture, ingestGameOccurrences } };
};

const fullFetch = (): StatsBombFetch =>
  stubFetch({
    [`${DEFAULT_STATSBOMB_BASE_URL}/matches/43/106.json`]: matchesEnvelope([SB_MATCH_ID]),
    [`${DEFAULT_STATSBOMB_BASE_URL}/events/${SB_MATCH_ID}.json`]: eventsEnvelope(),
    [`${DEFAULT_STATSBOMB_BASE_URL}/three-sixty/${SB_MATCH_ID}.json`]: threeSixtyEnvelope(),
  });

const run = (input: StatsBombBackfillInput, depsOverrides?: Parameters<typeof buildDeps>[0]) => {
  const { deps, mocks } = buildDeps(depsOverrides);
  return { promise: statsbombBackfillWorkflow(input, deps), mocks };
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('matchIdsFromMatchesEnvelope', () => {
  it('extracts numeric match_ids from a matches envelope', () => {
    expect(matchIdsFromMatchesEnvelope(matchesEnvelope([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('ignores non-array / malformed input', () => {
    expect(matchIdsFromMatchesEnvelope(undefined)).toEqual([]);
    expect(matchIdsFromMatchesEnvelope({})).toEqual([]);
    expect(matchIdsFromMatchesEnvelope([{ foo: 1 }, { match_id: 'x' }])).toEqual([]);
  });
});

describe('statsbombBackfillWorkflow', () => {
  it('enumerates WC2022 matches from the matches file when matchIds omitted', async () => {
    const { promise } = run({}, { fetcher: fullFetch() });
    const out = await promise;
    expect(out.matchesDiscovered).toBe(1);
    // No mapping for this match in the static stub -> skipped.
    expect(out.matchesSkipped).toBe(1);
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('no_fixture_mapping');
    expect(out.status).toBe('completed');
  });

  it('skips matches with no fixture mapping (static map is a stub)', async () => {
    const { promise, mocks } = run({ matchIds: [SB_MATCH_ID] }, { fetcher: fullFetch() });
    const out = await promise;
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('no_fixture_mapping');
    expect(mocks.lookupGameByFixture).not.toHaveBeenCalled();
    expect(mocks.ingestGameOccurrences).not.toHaveBeenCalled();
  });

  it('ingests occurrences under the canonical game id via a fixtureMap override', async () => {
    const { promise, mocks } = run(
      { matchIds: [SB_MATCH_ID], fixtureMap: { [SB_MATCH_ID]: API_FIXTURE_ID } },
      { fetcher: fullFetch() }
    );
    const out = await promise;

    // Lookup uses the api-football provider + the mapped fixture id.
    expect(mocks.lookupGameByFixture).toHaveBeenCalledTimes(1);
    const lookupReq = mocks.lookupGameByFixture.mock.calls[0][0] as LookupGameByFixtureRequest;
    expect(lookupReq.provider).toBe('api-football');
    expect(lookupReq.providerFixtureId).toBe(String(API_FIXTURE_ID));

    // Ingest fired under the resolved canonical game id.
    expect(mocks.ingestGameOccurrences).toHaveBeenCalledTimes(1);
    const ingestReq = mocks.ingestGameOccurrences.mock.calls[0][0] as IngestGameOccurrencesRequest;
    expect(ingestReq.gameId).toBe(GAME_ID);
    expect(ingestReq.occurrences.length).toBe(1);
    // Idempotency contract: occurrence id == the stable StatsBomb event UUID.
    expect(ingestReq.occurrences[0].id).toBe('545c2c84-018f-4570-a01c-753823feaeac');

    expect(out.matchesOk).toBe(1);
    expect(out.matches[0].status).toBe('ok');
    expect(out.matches[0].gameId).toBe(GAME_ID);
    expect(out.matches[0].acceptedCount).toBe(1);
    expect(out.matches[0].threeSixtyApplied).toBe(true);
    expect(out.status).toBe('completed');
  });

  it('threads 360 visible_area into the ingested occurrence', async () => {
    const { promise, mocks } = run(
      { matchIds: [SB_MATCH_ID], fixtureMap: { [SB_MATCH_ID]: API_FIXTURE_ID } },
      { fetcher: fullFetch() }
    );
    await promise;
    const ingestReq = mocks.ingestGameOccurrences.mock.calls[0][0] as IngestGameOccurrencesRequest;
    const occ = ingestReq.occurrences[0];
    // Action payload carries the 360 visible_area (8 flat coords -> 4 points).
    if (occ.payload.case === 'action' && occ.payload.value.action.case === 'football') {
      expect(occ.payload.value.action.value.visibleArea.length).toBe(4);
    } else {
      throw new Error('expected a football action payload');
    }
  });

  it('dry-run resolves the canonical id but does not fetch events or ingest', async () => {
    const fetcher = fullFetch();
    const { promise, mocks } = run(
      { matchIds: [SB_MATCH_ID], fixtureMap: { [SB_MATCH_ID]: API_FIXTURE_ID }, dryRun: true },
      { fetcher }
    );
    const out = await promise;
    expect(mocks.lookupGameByFixture).toHaveBeenCalledTimes(1);
    expect(mocks.ingestGameOccurrences).not.toHaveBeenCalled();
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('dry_run');
    expect(out.matches[0].gameId).toBe(GAME_ID);
    // Only the lookup happened; no events/360 fetch in dry-run.
    expect(fetcher).not.toHaveBeenCalledWith(
      `${DEFAULT_STATSBOMB_BASE_URL}/events/${SB_MATCH_ID}.json`
    );
  });

  it('skips with game_lookup_not_wired when no lookup client is wired', async () => {
    const { promise } = run(
      { matchIds: [SB_MATCH_ID], fixtureMap: { [SB_MATCH_ID]: API_FIXTURE_ID } },
      { fetcher: fullFetch(), withLookup: false }
    );
    const out = await promise;
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('game_lookup_not_wired');
  });

  it('skips with game_service_not_wired when no ingest client is wired', async () => {
    const { promise } = run(
      { matchIds: [SB_MATCH_ID], fixtureMap: { [SB_MATCH_ID]: API_FIXTURE_ID } },
      { fetcher: fullFetch(), withGameService: false }
    );
    const out = await promise;
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('game_service_not_wired');
  });

  it('skips with game_not_found when the crosswalk has no canonical id', async () => {
    const { promise } = run(
      { matchIds: [SB_MATCH_ID], fixtureMap: { [SB_MATCH_ID]: API_FIXTURE_ID } },
      {
        fetcher: fullFetch(),
        lookupResponse: create(LookupGameByFixtureResponseSchema, { found: false, gameId: '' }),
      }
    );
    const out = await promise;
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('game_not_found');
  });

  it('fails the match when events are missing but the game resolved', async () => {
    // matches + mapping present, but no events file in the stub.
    const fetcher = stubFetch({
      [`${DEFAULT_STATSBOMB_BASE_URL}/matches/43/106.json`]: matchesEnvelope([SB_MATCH_ID]),
    });
    const { promise } = run(
      { matchIds: [SB_MATCH_ID], fixtureMap: { [SB_MATCH_ID]: API_FIXTURE_ID } },
      { fetcher }
    );
    const out = await promise;
    expect(out.matches[0].status).toBe('failed');
    expect(out.matches[0].reason).toBe('empty_or_missing_events');
    expect(out.status).toBe('partial');
  });
});
