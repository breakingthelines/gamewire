/**
 * Bridge: ingestion loop → match-concluded publisher.
 *
 * The {@link ApiFootballIngestionLoop} owns the polling cadence and the
 * cache/quota machinery. The {@link MatchConcludedPublisher} owns the
 * Redis Streams XADD and the emit-once gate. This module is the thin
 * adapter between them:
 *
 *   1. Decode an API-Football `/fixtures?id=<id>` response envelope.
 *   2. Resolve the provider fixture id → BTL canonical `game_id` via
 *      the identity-server.
 *   3. Hand the resulting envelope to `publisher.observe(fixture)`.
 *
 * The bridge NEVER throws — every failure path logs a structured event
 * and returns. Back-pressure on ingest would defeat the worker's call
 * budget guarantees, and the publisher already records non-terminal /
 * already-emitted observations as benign outcomes.
 *
 * Scope intentionally narrow:
 *   - No fixture polling here (that's the loop's `start()` path).
 *   - No status correction handling (publisher's emit-once gate stays
 *     authoritative; the consumer on game-service owns rescore).
 *   - No new transport layers (the identity-client is injected; see
 *     `clients/identity.ts` for the fetch-based default).
 */

import { create } from '@bufbuild/protobuf';

import {
  EntityType,
} from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import {
  type ResolveResponse,
  ResolveRequestSchema,
} from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import type { FootballIdentityLookupClient } from './clients/identity.js';
import type { IngestionWorkload } from './ingestion.js';
import type {
  MatchConcludedObserveOutcome,
  MatchConcludedPublisher,
  MatchFixtureObservation,
} from './match-concluded-publisher.js';

/**
 * Callback shape consumed by the ingestion loop. Fired after every
 * successful `fetchWorkload` for a fixture-detail workload that returned
 * either freshly-fetched or cached JSON.
 */
export type OnFixtureFetched = (input: {
  readonly workload: IngestionWorkload;
  readonly resourceId: string;
  readonly data: unknown;
}) => Promise<void> | void;

export interface MatchConcludedBridgeLogEntry {
  readonly event: string;
  readonly workload?: IngestionWorkload;
  readonly resourceId?: string;
  readonly providerFixtureId?: string;
  readonly providerId?: string;
  readonly providerStatus?: string;
  readonly gameId?: string;
  readonly outcome?: MatchConcludedObserveOutcome['outcome'];
  readonly message?: string;
  readonly reason?: string;
}

export type MatchConcludedBridgeLogger = (
  entry: MatchConcludedBridgeLogEntry,
) => void;

const defaultBridgeLogger: MatchConcludedBridgeLogger = (entry) => {
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
};

/**
 * Workloads whose response payload is a single-fixture envelope. The
 * bridge ignores any other workload to keep the contract obvious — a
 * lineups or fixtures-list payload has a different shape and must not
 * accidentally trigger an observation.
 */
const FIXTURE_DETAIL_WORKLOADS: ReadonlySet<IngestionWorkload> = new Set([
  'fixture-detail-preKO',
  'fixture-detail-live',
  'fixture-detail-fullTime',
]);

export const isFixtureDetailWorkload = (workload: IngestionWorkload): boolean =>
  FIXTURE_DETAIL_WORKLOADS.has(workload);

export interface MatchConcludedBridgeOptions {
  /** Publisher that owns the emit-once gate + XADD. */
  readonly publisher: MatchConcludedPublisher;
  /** Identity lookup boundary. Used to resolve fixture id → game id. */
  readonly identity: FootballIdentityLookupClient;
  /** Provider id used both for identity lookup + observation envelope. */
  readonly providerId: string;
  /** Override the bridge log sink. */
  readonly logger?: MatchConcludedBridgeLogger;
  /** Wall clock; defaulted for tests. */
  readonly clock?: () => number;
}

/**
 * Build a bridge callback. The returned function is safe to drop into
 * `IngestionLoopOptions.onFixtureFetched` and is a no-op for non-fixture
 * workloads or unparseable payloads.
 */
export const createMatchConcludedBridge = (
  options: MatchConcludedBridgeOptions,
): OnFixtureFetched => {
  const log = options.logger ?? defaultBridgeLogger;
  const clock = options.clock ?? Date.now;
  const publisher = options.publisher;
  const identity = options.identity;
  const providerId = options.providerId;

  return async ({ workload, resourceId, data }) => {
    if (!FIXTURE_DETAIL_WORKLOADS.has(workload)) {
      return;
    }

    const decoded = decodeFixtureEnvelope(data);
    if (!decoded) {
      log({
        event: 'bridge_decode_skipped',
        workload,
        resourceId,
        reason: 'malformed_response',
      });
      return;
    }

    const { providerFixtureId, providerStatus, concludedAtMs } = decoded;

    let resolveResponse: ResolveResponse;
    try {
      resolveResponse = await identity.resolve(
        create(ResolveRequestSchema, {
          entityType: EntityType.GAME,
          provider: providerId,
          providerId: providerFixtureId,
        }),
      );
    } catch (err) {
      log({
        event: 'bridge_identity_error',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!resolveResponse.found || !resolveResponse.entityId) {
      log({
        event: 'bridge_identity_miss',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
      });
      return;
    }

    const observation: MatchFixtureObservation = {
      providerFixtureId,
      gameId: resolveResponse.entityId,
      providerStatus,
      concludedAtMs: concludedAtMs ?? clock(),
      providerId,
    };

    try {
      const outcome = await publisher.observe(observation);
      log({
        event: 'bridge_observed',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
        gameId: observation.gameId,
        outcome: outcome.outcome,
      });
    } catch (err) {
      // observe() is documented as no-throw, but defend against an
      // unexpected client error so the ingestion tick is never poisoned.
      log({
        event: 'bridge_observe_failed',
        workload,
        resourceId,
        providerFixtureId,
        providerStatus,
        providerId,
        gameId: observation.gameId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
};

interface DecodedFixture {
  readonly providerFixtureId: string;
  readonly providerStatus: string;
  readonly concludedAtMs?: number;
}

/**
 * Extract the bits the publisher needs from the API-Football fixture
 * detail response. Returns `null` for any malformed shape; the bridge
 * logs and skips so a single bad payload cannot poison the ingest tick.
 *
 * Shape:
 *   { response: [ { fixture: { id, date, status: { short } }, ... } ] }
 */
export const decodeFixtureEnvelope = (data: unknown): DecodedFixture | null => {
  if (!isRecord(data)) {
    return null;
  }
  const list = (data as { response?: unknown }).response;
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  const first = list[0];
  if (!isRecord(first)) {
    return null;
  }
  const fixture = (first as { fixture?: unknown }).fixture;
  if (!isRecord(fixture)) {
    return null;
  }
  const rawId = (fixture as { id?: unknown }).id;
  if (rawId === undefined || rawId === null || rawId === '') {
    return null;
  }
  const status = (fixture as { status?: unknown }).status;
  if (!isRecord(status)) {
    return null;
  }
  const shortRaw = (status as { short?: unknown }).short;
  if (typeof shortRaw !== 'string' || shortRaw.length === 0) {
    return null;
  }
  const rawDate = (fixture as { date?: unknown }).date;
  let concludedAtMs: number | undefined;
  if (typeof rawDate === 'string' && rawDate.length > 0) {
    const parsed = Date.parse(rawDate);
    if (Number.isFinite(parsed)) {
      concludedAtMs = parsed;
    }
  }
  return {
    providerFixtureId: String(rawId),
    providerStatus: shortRaw,
    concludedAtMs,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Test-only exports. */
export const __test = {
  FIXTURE_DETAIL_WORKLOADS,
};
