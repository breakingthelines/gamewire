/**
 * Tests for the StatsBomb match-envelope → canonical `Game` adapter
 * (`gameFromStatsBombOpen` / `gameFromStatsBombMatch`).
 *
 * Verified against the real `matches/43/106.json` shape: prefixed team keys
 * (`home_team_id`/`home_team_name`), suffixed competition/season keys
 * (`competition_id`/`season_id`), and a `kick_off` HH:MM:SS string paired with
 * a `match_date`.
 */
import { describe, expect, it } from 'vitest';

import { ResolutionState } from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import {
  GameStatus,
  GameParticipantRole,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import { Sport, SubjectType } from '@breakingthelines/protos/btl/context/v1/context_pb';

import {
  gameFromStatsBombOpen,
  gameFromStatsBombMatch,
  kickoffMsFromMatch,
  teamSideFromMatchTeam,
} from './game.js';
import { STATSBOMB_OPEN_PROVIDER_ID } from './adapter.js';
import type { StatsBombMatch } from './types.js';

// The WC2022 final, mirroring the real matches/43/106.json envelope shape.
const finalMatch = (): StatsBombMatch =>
  ({
    match_id: 3869685,
    match_date: '2022-12-18',
    kick_off: '18:00:00.000',
    competition: {
      competition_id: 43,
      country_name: 'International',
      competition_name: 'FIFA World Cup',
    },
    season: { season_id: 106, season_name: '2022' },
    home_team: { home_team_id: 779, home_team_name: 'Argentina' },
    away_team: { away_team_id: 771, away_team_name: 'France' },
    home_score: 3,
    away_score: 3,
    match_status: 'available',
  }) as unknown as StatsBombMatch;

describe('teamSideFromMatchTeam', () => {
  it('reads the home side off the prefixed shape', () => {
    expect(teamSideFromMatchTeam(finalMatch().home_team, 'home')).toEqual({
      id: 779,
      name: 'Argentina',
    });
  });

  it('reads the away side off the prefixed shape', () => {
    expect(teamSideFromMatchTeam(finalMatch().away_team, 'away')).toEqual({
      id: 771,
      name: 'France',
    });
  });

  it('returns undefined for a missing/invalid side id', () => {
    expect(teamSideFromMatchTeam({ home_team_name: 'X' }, 'home')).toBeUndefined();
    expect(teamSideFromMatchTeam(undefined, 'home')).toBeUndefined();
  });
});

describe('kickoffMsFromMatch', () => {
  it('combines match_date + kick_off as UTC', () => {
    const ms = kickoffMsFromMatch({ match_date: '2022-12-18', kick_off: '18:00:00.000' });
    expect(ms).toBe(Date.parse('2022-12-18T18:00:00.000Z'));
  });

  it('falls back to date-only midnight UTC when kick_off is absent', () => {
    const ms = kickoffMsFromMatch({ match_date: '2022-12-18' });
    expect(ms).toBe(Date.parse('2022-12-18T00:00:00.000Z'));
  });

  it('returns undefined for a missing/unparseable date', () => {
    expect(kickoffMsFromMatch({ match_date: '' })).toBeUndefined();
    expect(kickoffMsFromMatch({ match_date: 'not-a-date' })).toBeUndefined();
  });
});

describe('gameFromStatsBombMatch', () => {
  it('mints a FOOTBALL game with provider_game_id = String(match_id)', () => {
    const game = gameFromStatsBombMatch(finalMatch());
    expect(game).not.toBeNull();
    expect(game?.sport).toBe(Sport.FOOTBALL);
    expect(game?.providerGameId).toBe('3869685');
    // No fabricated BTL id — the canonical id is assigned by game-service.
    expect(game?.id).toBe('');
  });

  it('emits two participants (HOME, AWAY) as UNRESOLVED provider refs', () => {
    const game = gameFromStatsBombMatch(finalMatch());
    expect(game?.participants.length).toBe(2);

    const [home, away] = game!.participants;
    expect(home.role).toBe(GameParticipantRole.HOME);
    expect(home.sortOrder).toBe(1);
    // subject left unset for game-service to resolve via the identity crosswalk.
    expect(home.subject).toBeUndefined();
    expect(home.resolutionRef?.state).toBe(ResolutionState.UNRESOLVED_PROVIDER_REF);
    expect(home.resolutionRef?.entityId).toBe('');
    expect(home.resolutionRef?.entityType).toBe(SubjectType.TEAM);
    expect(home.resolutionRef?.providerRef?.provider).toBe(STATSBOMB_OPEN_PROVIDER_ID);
    expect(home.resolutionRef?.providerRef?.providerId).toBe('779');
    expect(home.resolutionRef?.providerRef?.providerResourceType).toBe('team');
    expect(home.resolutionRef?.displayLabel).toBe('Argentina');

    expect(away.role).toBe(GameParticipantRole.AWAY);
    expect(away.sortOrder).toBe(2);
    expect(away.resolutionRef?.providerRef?.providerId).toBe('771');
    expect(away.resolutionRef?.displayLabel).toBe('France');
  });

  it('maps competition + season to provider-scoped fallback SubjectRefs', () => {
    const game = gameFromStatsBombMatch(finalMatch());
    expect(game?.competition?.type).toBe(SubjectType.COMPETITION);
    expect(game?.competition?.id).toBe(`provider:${STATSBOMB_OPEN_PROVIDER_ID}:competition:43`);
    expect(game?.competition?.label).toBe('FIFA World Cup');
    expect(game?.competition?.sport).toBe(Sport.FOOTBALL);

    expect(game?.season?.type).toBe(SubjectType.SEASON);
    expect(game?.season?.id).toBe(`provider:${STATSBOMB_OPEN_PROVIDER_ID}:season:106`);
    expect(game?.season?.label).toBe('2022 FIFA World Cup');
  });

  it('sets scheduled_start from match_date + kick_off (UTC)', () => {
    const game = gameFromStatsBombMatch(finalMatch());
    const expectedSeconds = BigInt(Math.floor(Date.parse('2022-12-18T18:00:00.000Z') / 1000));
    expect(game?.scheduledStart?.seconds).toBe(expectedSeconds);
  });

  it('mints as FINISHED with the final score when scores are present', () => {
    const game = gameFromStatsBombMatch(finalMatch());
    expect(game?.status).toBe(GameStatus.FINISHED);
    expect(game?.score?.display).toBe('3-3');
    expect(game?.score?.final).toBe(true);
    if (game?.score?.sportScore.case === 'football') {
      expect(game.score.sportScore.value.homeGoals).toBe(3);
      expect(game.score.sportScore.value.awayGoals).toBe(3);
    } else {
      throw new Error('expected a football score payload');
    }
  });

  it('carries an UNRESOLVED game-level resolution_ref (provider fixture)', () => {
    const game = gameFromStatsBombMatch(finalMatch());
    expect(game?.resolutionRef?.state).toBe(ResolutionState.UNRESOLVED_PROVIDER_REF);
    expect(game?.resolutionRef?.entityType).toBe(SubjectType.GAME);
    expect(game?.resolutionRef?.providerRef?.provider).toBe(STATSBOMB_OPEN_PROVIDER_ID);
    expect(game?.resolutionRef?.providerRef?.providerId).toBe('3869685');
    expect(game?.resolutionRef?.providerRef?.providerResourceType).toBe('fixture');
    expect(game?.resolutionRef?.displayLabel).toBe('Argentina v France');
  });

  it('falls back to SCHEDULED with no score when scores are absent', () => {
    const match = finalMatch();
    delete (match as { home_score?: number }).home_score;
    delete (match as { away_score?: number }).away_score;
    const game = gameFromStatsBombMatch(match);
    expect(game?.status).toBe(GameStatus.SCHEDULED);
    expect(game?.score).toBeUndefined();
  });

  it('returns null for a match missing a team id (unmintable)', () => {
    const match = finalMatch();
    (match as { home_team: unknown }).home_team = { home_team_name: 'Argentina' };
    expect(gameFromStatsBombMatch(match)).toBeNull();
  });

  it('returns null for a malformed match_id', () => {
    const match = finalMatch();
    (match as { match_id: unknown }).match_id = 'x';
    expect(gameFromStatsBombMatch(match)).toBeNull();
  });
});

describe('gameFromStatsBombOpen', () => {
  it('wraps the game in an IngestGamesRequest with statsbomb-open metadata', () => {
    const req = gameFromStatsBombOpen(finalMatch());
    expect(req.games.length).toBe(1);
    expect(req.games[0].providerGameId).toBe('3869685');
    expect(req.metadata?.provider).toBe(STATSBOMB_OPEN_PROVIDER_ID);
    expect(req.metadata?.replayId).toBe('statsbomb-open:game:3869685');
    // Idempotency: the key is stable for a given match + replay id.
    expect(req.metadata?.idempotencyKey).toBe(
      'statsbomb-open:games:3869685:statsbomb-open:game:3869685'
    );
  });

  it('honours an explicit replayId + rawPayloadRef', () => {
    const req = gameFromStatsBombOpen(finalMatch(), {
      replayId: 'custom-replay',
      rawPayloadRef: 'provider://statsbomb-open/matches/43/106.json',
    });
    expect(req.metadata?.replayId).toBe('custom-replay');
    expect(req.metadata?.rawPayloadRef).toBe('provider://statsbomb-open/matches/43/106.json');
  });

  it('returns an empty games array for an unmintable match', () => {
    const match = finalMatch();
    (match as { away_team: unknown }).away_team = {};
    const req = gameFromStatsBombOpen(match);
    expect(req.games.length).toBe(0);
    // Metadata is still well-formed so the caller can treat it as a skip.
    expect(req.metadata?.provider).toBe(STATSBOMB_OPEN_PROVIDER_ID);
  });
});
