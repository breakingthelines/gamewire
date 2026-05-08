/**
 * StatsBomb Open Data adapter.
 *
 * Transforms StatsBomb Open Data events into BTL proto messages.
 */

import { create } from '@bufbuild/protobuf';

import {
  type NormalizedMatchData,
  type MatchEvent,
  type Team,
  type Player,
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
  TackleEventDataSchema,
  InterceptionEventDataSchema,
  EventType,
  ShotOutcome,
  PassHeight,
  PassOutcome,
  TackleOutcome,
  InterceptionOutcome,
  BodyPart,
  DuelType,
} from '#/generated/game/v1/types/football/football_pb.js';

import {
  type StatsBombEvent,
  type StatsBombLocation,
  type StatsBombMatch,
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
  /** Match metadata (from matches.json) */
  match?: StatsBombMatch;
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
// ENTITY TRANSFORMERS
// =============================================================================

function transformPlayer(
  sbPlayer: { id: number; name: string } | undefined,
  shirtNumber?: number
): Player | undefined {
  if (!sbPlayer) return undefined;
  return create(PlayerSchema, {
    id: String(sbPlayer.id),
    name: sbPlayer.name,
    shirtNumber: shirtNumber ?? 0,
  });
}

function transformTeam(sbTeam: { id: number; name: string }): Team {
  return create(TeamSchema, {
    id: String(sbTeam.id),
    name: sbTeam.name,
  });
}

// =============================================================================
// EVENT TRANSFORMERS
// =============================================================================

function getEventType(event: StatsBombEvent): EventType | null {
  switch (event.type.id) {
    case STATSBOMB_EVENT_TYPES.SHOT:
      return EventType.SHOT;
    case STATSBOMB_EVENT_TYPES.PASS:
      return EventType.PASS;
    case STATSBOMB_EVENT_TYPES.CARRY:
      return EventType.CARRY;
    case STATSBOMB_EVENT_TYPES.DUEL:
      if (event.duel?.type?.id === 11) return EventType.TACKLE;
      return null;
    case STATSBOMB_EVENT_TYPES.INTERCEPTION:
      return EventType.INTERCEPTION;
    default:
      return null;
  }
}

function transformEvent(event: StatsBombEvent): MatchEvent | null {
  const eventType = getEventType(event);
  if (!eventType) return null;

  const timestamp = event.minute + event.second / 60;

  const matchEvent = create(MatchEventSchema, {
    id: event.id,
    type: eventType,
    timestamp,
    player: transformPlayer(event.player),
    team: event.team ? transformTeam(event.team) : undefined,
    location: event.location ? normalizeCoordinates(event.location) : undefined,
    meta: {
      period: String(event.period),
      possession: String(event.possession),
      ...(event.under_pressure && { underPressure: 'true' }),
    },
  });

  // Add type-specific event data
  switch (eventType) {
    case EventType.SHOT:
      if (event.shot) {
        matchEvent.eventData = {
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

    case EventType.PASS:
      if (event.pass) {
        matchEvent.eventData = {
          case: 'pass',
          value: create(PassEventDataSchema, {
            endLocation: event.pass.end_location
              ? normalizeCoordinates(event.pass.end_location)
              : undefined,
            recipient: event.pass.recipient ? transformPlayer(event.pass.recipient) : undefined,
            height: event.pass.height
              ? mapPassHeight(event.pass.height.id)
              : PassHeight.UNSPECIFIED,
            bodyPart: mapBodyPart(event.pass.body_part?.id),
            outcome: mapPassOutcome(event.pass.outcome),
          }),
        };
      }
      break;

    case EventType.CARRY:
      if (event.carry) {
        matchEvent.eventData = {
          case: 'carry',
          value: create(CarryEventDataSchema, {
            endLocation: event.carry.end_location
              ? normalizeCoordinates(event.carry.end_location)
              : undefined,
          }),
        };
      }
      break;

    case EventType.TACKLE:
      if (event.duel) {
        matchEvent.eventData = {
          case: 'tackle',
          value: create(TackleEventDataSchema, {
            outcome: mapTackleOutcome(event.duel.outcome),
            duelType: mapDuelType(event.duel.type?.id),
          }),
        };
      }
      break;

    case EventType.INTERCEPTION:
      if (event.interception) {
        matchEvent.eventData = {
          case: 'interception',
          value: create(InterceptionEventDataSchema, {
            outcome: mapInterceptionOutcome(event.interception.outcome.id),
          }),
        };
      }
      break;
  }

  return matchEvent;
}

// =============================================================================
// MAIN ADAPTER
// =============================================================================

/**
 * Transform StatsBomb Open Data events into BTL proto messages.
 *
 * @param events - Array of StatsBomb events (from events JSON file)
 * @param options - Optional configuration
 * @returns NormalizedMatchData proto message
 *
 * @example
 * ```ts
 * import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';
 *
 * const matchData = fromStatsBombOpen(eventsJson, {
 *   homeTeam: { shortName: 'ARG', primaryColor: '#75AADB' },
 *   awayTeam: { shortName: 'FRA', primaryColor: '#002654' },
 * });
 * ```
 */
export function fromStatsBombOpen(
  events: StatsBombEvent[],
  options: FromStatsBombOpenOptions = {}
): NormalizedMatchData {
  const teamsFromEvents = extractTeamsFromEvents(events);

  const homeTeam = create(TeamSchema, {
    id: teamsFromEvents.home.id,
    name: teamsFromEvents.home.name,
    shortName: options.homeTeam?.shortName ?? '',
    primaryColor: options.homeTeam?.primaryColor ?? '',
    secondaryColor: options.homeTeam?.secondaryColor ?? '',
  });

  const awayTeam = create(TeamSchema, {
    id: teamsFromEvents.away.id,
    name: teamsFromEvents.away.name,
    shortName: options.awayTeam?.shortName ?? '',
    primaryColor: options.awayTeam?.primaryColor ?? '',
    secondaryColor: options.awayTeam?.secondaryColor ?? '',
  });

  const matchId = options.match?.match_id
    ? String(options.match.match_id)
    : events[0]?.id?.split('-')[0] || 'unknown';

  const transformedEvents = events.map(transformEvent).filter((e): e is MatchEvent => e !== null);

  return create(NormalizedMatchDataSchema, {
    matchId,
    homeTeam,
    awayTeam,
    events: transformedEvents,
    source: create(DataSourceSchema, {
      provider: 'statsbomb-open',
      name: 'StatsBomb Open Data',
      logo: 'https://static.hudl.com/craft/productAssets/statsbomb_icon.svg',
      url: 'https://github.com/statsbomb/open-data',
    }),
    meta: options.meta ?? {},
  });
}

function extractTeamsFromEvents(events: StatsBombEvent[]): {
  home: { id: string; name: string };
  away: { id: string; name: string };
} {
  const startingXIs = events.filter((e) => e.type.id === STATSBOMB_EVENT_TYPES.STARTING_XI);

  if (startingXIs.length >= 2) {
    return {
      home: { id: String(startingXIs[0].team.id), name: startingXIs[0].team.name },
      away: { id: String(startingXIs[1].team.id), name: startingXIs[1].team.name },
    };
  }

  const teams = new Map<number, { id: number; name: string }>();
  for (const event of events) {
    if (event.team && !teams.has(event.team.id)) {
      teams.set(event.team.id, event.team);
    }
    if (teams.size >= 2) break;
  }

  const teamArray = Array.from(teams.values());
  return {
    home: { id: String(teamArray[0]?.id ?? 0), name: teamArray[0]?.name ?? 'Unknown Home' },
    away: { id: String(teamArray[1]?.id ?? 0), name: teamArray[1]?.name ?? 'Unknown Away' },
  };
}
