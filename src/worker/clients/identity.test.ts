import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import { createFetchFootballIdentityLookupClient, type IdentityFetch } from './identity.js';

describe('createFetchFootballIdentityLookupClient', () => {
  it('uses the deployed identity HTTP JSON resolve endpoint', async () => {
    const calls: Array<{ input: string | URL; init: Parameters<IdentityFetch>[1] }> = [];
    const fetchFn = vi.fn<IdentityFetch>(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        entity_id: 'btl_football_team_t8596499a',
        entity_type: 'ENTITY_TYPE_TEAM',
        provider_key: {
          entity_type: 'ENTITY_TYPE_TEAM',
          entity_id: 'btl_football_team_t8596499a',
          provider: 'api_football',
          provider_id: '42',
          confidence: 'PROVIDER_KEY_CONFIDENCE_VERIFIED',
          source: 'ENTITY_SOURCE_REEP',
        },
        found: true,
      });
    });

    const client = createFetchFootballIdentityLookupClient({
      baseUrl: 'http://identity-service:8094/',
      fetchFn,
    });

    const response = await client.resolve(
      create(ResolveRequestSchema, {
        entityType: EntityType.TEAM,
        provider: 'api-football',
        providerId: '42',
      })
    );

    expect(response.found).toBe(true);
    expect(response.entityId).toBe('btl_football_team_t8596499a');
    expect(response.entityType).toBe(EntityType.TEAM);
    expect(response.providerKey?.provider).toBe('api_football');
    expect(fetchFn).toHaveBeenCalledOnce();

    const url = new URL(String(calls[0]?.input));
    expect(url.pathname).toBe('/v1/resolve');
    expect(url.searchParams.get('provider')).toBe('api-football');
    expect(url.searchParams.get('provider_id')).toBe('42');
    expect(url.searchParams.get('type')).toBe('team');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers.accept).toBe('application/json');
  });

  it('includes identity HTTP failures in the thrown error', async () => {
    const client = createFetchFootballIdentityLookupClient({
      baseUrl: 'http://identity-service:8094',
      fetchFn: async () => jsonResponse({ error: 'not found' }, 404),
    });

    await expect(
      client.resolve(
        create(ResolveRequestSchema, {
          entityType: EntityType.TEAM,
          provider: 'api-football',
          providerId: 'missing',
        })
      )
    ).rejects.toThrow('identity-server /v1/resolve failed: status=404');
  });
});

const jsonResponse = (
  body: Record<string, unknown>,
  status = 200
): Awaited<ReturnType<IdentityFetch>> => ({
  ok: status >= 200 && status < 300,
  status,
  async text() {
    return JSON.stringify(body);
  },
});
