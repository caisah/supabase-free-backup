/**
 * Dependency-neutral local-backup store layout and private-path policy,
 * shared by the backup-side store scan (src/local-backup.js) and the
 * restore-side scan (src/restore.js).
 *
 * Nothing here may import an operational module (backup/restore/database):
 * this module exists so the NON-destructive restore preparation layer can
 * enforce the store's trust boundary without transitively loading the
 * destructive restore pipelines.
 *
 * Mode policy is POSIX-only by design: on Windows the checks are skipped
 * because DACLs (not 0700/0600 modes) enforce the trust boundary. This is a
 * documented OS-dependent fail-closed boundary, not an oversight.
 */

import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_BACKUP_DIRECTORY_NAME = 'local-backups';
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Order snapshots newest-first by descending canonical snapshot id. The
 * single shared comparator for every local-store listing (backup-side scan,
 * restore-side listing, publish comparison). */
export function sortSnapshotsNewestFirst(snapshots) {
  return [...snapshots].sort((a, b) =>
    a.snapshotId < b.snapshotId ? 1 : a.snapshotId > b.snapshotId ? -1 : 0,
  );
}

/**
 * Human-readable problem when `dir` is not a real (non-symlink) private 0700
 * directory; null when it satisfies the policy. Uses lstat so a symlink is
 * never followed into the store.
 */
export function privateDirectoryProblem(dir, label) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return `${label} is not a directory: ${dir}`;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return `${label} must be a real directory, not a symlink or file: ${dir}`;
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    return `${label} has unsafe permissions; require mode 0700`;
  }
  return null;
}

/**
 * Human-readable problem when a packaged snapshot directory or any of its
 * stored files violates the private-path policy; null when the package
 * satisfies it. On POSIX the directory must be 0700 and every stored file
 * 0600; symlink substitution is rejected via lstat.
 */
export function privateSnapshotProblem(dir, storedNames) {
  const dirProblem = privateDirectoryProblem(dir, 'completed local snapshot directory');
  if (dirProblem) return dirProblem;
  if (process.platform === 'win32') return null;
  for (const name of storedNames) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(dir, name));
    } catch {
      return `completed local snapshot file is missing or invalid: ${name}`;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      return `completed local snapshot file has unsafe permissions: ${name}; require mode 0600`;
    }
  }
  return null;
}
