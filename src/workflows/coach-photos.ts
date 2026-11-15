/**
 * `coach-photos`: copy API-Football coach headshots to the CDN for coaches
 * identity maps, so a newly mapped coach gets a photo the day after the coach
 * sync lists them. It is the scheduled form of identity's one-off
 * `tools/coach-photo-mirror`, and writes the same object:
 *
 *   media.api-sports.io/football/coachs/<api-football coach id>.png
 *     -> R2 media/apifootball/coach/<btl coach id>.png
 *
 * Platform's coach avatar chain reads that key after bespoke art and the
 * Wikimedia portrait, so a missing object shows nothing and a placeholder
 * copied as a photo would show the placeholder. Hence:
 *
 * - The coach list is the provider coach ids each team's last `team-coaches`
 *   pull listed (the team digest), or `coachIds` from the request. No
 *   API-Football JSON call is made: the photo URL is fixed by the coach id,
 *   and the image host takes no API key and counts against no quota.
 * - Each id is resolved through identity. Only `btl_football_coach_*` ids are
 *   mirrored; an unmapped coach has no page.
 * - A coach whose object exists is skipped after one HEAD. A real photo is
 *   never replaced.
 * - The provider answers a coach without a photo with HTTP 200 and one of a
 *   few fixed images. Those are skipped by sha256, and the id is not asked
 *   again for {@link COACH_NO_PHOTO_RECHECK_SECONDS}. A body seen for more
 *   than {@link REPEATED_BODY_LIMIT} coaches in one run is treated as a new
 *   placeholder from then on and logged, so it can be added to the list.
 * - `limit` caps image downloads per run; downloads are sequential with
 *   {@link COACH_PHOTO_FETCH_GAP_MS} between them. A capped run ends
 *   `incomplete` and the next run carries on, since mirrored coaches are
 *   skipped by HEAD.
 * - `dryRun` resolves, HEADs, downloads and classifies, and writes nothing:
 *   no object and no no-photo marker.
 */
import { createHash } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { EntityType } from '@breakingthelines/protos/btl/identity/v1/identity_pb';
import { ResolveRequestSchema } from '@breakingthelines/protos/btl/identity/v1/identity_service_pb';

import { API_FOOTBALL_PROVIDER_ID } from '../adapters/api-football/index.js';
import type { ProviderQuotaSnapshot } from '../worker/quota.js';
import type { MediaObjectStore } from '../worker/asset-mirror.js';
import {
  resolveTeamScope,
  teamCoachsDigestKey,
  type TeamCoachsDigest,
} from './provider-enrichment-units.js';
import type {
  ProviderEnrichmentInput,
  ProviderEnrichmentOutput,
  ProviderEnrichmentTargetResult,
  WorkflowDeps,
  WorkflowLogEntry,
} from './types.js';

/** Image downloads per run by default. About 65 coaches were due on 2026-11-15. */
export const DEFAULT_COACH_PHOTO_DOWNLOADS_PER_RUN = 150;
/** Upper bound on `limit` for this dataset. */
export const MAX_COACH_PHOTO_DOWNLOADS_PER_RUN = 1_000;
/** Pause between image downloads, so a run never bursts at the image host. */
export const COACH_PHOTO_FETCH_GAP_MS = 500;
/** A provider coach id that answered a placeholder is asked again after this. */
export const COACH_NO_PHOTO_RECHECK_SECONDS = 7 * 24 * 60 * 60;
/** One body for more coaches than this in a run is a placeholder, not a face. */
export const REPEATED_BODY_LIMIT = 3;
const IMAGE_TIMEOUT_MS = 10_000;

export const COACH_PHOTO_BASE_URL = 'https://media.api-sports.io/football/coachs';
/** Sent on every image download. Generic on purpose: no personal contact. */
export const COACH_PHOTO_USER_AGENT = 'BTL-coach-photo-mirror/1.0 (+https://breakingthelines.com)';

const COACH_ENTITY_ID = /^btl_football_coach_[a-z0-9]+$/;
const PROVIDER_COACH_ID = /^[0-9]+$/;

/**
 * Bodies that mean "no photo", found by hashing every mapped coach's body on
 * 2026-11-13 (identity `tools/coach-photo-mirror`). The player silhouette is
 * listed in case the coach path ever serves it.
 */
export const COACH_PHOTO_PLACEHOLDER_SHA256: ReadonlyMap<string, string> = new Map([
  ['575e4487e3942dd820fe682e8b81f9c59b0b0d60265433ce5bd1884db4004035', 'no photo yet placeholder'],
  [
    '72f0bbb253ab54961cd5d66148e55aceb3e6bc9823da43e57a6e0812e5427430',
    'image not available placeholder',
  ],
  ['b602abdd01273f6dd29855a6aed585747243148768da4a5a54e3cebd9989fd36', 'shield placeholder'],
  ['2ff7d52a628fce5d954c58480dde4e47396db4bb405b7b7d6a6567134bf86422', 'player placeholder'],
]);

/** The CDN object platform reads for a coach's API-Football photo. */
export const coachPhotoObjectKey = (coachEntityId: string): string =>
  `media/apifootball/coach/${coachEntityId}.png`;

export const coachPhotoUrl = (providerCoachId: string): string =>
  `${COACH_PHOTO_BASE_URL}/${encodeURIComponent(providerCoachId)}.png`;

/** Marker for a provider coach id whose photo was a placeholder. */
export const coachNoPhotoKey = (providerCoachId: string): string =>
  `enrich:coach-photos:none:${providerCoachId}`;

export interface CoachNoPhotoMarker {
  readonly checkedAtMs: number;
  readonly reason: string;
}

export type CoachPhotoClassification =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly sha: string; readonly reason: string };

/** A PNG or JPEG that is not a known placeholder is a photo. */
export const classifyCoachPhoto = (body: Uint8Array): CoachPhotoClassification => {
  const sha = createHash('sha256').update(body).digest('hex');
  if (body.byteLength === 0) {
    return { ok: false, sha, reason: 'empty body' };
  }
  const placeholder = COACH_PHOTO_PLACEHOLDER_SHA256.get(sha);
  if (placeholder) {
    return { ok: false, sha, reason: placeholder };
  }
  const isPng =
    body.byteLength > 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47;
  const isJpeg = body.byteLength > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (!isPng && !isJpeg) {
    return { ok: false, sha, reason: 'not a PNG or JPEG body' };
  }
  return { ok: true, sha };
};

/** Image GET. Mirrors the global `fetch` shape so tests can stub it. */
export type CoachPhotoFetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Runtime wiring for `coach-photos`, built in `worker/http.ts`. */
export interface CoachPhotoDeps {
  /** The content bucket (`R2_BUCKET_CONTENT`), the same store the asset mirror writes. */
  readonly store: MediaObjectStore;
  /** Defaults to the global `fetch`. */
  readonly imageFetch?: CoachPhotoFetch;
  /** Defaults to {@link COACH_PHOTO_FETCH_GAP_MS}. */
  readonly fetchGapMs?: number;
}

export const clampCoachPhotoLimit = (limit: number | undefined): number =>
  limit === undefined || !Number.isFinite(limit) || limit <= 0
    ? DEFAULT_COACH_PHOTO_DOWNLOADS_PER_RUN
    : Math.min(Math.floor(limit), MAX_COACH_PHOTO_DOWNLOADS_PER_RUN);

interface CoachPhotoEnv {
  readonly clock: () => Date;
  readonly nowMs: number;
  readonly limit: number;
  readonly dryRun: boolean;
  readonly log: (entry: Omit<WorkflowLogEntry, 'workflow'>) => void;
  readonly finish: (
    status: ProviderEnrichmentOutput['status'],
    fields?: {
      readonly targets?: readonly ProviderEnrichmentTargetResult[];
      readonly callsUsed?: number;
      readonly finalQuota?: ProviderQuotaSnapshot;
      readonly reason?: string;
    }
  ) => ProviderEnrichmentOutput;
}

/** One identity coach and the API-Football ids that resolve to it, in id order. */
interface MappedCoach {
  readonly entityId: string;
  readonly providerIds: string[];
}

export interface CoachPhotoCounts {
  /** Provider coach ids considered. */
  coachIds: number;
  unmapped: number;
  /** Identity coaches considered. */
  coaches: number;
  present: number;
  mirrored: number;
  noPhoto: number;
  /** Ids skipped because a recent run found a placeholder. */
  noPhotoRecent: number;
  failed: number;
  /** Coaches left for the next run because the download cap was reached. */
  deferred: number;
  downloads: number;
}

const sortNumeric = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));

const defaultCoachPhotoFetch: CoachPhotoFetch = (url, init) =>
  fetch(url, { headers: init.headers, signal: init.signal });

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Run the `coach-photos` dataset. Called by `providerEnrichmentWorkflow`
 * after the kill switch check.
 */
export const runCoachPhotos = async (
  input: ProviderEnrichmentInput,
  deps: WorkflowDeps,
  env: CoachPhotoEnv
): Promise<ProviderEnrichmentOutput> => {
  const { nowMs, limit, dryRun, log, finish } = env;
  const store = deps.coachPhotos?.store;
  if (!store) {
    return finish('skipped', {
      reason: 'media store is not configured (R2_BUCKET_CONTENT and the R2 credentials)',
    });
  }
  const identity = deps.identity;
  if (!identity) {
    return finish('skipped', { reason: 'identity client is not wired' });
  }
  const state = deps.stateStore ?? deps.ingestion.cache;
  const imageFetch = deps.coachPhotos?.imageFetch ?? defaultCoachPhotoFetch;
  const fetchGapMs = deps.coachPhotos?.fetchGapMs ?? COACH_PHOTO_FETCH_GAP_MS;
  const sleep = deps.enrichment?.sleep ?? defaultSleep;

  // 1. Provider coach ids: the request's, else every team digest in scope.
  let providerIds: string[];
  let gaps = 0;
  let teamsWithoutList = 0;
  if (input.coachIds && input.coachIds.length > 0) {
    providerIds = sortNumeric(input.coachIds.filter((id) => PROVIDER_COACH_ID.test(id)));
  } else {
    const scope = await resolveTeamScope(input, deps, undefined, 'coaches');
    gaps = scope.gaps.length;
    for (const gap of scope.gaps) {
      log({
        event: 'provider_enrichment.scope_gap',
        leagueId: gap.leagueId,
        season: gap.season || undefined,
        reason: gap.reason,
      });
    }
    const collected: string[] = [];
    for (const teamId of scope.teamIds) {
      const digest = await state.get<TeamCoachsDigest>(teamCoachsDigestKey(teamId));
      if (!digest) {
        teamsWithoutList += 1;
        continue;
      }
      collected.push(...digest.coachIds.filter((id) => PROVIDER_COACH_ID.test(id)));
    }
    providerIds = sortNumeric(collected);
  }

  const counts: CoachPhotoCounts = {
    coachIds: providerIds.length,
    unmapped: 0,
    coaches: 0,
    present: 0,
    mirrored: 0,
    noPhoto: 0,
    noPhotoRecent: 0,
    failed: 0,
    deferred: 0,
    downloads: 0,
  };
  const targets: ProviderEnrichmentTargetResult[] = [];
  const target = (
    entityId: string,
    status: ProviderEnrichmentTargetResult['status'],
    errors: readonly string[] = []
  ): ProviderEnrichmentTargetResult => ({
    unit: `coach-${entityId}`,
    leagueId: 0,
    season: 0,
    status,
    pagesTotal: 0,
    nextPage: 0,
    pagesFetched: 0,
    rowsIngested: status === 'complete' ? 1 : 0,
    rowsDropped: 0,
    errors,
  });

  // 2. Resolve each id through identity and group by identity coach.
  const byEntity = new Map<string, MappedCoach>();
  for (const providerId of providerIds) {
    try {
      const resolved = await identity.resolve(
        create(ResolveRequestSchema, {
          entityType: EntityType.COACH,
          provider: API_FOOTBALL_PROVIDER_ID,
          providerId,
        })
      );
      if (!resolved.found || !COACH_ENTITY_ID.test(resolved.entityId)) {
        counts.unmapped += 1;
        continue;
      }
      const coach = byEntity.get(resolved.entityId) ?? {
        entityId: resolved.entityId,
        providerIds: [],
      };
      coach.providerIds.push(providerId);
      byEntity.set(resolved.entityId, coach);
    } catch (error) {
      counts.failed += 1;
      log({
        event: 'coach_photos.identity_error',
        providerId,
        message: errorMessage(error),
      });
    }
  }
  const coaches = [...byEntity.values()].sort((a, b) =>
    a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
  );
  counts.coaches = coaches.length;

  // 3. Mirror each coach without an object, first real photo wins.
  const bodiesSeen = new Map<string, Set<string>>();
  const learnedPlaceholders = new Set<string>();
  let capped = false;
  for (const coach of coaches) {
    const key = coachPhotoObjectKey(coach.entityId);
    try {
      if (await store.head(key)) {
        counts.present += 1;
        continue;
      }
    } catch (error) {
      counts.failed += 1;
      targets.push(target(coach.entityId, 'failed', [`head ${key}: ${errorMessage(error)}`]));
      continue;
    }
    if (capped) {
      counts.deferred += 1;
      continue;
    }

    let mirrored = false;
    let deferred = false;
    const failedWith: string[] = [];
    let noPhoto = false;
    let checked = false;
    for (const providerId of coach.providerIds) {
      if (!input.reset) {
        const marker = await state.get<CoachNoPhotoMarker>(coachNoPhotoKey(providerId));
        if (marker && nowMs - marker.checkedAtMs < COACH_NO_PHOTO_RECHECK_SECONDS * 1_000) {
          continue;
        }
      }
      checked = true;
      if (counts.downloads >= limit) {
        capped = true;
        deferred = true;
        break;
      }
      if (counts.downloads > 0 && fetchGapMs > 0) {
        await sleep(fetchGapMs);
      }
      counts.downloads += 1;
      const got = await downloadCoachPhoto(imageFetch, providerId);
      if (got.kind === 'failed') {
        failedWith.push(`${providerId}: ${got.reason}`);
        continue;
      }
      let placeholder = got.kind === 'no-photo' ? got.reason : undefined;
      if (got.kind === 'photo') {
        if (learnedPlaceholders.has(got.sha)) {
          placeholder = 'repeated body';
        } else {
          const seen = bodiesSeen.get(got.sha) ?? new Set<string>();
          seen.add(coach.entityId);
          bodiesSeen.set(got.sha, seen);
          if (seen.size > REPEATED_BODY_LIMIT) {
            learnedPlaceholders.add(got.sha);
            placeholder = 'repeated body';
            log({
              event: 'coach_photos.repeated_body',
              reason:
                `sha256 ${got.sha} served for ${seen.size} coaches, treated as a placeholder; ` +
                'add it to COACH_PHOTO_PLACEHOLDER_SHA256 and check the objects already ' +
                `written for ${[...seen].slice(0, REPEATED_BODY_LIMIT).join(', ')}`,
            });
          }
        }
      }
      if (placeholder !== undefined || got.kind !== 'photo') {
        noPhoto = true;
        if (!dryRun) {
          await state.set<CoachNoPhotoMarker>(
            coachNoPhotoKey(providerId),
            { checkedAtMs: nowMs, reason: placeholder ?? 'no photo' },
            COACH_NO_PHOTO_RECHECK_SECONDS
          );
        }
        continue;
      }
      if (dryRun) {
        mirrored = true;
        break;
      }
      try {
        await store.put(key, got.body, {
          contentType: got.contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        });
        mirrored = true;
        log({ event: 'coach_photos.mirrored', providerId, label: coach.entityId, status: key });
      } catch (error) {
        failedWith.push(`put ${key}: ${errorMessage(error)}`);
      }
      break;
    }

    if (mirrored) {
      counts.mirrored += 1;
      targets.push(target(coach.entityId, dryRun ? 'planned' : 'complete'));
    } else if (deferred) {
      counts.deferred += 1;
    } else if (failedWith.length > 0) {
      counts.failed += 1;
      targets.push(target(coach.entityId, 'failed', failedWith));
      for (const message of failedWith) {
        log({ event: 'coach_photos.failed', label: coach.entityId, message });
      }
    } else if (noPhoto) {
      counts.noPhoto += 1;
    } else if (!checked) {
      counts.noPhotoRecent += 1;
    }
  }

  const summary =
    `${dryRun ? 'would mirror' : 'mirrored'} ${counts.mirrored}, present ${counts.present}, ` +
    `no photo ${counts.noPhoto} (+${counts.noPhotoRecent} checked in the last 7 days), ` +
    `failed ${counts.failed}, deferred ${counts.deferred}; ` +
    `${counts.coaches} mapped coaches from ${counts.coachIds} ids (${counts.unmapped} unmapped), ` +
    `${counts.downloads}/${limit} downloads` +
    (teamsWithoutList > 0 ? `; ${teamsWithoutList} teams with no coach list yet` : '') +
    (gaps > 0 ? `; ${gaps} leagues without a cached fixture list` : '');
  log({ event: 'coach_photos.summary', status: dryRun ? 'dry-run' : 'run', reason: summary });

  if (counts.coachIds === 0) {
    return finish(gaps > 0 ? 'incomplete' : 'skipped', {
      targets,
      reason: `no coach ids: run team-coaches first, or pass coachIds; ${summary}`,
    });
  }
  const incomplete = capped || counts.failed > 0 || gaps > 0;
  return finish(incomplete ? 'incomplete' : 'completed', {
    targets,
    reason: dryRun ? `dry run: ${summary}` : summary,
  });
};

type Downloaded =
  | {
      readonly kind: 'photo';
      readonly body: Uint8Array;
      readonly sha: string;
      readonly contentType: string;
    }
  | { readonly kind: 'no-photo'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

const downloadCoachPhoto = async (
  imageFetch: CoachPhotoFetch,
  providerId: string
): Promise<Downloaded> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const response = await imageFetch(coachPhotoUrl(providerId), {
      headers: { 'User-Agent': COACH_PHOTO_USER_AGENT },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return { kind: 'no-photo', reason: 'http 404' };
    }
    if (!response.ok) {
      return { kind: 'failed', reason: `http ${response.status}` };
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const classified = classifyCoachPhoto(body);
    if (!classified.ok) {
      return { kind: 'no-photo', reason: classified.reason };
    }
    const header = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() ?? '';
    return {
      kind: 'photo',
      body,
      sha: classified.sha,
      contentType: header.startsWith('image/') ? header : 'image/png',
    };
  } catch (error) {
    return { kind: 'failed', reason: `fetch: ${errorMessage(error)}` };
  } finally {
    clearTimeout(timer);
  }
};
