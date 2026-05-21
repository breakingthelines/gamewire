import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  GameService,
  IngestBatchResponseSchema,
  IngestGamesRequestSchema,
  LookupGameByFixtureRequestSchema,
  LookupGameByFixtureResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createGrpcTransport: vi.fn(),
}));

vi.mock('@connectrpc/connect', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: mocks.createGrpcTransport,
}));

describe('createFetchFootballGameLookupClient', () => {
  it('uses the native gRPC transport for game-service mesh calls', async () => {
    const transport = { kind: 'grpc-transport' };
    const ingestGames = vi.fn().mockResolvedValue(create(IngestBatchResponseSchema, {}));
    const lookupGameByFixture = vi
      .fn()
      .mockResolvedValue(create(LookupGameByFixtureResponseSchema, { found: true }));

    mocks.createGrpcTransport.mockReturnValue(transport);
    mocks.createClient.mockReturnValue({
      ingestGames,
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
    await client.lookupGameByFixture(lookupRequest);

    expect(mocks.createGrpcTransport).toHaveBeenCalledWith({
      baseUrl: 'http://game-service:50059',
    });
    expect(mocks.createClient).toHaveBeenCalledWith(GameService, transport);
    expect(ingestGames).toHaveBeenCalledWith(ingestRequest, { timeoutMs: 1234 });
    expect(lookupGameByFixture).toHaveBeenCalledWith(lookupRequest, { timeoutMs: 1234 });
  });
});
