/**
 * Restore source acquisition and verification (sub-plan 06).
 *
 * The common NON-DESTRUCTIVE preparation path: select a snapshot (repository
 * or R2), acquire it privately, verify every stored artifact, decrypt row
 * data with the private identity, and recompute the aggregate logical
 * fingerprint BEFORE any restore target is touched. Never connects to a
 * database and never prompts for confirmation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSnapshotId, isValidSnapshotId, formatSnapshotId } from './fingerprint.js';
import { unpackAndVerify, ROW_DATA_FILE, MANIFEST_NAME } from './snapshot.js';
import { scanRepositorySnapshots } from './repository.js';
import { listValidSnapshots, downloadSnapshot, createS3Adapter } from './r2.js';
import { ensurePrivateDir, writePrivateFile, removeFiles } from './encryption.js';
import { BACKUP_WORKSPACE_PREFIX } from './backup.js';

/**
 * Private temp-directory prefixes; shared with tests for leak scans. Every
 * value is DERIVED from the canonical `BACKUP_WORKSPACE_PREFIX` so the
 * on-disk convention can never drift between the backup and restore paths.
 *
 * BREAKING RENAME NOTE: versions before the generic rename used
 * `fragtrack-{backup,identity,download,prepared,cleanup}-*`. A process still
 * removes only directories it created under the CURRENT prefixes, so legacy
 * orphans from crashed pre-rename runs are intentionally NOT reaped. After
 * upgrading, remove any leftover `fragtrack-*` temp directories manually:
 * they may contain decrypted row data and the age identity.
 */
export const RESTORE_WORKSPACE_PREFIXES = Object.freeze({
  identity: `${BACKUP_WORKSPACE_PREFIX}identity-`,
  download: `${BACKUP_WORKSPACE_PREFIX}download-`,
  prepared: `${BACKUP_WORKSPACE_PREFIX}prepared-`,
  cleanup: `${BACKUP_WORKSPACE_PREFIX}cleanup-`,
});

export class RestoreError extends Error {
  constructor(message, { availableIds = [], cause } = {}) {
    super(message);
    this.name = 'RestoreError';
    this.availableIds = availableIds;
    this.cause = cause;
  }
}

/** R2 sources need a bucket-scoped adapter; repo sources need none. */
export function createRestoreAdapter({ source, cfg, makeAdapter = createS3Adapter }) {
  if (source !== 'r2') return undefined;
  return makeAdapter({
    accountId: cfg.accountId,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
}

/** Strict CLI selector: `latest` or one exact canonical snapshot ID. */
export function parseBackupSelector(value) {
  if (value === 'latest') return { kind: 'latest' };
  if (typeof value === 'string' && isValidSnapshotId(value)) {
    return { kind: 'exact', snapshotId: value };
  }
  throw new RestoreError(
    '--backup must be "latest" or one exact canonical snapshot ID (YYYY-MM-DDTHH-mm-ssZ)',
  );
}

export function formatAvailableIds(ids) {
  return ids.length > 0 ? ids.join(', ') : '(none)';
}

/**
 * Select one snapshot entry from a newest-first sorted list using the
 * selector. Unavailable exact IDs fail with the valid choices listed.
 */
export function selectFromSnapshots({ selector, snapshots }) {
  if (selector.kind === 'latest') {
    if (snapshots.length === 0) {
      throw new RestoreError('no valid snapshots available for this environment/source');
    }
    return snapshots[0];
  }
  const match = snapshots.find((s) => s.snapshotId === selector.snapshotId);
  if (!match) {
    const ids = [...snapshots].sort().map((s) => s.snapshotId);
    throw new RestoreError(
      `snapshot ${selector.snapshotId} is not available; valid snapshot IDs: ${formatAvailableIds(ids)}`,
      { availableIds: ids },
    );
  }
  return match;
}

/** Repository source: newest-first valid snapshots for one environment. */
export async function listRepositorySnapshots({
  repoRoot,
  environment,
  projectRef,
  limits: _limits,
}) {
  const { snapshots } = await scanRepositorySnapshots({ repoRoot, environment });
  const filtered = projectRef
    ? snapshots.filter((s) => s.manifest.sourceProjectRef === projectRef)
    : snapshots;
  return filtered.map((s) => ({ ...s, kind: 'repo' }));
}

/** R2 source: newest-first valid snapshots for one environment. */
export async function listR2Snapshots({ adapter, bucket, environment, projectRef, limits }) {
  const valid = await listValidSnapshots({
    adapter,
    bucket,
    expectedEnvironment: environment,
    expectedProjectRef: projectRef,
    limits,
  });
  return [...valid].reverse().map((s) => ({ ...s, kind: 'r2' }));
}

async function writeIdentityFile(ageIdentity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), RESTORE_WORKSPACE_PREFIXES.identity));
  try {
    ensurePrivateDir(dir, 0o700);
    const identityFile = path.join(dir, 'identity.txt');
    writePrivateFile(identityFile, `${ageIdentity}\n`);
    return { dir, identityFile };
  } catch (err) {
    // The identity material must never stay behind: the directory is only
    // registered with the caller's cleanup AFTER this function succeeds.
    await removeFiles([dir]);
    throw err;
  }
}

/** Select one snapshot (repository or R2) using the strict `latest`/exact selector. */
async function selectRestoreSnapshot({
  source,
  selector,
  repoRoot,
  environment,
  projectRef,
  adapter,
  bucket,
  limits,
}) {
  const parsedSelector = parseBackupSelector(selector);
  if (source === 'repo') {
    if (!repoRoot) throw new RestoreError('repo source requires repoRoot');
    const snapshots = await listRepositorySnapshots({ repoRoot, environment, projectRef, limits });
    return selectFromSnapshots({ selector: parsedSelector, snapshots });
  }
  if (source === 'r2') {
    if (!adapter || !bucket) throw new RestoreError('r2 source requires an adapter and bucket');
    const snapshots = await listR2Snapshots({ adapter, bucket, environment, projectRef, limits });
    return selectFromSnapshots({ selector: parsedSelector, snapshots });
  }
  throw new RestoreError('source must be one of: r2, repo');
}

/**
 * Acquire the selected snapshot locally: R2 downloads into a tracked private
 * directory (registered with cleanup BEFORE downloading); repo sources are
 * used in place and never owned by this operation.
 */
async function acquireSourceDirectory({ selected, adapter, bucket, cleanupWork, limits }) {
  if (selected.kind !== 'r2') return selected.dir;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), RESTORE_WORKSPACE_PREFIXES.download));
  fs.chmodSync(downloadDir, 0o700);
  cleanupWork.push(downloadDir);
  await downloadSnapshot({
    adapter,
    bucket,
    prefix: selected.prefix,
    manifest: selected.manifest,
    destDir: downloadDir,
    limits,
  });
  return downloadDir;
}

/** Reuse a caller-supplied identity file or materialize one in a tracked dir. */
async function resolveIdentityFile({
  ageIdentity,
  identityFile: identityFileOverride,
  cleanupWork,
}) {
  if (identityFileOverride) return { identityFile: identityFileOverride, identityDir: null };
  const written = await writeIdentityFile(ageIdentity);
  cleanupWork.push(written.dir);
  return { identityFile: written.identityFile, identityDir: written.dir };
}

/** Create the private prepared parent and unpack/verify the snapshot into it. */
async function createPreparedWorkspace({
  sourceDir,
  identityFile,
  environment,
  snapshotId,
  projectRef,
  agePath,
  run,
  signal,
  limits,
  cleanupWork,
}) {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), RESTORE_WORKSPACE_PREFIXES.prepared));
  fs.chmodSync(parentDir, 0o700);
  cleanupWork.push(parentDir);
  return unpackAndVerify({
    sourceDir,
    destDir: path.join(parentDir, 'prepared'),
    identityFile,
    agePath,
    run,
    signal,
    expectedEnvironment: environment,
    expectedSnapshotId: snapshotId,
    expectedProjectRef: projectRef,
    limits,
  });
}

/** Idempotent cleanup owning only the directories created by this operation. */
function makeCleanupClosure(cleanupWork) {
  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    await removeFiles(cleanupWork);
  };
}

/**
 * Acquire, verify, decrypt, and fingerprint a snapshot into a private
 * prepared directory. Returns `{ dir, dataPath, manifest, cleanup }` where
 * `cleanup` is idempotent and must be called by the caller after success or
 * failure. No database connection, confirmation prompt, reset, or restore
 * happens here.
 *
 * @param {object} opts
 * @param {string} opts.environment
 * @param {'r2'|'repo'} opts.source
 * @param {string} opts.selector `latest` or one canonical snapshot ID
 * @param {string} opts.ageIdentity raw identity (only used when no override)
 * @param {string} [opts.agePath]
 * @param {string} [opts.projectRef]
 * @param {string} [opts.repoRoot]
 * @param {object} [opts.adapter]
 * @param {string} [opts.bucket]
 * @param {Function} [opts.run]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.limits]
 * @param {string} [opts.identityFile] caller-supplied identity file (never removed)
 */
export async function prepareRestore(opts) {
  const selected = await selectRestoreSnapshot(opts);
  const cleanupWork = [];
  try {
    const sourceDir = await acquireSourceDirectory({ ...opts, selected, cleanupWork });
    const { identityFile } = await resolveIdentityFile({ ...opts, cleanupWork });
    const created = await createPreparedWorkspace({
      ...opts,
      snapshotId: selected.snapshotId,
      sourceDir,
      identityFile,
      cleanupWork,
    });
    return {
      dir: created.dir,
      dataPath: created.dataPath,
      manifest: created.manifest,
      snapshotId: selected.snapshotId,
      cleanup: makeCleanupClosure(cleanupWork),
    };
  } catch (err) {
    await removeFiles(cleanupWork);
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(`restore preparation failed: ${err.message}`, { cause: err });
  }
}

/** Error text helper: lists available IDs without printing any data. */
export function describeUnavailable(err) {
  if (err instanceof RestoreError && err.availableIds.length > 0) {
    return `valid snapshot IDs: ${err.availableIds.join(', ')}`;
  }
  return null;
}

export { ROW_DATA_FILE, MANIFEST_NAME, parseSnapshotId, formatSnapshotId };
