import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

import {
  createFetchFootballIdentityLookupClient,
  type FootballIdentityLookupClient,
} from './clients/identity.js';
import { withIdentityResolveCache } from './clients/identity-resolve-cache.js';
import {
  createFetchFootballGameLookupClient,
  createFetchGameServiceProfileJobsClient,
  type FootballGameBridgeClient,
  type GameServiceProfileJobsClient,
  type ProviderEnrichmentIngestClient,
} from './clients/game-service.js';
import { createAuthContextVerifier } from './auth-context.js';
import { config } from './config.js';
import { buildWorkflowDeps, handleWorkerRequest, type WorkerHttpHandlerOptions } from './http.js';
import { ApiFootballIngestionLoop, type OnFixtureFetchedCallback } from './ingestion.js';
import { RedisProviderCache, createRedisLikeClient, type ProviderCache } from './cache.js';
import {
  DEFAULT_ENRICHMENT_MINUTE_CAP,
  ProviderMinuteLimiter,
  RedisMinuteCounterStore,
  createRedisMinuteCounterClient,
  type MinuteCounterStore,
  type RedisCommandSender,
} from './minute-limiter.js';
import { createProviderBudget } from './provider-budget.js';
import { createAssetMirrorBridge, createMediaObjectStoreFromConfig } from './media-store.js';
import { createMatchConcludedBridge } from './match-concluded-bridge.js';
import {
  InMemoryMatchConcludedStreamClient,
  MATCH_CONCLUDED_STREAM_NAME,
  MatchConcludedPublisher,
  createBunMatchConcludedStreamClient,
  type BunRedisStreamPublisher,
} from './match-concluded-publisher.js';
import { RedisEmittedFixtureStore } from './redis-emitted-fixture-store.js';
import { createRedisRunStore, InMemoryRunStore, RunRegistry } from './run-registry.js';

/** How long SIGTERM waits for interrupted runs to settle before closing the server. */
const RUN_SHUTDOWN_WAIT_MS = 20_000;
import { describeEventsRedis, SOURCE_SERVICE_URL } from '@breakingthelines/protos/sdk/eventbus';
import {
  STEADY_STATE_COMPETITIONS,
  collectVerifiedFixtureIds,
  runPreMatchEnrichment,
} from '../workflows/index.js';
import {
  ENABLED_GATED_COMPETITION_KEYS,
  unknownGatedCompetitionKeys,
} from '../workflows/competitions.js';

interface ReadBodyResult {
  readonly body: unknown;
  readonly rawBody: string;
}

const readBody = async (request: IncomingMessage): Promise<ReadBodyResult> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return { body: undefined, rawBody: '' };
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return { body: undefined, rawBody: '' };
  }

  try {
    return { body: JSON.parse(raw), rawBody: raw };
  } catch {
    return { body: raw, rawBody: raw };
  }
};

const flattenHeaders = (request: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.join(', ');
    } else if (typeof value === 'string') {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
};

/**
 * Compose zero or more fire-and-forget fixture bridges into one callback for
 * the ingestion loop's single `onFixtureFetched` seam. Returns `undefined`
 * when no bridge is active (so the loop keeps its no-op default). Each bridge
 * is dispatched independently; a synchronous or async throw in one is
 * swallowed so it can neither block the other bridge nor the fetch path.
 */
const composeFixtureBridges = (
  ...bridges: readonly (OnFixtureFetchedCallback | undefined)[]
): OnFixtureFetchedCallback | undefined => {
  const active = bridges.filter(
    (bridge): bridge is OnFixtureFetchedCallback => bridge !== undefined
  );
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return async (input) => {
    await Promise.allSettled(active.map((bridge) => Promise.resolve(bridge(input))));
  };
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

let closeEventsRedis: (() => void) | undefined;
// The match-concluded publisher is constructed once and held at module
// scope so the ingestion bridge can call `.observe(fixture)` without
// re-creating the Redis client per fixture. We expose it via the
// `matchConcludedPublisher` export below. When Redis is unavailable
// the value stays undefined; callers must null-check.
//
// gamewire publishes on the fact bus and consumes nothing from it. It used
// to subscribe a `gamewire-rating` group to `btl:facts:game.rating.submitted`,
// but its GameService.RecordRating client was a stub that threw, so on a
// live bus every rating fact would have been dead-lettered. game-service
// already folds each rating into its aggregates inside RecordRating, so the
// subscription and its consumer were removed.
let matchConcludedPublisher: MatchConcludedPublisher | undefined;
if (config.redisUrl) {
  try {
    // Bun exposes a global `Bun.redis` connected to REDIS_URL (the cache
    // database). It carries the emit-once keys below. `Bun.RedisClient`
    // opens a further connection; it selects the database from the URL path.
    // `Bun.redis` is one shared connection: never give it a blocking reader
    // (see the rule at `sharedRedis` below).
    const bunGlobal = (
      globalThis as {
        Bun?: {
          redis?: BunRedisStreamPublisher;
          RedisClient?: new (url: string) => BunRedisStreamPublisher & { close(): void };
        };
      }
    ).Bun;
    const bunRedis = bunGlobal?.redis;
    if (!bunRedis) {
      console.log(
        '[gamewire-worker] GAMEWIRE_REDIS_URL set but Bun.redis is unavailable; ' +
          'match-concluded publisher NOT started'
      );
    } else {
      // The fact bus lives on the shared events database (BTL_EVENTS_REDIS_DB,
      // 0 in prod), where game-service's settle consumer reads. It always gets
      // its own connection; the cache database stays on Bun.redis.
      const eventsRedisConfig = config.eventsRedis;
      if (!eventsRedisConfig) {
        throw new Error('events redis unresolved although GAMEWIRE_REDIS_URL is set');
      }
      if (!bunGlobal?.RedisClient) {
        throw new Error('Bun.RedisClient is unavailable for the events bus');
      }
      const busLine = `[gamewire-worker] ${describeEventsRedis(eventsRedisConfig)}`;
      if (eventsRedisConfig.source === SOURCE_SERVICE_URL) {
        console.warn(busLine);
      } else {
        console.log(busLine);
      }
      const eventsRedis = new bunGlobal.RedisClient(eventsRedisConfig.url);
      closeEventsRedis = () => eventsRedis.close();

      // One fact per terminal fixture on btl:facts:game.match.concluded
      // (MAXLEN ~ 10000), written by the protos SDK's publishFact. The bridge
      // below pipes fixture-detail ingestion results into `observe()` so
      // terminal fixtures emit one fact each; event and lineup payloads use
      // the same bridge to call game-service ingest RPCs.
      //
      // The emit-once gate is backed by Redis (`SET NX EX 30d` under
      // `btl:fact:emitted:`) so a worker restart between two terminal
      // observations of the same fixture does not re-emit. Those keys stay
      // on the cache database even when the stream moves: they are this
      // worker's own state, and keeping them means a bus move never
      // re-emits the last 30 days of concluded fixtures.
      const emittedStore = new RedisEmittedFixtureStore({ client: bunRedis });
      matchConcludedPublisher = new MatchConcludedPublisher({
        stream: createBunMatchConcludedStreamClient(eventsRedis),
        emitted: emittedStore,
      });
      console.log(
        '[gamewire-worker] match-concluded publisher ready ' +
          `(stream=${MATCH_CONCLUDED_STREAM_NAME} stream-db=${eventsRedisConfig.db} emitted-store=${emittedStore.backend})`
      );
    }
  } catch (err) {
    console.log(
      `[gamewire-worker] failed to start match-concluded publisher: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
} else {
  console.log('[gamewire-worker] GAMEWIRE_REDIS_URL unset; fact bus disabled');
  matchConcludedPublisher = new MatchConcludedPublisher({
    stream: new InMemoryMatchConcludedStreamClient(),
  });
  console.log('[gamewire-worker] match-concluded publisher ready (stream=memory)');
}

/**
 * Identity-server client. Used by the API-Football bridge to resolve
 * provider teams, players, competitions, and seasons when the snapshot
 * has a match. The GAME path still resolves through game-service
 * because identity's read-only SQLite snapshot does not carry the live
 * provider fixture mapping.
 */
const identityClient: FootballIdentityLookupClient | undefined = config.identityServiceUrl
  ? createFetchFootballIdentityLookupClient({ baseUrl: config.identityServiceUrl })
  : undefined;

/**
 * The bridges resolve the same competition and teams on every live tick, so
 * they go through an LRU. Workflows keep the raw client: identity-gap-scan
 * reports current misses and must not see a cached one.
 */
const bridgeIdentityClient: FootballIdentityLookupClient | undefined = identityClient
  ? withIdentityResolveCache(identityClient)
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
const gameServiceLookupClient:
  | (FootballGameBridgeClient & ProviderEnrichmentIngestClient)
  | undefined = config.gameServiceUrl
  ? createFetchFootballGameLookupClient({ baseUrl: config.gameServiceUrl })
  : undefined;

if (!config.gameServiceUrl) {
  console.log(
    '[gamewire-worker] bridge inactive: game-service url not configured ' + '(set GAME_SERVICE_URL)'
  );
}

/**
 * game-service-profile-jobs client, used only by the provider-fixture-results
 * workflow's `IngestProviderFixtureResults` call (`profile-spec.md` §3.4:
 * served ONLY by that Deployment, never the serving pods behind
 * `gameServiceLookupClient`/`GAME_SERVICE_URL` above — PF-GW1 review
 * finding #4).
 */
const gameServiceJobsClient: GameServiceProfileJobsClient | undefined = config.gameServiceJobsUrl
  ? createFetchGameServiceProfileJobsClient({ baseUrl: config.gameServiceJobsUrl })
  : undefined;

console.log(`[gamewire-worker] game-service-profile-jobs target: ${config.gameServiceJobsUrl}`);
console.log(
  `[gamewire-worker] competitions: ${STEADY_STATE_COMPETITIONS.length}; gated on: ${
    [...ENABLED_GATED_COMPETITION_KEYS].join(',') || 'none'
  }`
);
const unknownGated = unknownGatedCompetitionKeys(ENABLED_GATED_COMPETITION_KEYS);
if (unknownGated.length > 0) {
  console.warn(
    `[gamewire-worker] GAMEWIRE_GATED_COMPETITIONS names no gated competition: ${unknownGated.join(',')}`
  );
}

/**
 * Bridge callback handed to the ingestion loop. Reads fixture-scoped provider
 * envelopes, resolves canonical entities through identity/game-service, ingests
 * games/events/lineups, and calls `publisher.observe()` for terminal fixture
 * details. No-op when the publisher, the game-service client, or the identity
 * client is unavailable.
 */
const matchConcludedBridge: OnFixtureFetchedCallback | undefined =
  matchConcludedPublisher && gameServiceLookupClient && bridgeIdentityClient
    ? createMatchConcludedBridge({
        publisher: matchConcludedPublisher,
        gameService: gameServiceLookupClient,
        identity: bridgeIdentityClient,
        providerId: config.providerId,
      })
    : undefined;

if (matchConcludedBridge) {
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

/**
 * Entity-imagery asset-mirror bridge. Stores CORS-clean copies of provider
 * crests/logos/player photos in the EXISTING content R2 bucket
 * (`R2_BUCKET_CONTENT`) under the `media/provider/` prefix as a byproduct of
 * ingestion (zero added provider JSON quota) — NO separate bucket. Returns
 * `undefined` — a safe no-op — when `R2_BUCKET_CONTENT` is unset, when the
 * shared R2 credentials / CDN base are missing, or when Bun's S3Client is
 * unavailable. Requires the identity client for provider→canonical id
 * resolution. See `docs/proposals/entity-imagery-system.md`.
 */
const assetMirrorBridge: OnFixtureFetchedCallback | undefined = bridgeIdentityClient
  ? createAssetMirrorBridge({
      config: config.assetMirror,
      identity: bridgeIdentityClient,
      providerId: config.providerId,
    })
  : undefined;

if (assetMirrorBridge) {
  console.log(
    '[gamewire-worker] asset-mirror bridge active ' +
      `(bucket=${config.assetMirror.bucket} cdn=${config.assetMirror.cdnBaseUrl} ` +
      `provider=${config.providerId})`
  );
} else {
  console.log(
    '[gamewire-worker] asset-mirror bridge inactive ' +
      `(bucket=${config.assetMirror.bucket ? 'set' : 'unset'} ` +
      `cdn=${config.assetMirror.cdnBaseUrl ? 'set' : 'unset'} ` +
      `identity=${identityClient ? 'ready' : 'missing'}) — set R2_BUCKET_CONTENT (shared content bucket) to enable`
  );
}

/**
 * Compose the two fire-and-forget bridges into the single `onFixtureFetched`
 * seam. Each bridge is invoked independently; a throw in one never blocks the
 * other (each already swallows its own errors, but the composer defends
 * against an unexpected synchronous throw too). Order is irrelevant — neither
 * back-pressures the fetch path.
 */
const onFixtureFetched: OnFixtureFetchedCallback | undefined = composeFixtureBridges(
  matchConcludedBridge,
  assetMirrorBridge
);

// Redis-backed minute buckets and workflow state. The minute and second
// buckets must be shared by every pod (a rolling deploy runs two) and by the
// enrichment limiter, and the season-backfill cursor must survive a restart:
// in process memory each deploy dropped every cursor and the next wave run
// walked its seasons again from fixture 0.
//
// Rule: `Bun.redis` is ONE connection, shared by the limiters, the workflow
// cursors and the emit-once keys. Redis answers a connection's commands in
// order, so a blocking command on it (XREADGROUP/XREAD with BLOCK, BLPOP,
// BRPOP, BLMOVE, BZPOP*, WAIT, SUBSCRIBE) stalls every other command behind
// it. A 5 s XREADGROUP BLOCK consumer here made each limiter step wait 5 s,
// and a provider-enrichment page took 50 s instead of 0.3 s (2026-11-13 to
// 2026-11-17). A blocking reader gets its own `new Bun.RedisClient(url)`.
// no-direct-stream-commands.test.ts enforces this.
const sharedRedis: RedisCommandSender | undefined = config.redisUrl
  ? (globalThis as { Bun?: { redis?: RedisCommandSender } }).Bun?.redis
  : undefined;
const minuteStore: MinuteCounterStore | undefined = sharedRedis
  ? new RedisMinuteCounterStore(createRedisMinuteCounterClient(sharedRedis))
  : undefined;
const workflowStateStore: ProviderCache | undefined = sharedRedis
  ? new RedisProviderCache({
      namespace: config.redisNamespace,
      client: createRedisLikeClient(sharedRedis),
    })
  : undefined;
console.log(
  `[gamewire-worker] workflow state store=${workflowStateStore?.backend ?? 'memory (ingestion cache)'}`
);

// Workflow runs (`/runs/*`, `/workflows/*`): run records, idempotency keys
// and scope leases. Short, non-blocking commands only, on the shared client.
const runRegistry = new RunRegistry({
  store: sharedRedis ? createRedisRunStore(sharedRedis) : new InMemoryRunStore(),
  namespace: config.redisNamespace,
  pod: process.env.HOSTNAME ?? 'gamewire-worker',
  log: (message) => console.log(`[gamewire-worker.run] ${message}`),
});
console.log(`[gamewire-worker] run registry=${sharedRedis ? 'redis' : 'memory'}`);

// The caps come from env through the factory (see provider-budget.test.ts).
// Before GW-1 they were logged but never reached the tracker.
const {
  quota,
  minuteLimiter,
  summary: budgetSummary,
  warnings: budgetWarnings,
} = createProviderBudget(config, {
  minuteStore,
  logger: (entry) => {
    console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
  },
});
console.log(budgetSummary);
for (const warning of budgetWarnings) {
  console.log(warning);
}

// GW-7/GW-8 pre-match enrichment (predictions, head-to-head, venues) runs
// after each discovery sweep. Bound below, once the workflow deps exist.
let preMatchEnrichment: (() => Promise<void>) | undefined;
const ingestion = new ApiFootballIngestionLoop({
  config,
  onFixtureFetched,
  quota,
  minuteLimiter,
  onDiscoveryComplete: () => preMatchEnrichment?.(),
});

// Provider enrichment (GW-6a). One limiter for the process so concurrent
// enrichment runs share the per-minute ceiling. Every call still passes the
// provider-wide limiter at background priority as well.
const enrichmentMinuteCap = config.enrichmentMinuteCap ?? DEFAULT_ENRICHMENT_MINUTE_CAP;
const enrichmentLimiter = new ProviderMinuteLimiter({
  providerId: `${config.providerId}:enrichment`,
  namespace: config.redisNamespace,
  store: minuteStore,
  smoothBackground: true,
  caps: {
    live: enrichmentMinuteCap,
    'near-live': enrichmentMinuteCap,
    background: enrichmentMinuteCap,
  },
});
console.log(
  `[gamewire-worker] provider enrichment datasets=${
    config.enrichmentDatasets && config.enrichmentDatasets.length > 0
      ? config.enrichmentDatasets.join(',')
      : 'none (off)'
  } minuteCap=${enrichmentMinuteCap}`
);

// Verified-rotation seed: merge operator-supplied env IDs with the
// catalogue's `verifiedFixtureIds` so staging smoke always covers the
// known-good launch-competition fixtures even when
// `GAMEWIRE_BOOTSTRAP_FIXTURE_IDS` is unset. Operator overrides take
// precedence by order (env first, catalogue second); duplicates are
// dropped by `normaliseResourceIds` inside `ingestion.start`.
const verifiedFixtureSeed = collectVerifiedFixtureIds();
const seededFixtureIds: readonly string[] = [...config.bootstrapFixtureIds, ...verifiedFixtureSeed];

let stopIngestion: (() => void) | undefined;
if (config.ingestionEnabled) {
  stopIngestion = ingestion.start({
    bootstrapFixtureIds: seededFixtureIds,
    runImmediately: config.ingestionRunImmediateTick,
  });
  console.log(
    `[gamewire-worker] ingestion loop started provider=${config.providerId} ` +
      `hardCap=${config.providerHardCap} softCap=${config.providerSoftCap} ` +
      `bootstrapFixtures=${seededFixtureIds.length} ` +
      `verifiedRotation=${verifiedFixtureSeed.length} ` +
      `runImmediateTick=${config.ingestionRunImmediateTick}`
  );
} else {
  console.log(
    `[gamewire-worker] ingestion loop disabled (providerMode=${config.providerMode}). ` +
      `verifiedRotation=${verifiedFixtureSeed.length} fixtures staged for next boot. ` +
      'Set GAMEWIRE_INGESTION_ENABLED=true to override.'
  );
}

/**
 * Module-level handle for the ingestion bridge to call
 * `matchConcludedPublisher?.observe(fixture)` once it has a normalised
 * fixture envelope. Redis-backed in production when configured; in-memory
 * otherwise so game/event/lineup ingest can still run in local/staging smoke.
 */
export { matchConcludedPublisher };

// btl-auth-context verifier. Constructed once at boot — the JWKS fetch
// happens here and the parsed key is cached on the Verifier instance for
// the lifetime of the process. There is no fallback credential: if the
// JWKS fetch fails the process exits and Dokploy's healthcheck restarts
// us, which is the right behaviour for a security-critical dependency.
const authContextVerifier = await createAuthContextVerifier(config);
console.log(
  `[gamewire-worker] btl-auth-context verifier ready ` +
    `(jwks=${config.authContextJwksUrl} issuer=${config.authContextIssuer} ` +
    `audience=${config.authContextAudience} scope=${config.authContextRequiredScope})`
);

const workerOptions: WorkerHttpHandlerOptions = {
  ingestion,
  competitions: STEADY_STATE_COMPETITIONS,
  authContextVerifier,
  gameServiceMissingPayloads: gameServiceLookupClient,
  // The squad-sweep workflow ingests standing rosters via
  // IngestFootballSquadLists and resolves provider team ids to canonical
  // btl_football_team_* ids through identity. Both clients must reach the
  // workflow deps or every team skips as `game_service_not_wired` (and an
  // unresolved canonical id leaves team_squad_rosters unfindable by
  // GetTeamSquad). gameServiceLookupClient is a FootballGameBridgeClient,
  // which is a superset of FootballGameIngestClient.
  gameService: gameServiceLookupClient,
  // PF-GW1's provider-fixture-results workflow calls
  // IngestProviderFixtureResults, which §3.4 serves only from the
  // game-service-profile-jobs Deployment — a different target from
  // gameServiceLookupClient/gameService above.
  gameServiceJobs: gameServiceJobsClient,
  // The statsbomb-backfill workflow resolves a provider fixture id to the
  // canonical BTL game id via LookupGameByFixture before ingesting
  // occurrences. Same FootballGameBridgeClient (superset of the lookup
  // client) the match-concluded bridge uses.
  gameLookup: gameServiceLookupClient,
  identity: identityClient,
  providerEnrichmentIngest: gameServiceLookupClient,
  enrichmentLimiter,
  workflowStateStore,
  runRegistry,
  // The `coach-photos` dataset writes coach headshots to the same content
  // bucket the asset mirror uses.
  coachPhotoStore: createMediaObjectStoreFromConfig(config.assetMirror),
  workflowLogger: (entry) => {
    console.log(`[gamewire-worker.workflow] ${JSON.stringify(entry)}`);
  },
};

const preMatchDeps = buildWorkflowDeps(workerOptions, config);
if (preMatchDeps) {
  preMatchEnrichment = async () => {
    await runPreMatchEnrichment({
      ...preMatchDeps,
      logger: (entry) => {
        console.log(`[gamewire-worker.workflow] ${JSON.stringify(entry)}`);
      },
    });
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const { body, rawBody } = await readBody(request);
  const workerResponse = await handleWorkerRequest(
    {
      method: request.method ?? 'GET',
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      rawBody,
      headers: flattenHeaders(request),
    },
    config,
    workerOptions
  );

  response.writeHead(workerResponse.status, workerResponse.headers);
  if (workerResponse.stream) {
    // NDJSON streaming response. Each iteration yields a single object; we
    // serialise and write it as a chunk so node:http frames it via
    // Transfer-Encoding: chunked. Each chunk resets the upstream Envoy
    // HCM stream_idle_timeout (default 5m), letting long-running workflows
    // run to completion without the mesh tearing the connection down.
    //
    // The async iterator is owned by the handler (see streamRegistryRun in
    // http.ts) and ends when the run settles, with a final `completed` line.
    // The run does not depend on this connection: a client that goes away
    // leaves it running in the registry.
    try {
      for await (const line of workerResponse.stream) {
        if (!response.writableEnded) {
          response.write(`${JSON.stringify(line)}\n`);
        }
      }
    } catch (err) {
      console.log(
        `[gamewire-worker] stream-write failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (!response.writableEnded) {
        response.end();
      }
    }
  } else {
    response.end(JSON.stringify(workerResponse.body));
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[gamewire-worker] listening on http://0.0.0.0:${config.port}`);
  console.log(`[gamewire-worker] GameService target: ${config.gameServiceUrl}`);
  console.log(`[gamewire-worker] Identity target: ${config.identityServiceUrl}`);
  console.log(`[gamewire-worker] Webhook path: ${config.webhookPath}`);
  console.log(
    `[gamewire-worker] Workflow endpoints accept btl-auth-context ` +
      `(/workflows/{daily-anchor,hourly-matchday,webhook-completed})`
  );
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`[gamewire-worker] received ${signal}; shutting down`);
  if (stopIngestion) {
    stopIngestion();
  }
  if (closeEventsRedis) {
    closeEventsRedis();
  }
  // Mark this pod's runs interrupted so pollers retry now (resuming from the
  // cursors) instead of waiting for the leases to go stale, ask each run to
  // stop at its next checkpoint, and give them up to 20 s (of the pod's 30 s
  // grace) to write their final record and release their scope lock.
  void runRegistry
    .interruptAll()
    .then(() => runRegistry.waitForLocalRuns(RUN_SHUTDOWN_WAIT_MS))
    .catch((err: unknown) => {
      console.log(
        `[gamewire-worker] run shutdown failed: ${err instanceof Error ? err.message : String(err)}`
      );
    })
    .finally(() => {
      server.close(() => process.exit(0));
    });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
