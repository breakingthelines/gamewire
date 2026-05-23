import { create } from '@bufbuild/protobuf';
import type { Interceptor, UnaryRequest, StreamRequest } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  IngestBatchResponseSchema,
  IngestFootballLineupsRequestSchema,
  IngestFootballSquadListsRequestSchema,
  IngestGameOccurrencesRequestSchema,
  IngestGamesRequestSchema,
  LookupGameByFixtureRequestSchema,
  LookupGameByFixtureResponseSchema,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import { createFetchFootballGameLookupClient } from './game-service.js';

// Auth-related metadata keys that MUST NEVER leave gamewire-worker.
// The mesh (Envoy + auth-service ext_authz) is responsible for stamping
// `btl-auth-context` on the user-service inbound listener. The worker
// itself does not mint, sign, or attach any auth header on outbound
// gRPC calls. This list mirrors the squad-service Go test
// (TestReserveHandle_NoClientSideAuthHeader) and is the explicit
// guard against any regression that re-introduces client-side minting.
const FORBIDDEN_AUTH_HEADERS = [
  'authorization',
  'btl-auth-context',
  'x-btl-auth-context',
  'x-spiffe-id',
  'x-btl-service-actor',
  'x-btl-service-actor-credential',
  'x-btl-service-actor-credential-id',
];

interface CapturedCall {
  readonly method: string;
  readonly headers: Record<string, string>;
}

/**
 * Build a Connect interceptor that records the outbound `req.header` for
 * every unary call and short-circuits the response with a caller-supplied
 * synthetic message. Short-circuiting avoids the need for a live gRPC
 * server in this test — we only care about what would have left the
 * client, not the server-side response shape.
 *
 * The `next` chain is intentionally never invoked: the call is fully
 * resolved inside the interceptor so it never reaches the underlying
 * http2 transport. The response object is cast through `unknown` because
 * Connect's `UnaryResponse` type is parameterised by the proto method's
 * descriptor and our synthetic response is shaped per-method at runtime.
 */
const captureInterceptor =
  (
    calls: CapturedCall[],
    syntheticResponse: (req: UnaryRequest | StreamRequest) => unknown
  ): Interceptor =>
  (_next) =>
  async (req: UnaryRequest | StreamRequest) => {
    const headers: Record<string, string> = {};
    req.header.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({ method: req.method.name, headers });

    if (req.stream) {
      const stream = req as StreamRequest;
      return {
        stream: true as const,
        service: stream.service,
        method: stream.method,
        header: new Headers(),
        trailer: new Headers(),
        message: (async function* () {
          yield syntheticResponse(stream);
        })(),
      } as unknown as ReturnType<typeof _next> extends Promise<infer R> ? R : never;
    }

    const unary = req as UnaryRequest;
    return {
      stream: false as const,
      service: unary.service,
      method: unary.method,
      header: new Headers(),
      trailer: new Headers(),
      message: syntheticResponse(unary),
    } as unknown as ReturnType<typeof _next> extends Promise<infer R> ? R : never;
  };

describe('createFetchFootballGameLookupClient — no client-side auth headers', () => {
  // Synthetic response factory. The bridge call sites only care that the
  // method round-trips, so an empty schema instance is enough.
  const syntheticResponse = (req: UnaryRequest | StreamRequest): unknown => {
    if (req.method.name === 'LookupGameByFixture') {
      return create(LookupGameByFixtureResponseSchema, { found: true });
    }
    return create(IngestBatchResponseSchema, {});
  };

  const assertNoAuthHeaders = (call: CapturedCall): void => {
    for (const forbidden of FORBIDDEN_AUTH_HEADERS) {
      expect(
        call.headers[forbidden],
        `client must not attach '${forbidden}' on ${call.method}`
      ).toBeUndefined();
    }
    for (const headerKey of Object.keys(call.headers)) {
      expect(
        headerKey.startsWith('btl-') || headerKey.startsWith('x-btl-'),
        `client must not attach any 'btl-*' or 'x-btl-*' metadata on ${call.method}; saw '${headerKey}'`
      ).toBe(false);
    }
  };

  it('ships no auth headers on the LookupGameByFixture mesh call', async () => {
    const calls: CapturedCall[] = [];
    const client = createFetchFootballGameLookupClient({
      baseUrl: 'http://game-service:50059',
      timeoutMs: 1_000,
      interceptors: [captureInterceptor(calls, syntheticResponse)],
    });

    const response = await client.lookupGameByFixture(
      create(LookupGameByFixtureRequestSchema, {
        provider: 'api-football',
        providerFixtureId: '1379343',
      })
    );

    expect(response.found).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('LookupGameByFixture');
    assertNoAuthHeaders(calls[0] as CapturedCall);
  });

  it('ships no auth headers on the IngestGames mesh call', async () => {
    const calls: CapturedCall[] = [];
    const client = createFetchFootballGameLookupClient({
      baseUrl: 'http://game-service:50059',
      timeoutMs: 1_000,
      interceptors: [captureInterceptor(calls, syntheticResponse)],
    });

    await client.ingestGames(create(IngestGamesRequestSchema, {}));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('IngestGames');
    assertNoAuthHeaders(calls[0] as CapturedCall);
  });

  it('ships no auth headers across the full bridge surface', async () => {
    const calls: CapturedCall[] = [];
    const client = createFetchFootballGameLookupClient({
      baseUrl: 'http://game-service:50059',
      timeoutMs: 1_000,
      interceptors: [captureInterceptor(calls, syntheticResponse)],
    });

    await client.ingestGames(create(IngestGamesRequestSchema, {}));
    await client.ingestGameOccurrences(create(IngestGameOccurrencesRequestSchema, {}));
    await client.ingestFootballLineups(create(IngestFootballLineupsRequestSchema, {}));
    await client.ingestFootballSquadLists(create(IngestFootballSquadListsRequestSchema, {}));
    await client.lookupGameByFixture(
      create(LookupGameByFixtureRequestSchema, {
        provider: 'api-football',
        providerFixtureId: '1379343',
      })
    );

    expect(calls.map((c) => c.method)).toEqual([
      'IngestGames',
      'IngestGameOccurrences',
      'IngestFootballLineups',
      'IngestFootballSquadLists',
      'LookupGameByFixture',
    ]);
    for (const call of calls) {
      assertNoAuthHeaders(call);
    }
  });

  it('respects the configured timeoutMs on each call', async () => {
    const calls: CapturedCall[] = [];
    const client = createFetchFootballGameLookupClient({
      baseUrl: 'http://game-service:50059',
      timeoutMs: 1_234,
      interceptors: [captureInterceptor(calls, syntheticResponse)],
    });

    await client.ingestGames(create(IngestGamesRequestSchema, {}));

    // Connect surfaces timeouts as the grpc-timeout pseudo-header on the
    // outgoing request. Confirm it is set so the bridge keeps the explicit
    // per-call deadline even though no auth wiring is involved.
    expect(calls[0]?.headers['grpc-timeout']).toBeDefined();
  });
});
