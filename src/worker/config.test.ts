import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('gamewire-worker config', () => {
  it('defaults to the local scaffold port and BTL service targets', () => {
    const config = loadConfig({});

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
    const config = loadConfig({
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
    });

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
    expect(() => loadConfig({ GAMEWIRE_WORKER_PORT: '0' })).toThrow('Invalid gamewire-worker port');
  });

  it('rejects invalid provider modes', () => {
    expect(() => loadConfig({ GAMEWIRE_PROVIDER_MODE: 'secret-live-mode' })).toThrow(
      'Invalid gamewire provider mode'
    );
  });

  it('rejects invalid immediate tick flags', () => {
    expect(() => loadConfig({ GAMEWIRE_RUN_IMMEDIATE_TICK: 'sometimes' })).toThrow(
      'Invalid gamewire ingestion immediate tick flag'
    );
  });
});
