import type { GamewireWorkerConfig } from './config.js';
import { config as defaultConfig } from './config.js';

export interface WorkerHttpRequest {
  method: string;
  pathname: string;
  body?: unknown;
}

export interface WorkerHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const jsonResponse = (status: number, body: Record<string, unknown>): WorkerHttpResponse => ({
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body,
});

export const activityNames = [
  'FetchFixtures',
  'FetchGame',
  'FetchLineup',
  'FetchOccurrences',
  'FetchStandings',
  'PollLiveGame',
] as const;

export const handleWorkerRequest = (
  request: WorkerHttpRequest,
  cfg: GamewireWorkerConfig = defaultConfig
): WorkerHttpResponse => {
  if (request.method === 'GET' && request.pathname === '/health') {
    return jsonResponse(200, {
      status: 'ok',
      service: 'gamewire-worker',
      provider: cfg.providerId,
    });
  }

  if (request.method === 'POST' && request.pathname === cfg.webhookPath) {
    return jsonResponse(202, {
      status: 'accepted',
      service: 'gamewire-worker',
      behavior: 'stubbed',
      provider: cfg.providerId,
      activities: [...activityNames],
    });
  }

  return jsonResponse(404, {
    status: 'not_found',
    service: 'gamewire-worker',
  });
};
