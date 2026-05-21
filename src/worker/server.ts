import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

import type {
  RecordRatingRequest,
  RecordRatingResponse,
} from '@breakingthelines/protos/btl/game/v1/game_service_pb';

import {
  createFetchFootballIdentityLookupClient,
  type FootballIdentityLookupClient,
} from './clients/identity.js';
import {
  createFetchFootballGameLookupClient,
  type FootballGameLookupClient,
  type GameServiceRecordRatingClient,
} from './clients/game-service.js';
import { config } from './config.js';
import { handleWorkerRequest } from './http.js';
import { ApiFootballIngestionLoop, type OnFixtureFetchedCallback } from './ingestion.js';
import { createMatchConcludedBridge } from './match-concluded-bridge.js';
import {
  MATCH_CONCLUDED_STREAM_NAME,
  MatchConcludedPublisher,
  createBunMatchConcludedStreamClient,
} from './match-concluded-publisher.js';
import { RATING_SUBMITTED_FACT_TYPE, RatingConsumer } from './rating-consumer.js';
import { RedisEmittedFixtureStore } from './redis-emitted-fixture-store.js';
import {
  RedisStreamConsumer,
  RedisStreamConsumerMetrics,
  createBunRedisStreamClient,
  type BunRedisLike,
} from './redis-stream-consumer.js';

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

// Redis Streams consumer for PlatformFact envelopes from game-service.
// Wired only when GAMEWIRE_REDIS_URL is set; in the unset case we log a
// degraded-mode marker and skip the consumer so local dev without Redis
// stays runnable. Both the publisher (game-service) and consumer
// (gamewire-worker) treat Redis as optional infrastructure with a
// graceful no-op fallback.
//
// Until a real Connect transport for GameService.RecordRating is
// installed (follow-up task: src/worker/clients/game-service-connect.ts),
// the rating consumer is constructed with a stub client that surfaces
// the missing wiring as a clear error per-event. The bus plumbing
// itself is fully exercised and the stub records each call so an
// operator can see facts flowing through the consumer in metrics.
const recordRatingNotImplemented: GameServiceRecordRatingClient = {
  async recordRating(_request: RecordRatingRequest): Promise<RecordRatingResponse> {
    throw new Error(
      'gamewire-worker: GameService.RecordRating transport not yet wired ' +
        '(see clients/game-service.ts boundary). The Redis Streams bus is live but ' +
        'rating facts will be retried until a real Connect client is installed.'
    );
  },
};

let stopFactConsumer: (() => void) | undefined;
// The match-concluded publisher is constructed once and held at module
// scope so the ingestion bridge can call `.observe(fixture)` without
// re-creating the Redis client per fixture. We expose it via the
// `matchConcludedPublisher` export below. When Redis is unavailable
// the value stays undefined; callers must null-check.
let matchConcludedPublisher: MatchConcludedPublisher | undefined;
if (config.redisUrl) {
  try {
    // Bun exposes a global `Bun.redis` connected to BUN_REDIS_URL or the
    // url passed at import. We accept any client that exposes `.send(cmd, args)`
    // so node-redis or ioredis adapters can be slotted in later.
    const bunGlobal = (globalThis as { Bun?: { redis?: BunRedisLike } }).Bun;
    const bunRedis = bunGlobal?.redis;
    if (!bunRedis) {
      console.log(
        '[gamewire-worker] GAMEWIRE_REDIS_URL set but Bun.redis is unavailable; ' +
          'fact bus consumer NOT started'
      );
    } else {
      const ratingConsumer = new RatingConsumer({ client: recordRatingNotImplemented });
      const streamConsumer = new RedisStreamConsumer({
        client: createBunRedisStreamClient(bunRedis),
        metrics: new RedisStreamConsumerMetrics(),
      });
      streamConsumer.subscribe({
        factType: RATING_SUBMITTED_FACT_TYPE,
        group: 'gamewire-rating',
        handler: async (fact) => {
          // RatingConsumer.handle() owns its own retry + dead-letter
          // budget and never throws — every outcome (applied, duplicate,
          // ignored, dead_letter_permanent, dead_letter_exhausted) is
          // terminal for the bus layer. Always ACK so the entry doesn't
          // cycle. If a future requirement reintroduces transient errors
          // here, return `false` to leave the entry in the PEL.
          await ratingConsumer.handle(fact);
          return true;
        },
      });

      const controller = new AbortController();
      streamConsumer.run(controller.signal).catch((err: unknown) => {
        console.log(
          `[gamewire-worker] fact bus consumer crashed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
      stopFactConsumer = () => controller.abort();
      console.log(
        '[gamewire-worker] fact bus consumer started ' +
          `(consumer=${streamConsumer.consumerName} stream=btl:facts:${RATING_SUBMITTED_FACT_TYPE} group=gamewire-rating)`
      );

      // Match-concluded publisher boot. Shares the same Bun.redis client
      // as the consumer; the stream-publish boundary issues a single
      // `XADD btl:facts:game.match.concluded MAXLEN ~ 10000 * data ...
      // event_id ... fact_type ...` call per terminal fixture. The
      // bridge below pipes fixture-detail ingestion results into
      // `observe()` so terminal fixtures emit one fact each.
      //
      // The emit-once gate is backed by Redis (`SET NX EX 30d` under
      // `btl:fact:emitted:`) so a worker restart between two terminal
      // observations of the same fixture no longer re-emits. The
      // in-memory store remains the default inside the publisher
      // constructor and is used implicitly when Redis is unavailable
      // (the entire `if (bunRedis)` branch below is skipped in that
      // case, falling through to the "fact bus consumer disabled" log).
      const emittedStore = new RedisEmittedFixtureStore({ client: bunRedis });
      matchConcludedPublisher = new MatchConcludedPublisher({
        stream: createBunMatchConcludedStreamClient(bunRedis),
        emitted: emittedStore,
      });
      console.log(
        '[gamewire-worker] match-concluded publisher ready ' +
          `(stream=${MATCH_CONCLUDED_STREAM_NAME} emitted-store=${emittedStore.backend})`
      );
    }
  } catch (err) {
    console.log(
      `[gamewire-worker] failed to start fact bus consumer: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
} else {
  console.log('[gamewire-worker] GAMEWIRE_REDIS_URL unset; fact bus consumer disabled');
}

/**
 * Identity-server client. Retained for future PLAYER / TEAM crosswalk
 * paths (player metadata sync, etc.); the GAME path on the
 * match-concluded bridge no longer routes through identity-server
 * because its read-only SQLite snapshot does not carry fixture-level
 * mappings. The client is wired here so the boundary stays in scope
 * for downstream callers — do not remove it.
 */
const identityClient: FootballIdentityLookupClient | undefined = config.identityServiceUrl
  ? createFetchFootballIdentityLookupClient({ baseUrl: config.identityServiceUrl })
  : undefined;

/**
 * game-service client used by the match-concluded bridge to resolve
 * API-Football fixture ids → BTL canonical game ids via
 * `LookupGameByFixture`. The crosswalk lives in `provider_game_mappings`
 * on game-service, populated by `IngestGames`. Wired only when
 * `config.gameServiceUrl` is set (the default in every deployment);
 * the bridge itself is a no-op when either the publisher or the
 * game-service client is unavailable.
 */
const gameServiceLookupClient: FootballGameLookupClient | undefined = config.gameServiceUrl
  ? createFetchFootballGameLookupClient({ baseUrl: config.gameServiceUrl })
  : undefined;

if (!config.gameServiceUrl) {
  console.log(
    '[gamewire-worker] bridge inactive: game-service url not configured ' + '(set GAME_SERVICE_URL)'
  );
}

/**
 * Bridge callback handed to the ingestion loop. Reads the fixture detail
 * envelope, resolves the canonical game id via game-service, calls
 * `publisher.observe()`. No-op when the publisher, the game-service
 * client, or the identity client is unavailable. (Identity client is
 * carried through for downstream PLAYER / TEAM paths.)
 */
const onFixtureFetched: OnFixtureFetchedCallback | undefined =
  matchConcludedPublisher && gameServiceLookupClient && identityClient
    ? createMatchConcludedBridge({
        publisher: matchConcludedPublisher,
        gameService: gameServiceLookupClient,
        identity: identityClient,
        providerId: config.providerId,
      })
    : undefined;

if (onFixtureFetched) {
  console.log(
    '[gamewire-worker] match-concluded bridge active ' +
      `(gameService=${config.gameServiceUrl} ` +
      `identity=${config.identityServiceUrl} provider=${config.providerId})`
  );
} else if (config.redisUrl) {
  console.log(
    '[gamewire-worker] match-concluded bridge inactive ' +
      `(publisher=${matchConcludedPublisher ? 'ready' : 'missing'} ` +
      `gameService=${gameServiceLookupClient ? 'ready' : 'missing'} ` +
      `identity=${identityClient ? 'ready' : 'missing'})`
  );
}

const ingestion = new ApiFootballIngestionLoop({ config, onFixtureFetched });

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

/**
 * Module-level handle for the ingestion bridge to call
 * `matchConcludedPublisher?.observe(fixture)` once it has a normalised
 * fixture envelope. Undefined when Redis is not configured.
 */
export { matchConcludedPublisher };

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
  if (stopFactConsumer) {
    stopFactConsumer();
  }
  server.close(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
