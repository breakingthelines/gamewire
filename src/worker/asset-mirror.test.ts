import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  type LookupRequest,
  type LookupResponse,
  type ResolveRequest,
  type ResolveResponse,
  ResolveResponseSchema,
  type SearchRequest,
  type SearchResponse,
  type StatsRequest,
  type StatsResponse,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import type { FootballIdentityLookupClient } from './clients/identity.js';
import {
  ENTITY_IMAGERY_MANIFEST_KEY,
  MEDIA_PREFIX,
  createAssetMirror,
  entityImageKeySuffix,
  entityImageTypeFor,
  extensionFromUrl,
  mirrorObjectKey,
  type EntityImageManifest,
  type ImageFetch,
  type MediaObjectStore,
} from './asset-mirror.js';
import { createAssetMirrorBridge } from './media-store.js';

const PROVIDER_ID = 'api-football';
// The CDN base the platform's resolver reads back from — INCLUDES the `/media`
// segment, because the objects live under `media/` in the shared content bucket
// and `cdn.breakingthelines.dev` fronts the bucket root.
const CDN_BASE = 'https://cdn.breakingthelines.dev/media';

/**
 * Identity stub resolving a fixed provider-id → canonical-id map, scoped by
 * entity type so a team `42` and a player `42` never collide. Misses anything
 * not in the map. Mirrors the bridge test idiom.
 */
const resolvingIdentity = (
  entities: Partial<Record<EntityType, Record<string, string>>>
): FootballIdentityLookupClient => ({
  async resolve(request: ResolveRequest): Promise<ResolveResponse> {
    const entityId = entities[request.entityType]?.[request.providerId];
    return create(ResolveResponseSchema, {
      entityId: entityId ?? '',
      entityType: request.entityType,
      found: entityId !== undefined,
    });
  },
  async lookup(_request: LookupRequest): Promise<LookupResponse> {
    throw new Error('lookup not used by the asset mirror');
  },
  async search(_request: SearchRequest): Promise<SearchResponse> {
    throw new Error('search not used by the asset mirror');
  },
  async stats(_request: StatsRequest): Promise<StatsResponse> {
    throw new Error('stats not used by the asset mirror');
  },
});

const inertIdentity = (): FootballIdentityLookupClient => ({
  async resolve(_request: ResolveRequest): Promise<ResolveResponse> {
    throw new Error('identity.resolve must not be called');
  },
  async lookup(_request: LookupRequest): Promise<LookupResponse> {
    throw new Error('not used');
  },
  async search(_request: SearchRequest): Promise<SearchResponse> {
    throw new Error('not used');
  },
  async stats(_request: StatsRequest): Promise<StatsResponse> {
    throw new Error('not used');
  },
});

interface PutCall {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
}

/**
 * In-memory {@link MediaObjectStore} for unit tests. Tracks HEAD/GET/PUT calls
 * and lets a test pre-seed existing keys (to exercise the HEAD-skip path).
 */
class FakeMediaStore implements MediaObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly headKeys: string[] = [];
  readonly puts: PutCall[] = [];

  seed(key: string, body = new Uint8Array([1])): void {
    this.objects.set(key, body);
  }

  async head(key: string): Promise<boolean> {
    this.headKeys.push(key);
    return this.objects.has(key);
  }

  async getText(key: string): Promise<string | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : new TextDecoder().decode(value);
  }

  async put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: string; readonly cacheControl: string }
  ): Promise<void> {
    this.objects.set(key, body);
    this.puts.push({
      key,
      body,
      contentType: options.contentType,
      cacheControl: options.cacheControl,
    });
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A successful image fetch returning PNG bytes + a content-type header. */
const okImageFetch = (contentType = 'image/png'): ImageFetch =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    arrayBuffer: async () => PNG_BYTES.buffer.slice(0),
  }));

const noopLogger = (): void => {};

/** Single-fixture envelope: home/away crests + the competition logo. */
const fixtureEnvelope = (): unknown => ({
  response: [
    {
      fixture: { id: 1538961, date: '2026-05-20T15:00:00+00:00', status: { short: 'FT' } },
      league: {
        id: 39,
        name: 'Premier League',
        season: 2025,
        logo: 'https://media.api-sports.io/football/leagues/39.png',
      },
      teams: {
        home: {
          id: 42,
          name: 'Arsenal',
          logo: 'https://media.api-sports.io/football/teams/42.png',
        },
        away: {
          id: 49,
          name: 'Chelsea',
          logo: 'https://media.api-sports.io/football/teams/49.png',
        },
      },
    },
  ],
});

const squadEnvelope = (): unknown => ({
  response: [
    {
      team: { id: 42, name: 'Arsenal', logo: 'https://media.api-sports.io/football/teams/42.png' },
      players: [
        {
          id: 1460,
          name: 'Bukayo Saka',
          photo: 'https://media.api-sports.io/football/players/1460.png',
        },
      ],
    },
  ],
});

/**
 * Byte-for-byte reimplementation of `@breakingthelines/design-system` 0.8.0's
 * published `entityImageKey` (`src/lib/entity-image.ts`). The producer
 * (gamewire, this module) and the consumer (the platform resolver) must agree
 * on this string EXACTLY; this local copy lets the test fail loudly if either
 * side drifts. The mirror writes the `provider` layer under the bucket's
 * `media/` prefix; the resolver appends the layer suffix to a `/media` cdnBase.
 */
const dsEntityImageKey = (
  layer: 'btl' | 'provider',
  type: string,
  entityId: string,
  ext: string
): string => `${layer}/${type}/${entityId}.${ext}`;

describe('mirrorObjectKey (producer/consumer contract)', () => {
  it('suffix equals the design-system entityImageKey output exactly', () => {
    // The trailing segment MUST be byte-identical to entityImageKey('provider', ...).
    expect(entityImageKeySuffix('crest', 'btl_football_team_42', 'png')).toBe(
      dsEntityImageKey('provider', 'crest', 'btl_football_team_42', 'png')
    );
    expect(entityImageKeySuffix('crest', 'btl_football_team_42', 'png')).toBe(
      'provider/crest/btl_football_team_42.png'
    );
  });

  it('bucket key is the content bucket media/ prefix + the entityImageKey suffix', () => {
    // The platform resolver builds:
    //   `${cdnBase}/${entityImageKey('provider', type, id, ext)}`
    //   = `https://cdn.breakingthelines.dev/media` + `/provider/crest/btl_football_team_42.png`
    //   = `cdn.breakingthelines.dev/media/provider/crest/btl_football_team_42.png`
    // which maps to bucket key `media/provider/crest/btl_football_team_42.png`.
    expect(MEDIA_PREFIX).toBe('media/');
    expect(mirrorObjectKey('crest', 'btl_football_team_42', 'png')).toBe(
      'media/provider/crest/btl_football_team_42.png'
    );
    expect(mirrorObjectKey('competition', 'btl_football_competition_39', 'png')).toBe(
      'media/provider/competition/btl_football_competition_39.png'
    );
    expect(mirrorObjectKey('player', 'btl_football_player_1460', 'webp')).toBe(
      'media/provider/player/btl_football_player_1460.webp'
    );
    // Equivalence with the resolver's URL join (cdnBase + '/' + suffix).
    const suffix = entityImageKeySuffix('crest', 'btl_football_team_42', 'png');
    expect(`${CDN_BASE}/${suffix}`).toBe(
      'https://cdn.breakingthelines.dev/media/provider/crest/btl_football_team_42.png'
    );
    expect(mirrorObjectKey('crest', 'btl_football_team_42', 'png')).toBe(
      `${MEDIA_PREFIX}${suffix}`
    );
  });

  it('manifest key lives under the content bucket media/ prefix', () => {
    expect(ENTITY_IMAGERY_MANIFEST_KEY).toBe('media/manifest/entity-imagery.json');
  });
});

describe('entityImageTypeFor (identity EntityType → key token)', () => {
  it('maps the imagery-bearing entity types to the resolver tokens', () => {
    expect(entityImageTypeFor(EntityType.TEAM)).toBe('crest');
    expect(entityImageTypeFor(EntityType.COMPETITION)).toBe('competition');
    expect(entityImageTypeFor(EntityType.PLAYER)).toBe('player');
    expect(entityImageTypeFor(EntityType.COACH)).toBe('manager');
    expect(entityImageTypeFor(EntityType.VENUE)).toBe('stadium');
  });

  it('returns null for non-imagery entity types', () => {
    expect(entityImageTypeFor(EntityType.SEASON)).toBeNull();
    expect(entityImageTypeFor(EntityType.GAME)).toBeNull();
  });
});

describe('extensionFromUrl', () => {
  it('extracts the lowercased extension and strips query/fragment', () => {
    expect(extensionFromUrl('https://media.api-sports.io/football/teams/42.png')).toBe('png');
    expect(extensionFromUrl('https://x/y/z.SVG?v=2')).toBe('svg');
    expect(extensionFromUrl('https://x/y/z.webp#frag')).toBe('webp');
  });

  it('returns empty for unknown or missing extensions (never invents one)', () => {
    expect(extensionFromUrl('https://x/y/noext')).toBe('');
    expect(extensionFromUrl('https://x/y/z.bin')).toBe('');
  });
});

describe('createAssetMirror', () => {
  it('PUTs on miss at the exact media/provider/<type>/<id>.<ext> key with immutable cache', async () => {
    const store = new FakeMediaStore();
    const imageFetch = okImageFetch('image/png');
    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({
        [EntityType.TEAM]: { '42': 'btl_football_team_42', '49': 'btl_football_team_49' },
        [EntityType.COMPETITION]: { '39': 'btl_football_competition_39' },
      }),
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch,
      logger: noopLogger,
      clock: () => Date.parse('2026-06-02T00:00:00Z'),
    });

    await mirror({
      workload: 'fixture-detail-fullTime',
      resourceId: '1538961',
      data: fixtureEnvelope(),
    });

    const imageKeys = store.puts
      .filter((p) => p.key !== ENTITY_IMAGERY_MANIFEST_KEY)
      .map((p) => p.key);
    expect(imageKeys).toEqual(
      expect.arrayContaining([
        'media/provider/crest/btl_football_team_42.png',
        'media/provider/crest/btl_football_team_49.png',
        'media/provider/competition/btl_football_competition_39.png',
      ])
    );
    expect(imageKeys).toHaveLength(3);

    const crestPut = store.puts.find(
      (p) => p.key === 'media/provider/crest/btl_football_team_42.png'
    );
    expect(crestPut?.contentType).toBe('image/png');
    expect(crestPut?.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(crestPut?.body).toEqual(PNG_BYTES);
    expect(imageFetch).toHaveBeenCalledTimes(3);
  });

  it('HEAD-skips when the object already exists: no image GET, no image PUT', async () => {
    const store = new FakeMediaStore();
    store.seed('media/provider/crest/btl_football_team_42.png');
    store.seed('media/provider/crest/btl_football_team_49.png');
    store.seed('media/provider/competition/btl_football_competition_39.png');
    const imageFetch = okImageFetch();
    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({
        [EntityType.TEAM]: { '42': 'btl_football_team_42', '49': 'btl_football_team_49' },
        [EntityType.COMPETITION]: { '39': 'btl_football_competition_39' },
      }),
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch,
      logger: noopLogger,
    });

    await mirror({
      workload: 'fixture-detail-fullTime',
      resourceId: '1538961',
      data: fixtureEnvelope(),
    });

    expect(imageFetch).not.toHaveBeenCalled();
    // HEAD was consulted for all three target keys.
    expect(store.headKeys).toEqual(
      expect.arrayContaining([
        'media/provider/crest/btl_football_team_42.png',
        'media/provider/crest/btl_football_team_49.png',
        'media/provider/competition/btl_football_competition_39.png',
      ])
    );
    // No image object was rewritten (only the 3 seeds remain; no manifest write either).
    expect(store.puts).toHaveLength(0);
  });

  it('patches the manifest at manifest/entity-imagery.json after a PUT', async () => {
    const store = new FakeMediaStore();
    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({ [EntityType.TEAM]: { '42': 'btl_football_team_42' } }),
      providerId: PROVIDER_ID,
      cdnBase: `${CDN_BASE}/`, // trailing slash should be stripped into the manifest cdnBase
      imageFetch: okImageFetch(),
      logger: noopLogger,
      clock: () => Date.parse('2026-06-02T00:00:00Z'),
    });

    // Squad envelope: team 42 has a logo + a player without a resolvable id (skipped).
    await mirror({
      workload: 'squad-list-fallback',
      resourceId: '1538961:42',
      data: {
        response: [
          {
            team: {
              id: 42,
              name: 'Arsenal',
              logo: 'https://media.api-sports.io/football/teams/42.png',
            },
            players: [],
          },
        ],
      },
    });

    const manifestPut = store.puts.find((p) => p.key === ENTITY_IMAGERY_MANIFEST_KEY);
    expect(manifestPut).toBeDefined();
    expect(manifestPut?.contentType).toBe('application/json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestPut!.body)) as EntityImageManifest;
    expect(manifest.cdnBase).toBe(CDN_BASE);
    expect(manifest.entities.btl_football_team_42).toEqual({ type: 'crest', provider: 'png' });
    expect(manifest.version).toBe('2026-06-02T00:00:00.000Z');
  });

  it('preserves a pre-existing btl layer + other entities when patching the manifest', async () => {
    const store = new FakeMediaStore();
    const seedManifest: EntityImageManifest = {
      version: '2026-01-01T00:00:00.000Z',
      cdnBase: CDN_BASE,
      entities: {
        btl_football_team_42: { type: 'crest', btl: 'svg' }, // bespoke art already landed
        btl_football_competition_39: { type: 'competition', provider: 'png' }, // unrelated entity
      },
    };
    store.objects.set(
      ENTITY_IMAGERY_MANIFEST_KEY,
      new TextEncoder().encode(JSON.stringify(seedManifest))
    );

    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({ [EntityType.TEAM]: { '42': 'btl_football_team_42' } }),
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch: okImageFetch(),
      logger: noopLogger,
    });

    await mirror({
      workload: 'squad-list-fallback',
      resourceId: '1538961:42',
      data: {
        response: [
          {
            team: {
              id: 42,
              name: 'Arsenal',
              logo: 'https://media.api-sports.io/football/teams/42.png',
            },
            players: [],
          },
        ],
      },
    });

    const manifestPut = store.puts.find((p) => p.key === ENTITY_IMAGERY_MANIFEST_KEY);
    const manifest = JSON.parse(new TextDecoder().decode(manifestPut!.body)) as EntityImageManifest;
    // btl layer preserved, provider layer added.
    expect(manifest.entities.btl_football_team_42).toEqual({
      type: 'crest',
      btl: 'svg',
      provider: 'png',
    });
    // Unrelated entity untouched.
    expect(manifest.entities.btl_football_competition_39).toEqual({
      type: 'competition',
      provider: 'png',
    });
  });

  it('skips when identity does not resolve the provider id (no GET, no PUT)', async () => {
    const store = new FakeMediaStore();
    const imageFetch = okImageFetch();
    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({}), // resolves nothing
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch,
      logger: noopLogger,
    });

    await mirror({
      workload: 'fixture-detail-fullTime',
      resourceId: '1538961',
      data: fixtureEnvelope(),
    });

    expect(imageFetch).not.toHaveBeenCalled();
    expect(store.puts).toHaveLength(0);
    expect(store.headKeys).toHaveLength(0); // never reaches HEAD without a canonical id
  });

  it('mirrors the team crest + player photo from a squad-list payload', async () => {
    const store = new FakeMediaStore();
    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({
        [EntityType.TEAM]: { '42': 'btl_football_team_42' },
        [EntityType.PLAYER]: { '1460': 'btl_football_player_1460' },
      }),
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch: okImageFetch(),
      logger: noopLogger,
    });

    await mirror({
      workload: 'squad-list-fallback',
      resourceId: '1538961:42',
      data: squadEnvelope(),
    });

    const imageKeys = store.puts
      .filter((p) => p.key !== ENTITY_IMAGERY_MANIFEST_KEY)
      .map((p) => p.key);
    expect(imageKeys).toEqual(
      expect.arrayContaining([
        'media/provider/crest/btl_football_team_42.png',
        'media/provider/player/btl_football_player_1460.png',
      ])
    );
  });

  it('ignores non-imagery workloads (events/lineups) entirely', async () => {
    const store = new FakeMediaStore();
    const imageFetch = okImageFetch();
    const mirror = createAssetMirror({
      store,
      identity: inertIdentity(),
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch,
      logger: noopLogger,
    });

    await mirror({ workload: 'events-post-final', resourceId: '1538961', data: fixtureEnvelope() });
    await mirror({
      workload: 'lineups-post-confirm',
      resourceId: '1538961',
      data: squadEnvelope(),
    });

    expect(imageFetch).not.toHaveBeenCalled();
    expect(store.puts).toHaveLength(0);
  });

  it('does not throw or PUT when the image GET fails (fire-and-forget)', async () => {
    const store = new FakeMediaStore();
    const failingFetch: ImageFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({ [EntityType.TEAM]: { '42': 'btl_football_team_42' } }),
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch: failingFetch,
      logger: noopLogger,
    });

    await expect(
      mirror({
        workload: 'squad-list-fallback',
        resourceId: '1538961:42',
        data: {
          response: [
            {
              team: {
                id: 42,
                name: 'Arsenal',
                logo: 'https://media.api-sports.io/football/teams/42.png',
              },
              players: [],
            },
          ],
        },
      })
    ).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
  });

  it('falls back to the extension content-type when the response header is generic', async () => {
    const store = new FakeMediaStore();
    const mirror = createAssetMirror({
      store,
      identity: resolvingIdentity({ [EntityType.TEAM]: { '42': 'btl_football_team_42' } }),
      providerId: PROVIDER_ID,
      cdnBase: CDN_BASE,
      imageFetch: okImageFetch('application/octet-stream'),
      logger: noopLogger,
    });

    await mirror({
      workload: 'squad-list-fallback',
      resourceId: '1538961:42',
      data: {
        response: [
          {
            team: {
              id: 42,
              name: 'Arsenal',
              logo: 'https://media.api-sports.io/football/teams/42.png',
            },
            players: [],
          },
        ],
      },
    });

    const crestPut = store.puts.find(
      (p) => p.key === 'media/provider/crest/btl_football_team_42.png'
    );
    expect(crestPut?.contentType).toBe('image/png');
  });
});

describe('createAssetMirrorBridge — no-bucket / no-creds guard', () => {
  // The bucket is the SHARED content bucket (`R2_BUCKET_CONTENT`); creds/endpoint
  // are the shared R2 creds. There is intentionally no separate media bucket.
  const CONTENT_BUCKET = 'btl-content';
  const baseConfig = {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    region: 'auto',
    cdnBaseUrl: CDN_BASE,
  };

  it('returns undefined (safe no-op) when the content bucket (R2_BUCKET_CONTENT) is unset', () => {
    const bridge = createAssetMirrorBridge({
      config: { ...baseConfig, bucket: undefined },
      identity: inertIdentity(),
      providerId: PROVIDER_ID,
    });
    expect(bridge).toBeUndefined();
  });

  it('returns undefined when the CDN base is missing', () => {
    const bridge = createAssetMirrorBridge({
      config: { ...baseConfig, bucket: CONTENT_BUCKET, cdnBaseUrl: undefined },
      identity: inertIdentity(),
      providerId: PROVIDER_ID,
    });
    expect(bridge).toBeUndefined();
  });

  it('returns undefined when shared R2 credentials are missing and no store is injected', () => {
    const bridge = createAssetMirrorBridge({
      config: { ...baseConfig, bucket: CONTENT_BUCKET, accessKeyId: undefined },
      identity: inertIdentity(),
      providerId: PROVIDER_ID,
    });
    expect(bridge).toBeUndefined();
  });

  it('builds an active bridge when the content bucket is set and a store is injected', async () => {
    const store = new FakeMediaStore();
    const bridge = createAssetMirrorBridge({
      config: { ...baseConfig, bucket: CONTENT_BUCKET },
      identity: resolvingIdentity({ [EntityType.TEAM]: { '42': 'btl_football_team_42' } }),
      providerId: PROVIDER_ID,
      store,
    });
    expect(bridge).toBeDefined();
    // Sanity: the active bridge actually mirrors via the injected store, at the
    // content bucket's media/provider/ key.
    await bridge!({
      workload: 'squad-list-fallback',
      resourceId: '1538961:42',
      data: {
        response: [
          {
            team: {
              id: 42,
              name: 'Arsenal',
              logo: 'https://media.api-sports.io/football/teams/42.png',
            },
            players: [],
          },
        ],
      },
    });
    expect(store.puts.some((p) => p.key === 'media/provider/crest/btl_football_team_42.png')).toBe(
      true
    );
  });
});
