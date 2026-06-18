/**
 * Tests for the StatsBomb Open Data backfill workflow.
 *
 * StatsBomb is a STANDALONE source: per match the workflow mints its own
 * canonical game (IngestGames find-or-mint), reads back the canonical id via
 * `LookupGameByFixture('statsbomb-open', match_id)`, then fetches events + 360
 * and ingests occurrences under that id. There is NO api-football dependency.
 *
 * Covers:
 *   - Match enumeration from a matches/<comp>/<season>.json envelope
 *   - matchIds as a FILTER over the enumerated matches (run just the final)
 *   - skip when a filter id has no metadata row in the matches file
 *   - Happy path: mint -> lookup(statsbomb-open) -> ingest occurrences, with
 *     occurrence ids = stable StatsBomb event UUIDs (idempotency contract)
 *   - The minted game carries the StatsBomb match teams as unresolved refs
 *   - 360 frames threaded through (visible_area populated)
 *   - Dry-run mode (mints + resolves canonical id, skips events fetch + ingest)
 *   - game_service_not_wired / game_lookup_not_wired / game_not_found guards
 *   - matchesFromEnvelope / matchIdsFromMatchesEnvelope helpers
 *
 * No live network: the StatsBombFetch boundary is stubbed with an in-memory
 * URL → JSON map.
 */
import { describe, expect, it, vi } from 'vitest';

import { create } from '@bufbuild/protobuf';
import {
  type IngestBatchResponse,
  type IngestGameOccurrencesRequest,
  type IngestGamesRequest,
  type LookupGameByFixtureRequest,
  type LookupGameByFixtureResponse,
  LookupGameByFixtureResponseSchema,
  IngestBatchResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import { GameParticipantRole } from '@breakingthelines/protos/btl/game/v1/types/game_pb';

import type {
  FootballGameIngestClient,
  FootballGameLookupClient,
} from '../../worker/clients/game-service.js';
import type { StatsBombBackfillInput, StatsBombFetch, WorkflowDeps } from '../types.js';
import { statsbombBackfillWorkflow, __test } from '../statsbomb-backfill.js';

const { matchIdsFromMatchesEnvelope, matchesFromEnvelope, DEFAULT_STATSBOMB_BASE_URL } = __test;

// ── Fixtures ────────────────────────────────────────────────────────────────

const GAME_ID = 'btl_football_game_wc2022_final';
const SB_MATCH_ID = 3869685;
const OTHER_MATCH_ID = 3869684;

/**
 * A matches/<comp>/<season>.json envelope (flat array of match objects),
 * mirroring the real WC2022 file shape: prefixed team keys + suffixed
 * competition/season keys + a kick_off paired with match_date.
 */
const matchesEnvelope = (matchIds: number[]): unknown =>
  matchIds.map((id) => ({
    match_id: id,
    match_date: '2022-12-18',
    kick_off: '18:00:00.000',
    competition: {
      competition_id: 43,
      country_name: 'International',
      competition_name: 'FIFA World Cup',
    },
    season: { season_id: 106, season_name: '2022' },
    home_team: { home_team_id: 779, home_team_name: 'Argentina' },
    away_team: { away_team_id: 771, away_team_name: 'France' },
    home_score: 3,
    away_score: 3,
    match_status: 'available',
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
  readonly ingestGames: ReturnType<typeof vi.fn>;
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
  const ingestGames = vi.fn(
    async (_req: IngestGamesRequest): Promise<IngestBatchResponse> => okIngestResponse()
  );
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
          ingestGames,
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
  return { deps, mocks: { ingestGames, lookupGameByFixture, ingestGameOccurrences } };
};

const fullFetch = (matchIds: number[] = [SB_MATCH_ID]): StatsBombFetch =>
  stubFetch({
    [`${DEFAULT_STATSBOMB_BASE_URL}/matches/43/106.json`]: matchesEnvelope(matchIds),
    [`${DEFAULT_STATSBOMB_BASE_URL}/events/${SB_MATCH_ID}.json`]: eventsEnvelope(),
    [`${DEFAULT_STATSBOMB_BASE_URL}/three-sixty/${SB_MATCH_ID}.json`]: threeSixtyEnvelope(),
  });

const run = (input: StatsBombBackfillInput, depsOverrides?: Parameters<typeof buildDeps>[0]) => {
  const { deps, mocks } = buildDeps(depsOverrides);
  return { promise: statsbombBackfillWorkflow(input, deps), mocks };
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('matchesFromEnvelope', () => {
  it('extracts match_id -> match for each row', () => {
    const byId = matchesFromEnvelope(matchesEnvelope([1, 2]));
    expect([...byId.keys()]).toEqual([1, 2]);
    expect(byId.get(1)?.competition.competition_id).toBe(43);
  });

  it('ignores non-array / malformed input', () => {
    expect(matchesFromEnvelope(undefined).size).toBe(0);
    expect(matchesFromEnvelope({}).size).toBe(0);
    expect(matchesFromEnvelope([{ foo: 1 }, { match_id: 'x' }]).size).toBe(0);
  });
});

describe('matchIdsFromMatchesEnvelope', () => {
  it('extracts numeric match_ids from a matches envelope', () => {
    expect(matchIdsFromMatchesEnvelope(matchesEnvelope([1, 2, 3]))).toEqual([1, 2, 3]);
  });
});

describe('statsbombBackfillWorkflow', () => {
  it('enumerates + mints all WC2022 matches from the matches file when matchIds omitted', async () => {
    const { promise, mocks } = run({}, { fetcher: fullFetch() });
    const out = await promise;
    expect(out.matchesDiscovered).toBe(1);
    expect(out.matchesOk).toBe(1);
    expect(mocks.ingestGames).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('completed');
  });

  it('mints the canonical game, looks it up under statsbomb-open, then ingests occurrences', async () => {
    const { promise, mocks } = run({ matchIds: [SB_MATCH_ID] }, { fetcher: fullFetch() });
    const out = await promise;

    // 1. Mint: IngestGames with the StatsBomb-sourced game.
    expect(mocks.ingestGames).toHaveBeenCalledTimes(1);
    const gamesReq = mocks.ingestGames.mock.calls[0][0] as IngestGamesRequest;
    expect(gamesReq.metadata?.provider).toBe('statsbomb-open');
    expect(gamesReq.games.length).toBe(1);
    const minted = gamesReq.games[0];
    expect(minted.providerGameId).toBe(String(SB_MATCH_ID));
    expect(minted.participants.length).toBe(2);
    expect(minted.participants[0].role).toBe(GameParticipantRole.HOME);
    expect(minted.participants[0].resolutionRef?.providerRef?.provider).toBe('statsbomb-open');
    expect(minted.participants[0].resolutionRef?.providerRef?.providerId).toBe('779');
    expect(minted.participants[1].resolutionRef?.providerRef?.providerId).toBe('771');

    // 2. Lookup: keyed under the statsbomb-open provider + the match id.
    expect(mocks.lookupGameByFixture).toHaveBeenCalledTimes(1);
    const lookupReq = mocks.lookupGameByFixture.mock.calls[0][0] as LookupGameByFixtureRequest;
    expect(lookupReq.provider).toBe('statsbomb-open');
    expect(lookupReq.providerFixtureId).toBe(String(SB_MATCH_ID));

    // 3. Ingest occurrences under the resolved canonical game id.
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

  it('uses matchIds as a filter to run just one match out of many', async () => {
    const { promise, mocks } = run(
      { matchIds: [SB_MATCH_ID] },
      { fetcher: fullFetch([OTHER_MATCH_ID, SB_MATCH_ID]) }
    );
    const out = await promise;
    // Only the requested match is processed even though two are enumerated.
    expect(out.matchesDiscovered).toBe(1);
    expect(out.matchesOk).toBe(1);
    expect(mocks.ingestGames).toHaveBeenCalledTimes(1);
    const gamesReq = mocks.ingestGames.mock.calls[0][0] as IngestGamesRequest;
    expect(gamesReq.games[0].providerGameId).toBe(String(SB_MATCH_ID));
  });

  it('skips a filter id with no metadata row in the matches file', async () => {
    const { promise, mocks } = run({ matchIds: [999999] }, { fetcher: fullFetch([SB_MATCH_ID]) });
    const out = await promise;
    // The id is filtered out at enumeration (no metadata to mint from).
    expect(out.matchesDiscovered).toBe(0);
    expect(out.matchesProcessed).toBe(0);
    expect(mocks.ingestGames).not.toHaveBeenCalled();
    expect(out.status).toBe('completed');
  });

  it('threads 360 visible_area into the ingested occurrence', async () => {
    const { promise, mocks } = run({ matchIds: [SB_MATCH_ID] }, { fetcher: fullFetch() });
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

  it('dry-run mints + resolves the canonical id but does not fetch events or ingest', async () => {
    const fetcher = fullFetch();
    const { promise, mocks } = run({ matchIds: [SB_MATCH_ID], dryRun: true }, { fetcher });
    const out = await promise;
    // Mint + lookup still happen; occurrences do not.
    expect(mocks.ingestGames).toHaveBeenCalledTimes(1);
    expect(mocks.lookupGameByFixture).toHaveBeenCalledTimes(1);
    expect(mocks.ingestGameOccurrences).not.toHaveBeenCalled();
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('dry_run');
    expect(out.matches[0].gameId).toBe(GAME_ID);
    // Only matches + lookup; no events/360 fetch in dry-run.
    expect(fetcher).not.toHaveBeenCalledWith(
      `${DEFAULT_STATSBOMB_BASE_URL}/events/${SB_MATCH_ID}.json`
    );
  });

  it('skips with game_service_not_wired when no ingest client is wired', async () => {
    const { promise } = run(
      { matchIds: [SB_MATCH_ID] },
      { fetcher: fullFetch(), withGameService: false }
    );
    const out = await promise;
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('game_service_not_wired');
  });

  it('skips with game_lookup_not_wired when no lookup client is wired', async () => {
    const { promise } = run(
      { matchIds: [SB_MATCH_ID] },
      { fetcher: fullFetch(), withLookup: false }
    );
    const out = await promise;
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('game_lookup_not_wired');
  });

  it('skips with game_not_found when the mint+crosswalk yields no canonical id', async () => {
    const { promise, mocks } = run(
      { matchIds: [SB_MATCH_ID] },
      {
        fetcher: fullFetch(),
        lookupResponse: create(LookupGameByFixtureResponseSchema, { found: false, gameId: '' }),
      }
    );
    const out = await promise;
    // The game was still minted; only the read-back missed.
    expect(mocks.ingestGames).toHaveBeenCalledTimes(1);
    expect(out.matches[0].status).toBe('skipped');
    expect(out.matches[0].reason).toBe('game_not_found');
  });

  it('fails the match when events are missing but the game minted + resolved', async () => {
    // matches present (so the game mints + resolves), but no events file.
    const fetcher = stubFetch({
      [`${DEFAULT_STATSBOMB_BASE_URL}/matches/43/106.json`]: matchesEnvelope([SB_MATCH_ID]),
    });
    const { promise, mocks } = run({ matchIds: [SB_MATCH_ID] }, { fetcher });
    const out = await promise;
    expect(mocks.ingestGames).toHaveBeenCalledTimes(1);
    expect(out.matches[0].status).toBe('failed');
    expect(out.matches[0].reason).toBe('empty_or_missing_events');
    expect(out.matches[0].gameId).toBe(GAME_ID);
    expect(out.status).toBe('partial');
  });

  it('fails the match when IngestGames throws', async () => {
    const { deps, mocks } = buildDeps({ fetcher: fullFetch() });
    mocks.ingestGames.mockRejectedValueOnce(new Error('mint boom'));
    const out = await statsbombBackfillWorkflow({ matchIds: [SB_MATCH_ID] }, deps);
    expect(out.matches[0].status).toBe('failed');
    expect(out.matches[0].reason).toContain('ingest_games');
    expect(mocks.lookupGameByFixture).not.toHaveBeenCalled();
    expect(out.status).toBe('partial');
  });
});
