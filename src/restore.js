/**
 * Restore source acquisition and verification.
 *
 * The common NON-DESTRUCTIVE preparation path: select a snapshot
 * (repository, R2, or the private local store), acquire it privately,
 * verify every stored artifact, restore row data per the manifest codec
 * (decryption applies ONLY to age-format snapshots, which still require the
 * identity file), and recompute the aggregate logical fingerprint BEFORE
 * any restore target is touched. Never connects to a database and never
 * prompts for confirmation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSnapshotId, isValidSnapshotId, formatSnapshotId } from './fingerprint.js';
import {
  unpackAndVerify,
  validatePackagedDirectory,
  ROW_DATA_FILE,
  MANIFEST_NAME,
} from './snapshot.js';
import { scanRepositorySnapshots } from './repository.js';
import { listValidSnapshots, downloadSnapshot, createS3Adapter } from './r2.js';
import { ensurePrivateDir, writePrivateFile, removeFiles } from './encryption.js';
import {
  LOCAL_BACKUP_DIRECTORY_NAME,
  privateDirectoryProblem,
  privateSnapshotProblem,
} from './local-store.js';

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

/**
 * Private local-store source: newest-first valid snapshots for one
 * environment. The store root and environment directories must satisfy the
 * private-path policy (real 0700 directories, never symlinks) or the
 * listing FAILS CLOSED: a world-writable store could substitute manifests
 * and row data, so no snapshot from it is trusted. Individual malformed or
 * non-canonical entries are skipped like repository scanning, but every
 * canonical-but-skipped snapshot is returned as a warning so `latest` can
 * never silently degrade to an older snapshot. A missing store is an empty
 * listing; a project-ref filter applies.
 */
export async function listLocalSnapshots({ repoRoot, environment, projectRef, limits }) {
  const storeRoot = path.join(repoRoot, LOCAL_BACKUP_DIRECTORY_NAME);
  const environmentDir = path.join(storeRoot, environment);
  const snapshots = [];
  const warnings = [];
  let entries;
  try {
    entries = await fs.promises.readdir(environmentDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { snapshots, warnings };
    throw new RestoreError(`cannot read local backup store: ${err.message}`, { cause: err });
  }
  const rootProblem = privateDirectoryProblem(storeRoot, 'local backup store root');
  if (rootProblem) throw new RestoreError(rootProblem);
  const environmentProblem = privateDirectoryProblem(environmentDir, 'local backup store');
  if (environmentProblem) throw new RestoreError(environmentProblem);

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSnapshotId(entry.name)) continue;
    const dir = path.join(environmentDir, entry.name);
    try {
      const { manifest } = await validatePackagedDirectory(dir, {
        expectedEnvironment: environment,
        expectedSnapshotId: entry.name,
        limits,
      });
      const modeProblem = privateSnapshotProblem(dir, [
        ...manifest.files.map((f) => f.name),
        MANIFEST_NAME,
      ]);
      if (modeProblem) {
        warnings.push(`skipped local snapshot ${entry.name}: ${modeProblem}`);
        continue;
      }
      snapshots.push({ dir, snapshotId: entry.name, manifest });
    } catch (err) {
      warnings.push(`skipped local snapshot ${entry.name}: ${err.message ?? String(err)}`);
    }
  }
  snapshots.sort((a, b) =>
    a.snapshotId < b.snapshotId ? 1 : a.snapshotId > b.snapshotId ? -1 : 0,
  );
  const filtered = projectRef
    ? snapshots.filter((s) => s.manifest.sourceProjectRef === projectRef)
    : snapshots;
  return { snapshots: filtered.map((s) => ({ ...s, kind: 'local' })), warnings };
}

async function writeIdentityFile(ageIdentity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fragtrack-identity-'));
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

/** Select one snapshot (repository, R2, or local) using the strict `latest`/exact selector. */
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
  if (source === 'local') {
    if (!repoRoot) throw new RestoreError('local source requires repoRoot');
    const { snapshots, warnings } = await listLocalSnapshots({
      repoRoot,
      environment,
      projectRef,
      limits,
    });
    return {
      selected: selectFromSnapshots({ selector: parsedSelector, snapshots }),
      warnings,
    };
  }
  if (source === 'repo') {
    if (!repoRoot) throw new RestoreError('repo source requires repoRoot');
    const snapshots = await listRepositorySnapshots({ repoRoot, environment, projectRef, limits });
    return { selected: selectFromSnapshots({ selector: parsedSelector, snapshots }), warnings: [] };
  }
  if (source === 'r2') {
    if (!adapter || !bucket) throw new RestoreError('r2 source requires an adapter and bucket');
    const snapshots = await listR2Snapshots({ adapter, bucket, environment, projectRef, limits });
    return { selected: selectFromSnapshots({ selector: parsedSelector, snapshots }), warnings: [] };
  }
  throw new RestoreError('source must be one of: r2, repo, local');
}

/**
 * Acquire the selected snapshot locally: R2 downloads into a tracked private
 * directory (registered with cleanup BEFORE downloading); repo sources are
 * used in place and never owned by this operation.
 */
async function acquireSourceDirectory({ selected, adapter, bucket, cleanupWork, limits }) {
  if (selected.kind !== 'r2') return selected.dir;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fragtrack-download-'));
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
  if (!ageIdentity) return { identityFile: null, identityDir: null };
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
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fragtrack-prepared-'));
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
 * Acquire, verify, restore row data (decrypt only for age formats), and
 * fingerprint a snapshot into a private prepared directory. Returns
 * `{ dir, dataPath, manifest, cleanup }` where `cleanup` is idempotent and
 * must be called by the caller after success or failure. No database
 * connection, confirmation prompt, reset, or restore happens here.
 *
 * @param {object} opts
 * @param {string} opts.environment
 * @param {'r2'|'repo'|'local'} opts.source
 * @param {string} opts.selector `latest` or one canonical snapshot ID
 * @param {string} [opts.ageIdentity] raw identity (only used when no override)
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
  const { selected, warnings } = await selectRestoreSnapshot(opts);
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
      // Snapshot-level skip warnings (local store): surfaced so `latest` can
      // never silently degrade to an older snapshot.
      warnings,
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
