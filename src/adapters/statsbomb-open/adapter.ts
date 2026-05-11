/**
 * StatsBomb Open Data adapter.
 *
 * Transforms StatsBomb Open Data events into BTL proto messages.
 */

import { create } from '@bufbuild/protobuf';

import {
  type IngestGameOccurrencesRequest,
  type GameOccurrence,
  type PitchCoordinates,
  IngestGameOccurrencesRequestSchema,
  IngestMetadataSchema,
  GameClockSchema,
  GameOccurrenceKind,
  GameOccurrenceSchema,
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
  type StatsBombLocation,
  STATSBOMB_EVENT_TYPES,
  STATSBOMB_SHOT_OUTCOMES,
  STATSBOMB_PASS_HEIGHTS,
  STATSBOMB_BODY_PARTS,
  STATSBOMB_INTERCEPTION_OUTCOMES,
} from './types.js';

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

function transformEvent(event: StatsBombEvent, gameId: string): GameOccurrence | null {
  const actionType = getActionType(event);
  if (!actionType) return null;

  const action = create(FootballActionPayloadSchema, {
    type: actionType,
    teamId: event.team ? String(event.team.id) : '',
    playerId: event.player ? String(event.player.id) : '',
    location: event.location ? normalizeCoordinates(event.location) : undefined,
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
        action.actionData = {
          case: 'shot',
          value: create(ShotEventDataSchema, {
            endLocation: event.shot.end_location
              ? normalizeCoordinates([event.shot.end_location[0], event.shot.end_location[1]])
              : undefined,
            xg: event.shot.statsbomb_xg,
            bodyPart: mapBodyPart(event.shot.body_part?.id),
            outcome: mapShotOutcome(event.shot.outcome.id),
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
    resolutionState: ResolutionState.UNRESOLVED_PROVIDER_REF,
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
 * @param options - Optional configuration
 * @returns GameService ingest request containing normalised GameOccurrence messages
 *
 * @example
 * ```ts
 * import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';
 *
 * const request = fromStatsBombOpen(eventsJson, {
 *   gameId: 'btl_football_game_argentina_france_2022',
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
  const occurrences = events
    .map((event) => transformEvent(event, gameId))
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
