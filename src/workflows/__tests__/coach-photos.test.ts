/**
 * `coach-photos`: copies API-Football coach headshots for identity-mapped
 * coaches to `media/apifootball/coach/<btl id>.png`. Identity, the media
 * store and the image host are stubbed; the workflow entry, kill switch and
 * wire parsing are the real ones.
 */
import { create } from '@bufbuild/protobuf';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  type ResolveRequest,
  ResolveResponseSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';
import { describe, expect, it } from 'vitest';

import type { MediaObjectStore } from '../../worker/asset-mirror.js';
import { InMemoryProviderCache } from '../../worker/cache.js';
import type { FootballIdentityLookupClient } from '../../worker/clients/identity.js';
import { parseProviderEnrichmentInput } from '../../worker/http.js';
import type { ApiFootballIngestionLoop } from '../../worker/ingestion.js';
import {
  COACH_NO_PHOTO_RECHECK_SECONDS,
  COACH_PHOTO_USER_AGENT,
  DEFAULT_COACH_PHOTO_DOWNLOADS_PER_RUN,
  MAX_COACH_PHOTO_DOWNLOADS_PER_RUN,
  REPEATED_BODY_LIMIT,
  type CoachPhotoFetch,
  classifyCoachPhoto,
  coachNoPhotoKey,
  coachPhotoObjectKey,
  coachPhotoUrl,
} from '../coach-photos.js';
import { clampEnrichmentLimit, providerEnrichmentWorkflow } from '../provider-enrichment.js';
import { teamCoachsDigestKey } from '../provider-enrichment-units.js';
import type { ProviderEnrichmentInput, WorkflowDeps, WorkflowLogEntry } from '../types.js';

const NOW = Date.UTC(2026, 10, 15, 8, 20, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A PNG signature followed by a tag, so every coach gets a distinct body. */
const png = (tag: string): Uint8Array =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new TextEncoder().encode(tag),
  ]);

type Reply = { readonly status: number; readonly body?: Uint8Array };

class FakeStore implements MediaObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  heads = 0;
  async head(key: string): Promise<boolean> {
    this.heads += 1;
    return this.objects.has(key);
  }
  async getText(): Promise<string | null> {
    return null;
  }
  async put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: string; readonly cacheControl: string }
  ): Promise<void> {
    this.objects.set(key, { body, contentType: options.contentType });
  }
}

interface Harness {
  readonly deps: WorkflowDeps;
  readonly store: FakeStore;
  readonly state: InMemoryProviderCache;
  readonly fetched: string[];
  readonly userAgents: string[];
  readonly resolved: string[];
  readonly logs: WorkflowLogEntry[];
  readonly sleeps: number[];
}

/**
 * `mapping`: API-Football coach id to identity coach id (absent = unmapped).
 * `photos`: API-Football coach id to the image host's reply (absent = 200 with a unique PNG).
 */
const harness = (
  options: {
    readonly mapping?: Readonly<Record<string, string>>;
    readonly photos?: Readonly<Record<string, Reply>>;
    readonly enabled?: readonly string[];
    readonly withStore?: boolean;
  } = {}
): Harness => {
  const store = new FakeStore();
  const state = new InMemoryProviderCache({ clock: () => NOW });
  const fetched: string[] = [];
  const userAgents: string[] = [];
  const resolved: string[] = [];
  const logs: WorkflowLogEntry[] = [];
  const sleeps: number[] = [];
  const mapping = options.mapping ?? {};
  const identity: FootballIdentityLookupClient = {
    lookup: () => Promise.reject(new Error('not used')),
    search: () => Promise.reject(new Error('not used')),
    stats: () => Promise.reject(new Error('not used')),
    async resolve(request: ResolveRequest) {
      expect(request.entityType).toBe(EntityType.COACH);
      expect(request.provider).toBe('api-football');
      resolved.push(request.providerId);
      const entityId = mapping[request.providerId];
      return create(ResolveResponseSchema, {
        found: entityId !== undefined,
        entityId: entityId ?? '',
        entityType: EntityType.COACH,
      });
    },
  };
  const imageFetch: CoachPhotoFetch = async (url, init) => {
    fetched.push(url);
    userAgents.push(init.headers['User-Agent'] ?? '');
    const id = url.slice(url.lastIndexOf('/') + 1).replace(/\.png$/, '');
    const reply = options.photos?.[id] ?? { status: 200, body: png(`coach-${id}`) };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => {
        const body = reply.body ?? new Uint8Array();
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
      },
    };
  };
  const deps: WorkflowDeps = {
    ingestion: { cache: new InMemoryProviderCache() } as unknown as ApiFootballIngestionLoop,
    competitions: [],
    clock: () => new Date(NOW),
    logger: (entry) => logs.push(entry),
    identity,
    stateStore: state,
    enrichment: {
      enabledDatasets: options.enabled ?? ['coach-photos'],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    coachPhotos: options.withStore === false ? undefined : { store, imageFetch },
  };
  return { deps, store, state, fetched, userAgents, resolved, logs, sleeps };
};

const run = (h: Harness, input: Partial<ProviderEnrichmentInput> = {}) =>
  providerEnrichmentWorkflow(
    { dataset: 'coach-photos', mode: 'nightly', ...input } as ProviderEnrichmentInput,
    h.deps
  );

const TUCHEL = 'btl_football_coach_c516a1a63';
const CARRICK = 'btl_football_coach_c2c44591f';
const GUARDIOLA = 'btl_football_coach_c0a61a092';

describe('coach-photos keys', () => {
  it('writes the key platform reads and asks the provider image host', () => {
    expect(coachPhotoObjectKey(TUCHEL)).toBe(`media/apifootball/coach/${TUCHEL}.png`);
    expect(coachPhotoUrl('1540')).toBe('https://media.api-sports.io/football/coachs/1540.png');
  });

  it('sends a generic User-Agent with no personal contact', () => {
    expect(COACH_PHOTO_USER_AGENT).toMatch(/^BTL-coach-photo-mirror\/\d/);
    expect(COACH_PHOTO_USER_AGENT).not.toMatch(/@/);
  });
});

describe('classifyCoachPhoto', () => {
  it('accepts a PNG or JPEG body', () => {
    expect(classifyCoachPhoto(png('face')).ok).toBe(true);
    expect(classifyCoachPhoto(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])).ok).toBe(true);
  });

  it('rejects an empty or non-image body', () => {
    expect(classifyCoachPhoto(new Uint8Array())).toMatchObject({ ok: false, reason: 'empty body' });
    expect(classifyCoachPhoto(new TextEncoder().encode('<html>404</html>'))).toMatchObject({
      ok: false,
      reason: 'not a PNG or JPEG body',
    });
  });
});

describe('coach-photos limit', () => {
  it('caps image downloads, not provider calls', () => {
    expect(clampEnrichmentLimit(undefined, 'coach-photos')).toBe(
      DEFAULT_COACH_PHOTO_DOWNLOADS_PER_RUN
    );
    expect(clampEnrichmentLimit(5, 'coach-photos')).toBe(5);
    expect(clampEnrichmentLimit(1e9, 'coach-photos')).toBe(MAX_COACH_PHOTO_DOWNLOADS_PER_RUN);
  });
});

describe('coach-photos workflow', () => {
  it('is off until GAMEWIRE_ENRICHMENT_DATASETS names it', async () => {
    const h = harness({ enabled: ['team-coaches'], mapping: { '40': TUCHEL } });
    const out = await run(h, { coachIds: ['40'] });
    expect(out.status).toBe('disabled');
    expect(h.resolved).toEqual([]);
    expect(h.fetched).toEqual([]);
  });

  it('skips without a media store', async () => {
    const h = harness({ withStore: false, mapping: { '40': TUCHEL } });
    const out = await run(h, { coachIds: ['40'] });
    expect(out.status).toBe('skipped');
    expect(out.reason).toMatch(/media store/);
  });

  it('mirrors a mapped coach with no object and makes no provider JSON call', async () => {
    const h = harness({ mapping: { '40': TUCHEL } });
    const out = await run(h, { coachIds: ['40'] });
    expect(out.status).toBe('completed');
    expect(out.callsUsed).toBe(0);
    expect(out.rowsIngested).toBe(1);
    expect(h.fetched).toEqual(['https://media.api-sports.io/football/coachs/40.png']);
    expect(h.userAgents).toEqual([COACH_PHOTO_USER_AGENT]);
    const object = h.store.objects.get(coachPhotoObjectKey(TUCHEL));
    expect(object?.contentType).toBe('image/png');
    expect(object?.body).toEqual(png('coach-40'));
    expect(out.targets).toEqual([
      expect.objectContaining({ unit: `coach-${TUCHEL}`, status: 'complete' }),
    ]);
  });

  it('skips a coach whose object exists and an unmapped coach', async () => {
    const h = harness({ mapping: { '40': TUCHEL } });
    await h.store.put(coachPhotoObjectKey(TUCHEL), png('bespoke'), {
      contentType: 'image/png',
      cacheControl: '',
    });
    const out = await run(h, { coachIds: ['40', '41'] });
    expect(out.status).toBe('completed');
    expect(h.resolved).toEqual(['40', '41']);
    expect(h.fetched).toEqual([]);
    expect(h.store.objects.get(coachPhotoObjectKey(TUCHEL))?.body).toEqual(png('bespoke'));
    expect(out.reason).toMatch(/mirrored 0, present 1/);
    expect(out.reason).toMatch(/1 unmapped/);
  });

  it('reads the coach ids the team-coaches run stored for each team', async () => {
    const h = harness({ mapping: { '40': TUCHEL, '41': GUARDIOLA } });
    await h.state.set(teamCoachsDigestKey('10'), { coachIds: ['40', '99'] }, 3600);
    await h.state.set(teamCoachsDigestKey('50'), { coachIds: ['41', '40'] }, 3600);
    const out = await run(h, { teamIds: ['10', '50', '77'] });
    expect(h.resolved).toEqual(['40', '41', '99']);
    expect([...h.store.objects.keys()].sort()).toEqual(
      [coachPhotoObjectKey(GUARDIOLA), coachPhotoObjectKey(TUCHEL)].sort()
    );
    expect(out.reason).toMatch(/1 teams with no coach list yet/);
  });

  it('reports no coach ids when no team-coaches list exists yet', async () => {
    const h = harness();
    const out = await run(h, { teamIds: ['10'] });
    expect(out.status).toBe('skipped');
    expect(out.reason).toMatch(/run team-coaches first/);
  });

  it('dry run downloads and classifies but writes no object and no marker', async () => {
    const h = harness({
      mapping: { '40': TUCHEL, '41': GUARDIOLA },
      photos: { '41': { status: 200, body: new TextEncoder().encode('<svg/>') } },
    });
    const out = await run(h, { coachIds: ['40', '41'], dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.status).toBe('completed');
    expect(out.reason).toMatch(/^dry run: would mirror 1, present 0, no photo 1/);
    expect(out.targets).toEqual([
      expect.objectContaining({ unit: `coach-${TUCHEL}`, status: 'planned' }),
    ]);
    expect(h.store.objects.size).toBe(0);
    expect(await h.state.get(coachNoPhotoKey('41'))).toBeUndefined();
  });

  it('marks a placeholder and does not download it again for a week', async () => {
    const h = harness({
      mapping: { '41': GUARDIOLA },
      photos: { '41': { status: 200, body: new TextEncoder().encode('GIF89a') } },
    });
    const first = await run(h, { coachIds: ['41'] });
    expect(first.status).toBe('completed');
    expect(h.store.objects.size).toBe(0);
    expect(await h.state.get(coachNoPhotoKey('41'))).toMatchObject({ checkedAtMs: NOW });

    const second = await run(h, { coachIds: ['41'] });
    expect(h.fetched).toHaveLength(1);
    expect(second.reason).toMatch(/no photo 0 \(\+1 checked in the last 7 days\)/);

    const reset = await run(h, { coachIds: ['41'], reset: true });
    expect(h.fetched).toHaveLength(2);
    expect(reset.reason).toMatch(/no photo 1/);
    expect(COACH_NO_PHOTO_RECHECK_SECONDS).toBe((7 * DAY_MS) / 1_000);
  });

  it('a 404 is no photo, a 5xx is a failure the next run retries', async () => {
    const h = harness({
      mapping: { '40': TUCHEL, '41': GUARDIOLA },
      photos: { '40': { status: 404 }, '41': { status: 503 } },
    });
    const out = await run(h, { coachIds: ['40', '41'] });
    expect(out.status).toBe('incomplete');
    expect(out.targets).toEqual([
      expect.objectContaining({
        unit: `coach-${GUARDIOLA}`,
        status: 'failed',
        errors: ['41: http 503'],
      }),
    ]);
    expect(await h.state.get(coachNoPhotoKey('40'))).toBeDefined();
    expect(await h.state.get(coachNoPhotoKey('41'))).toBeUndefined();
  });

  it('tries a coach’s other API-Football id when the first has no photo', async () => {
    const h = harness({
      mapping: { '16246': CARRICK, '25762': CARRICK },
      photos: { '16246': { status: 200, body: new TextEncoder().encode('nope') } },
    });
    const out = await run(h, { coachIds: ['25762', '16246'] });
    expect(out.status).toBe('completed');
    expect(h.fetched.map((url) => url.split('/').pop())).toEqual(['16246.png', '25762.png']);
    expect(h.store.objects.get(coachPhotoObjectKey(CARRICK))?.body).toEqual(png('coach-25762'));
  });

  it('stops downloading at the cap and leaves the rest for the next run', async () => {
    const h = harness({ mapping: { '40': TUCHEL, '41': GUARDIOLA, '42': CARRICK } });
    const out = await run(h, { coachIds: ['40', '41', '42'], limit: 2 });
    expect(out.status).toBe('incomplete');
    expect(h.fetched).toHaveLength(2);
    expect(h.store.objects.size).toBe(2);
    expect(out.reason).toMatch(/deferred 1/);
    expect(h.sleeps).toEqual([500]);

    const next = await run(h, { coachIds: ['40', '41', '42'], limit: 2 });
    expect(next.status).toBe('completed');
    expect(h.store.objects.size).toBe(3);
  });

  it('treats one body served for many coaches as a placeholder', async () => {
    const same = png('new-placeholder');
    const ids = ['40', '41', '42', '43', '44'];
    const h = harness({
      mapping: Object.fromEntries(ids.map((id) => [id, `btl_football_coach_c${id}`])),
      photos: Object.fromEntries(ids.map((id) => [id, { status: 200, body: same }])),
    });
    const out = await run(h, { coachIds: ids });
    expect(h.store.objects.size).toBe(REPEATED_BODY_LIMIT);
    expect(out.reason).toMatch(/no photo 2/);
    expect(h.logs.some((entry) => entry.event === 'coach_photos.repeated_body')).toBe(true);
  });
});

describe('parseProviderEnrichmentInput coach-photos', () => {
  it('accepts coachIds, teamIds, limit and dryRun', () => {
    const parsed = parseProviderEnrichmentInput({
      dataset: 'coach-photos',
      mode: 'nightly',
      coachIds: ['40'],
      teamIds: ['10'],
      limit: 20,
      dryRun: true,
    });
    expect(parsed).toEqual({
      ok: true,
      input: expect.objectContaining({
        dataset: 'coach-photos',
        coachIds: ['40'],
        teamIds: ['10'],
        limit: 20,
        dryRun: true,
      }),
    });
  });

  it('rejects ids the dataset does not use', () => {
    expect(parseProviderEnrichmentInput({ dataset: 'coach-photos', playerIds: ['1'] })).toEqual({
      ok: false,
      reason: 'ids_not_used_by_dataset',
    });
  });
});
