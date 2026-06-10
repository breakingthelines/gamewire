// One-shot: mirror Wikidata competition logos into the content bucket + the
// entity-imagery manifest, so the platform resolves real competition badges
// (instead of monograms) for competitions that have no api-football logo.
//
// Self-contained (Bun built-ins only). Reads the shared R2 env the gamewire
// asset-mirror uses; writes under the SAME bucket key convention
// (media/provider/competition/<canonicalId>.<ext>) + patches the SAME manifest
// (media/manifest/entity-imagery.json). Idempotent: skips competitions already
// in the manifest (keeps the 6 api-football PNGs). Run in the gamewire worker
// (R2 creds + outbound present): bun mirror-competition-logos.ts <pairs.json>
//
// pairs.json: { "<btl_football_competition_*>": "<wikidata Qid>", ... }

const PAIRS_PATH = process.argv[2] ?? '/tmp/comp-wikidata.json';
const UA =
  'BTL-competition-logo-backfill/1.0 (https://breakingthelines.com; ops@breakingthelines.com)';
const MANIFEST_KEY = 'media/manifest/entity-imagery.json';

const endpoint = process.env.R2_ENDPOINT;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_CONTENT;
const cdnBaseEnv = (
  process.env.R2_MEDIA_CDN_BASE_URL ??
  process.env.CONTENT_STORAGE_CDN_BASE_URL ??
  ''
).replace(/\/+$/, '');

if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
  console.error(
    'missing R2 env (R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_CONTENT)'
  );
  process.exit(1);
}

// @ts-expect-error Bun global
const s3 = new Bun.S3Client({ endpoint, accessKeyId, secretAccessKey, bucket, region: 'auto' });

const CONTENT_TYPE: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const extOf = (filename: string): string => {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
};

// Wikidata P154 (logo image) → Commons filename. Returns null when absent.
async function wikidataLogoFile(qid: string): Promise<string | null> {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P154&format=json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const d: any = await r.json();
  const claims = d?.claims?.P154;
  if (!Array.isArray(claims)) return null;
  for (const cl of claims) {
    const v = cl?.mainsnak?.datavalue?.value;
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

async function main() {
  const pairs: Record<string, string> = JSON.parse(await Bun.file(PAIRS_PATH).text());

  const manifestFile = s3.file(MANIFEST_KEY);
  const manifest: { version: string; cdnBase: string; entities: Record<string, any> } =
    (await manifestFile.exists())
      ? JSON.parse(await manifestFile.text())
      : { version: new Date().toISOString(), cdnBase: cdnBaseEnv, entities: {} };
  manifest.entities ??= {};
  const cdnBase = manifest.cdnBase || cdnBaseEnv;
  if (!cdnBase) {
    console.error(
      'no cdnBase (manifest has none + env unset) — refusing to write a broken manifest'
    );
    process.exit(1);
  }

  const ids = Object.keys(pairs);
  let mirrored = 0,
    skipped = 0,
    nologo = 0,
    failed = 0;

  for (const cid of ids) {
    if (manifest.entities[cid]) {
      skipped++;
      continue;
    }
    const qid = pairs[cid];
    try {
      const file = await wikidataLogoFile(qid);
      if (!file) {
        nologo++;
        continue;
      }
      const ext = extOf(file);
      if (!ext || !CONTENT_TYPE[ext]) {
        nologo++;
        continue;
      }
      const commonsUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(
        file.replace(/ /g, '_')
      )}`;
      const img = await fetch(commonsUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!img.ok) {
        failed++;
        console.error(`fetch ${img.status} ${cid} ${qid} ${file}`);
        continue;
      }
      const body = new Uint8Array(await img.arrayBuffer());
      if (body.byteLength === 0) {
        failed++;
        continue;
      }
      const key = `media/provider/competition/${cid}.${ext}`;
      await s3.file(key).write(body, { type: CONTENT_TYPE[ext] });
      manifest.entities[cid] = { type: 'competition', provider: ext };
      mirrored++;
      if (mirrored % 20 === 0) console.log(`...${mirrored} mirrored`);
      await Bun.sleep(150); // be polite to Wikimedia
    } catch (e) {
      failed++;
      console.error(`error ${cid} ${qid}: ${String(e)}`);
    }
  }

  manifest.version = new Date().toISOString();
  manifest.cdnBase = cdnBase;
  await manifestFile.write(`${JSON.stringify(manifest, null, 2)}\n`, { type: 'application/json' });

  console.log(
    `DONE. mirrored=${mirrored} skipped(already)=${skipped} no-logo=${nologo} failed=${failed} total=${ids.length} | manifest competitions now=${
      Object.values(manifest.entities).filter((e: any) => e?.type === 'competition').length
    }`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
