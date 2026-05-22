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
   * Shared secret used to HMAC-sign POSTs to the `/workflows/*` endpoints.
   * Set via `GAMEWIRE_WORKFLOW_SECRET`. Retained for dual-mode operation:
   * during the SP-token rollout the worker prefers a verified
   * `btl-auth-context` header but still accepts HMAC-signed requests so
   * backfill / legacy callers keep working. Once kernel-service is
   * shipping `btl-auth-context` in staging this fallback (and the field
   * itself) gets removed in a follow-up PR.
   */
  workflowSecret?: string;
  /**
   * URL of the auth-service JWKS endpoint
   * (e.g. `https://auth.staging.breakingthelines.dev/.well-known/jwks.json`).
   * Set via `GAMEWIRE_AUTH_CONTEXT_JWKS_URL`. When unset the worker runs
   * HMAC-only and the btl-auth-context verification path is dormant. When
   * set, `authContextIssuer`, `authContextAudience`, and
   * `authContextRequiredScope` MUST also be set — `loadConfig` enforces
   * this so a half-configured worker fails fast at boot.
   */
  authContextJwksUrl?: string;
  /**
   * Expected `iss` claim on inbound btl-auth-context tokens. Set via
   * `GAMEWIRE_AUTH_CONTEXT_ISSUER`. Required when `authContextJwksUrl` is set.
   */
  authContextIssuer?: string;
  /**
   * Expected `service_principal.audience` claim on inbound
   * btl-auth-context tokens (e.g. `gamewire-worker`). Set via
   * `GAMEWIRE_AUTH_CONTEXT_AUDIENCE`. Required when `authContextJwksUrl`
   * is set.
   */
  authContextAudience?: string;
  /**
   * Required scope inside `service_principal.granted_scopes` for
   * `/workflows/*` invocations (e.g. `gamewire.workflow.invoke`). Set via
   * `GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE`. Required when
   * `authContextJwksUrl` is set.
   */
  authContextRequiredScope?: string;
}

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
    workflowSecret:
      env.GAMEWIRE_WORKFLOW_SECRET === undefined || env.GAMEWIRE_WORKFLOW_SECRET.trim() === ''
        ? undefined
        : env.GAMEWIRE_WORKFLOW_SECRET.trim(),
    ...resolveAuthContextConfig(env),
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
  authContextJwksUrl?: string;
  authContextIssuer?: string;
  authContextAudience?: string;
  authContextRequiredScope?: string;
}

const resolveAuthContextConfig = (env: GamewireWorkerEnv): AuthContextConfig => {
  const jwksUrl = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_JWKS_URL);
  const issuer = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_ISSUER);
  const audience = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_AUDIENCE);
  const requiredScope = trimmedOrUndefined(env.GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE);

  if (jwksUrl === undefined) {
    // HMAC-only mode. None of the other auth-context fields take effect.
    return {};
  }

  const missing: string[] = [];
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
      `gamewire-worker auth-context misconfigured: GAMEWIRE_AUTH_CONTEXT_JWKS_URL is set but ${missing.join(
        ', '
      )} ${missing.length === 1 ? 'is' : 'are'} missing`
    );
  }

  return {
    authContextJwksUrl: jwksUrl,
    authContextIssuer: issuer,
    authContextAudience: audience,
    authContextRequiredScope: requiredScope,
  };
};

export const config = loadConfig();
