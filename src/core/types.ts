export {
  type IngestGameOccurrencesRequest,
  type IngestMetadata,
  IngestGameOccurrencesRequestSchema,
  IngestMetadataSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

export {
  type GameClock,
  type GameOccurrence,
  type ProviderAttribution,
  type SportActionPayload,
  GameClockSchema,
  GameOccurrenceKind,
  GameOccurrenceSchema,
  OccurrenceRevisionState,
  ProviderAttributionSchema,
  ResolutionState,
  SportActionPayloadSchema,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';

export {
  type FootballActionPayload,
  type PitchCoordinates,
  type ShotEventData,
  type PassEventData,
  type TackleEventData,
  type CarryEventData,
  type InterceptionEventData,
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
} from '@breakingthelines/protos/btl/game/v1/types/football/football_pb';

// Re-export create from protobuf for convenience
export { create } from '@bufbuild/protobuf';
