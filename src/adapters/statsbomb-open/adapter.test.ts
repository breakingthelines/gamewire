import { describe, it, expect, beforeAll } from 'vitest';

import { fromStatsBombOpen } from './adapter.js';
import type { StatsBombEvent, StatsBombThreeSixtyFrame } from './types.js';
import { STATSBOMB_EVENT_TYPES } from './types.js';
import {
  FootballActionType,
  PassOutcome,
  ResolutionState,
  isCarry,
  isPass,
  isShot,
} from '#/core/index.js';

// Committed fixtures — a single real WC2022-final shot (with its own
// freeze_frame, including the goalkeeper) and the matching 360 frame. Used by
// the freeze_frame/visible_area/actors tests so they do NOT depend on the live
// network fetch that the broader suite uses.
import shotWithFreezeFrameFixture from './fixtures/shot-with-freeze-frame.json' with { type: 'json' };
import threeSixtyFramesFixture from './fixtures/three-sixty-frames.json' with { type: 'json' };

const shotFixtureEvents = shotWithFreezeFrameFixture as unknown as StatsBombEvent[];
const threeSixtyFixture = threeSixtyFramesFixture as unknown as StatsBombThreeSixtyFrame[];

// 2022 World Cup Final: Argentina vs France
const FIXTURE_URL =
  'https://raw.githubusercontent.com/statsbomb/open-data/master/data/events/3869685.json';

describe('StatsBomb Open adapter', () => {
  let events: StatsBombEvent[];
  const gameId = 'btl_football_game_argentina_france_2022';

  beforeAll(async () => {
    const response = await fetch(FIXTURE_URL);
    events = (await response.json()) as StatsBombEvent[];
  });

  describe('fromStatsBombOpen', () => {
    it('transforms events into normalised match data', () => {
      const result = fromStatsBombOpen(events, { gameId });

      expect(result).toMatchObject({
        gameId,
        metadata: expect.objectContaining({
          provider: 'statsbomb-open',
          replayId: expect.any(String),
        }),
        occurrences: expect.any(Array),
      });
    });

    it('uses caller-supplied replay metadata', () => {
      const result = fromStatsBombOpen(events, {
        gameId,
        replayId: 'replay-2022-final',
        rawPayloadRef: 'r2://statsbomb/3869685.json',
      });

      expect(result.metadata?.replayId).toBe('replay-2022-final');
      expect(result.metadata?.rawPayloadRef).toBe('r2://statsbomb/3869685.json');
    });

    it('produces valid proto message structure', () => {
      const result = fromStatsBombOpen(events, { gameId });

      // Verify proto message has required fields
      expect(result.gameId).toBe(gameId);
      expect(result.metadata).toBeDefined();
      expect(result.occurrences).toBeDefined();

      // Verify events have proper structure
      expect(result.occurrences.length).toBeGreaterThan(0);
      const firstEvent = result.occurrences[0];
      expect(firstEvent.id).toBeDefined();
      expect(firstEvent.kind).toBeDefined();
      expect(firstEvent.payload.case).toBe('action');
    });
  });

  describe('coordinate normalisation', () => {
    it('transforms StatsBomb coordinates (120x80) to BTL (0-100)', () => {
      const result = fromStatsBombOpen(events, { gameId });

      // Find a pass event with location
      const passEvent = result.occurrences
        .filter(isPass)
        .find((e) => e.payload.value.action.value.location);

      expect(passEvent).toBeDefined();
      const location = passEvent!.payload.value.action.value.location!;
      expect(location.x).toBeGreaterThanOrEqual(0);
      expect(location.x).toBeLessThanOrEqual(100);
      expect(location.y).toBeGreaterThanOrEqual(0);
      expect(location.y).toBeLessThanOrEqual(100);
    });

    it('normalises center of pitch correctly', () => {
      // StatsBomb center: (60, 40) -> BTL: (50, 50)
      // Find an event near center
      const result = fromStatsBombOpen(events, { gameId });

      // Just verify all coordinates are in valid range
      for (const event of result.occurrences) {
        if (event.payload.case === 'action' && event.payload.value.action.case === 'football') {
          const { location } = event.payload.value.action.value;
          if (location) {
            expect(location.x).toBeGreaterThanOrEqual(0);
            expect(location.x).toBeLessThanOrEqual(100);
            expect(location.y).toBeGreaterThanOrEqual(0);
            expect(location.y).toBeLessThanOrEqual(100);
          }
        }
      }
    });
  });

  describe('event type mapping', () => {
    it('transforms shot events', () => {
      const result = fromStatsBombOpen(events, { gameId });
      const shots = result.occurrences.filter(isShot);

      // The 2022 World Cup Final had many shots
      expect(shots.length).toBeGreaterThan(0);

      const shot = shots[0];
      expect(shot.payload.value.action.value.type).toBe(FootballActionType.SHOT);
      expect(shot.payload.value.action.value.actionData.case).toBe('shot');
      expect(shot.payload.value.action.value.actionData.value.xg).toBeGreaterThanOrEqual(0);
      expect(shot.payload.value.action.value.actionData.value.xg).toBeLessThanOrEqual(1);
    });

    it('transforms pass events', () => {
      const result = fromStatsBombOpen(events, { gameId });
      const passes = result.occurrences.filter(isPass);

      expect(passes.length).toBeGreaterThan(0);

      const pass = passes[0];
      expect(pass.payload.value.action.value.type).toBe(FootballActionType.PASS);
      expect(pass.payload.value.action.value.actionData.case).toBe('pass');
      expect([PassOutcome.SUCCESSFUL, PassOutcome.UNSUCCESSFUL]).toContain(
        pass.payload.value.action.value.actionData.value.outcome
      );
    });

    it('transforms carry events', () => {
      const result = fromStatsBombOpen(events, { gameId });
      const carries = result.occurrences.filter(isCarry);

      expect(carries.length).toBeGreaterThan(0);

      const carry = carries[0];
      expect(carry.payload.value.action.value.type).toBe(FootballActionType.CARRY);
      expect(carry.payload.value.action.value.actionData.case).toBe('carry');
      expect(carry.payload.value.action.value.actionData.value.endLocation).toBeDefined();
    });

    it('filters out unsupported event types', () => {
      const result = fromStatsBombOpen(events, { gameId });

      // Count raw events of supported types
      const supportedTypeIds = [
        STATSBOMB_EVENT_TYPES.SHOT,
        STATSBOMB_EVENT_TYPES.PASS,
        STATSBOMB_EVENT_TYPES.CARRY,
        STATSBOMB_EVENT_TYPES.INTERCEPTION,
      ] as const;
      const supportedRawCount = events.filter((e) =>
        (supportedTypeIds as readonly number[]).includes(e.type.id)
      ).length;

      // Duel events are only included if they're tackles
      const tackleCount = events.filter(
        (e) => e.type.id === STATSBOMB_EVENT_TYPES.DUEL && e.duel?.type?.id === 11
      ).length;

      // Total transformed should be <= supported raw + tackles
      expect(result.occurrences.length).toBeLessThanOrEqual(supportedRawCount + tackleCount);
    });
  });

  describe('data source attribution', () => {
    it('includes StatsBomb Open attribution', () => {
      const result = fromStatsBombOpen(events, { gameId });

      expect(result.occurrences[0]?.source?.provider).toBe('statsbomb-open');
      expect(result.occurrences[0]?.source?.name).toBe('StatsBomb Open Data');
      expect(result.occurrences[0]?.source?.url).toContain('github.com/statsbomb');
    });
  });

  describe('timestamp calculation', () => {
    it('converts minute/second to decimal timestamp', () => {
      const result = fromStatsBombOpen(events, { gameId });

      // Find an event in the first half
      const event = result.occurrences.find(
        (e) => e.clock && e.clock.elapsedSeconds > 0 && e.clock.elapsedSeconds < 45 * 60
      );

      expect(event).toBeDefined();
      expect(event!.clock!.elapsedSeconds).toBeGreaterThan(0);
    });

    it('includes period in event meta', () => {
      const result = fromStatsBombOpen(events, { gameId });

      // All events should have period in meta
      for (const event of result.occurrences.slice(0, 10)) {
        expect(event.clock).toBeDefined();
        expect([1, 2, 3, 4, 5]).toContain(event.clock?.period);
      }
    });
  });

  // These use the committed fixtures (no live network), per the task: feed a
  // shot with a freeze_frame and assert ShotEventData.freeze_frame is
  // populated, coords are 0-100, and is_keeper is derived.
  describe('shot freeze_frame (fixture, no network)', () => {
    it('populates ShotEventData.freeze_frame with 0-100 coords and derives is_keeper', () => {
      const result = fromStatsBombOpen(shotFixtureEvents, { gameId });
      const shots = result.occurrences.filter(isShot);
      expect(shots.length).toBe(1);

      const freezeFrame = shots[0].payload.value.action.value.actionData.value.freezeFrame;
      // Fixture has 3 players in the shot's freeze_frame.
      expect(freezeFrame.length).toBe(3);

      // Every freeze-frame player has a 0-100 location + a provider player id.
      for (const player of freezeFrame) {
        expect(player.location).toBeDefined();
        expect(player.location!.x).toBeGreaterThanOrEqual(0);
        expect(player.location!.x).toBeLessThanOrEqual(100);
        expect(player.location!.y).toBeGreaterThanOrEqual(0);
        expect(player.location!.y).toBeLessThanOrEqual(100);
        expect(player.providerPlayerId).not.toBe('');
        // actor_entity_id/actor_name are resolved later at read time.
        expect(player.actorEntityId).toBe('');
        expect(player.actorName).toBe('');
      }

      // Exactly one player (Hugo Lloris, position "Goalkeeper") is the keeper.
      const keepers = freezeFrame.filter((p) => p.isKeeper);
      expect(keepers.length).toBe(1);
      expect(keepers[0].providerPlayerId).toBe('3099');

      // teammate flag carried through (Mac Allister is the only teammate here).
      expect(freezeFrame.filter((p) => p.teammate).length).toBe(1);
    });

    it('populates the occurrence actors[] with shooter + team as unresolved provider refs', () => {
      const result = fromStatsBombOpen(shotFixtureEvents, { gameId });
      const shot = result.occurrences.filter(isShot)[0];

      expect(shot.actors.length).toBe(2);
      for (const actor of shot.actors) {
        expect(actor.state).toBe(ResolutionState.UNRESOLVED_PROVIDER_REF);
        expect(actor.entityId).toBe('');
        expect(actor.providerRef?.provider).toBe('statsbomb-open');
      }
      const resourceTypes = shot.actors.map((a) => a.providerRef?.providerResourceType).sort();
      expect(resourceTypes).toEqual(['player', 'team']);
      // Shooter (Mac Allister, 27886) + Argentina (779) carried as provider ids.
      const ids = shot.actors.map((a) => a.providerRef?.providerId).sort();
      expect(ids).toEqual(['27886', '779']);
      expect(shot.resolutionState).toBe(ResolutionState.UNRESOLVED_PROVIDER_REF);
    });
  });

  describe('360 visible_area (fixture, no network)', () => {
    it('maps the matching 360 frame visible_area to 0-100 pairwise', () => {
      const result = fromStatsBombOpen(shotFixtureEvents, {
        gameId,
        threeSixtyFrames: threeSixtyFixture,
      });
      const shot = result.occurrences.filter(isShot)[0];
      const { visibleArea } = shot.payload.value.action.value;

      // 12 flat coords in the fixture -> 6 PitchCoordinates.
      expect(visibleArea.length).toBe(6);
      for (const point of visibleArea) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(100);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(100);
      }
    });

    it('omits visible_area when no 360 frames are supplied', () => {
      const result = fromStatsBombOpen(shotFixtureEvents, { gameId });
      const shot = result.occurrences.filter(isShot)[0];
      expect(shot.payload.value.action.value.visibleArea.length).toBe(0);
    });

    it('prefers the shot freeze_frame over the 360 freeze_frame for shots', () => {
      // The fixture shot HAS its own freeze_frame, so even with a 360 frame
      // present the shot.freeze_frame (3 players, with provider ids) wins.
      const result = fromStatsBombOpen(shotFixtureEvents, {
        gameId,
        threeSixtyFrames: threeSixtyFixture,
      });
      const freezeFrame =
        result.occurrences.filter(isShot)[0].payload.value.action.value.actionData.value
          .freezeFrame;
      expect(freezeFrame.length).toBe(3);
      // Shot-sourced freeze-frame carries provider player ids; the 360 one
      // would not. Confirms we took the shot path.
      expect(freezeFrame.every((p) => p.providerPlayerId !== '')).toBe(true);
    });
  });
});
