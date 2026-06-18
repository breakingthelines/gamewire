/**
 * StatsBomb Open Data raw types.
 *
 * Based on the StatsBomb Open Data JSON schema.
 * @see https://github.com/statsbomb/open-data
 */

// =============================================================================
// COMMON STRUCTURES
// =============================================================================

export interface StatsBombRef {
  id: number;
  name: string;
}

/** StatsBomb coordinates: x=0-120, y=0-80 */
export type StatsBombLocation = [number, number];

/** Shot end location includes height: [x, y, z] */
export type StatsBombLocation3D = [number, number, number];

// =============================================================================
// EVENT TYPES
// =============================================================================

export interface StatsBombEvent {
  id: string;
  index: number;
  period: number;
  timestamp: string;
  minute: number;
  second: number;
  type: StatsBombRef;
  possession: number;
  possession_team: StatsBombRef;
  play_pattern: StatsBombRef;
  team: StatsBombRef;
  player?: StatsBombRef;
  position?: StatsBombRef;
  location?: StatsBombLocation;
  duration?: number;
  related_events?: string[];

  // Event-specific data
  shot?: StatsBombShot;
  pass?: StatsBombPass;
  carry?: StatsBombCarry;
  duel?: StatsBombDuel;
  interception?: StatsBombInterception;
  clearance?: StatsBombClearance;
  tactics?: StatsBombTactics;

  // Additional context
  under_pressure?: boolean;
  off_camera?: boolean;
  out?: boolean;
}

// =============================================================================
// SHOT
// =============================================================================

export interface StatsBombShot {
  statsbomb_xg: number;
  end_location: StatsBombLocation3D;
  outcome: StatsBombRef;
  type: StatsBombRef;
  body_part: StatsBombRef;
  technique?: StatsBombRef;
  first_time?: boolean;
  follows_dribble?: boolean;
  redirect?: boolean;
  one_on_one?: boolean;
  open_goal?: boolean;
  deflected?: boolean;
  saved_off_target?: boolean;
  saved_to_post?: boolean;
  key_pass_id?: string;
  freeze_frame?: StatsBombFreezeFrame[];
}

export interface StatsBombFreezeFrame {
  location: StatsBombLocation;
  player: StatsBombRef;
  position: StatsBombRef;
  teammate: boolean;
}

// =============================================================================
// 360 FRAMES (from three-sixty/<matchId>.json)
// =============================================================================

/**
 * A single 360 freeze-frame player. StatsBomb's 360 data is a SEPARATE feed
 * from the per-event `shot.freeze_frame`: it covers many event types (not just
 * shots) and uses a slightly different per-player shape — there is no nested
 * `player`/`position` ref, only flat `actor`/`keeper`/`teammate` booleans and a
 * location. The richer player identity in the shot's own freeze-frame is
 * preferred for shots; the 360 frame is used for the camera `visible_area`
 * polygon (and as a freeze-frame fallback for non-shot events).
 *
 * @see https://github.com/statsbomb/open-data/blob/master/doc/StatsBomb%20Open%20Data%20360%20Specification%20v1.1.pdf
 */
export interface StatsBombThreeSixtyPlayer {
  /** [x, y] in the 120×80 StatsBomb pitch frame. */
  location: StatsBombLocation;
  /** True for the player performing the event this frame is attached to. */
  actor?: boolean;
  /** True when this player is on the same team as the actor. */
  teammate?: boolean;
  /** True when this player is the goalkeeper. */
  keeper?: boolean;
}

/**
 * A 360 frame, keyed to an event by `event_uuid`. `visible_area` is a flat
 * coordinate list `[x0, y0, x1, y1, ...]` describing the camera-visible
 * polygon in the 120×80 frame; it is mapped to BTL 0-100 pairwise.
 */
export interface StatsBombThreeSixtyFrame {
  event_uuid: string;
  /** Flattened polygon vertices: [x0, y0, x1, y1, ...] in 120×80 coords. */
  visible_area: number[];
  freeze_frame: StatsBombThreeSixtyPlayer[];
}

// =============================================================================
// PASS
// =============================================================================

export interface StatsBombPass {
  recipient?: StatsBombRef;
  length: number;
  angle: number;
  height: StatsBombRef;
  end_location: StatsBombLocation;
  type?: StatsBombRef;
  body_part?: StatsBombRef;
  outcome?: StatsBombRef;
  cross?: boolean;
  cut_back?: boolean;
  switch?: boolean;
  through_ball?: boolean;
  shot_assist?: boolean;
  goal_assist?: boolean;
  miscommunication?: boolean;
  technique?: StatsBombRef;
}

// =============================================================================
// CARRY
// =============================================================================

export interface StatsBombCarry {
  end_location: StatsBombLocation;
}

// =============================================================================
// DUEL (used for tackles)
// =============================================================================

export interface StatsBombDuel {
  type: StatsBombRef;
  outcome?: StatsBombRef;
}

// =============================================================================
// INTERCEPTION
// =============================================================================

export interface StatsBombInterception {
  outcome: StatsBombRef;
}

// =============================================================================
// CLEARANCE
// =============================================================================

export interface StatsBombClearance {
  body_part?: StatsBombRef;
  aerial_won?: boolean;
  head?: boolean;
  left_foot?: boolean;
  right_foot?: boolean;
}

// =============================================================================
// TACTICS (Starting XI)
// =============================================================================

export interface StatsBombTactics {
  formation: number;
  lineup: StatsBombLineupPlayer[];
}

export interface StatsBombLineupPlayer {
  player: StatsBombRef;
  position: StatsBombRef;
  jersey_number: number;
}

// =============================================================================
// MATCH INFO (from matches.json)
// =============================================================================

export interface StatsBombMatch {
  match_id: number;
  match_date: string;
  kick_off: string;
  competition: StatsBombRef;
  season: StatsBombRef;
  home_team: StatsBombTeam;
  away_team: StatsBombTeam;
  home_score: number;
  away_score: number;
  match_status: string;
  match_status_360: string;
  last_updated: string;
  last_updated_360: string;
  match_week: number;
  competition_stage: StatsBombRef;
  stadium: StatsBombRef;
  referee: StatsBombRef;
}

export interface StatsBombTeam {
  home_team_id?: number;
  away_team_id?: number;
  home_team_name?: string;
  away_team_name?: string;
  home_team_gender?: string;
  away_team_gender?: string;
  home_team_group?: string | null;
  away_team_group?: string | null;
  country: StatsBombRef;
  managers?: StatsBombManager[];
}

export interface StatsBombManager {
  id: number;
  name: string;
  nickname: string;
  dob: string;
  country: StatsBombRef;
}

// =============================================================================
// EVENT TYPE IDS
// =============================================================================

export const STATSBOMB_EVENT_TYPES = {
  STARTING_XI: 35,
  HALF_START: 18,
  HALF_END: 34,
  PASS: 30,
  BALL_RECEIPT: 42,
  CARRY: 43,
  PRESSURE: 17,
  SHOT: 16,
  GOAL_KEEPER: 23,
  CLEARANCE: 9,
  DUEL: 4,
  INTERCEPTION: 10,
  BLOCK: 6,
  FOUL_COMMITTED: 22,
  FOUL_WON: 21,
  DRIBBLE: 14,
  BALL_RECOVERY: 2,
  MISCONTROL: 38,
  DISPOSSESSED: 3,
  INJURY_STOPPAGE: 40,
  SUBSTITUTION: 19,
  TACTICAL_SHIFT: 36,
  BAD_BEHAVIOUR: 24,
  REFEREE_BALL_DROP: 41,
  FIFTY_FIFTY: 33,
  PLAYER_ON: 26,
  PLAYER_OFF: 27,
  SHIELD: 28,
  OWN_GOAL_AGAINST: 20,
  OWN_GOAL_FOR: 25,
  ERROR: 37,
  OFFSIDE: 8,
} as const;

// =============================================================================
// SHOT OUTCOME IDS
// =============================================================================

export const STATSBOMB_SHOT_OUTCOMES = {
  GOAL: 97,
  SAVED: 100,
  OFF_T: 98, // Off Target (missed)
  BLOCKED: 96,
  POST: 99,
  WAYWARD: 101,
  SAVED_OFF_TARGET: 115,
  SAVED_TO_POST: 116,
} as const;

// =============================================================================
// PASS HEIGHT IDS
// =============================================================================

export const STATSBOMB_PASS_HEIGHTS = {
  GROUND: 1,
  LOW: 2,
  HIGH: 3,
} as const;

// =============================================================================
// BODY PART IDS
// =============================================================================

export const STATSBOMB_BODY_PARTS = {
  RIGHT_FOOT: 40,
  LEFT_FOOT: 38,
  HEAD: 37,
  OTHER: 70, // "No Touch" or other
  CHEST: 36,
  BOTH_HANDS: 35,
  DROP_KICK: 69,
  KEEPER_ARM: 68,
} as const;

// =============================================================================
// DUEL TYPE IDS
// =============================================================================

export const STATSBOMB_DUEL_TYPES = {
  AERIAL_LOST: 10,
  TACKLE: 11,
} as const;

// =============================================================================
// INTERCEPTION OUTCOME IDS
// =============================================================================

export const STATSBOMB_INTERCEPTION_OUTCOMES = {
  WON: 4,
  SUCCESS_IN_PLAY: 15,
  SUCCESS_OUT: 16,
  LOST: 1,
  LOST_IN_PLAY: 13,
  LOST_OUT: 14,
} as const;
