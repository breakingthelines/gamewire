/**
 * Utility functions for working with proto types.
 * Provides better DX for common operations.
 */

import {
  type FootballActionPayload,
  type GameOccurrence,
  type ShotEventData,
  type PassEventData,
  type TackleEventData,
  type CarryEventData,
  type InterceptionEventData,
  FootballActionType,
  ShotOutcome,
  PassHeight,
  PassOutcome,
  TackleOutcome,
  DuelType,
  InterceptionOutcome,
  BodyPart,
} from './types.js';

// =============================================================================
// TYPE GUARDS
// =============================================================================

type FootballActionOccurrence<
  TCase extends FootballActionPayload['actionData']['case'],
  TValue,
> = GameOccurrence & {
  payload: {
    case: 'action';
    value: {
      action: {
        case: 'football';
        value: FootballActionPayload & {
          actionData: {
            case: TCase;
            value: TValue;
          };
        };
      };
    };
  };
};

export function isShot(
  event: GameOccurrence
): event is FootballActionOccurrence<'shot', ShotEventData> {
  return (
    event.payload.case === 'action' &&
    event.payload.value.action.case === 'football' &&
    event.payload.value.action.value.actionData.case === 'shot'
  );
}

export function isPass(
  event: GameOccurrence
): event is FootballActionOccurrence<'pass', PassEventData> {
  return (
    event.payload.case === 'action' &&
    event.payload.value.action.case === 'football' &&
    event.payload.value.action.value.actionData.case === 'pass'
  );
}

export function isTackle(
  event: GameOccurrence
): event is FootballActionOccurrence<'tackle', TackleEventData> {
  return (
    event.payload.case === 'action' &&
    event.payload.value.action.case === 'football' &&
    event.payload.value.action.value.actionData.case === 'tackle'
  );
}

export function isCarry(
  event: GameOccurrence
): event is FootballActionOccurrence<'carry', CarryEventData> {
  return (
    event.payload.case === 'action' &&
    event.payload.value.action.case === 'football' &&
    event.payload.value.action.value.actionData.case === 'carry'
  );
}

export function isInterception(
  event: GameOccurrence
): event is FootballActionOccurrence<'interception', InterceptionEventData> {
  return (
    event.payload.case === 'action' &&
    event.payload.value.action.case === 'football' &&
    event.payload.value.action.value.actionData.case === 'interception'
  );
}

// =============================================================================
// ENUM TO STRING HELPERS
// =============================================================================

export const footballActionTypeName: Record<FootballActionType, string> = {
  [FootballActionType.UNSPECIFIED]: 'unspecified',
  [FootballActionType.SHOT]: 'shot',
  [FootballActionType.PASS]: 'pass',
  [FootballActionType.TACKLE]: 'tackle',
  [FootballActionType.CARRY]: 'carry',
  [FootballActionType.INTERCEPTION]: 'interception',
  [FootballActionType.CARD]: 'card',
  [FootballActionType.DUEL]: 'duel',
  [FootballActionType.GOALKEEPER]: 'goalkeeper',
  [FootballActionType.CLEARANCE]: 'clearance',
  [FootballActionType.SUBSTITUTION]: 'substitution',
  [FootballActionType.FOUL_COMMITTED]: 'foul_committed',
  [FootballActionType.TAKE_ON]: 'take_on',
  [FootballActionType.RECOVERY]: 'recovery',
  [FootballActionType.PRESSURE]: 'pressure',
};

export const shotOutcomeName: Record<ShotOutcome, string> = {
  [ShotOutcome.UNSPECIFIED]: 'unspecified',
  [ShotOutcome.GOAL]: 'goal',
  [ShotOutcome.SAVED]: 'saved',
  [ShotOutcome.MISSED]: 'missed',
  [ShotOutcome.BLOCKED]: 'blocked',
  [ShotOutcome.POST]: 'post',
};

export const passHeightName: Record<PassHeight, string> = {
  [PassHeight.UNSPECIFIED]: 'unspecified',
  [PassHeight.GROUND]: 'ground',
  [PassHeight.LOW]: 'low',
  [PassHeight.HIGH]: 'high',
};

export const passOutcomeName: Record<PassOutcome, string> = {
  [PassOutcome.UNSPECIFIED]: 'unspecified',
  [PassOutcome.SUCCESSFUL]: 'successful',
  [PassOutcome.UNSUCCESSFUL]: 'unsuccessful',
};

export const tackleOutcomeName: Record<TackleOutcome, string> = {
  [TackleOutcome.UNSPECIFIED]: 'unspecified',
  [TackleOutcome.WON]: 'won',
  [TackleOutcome.LOST]: 'lost',
};

export const duelTypeName: Record<DuelType, string> = {
  [DuelType.UNSPECIFIED]: 'unspecified',
  [DuelType.GROUND]: 'ground',
  [DuelType.AERIAL]: 'aerial',
};

export const interceptionOutcomeName: Record<InterceptionOutcome, string> = {
  [InterceptionOutcome.UNSPECIFIED]: 'unspecified',
  [InterceptionOutcome.WON]: 'won',
  [InterceptionOutcome.LOST]: 'lost',
};

export const bodyPartName: Record<BodyPart, string> = {
  [BodyPart.UNSPECIFIED]: 'unspecified',
  [BodyPart.RIGHT_FOOT]: 'right_foot',
  [BodyPart.LEFT_FOOT]: 'left_foot',
  [BodyPart.HEAD]: 'head',
  [BodyPart.OTHER]: 'other',
};
