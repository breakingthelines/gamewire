import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

import { config } from './config.js';
import { handleWorkerRequest } from './http.js';
import { ApiFootballIngestionLoop } from './ingestion.js';

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

// The ingestion loop is constructed alongside the HTTP server. The default
// constructor uses an in-memory cache + quota store; production deployments
// inject Redis-backed implementations by setting GAMEWIRE_REDIS_URL and
// providing a thin client adapter at boot (see cache.ts / quota.ts).
//
// When config.redisUrl is set we expect a follow-up patch to install a Bun /
// ioredis client adapter and pass it into RedisProviderCache + RedisQuotaStore.
// Until then the in-memory backends keep the loop functional for staging
// validation; metrics will reset on container restart.
if (config.redisUrl) {
  console.log(
    `[gamewire-worker] GAMEWIRE_REDIS_URL set (namespace=${config.redisNamespace}); ` +
      'using in-memory cache backend until Redis adapter is wired'
  );
}
const ingestion = new ApiFootballIngestionLoop({ config });

let stopIngestion: (() => void) | undefined;
if (config.ingestionEnabled) {
  stopIngestion = ingestion.start();
  console.log(
    `[gamewire-worker] ingestion loop started provider=${config.providerId} ` +
      `hardCap=${config.providerHardCap} softCap=${config.providerSoftCap}`
  );
} else {
  console.log(
    `[gamewire-worker] ingestion loop disabled (providerMode=${config.providerMode}). ` +
      'Set GAMEWIRE_INGESTION_ENABLED=true to override.'
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const workerResponse = await handleWorkerRequest(
    {
      method: request.method ?? 'GET',
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: await readBody(request),
    },
    config,
    { ingestion }
  );

  response.writeHead(workerResponse.status, workerResponse.headers);
  response.end(JSON.stringify(workerResponse.body));
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[gamewire-worker] listening on http://0.0.0.0:${config.port}`);
  console.log(`[gamewire-worker] GameService target: ${config.gameServiceUrl}`);
  console.log(`[gamewire-worker] Identity target: ${config.identityServiceUrl}`);
  console.log(`[gamewire-worker] Webhook path: ${config.webhookPath}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`[gamewire-worker] received ${signal}; shutting down`);
  if (stopIngestion) {
    stopIngestion();
  }
  server.close(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
