/**
 * Bun-backed media object store + the guarded asset-mirror factory.
 *
 * This module is the ONLY place that touches Bun's built-in S3 client. The
 * mirror's algorithm (`asset-mirror.ts`) depends only on the abstract
 * {@link MediaObjectStore} boundary, so the Vitest suite (which runs under
 * Node, not Bun) never imports a `Bun` global. `server.ts` — the sole
 * Bun-runtime entry — calls {@link createAssetMirrorBridge}, which constructs
 * the Bun S3 store and the mirror together, OR returns `undefined` when the
 * shared content bucket / R2 creds are not configured (safe no-op; mirroring
 * is simply skipped).
 *
 * STORAGE: the EXISTING content R2 bucket (`R2_BUCKET_CONTENT`) — NOT a
 * separate bucket. Objects are written under the `media/provider/` prefix and
 * served by the same `cdn.breakingthelines.dev` that fronts content-service
 * uploads. R2 is S3-compatible: a custom `endpoint`, `region: 'auto'`, and
 * static credentials — the same SHARED creds content-service's Go S3 client
 * uses (`internal/adapter/storage/s3.go`).
 *
 * CACHE-CONTROL: Bun's `S3File.write` accepts a `BlobPropertyBag` (`type` /
 * `contentEncoding` / `contentDisposition`) but has no `cacheControl` field, so
 * the immutable `Cache-Control` for the `media/provider/` objects is applied by
 * the bucket/CDN cache rule (the content bucket already serves `media/` with a
 * long-lived edge cache). The {@link MediaObjectStore} boundary still carries
 * the intended `cacheControl` so the algorithm + its tests stay explicit and a
 * future SDK swap can forward it natively.
 */

import type { AssetMirrorConfig } from './config.js';
import type { FootballIdentityLookupClient } from './clients/identity.js';
import {
  createAssetMirror,
  type AssetMirrorLogger,
  type MediaObjectStore,
  type OnFixtureFetched,
} from './asset-mirror.js';

/**
 * Shape of Bun's built-in S3 client surface we use. Declared structurally so
 * this file type-checks under Node/Vitest (where `bun` types may be absent)
 * without pulling `@types/bun`. At runtime under Bun the real `S3Client`
 * satisfies it.
 */
interface BunS3File {
  exists(): Promise<boolean>;
  text(): Promise<string>;
  write(data: Uint8Array, options?: { type?: string }): Promise<number>;
}

interface BunS3ClientLike {
  file(key: string): BunS3File;
}

interface BunS3ClientCtor {
  new (options: {
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
  }): BunS3ClientLike;
}

interface BunGlobalLike {
  S3Client?: BunS3ClientCtor;
}

/**
 * Adapt a Bun `S3Client` to the abstract {@link MediaObjectStore}. The
 * content-type is forwarded via Bun's `write` `type` option. `cacheControl` is
 * accepted by the boundary (and asserted by the unit tests) but is applied by
 * the bucket/CDN cache rule for the `media/provider/` prefix — see the module
 * header — because Bun's `S3File.write` has no cache-control field.
 */
export const createBunMediaObjectStore = (client: BunS3ClientLike): MediaObjectStore => ({
  async head(key: string): Promise<boolean> {
    return client.file(key).exists();
  },
  async getText(key: string): Promise<string | null> {
    const file = client.file(key);
    if (!(await file.exists())) {
      return null;
    }
    return file.text();
  },
  async put(key, body, putOptions): Promise<void> {
    await client.file(key).write(body, { type: putOptions.contentType });
  },
});

export interface AssetMirrorBridgeDeps {
  readonly config: AssetMirrorConfig;
  readonly identity: FootballIdentityLookupClient;
  readonly providerId: string;
  readonly logger?: AssetMirrorLogger;
  /** Inject a store for tests; production resolves a Bun S3 store from `config`. */
  readonly store?: MediaObjectStore;
}

/**
 * Build the asset-mirror bridge, or return `undefined` when the mirror cannot
 * or should not run. This is the NO-CREDS / NO-BUCKET GUARD: if
 * `config.bucket` (`R2_BUCKET_CONTENT`) is empty/unset the mirror is disabled
 * end-to-end (no S3 client, no HEAD/GET/PUT, no manifest write) — a safe no-op.
 * It also returns `undefined` if the shared R2 credentials / endpoint are
 * missing, if the CDN base is missing, or if Bun's `S3Client` is unavailable
 * (e.g. not under the Bun runtime) and no store was injected.
 */
export const createAssetMirrorBridge = (
  deps: AssetMirrorBridgeDeps
): OnFixtureFetched | undefined => {
  const cfg = deps.config;

  // NO-BUCKET GUARD: the single load-bearing check. The shared content bucket
  // must be configured for the mirror to run.
  if (!cfg.bucket) {
    return undefined;
  }

  // Without a CDN base the manifest URLs are unusable; treat as not-configured.
  if (!cfg.cdnBaseUrl) {
    return undefined;
  }

  let store = deps.store;
  if (!store) {
    // NO-CREDS GUARD: the shared R2 credentials/endpoint must all be present.
    if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey) {
      return undefined;
    }
    const bunGlobal = (globalThis as { Bun?: BunGlobalLike }).Bun;
    const S3Client = bunGlobal?.S3Client;
    if (!S3Client) {
      return undefined;
    }
    const client = new S3Client({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
    });
    store = createBunMediaObjectStore(client);
  }

  return createAssetMirror({
    store,
    identity: deps.identity,
    providerId: deps.providerId,
    cdnBase: cfg.cdnBaseUrl,
    logger: deps.logger,
  });
};
