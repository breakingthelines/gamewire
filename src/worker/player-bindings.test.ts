import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  type ResolvePlayerBindingsRequest,
  type ResolvePlayerBindingsResponse,
  ResolvePlayerBindingsResponseSchema,
  ResolvedPlayerBindingSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import {
  createPlayerBindingResolver,
  MAX_PLAYER_BINDING_IDS,
  type PlayerBindingLogEntry,
  type PlayerSource,
} from './player-bindings.js';

type Answer = ResolvePlayerBindingsResponse | Error;

/** A game-service stub that answers each call from `answers` in turn (the last repeats). */
const stubGameService = (answers: Answer[]) => {
  const calls: ResolvePlayerBindingsRequest[] = [];
  return {
    calls,
    client: {
      async resolvePlayerBindings(request: ResolvePlayerBindingsRequest) {
        calls.push(request);
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
    },
  };
};

const modeOnly = (ingestMode: string) =>
  create(ResolvePlayerBindingsResponseSchema, { ingestMode });

const on = (bindings: Record<string, [entityId: string, label?: string]>) =>
  create(ResolvePlayerBindingsResponseSchema, {
    ingestMode: 'on',
    bindings: Object.entries(bindings).map(([providerPlayerId, [entityId, label]]) =>
      create(ResolvedPlayerBindingSchema, {
        providerPlayerId,
        entityId,
        hasBinding: true,
        label: label ?? '',
      })
    ),
  });

const players = (source: PlayerSource) =>
  source.kind === 'bindings' ? Object.fromEntries(source.players) : undefined;

describe('createPlayerBindingResolver', () => {
  it('uses identity when the client has no resolvePlayerBindings method', async () => {
    const resolver = createPlayerBindingResolver({ client: {}, providerId: 'api-football' });
    expect(await resolver.forPlayers(['1460'])).toEqual({ kind: 'identity' });
  });

  it('uses identity for providers without player bindings, with no call', async () => {
    const gs = stubGameService([on({ '1460': ['btl_football_player_saka'] })]);
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'statsbomb' });
    expect(await resolver.forPlayers(['1460'])).toEqual({ kind: 'identity' });
    expect(gs.calls).toHaveLength(0);
  });

  it('uses identity for a page with no player ids, with no call', async () => {
    const gs = stubGameService([on({})]);
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    expect(await resolver.forPlayers(['', '  '])).toEqual({ kind: 'identity' });
    expect(gs.calls).toHaveLength(0);
  });

  it.each(['off', 'shadow', '', 'paused'])(
    'uses identity while ingest is %j, and reuses that answer for a minute',
    async (mode) => {
      let now = 1_000_000;
      const gs = stubGameService([modeOnly(mode)]);
      const resolver = createPlayerBindingResolver({
        client: gs.client,
        providerId: 'api-football',
        clock: () => now,
      });
      expect(await resolver.forPlayers(['1460'])).toEqual({ kind: 'identity' });
      now += 59_000;
      expect(await resolver.forPlayers(['1460'])).toEqual({ kind: 'identity' });
      expect(gs.calls).toHaveLength(1);
      now += 2_000;
      await resolver.forPlayers(['1460']);
      expect(gs.calls).toHaveLength(2);
    }
  );

  it('answers from the bindings when ingest is on, dropping placeholders and duplicates', async () => {
    const gs = stubGameService([
      on({
        '1460': ['btl_football_player_moved', 'Moved Player'],
        '501906': ['provider:api-football:player:501906'],
        '777': ['btl_football_player_nolabel'],
      }),
    ]);
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    const source = await resolver.forPlayers(['1460', '501906', '777', '1460', ' 777 ']);
    expect(source.kind).toBe('bindings');
    expect(source.kind === 'bindings' && source.reason).toBe('on');
    expect(players(source)).toEqual({
      '1460': { entityId: 'btl_football_player_moved', label: 'Moved Player' },
      '777': { entityId: 'btl_football_player_nolabel' },
    });
    expect(gs.calls).toHaveLength(1);
    expect(gs.calls[0]?.provider).toBe('api-football');
    expect(gs.calls[0]?.providerPlayerIds).toEqual(['1460', '501906', '777']);
  });

  it('asks again on every page while ingest is on', async () => {
    const gs = stubGameService([on({ '1460': ['btl_football_player_a'] })]);
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    await resolver.forPlayers(['1460']);
    await resolver.forPlayers(['1460']);
    expect(gs.calls).toHaveLength(2);
  });

  it('splits a large page into calls of at most 500 ids', async () => {
    const gs = stubGameService([on({})]);
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    const ids = Array.from({ length: MAX_PLAYER_BINDING_IDS + 3 }, (_, i) => String(i + 1));
    await resolver.forPlayers(ids);
    expect(gs.calls.map((call) => call.providerPlayerIds.length)).toEqual([
      MAX_PLAYER_BINDING_IDS,
      3,
    ]);
  });

  it('treats an older game-service without the RPC as off, and remembers it', async () => {
    const gs = stubGameService([new ConnectError('unknown method', Code.Unimplemented)]);
    const logs: PlayerBindingLogEntry[] = [];
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    expect(await resolver.forPlayers(['1460'], (entry) => logs.push(entry))).toEqual({
      kind: 'identity',
    });
    await resolver.forPlayers(['1460']);
    expect(gs.calls).toHaveLength(1);
    expect(logs).toHaveLength(0);
  });

  it('falls back to identity on an error before ingest was ever seen on', async () => {
    const gs = stubGameService([new ConnectError('down', Code.Unavailable)]);
    const logs: PlayerBindingLogEntry[] = [];
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    expect(await resolver.forPlayers(['1460'], (entry) => logs.push(entry))).toEqual({
      kind: 'identity',
    });
    expect(logs.map((entry) => entry.reason)).toEqual(['unavailable']);
  });

  it('never falls back to identity once ingest was on: the page goes out as provider refs', async () => {
    const gs = stubGameService([
      on({ '1460': ['btl_football_player_moved'] }),
      new ConnectError('deadline', Code.DeadlineExceeded),
    ]);
    const logs: PlayerBindingLogEntry[] = [];
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    await resolver.forPlayers(['1460']);
    const source = await resolver.forPlayers(['1460'], (entry) => logs.push(entry));
    expect(source.kind).toBe('bindings');
    expect(source.kind === 'bindings' && source.reason).toBe('unavailable');
    expect(players(source)).toEqual({});
    expect(logs.map((entry) => entry.reason)).toEqual(['on_unavailable']);
  });

  it.each(['off', 'shadow'])(
    'goes back to identity only once a later %j answer confirms the switch from on',
    async (next) => {
      let now = 1_000_000;
      const gs = stubGameService([on({ '1460': ['btl_football_player_a'] }), modeOnly(next)]);
      const logs: PlayerBindingLogEntry[] = [];
      const resolver = createPlayerBindingResolver({
        client: gs.client,
        providerId: 'api-football',
        clock: () => now,
      });
      expect((await resolver.forPlayers(['1460'])).kind).toBe('bindings');
      // The first non-on answer is not trusted: provider refs, never identity.
      const first = await resolver.forPlayers(['1460'], (entry) => logs.push(entry));
      expect(first.kind === 'bindings' && first.reason).toBe('confirming');
      expect(players(first)).toEqual({});
      now += 29_000;
      const second = await resolver.forPlayers(['1460'], (entry) => logs.push(entry));
      expect(second.kind === 'bindings' && second.reason).toBe('confirming');
      expect(logs.map((entry) => entry.reason)).toEqual(['downgrade_pending']);
      now += 1_000;
      expect(await resolver.forPlayers(['1460'])).toEqual({ kind: 'identity' });
      // Confirmed: the answer is now reused for the mode TTL.
      expect(await resolver.forPlayers(['1460'])).toEqual({ kind: 'identity' });
      expect(gs.calls).toHaveLength(4);
    }
  );

  it('an on answer cancels a pending downgrade', async () => {
    let now = 1_000_000;
    const gs = stubGameService([
      on({ '1460': ['btl_football_player_a'] }),
      modeOnly('off'),
      on({ '1460': ['btl_football_player_a'] }),
      modeOnly('off'),
    ]);
    const resolver = createPlayerBindingResolver({
      client: gs.client,
      providerId: 'api-football',
      clock: () => now,
    });
    await resolver.forPlayers(['1460']);
    expect(await resolver.forPlayers(['1460'])).toMatchObject({ reason: 'confirming' });
    now += 20_000;
    expect(await resolver.forPlayers(['1460'])).toMatchObject({ reason: 'on' });
    now += 20_000;
    // A new downgrade starts its own window: 40 s after the first off is not enough.
    expect(await resolver.forPlayers(['1460'])).toMatchObject({ reason: 'confirming' });
  });

  it('an error while a downgrade is pending still sends provider refs', async () => {
    const gs = stubGameService([
      on({ '1460': ['btl_football_player_a'] }),
      modeOnly('off'),
      new ConnectError('down', Code.Unavailable),
    ]);
    const resolver = createPlayerBindingResolver({ client: gs.client, providerId: 'api-football' });
    await resolver.forPlayers(['1460']);
    await resolver.forPlayers(['1460']);
    expect(await resolver.forPlayers(['1460'])).toMatchObject({
      kind: 'bindings',
      reason: 'unavailable',
    });
  });
});
