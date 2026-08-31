/**
 * Weekly Git snapshot handling: repository scanning, staged-snapshot planning,
 * and append-only dated directory copying. Dated directories under `backups/` are
 * never overwritten; malformed repository snapshots are never selected but
 * reported as warnings instead of being deleted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import {
  validatePackagedDirectory,
  MANIFEST_NAME,
  resolvePrivatePath,
  sameSnapshotContent,
} from './snapshot.js';
import { isValidSnapshotId } from './fingerprint.js';
import { removeFiles } from './encryption.js';
import { sha256Readable } from './stream.js';

export const BACKUP_ENVIRONMENTS = ['development', 'production'];

export class RepositoryError extends Error {
  constructor(message, { warnings = [] } = {}) {
    super(message);
    this.name = 'RepositoryError';
    this.warnings = warnings;
  }
}

/**
 * Scan one environment's dated snapshot directories. Only canonical snapshot
 * IDs with valid manifests matching the directory name are selected;
 * everything else is reported as a warning. Returns newest-first sorted
 * entries [{ dir, snapshotId, manifest }].
 */
export async function scanRepositorySnapshots({ repoRoot, environment }) {
  const backupsRoot = path.join(repoRoot, 'backups', environment);
  const warnings = [];
  const valid = [];
  let entries;
  try {
    entries = fs.readdirSync(backupsRoot, { withFileTypes: true });
  } catch {
    return { snapshots: [], warnings: [] }; // no backups yet: empty repository
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      warnings.push(`ignoring non-directory entry ${entry.name}`);
      continue;
    }
    if (!isValidSnapshotId(entry.name)) {
      warnings.push(`ignoring non-canonical snapshot directory ${entry.name}`);
      continue;
    }
    const dir = path.join(backupsRoot, entry.name);
    try {
      const { manifest } = await validatePackagedDirectory(dir, {
        expectedEnvironment: environment,
        expectedSnapshotId: entry.name,
      });
      valid.push({ dir, snapshotId: entry.name, manifest });
    } catch (err) {
      warnings.push(`ignoring invalid snapshot ${entry.name}: ${err.message}`);
    }
  }
  valid.sort((a, b) => (a.snapshotId < b.snapshotId ? 1 : a.snapshotId > b.snapshotId ? -1 : 0));
  return { snapshots: valid, warnings };
}

export function newestOf(entries) {
  return entries.length > 0 ? entries[0] : null;
}

/**
 * Deterministic weekly plan for one environment.
 *
 * @param {object} opts
 * @param {{snapshotId:string, manifest:object}|null} opts.existing newest committed valid snapshot
 * @param {{snapshotId:string, manifest:object}|null} opts.staged staged snapshot awaiting the weekly commit
 * @returns {{action:'add'|'skip'|'reject', reason:string}}
 */
export function planWeekly({ existing, staged }) {
  if (!staged) {
    return { action: 'skip', reason: 'no staged snapshot' };
  }
  if (existing) {
    if (existing.snapshotId === staged.snapshotId) {
      return { action: 'skip', reason: 'staged snapshot already committed' };
    }
    if (staged.snapshotId < existing.snapshotId) {
      return {
        action: 'reject',
        reason: 'staged snapshot older than the newest committed snapshot',
      };
    }
    const sameContent = sameSnapshotContent(existing.manifest, staged.manifest);
    if (sameContent) {
      return { action: 'skip', reason: 'identical content and recipient' };
    }
  }
  return { action: 'add', reason: 'changed content' };
}

/**
 * Copy a validated staged snapshot into `backups/<environment>/<id>/`.
 * Copies only manifest-allowlisted files, recomputes hashes after copy, and
 * removes any partial destination on failure. Destination collisions fail
 * without overwriting.
 */
export async function copyStagedSnapshot({
  stagingDir,
  repoRoot,
  environment,
  manifest,
  snapshotId,
}) {
  const destDir = path.join(repoRoot, 'backups', environment, snapshotId);
  if (fs.existsSync(destDir)) {
    throw new RepositoryError(`destination already exists: ${environment}/${snapshotId}`);
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true, mode: 0o700 });
  const tmpDest = path.join(path.dirname(destDir), `.tmp-${snapshotId}`);
  fs.rmSync(tmpDest, { recursive: true, force: true });
  fs.mkdirSync(tmpDest, { mode: 0o700 });
  try {
    for (const entry of manifest.files) {
      const source = resolvePrivatePath(stagingDir, entry.name);
      const target = resolvePrivatePath(tmpDest, entry.name);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
      await verifySizeAndHash(target, entry);
    }
    const manifestSource = resolvePrivatePath(stagingDir, MANIFEST_NAME);
    const manifestTarget = resolvePrivatePath(tmpDest, MANIFEST_NAME);
    fs.copyFileSync(manifestSource, manifestTarget);
    fs.chmodSync(manifestTarget, 0o600);
    // Atomic-ish publish: rename only after every hash verified.
    fs.renameSync(tmpDest, destDir);
    return destDir;
  } catch (err) {
    await removeFiles([tmpDest]);
    if (!(err instanceof RepositoryError)) {
      throw new RepositoryError(`staged snapshot copy failed: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

async function verifySizeAndHash(filePath, entry) {
  const stat = fs.statSync(filePath);
  if (stat.size !== entry.size) {
    throw new RepositoryError(`size mismatch after copy: ${entry.name}`);
  }
  const actual = await sha256Readable(createReadStream(filePath));
  if (actual !== entry.sha256) {
    throw new RepositoryError(`checksum mismatch after copy: ${entry.name}`);
  }
}

/**
 * Validate a staging directory produced by the backup entry point:
 * `<stagingDir>/<environment>/<snapshotId>/{files,manifest.json}`.
 * Returns a map environment -> { dir, snapshotId, manifest } for zero or one
 * snapshot per environment. Malformed staged snapshots throw (nothing may be
 * copied from them). Symlinks/traversal/unknown files fail validation.
 */
export async function loadStagedSnapshots({
  stagingDir,
  environments = BACKUP_ENVIRONMENTS,
  logger,
}) {
  const found = {};
  for (const environment of environments) {
    const envDir = path.join(stagingDir, environment);
    let envEntries;
    try {
      envEntries = fs.readdirSync(envDir, { withFileTypes: true });
    } catch {
      continue; // no staged snapshot for this environment
    }
    const dirs = envEntries.filter((e) => e.isDirectory());
    const canonicalDirs = dirs.filter((e) => isValidSnapshotId(e.name));
    if (dirs.length > 1 || (dirs.length === 1 && !canonicalDirs.length)) {
      const bad = dirs.find((e) => !isValidSnapshotId(e.name));
      throw new RepositoryError(
        `staging directory contains an invalid snapshot directory for ${environment}: ${bad?.name ?? 'multiple staged snapshots'}`,
      );
    }
    if (canonicalDirs.length === 0) {
      continue;
    }
    const dir = path.join(envDir, canonicalDirs[0].name);
    const snapshotId = canonicalDirs[0].name;
    const { manifest } = await validatePackagedDirectory(dir, {
      expectedEnvironment: environment,
      expectedSnapshotId: snapshotId,
    });
    found[environment] = { dir, snapshotId, manifest };
    if (logger) logger.status(`staged ${environment}: ${snapshotId}`);
  }
  return found;
}
