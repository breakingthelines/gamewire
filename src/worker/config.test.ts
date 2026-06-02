import { describe, expect, it } from 'vitest';

import { DEFAULT_MEDIA_CDN_BASE_URL, loadConfig } from './config.js';

const authEnv = (overrides: Record<string, string | undefined> = {}) => ({
  GAMEWIRE_AUTH_CONTEXT_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
  GAMEWIRE_AUTH_CONTEXT_ISSUER: 'auth-service',
  GAMEWIRE_AUTH_CONTEXT_AUDIENCE: 'gamewire-worker',
  GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE: 'gamewire.workflow.invoke',
  ...overrides,
});

describe('gamewire-worker config', () => {
  it('defaults to the local scaffold port and BTL service targets', () => {
    const config = loadConfig(authEnv());

    expect(config.port).toBe(8095);
    expect(config.gameServiceUrl).toBe('http://game-service:9090');
    expect(config.identityServiceUrl).toBe('http://identity:9090');
    expect(config.providerId).toBe('api-football');
    expect(config.providerMode).toBe('replay');
    expect(config.providerBaseUrl).toBe('https://v3.football.api-sports.io');
    expect(config.webhookPath).toBe('/webhooks/gamewire');
    expect(config.bootstrapFixtureIds).toEqual([]);
    expect(config.ingestionRunImmediateTick).toBe(false);
  });

  it('allows explicit runtime overrides without secrets', () => {
    const config = loadConfig(
      authEnv({
        GAMEWIRE_WORKER_PORT: '9100',
        GAME_SERVICE_URL: 'http://localhost:19090',
        IDENTITY_SERVICE_URL: 'http://localhost:19091',
        GAMEWIRE_PROVIDER_ID: 'fixture-provider',
        GAMEWIRE_PROVIDER_KIND: 'fixture',
        GAMEWIRE_PROVIDER_MODE: 'live',
        GAMEWIRE_PROVIDER_BASE_URL: 'https://provider.example.test',
        API_FOOTBALL_KEY: 'test-provider-key',
        IDENTITY_PROVIDER_ID: 'identity-data-football',
        GAMEWIRE_WEBHOOK_PATH: '/provider/webhook',
        GAMEWIRE_BOOTSTRAP_FIXTURE_IDS: '1917,  1035065,1917',
        GAMEWIRE_INGESTION_RUN_IMMEDIATE_TICK: 'true',
        LOG_LEVEL: 'debug',
      })
    );

    expect(config).toMatchObject({
      port: 9100,
      gameServiceUrl: 'http://localhost:19090',
      identityServiceUrl: 'http://localhost:19091',
      providerId: 'fixture-provider',
      providerKind: 'fixture',
      providerMode: 'live',
      providerBaseUrl: 'https://provider.example.test',
      providerApiKey: 'test-provider-key',
      identityProviderId: 'identity-data-football',
      webhookPath: '/provider/webhook',
      logLevel: 'debug',
      bootstrapFixtureIds: ['1917', '1035065'],
      ingestionRunImmediateTick: true,
    });
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig(authEnv({ GAMEWIRE_WORKER_PORT: '0' }))).toThrow(
      'Invalid gamewire-worker port'
    );
  });

  it('rejects invalid provider modes', () => {
    expect(() => loadConfig(authEnv({ GAMEWIRE_PROVIDER_MODE: 'secret-live-mode' }))).toThrow(
      'Invalid gamewire provider mode'
    );
  });

  it('rejects invalid immediate tick flags', () => {
    expect(() => loadConfig(authEnv({ GAMEWIRE_RUN_IMMEDIATE_TICK: 'sometimes' }))).toThrow(
      'Invalid gamewire ingestion immediate tick flag'
    );
  });

  it('loads the full btl-auth-context config when all four env vars are set', () => {
    const cfg = loadConfig(authEnv());
    expect(cfg.authContextJwksUrl).toBe('https://auth.test/.well-known/jwks.json');
    expect(cfg.authContextIssuer).toBe('auth-service');
    expect(cfg.authContextAudience).toBe('gamewire-worker');
    expect(cfg.authContextRequiredScope).toBe('gamewire.workflow.invoke');
  });

  it('refuses to start when GAMEWIRE_AUTH_CONTEXT_JWKS_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/GAMEWIRE_AUTH_CONTEXT_JWKS_URL.*required/);
  });

  it('refuses to start when any of the four auth-context env vars are missing', () => {
    expect(() =>
      loadConfig({
        GAMEWIRE_AUTH_CONTEXT_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
        GAMEWIRE_AUTH_CONTEXT_ISSUER: 'auth-service',
      })
    ).toThrow(
      /auth-context misconfigured.*GAMEWIRE_AUTH_CONTEXT_AUDIENCE.*GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE/
    );
  });

  describe('asset-mirror config (shared content bucket, no separate media bucket)', () => {
    it('leaves the bucket unset (mirror no-op) when R2_BUCKET_CONTENT is absent', () => {
      const cfg = loadConfig(authEnv());
      // No-creds / no-bucket guard at the config layer: bucket undefined ⇒ the
      // mirror factory returns a safe no-op.
      expect(cfg.assetMirror.bucket).toBeUndefined();
      // CDN base still defaults so the value is meaningful once a bucket lands.
      expect(cfg.assetMirror.cdnBaseUrl).toBe(DEFAULT_MEDIA_CDN_BASE_URL);
      expect(cfg.assetMirror.region).toBe('auto');
      // Crucially, there is NO R2_BUCKET_MEDIA: even if set, it is ignored.
      const withMediaOnly = loadConfig(authEnv({ R2_BUCKET_MEDIA: 'btl-media' }));
      expect(withMediaOnly.assetMirror.bucket).toBeUndefined();
    });

    it('reuses the SHARED R2 env (R2_BUCKET_CONTENT + R2_* creds) for the mirror', () => {
      const cfg = loadConfig(
        authEnv({
          R2_BUCKET_CONTENT: 'btl-content',
          R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
          R2_ACCESS_KEY_ID: 'AKIA',
          R2_SECRET_ACCESS_KEY: 'secret',
        })
      );
      expect(cfg.assetMirror).toMatchObject({
        bucket: 'btl-content',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        region: 'auto',
      });
    });

    it('defaults the CDN base to cdn.breakingthelines.dev/media and strips a trailing slash', () => {
      expect(DEFAULT_MEDIA_CDN_BASE_URL).toBe('https://cdn.breakingthelines.dev/media');
      const def = loadConfig(authEnv());
      expect(def.assetMirror.cdnBaseUrl).toBe('https://cdn.breakingthelines.dev/media');

      const overridden = loadConfig(
        authEnv({ R2_MEDIA_CDN_BASE_URL: 'https://cdn.breakingthelines.dev/media/' })
      );
      expect(overridden.assetMirror.cdnBaseUrl).toBe('https://cdn.breakingthelines.dev/media');

      // Falls back to content-service's CDN base var when the media-specific one is absent.
      const fromContent = loadConfig(
        authEnv({ CONTENT_STORAGE_CDN_BASE_URL: 'https://cdn.example.dev/media' })
      );
      expect(fromContent.assetMirror.cdnBaseUrl).toBe('https://cdn.example.dev/media');
    });
  });
});
