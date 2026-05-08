/**
 * Template adapter.
 *
 * Copy this file to create a new adapter for a data provider.
 * Replace "Template" with your provider name throughout.
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
  ShotOutcome,
  PassHeight,
  PassOutcome,
  BodyPart,
} from '#/core/index.js';

import { type TemplateEvent, TEMPLATE_EVENT_TYPES, TEMPLATE_PITCH } from './types.js';

// =============================================================================
// OPTIONS
// =============================================================================

export interface FromTemplateOptions {
  /** Canonical BTL game ID minted by game-service. */
  gameId: string;
  /** Provider replay identifier used for idempotency and backfills. */
  replayId?: string;
}

// =============================================================================
// COORDINATE TRANSFORMATION
// =============================================================================

/**
 * Normalise provider coordinates to BTL 0-100 system.
 *
 * BTL coordinate system:
 * - X: 0 = own goal line, 100 = opposition goal line
 * - Y: 0 = left touchline, 100 = right touchline
 */
function normalizeCoordinates(location: [number, number]): PitchCoordinates {
  const [x, y] = location;
  return create(PitchCoordinatesSchema, {
    x: (x / TEMPLATE_PITCH.LENGTH) * 100,
    y: (y / TEMPLATE_PITCH.WIDTH) * 100,
  });
}

// =============================================================================
// ENUM MAPPINGS
// =============================================================================

/**
 * Map provider's body part IDs to BTL BodyPart enum.
 */
function mapBodyPart(_bodyPartId: number | undefined): BodyPart {
  // TODO: Implement mapping for your provider
  return BodyPart.UNSPECIFIED;
}

/**
 * Map provider's shot outcome to BTL ShotOutcome enum.
 */
function mapShotOutcome(_outcomeId: number): ShotOutcome {
  // TODO: Implement mapping for your provider
  return ShotOutcome.UNSPECIFIED;
}

/**
 * Map provider's pass height to BTL PassHeight enum.
 */
function mapPassHeight(_heightId: number): PassHeight {
  // TODO: Implement mapping for your provider
  return PassHeight.UNSPECIFIED;
}

/**
 * Map provider's pass outcome to BTL PassOutcome enum.
 */
function mapPassOutcome(_outcome: unknown): PassOutcome {
  // TODO: Implement mapping for your provider
  return PassOutcome.UNSPECIFIED;
}

// =============================================================================
// EVENT TRANSFORMERS
// =============================================================================

/**
 * Determine BTL event type from provider event.
 * Return null for unsupported event types (they will be filtered out).
 */
function getActionType(event: TemplateEvent): FootballActionType | null {
  switch (event.type.id) {
    case TEMPLATE_EVENT_TYPES.SHOT:
      return FootballActionType.SHOT;
    case TEMPLATE_EVENT_TYPES.PASS:
      return FootballActionType.PASS;
    case TEMPLATE_EVENT_TYPES.CARRY:
      return FootballActionType.CARRY;
    case TEMPLATE_EVENT_TYPES.TACKLE:
      return FootballActionType.TACKLE;
    case TEMPLATE_EVENT_TYPES.INTERCEPTION:
      return FootballActionType.INTERCEPTION;
    default:
      return null;
  }
}

/**
 * Transform a single provider event to BTL GameOccurrence.
 * Return null for unsupported events.
 */
function transformEvent(event: TemplateEvent, gameId: string): GameOccurrence | null {
  const actionType = getActionType(event);
  if (!actionType) return null;

  const action = create(FootballActionPayloadSchema, {
    type: actionType,
    teamId: event.team ? String(event.team.id) : '',
    playerId: event.player ? String(event.player.id) : '',
    location: event.location ? normalizeCoordinates(event.location) : undefined,
    meta: {
      provider_event_type: event.type.name,
      ...(event.player && { provider_player: event.player.name }),
      ...(event.team && { provider_team: event.team.name }),
    },
  });

  // Add type-specific event data
  switch (actionType) {
    case FootballActionType.SHOT:
      action.actionData = {
        case: 'shot',
        value: create(ShotEventDataSchema, {
          // TODO: Map shot-specific fields
          outcome: mapShotOutcome(0),
          bodyPart: mapBodyPart(undefined),
        }),
      };
      break;

    case FootballActionType.PASS:
      action.actionData = {
        case: 'pass',
        value: create(PassEventDataSchema, {
          // TODO: Map pass-specific fields
          height: mapPassHeight(0),
          bodyPart: mapBodyPart(undefined),
          outcome: mapPassOutcome(undefined),
        }),
      };
      break;

    case FootballActionType.CARRY:
      action.actionData = {
        case: 'carry',
        value: create(CarryEventDataSchema, {
          // TODO: Map carry-specific fields
        }),
      };
      break;

    // Add more event types as needed
  }

  return create(GameOccurrenceSchema, {
    id: event.id,
    gameId,
    sequence: Math.trunc(event.timestamp),
    clock: create(GameClockSchema, {
      display: String(event.timestamp),
      elapsedSeconds: Math.trunc(event.timestamp * 60),
      sportClock: {
        case: 'football',
        value: create(FootballClockPayloadSchema, {
          period: FootballPeriod.UNSPECIFIED,
          minute: Math.trunc(event.timestamp),
        }),
      },
    }),
    kind: GameOccurrenceKind.ACTION,
    resolutionState: ResolutionState.UNRESOLVED_PROVIDER_REF,
    version: 1,
    revisionState: OccurrenceRevisionState.CURRENT,
    source: create(ProviderAttributionSchema, {
      provider: 'template',
      name: 'Template Provider',
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
 * Transform provider events into BTL proto messages.
 *
 * @param events - Array of raw events from provider
 * @param options - Optional configuration
 * @returns GameService ingest request containing normalised GameOccurrence messages
 *
 * @example
 * ```ts
 * import { fromTemplate } from '@breakingthelines/gamewire/adapters/template';
 *
 * const request = fromTemplate(events, {
 *   gameId: 'btl_football_game_example',
 * });
 * ```
 */
export function fromTemplate(
  events: TemplateEvent[],
  options: FromTemplateOptions
): IngestGameOccurrencesRequest {
  const replayId = options.replayId ?? `template:${options.gameId}:occurrences`;
  const occurrences = events
    .map((event) => transformEvent(event, options.gameId))
    .filter((e): e is GameOccurrence => e !== null);

  return create(IngestGameOccurrencesRequestSchema, {
    gameId: options.gameId,
    metadata: create(IngestMetadataSchema, {
      provider: 'template',
      replayId,
      normalizedBatchId: `template:${options.gameId}:occurrences`,
      idempotencyKey: replayId,
    }),
    occurrences,
  });
}
