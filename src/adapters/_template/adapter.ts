/**
 * Template adapter.
 *
 * Copy this file to create a new adapter for a data provider.
 * Replace "Template" with your provider name throughout.
 */

import { create } from '@bufbuild/protobuf';

import {
  type NormalizedMatchData,
  type MatchEvent,
  type PitchCoordinates,
  NormalizedMatchDataSchema,
  DataSourceSchema,
  TeamSchema,
  PlayerSchema,
  PitchCoordinatesSchema,
  MatchEventSchema,
  ShotEventDataSchema,
  PassEventDataSchema,
  CarryEventDataSchema,
  EventType,
  ShotOutcome,
  PassHeight,
  PassOutcome,
  BodyPart,
} from '#/generated/game/v1/types/football/football_pb.js';

import { type TemplateEvent, TEMPLATE_EVENT_TYPES, TEMPLATE_PITCH } from './types.js';

// =============================================================================
// OPTIONS
// =============================================================================

export interface FromTemplateOptions {
  /** Override home team info */
  homeTeam?: { shortName?: string; primaryColor?: string; secondaryColor?: string };
  /** Override away team info */
  awayTeam?: { shortName?: string; primaryColor?: string; secondaryColor?: string };
  /** Additional metadata to include */
  meta?: Record<string, string>;
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
function getEventType(event: TemplateEvent): EventType | null {
  switch (event.type.id) {
    case TEMPLATE_EVENT_TYPES.SHOT:
      return EventType.SHOT;
    case TEMPLATE_EVENT_TYPES.PASS:
      return EventType.PASS;
    case TEMPLATE_EVENT_TYPES.CARRY:
      return EventType.CARRY;
    case TEMPLATE_EVENT_TYPES.TACKLE:
      return EventType.TACKLE;
    case TEMPLATE_EVENT_TYPES.INTERCEPTION:
      return EventType.INTERCEPTION;
    default:
      return null;
  }
}

/**
 * Transform a single provider event to BTL MatchEvent.
 * Return null for unsupported events.
 */
function transformEvent(event: TemplateEvent): MatchEvent | null {
  const eventType = getEventType(event);
  if (!eventType) return null;

  const matchEvent = create(MatchEventSchema, {
    id: event.id,
    type: eventType,
    timestamp: event.timestamp,
    player: event.player
      ? create(PlayerSchema, {
          id: String(event.player.id),
          name: event.player.name,
        })
      : undefined,
    team: event.team
      ? create(TeamSchema, {
          id: String(event.team.id),
          name: event.team.name,
        })
      : undefined,
    location: event.location ? normalizeCoordinates(event.location) : undefined,
  });

  // Add type-specific event data
  switch (eventType) {
    case EventType.SHOT:
      matchEvent.eventData = {
        case: 'shot',
        value: create(ShotEventDataSchema, {
          // TODO: Map shot-specific fields
          outcome: mapShotOutcome(0),
          bodyPart: mapBodyPart(undefined),
        }),
      };
      break;

    case EventType.PASS:
      matchEvent.eventData = {
        case: 'pass',
        value: create(PassEventDataSchema, {
          // TODO: Map pass-specific fields
          height: mapPassHeight(0),
          bodyPart: mapBodyPart(undefined),
          outcome: mapPassOutcome(undefined),
        }),
      };
      break;

    case EventType.CARRY:
      matchEvent.eventData = {
        case: 'carry',
        value: create(CarryEventDataSchema, {
          // TODO: Map carry-specific fields
        }),
      };
      break;

    // Add more event types as needed
  }

  return matchEvent;
}

// =============================================================================
// MAIN ADAPTER
// =============================================================================

/**
 * Transform provider events into BTL proto messages.
 *
 * @param events - Array of raw events from provider
 * @param options - Optional configuration
 * @returns NormalizedMatchData proto message
 *
 * @example
 * ```ts
 * import { fromTemplate } from '@breakingthelines/gamewire/adapters/template';
 *
 * const matchData = fromTemplate(events, {
 *   homeTeam: { shortName: 'HME', primaryColor: '#FF0000' },
 *   awayTeam: { shortName: 'AWY', primaryColor: '#0000FF' },
 * });
 * ```
 */
export function fromTemplate(
  events: TemplateEvent[],
  options: FromTemplateOptions = {}
): NormalizedMatchData {
  // TODO: Extract teams from events or options
  const homeTeam = create(TeamSchema, {
    id: '1',
    name: 'Home Team',
    shortName: options.homeTeam?.shortName ?? '',
    primaryColor: options.homeTeam?.primaryColor ?? '',
    secondaryColor: options.homeTeam?.secondaryColor ?? '',
  });

  const awayTeam = create(TeamSchema, {
    id: '2',
    name: 'Away Team',
    shortName: options.awayTeam?.shortName ?? '',
    primaryColor: options.awayTeam?.primaryColor ?? '',
    secondaryColor: options.awayTeam?.secondaryColor ?? '',
  });

  const transformedEvents = events.map(transformEvent).filter((e): e is MatchEvent => e !== null);

  return create(NormalizedMatchDataSchema, {
    matchId: 'unknown',
    homeTeam,
    awayTeam,
    events: transformedEvents,
    source: create(DataSourceSchema, {
      // TODO: Update with your provider's attribution
      provider: 'template',
      name: 'Template Provider',
      logo: '',
      url: '',
    }),
    meta: options.meta ?? {},
  });
}
