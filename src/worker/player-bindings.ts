/**
 * Player resolution through game-service's API-Football player bindings
 * (ADR-057, GW1).
 *
 * game-service keeps one binding per API-Football player id and is the
 * runtime authority for which BTL player it is. Once its ingest runs `on`, a
 * player the rebind has moved must not be sent under identity's older answer
 * (identity answers are cached here for up to 6 h, and identity may still
 * hold a key the review queue has corrected). So, for the players on a
 * lineup, squad list, event list or player stats page, the bridge asks
 * game-service's `ResolvePlayerBindings` first:
 *
 * - ingest `on`: every player resolves from the bindings and identity is not
 *   asked for players. An id bound to no player stays a provider ref.
 * - ingest `off` or `shadow`, an older game-service without the RPC, a
 *   provider other than API-Football, or a client without the method: the
 *   bridge resolves players through identity exactly as before. `off` and
 *   `shadow` answers are remembered for a minute so the steady state costs
 *   one call a minute, not one per page.
 * - the call fails: while the last answer was `on`, players go out as
 *   provider refs (never identity's answer) and game-service binds them by
 *   provider id on write; otherwise identity, as before.
 *
 * Every payload also carries the provider player id next to the entity id
 * (lineup slots, squad list players, timeline events, occurrence actors), so
 * game-service can bind by it whatever id gamewire sent.
 */

import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';

import {
  type ResolvePlayerBindingsRequest,
  ResolvePlayerBindingsRequestSchema,
  type ResolvePlayerBindingsResponse,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import type { ApiFootballResolvedEntity } from '../adapters/api-football/index.js';

/** The game-service RPC this module needs. */
export interface PlayerBindingLookupClient {
  resolvePlayerBindings(
    request: ResolvePlayerBindingsRequest
  ): Promise<ResolvePlayerBindingsResponse>;
}

/** Where the bridge takes player ids from for one page. */
export type PlayerSource =
  | { readonly kind: 'identity' }
  | {
      readonly kind: 'bindings';
      /** `on`: game-service answered. `unavailable`: the call failed while ingest was on. */
      readonly reason: 'on' | 'unavailable';
      /** Canonical answers by provider player id; an absent id stays a provider ref. */
      readonly players: ReadonlyMap<string, ApiFootballResolvedEntity>;
    };

export const IDENTITY_PLAYER_SOURCE: PlayerSource = { kind: 'identity' };

export interface PlayerBindingLogEntry {
  readonly event: 'bridge_player_bindings_error';
  readonly providerId: string;
  readonly reason: 'on_unavailable' | 'unavailable';
  readonly message: string;
}

export interface PlayerBindingResolver {
  /** The source for a page's players. Never throws. */
  forPlayers(
    providerPlayerIds: readonly string[],
    log?: (entry: PlayerBindingLogEntry) => void
  ): Promise<PlayerSource>;
}

export interface PlayerBindingResolverOptions {
  /** game-service; without `resolvePlayerBindings` every page uses identity. */
  readonly client?: Partial<PlayerBindingLookupClient>;
  readonly providerId: string;
  readonly clock?: () => number;
  /** How long an `off`/`shadow` answer is reused. Default 60 s. */
  readonly modeTtlMs?: number;
}

/** The only provider game-service keeps player bindings for. */
export const PLAYER_BINDINGS_PROVIDER = 'api-football';
/** game-service's per-call cap. */
export const MAX_PLAYER_BINDING_IDS = 500;
const DEFAULT_MODE_TTL_MS = 60_000;

type KnownMode = 'unknown' | 'off' | 'shadow' | 'on' | 'unimplemented';

export const createPlayerBindingResolver = (
  options: PlayerBindingResolverOptions
): PlayerBindingResolver => {
  const clock = options.clock ?? Date.now;
  const ttl = options.modeTtlMs ?? DEFAULT_MODE_TTL_MS;
  const client = options.client;
  const resolve = client?.resolvePlayerBindings?.bind(client);
  let mode: KnownMode = 'unknown';
  let modeAt = 0;

  const remember = (next: KnownMode) => {
    mode = next;
    modeAt = clock();
  };

  return {
    async forPlayers(providerPlayerIds, log) {
      if (!resolve || options.providerId !== PLAYER_BINDINGS_PROVIDER) {
        return IDENTITY_PLAYER_SOURCE;
      }
      const ids = distinctIds(providerPlayerIds);
      if (ids.length === 0) {
        return IDENTITY_PLAYER_SOURCE;
      }
      if (mode !== 'unknown' && mode !== 'on' && clock() - modeAt < ttl) {
        return IDENTITY_PLAYER_SOURCE;
      }
      try {
        const players = new Map<string, ApiFootballResolvedEntity>();
        for (let start = 0; start < ids.length; start += MAX_PLAYER_BINDING_IDS) {
          const response = await resolve(
            create(ResolvePlayerBindingsRequestSchema, {
              provider: PLAYER_BINDINGS_PROVIDER,
              providerPlayerIds: ids.slice(start, start + MAX_PLAYER_BINDING_IDS),
            })
          );
          const answered = normaliseMode(response.ingestMode);
          remember(answered);
          if (answered !== 'on') {
            return IDENTITY_PLAYER_SOURCE;
          }
          for (const binding of response.bindings) {
            const entityId = binding.entityId.trim();
            if (!isCanonicalEntityId(entityId)) {
              continue;
            }
            const label = binding.label.trim();
            players.set(binding.providerPlayerId, label ? { entityId, label } : { entityId });
          }
        }
        return { kind: 'bindings', reason: 'on', players };
      } catch (err) {
        if (err instanceof ConnectError && err.code === Code.Unimplemented) {
          // A game-service older than the RPC: bindings are not running.
          remember('unimplemented');
          return IDENTITY_PLAYER_SOURCE;
        }
        const wasOn = mode === 'on';
        log?.({
          event: 'bridge_player_bindings_error',
          providerId: options.providerId,
          reason: wasOn ? 'on_unavailable' : 'unavailable',
          message: err instanceof Error ? err.message : String(err),
        });
        if (wasOn) {
          // Never fall back to identity once ingest is on: identity's answer
          // may be the one a rebind moved away from. Provider refs are bound
          // by game-service on write.
          return { kind: 'bindings', reason: 'unavailable', players: new Map() };
        }
        return IDENTITY_PLAYER_SOURCE;
      }
    },
  };
};

const distinctIds = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
};

const normaliseMode = (value: string): KnownMode => {
  switch (value.trim().toLowerCase()) {
    case 'on':
      return 'on';
    case 'shadow':
      return 'shadow';
    default:
      // "off", or anything this build does not know: behave as before.
      return 'off';
  }
};

/** A BTL entity id; provider placeholders (`provider:...`) are not. */
const isCanonicalEntityId = (id: string): boolean => id !== '' && !id.startsWith('provider:');
