/**
 * StatsBomb Open Data adapter.
 *
 * Transforms StatsBomb Open Data events into BTL proto messages.
 */

import { create } from '@bufbuild/protobuf';

import {
  type IngestGameOccurrencesRequest,
  type GameOccurrence,
  type EntityResolutionRef,
  type PitchCoordinates,
  IngestGameOccurrencesRequestSchema,
  IngestMetadataSchema,
  GameClockSchema,
  GameOccurrenceKind,
  GameOccurrenceSchema,
  EntityResolutionRefSchema,
  ProviderRefSchema,
  ProviderEntitySnapshotSchema,
  SubjectType,
  OccurrenceRevisionState,
  ProviderAttributionSchema,
  ResolutionState,
  SportActionPayloadSchema,
  FootballActionPayloadSchema,
  FootballActionType,
  FootballClockPayloadSchema,
  FootballPeriod,
  PitchCoordinatesSchema,
  ShotEventDataSchema,
  FreezeFramePlayerSchema,
  PassEventDataSchema,
  CarryEventDataSchema,
  TackleEventDataSchema,
  InterceptionEventDataSchema,
  ShotOutcome,
  PassHeight,
  PassOutcome,
  TackleOutcome,
  InterceptionOutcome,
  BodyPart,
  DuelType,
} from '#/core/index.js';

import {
  type StatsBombEvent,
  type StatsBombFreezeFrame,
  type StatsBombLocation,
  type StatsBombThreeSixtyFrame,
  type StatsBombThreeSixtyPlayer,
  STATSBOMB_EVENT_TYPES,
  STATSBOMB_SHOT_OUTCOMES,
  STATSBOMB_PASS_HEIGHTS,
  STATSBOMB_BODY_PARTS,
  STATSBOMB_INTERCEPTION_OUTCOMES,
} from './types.js';

/** Provider id used for attribution + unresolved actor provider refs. */
export const STATSBOMB_OPEN_PROVIDER_ID = 'statsbomb-open';

// =============================================================================
// OPTIONS
// =============================================================================

export interface FromStatsBombOpenOptions {
  /** Canonical BTL game ID minted by game-service. */
  gameId: string;
  /** Provider replay identifier used for idempotency and backfills. */
  replayId?: string;
  /** Optional pointer to the raw payload in object storage. */
  rawPayloadRef?: string;
  /** Optional batch ID when a caller coordinates multiple normalizers. */
  normalizedBatchId?: string;
  /** Optional idempotency key for the ingest request. */
  idempotencyKey?: string;
  /**
   * Optional StatsBomb 360 frames for this match (parsed from
   * `three-sixty/<matchId>.json`). Each frame is keyed to an event by
   * `event_uuid`. When present, a matching event's football payload gains a
   * normalised `visible_area` polygon; shots lacking their own
   * `shot.freeze_frame` additionally fall back to the 360 freeze-frame.
   * Events with no matching 360 frame simply omit `visible_area`.
   */
  threeSixtyFrames?: readonly StatsBombThreeSixtyFrame[];
}

// =============================================================================
// COORDINATE TRANSFORMATION
// =============================================================================

const STATSBOMB_PITCH_LENGTH = 120;
const STATSBOMB_PITCH_WIDTH = 80;

function normalizeCoordinates(location: StatsBombLocation): PitchCoordinates {
  const [x, y] = location;
  return create(PitchCoordinatesSchema, {
    x: (x / STATSBOMB_PITCH_LENGTH) * 100,
    y: (y / STATSBOMB_PITCH_WIDTH) * 100,
  });
}

/**
 * Map a StatsBomb 360 `visible_area` polygon — a FLAT vertex list
 * `[x0, y0, x1, y1, ...]` in the 120×80 frame — to an array of BTL
 * {@link PitchCoordinates} in 0-100, pairwise. A trailing odd coordinate (a
 * malformed frame) is dropped rather than fabricating a partial point.
 */
function normalizeVisibleArea(area: readonly number[] | undefined): PitchCoordinates[] {
  if (!Array.isArray(area)) {
    return [];
  }
  const points: PitchCoordinates[] = [];
  for (let i = 0; i + 1 < area.length; i += 2) {
    const x = area[i];
    const y = area[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number') {
      continue;
    }
    points.push(normalizeCoordinates([x, y]));
  }
  return points;
}

// =============================================================================
// FREEZE FRAME
// =============================================================================

/**
 * Map a shot's own `freeze_frame[]` (the per-shot StatsBomb snapshot) to BTL
 * {@link FreezeFramePlayer} records. This is the PREFERRED freeze-frame source
 * for shots: it carries the richest player identity (a nested `player`/
 * `position` ref). `is_keeper` is derived from the provider position name;
 * `actor_entity_id`/`actor_name` are left empty — they are resolved to a BTL
 * identity at read time by game-service.
 */
function freezeFrameFromShot(frame: readonly StatsBombFreezeFrame[] | undefined) {
  if (!Array.isArray(frame)) {
    return [];
  }
  return frame.map((ff) =>
    create(FreezeFramePlayerSchema, {
      location: normalizeCoordinates(ff.location),
      teammate: ff.teammate === true,
      isKeeper: ff.position?.name === 'Goalkeeper',
      providerPlayerId: ff.player ? String(ff.player.id) : '',
    })
  );
}

/**
 * Map a 360 frame's `freeze_frame[]` (the richer, all-event StatsBomb 360
 * feed) to BTL {@link FreezeFramePlayer} records. Used only as a FALLBACK for
 * shots that lack their own `shot.freeze_frame`. The 360 per-player shape has
 * no player identity — only flat `teammate`/`keeper`/`actor` booleans — so
 * `provider_player_id` is necessarily empty here.
 */
function freezeFrameFromThreeSixty(frame: readonly StatsBombThreeSixtyPlayer[] | undefined) {
  if (!Array.isArray(frame)) {
    return [];
  }
  return frame.map((ff) =>
    create(FreezeFramePlayerSchema, {
      location: normalizeCoordinates(ff.location),
      teammate: ff.teammate === true,
      isKeeper: ff.keeper === true,
      providerPlayerId: '',
    })
  );
}

// =============================================================================
// ACTORS (unresolved provider refs)
// =============================================================================

/**
 * Build an UNRESOLVED provider {@link EntityResolutionRef} for an occurrence
 * actor (the shooter or the team). game-service extracts `actor_entity_id`
 * from these refs and resolves them to canonical BTL identities at read time,
 * exactly as it does for the api-football adapter's actors. We never mint a
 * fake BTL id here — `entity_id` stays empty and `state` is
 * UNRESOLVED_PROVIDER_REF, with the provider ref carrying the StatsBomb id.
 */
function unresolvedActor(
  ref: { readonly id: number; readonly name: string } | undefined,
  entityType: SubjectType,
  providerResourceType: 'team' | 'player'
): EntityResolutionRef | undefined {
  if (!ref || !Number.isFinite(ref.id)) {
    return undefined;
  }
  return create(EntityResolutionRefSchema, {
    entityId: '',
    entityType,
    state: ResolutionState.UNRESOLVED_PROVIDER_REF,
    providerRef: create(ProviderRefSchema, {
      provider: STATSBOMB_OPEN_PROVIDER_ID,
      providerId: String(ref.id),
      providerResourceType,
    }),
    displayLabel: ref.name ?? '',
    providerSnapshot: ref.name
      ? create(ProviderEntitySnapshotSchema, { label: ref.name })
      : undefined,
  });
}

/**
 * The shooter + their team as unresolved provider refs. Mirrors the
 * api-football adapter's `actors[]` (team + player) so game-service's
 * read-time resolution populates the same downstream surfaces.
 */
function buildActors(event: StatsBombEvent): EntityResolutionRef[] {
  return [
    unresolvedActor(event.team, SubjectType.TEAM, 'team'),
    unresolvedActor(event.player, SubjectType.PLAYER, 'player'),
  ].filter((actor): actor is EntityResolutionRef => actor !== undefined);
}

/**
 * Derive the occurrence-level {@link ResolutionState} from its actors. Every
 * StatsBomb actor is an unresolved provider ref at ingest time, so this is
 * UNRESOLVED_PROVIDER_REF whenever actors exist (and when they don't).
 * Declared as its own function to mirror the api-football adapter's
 * `occurrenceResolutionState` shape, leaving room for partial resolution
 * later without touching the call site.
 */
function occurrenceResolutionState(actors: readonly EntityResolutionRef[]): ResolutionState {
  const resolved = actors.filter((a) => a.state === ResolutionState.RESOLVED).length;
  if (actors.length > 0 && resolved === actors.length) {
    return ResolutionState.RESOLVED;
  }
  return resolved > 0 ? ResolutionState.PARTIAL : ResolutionState.UNRESOLVED_PROVIDER_REF;
}

// =============================================================================
// 360 INDEX
// =============================================================================

/**
 * Index optional 360 frames by their `event_uuid` for O(1) per-event lookup.
 * Tolerant of malformed entries (missing/blank uuid) — those are skipped so a
 * single bad frame never breaks the whole match transform.
 */
function indexThreeSixtyFrames(
  frames: readonly StatsBombThreeSixtyFrame[] | undefined
): ReadonlyMap<string, StatsBombThreeSixtyFrame> {
  const byEvent = new Map<string, StatsBombThreeSixtyFrame>();
  if (!Array.isArray(frames)) {
    return byEvent;
  }
  for (const frame of frames) {
    const uuid = typeof frame?.event_uuid === 'string' ? frame.event_uuid.trim() : '';
    if (uuid === '') {
      continue;
    }
    byEvent.set(uuid, frame);
  }
  return byEvent;
}

// =============================================================================
// ENUM MAPPINGS
// =============================================================================

function mapBodyPart(bodyPartId: number | undefined): BodyPart {
  if (bodyPartId === undefined) return BodyPart.UNSPECIFIED;

  switch (bodyPartId) {
    case STATSBOMB_BODY_PARTS.RIGHT_FOOT:
      return BodyPart.RIGHT_FOOT;
    case STATSBOMB_BODY_PARTS.LEFT_FOOT:
      return BodyPart.LEFT_FOOT;
    case STATSBOMB_BODY_PARTS.HEAD:
      return BodyPart.HEAD;
    default:
      return BodyPart.OTHER;
  }
}

function mapShotOutcome(outcomeId: number): ShotOutcome {
  switch (outcomeId) {
    case STATSBOMB_SHOT_OUTCOMES.GOAL:
      return ShotOutcome.GOAL;
    case STATSBOMB_SHOT_OUTCOMES.SAVED:
    case STATSBOMB_SHOT_OUTCOMES.SAVED_OFF_TARGET:
    case STATSBOMB_SHOT_OUTCOMES.SAVED_TO_POST:
      return ShotOutcome.SAVED;
    case STATSBOMB_SHOT_OUTCOMES.OFF_T:
    case STATSBOMB_SHOT_OUTCOMES.WAYWARD:
      return ShotOutcome.MISSED;
    case STATSBOMB_SHOT_OUTCOMES.BLOCKED:
      return ShotOutcome.BLOCKED;
    case STATSBOMB_SHOT_OUTCOMES.POST:
      return ShotOutcome.POST;
    default:
      return ShotOutcome.UNSPECIFIED;
  }
}

function mapPassHeight(heightId: number): PassHeight {
  switch (heightId) {
    case STATSBOMB_PASS_HEIGHTS.GROUND:
      return PassHeight.GROUND;
    case STATSBOMB_PASS_HEIGHTS.LOW:
      return PassHeight.LOW;
    case STATSBOMB_PASS_HEIGHTS.HIGH:
      return PassHeight.HIGH;
    default:
      return PassHeight.UNSPECIFIED;
  }
}

function mapPassOutcome(outcome: { id: number } | undefined): PassOutcome {
  if (!outcome) return PassOutcome.SUCCESSFUL;
  return PassOutcome.UNSUCCESSFUL;
}

function mapInterceptionOutcome(outcomeId: number): InterceptionOutcome {
  switch (outcomeId) {
    case STATSBOMB_INTERCEPTION_OUTCOMES.WON:
    case STATSBOMB_INTERCEPTION_OUTCOMES.SUCCESS_IN_PLAY:
    case STATSBOMB_INTERCEPTION_OUTCOMES.SUCCESS_OUT:
      return InterceptionOutcome.WON;
    case STATSBOMB_INTERCEPTION_OUTCOMES.LOST:
    case STATSBOMB_INTERCEPTION_OUTCOMES.LOST_IN_PLAY:
    case STATSBOMB_INTERCEPTION_OUTCOMES.LOST_OUT:
      return InterceptionOutcome.LOST;
    default:
      return InterceptionOutcome.UNSPECIFIED;
  }
}

function mapTackleOutcome(outcome: { id: number; name: string } | undefined): TackleOutcome {
  if (!outcome) return TackleOutcome.WON;
  return outcome.name.toLowerCase().includes('lost') ? TackleOutcome.LOST : TackleOutcome.WON;
}

function mapDuelType(duelTypeId: number | undefined): DuelType {
  if (duelTypeId === undefined) return DuelType.UNSPECIFIED;
  if (duelTypeId === 10) return DuelType.AERIAL;
  return DuelType.GROUND;
}

// =============================================================================
// EVENT TRANSFORMERS
// =============================================================================

function mapFootballPeriod(period: number): FootballPeriod {
  switch (period) {
    case 1:
      return FootballPeriod.FIRST_HALF;
    case 2:
      return FootballPeriod.SECOND_HALF;
    case 3:
      return FootballPeriod.EXTRA_TIME_FIRST;
    case 4:
      return FootballPeriod.EXTRA_TIME_SECOND;
    case 5:
      return FootballPeriod.SHOOTOUT;
    default:
      return FootballPeriod.UNSPECIFIED;
  }
}

function getActionType(event: StatsBombEvent): FootballActionType | null {
  switch (event.type.id) {
    case STATSBOMB_EVENT_TYPES.SHOT:
      return FootballActionType.SHOT;
    case STATSBOMB_EVENT_TYPES.PASS:
      return FootballActionType.PASS;
    case STATSBOMB_EVENT_TYPES.CARRY:
      return FootballActionType.CARRY;
    case STATSBOMB_EVENT_TYPES.DUEL:
      if (event.duel?.type?.id === 11) return FootballActionType.TACKLE;
      return null;
    case STATSBOMB_EVENT_TYPES.INTERCEPTION:
      return FootballActionType.INTERCEPTION;
    default:
      return null;
  }
}

function transformEvent(
  event: StatsBombEvent,
  gameId: string,
  threeSixtyFrame?: StatsBombThreeSixtyFrame
): GameOccurrence | null {
  const actionType = getActionType(event);
  if (!actionType) return null;

  const action = create(FootballActionPayloadSchema, {
    type: actionType,
    teamId: event.team ? String(event.team.id) : '',
    playerId: event.player ? String(event.player.id) : '',
    location: event.location ? normalizeCoordinates(event.location) : undefined,
    // The 360 camera polygon for this event (empty when no 360 frame matched
    // by event uuid). Drives the lit "visible area" in the Moment block.
    visibleArea: normalizeVisibleArea(threeSixtyFrame?.visible_area),
    meta: {
      provider_event_type: event.type.name,
      provider_team: event.team.name,
      possession: String(event.possession),
      ...(event.player && { provider_player: event.player.name }),
      ...(event.under_pressure && { under_pressure: 'true' }),
    },
  });

  switch (actionType) {
    case FootballActionType.SHOT:
      if (event.shot) {
        // Prefer the shot's own freeze_frame (richest player identity); fall
        // back to the 360 frame's freeze_frame only when the shot has none.
        const freezeFrame =
          Array.isArray(event.shot.freeze_frame) && event.shot.freeze_frame.length > 0
            ? freezeFrameFromShot(event.shot.freeze_frame)
            : freezeFrameFromThreeSixty(threeSixtyFrame?.freeze_frame);
        action.actionData = {
          case: 'shot',
          value: create(ShotEventDataSchema, {
            endLocation: event.shot.end_location
              ? normalizeCoordinates([event.shot.end_location[0], event.shot.end_location[1]])
              : undefined,
            xg: event.shot.statsbomb_xg,
            bodyPart: mapBodyPart(event.shot.body_part?.id),
            outcome: mapShotOutcome(event.shot.outcome.id),
            freezeFrame,
          }),
        };
      }
      break;
    case FootballActionType.PASS:
      if (event.pass) {
        action.actionData = {
          case: 'pass',
          value: create(PassEventDataSchema, {
            endLocation: event.pass.end_location
              ? normalizeCoordinates(event.pass.end_location)
              : undefined,
            recipientPlayerId: event.pass.recipient ? String(event.pass.recipient.id) : '',
            height: event.pass.height
              ? mapPassHeight(event.pass.height.id)
              : PassHeight.UNSPECIFIED,
            bodyPart: mapBodyPart(event.pass.body_part?.id),
            outcome: mapPassOutcome(event.pass.outcome),
          }),
        };
      }
      break;
    case FootballActionType.CARRY:
      if (event.carry) {
        action.actionData = {
          case: 'carry',
          value: create(CarryEventDataSchema, {
            endLocation: event.carry.end_location
              ? normalizeCoordinates(event.carry.end_location)
              : undefined,
          }),
        };
      }
      break;
    case FootballActionType.TACKLE:
      if (event.duel) {
        action.actionData = {
          case: 'tackle',
          value: create(TackleEventDataSchema, {
            outcome: mapTackleOutcome(event.duel.outcome),
            duelType: mapDuelType(event.duel.type?.id),
          }),
        };
      }
      break;
    case FootballActionType.INTERCEPTION:
      if (event.interception) {
        action.actionData = {
          case: 'interception',
          value: create(InterceptionEventDataSchema, {
            outcome: mapInterceptionOutcome(event.interception.outcome.id),
          }),
        };
      }
      break;
  }

  // Shooter + team as unresolved provider refs so game-service's
  // actor_entity_id extraction + read-time resolution work (mirrors the
  // api-football adapter's actors[]).
  const actors = buildActors(event);

  return create(GameOccurrenceSchema, {
    id: event.id,
    gameId,
    sequence: event.index,
    clock: create(GameClockSchema, {
      display: `${event.minute}:${String(event.second).padStart(2, '0')}`,
      period: event.period,
      elapsedSeconds: event.minute * 60 + event.second,
      running: false,
      sportClock: {
        case: 'football',
        value: create(FootballClockPayloadSchema, {
          period: mapFootballPeriod(event.period),
          minute: event.minute,
          stoppageMinute: 0,
        }),
      },
    }),
    kind: GameOccurrenceKind.ACTION,
    actors,
    resolutionState: occurrenceResolutionState(actors),
    version: 1,
    revisionState: OccurrenceRevisionState.CURRENT,
    relatedOccurrenceIds: event.related_events ?? [],
    source: create(ProviderAttributionSchema, {
      provider: 'statsbomb-open',
      name: 'StatsBomb Open Data',
      logo: 'https://static.hudl.com/craft/productAssets/statsbomb_icon.svg',
      url: 'https://github.com/statsbomb/open-data',
      license: 'StatsBomb Open Data',
      attributionText: 'Data from StatsBomb Open Data',
    }),
    payload: {
      case: 'action',
      value: create(SportActionPayloadSchema, {
        action: {
          case: 'football',
          value: action,
        },
      }),
    },
  });
}

// =============================================================================
// MAIN ADAPTER
// =============================================================================

/**
 * Transform StatsBomb Open Data events into BTL proto messages.
 *
 * @param events - Array of StatsBomb events (from events JSON file)
 * @param options - Optional configuration. `threeSixtyFrames` is the OPTIONAL
 *   StatsBomb 360 feed (`three-sixty/<matchId>.json`); when supplied, each
 *   event matched by uuid gains a `visible_area` polygon, and shots without
 *   their own `shot.freeze_frame` fall back to the 360 frame's freeze-frame.
 * @returns GameService ingest request containing normalised GameOccurrence messages
 *
 * @example
 * ```ts
 * import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';
 *
 * const request = fromStatsBombOpen(eventsJson, {
 *   gameId: 'btl_football_game_argentina_france_2022',
 *   threeSixtyFrames: threeSixtyJson,
 * });
 * ```
 */
export function fromStatsBombOpen(
  events: StatsBombEvent[],
  options: FromStatsBombOpenOptions
): IngestGameOccurrencesRequest {
  const providerMatchId = events[0]?.id?.split('-')[0] || 'unknown';
  const replayId = options.replayId ?? `statsbomb-open:${providerMatchId}`;
  const gameId = options.gameId;
  // Index the optional 360 frames by event uuid for O(1) per-event lookup.
  const framesByEvent = indexThreeSixtyFrames(options.threeSixtyFrames);
  const occurrences = events
    .map((event) => transformEvent(event, gameId, framesByEvent.get(event.id)))
    .filter((e): e is GameOccurrence => e !== null);

  return create(IngestGameOccurrencesRequestSchema, {
    gameId,
    metadata: create(IngestMetadataSchema, {
      provider: 'statsbomb-open',
      replayId,
      rawPayloadRef: options.rawPayloadRef ?? '',
      normalizedBatchId: options.normalizedBatchId ?? `statsbomb-open:${gameId}:occurrences`,
      idempotencyKey: options.idempotencyKey ?? `statsbomb-open:${gameId}:${replayId}:occurrences`,
    }),
    occurrences,
  });
}
