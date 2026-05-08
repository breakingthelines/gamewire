/**
 * Core module - re-exports proto types and provides utilities.
 */

// Proto types and schemas
export {
  type IngestGameOccurrencesRequest,
  type IngestMetadata,
  type GameClock,
  type GameOccurrence,
  type ProviderAttribution,
  type SportActionPayload,
  type FootballActionPayload,
  type PitchCoordinates,
  type ShotEventData,
  type PassEventData,
  type TackleEventData,
  type CarryEventData,
  type InterceptionEventData,
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
  PassHeight,
  PassOutcome,
  ShotEventDataSchema,
  ShotOutcome,
  PassEventDataSchema,
  TackleEventDataSchema,
  TackleOutcome,
  CarryEventDataSchema,
  InterceptionEventDataSchema,
  DuelType,
  InterceptionOutcome,
  BodyPart,
  // Protobuf create helper
  create,
} from './types.js';

// Utilities
export {
  // Type guards
  isShot,
  isPass,
  isTackle,
  isCarry,
  isInterception,
  // Enum name helpers
  footballActionTypeName,
  shotOutcomeName,
  passHeightName,
  passOutcomeName,
  tackleOutcomeName,
  duelTypeName,
  interceptionOutcomeName,
  bodyPartName,
} from './utils.js';
