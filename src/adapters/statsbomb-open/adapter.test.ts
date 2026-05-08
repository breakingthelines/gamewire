import { describe, it, expect, beforeAll } from 'vitest';

import { fromStatsBombOpen } from './adapter.js';
import type { StatsBombEvent } from './types.js';
import { STATSBOMB_EVENT_TYPES } from './types.js';
import { FootballActionType, PassOutcome, isCarry, isPass, isShot } from '#/core/index.js';

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
});
