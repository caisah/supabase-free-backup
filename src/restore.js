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
 *
 * Invariant: local-store snapshots carry the fixed store label `local` and
 * their source project ref as metadata only — the hosted restore target is
 * chosen at RESTORE time and is never expected on a local snapshot's
 * manifest (see `selectRestoreSnapshot`). The selected snapshot's source
 * ref is surfaced to the caller so the operator can acknowledge it.
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
import { LOCAL_STORE_ENVIRONMENT } from './config.js';
import { ensurePrivateDir, writePrivateFile, removeFiles } from './encryption.js';
import {
  LOCAL_BACKUP_DIRECTORY_NAME,
  PRIVATE_DIRECTORY_MODE,
  privateDirectoryProblem,
  privateSnapshotProblem,
  sortSnapshotsNewestFirst,
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
 * Private local-store source: newest-first valid snapshots from the single
 * fixed private store, whose directory label is LOCAL_STORE_ENVIRONMENT
 * (see src/config.js). Both hosted restore targets read the SAME store, so
 * no environment or project-ref matching applies: a snapshot in this store
 * may be restored into any hosted target by explicit operator choice
 * (`restore:development|restore:production --source local`). The store root
 * and environment directory must satisfy the private-path policy (real 0700
 * directories, never symlinks) or the listing FAILS CLOSED: a world-writable
 * store could substitute manifests and row data, so no snapshot from it is
 * trusted. Individual malformed or non-canonical entries are skipped like
 * repository scanning, but every canonical-but-skipped snapshot is returned
 * as a warning so `latest` can never silently degrade to an older snapshot.
 * A missing store is an empty listing.
 */
export async function listLocalSnapshots({ repoRoot, limits }) {
  const storeRoot = path.join(repoRoot, LOCAL_BACKUP_DIRECTORY_NAME);
  const environmentDir = path.join(storeRoot, LOCAL_STORE_ENVIRONMENT);
  const snapshots = [];
  const warnings = [];
  // The store-root policy is evaluated BEFORE the existence short-circuit:
  // an ABSENT store/root is an empty listing, but an EXISTING untrusted
  // (world-writable/symlink) store root fails closed even when the
  // environment directory is missing — an empty result must never be the
  // verdict for a store whose trust boundary is gone.
  let rootProblem = null;
  try {
    fs.lstatSync(storeRoot);
    rootProblem = privateDirectoryProblem(storeRoot, 'local backup store root');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (rootProblem) throw new RestoreError(rootProblem);
  let entries;
  try {
    entries = await fs.promises.readdir(environmentDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { snapshots, warnings };
    throw new RestoreError(`cannot read local backup store: ${err.message}`, { cause: err });
  }
  const environmentProblem = privateDirectoryProblem(environmentDir, 'local backup store');
  if (environmentProblem) throw new RestoreError(environmentProblem);

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSnapshotId(entry.name)) continue;
    const dir = path.join(environmentDir, entry.name);
    try {
      const { manifest } = await validatePackagedDirectory(dir, {
        expectedEnvironment: LOCAL_STORE_ENVIRONMENT,
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
  return {
    snapshots: sortSnapshotsNewestFirst(snapshots).map((s) => ({ ...s, kind: 'local' })),
    warnings,
  };
}

async function writeIdentityFile(ageIdentity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-identity-'));
  try {
    ensurePrivateDir(dir, PRIVATE_DIRECTORY_MODE);
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

/**
 * Select one snapshot (repository, R2, or local) using the strict
 * `latest`/exact selector. Returns the selected snapshot, its skip warnings,
 * and the VERIFICATION EXPECTATIONS for that source: local snapshots are
 * verified against the fixed store label with NO project ref (the store
 * feeds any hosted target), while repo/r2 snapshots are verified against the
 * requested environment and project ref. Source-specific policy lives here
 * with source-specific selection; `prepareRestore` never branches on source.
 */
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
    const { snapshots, warnings } = await listLocalSnapshots({ repoRoot, limits });
    let selected;
    try {
      selected = selectFromSnapshots({ selector: parsedSelector, snapshots });
    } catch (err) {
      // Skip warnings (malformed local snapshots) are diagnostic even when an
      // exact-ID selection fails: keep them on the thrown error.
      if (err instanceof RestoreError) err.warnings = warnings;
      throw err;
    }
    return {
      selected,
      warnings,
      verificationEnvironment: LOCAL_STORE_ENVIRONMENT,
      verificationProjectRef: undefined,
    };
  }
  if (source === 'repo') {
    if (!repoRoot) throw new RestoreError('repo source requires repoRoot');
    const snapshots = await listRepositorySnapshots({ repoRoot, environment, projectRef, limits });
    return {
      selected: selectFromSnapshots({ selector: parsedSelector, snapshots }),
      warnings: [],
      verificationEnvironment: environment,
      verificationProjectRef: projectRef,
    };
  }
  if (source === 'r2') {
    if (!adapter || !bucket) throw new RestoreError('r2 source requires an adapter and bucket');
    const snapshots = await listR2Snapshots({ adapter, bucket, environment, projectRef, limits });
    return {
      selected: selectFromSnapshots({ selector: parsedSelector, snapshots }),
      warnings: [],
      verificationEnvironment: environment,
      verificationProjectRef: projectRef,
    };
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
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-download-'));
  fs.chmodSync(downloadDir, PRIVATE_DIRECTORY_MODE);
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
  verificationEnvironment,
  verificationProjectRef,
  snapshotId,
  agePath,
  run,
  signal,
  limits,
  cleanupWork,
}) {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-prepared-'));
  fs.chmodSync(parentDir, PRIVATE_DIRECTORY_MODE);
  cleanupWork.push(parentDir);
  return unpackAndVerify({
    sourceDir,
    destDir: path.join(parentDir, 'prepared'),
    identityFile,
    agePath,
    run,
    signal,
    expectedEnvironment: verificationEnvironment,
    expectedSnapshotId: snapshotId,
    expectedProjectRef: verificationProjectRef,
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
 * `{ dir, dataPath, manifest, snapshotId, sourceProjectRef, warnings,
 * cleanup }` where `cleanup` is idempotent and must be called by the caller
 * after success or failure. No database connection, confirmation prompt,
 * reset, or restore happens here. Verification expectations (environment /
 * project ref) are owned by the source selector: local snapshots verify
 * against the single store label LOCAL_STORE_ENVIRONMENT with NO project
 * ref, because the local store feeds any hosted target chosen by the
 * operator; the hosted target's environment/ref are never expected on a
 * local snapshot.
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
  const { selected, warnings, verificationEnvironment, verificationProjectRef } =
    await selectRestoreSnapshot(opts);
  const cleanupWork = [];
  try {
    const sourceDir = await acquireSourceDirectory({ ...opts, selected, cleanupWork });
    const { identityFile } = await resolveIdentityFile({ ...opts, cleanupWork });
    const created = await createPreparedWorkspace({
      ...opts,
      snapshotId: selected.snapshotId,
      sourceDir,
      identityFile,
      verificationEnvironment,
      verificationProjectRef,
      cleanupWork,
    });
    return {
      dir: created.dir,
      dataPath: created.dataPath,
      manifest: created.manifest,
      snapshotId: selected.snapshotId,
      // The snapshot's origin project (from the verified manifest). Restore
      // targets must surface this to the operator: a local snapshot can be
      // restored into ANY hosted target, so the source ref is the only
      // binding that says what project this data actually came from.
      sourceProjectRef: selected.manifest.sourceProjectRef,
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
