/**
 * Cloudflare R2 adapter and seven-day retention logic.
 *
 * The adapter layer isolates the AWS SDK behind a narrow contract so unit
 * tests can use an in-memory object store. Everything treats remote keys and
 * manifests as untrusted; credentials never appear in errors or logs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { parseManifest, LIMITS, MANIFEST_NAME, resolvePrivatePath } from './snapshot.js';
import { removeFiles, ensurePrivateDir } from './encryption.js';
import { ordinal } from './progress.js';
import { isValidSnapshotId, parseSnapshotId } from './fingerprint.js';
import { writeWithBackpressure, endWritable, sha256Readable } from './stream.js';

export class R2Error extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'R2Error';
    this.cause = cause;
  }
}

export function r2Endpoint(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** Max keys per DeleteObjects call (S3 API limit). */
const DELETE_BATCH_SIZE = 1000;

/** Inspection outcomes reported in the valid-snapshot scan progress. */
const SNAPSHOT_OUTCOME = {
  IGNORED: 'ignored',
  VALID: 'valid',
};

/**
 * Real adapter over the AWS SDK. Methods never accept or return credentials.
 * Each operation is a small client-bound private function. `endpoint`
 * overrides the default R2 endpoint (e.g. a local MinIO for fixtures).
 */
export function createS3Adapter({ accountId, accessKeyId, secretAccessKey, endpoint }) {
  const client = new S3Client({
    region: 'auto',
    endpoint: endpoint ?? r2Endpoint(accountId),
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    headBucket: headBucketOp(client),
    listObjects: listObjectsOp(client),
    headObject: headObjectOp(client),
    getObject: getObjectOp(client),
    putObject: putObjectOp(client),
    deleteObjects: deleteObjectsOp(client),
  };
}

function headBucketOp(client) {
  return async ({ bucket, signal }) => {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
  };
}

function listObjectsOp(client) {
  return async ({ bucket, prefix = '', continuationToken }) => {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    return {
      keys: (res.Contents ?? []).map((o) => ({ key: o.Key, size: o.Size ?? 0 })),
      isTruncated: res.IsTruncated === true,
      nextToken: res.NextContinuationToken,
    };
  };
}

function headObjectOp(client) {
  return async ({ bucket, key }) => {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: res.ContentLength ?? 0, metadata: res.Metadata ?? {} };
  };
}

function getObjectOp(client) {
  return async ({ bucket, key }) => {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return {
      size: res.ContentLength ?? 0,
      metadata: res.Metadata ?? {},
      body: res.Body,
      contentType: res.ContentType,
    };
  };
}

function putObjectOp(client) {
  return async ({ bucket, key, body, contentLength, contentType, metadata }) => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: contentLength,
        ContentType: contentType,
        Metadata: metadata,
      }),
    );
  };
}

function deleteObjectsOp(client) {
  return async ({ bucket, keys }) => {
    const failed = [];
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const res = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: keys.slice(i, i + DELETE_BATCH_SIZE).map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      // S3-compatible bulk delete resolves with HTTP success while returning
      // per-key failures in `Errors`. A discarded response would let retention
      // report a prefix as cleaned when objects survived.
      for (const item of res.Errors ?? []) {
        failed.push(`${item.Key}: ${item.Code ?? 'unknown'} (${item.Message ?? 'no message'})`);
      }
    }
    if (failed.length > 0) {
      throw new R2Error(`delete failed for ${failed.length} object(s): ${failed.join('; ')}`);
    }
  };
}

export function prefixOf(snapshotId) {
  return `snapshots/${snapshotId}/`;
}

/** Snapshot ID from a canonical prefix (`snapshots/<id>/`). */
export function snapshotIdOf(prefix) {
  return prefix.split('/')[1];
}

/** Group listing keys by canonical snapshot prefix `snapshots/<id>/`. */
export async function listSnapshotPrefixes({ adapter, bucket }) {
  const grouped = new Map();
  let token;
  do {
    const page = await adapter.listObjects({
      bucket,
      prefix: 'snapshots/',
      continuationToken: token,
    });
    for (const { key } of page.keys) {
      const parts = String(key).split('/');
      if (parts.length !== 3 || parts[0] !== 'snapshots' || parts[2] === '') continue;
      const snapshotId = parts[1];
      if (!isValidSnapshotId(snapshotId)) continue;
      const prefix = `${parts[0]}/${parts[1]}/`;
      if (!grouped.has(prefix)) grouped.set(prefix, []);
      grouped.get(prefix).push(parts[2]);
    }
    token = page.nextToken;
  } while (token);
  return grouped;
}

/**
 * Valid snapshots only: canonical prefix, valid manifest, matching
 * environment/snapshot ID, and every referenced stored file present in the
 * listing. Incomplete prefixes are ignored for selection.
 */
export async function listValidSnapshots({
  adapter,
  bucket,
  expectedEnvironment,
  expectedProjectRef,
  limits,
  onProgress,
}) {
  const prefixes = await listSnapshotPrefixes({ adapter, bucket });
  const valid = [];
  const total = prefixes.size;
  let index = 0;
  for (const [prefix, keys] of prefixes) {
    index += 1;
    const snapshotId = snapshotIdOf(prefix);
    let outcome = SNAPSHOT_OUTCOME.IGNORED;
    onProgress?.(`starting snapshot inspection ${index}/${total}: ${snapshotId}`);
    try {
      if (!keys.includes(MANIFEST_NAME)) continue;
      let manifest;
      try {
        manifest = await fetchManifest({ adapter, bucket, prefix, limits });
      } catch {
        continue; // malformed manifest: incomplete prefix, never selectable
      }
      if (expectedEnvironment && manifest.environment !== expectedEnvironment) continue;
      if (manifest.snapshotId !== snapshotId) continue;
      if (expectedProjectRef && manifest.sourceProjectRef !== expectedProjectRef) continue;
      const names = new Set(keys);
      if (!manifest.files.every((f) => names.has(f.name))) continue;
      outcome = SNAPSHOT_OUTCOME.VALID;
      valid.push({ prefix, snapshotId, manifest, keys: new Set(keys) });
    } finally {
      onProgress?.(`completed snapshot inspection ${index}/${total}: ${snapshotId}: ${outcome}`);
    }
  }
  valid.sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0));
  return valid;
}

/** Fetch and strictly validate the manifest object for one prefix. */
export async function fetchManifest({ adapter, bucket, prefix, limits }) {
  const lim = { ...LIMITS, ...(limits ?? {}) };
  const key = `${prefix}${MANIFEST_NAME}`;
  const head = await adapter.headObject({ bucket, key });
  if (head.size > lim.maxManifestBytes) {
    throw new R2Error(`manifest exceeds size limit (${head.size} bytes)`);
  }
  const { body } = await adapter.getObject({ bucket, key });
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  let parsed;
  try {
    parsed = parseManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (err) {
    throw new R2Error(`invalid manifest for ${prefix}`, { cause: err });
  }
  return parsed;
}

/** Newest valid snapshot (lexicographic = chronological UTC ordering). */
export function selectLatest(validSnapshots) {
  const sorted = [...validSnapshots].sort((a, b) =>
    a.snapshotId < b.snapshotId ? 1 : a.snapshotId > b.snapshotId ? -1 : 0,
  );
  return sorted[0] ?? null;
}

/**
 * Time-based retention: a snapshot is deleted when its manifest/snapshot-ID
 * timestamp is at least `retentionDays` older than the current run. The exact
 * boundary (equal to `retentionDays` ago) is deleted.
 */
export function computeRetentionDeletes({ snapshots, now, retentionDays = 7 }) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const expired = snapshots.filter((s) => parseSnapshotId(s.snapshotId).ms <= cutoff);
  // Availability guard: an unchanged database that skips uploads must never
  // lose its only valid R2 snapshot. If deleting `expired` would remove
  // EVERY valid snapshot, keep the newest VALID one so `--backup latest
  // --source r2` can still recover. The guard keys on what would remain
  // valid, not on whether ALL prefixes are expired: a recent incomplete
  // prefix (not expired) must not cause the only valid copy to be deleted.
  const valid = snapshots.filter((s) => s.manifest != null);
  const remainingValid = valid.filter((v) => !expired.some((e) => e.snapshotId === v.snapshotId));
  if (valid.length > 0 && remainingValid.length === 0) {
    const newestValid = [...valid].sort((a, b) =>
      a.snapshotId < b.snapshotId ? 1 : a.snapshotId > b.snapshotId ? -1 : 0,
    )[0];
    const idx = expired.findIndex((e) => e.snapshotId === newestValid.snapshotId);
    if (idx !== -1) expired.splice(idx, 1);
  }
  return expired;
}

/** Prior prefixes for the same UTC calendar date as the current snapshot. */
export function computeSameDayDelete({ snapshotId, prefixes }) {
  const date = snapshotId.slice(0, 10);
  return prefixes.filter((p) => snapshotIdOf(p)?.startsWith(`${date}T`));
}

/** Delete object keys in API-sized batches (1,000 per call). */
export async function batchDelete({ adapter, bucket, keys, onProgress }) {
  const total = Math.ceil(keys.length / DELETE_BATCH_SIZE);
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = i / DELETE_BATCH_SIZE + 1;
    const count = Math.min(DELETE_BATCH_SIZE, keys.length - i);
    onProgress?.(`starting delete batch ${batch}/${total}: ${count} object(s)`);
    await adapter.deleteObjects({ bucket, keys: keys.slice(i, i + DELETE_BATCH_SIZE) });
    onProgress?.(`completed delete batch ${batch}/${total}: ${count} object(s)`);
  }
}

/** List every object under a prefix and delete it in API-sized batches. */
export async function deletePrefix({ adapter, bucket, prefix, onProgress }) {
  onProgress?.('starting cleanup object listing');
  const keys = [];
  let token;
  do {
    const page = await adapter.listObjects({ bucket, prefix, continuationToken: token });
    keys.push(...page.keys.map((k) => k.key));
    token = page.nextToken;
  } while (token);
  onProgress?.(`completed cleanup object listing: ${keys.length} object(s)`);
  if (keys.length > 0) {
    await batchDelete({ adapter, bucket, keys, onProgress });
  }
  return keys.length;
}

/** Upload one object and verify it with HeadObject; rejects on mismatch. */
async function uploadAndVerifyObject({
  adapter,
  bucket,
  key,
  body,
  contentLength,
  contentType,
  metadata,
  name,
}) {
  await adapter.putObject({ bucket, key, body, contentLength, contentType, metadata });
  const head = await adapter.headObject({ bucket, key });
  if (head.size !== contentLength || (head.metadata?.sha256 ?? null) !== metadata.sha256) {
    throw new R2Error(`upload verification failed for ${name}`);
  }
}

/**
 * Upload a packaged snapshot: every non-manifest file first (verified with
 * HeadObject), manifest.json last (also verified). SHA-256 of each stored
 * object is kept as object metadata.
 */
export async function uploadSnapshot({
  adapter,
  bucket,
  prefix,
  files,
  manifest: _manifest,
  manifestRaw,
  contentType = 'application/octet-stream',
  onProgress,
}) {
  const manifestKey = `${prefix}${MANIFEST_NAME}`;
  const total = files.length + 1;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const key = `${prefix}${file.name}`;
    const stat = fs.statSync(file.path);
    // A failing read stream must not crash the process with an uncaught
    // exception, and its root cause must not be swallowed: record the first
    // stream error and rethrow it as the actionable failure when the request
    // fails. Errors from the SDK cancelling the stream after its own failure
    // (ERR_STREAM_PREMATURE_CLOSE and friends) are NOT fs faults: they fall
    // through to the original request error.
    const body = fs.createReadStream(file.path);
    let readError = null;
    const onReadError = (err) => {
      if (readError === null) readError = err;
    };
    body.on('error', onReadError);
    // Keep the observer until the stream really closes: an eager open that
    // races a failed put can emit its error AFTER the put settled, and an
    // unobserved error would become an uncaught exception.
    body.once('close', () => body.removeListener('error', onReadError));
    onProgress?.(`starting snapshot object upload ${ordinal(i, total)}: ${file.name}`);
    try {
      await uploadAndVerifyObject({
        adapter,
        bucket,
        key,
        body,
        contentLength: stat.size,
        contentType: file.contentType ?? contentType,
        metadata: { sha256: file.sha256 },
        name: file.name,
      });
    } catch (err) {
      // Stop feeding the failed request; the observer above still absorbs
      // any error from a pending open/read until the stream closes.
      body.destroy();
      if (readError && FS_READ_ERROR_CODES.has(readError.code)) {
        throw new R2Error(`read failed for ${file.name}: ${readError.message}`, {
          cause: readError,
        });
      }
      throw err;
    }
    onProgress?.(`completed snapshot object upload ${ordinal(i, total)}: ${file.name}: verified`);
  }
  const manifestBody = Buffer.from(manifestRaw, 'utf8');
  const manifestOrdinal = `${total}/${total}`;
  onProgress?.(`starting snapshot object upload ${manifestOrdinal}: ${MANIFEST_NAME}`);
  await uploadAndVerifyObject({
    adapter,
    bucket,
    key: manifestKey,
    body: manifestBody,
    contentLength: manifestBody.length,
    contentType: 'application/json',
    metadata: { sha256: sha256OfBuffer(manifestRaw) },
    name: MANIFEST_NAME,
  });
  onProgress?.(`completed snapshot object upload ${manifestOrdinal}: ${MANIFEST_NAME}: verified`);
  return { uploaded: files.length + 1 };
}

function sha256OfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** fs-level read failure codes: the stream is the only source of truth. */
const FS_READ_ERROR_CODES = new Set([
  'ENOENT',
  'EISDIR',
  'EACCES',
  'EPERM',
  'EIO',
  'EBADF',
  'EMFILE',
  'ENFILE',
  'ENXIO',
  'ESTALE',
]);

/** Declared-size validation against limits before any object is downloaded. */
function assertDeclaredSizes({ manifest, lim }) {
  for (const entry of manifest.files) {
    if (!entry.encrypted && entry.size > lim.maxPlaintextBytes) {
      throw new R2Error(`declared size exceeds plaintext limit: ${entry.name}`);
    }
    if (entry.encrypted && entry.size > lim.maxPartBytes) {
      throw new R2Error(`declared size exceeds part limit: ${entry.name}`);
    }
  }
}

/** Head-check and stream one declared object to a private file with backpressure. */
async function downloadObjectToFile({ adapter, bucket, key, expectedSize, outPath }) {
  const head = await adapter.headObject({ bucket, key });
  if (head.size !== expectedSize) {
    throw new R2Error(`size mismatch for ${path.basename(outPath)}`);
  }
  const { body } = await adapter.getObject({ bucket, key });
  const writeStream = fs.createWriteStream(outPath, { mode: 0o600 });
  try {
    for await (const chunk of body) {
      await writeWithBackpressure(writeStream, chunk);
    }
  } finally {
    await endWritable(writeStream);
  }
}

/** Recompute the on-disk size and SHA-256 and compare with the manifest entry. */
async function verifyDownloadedFile({ outPath, expectedSize, expectedSha256 }) {
  const stat = fs.statSync(outPath);
  if (stat.size !== expectedSize) {
    throw new R2Error(`downloaded size mismatch for ${path.basename(outPath)}`);
  }
  const actual = await sha256Readable(fs.createReadStream(outPath));
  if (actual !== expectedSha256) {
    throw new R2Error(`checksum mismatch for ${path.basename(outPath)}`);
  }
}

/** Download the bounded manifest alongside the snapshot files. */
async function downloadManifestObject({ adapter, bucket, prefix, destDir, lim }) {
  const key = `${prefix}${MANIFEST_NAME}`;
  const head = await adapter.headObject({ bucket, key });
  if (head.size > lim.maxManifestBytes) {
    throw new R2Error(`manifest exceeds size limit (${head.size} bytes)`);
  }
  const { body } = await adapter.getObject({ bucket, key });
  const outPath = resolvePrivatePath(destDir, MANIFEST_NAME);
  const writeStream = fs.createWriteStream(outPath, { mode: 0o600 });
  try {
    for await (const chunk of body) {
      await writeWithBackpressure(writeStream, chunk);
    }
  } finally {
    await endWritable(writeStream);
  }
  return outPath;
}

/**
 * Download only manifest-allowlisted keys into a private directory, enforcing
 * declared size limits BEFORE downloading and recomputing SHA-256 after.
 * Never uses unvalidated keys as local paths; removes the destination on any
 * failure.
 */
export async function downloadSnapshot({ adapter, bucket, prefix, manifest, destDir, limits }) {
  const lim = { ...LIMITS, ...(limits ?? {}) };
  ensurePrivateDir(destDir, 0o700);
  const downloaded = [];
  try {
    assertDeclaredSizes({ manifest, lim });
    for (const entry of manifest.files) {
      const outPath = resolvePrivatePath(destDir, entry.name);
      await downloadObjectToFile({
        adapter,
        bucket,
        key: `${prefix}${entry.name}`,
        expectedSize: entry.size,
        outPath,
      });
      await verifyDownloadedFile({
        outPath,
        expectedSize: entry.size,
        expectedSha256: entry.sha256,
      });
      downloaded.push({ name: entry.name, path: outPath });
    }
    // The manifest itself travels with the snapshot (restore preparation
    // re-validates source directories that must include it).
    const manifestOut = await downloadManifestObject({ adapter, bucket, prefix, destDir, lim });
    downloaded.push({ name: MANIFEST_NAME, path: manifestOut });
    return downloaded;
  } catch (err) {
    await removeFiles([destDir]);
    throw err instanceof R2Error
      ? err
      : new R2Error(`download failed: ${err.message}`, { cause: err });
  }
}

export async function headBucketCheck({ adapter, bucket, signal }) {
  try {
    await adapter.headBucket({ bucket, signal });
  } catch (err) {
    // Static message; the raw cause is preserved so non-doctor callers keep
    // AWS status codes, request IDs, and abort classification. The doctor
    // discards the cause at its own reporting boundary (bare catch).
    throw new R2Error(`cannot access R2 bucket for ${bucket}: check credentials and bucket scope`, {
      cause: err,
    });
  }
}
