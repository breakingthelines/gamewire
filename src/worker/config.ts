export type GamewireWorkerLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface GamewireWorkerConfig {
  port: number;
  gameServiceUrl: string;
  identityServiceUrl: string;
  providerId: string;
  providerKind: string;
  identityProviderId: string;
  webhookPath: string;
  logLevel: GamewireWorkerLogLevel;
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

export const loadConfig = (env: GamewireWorkerEnv = process.env): GamewireWorkerConfig => ({
  port: parsePort(env.GAMEWIRE_WORKER_PORT ?? env.PORT, 8095),
  gameServiceUrl: env.GAME_SERVICE_URL ?? 'http://game-service:9090',
  identityServiceUrl: env.IDENTITY_SERVICE_URL ?? 'http://identity:9090',
  providerId: env.GAMEWIRE_PROVIDER_ID ?? 'identity-data-football',
  providerKind: env.GAMEWIRE_PROVIDER_KIND ?? 'football',
  identityProviderId: env.IDENTITY_PROVIDER_ID ?? 'identity-data-football',
  webhookPath: env.GAMEWIRE_WEBHOOK_PATH ?? '/webhooks/gamewire',
  logLevel: parseLogLevel(env.LOG_LEVEL),
});

export const config = loadConfig();
