/**
 * Bridge: ingestion loop → entity-imagery asset mirror.
 *
 * As a byproduct of the existing data ingestion, this module fetches each
 * provider entity image (team/competition logo, player photo) ONCE and stores
 * a CORS-clean copy in the EXISTING content R2 bucket (`R2_BUCKET_CONTENT`)
 * under a `media/provider/` prefix — NOT a separate bucket — so the app stops
 * hotlinking `media.api-sports.io` and stops re-hitting the provider for
 * images. It adds ZERO API-Football JSON quota: the image URLs are already
 * present in the payloads the ingestion loop fetches, and the image GET hits
 * the provider's image CDN (not the rate-limited JSON API).
 *
 * Contract (PRODUCER side — the design-system resolver is the CONSUMER):
 *   - Storage key:  `media/provider/<type>/<entityId>.<ext>`.
 *     The trailing `provider/<type>/<entityId>.<ext>` segment is byte-for-byte
 *     `entityImageKey('provider', type, entityId, ext)` from
 *     `@breakingthelines/design-system` 0.8.0 (`src/lib/entity-image.ts`); the
 *     leading `media/` is the content bucket's existing media prefix (the same
 *     prefix content-service uploads use — see `internal/adapter/storage/s3.go`).
 *     The platform reads it back via that resolver with
 *     `cdnBase=https://cdn.breakingthelines.dev/media`, building
 *     `${cdnBase}/provider/<type>/<id>.<ext>` =
 *     `cdn.breakingthelines.dev/media/provider/<type>/<id>.<ext>`, which maps to
 *     this exact bucket key.
 *   - `<type>` ∈ crest | competition | player | manager | stadium — IDENTICAL to
 *     the design-system `EntityImageType` union — mapped from the identity
 *     `EntityType` (TEAM→crest, COMPETITION→competition, PLAYER→player,
 *     COACH→manager, VENUE→stadium).
 *   - `<entityId>` is the canonical BTL identity id (e.g. `btl_football_team_42`),
 *     resolved from the provider id via the identity client — NOT a provider id.
 *   - Coverage manifest at `media/manifest/entity-imagery.json` records, per
 *     entity, which layers exist + the stored extension; shape matches
 *     `EntityImageManifest` in the design-system. The mirror patches the
 *     `provider` layer; the `btl` layer is owned by the designer tool.
 *
 * Behaviour:
 *   - Idempotent: HEAD the target key; skip the image GET + PUT if present.
 *   - One image GET per new entity, then never again (HEAD-gated).
 *   - Fire-and-forget: every failure path is caught + logged and returns. The
 *     mirror runs on the ingestion loop's `onFixtureFetched` seam (like the
 *     match-concluded bridge) and must NEVER back-pressure the fetch path.
 *   - Safe no-op when the content bucket / R2 creds are not configured (see
 *     {@link createAssetMirrorBridge}).
 *
 * See `docs/proposals/entity-imagery-system.md` (engineering spec) and
 * `design-system/src/lib/entity-image.ts` (the consuming resolver + key fn).
 */

import { create } from '@bufbuild/protobuf';

import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  type ResolveResponse,
  ResolveRequestSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import type {
  ApiFootballPlayersResponse,
  ApiFootballSquadResponse,
  ApiFootballFixtureResponse,
} from '../adapters/api-football/index.js';
import type { FootballIdentityLookupClient } from './clients/identity.js';
import type { IngestionWorkload } from './ingestion.js';

/**
 * Entity image type token. MUST equal the design-system resolver's
 * `EntityImageType` union — it drives the `<type>` segment of the storage key
 * that the platform reads back.
 */
export type EntityImageType = 'crest' | 'competition' | 'player' | 'manager' | 'stadium';

/** The storage layer this mirror writes. The designer tool owns `'btl'`. */
export const MIRROR_LAYER = 'provider' as const;

/**
 * Prefix every mirrored object with the content bucket's existing media path.
 * The bucket is the SHARED content bucket (`R2_BUCKET_CONTENT`), not a
 * dedicated one, and `cdn.breakingthelines.dev` fronts the bucket root, so all
 * served media lives under `media/` (the same prefix content-service uses, see
 * `internal/adapter/storage/s3.go`). The platform's resolver therefore uses
 * `cdnBase=https://cdn.breakingthelines.dev/media`; the `media/` here is the
 * bucket-side counterpart of the `/media` in that cdnBase.
 */
export const MEDIA_PREFIX = 'media/' as const;

/**
 * The design-system `entityImageKey('provider', type, id, ext)` suffix —
 * `provider/<type>/<id>.<ext>` — WITHOUT the bucket's `media/` prefix. This is
 * exactly what the resolver appends to its `/media` cdnBase. Kept separate from
 * {@link mirrorObjectKey} so the producer/consumer contract is explicit: the
 * resolver owns this suffix; the mirror owns the `media/` prefix on the bucket
 * side.
 */
export const entityImageKeySuffix = (
  type: EntityImageType,
  entityId: string,
  ext: string
): string => `${MIRROR_LAYER}/${type}/${entityId}.${ext}`;

/**
 * Manifest object key inside the content bucket. Lives under `media/` so the
 * platform can fetch it from the same CDN at
 * `cdn.breakingthelines.dev/media/manifest/entity-imagery.json`.
 */
export const ENTITY_IMAGERY_MANIFEST_KEY = `${MEDIA_PREFIX}manifest/entity-imagery.json`;

const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Map an identity `EntityType` to the design-system `<type>` token. Only the
 * types that carry imagery are mapped; anything else returns `null` and the
 * mirror skips it. SEASON has no imagery; GAME/OFFICIAL are not entities with
 * a portrait.
 */
export const entityImageTypeFor = (entityType: EntityType): EntityImageType | null => {
  switch (entityType) {
    case EntityType.TEAM:
      return 'crest';
    case EntityType.COMPETITION:
      return 'competition';
    case EntityType.PLAYER:
      return 'player';
    case EntityType.COACH:
      return 'manager';
    case EntityType.VENUE:
      return 'stadium';
    default:
      return null;
  }
};

/**
 * Build the BUCKET key for a mirrored provider asset:
 * `media/provider/<type>/<entityId>.<ext>`. The `provider/<type>/<id>.<ext>`
 * suffix is byte-for-byte `entityImageKey('provider', type, entityId, ext)` in
 * the design-system 0.8.0 resolver (reimplemented here so gamewire — the
 * producer — does not depend on the React package); the leading `media/` is the
 * content bucket's media prefix, matching the resolver's `/media` cdnBase. The
 * producer/consumer agreement is enforced by this comment + the unit test
 * asserting the exact string — DO NOT diverge.
 */
export const mirrorObjectKey = (type: EntityImageType, entityId: string, ext: string): string =>
  `${MEDIA_PREFIX}${entityImageKeySuffix(type, entityId, ext)}`;

/**
 * Coverage manifest entry. Matches `EntityImageManifestEntry` in the
 * design-system: the type plus the stored extension of each present layer.
 */
export interface EntityImageManifestEntry {
  readonly type: EntityImageType;
  readonly btl?: string;
  readonly provider?: string;
}

/** Coverage manifest. Matches `EntityImageManifest` in the design-system. */
export interface EntityImageManifest {
  readonly version: string;
  readonly cdnBase: string;
  readonly entities: Record<string, EntityImageManifestEntry>;
}

/**
 * Minimal object-store boundary the mirror depends on. The production
 * implementation is backed by Bun's built-in S3 client against R2 (constructed
 * in `server.ts`, the only Bun-runtime entry); tests inject a mock. Keeping
 * the boundary here means no `Bun` global is referenced on any path Vitest
 * imports.
 */
export interface MediaObjectStore {
  /** Resolve `true` if an object exists at `key`, `false` otherwise. Must not throw for a plain 404. */
  head(key: string): Promise<boolean>;
  /** Read an object as UTF-8 text, or `null` if absent (used for the manifest read-modify-write). */
  getText(key: string): Promise<string | null>;
  /** Write bytes to `key` with the given content-type + cache-control. */
  put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: string; readonly cacheControl: string }
  ): Promise<void>;
}

/** Minimal fetch contract for the image GET. Mirrors the global `fetch` shape so tests can inject a mock. */
export type ImageFetch = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface AssetMirrorLogEntry {
  readonly event: string;
  readonly workload?: IngestionWorkload;
  readonly resourceId?: string;
  readonly providerId?: string;
  readonly providerEntityId?: string;
  readonly entityId?: string;
  readonly type?: EntityImageType;
  readonly key?: string;
  readonly ext?: string;
  readonly contentType?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly message?: string;
  readonly count?: number;
}

export type AssetMirrorLogger = (entry: AssetMirrorLogEntry) => void;

const defaultAssetMirrorLogger: AssetMirrorLogger = (entry) => {
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
};

/**
 * Callback shape consumed by the ingestion loop's `onFixtureFetched` seam.
 * Identical to the match-concluded bridge's `OnFixtureFetched`.
 */
export type OnFixtureFetched = (input: {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly data: unknown;
}) => Promise<void> | void;

export interface AssetMirrorOptions {
  /** Object store for the media bucket (HEAD/GET-text/PUT). */
  readonly store: MediaObjectStore;
  /** Identity client used to resolve provider id → canonical BTL entity id. */
  readonly identity: FootballIdentityLookupClient;
  /** Provider id for identity resolution + log context (e.g. `api-football`). */
  readonly providerId: string;
  /**
   * Public CDN base the platform reads imagery from, INCLUDING the `/media`
   * segment and with no trailing slash, e.g.
   * `https://cdn.breakingthelines.dev/media`. Stamped verbatim into the
   * manifest's `cdnBase` so the consuming resolver builds
   * `${cdnBase}/provider/<type>/<id>.<ext>` =
   * `cdn.breakingthelines.dev/media/provider/<type>/<id>.<ext>`, matching the
   * `media/provider/...` bucket keys this mirror writes.
   */
  readonly cdnBase: string;
  /** Override the image GET. Defaults to the global `fetch`. */
  readonly imageFetch?: ImageFetch;
  /** Override the log sink. */
  readonly logger?: AssetMirrorLogger;
  /** Wall clock; defaulted for tests (stamps the manifest `version`). */
  readonly clock?: () => number;
  /** Image GET timeout in ms. Default 10s. */
  readonly imageTimeoutMs?: number;
}

/**
 * Workloads whose payloads carry entity imagery and which actually flow
 * through the ingestion loop's bridge seam (`BRIDGE_WORKLOADS`). Fixture
 * detail carries team crests + the competition logo; squad lists and
 * per-fixture player stats carry team crests + player photos. Events and
 * lineups carry no logo/photo fields, so they are intentionally absent.
 */
const IMAGERY_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set([
  'fixture-detail-preKO',
  'fixture-detail-live',
  'fixture-detail-fullTime',
  'squad-list-fallback',
  'player-match-stats',
]);

/**
 * One image to consider mirroring: a provider entity, its imagery type, and
 * the provider image URL already present in the payload.
 */
interface MirrorCandidate {
  readonly entityType: EntityType;
  readonly type: EntityImageType;
  readonly providerEntityId: string;
  readonly imageUrl: string;
}

/**
 * Build the asset-mirror bridge callback. Drop the result into
 * `IngestionLoopOptions.onFixtureFetched` (composed with any other bridge).
 * The returned function is a no-op for non-imagery workloads and unparseable
 * payloads, and NEVER throws.
 */
export const createAssetMirror = (options: AssetMirrorOptions): OnFixtureFetched => {
  const store = options.store;
  const identity = options.identity;
  const providerId = options.providerId;
  const cdnBase = options.cdnBase.replace(/\/+$/, '');
  const imageFetch = options.imageFetch ?? defaultImageFetch;
  const log = options.logger ?? defaultAssetMirrorLogger;
  const clock = options.clock ?? Date.now;
  const imageTimeoutMs = options.imageTimeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;

  return async ({ workload, resourceId, data }) => {
    if (!IMAGERY_WORKLOADS.has(workload) || data === undefined) {
      return;
    }

    const candidates = collectCandidates(workload, data);
    if (candidates.length === 0) {
      return;
    }

    // De-dupe by (entityType, providerEntityId) so a payload that repeats a
    // team across multiple rows resolves + HEADs it at most once per tick.
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const dedupeKey = `${candidate.entityType}:${candidate.providerEntityId}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      await mirrorOne({
        candidate,
        workload,
        resourceId,
        store,
        identity,
        providerId,
        cdnBase,
        imageFetch,
        imageTimeoutMs,
        clock,
        log,
      });
    }
  };
};

interface MirrorOneInput {
  readonly candidate: MirrorCandidate;
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly store: MediaObjectStore;
  readonly identity: FootballIdentityLookupClient;
  readonly providerId: string;
  readonly cdnBase: string;
  readonly imageFetch: ImageFetch;
  readonly imageTimeoutMs: number;
  readonly clock: () => number;
  readonly log: AssetMirrorLogger;
}

const mirrorOne = async (input: MirrorOneInput): Promise<void> => {
  const { candidate, workload, resourceId, store, providerId, log } = input;

  // 1. Resolve provider id → canonical BTL identity id. The mirror only ever
  //    stores under canonical ids (the key the consumer reads). Identity miss
  //    or error ⇒ skip (logged); never throw.
  let entityId: string;
  try {
    const resolved: ResolveResponse = await input.identity.resolve(
      create(ResolveRequestSchema, {
        entityType: candidate.entityType,
        provider: providerId,
        providerId: candidate.providerEntityId,
      })
    );
    if (!resolved.found || !resolved.entityId) {
      log({
        event: 'asset_mirror_identity_miss',
        workload,
        resourceId,
        providerId,
        providerEntityId: candidate.providerEntityId,
        type: candidate.type,
      });
      return;
    }
    entityId = resolved.entityId;
  } catch (err) {
    log({
      event: 'asset_mirror_identity_error',
      workload,
      resourceId,
      providerId,
      providerEntityId: candidate.providerEntityId,
      type: candidate.type,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const ext = extensionFromUrl(candidate.imageUrl);
  if (!ext) {
    log({
      event: 'asset_mirror_skip_no_extension',
      workload,
      resourceId,
      entityId,
      type: candidate.type,
      reason: candidate.imageUrl,
    });
    return;
  }

  const key = mirrorObjectKey(candidate.type, entityId, ext);

  // 2. Idempotency: HEAD the target key. Present ⇒ skip (no image GET, no PUT).
  try {
    if (await store.head(key)) {
      log({
        event: 'asset_mirror_skip_present',
        workload,
        resourceId,
        entityId,
        type: candidate.type,
        key,
      });
      return;
    }
  } catch (err) {
    log({
      event: 'asset_mirror_head_error',
      workload,
      resourceId,
      entityId,
      type: candidate.type,
      key,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 3. One image GET (the URL already in the payload — NOT the JSON API, so
  //    zero provider quota). Bounded by a timeout.
  let body: Uint8Array;
  let contentType: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.imageTimeoutMs);
    let response: Awaited<ReturnType<ImageFetch>>;
    try {
      response = await input.imageFetch(candidate.imageUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      log({
        event: 'asset_mirror_fetch_failed',
        workload,
        resourceId,
        entityId,
        type: candidate.type,
        key,
        status: response.status,
        reason: candidate.imageUrl,
      });
      return;
    }
    body = new Uint8Array(await response.arrayBuffer());
    contentType = contentTypeFor(response.headers.get('content-type'), ext);
  } catch (err) {
    log({
      event: 'asset_mirror_fetch_error',
      workload,
      resourceId,
      entityId,
      type: candidate.type,
      key,
      reason: candidate.imageUrl,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 4. PUT to the media bucket with the resolved content-type + immutable cache.
  try {
    await store.put(key, body, { contentType, cacheControl: IMMUTABLE_CACHE_CONTROL });
    log({
      event: 'asset_mirror_put',
      workload,
      resourceId,
      entityId,
      type: candidate.type,
      key,
      ext,
      contentType,
    });
  } catch (err) {
    log({
      event: 'asset_mirror_put_error',
      workload,
      resourceId,
      entityId,
      type: candidate.type,
      key,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 5. Patch the manifest LAST so a failed PUT never marks coverage. Failures
  //    here are non-fatal: the object exists; a later periodic rebuild or the
  //    next mirror pass reconciles the manifest.
  await patchManifest({
    store: input.store,
    cdnBase: input.cdnBase,
    entityId,
    type: candidate.type,
    ext,
    clock: input.clock,
    log,
    workload,
    resourceId,
  });
};

interface PatchManifestInput {
  readonly store: MediaObjectStore;
  readonly cdnBase: string;
  readonly entityId: string;
  readonly type: EntityImageType;
  readonly ext: string;
  readonly clock: () => number;
  readonly log: AssetMirrorLogger;
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
}

/**
 * Read-modify-write the coverage manifest to mark the `provider` layer present
 * for `entityId` at the stored extension. Preserves any existing `btl` layer
 * (owned by the designer tool) and other entities. Idempotent: re-running with
 * the same inputs converges to the same manifest. Never throws.
 *
 * MANIFEST-AUTHORITY RESIDUAL: this is a last-write-wins read-modify-write
 * with no compare-and-swap, so two concurrent mirrors patching DIFFERENT
 * entities can clobber one another's just-added entry. See the report. The
 * spec's v1 recommendation (incremental gamewire patch, converging to a
 * periodic prefix-lister rebuild as the reconciler) makes this acceptable:
 * the objects are the source of truth and a periodic rebuild heals drift.
 */
const patchManifest = async (input: PatchManifestInput): Promise<void> => {
  const { store, entityId, type, ext, log, workload, resourceId } = input;
  try {
    const existingText = await store.getText(ENTITY_IMAGERY_MANIFEST_KEY);
    const manifest = parseManifest(existingText, input.cdnBase);

    const previous = manifest.entities[entityId];
    // No-op short-circuit: already recorded at this type + provider extension.
    if (previous && previous.type === type && previous.provider === ext) {
      return;
    }

    const nextEntry: EntityImageManifestEntry = {
      type,
      // Preserve a bespoke `btl` layer if the designer tool already recorded one.
      ...(previous?.btl ? { btl: previous.btl } : {}),
      provider: ext,
    };
    const next: EntityImageManifest = {
      version: new Date(input.clock()).toISOString(),
      cdnBase: input.cdnBase,
      entities: { ...manifest.entities, [entityId]: nextEntry },
    };

    const serialised = `${JSON.stringify(next, null, 2)}\n`;
    await store.put(ENTITY_IMAGERY_MANIFEST_KEY, encodeUtf8(serialised), {
      contentType: 'application/json',
      // The manifest is mutable; do not let edges pin a stale copy.
      cacheControl: 'public, max-age=60, must-revalidate',
    });
    log({
      event: 'asset_mirror_manifest_patched',
      workload,
      resourceId,
      entityId,
      type,
      ext,
      count: Object.keys(next.entities).length,
    });
  } catch (err) {
    log({
      event: 'asset_mirror_manifest_error',
      workload,
      resourceId,
      entityId,
      type,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Collect mirror candidates from a bridge payload. Each candidate is a
 * provider entity with imagery + the provider image URL already in the
 * payload. Malformed shapes yield no candidates (the caller no-ops).
 */
const collectCandidates = (
  workload: IngestionWorkload,
  data: unknown
): readonly MirrorCandidate[] => {
  const out: MirrorCandidate[] = [];
  const responses = responseArray(data);

  for (const item of responses) {
    if (!isRecord(item)) {
      continue;
    }

    // Fixture detail: home/away crests + the competition logo.
    if (isRecord(item.teams) && isRecord(item.league)) {
      const fixture = item as unknown as ApiFootballFixtureResponse;
      pushTeam(out, fixture.teams.home);
      pushTeam(out, fixture.teams.away);
      pushCompetition(out, fixture.league);
      continue;
    }

    // Squad list + per-fixture player stats: one team + its players.
    if (isRecord(item.team) && Array.isArray(item.players)) {
      pushTeam(out, (item as unknown as ApiFootballSquadResponse).team);
      if (workload === 'squad-list-fallback') {
        for (const player of (item as unknown as ApiFootballSquadResponse).players) {
          pushSquadPlayer(out, player);
        }
      } else {
        for (const player of (item as unknown as ApiFootballPlayersResponse).players) {
          pushStatsPlayer(out, player);
        }
      }
    }
  }

  return out;
};

const pushTeam = (
  out: MirrorCandidate[],
  team: { readonly id?: unknown; readonly logo?: unknown } | null | undefined
): void => {
  const id = providerIdString(team?.id);
  const imageUrl = urlString(team?.logo);
  if (id && imageUrl) {
    out.push({ entityType: EntityType.TEAM, type: 'crest', providerEntityId: id, imageUrl });
  }
};

const pushCompetition = (
  out: MirrorCandidate[],
  league: { readonly id?: unknown; readonly logo?: unknown } | null | undefined
): void => {
  const id = providerIdString(league?.id);
  const imageUrl = urlString(league?.logo);
  if (id && imageUrl) {
    out.push({
      entityType: EntityType.COMPETITION,
      type: 'competition',
      providerEntityId: id,
      imageUrl,
    });
  }
};

const pushSquadPlayer = (
  out: MirrorCandidate[],
  player: { readonly id?: unknown; readonly photo?: unknown } | null | undefined
): void => {
  const id = providerIdString(player?.id);
  const imageUrl = urlString(player?.photo);
  if (id && imageUrl) {
    out.push({ entityType: EntityType.PLAYER, type: 'player', providerEntityId: id, imageUrl });
  }
};

const pushStatsPlayer = (
  out: MirrorCandidate[],
  entry:
    | { readonly player?: { readonly id?: unknown; readonly photo?: unknown } | null }
    | null
    | undefined
): void => {
  pushSquadPlayer(out, entry?.player ?? undefined);
};

const responseArray = (data: unknown): readonly unknown[] => {
  if (!isRecord(data)) {
    return [];
  }
  const response = data.response;
  return Array.isArray(response) ? response : [];
};

const providerIdString = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return '';
};

const urlString = (value: unknown): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : '';

/**
 * Derive the stored file extension from the provider image URL. The provider
 * serves `.png` for crests/logos/photos today; `.svg`/`.webp`/`.jpg` are
 * handled defensively. Query strings + fragments are stripped. Unknown or
 * missing extensions return `''` (the mirror skips — we never invent one).
 */
export const extensionFromUrl = (url: string): string => {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? '';
  const lastSlash = withoutQuery.lastIndexOf('/');
  const filename = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) {
    return '';
  }
  const ext = filename.slice(dot + 1).toLowerCase();
  return KNOWN_IMAGE_EXTENSIONS.has(ext) ? ext : '';
};

const KNOWN_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'svg',
  'webp',
  'jpg',
  'jpeg',
  'gif',
  'avif',
]);

const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * Resolve the stored content-type. Prefer the provider's response header when
 * it is a concrete image type; otherwise fall back to the extension mapping.
 * A generic/absent header (e.g. `application/octet-stream`) is ignored in
 * favour of the extension so the object always advertises a real image type.
 */
const contentTypeFor = (headerValue: string | null, ext: string): string => {
  const header = (headerValue ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (header.startsWith('image/')) {
    return header;
  }
  return EXTENSION_CONTENT_TYPES[ext] ?? 'application/octet-stream';
};

const parseManifest = (text: string | null, cdnBase: string): EntityImageManifest => {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<EntityImageManifest>;
      if (parsed && typeof parsed === 'object' && isRecord(parsed.entities)) {
        return {
          version: typeof parsed.version === 'string' ? parsed.version : '',
          cdnBase: typeof parsed.cdnBase === 'string' ? parsed.cdnBase : cdnBase,
          entities: parsed.entities as Record<string, EntityImageManifestEntry>,
        };
      }
    } catch {
      // Corrupt manifest — fall through to a fresh one. The just-stored object
      // is still resolvable; a periodic rebuild heals the manifest.
    }
  }
  return { version: '', cdnBase, entities: {} };
};

const defaultImageFetch: ImageFetch = async (input, init) => {
  const response = await fetch(input, init as RequestInit | undefined);
  return response;
};

const encodeUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Test-only exports. */
export const __test = {
  IMAGERY_WORKLOADS,
  IMMUTABLE_CACHE_CONTROL,
  MEDIA_PREFIX,
  entityImageKeySuffix,
  collectCandidates,
  contentTypeFor,
  parseManifest,
};
