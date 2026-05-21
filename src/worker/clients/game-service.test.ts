import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  GameService,
  IngestBatchResponseSchema,
  IngestFootballLineupsRequestSchema,
  IngestFootballSquadListsRequestSchema,
  IngestGameOccurrencesRequestSchema,
  IngestGamesRequestSchema,
  LookupGameByFixtureRequestSchema,
  LookupGameByFixtureResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

interface GameServiceClientMocks {
  createClient: ReturnType<typeof vi.fn>;
  createGrpcTransport: ReturnType<typeof vi.fn>;
}

declare global {
  // eslint-disable-next-line no-var
  var __gameServiceClientMocks: GameServiceClientMocks | undefined;
}

function gameServiceClientMocks(): GameServiceClientMocks {
  globalThis.__gameServiceClientMocks ??= {
    createClient: vi.fn(),
    createGrpcTransport: vi.fn(),
  };
  return globalThis.__gameServiceClientMocks;
}

const callMock = (mock: ReturnType<typeof vi.fn>, args: unknown[]): unknown =>
  (mock as unknown as (...callArgs: unknown[]) => unknown)(...args);

vi.mock('@connectrpc/connect', () => ({
  createClient: (...args: unknown[]) => callMock(gameServiceClientMocks().createClient, args),
}));

vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: (...args: unknown[]) =>
    callMock(gameServiceClientMocks().createGrpcTransport, args),
}));

describe('createFetchFootballGameLookupClient', () => {
  it('uses the native gRPC transport for game-service mesh calls', async () => {
    const mocks = gameServiceClientMocks();
    mocks.createClient.mockReset();
    mocks.createGrpcTransport.mockReset();

    const transport = { kind: 'grpc-transport' };
    const ingestGames = vi.fn().mockResolvedValue(create(IngestBatchResponseSchema, {}));
    const ingestGameOccurrences = vi.fn().mockResolvedValue(create(IngestBatchResponseSchema, {}));
    const ingestFootballLineups = vi.fn().mockResolvedValue(create(IngestBatchResponseSchema, {}));
    const ingestFootballSquadLists = vi
      .fn()
      .mockResolvedValue(create(IngestBatchResponseSchema, {}));
    const lookupGameByFixture = vi
      .fn()
      .mockResolvedValue(create(LookupGameByFixtureResponseSchema, { found: true }));

    mocks.createGrpcTransport.mockReturnValue(transport);
    mocks.createClient.mockReturnValue({
      ingestGames,
      ingestGameOccurrences,
      ingestFootballLineups,
      ingestFootballSquadLists,
      lookupGameByFixture,
    });

    const { createFetchFootballGameLookupClient } = await import('./game-service.js');

    const client = createFetchFootballGameLookupClient({
      baseUrl: 'http://game-service:50059/',
      timeoutMs: 1234,
    });
    const ingestRequest = create(IngestGamesRequestSchema, {});
    const lookupRequest = create(LookupGameByFixtureRequestSchema, {
      provider: 'api-football',
      providerFixtureId: '1379343',
    });

    await client.ingestGames(ingestRequest);
    const occurrencesRequest = create(IngestGameOccurrencesRequestSchema, {});
    const lineupsRequest = create(IngestFootballLineupsRequestSchema, {});
    const squadListsRequest = create(IngestFootballSquadListsRequestSchema, {});
    await client.ingestGameOccurrences(occurrencesRequest);
    await client.ingestFootballLineups(lineupsRequest);
    await client.ingestFootballSquadLists(squadListsRequest);
    await client.lookupGameByFixture(lookupRequest);

    expect(mocks.createGrpcTransport).toHaveBeenCalledWith({
      baseUrl: 'http://game-service:50059',
    });
    expect(mocks.createClient).toHaveBeenCalledWith(GameService, transport);
    expect(ingestGames).toHaveBeenCalledWith(ingestRequest, { timeoutMs: 1234 });
    expect(ingestGameOccurrences).toHaveBeenCalledWith(occurrencesRequest, { timeoutMs: 1234 });
    expect(ingestFootballLineups).toHaveBeenCalledWith(lineupsRequest, { timeoutMs: 1234 });
    expect(ingestFootballSquadLists).toHaveBeenCalledWith(squadListsRequest, {
      timeoutMs: 1234,
    });
    expect(lookupGameByFixture).toHaveBeenCalledWith(lookupRequest, { timeoutMs: 1234 });
  });
});
