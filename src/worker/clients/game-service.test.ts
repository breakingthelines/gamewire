// @ts-expect-error Bun provides this test helper at runtime.
import { mock } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import {
  GameService,
  IngestBatchResponseSchema,
  IngestGamesRequestSchema,
  LookupGameByFixtureRequestSchema,
  LookupGameByFixtureResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

const createClientMock = vi.fn();
const createGrpcTransportMock = vi.fn();

mock.module('@connectrpc/connect', () => ({
  createClient: createClientMock,
}));

mock.module('@connectrpc/connect-node', () => ({
  createGrpcTransport: createGrpcTransportMock,
}));

describe('createFetchFootballGameLookupClient', () => {
  it('uses the native gRPC transport for game-service mesh calls', async () => {
    const transport = { kind: 'grpc-transport' };
    const ingestGames = vi.fn().mockResolvedValue(create(IngestBatchResponseSchema, {}));
    const lookupGameByFixture = vi
      .fn()
      .mockResolvedValue(create(LookupGameByFixtureResponseSchema, { found: true }));

    createGrpcTransportMock.mockReturnValue(transport);
    createClientMock.mockReturnValue({
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

    expect(createGrpcTransportMock).toHaveBeenCalledWith({
      baseUrl: 'http://game-service:50059',
    });
    expect(createClientMock).toHaveBeenCalledWith(GameService, transport);
    expect(ingestGames).toHaveBeenCalledWith(ingestRequest, { timeoutMs: 1234 });
    expect(lookupGameByFixture).toHaveBeenCalledWith(lookupRequest, { timeoutMs: 1234 });
  });
});
