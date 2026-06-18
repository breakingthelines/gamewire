/**
 * StatsBomb Open Data → canonical `Game` adapter.
 *
 * Builds an {@link IngestGamesRequest} from a StatsBomb match-envelope entry
 * (one element of `matches/<competition>/<season>.json`) so the StatsBomb open
 * data set can MINT its own canonical game via game-service `IngestGames`
 * find-or-mint — with no dependency on api-football having ingested the match
 * first.
 *
 * Why standalone
 * --------------
 * The occurrence path (`fromStatsBombOpen`) needs a canonical `game_id` to hang
 * occurrences off. Previously the backfill resolved that id by mapping each
 * StatsBomb match to an api-football fixture id and calling
 * `LookupGameByFixture('api-football', …)` — i.e. it assumed api-football had
 * already minted the game. But api-football has NO WC2022 data, so that lookup
 * always missed. StatsBomb ships everything needed to mint the game itself
 * (match metadata + the two teams), and game-service `IngestGames` is
 * find-or-mint: a Game with resolved participants either attaches to an existing
 * canonical game or mints a new one. So we ingest a StatsBomb-sourced Game,
 * then `LookupGameByFixture('statsbomb-open', String(match_id))` to read back
 * the canonical id game-service assigned.
 *
 * Identity resolution
 * -------------------
 * This adapter never fabricates BTL ids. Participants, competition and season
 * are emitted as UNRESOLVED provider refs (a {@link ProviderRef} under the
 * `statsbomb-open` provider). game-service resolves those to canonical BTL
 * entities via the identity crosswalk at ingest/read time — exactly as it does
 * for the api-football adapter's actors — which is what attaches teams + crests
 * to the minted game.
 *
 * Idempotency
 * -----------
 * `Game.provider_game_id = String(match_id)` and the crosswalk key
 * `(statsbomb-open, match_id)` are stable, so re-ingesting the same match finds
 * the same canonical game (upsert) rather than minting a duplicate.
 */
import { create } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromMs } from '@bufbuild/protobuf/wkt';

import {
  IngestGamesRequestSchema,
  IngestMetadataSchema,
  type IngestGamesRequest,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';
import {
  Sport,
  SubjectRefSchema,
  SubjectType,
} from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  EntityResolutionRefSchema,
  GameParticipantRole,
  GameParticipantSchema,
  GameScoreSchema,
  GameSchema,
  GameStatus,
  ParticipantScoreSchema,
  ProviderEntitySnapshotSchema,
  ProviderRefSchema,
  ResolutionState,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import { FootballScorePayloadSchema } from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';

import { STATSBOMB_OPEN_PROVIDER_ID } from './adapter.js';
import type { StatsBombMatch, StatsBombTeam } from './types.js';

// =============================================================================
// SIDE ACCESSOR
// =============================================================================

/** The id + name for one side, read off StatsBomb's prefixed team shape. */
interface TeamSide {
  readonly id: number;
  readonly name: string;
}

/**
 * Read a single side's `{ id, name }` off a StatsBomb match-envelope team.
 *
 * StatsBomb prefixes team fields with the side (`home_team_id`/`home_team_name`
 * vs `away_team_id`/`away_team_name`), so the same {@link StatsBombTeam} shape
 * is used for both and only the relevant side's keys are populated. Returns
 * `undefined` when the side's id is missing/non-finite so the caller can skip a
 * malformed match rather than mint a participant with an empty provider id.
 */
export function teamSideFromMatchTeam(
  team: StatsBombTeam | undefined,
  side: 'home' | 'away'
): TeamSide | undefined {
  if (team === undefined || team === null) {
    return undefined;
  }
  const id = side === 'home' ? team.home_team_id : team.away_team_id;
  const name = side === 'home' ? team.home_team_name : team.away_team_name;
  if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) {
    return undefined;
  }
  return { id, name: typeof name === 'string' ? name : '' };
}

// =============================================================================
// PROVIDER-SCOPED IDS + SLUG
// =============================================================================

/**
 * The provider-scoped storage id `provider:<providerId>:<type>:<id>`. Mirrors
 * the api-football adapter's `providerStorageId` sentinel: game-service writes
 * this into `games.competition_id` / `season_id` on an identity miss, so a
 * not-yet-canonicalized competition (e.g. WC2022 before an identity backfill)
 * still yields a stable, filterable id that a later backfill rebinds to the
 * canonical `btl_football_*` id.
 */
function providerStorageId(resourceType: string, providerId: string | number): string {
  return `provider:${STATSBOMB_OPEN_PROVIDER_ID}:${resourceType}:${String(providerId).trim()}`;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// =============================================================================
// KICKOFF
// =============================================================================

/**
 * Resolve the scheduled kickoff to epoch milliseconds from the match envelope's
 * `match_date` (a `YYYY-MM-DD` calendar date) and optional `kick_off`
 * (`HH:MM:SS.mmm`). StatsBomb provides no timezone, so the pair is interpreted
 * as UTC — consistent, stable, and good enough for ordering + day bucketing
 * (the canonical game is the source of identity, not a broadcast clock).
 * Returns `undefined` when `match_date` is missing or unparseable so the caller
 * omits `scheduled_start` rather than emitting an epoch-zero timestamp.
 */
export function kickoffMsFromMatch(
  match: Pick<StatsBombMatch, 'match_date' | 'kick_off'>
): number | undefined {
  const date = typeof match.match_date === 'string' ? match.match_date.trim() : '';
  if (date === '') {
    return undefined;
  }
  const kickOff = typeof match.kick_off === 'string' ? match.kick_off.trim() : '';
  // `YYYY-MM-DDTHH:MM:SS.mmmZ` parses as UTC; date-only `YYYY-MM-DD` also parses
  // as UTC midnight under the ISO date-only rule.
  const iso = kickOff === '' ? date : `${date}T${kickOff}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    // Fall back to the date alone if the combined string failed (e.g. an
    // unexpected kick_off format) so we still anchor the game to its day.
    const dateMs = Date.parse(date);
    return Number.isFinite(dateMs) ? dateMs : undefined;
  }
  return ms;
}

// =============================================================================
// UNRESOLVED PROVIDER REF
// =============================================================================

/**
 * Build an UNRESOLVED provider {@link EntityResolutionRef} for a participant.
 * `entity_id` is left empty and `state` is UNRESOLVED_PROVIDER_REF; the
 * `provider_ref` carries the StatsBomb team id under the `statsbomb-open`
 * provider, and `display_label` carries the team name. game-service resolves
 * this to a canonical BTL team (and its crest) via the identity crosswalk —
 * the same mechanism the api-football adapter relies on.
 */
function unresolvedTeamRef(team: TeamSide) {
  return create(EntityResolutionRefSchema, {
    entityId: '',
    entityType: SubjectType.TEAM,
    state: ResolutionState.UNRESOLVED_PROVIDER_REF,
    providerRef: create(ProviderRefSchema, {
      provider: STATSBOMB_OPEN_PROVIDER_ID,
      providerId: String(team.id),
      providerResourceType: 'team',
    }),
    displayLabel: team.name,
    providerSnapshot:
      team.name !== ''
        ? create(ProviderEntitySnapshotSchema, {
            label: team.name,
            slug: slugify(team.name),
            attributes: { provider_team_id: String(team.id) },
          })
        : undefined,
  });
}

/**
 * Mint a provider-scoped fallback {@link SubjectRef} for the competition or
 * season. game-service writes `SubjectRef.id` into the
 * `games.competition_id` / `season_id` columns; emitting the
 * `provider:statsbomb-open:<type>:<id>` sentinel (rather than dropping the
 * subject) keeps the minted WC2022 games filterable by competition on the
 * predict screen even before an identity backfill canonicalizes the World Cup.
 */
function providerSubject(
  resourceType: 'competition' | 'season',
  providerId: number,
  type: SubjectType,
  label: string
) {
  return create(SubjectRefSchema, {
    id: providerStorageId(resourceType, providerId),
    type,
    sport: Sport.FOOTBALL,
    label,
    slug: slugify(label),
  });
}

// =============================================================================
// GAME
// =============================================================================

/**
 * Convert a single StatsBomb match-envelope entry to a canonical {@link Game}
 * for an {@link IngestGamesRequest}. Returns `null` when either side's team id
 * is missing (a malformed match the caller should skip) so we never mint a game
 * with an unresolvable participant.
 *
 * The shape mirrors the api-football adapter's `liveGame`:
 *   - `sport = FOOTBALL`, `provider_game_id = String(match_id)`.
 *   - `competition` / `season` as provider-scoped fallback SubjectRefs (so
 *     `competition_id` / `season_id` are always populated + filterable).
 *   - two `participants` (HOME, AWAY), each with an UNRESOLVED provider
 *     `resolution_ref` (team id under `statsbomb-open`) and `subject` left
 *     unset for game-service to resolve via the identity crosswalk.
 *   - `scheduled_start` from `match_date` + `kick_off` (UTC).
 *   - `status` + `score` from the final scoreline when present (WC2022 matches
 *     are all played), else SCHEDULED with no score.
 *   - a top-level `resolution_ref` for the game itself (UNRESOLVED; the
 *     provider fixture ref game-service keys the crosswalk on).
 */
export function gameFromStatsBombMatch(match: StatsBombMatch) {
  if (
    match === undefined ||
    match === null ||
    typeof match.match_id !== 'number' ||
    !Number.isFinite(match.match_id) ||
    match.match_id <= 0
  ) {
    return null;
  }
  const home = teamSideFromMatchTeam(match.home_team, 'home');
  const away = teamSideFromMatchTeam(match.away_team, 'away');
  if (home === undefined || away === undefined) {
    return null;
  }

  const providerGameId = String(match.match_id);

  const competition =
    match.competition && Number.isFinite(match.competition.competition_id)
      ? providerSubject(
          'competition',
          match.competition.competition_id,
          SubjectType.COMPETITION,
          match.competition.competition_name ?? ''
        )
      : undefined;
  const season =
    match.season && Number.isFinite(match.season.season_id)
      ? providerSubject(
          'season',
          match.season.season_id,
          SubjectType.SEASON,
          [match.season.season_name, match.competition?.competition_name]
            .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
            .join(' ')
        )
      : undefined;

  const scheduledStartMs = kickoffMsFromMatch(match);

  const homeGoals = typeof match.home_score === 'number' ? match.home_score : undefined;
  const awayGoals = typeof match.away_score === 'number' ? match.away_score : undefined;
  const hasScore = homeGoals !== undefined && awayGoals !== undefined;

  const gameResolutionRef = create(EntityResolutionRefSchema, {
    entityId: '',
    entityType: SubjectType.GAME,
    state: ResolutionState.UNRESOLVED_PROVIDER_REF,
    providerRef: create(ProviderRefSchema, {
      provider: STATSBOMB_OPEN_PROVIDER_ID,
      providerId: providerGameId,
      providerResourceType: 'fixture',
    }),
    displayLabel: `${home.name} v ${away.name}`,
  });

  return create(GameSchema, {
    sport: Sport.FOOTBALL,
    providerGameId,
    competition,
    season,
    participants: [
      create(GameParticipantSchema, {
        resolutionRef: unresolvedTeamRef(home),
        role: GameParticipantRole.HOME,
        sortOrder: 1,
      }),
      create(GameParticipantSchema, {
        resolutionRef: unresolvedTeamRef(away),
        role: GameParticipantRole.AWAY,
        sortOrder: 2,
      }),
    ],
    scheduledStart:
      scheduledStartMs !== undefined
        ? create(TimestampSchema, timestampFromMs(scheduledStartMs))
        : undefined,
    // WC2022 matches are historical + complete; when the envelope carries a
    // scoreline we mint the game as FINISHED with that score. Absent a score we
    // fall back to SCHEDULED (the honest default for an as-yet-unplayed match).
    status: hasScore ? GameStatus.FINISHED : GameStatus.SCHEDULED,
    score: hasScore
      ? create(GameScoreSchema, {
          scores: [
            create(ParticipantScoreSchema, {
              participantId: providerStorageId('team', home.id),
              score: homeGoals ?? 0,
              display: String(homeGoals ?? 0),
            }),
            create(ParticipantScoreSchema, {
              participantId: providerStorageId('team', away.id),
              score: awayGoals ?? 0,
              display: String(awayGoals ?? 0),
            }),
          ],
          display: `${homeGoals ?? 0}-${awayGoals ?? 0}`,
          final: true,
          sportScore: {
            case: 'football',
            value: create(FootballScorePayloadSchema, {
              homeGoals: homeGoals ?? 0,
              awayGoals: awayGoals ?? 0,
            }),
          },
        })
      : undefined,
    resolutionRef: gameResolutionRef,
  });
}

// =============================================================================
// INGEST REQUEST
// =============================================================================

export interface GameFromStatsBombOpenOptions {
  /** Provider replay identifier used for idempotency + backfills. */
  readonly replayId?: string;
  /** Optional pointer to the raw match-envelope payload in object storage. */
  readonly rawPayloadRef?: string;
}

/**
 * Build an {@link IngestGamesRequest} that mints (find-or-mint) the canonical
 * game for a single StatsBomb match. The request carries exactly one
 * {@link Game}; an empty `games` array is returned for a malformed match so the
 * caller can treat it as a skip rather than crashing the run.
 *
 * @example
 * ```ts
 * const req = gameFromStatsBombOpen(match);
 * await gameService.ingestGames(req);                 // find-or-mint
 * const { gameId } = await gameLookup.lookupGameByFixture(
 *   create(LookupGameByFixtureRequestSchema, {
 *     provider: 'statsbomb-open',
 *     providerFixtureId: String(match.match_id),
 *   })
 * );
 * ```
 */
export function gameFromStatsBombOpen(
  match: StatsBombMatch,
  options: GameFromStatsBombOpenOptions = {}
): IngestGamesRequest {
  const game = gameFromStatsBombMatch(match);
  const matchId = typeof match?.match_id === 'number' ? match.match_id : 'unknown';
  const replayId = options.replayId ?? `statsbomb-open:game:${matchId}`;
  return create(IngestGamesRequestSchema, {
    metadata: create(IngestMetadataSchema, {
      provider: STATSBOMB_OPEN_PROVIDER_ID,
      replayId,
      rawPayloadRef: options.rawPayloadRef ?? '',
      normalizedBatchId: `statsbomb-open:games:${matchId}`,
      idempotencyKey: `statsbomb-open:games:${matchId}:${replayId}`,
    }),
    games: game ? [game] : [],
  });
}
