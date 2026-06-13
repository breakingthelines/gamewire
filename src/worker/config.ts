export type GamewireWorkerLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type GamewireProviderMode = 'replay' | 'live';

export interface GamewireWorkerConfig {
  port: number;
  gameServiceUrl: string;
  identityServiceUrl: string;
  providerId: string;
  providerKind: string;
  providerMode: GamewireProviderMode;
  providerBaseUrl?: string;
  providerApiKey?: string;
  identityProviderId: string;
  webhookPath: string;
  logLevel: GamewireWorkerLogLevel;
  /** Redis connection URL for the shared provider cache + quota counter. */
  redisUrl?: string;
  /** Redis key prefix used by gamewire-worker (defaults to "gamewire"). */
  redisNamespace: string;
  /** Hard daily provider call cap. Default 70,000 (5k headroom under 75k plan ceiling). */
  providerHardCap: number;
  /** Soft daily cap that flips the worker into cached-only mode. Default 60,000. */
  providerSoftCap: number;
  /** Enable the polling ingestion loop. Default true in live mode, false in replay. */
  ingestionEnabled: boolean;
  /** Fixture ids to poll immediately on boot, useful for deterministic staging smoke. */
  bootstrapFixtureIds: readonly string[];
  /** Run one polling tick at boot instead of waiting for the first interval. */
  ingestionRunImmediateTick: boolean;
  /**
   * URL of the auth-service JWKS endpoint
   * (e.g. `https://auth.staging.breakingthelines.dev/.well-known/jwks.json`).
   * Set via `GAMEWIRE_AUTH_CONTEXT_JWKS_URL`. Required: the worker
   * refuses to boot without it, because `/workflows/*` endpoints have no
   * other accepted credential.
   */
  authContextJwksUrl: string;
  /**
   * Expected `iss` claim on inbound btl-auth-context tokens. Set via
   * `GAMEWIRE_AUTH_CONTEXT_ISSUER`.
   */
  authContextIssuer: string;
  /**
   * Expected `service_principal.audience` claim on inbound
   * btl-auth-context tokens (e.g. `gamewire-worker`). Set via
   * `GAMEWIRE_AUTH_CONTEXT_AUDIENCE`.
   */
  authContextAudience: string;
  /**
   * Required scope inside `service_principal.granted_scopes` for
   * `/workflows/*` invocations (e.g. `gamewire.workflow.invoke`). Set via
   * `GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE`.
   */
  authContextRequiredScope: string;
  /**
   * Allow-list of trusted service-mesh caller identities permitted to invoke
   * `/workflows/*` WITHOUT a btl-auth-context JWT. Each entry is a full
   * Linkerd identity, e.g.
   * `kernel-service.btl-prod.serviceaccount.identity.linkerd.cluster.local`,
   * matched against the `l5d-client-id` header the inbound Linkerd proxy
   * stamps from the peer's mTLS identity (and strips if client-supplied, so
   * it cannot be forged in-mesh). Set via
   * `GAMEWIRE_AUTH_CONTEXT_TRUSTED_MESH_IDENTITIES` (comma-separated).
   *
   * Empty by default. On meshes that stamp btl-auth-context at the inbound
   * (Consul/Envoy ext_authz, staging) this stays unset and the JWT is the
   * only accepted credential. It exists for Linkerd meshes (prod), where no
   * ext_authz mints the header, so the kernel's plain POST is authorised by
   * its verified mesh identity instead.
   *
   * Optional: absent ⇒ no mesh identities are trusted (the staging default),
   * so the JWT stays the only credential. The loader always populates it (to
   * `[]` when unset), but the field is optional so configs constructed by hand
   * (tests, embedders) need not specify it.
   */
  authContextTrustedMeshIdentities?: readonly string[];
  /**
   * Entity-imagery asset mirror config. The mirror stores CORS-clean copies
   * of provider entity images (crests/logos/player photos) in the EXISTING
   * content R2 bucket — under a `media/provider/` prefix — as a byproduct of
   * ingestion, so the app stops hotlinking and re-hitting the provider for
   * images. There is NO separate media bucket: the objects are served by the
   * same `cdn.breakingthelines.dev` that fronts content-service uploads.
   * See `docs/proposals/entity-imagery-system.md`.
   *
   * The mirror is a SAFE NO-OP unless `bucket` (`R2_BUCKET_CONTENT`) is set —
   * if the shared R2 creds/bucket are unset the worker simply skips mirroring.
   * The S3-compatible credentials/endpoint are the SHARED R2 creds, the same
   * account content-service's R2 client uses.
   */
  readonly assetMirror: AssetMirrorConfig;
}

/**
 * Resolved entity-imagery asset-mirror configuration. Every value comes from
 * the SHARED R2 env that content-service already uses — `R2_ENDPOINT`,
 * `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and the existing content bucket
 * `R2_BUCKET_CONTENT`. There is intentionally NO `R2_BUCKET_MEDIA`: the mirror
 * writes into the content bucket under the `media/provider/` prefix.
 *
 * `bucket` is the load-bearing guard: when it is `undefined` the mirror is
 * disabled end-to-end (no S3 client constructed, no HEAD/GET/PUT, no manifest
 * write). Every other field is only meaningful when `bucket` is set.
 */
export interface AssetMirrorConfig {
  /** `R2_BUCKET_CONTENT` — the EXISTING content bucket. Undefined ⇒ mirror disabled. */
  readonly bucket?: string;
  /**
   * Public CDN base the platform's resolver reads back from, INCLUDING the
   * `/media` segment, e.g. `https://cdn.breakingthelines.dev/media` (no
   * trailing slash). Stamped into the coverage manifest's `cdnBase` so the
   * design-system resolver builds `${cdnBase}/<layer>/<type>/<id>.<ext>` =
   * `cdn.breakingthelines.dev/media/provider/<type>/<id>.<ext>`, which maps to
   * the bucket key `media/provider/<type>/<id>.<ext>` this mirror writes.
   * Sourced from `R2_MEDIA_CDN_BASE_URL` (or `CONTENT_STORAGE_CDN_BASE_URL`);
   * defaults to `https://cdn.breakingthelines.dev/media`.
   */
  readonly cdnBaseUrl?: string;
  /** `R2_ENDPOINT` — shared S3-compatible endpoint (Cloudflare R2 account URL). */
  readonly endpoint?: string;
  /** `R2_ACCESS_KEY_ID` — shared R2 access key id. */
  readonly accessKeyId?: string;
  /** `R2_SECRET_ACCESS_KEY` — shared R2 secret access key. */
  readonly secretAccessKey?: string;
  /** S3 region; R2 always uses `auto`. */
  readonly region: string;
}

/**
 * Default public CDN base the platform reads entity imagery from. Includes the
 * `/media` segment because the objects live under the `media/` prefix in the
 * shared content bucket (the same prefix content-service uploads use), and
 * `cdn.breakingthelines.dev` fronts the bucket root.
 */
export const DEFAULT_MEDIA_CDN_BASE_URL = 'https://cdn.breakingthelines.dev/media';

export type GamewireWorkerEnv = Record<string, string | undefined>;

const parsePort = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid gamewire-worker port: ${value}`);
  }

  return port;
};

const parseLogLevel = (value: string | undefined): GamewireWorkerLogLevel => {
  switch (value) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return value;
    case undefined:
    case '':
      return 'info';
    default:
      throw new Error(`Invalid gamewire-worker log level: ${value}`);
  }
};

const parseProviderMode = (value: string | undefined): GamewireProviderMode => {
  switch (value) {
    case 'live':
    case 'replay':
      return value;
    case undefined:
    case '':
      return 'replay';
    default:
      throw new Error(`Invalid gamewire provider mode: ${value}`);
  }
};

const resolveProviderApiKey = (env: GamewireWorkerEnv): string | undefined =>
  env.API_FOOTBALL_KEY ?? env.APISPORTS_KEY ?? env.API_SPORTS_KEY ?? env.GAMEWIRE_PROVIDER_API_KEY;

const parsePositiveInt = (value: string | undefined, fallback: number, label: string): number => {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
};

const parseBoolean = (value: string | undefined, fallback: boolean, label: string): boolean => {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalised = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalised)) {
    return false;
  }
  throw new Error(`Invalid ${label}: ${value}`);
};

const parseStringList = (value: string | undefined): readonly string[] => {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '') {
      seen.add(trimmed);
    }
  }
  return [...seen];
};

export const loadConfig = (env: GamewireWorkerEnv = process.env): GamewireWorkerConfig => {
  const providerMode = parseProviderMode(env.GAMEWIRE_PROVIDER_MODE);
  const hardCap = parsePositiveInt(
    env.GAMEWIRE_PROVIDER_HARD_CAP,
    70_000,
    'gamewire provider hard cap'
  );
  const softCap = parsePositiveInt(
    env.GAMEWIRE_PROVIDER_SOFT_CAP,
    60_000,
    'gamewire provider soft cap'
  );
  if (softCap > hardCap) {
    throw new Error(
      `gamewire provider soft cap (${softCap}) must not exceed hard cap (${hardCap})`
    );
  }
  return {
    port: parsePort(env.GAMEWIRE_WORKER_PORT ?? env.PORT, 8095),
    gameServiceUrl: env.GAME_SERVICE_URL ?? 'http://game-service:9090',
    identityServiceUrl: env.IDENTITY_SERVICE_URL ?? 'http://identity:9090',
    providerId: env.GAMEWIRE_PROVIDER_ID ?? 'api-football',
    providerKind: env.GAMEWIRE_PROVIDER_KIND ?? 'football',
    providerMode,
    providerBaseUrl: env.GAMEWIRE_PROVIDER_BASE_URL ?? 'https://v3.football.api-sports.io',
    providerApiKey: resolveProviderApiKey(env),
    identityProviderId: env.IDENTITY_PROVIDER_ID ?? 'identity-data-football',
    webhookPath: env.GAMEWIRE_WEBHOOK_PATH ?? '/webhooks/gamewire',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    redisUrl: env.GAMEWIRE_REDIS_URL ?? env.REDIS_URL,
    redisNamespace: env.GAMEWIRE_REDIS_NAMESPACE ?? 'gamewire',
    providerHardCap: hardCap,
    providerSoftCap: softCap,
    ingestionEnabled: parseBoolean(
      env.GAMEWIRE_INGESTION_ENABLED,
      providerMode === 'live',
      'gamewire ingestion enabled flag'
    ),
    bootstrapFixtureIds: parseStringList(env.GAMEWIRE_BOOTSTRAP_FIXTURE_IDS),
    ingestionRunImmediateTick: parseBoolean(
      env.GAMEWIRE_INGESTION_RUN_IMMEDIATE_TICK ?? env.GAMEWIRE_RUN_IMMEDIATE_TICK,
      providerMode === 'live',
      'gamewire ingestion immediate tick flag'
    ),
    assetMirror: resolveAssetMirrorConfig(env),
    ...resolveAuthContextConfig(env),
  };
};

/**
 * Resolve entity-imagery asset-mirror config from the SHARED R2 env. The mirror
 * reuses content-service's R2 account credentials/endpoint AND its content
 * bucket (`R2_BUCKET_CONTENT`) — writing under the `media/provider/` prefix, NOT
 * a separate bucket. `bucket` is intentionally optional: when unset the mirror
 * is a safe no-op (skip mirroring). The CDN base (which the resolver reads back
 * from) defaults to `https://cdn.breakingthelines.dev/media` and has its
 * trailing slash stripped to match the resolver's `cdnBase.replace(/\/+$/, '')`
 * contract so keys join cleanly.
 */
const resolveAssetMirrorConfig = (env: GamewireWorkerEnv): AssetMirrorConfig => {
  const cdnBaseUrl =
    trimmedOrUndefined(env.R2_MEDIA_CDN_BASE_URL) ??
    trimmedOrUndefined(env.CONTENT_STORAGE_CDN_BASE_URL) ??
    DEFAULT_MEDIA_CDN_BASE_URL;
  return {
    bucket: trimmedOrUndefined(env.R2_BUCKET_CONTENT),
    cdnBaseUrl: cdnBaseUrl.replace(/\/+$/, ''),
    endpoint: trimmedOrUndefined(env.R2_ENDPOINT),
    accessKeyId: trimmedOrUndefined(env.R2_ACCESS_KEY_ID),
    secretAccessKey: trimmedOrUndefined(env.R2_SECRET_ACCESS_KEY),
    region: trimmedOrUndefined(env.R2_REGION) ?? 'auto',
  };
};

const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

interface AuthContextConfig {
  authContextJwksUrl: string;
  authContextIssuer: string;
  authContextAudience: string;
  authContextRequiredScope: string;
  authContextTrustedMeshIdentities: readonly string[];
}

const resolveAuthContextConfig = (env: GamewireWorkerEnv): AuthContextConfig => {
  const jwksUrl = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_JWKS_URL);
  const issuer = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_ISSUER);
  const audience = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_AUDIENCE);
  const requiredScope = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE);

  const missing: string[] = [];
  if (jwksUrl === undefined) {
    missing.push('GAMEWIRE_AUTH_CONTEXT_JWKS_URL');
  }
  if (issuer === undefined) {
    missing.push('GAMEWIRE_AUTH_CONTEXT_ISSUER');
  }
  if (audience === undefined) {
    missing.push('GAMEWIRE_AUTH_CONTEXT_AUDIENCE');
  }
  if (requiredScope === undefined) {
    missing.push('GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE');
  }
  if (missing.length > 0) {
    throw new Error(
      `gamewire-worker auth-context misconfigured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } required`
    );
  }

  return {
    authContextJwksUrl: jwksUrl as string,
    authContextIssuer: issuer as string,
    authContextAudience: audience as string,
    authContextRequiredScope: requiredScope as string,
    // Optional: unset on Envoy/Consul meshes (staging) where the inbound
    // stamps btl-auth-context; set on Linkerd (prod) to authorise the
    // kernel's plain POST by its verified mesh identity.
    authContextTrustedMeshIdentities: parseStringList(
      env.GAMEWIRE_AUTH_CONTEXT_TRUSTED_MESH_IDENTITIES
    ),
  };
};

export const config = loadConfig();
