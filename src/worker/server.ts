import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

import { config } from './config.js';
import { handleWorkerRequest } from './http.js';

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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const workerResponse = handleWorkerRequest(
    {
      method: request.method ?? 'GET',
      pathname: url.pathname,
      body: await readBody(request),
    },
    config
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
