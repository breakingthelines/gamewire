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
    expect(config.gameServiceJobsUrl).toBe('http://game-service-profile-jobs:9090');
    expect(config.identityServiceUrl).toBe('http://identity:9090');
    expect(config.providerId).toBe('api-football');
    expect(config.providerMode).toBe('replay');
    expect(config.providerBaseUrl).toBe('https://v3.football.api-sports.io');
    expect(config.webhookPath).toBe('/webhooks/gamewire');
    expect(config.bootstrapFixtureIds).toEqual([]);
    expect(config.ingestionRunImmediateTick).toBe(false);
    // PF-GW1 kill switch (finding #7): off unless GAMEWIRE_PROVIDER_FIXTURE_RESULTS=on.
    expect(config.providerFixtureResultsEnabled).toBe(false);
  });

  it('reads GAME_SERVICE_JOBS_URL and GAMEWIRE_PROVIDER_FIXTURE_RESULTS from env', () => {
    const config = loadConfig(
      authEnv({
        GAME_SERVICE_JOBS_URL: 'http://game-service-profile-jobs.btl-prod:9090',
        GAMEWIRE_PROVIDER_FIXTURE_RESULTS: 'on',
      })
    );

    expect(config.gameServiceJobsUrl).toBe('http://game-service-profile-jobs.btl-prod:9090');
    expect(config.providerFixtureResultsEnabled).toBe(true);
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

  describe('provider budget', () => {
    it('defaults to the Mega plan caps (spec contract 4)', () => {
      const cfg = loadConfig(authEnv());
      expect(cfg.providerHardCap).toBe(140_000);
      expect(cfg.providerSoftCap).toBe(130_000);
      expect(cfg.providerPlanCeiling).toBe(150_000);
      expect(cfg.providerBackgroundDailyCap).toBe(110_000);
      expect(cfg.providerQuotaSource).toBe('local');
      expect(cfg.providerMinuteCaps).toEqual({ live: 800, 'near-live': 650, background: 450 });
      expect(cfg.providerRequestTimeoutMs).toBe(10_000);
    });

    it('keeps the background cap at the soft cap under the current prod env', () => {
      const cfg = loadConfig(
        authEnv({ GAMEWIRE_PROVIDER_HARD_CAP: '70000', GAMEWIRE_PROVIDER_SOFT_CAP: '60000' })
      );
      // min(110k, soft cap): background stops where workflows already go
      // cached-only, and the default never exceeds the hard cap.
      expect(cfg.providerBackgroundDailyCap).toBe(60_000);
    });

    it('reads the provider request timeout from env', () => {
      expect(
        loadConfig(authEnv({ GAMEWIRE_PROVIDER_REQUEST_TIMEOUT_MS: '2500' }))
          .providerRequestTimeoutMs
      ).toBe(2_500);
    });

    it('reads the INF-1 Mega values from env', () => {
      const cfg = loadConfig(
        authEnv({
          GAMEWIRE_PROVIDER_HARD_CAP: '140000',
          GAMEWIRE_PROVIDER_SOFT_CAP: '130000',
          GAMEWIRE_PROVIDER_PLAN_CEILING: '150000',
          GAMEWIRE_PROVIDER_QUOTA_SOURCE: 'provider-header',
          GAMEWIRE_PROVIDER_MINUTE_CAP_LIVE: '800',
          GAMEWIRE_PROVIDER_MINUTE_CAP_NEARLIVE: '650',
          GAMEWIRE_PROVIDER_MINUTE_CAP_BACKGROUND: '450',
          GAMEWIRE_PROVIDER_BACKGROUND_DAILY_CAP: '110000',
        })
      );
      expect(cfg.providerHardCap).toBe(140_000);
      expect(cfg.providerSoftCap).toBe(130_000);
      expect(cfg.providerPlanCeiling).toBe(150_000);
      expect(cfg.providerQuotaSource).toBe('provider-header');
      expect(cfg.providerBackgroundDailyCap).toBe(110_000);
    });

    it('reads the staging values from env', () => {
      const cfg = loadConfig(
        authEnv({
          GAMEWIRE_PROVIDER_HARD_CAP: '5000',
          GAMEWIRE_PROVIDER_SOFT_CAP: '4000',
          GAMEWIRE_PROVIDER_MINUTE_CAP_LIVE: '60',
          GAMEWIRE_PROVIDER_MINUTE_CAP_NEARLIVE: '60',
          GAMEWIRE_PROVIDER_MINUTE_CAP_BACKGROUND: '30',
          GAMEWIRE_PROVIDER_QUOTA_SOURCE: 'local',
        })
      );
      expect(cfg.providerMinuteCaps).toEqual({ live: 60, 'near-live': 60, background: 30 });
      expect(cfg.providerBackgroundDailyCap).toBe(4_000);
    });

    it('rejects a background cap above the hard cap', () => {
      expect(() =>
        loadConfig(authEnv({ GAMEWIRE_PROVIDER_BACKGROUND_DAILY_CAP: '150000' }))
      ).toThrow(/background daily cap/);
    });

    it('rejects minute caps out of order', () => {
      expect(() =>
        loadConfig(
          authEnv({
            GAMEWIRE_PROVIDER_MINUTE_CAP_LIVE: '100',
            GAMEWIRE_PROVIDER_MINUTE_CAP_NEARLIVE: '200',
          })
        )
      ).toThrow(/ordered/);
    });

    it('keeps provider enrichment off by default at 120 a minute', () => {
      const cfg = loadConfig(authEnv());
      expect(cfg.enrichmentDatasets).toEqual([]);
      expect(cfg.enrichmentMinuteCap).toBe(120);
    });

    it('reads the enrichment allowlist and minute cap', () => {
      const cfg = loadConfig(
        authEnv({
          GAMEWIRE_ENRICHMENT_DATASETS: ' player-season-stats , ,player-season-stats',
          GAMEWIRE_ENRICHMENT_MINUTE_CAP: '60',
        })
      );
      expect(cfg.enrichmentDatasets).toEqual(['player-season-stats']);
      expect(cfg.enrichmentMinuteCap).toBe(60);
    });

    it('lowers the enrichment cap to the background minute cap (staging 30)', () => {
      const cfg = loadConfig(
        authEnv({
          GAMEWIRE_PROVIDER_MINUTE_CAP_LIVE: '60',
          GAMEWIRE_PROVIDER_MINUTE_CAP_NEARLIVE: '60',
          GAMEWIRE_PROVIDER_MINUTE_CAP_BACKGROUND: '30',
        })
      );
      expect(cfg.enrichmentMinuteCap).toBe(30);
    });

    it('rejects an invalid enrichment minute cap', () => {
      expect(() => loadConfig(authEnv({ GAMEWIRE_ENRICHMENT_MINUTE_CAP: '0' }))).toThrow(
        /enrichment minute cap/
      );
    });

    it('rejects an unknown quota source', () => {
      expect(() => loadConfig(authEnv({ GAMEWIRE_PROVIDER_QUOTA_SOURCE: 'remote' }))).toThrow(
        /quota source/
      );
    });
  });
});
