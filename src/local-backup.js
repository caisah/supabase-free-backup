/**
 * Private local snapshot store for `backup:local`.
 *
 * Owns the fixed `local-backups/<environment>/` tree, a per-environment
 * lock, read-only local-stack connectivity/state checks, the validated
 * existing-snapshot scan, and publish-before-retention finalization. The
 * local stack is READ-ONLY here: nothing starts, stops, resets, or migrates
 * it, and no R2 adapter or hosted DB connection is imported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidSnapshotId } from './fingerprint.js';
import { MANIFEST_NAME, validatePackagedDirectory, sameSnapshotContent } from './snapshot.js';
import { localPsqlQuery } from './local-restore.js';
import {
  LOCAL_BACKUP_DIRECTORY_NAME,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  privateDirectoryProblem,
  privateSnapshotProblem,
} from './local-store.js';

export { LOCAL_BACKUP_DIRECTORY_NAME };

const CANDIDATE_PREFIX = '.candidate-';
const CANDIDATE_NAME_PATTERN = /^\.candidate-[0-9a-f]{16}$/;
const DATABASE_STATE_PATTERN = /^[0-9a-f]{32}\|[0-9a-f]{32}\|[0-9a-f]{32}\|[0-9a-f]{32}$/;
const LOCAL_DATABASE_STATE_QUERY = `
WITH relevant_namespaces AS (
  SELECT oid, nspname, xmin::text AS row_xmin
  FROM pg_namespace
  WHERE nspname !~ '^pg_'
    AND nspname NOT IN (
      'information_schema', 'graphql', 'graphql_public', 'pgsodium', 'pgsodium_masks',
      'pgtle', 'repack', 'tiger', 'tiger_data', 'topology', 'vault', 'etl',
      'extensions', 'pgbouncer', 'realtime', '_analytics', '_realtime', '_supavisor'
    )
    AND nspname NOT LIKE 'timescaledb_%'
    AND nspname NOT LIKE '_timescaledb_%'
), relation_state AS (
  SELECT md5(COALESCE(
    string_agg(to_jsonb(relation_row)::text, E'\\n' ORDER BY schema_name, relation_name),
    ''
  )) AS token
  FROM (
    SELECT n.nspname AS schema_name,
           c.relname AS relation_name,
           c.relkind::text AS relation_kind,
           c.relpersistence::text AS persistence,
           c.relfilenode,
           pg_relation_size(c.oid) AS relation_size,
           COALESCE(s.n_tup_ins, 0) AS inserted,
           COALESCE(s.n_tup_upd, 0) AS updated,
           COALESCE(s.n_tup_del, 0) AS deleted
    FROM pg_class AS c
    JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_all_tables AS s ON s.relid = c.oid
    WHERE c.relkind IN ('r', 'p', 'm', 'f')
  ) AS relation_row
), catalog_entries AS (
  SELECT 'namespace' AS kind, n.oid::text AS object_key, n.row_xmin AS xmin
  FROM relevant_namespaces AS n
  UNION ALL
  SELECT 'class', c.oid::text, c.xmin::text
  FROM pg_class AS c JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'attribute', a.attrelid::text || ':' || a.attnum::text, a.xmin::text
  FROM pg_attribute AS a
  JOIN pg_class AS c ON c.oid = a.attrelid
  JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'default', d.oid::text, d.xmin::text
  FROM pg_attrdef AS d
  JOIN pg_class AS c ON c.oid = d.adrelid
  JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'constraint', c.oid::text, c.xmin::text
  FROM pg_constraint AS c JOIN relevant_namespaces AS n ON n.oid = c.connamespace
  UNION ALL
  SELECT 'index', i.indexrelid::text, i.xmin::text
  FROM pg_index AS i
  JOIN pg_class AS c ON c.oid = i.indrelid
  JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'rewrite', r.oid::text, r.xmin::text
  FROM pg_rewrite AS r
  JOIN pg_class AS c ON c.oid = r.ev_class
  JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'function', p.oid::text, p.xmin::text
  FROM pg_proc AS p JOIN relevant_namespaces AS n ON n.oid = p.pronamespace
  UNION ALL
  SELECT 'trigger', t.oid::text, t.xmin::text
  FROM pg_trigger AS t
  JOIN pg_class AS c ON c.oid = t.tgrelid
  JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'policy', p.oid::text, p.xmin::text
  FROM pg_policy AS p
  JOIN pg_class AS c ON c.oid = p.polrelid
  JOIN relevant_namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'type', t.oid::text, t.xmin::text
  FROM pg_type AS t JOIN relevant_namespaces AS n ON n.oid = t.typnamespace
  UNION ALL
  SELECT 'enum', e.oid::text, e.xmin::text
  FROM pg_enum AS e
  JOIN pg_type AS t ON t.oid = e.enumtypid
  JOIN relevant_namespaces AS n ON n.oid = t.typnamespace
), catalog_state AS (
  SELECT md5(COALESCE(
    string_agg(kind || ':' || object_key || ':' || xmin, E'\\n' ORDER BY kind, object_key),
    ''
  )) AS token
  FROM catalog_entries
), sequence_state AS (
  SELECT md5(COALESCE(
    string_agg(to_jsonb(sequence_row)::text, E'\\n' ORDER BY schemaname, sequencename),
    ''
  )) AS token
  FROM (
    SELECT s.schemaname,
           s.sequencename,
           s.sequenceowner,
           s.data_type::text,
           s.start_value,
           s.min_value,
           s.max_value,
           s.increment_by,
           s.cycle,
           s.cache_size,
           s.last_value
    FROM pg_sequences AS s
    JOIN relevant_namespaces AS n ON n.nspname = s.schemaname
  ) AS sequence_row
), role_state AS (
  SELECT md5(
    COALESCE((
      SELECT string_agg(to_jsonb(role_row)::text, E'\\n' ORDER BY rolname)
      FROM (
        SELECT rolname,
               rolsuper,
               rolinherit,
               rolcreaterole,
               rolcreatedb,
               rolcanlogin,
               rolreplication,
               rolconnlimit,
               rolvaliduntil::text,
               rolbypassrls,
               rolconfig
        FROM pg_roles
      ) AS role_row
    ), '') || E'\\n' ||
    COALESCE((
      SELECT string_agg(to_jsonb(setting_row)::text, E'\\n' ORDER BY setdatabase, setrole)
      FROM (
        SELECT setdatabase, setrole, setconfig
        FROM pg_db_role_setting
      ) AS setting_row
    ), '')
  ) AS token
)
SELECT relation_state.token || '|' || catalog_state.token || '|' ||
       sequence_state.token || '|' || role_state.token
FROM relation_state, catalog_state, sequence_state, role_state`;

export const LOCAL_DATABASE_CHANGED_MESSAGE =
  'local database changed while the backup was being dumped; no snapshot was published; retry when local writes are quiesced';

export class LocalBackupError extends Error {
  constructor(message, { cause, stage } = {}) {
    super(message);
    this.name = 'LocalBackupError';
    this.cause = cause;
    this.stage = stage;
  }
}

/** Static offline guidance; never echoes addresses or credentials. */
export const LOCAL_STACK_OFFLINE_MESSAGE =
  'local stack is not reachable; start the local stack in the Fragtrack workdir (supabase start) and retry';

/**
 * Read-only connectivity gate: require the already-running local stack to
 * answer `SELECT 1` with exactly `1`. No lifecycle command is ever invoked.
 */
export async function assertLocalStackRunning({ dockerPath, dbContainer, run, signal }) {
  let lines;
  try {
    lines = await localPsqlQuery({ dockerPath, dbContainer, query: 'SELECT 1', run, signal });
  } catch (err) {
    throw new LocalBackupError(LOCAL_STACK_OFFLINE_MESSAGE, { cause: err, stage: 'connect' });
  }
  if (lines.length !== 1 || lines[0] !== '1') {
    throw new LocalBackupError(LOCAL_STACK_OFFLINE_MESSAGE, { stage: 'connect' });
  }
  return { ok: true };
}

/**
 * Capture a conservative, database-local state token around the six dumps.
 * It combines relevant-table mutation counters with relation/catalog,
 * sequence, role, and role-setting digests. This avoids cluster-wide false positives
 * while covering ordinary MVCC writes and dump-relevant non-row state. Any
 * change rejects the candidate rather than publishing mixed-state files.
 */
export async function readLocalDatabaseState({ dockerPath, dbContainer, run, signal }) {
  let lines;
  try {
    lines = await localPsqlQuery({
      dockerPath,
      dbContainer,
      query: LOCAL_DATABASE_STATE_QUERY,
      run,
      signal,
    });
  } catch (err) {
    throw new LocalBackupError('cannot verify local database stability for backup', {
      cause: err,
      stage: 'consistency',
    });
  }
  if (lines.length !== 1 || !DATABASE_STATE_PATTERN.test(lines[0])) {
    throw new LocalBackupError('cannot verify local database stability for backup', {
      stage: 'consistency',
    });
  }
  return lines[0];
}

/** Fail closed when the source changed between the pre/post dump probes. */
export function assertLocalDatabaseStateUnchanged(before, after) {
  if (before !== after) {
    throw new LocalBackupError(LOCAL_DATABASE_CHANGED_MESSAGE, { stage: 'consistency' });
  }
}

/** Reject a path that is a symlink or not a directory. */
function assertRealDirectory(dir, label) {
  const problem = privateDirectoryProblem(dir, label);
  if (problem) throw new LocalBackupError(problem);
  return fs.lstatSync(dir);
}

/** Create the directory privately only when it does not exist yet. */
function ensureRealDirectory(dir, label) {
  let exists = false;
  try {
    fs.lstatSync(dir);
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!exists) {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fs.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
  }
  return assertRealDirectory(dir, label);
}

/**
 * Remove real, implementation-owned `.candidate-*` directories left by an
 * interrupted run. Symlinks or unexpected entry types are rejected, never
 * deleted. Runs under the environment lock.
 */
function cleanupStaleCandidates(environmentDir) {
  const entries = fs.readdirSync(environmentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(CANDIDATE_PREFIX)) continue;
    if (!CANDIDATE_NAME_PATTERN.test(entry.name)) {
      throw new LocalBackupError(
        `non-canonical candidate lookalike in local backup store: ${entry.name}; reconcile it manually`,
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new LocalBackupError(
        `unexpected candidate entry in local backup store: ${entry.name}; remove it manually`,
      );
    }
    fs.rmSync(path.join(environmentDir, entry.name), { recursive: true, force: true });
  }
}

/**
 * Open the per-environment local snapshot store.
 *
 * Creates `local-backups/` and `local-backups/<environment>/` privately when
 * absent, rejects symlink/non-directory paths, and takes an exclusive
 * mode-0600 lock scoped by environment. The returned `release()` is
 * idempotent; a setup failure after lock creation releases it before the
 * error propagates. An existing lock is never auto-deleted: the error names
 * the lock path and instructs the operator to confirm no matching command is
 * active before removing it.
 */
export function openLocalBackupStore({ repoRoot, environment }) {
  const root = path.join(repoRoot, LOCAL_BACKUP_DIRECTORY_NAME);
  ensureRealDirectory(root, `local backup store root (${LOCAL_BACKUP_DIRECTORY_NAME}/)`);
  const environmentDir = path.join(root, environment);
  ensureRealDirectory(
    environmentDir,
    `local backup store (${LOCAL_BACKUP_DIRECTORY_NAME}/${environment})`,
  );

  const lockPath = path.join(root, `.lock-${environment}`);
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx', PRIVATE_FILE_MODE);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new LocalBackupError(
        `another local backup command holds the lock ${lockPath}; confirm no matching command is active, then remove the lock file and retry`,
        { stage: 'lock' },
      );
    }
    throw new LocalBackupError('cannot acquire the local backup lock', {
      cause: err,
      stage: 'lock',
    });
  }

  const lockToken = randomUUID();
  let lockIdentity;
  try {
    fs.fchmodSync(lockFd, PRIVATE_FILE_MODE);
    fs.writeFileSync(lockFd, `${lockToken}\n`, 'utf8');
    fs.fsyncSync(lockFd);
    lockIdentity = fs.fstatSync(lockFd);
  } catch (err) {
    try {
      fs.closeSync(lockFd);
    } finally {
      lockFd = null;
      fs.rmSync(lockPath, { force: true });
    }
    throw new LocalBackupError('cannot initialize the local backup lock', {
      cause: err,
      stage: 'lock',
    });
  }

  let released = false;
  const release = () => {
    if (released) return;
    const failures = [];
    let unlinked = false;
    try {
      const current = fs.lstatSync(lockPath);
      const expectedSize = Buffer.byteLength(`${lockToken}\n`);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== lockIdentity.dev ||
        current.ino !== lockIdentity.ino ||
        current.size !== expectedSize
      ) {
        throw new LocalBackupError(
          'local backup lock ownership changed; refusing to remove another process lock',
          { stage: 'lock-release' },
        );
      }
      const currentToken = fs.readFileSync(lockPath, 'utf8').trim();
      if (currentToken !== lockToken) {
        throw new LocalBackupError(
          'local backup lock ownership changed; refusing to remove another process lock',
          { stage: 'lock-release' },
        );
      }
      fs.unlinkSync(lockPath);
      unlinked = true;
    } catch (err) {
      failures.push(
        err instanceof LocalBackupError
          ? err
          : new LocalBackupError('cannot verify or remove the owned local backup lock', {
              cause: err,
              stage: 'lock-release',
            }),
      );
    }

    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch (err) {
        failures.push(
          new LocalBackupError('cannot close the owned local backup lock', {
            cause: err,
            stage: 'lock-release',
          }),
        );
      } finally {
        lockFd = null;
      }
    }
    if (unlinked) released = true;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new LocalBackupError(
        'multiple failures occurred while releasing the local backup lock',
        {
          cause: new AggregateError(failures),
          stage: 'lock-release',
        },
      );
    }
  };

  try {
    cleanupStaleCandidates(environmentDir);
  } catch (err) {
    try {
      release();
    } catch (releaseError) {
      throw new AggregateError([err, releaseError], err.message, { cause: err });
    }
    throw err;
  }

  return { root, environmentDir, lockPath, release };
}

/** Require private modes for every retained local snapshot path. */
function assertPrivateSnapshotModes(dir, manifest) {
  const problem = privateSnapshotProblem(dir, [
    ...manifest.files.map((file) => file.name),
    MANIFEST_NAME,
  ]);
  if (problem) throw new LocalBackupError(problem, { stage: 'permissions' });
}

/**
 * Scan the environment directory for completed snapshots after store
 * preparation removed stale candidates. Every remaining entry must be a
 * canonical snapshot-ID directory that passes full packaged validation;
 * anything else is a hard error, never ignored or deleted. Returns valid
 * snapshots newest first as `[{ dir, snapshotId, manifest }]`, so a prior
 * post-publication retention failure can be reconciled from the survivors.
 */
export async function scanLocalBackupSnapshots({ environmentDir, environment }) {
  let entries;
  try {
    entries = fs.readdirSync(environmentDir, { withFileTypes: true });
  } catch (err) {
    throw new LocalBackupError(`cannot read local backup store: ${err.message}`, { cause: err });
  }
  const snapshots = [];
  for (const entry of entries) {
    if (entry.name.startsWith(CANDIDATE_PREFIX)) {
      throw new LocalBackupError(
        `unexpected candidate entry found during scan: ${entry.name}; reconcile it manually`,
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new LocalBackupError(
        `unexpected entry in local backup store: ${entry.name}; reconcile it manually`,
      );
    }
    if (!isValidSnapshotId(entry.name)) {
      throw new LocalBackupError(`non-canonical snapshot directory: ${entry.name}`);
    }
    const dir = path.join(environmentDir, entry.name);
    const { manifest } = await validatePackagedDirectory(dir, {
      expectedEnvironment: environment,
      expectedSnapshotId: entry.name,
    });
    assertPrivateSnapshotModes(dir, manifest);
    snapshots.push({ dir, snapshotId: entry.name, manifest });
  }
  snapshots.sort((a, b) =>
    a.snapshotId < b.snapshotId ? 1 : a.snapshotId > b.snapshotId ? -1 : 0,
  );
  return snapshots;
}

/**
 * Create a unique private candidate parent under the environment directory.
 * `candidate.pkgDir` is left NONEXISTENT so `packageSnapshot` owns its
 * creation (it rejects a pre-existing destination).
 */
export function createLocalBackupCandidate({ environmentDir }) {
  let candidateDir = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `${CANDIDATE_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const dir = path.join(environmentDir, name);
    try {
      fs.mkdirSync(dir, { mode: PRIVATE_DIRECTORY_MODE });
      candidateDir = dir;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  if (!candidateDir) {
    throw new LocalBackupError('cannot allocate a private candidate directory', {
      stage: 'candidate',
    });
  }
  const pkgDir = path.join(candidateDir, 'pkg');
  return { candidateDir, pkgDir, published: false };
}

/** Default old-snapshot removal; injectable for retention-failure tests. */
export async function removeLocalSnapshot(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/** fsync one file or directory and surface unsupported durability semantics. */
function syncLocalPath(target, label) {
  let fd = null;
  let failure = null;
  try {
    fd = fs.openSync(target, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    failure = err;
  }
  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch (err) {
      failure = failure ?? err;
    }
  }
  if (failure) {
    throw new LocalBackupError(`cannot durably sync ${label}`, {
      cause: failure,
      stage: 'durability',
    });
  }
}

/** Flush every validated package file, then its directory entries. */
function syncLocalSnapshot(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new LocalBackupError(`cannot durably sync invalid snapshot entry ${entry.name}`, {
        stage: 'durability',
      });
    }
    syncLocalPath(path.join(dir, entry.name), 'snapshot file');
  }
  syncLocalPath(dir, 'snapshot directory');
}

/** Flush publication or retention changes in the environment directory. */
function syncLocalDirectory(dir) {
  syncLocalPath(dir, 'local backup environment directory');
}

/**
 * Finalize a validated candidate package.
 *
 * The caller has already fully validated `candidate.pkgDir` for the expected
 * environment, snapshot ID, and target project ref BEFORE calling this.
 *
 * - unchanged (same encrypted content + same target project ref as the
 *   newest validated snapshot): removes only validated snapshots OLDER than
 *   newest, retains newest, returns `{ changed: false, ... }`.
 * - changed: fails without deletion if the canonical final path exists, then
 *   atomically renames `candidate.pkgDir` -> `final` (same filesystem, never
 *   a copy), marks the candidate published, and only then removes every
 *   previously validated snapshot. Any failure keeps at least the newest
 *   pre-existing snapshot; a retention failure leaves the new output present.
 */
export async function finalizeLocalBackup({
  candidate,
  candidateManifest,
  existingSnapshots = [],
  environmentDir,
  snapshotId,
  removeSnapshot = removeLocalSnapshot,
  syncSnapshot = syncLocalSnapshot,
  syncDirectory = syncLocalDirectory,
}) {
  const newest = existingSnapshots.length > 0 ? existingSnapshots[0] : null;
  const same = newest !== null && sameContentAndRef(newest.manifest, candidateManifest);

  if (same) {
    for (const snapshot of existingSnapshots.slice(1)) {
      await removeSnapshot(snapshot.dir);
    }
    if (existingSnapshots.length > 1) await syncDirectory(environmentDir);
    return { changed: false, snapshotId: newest.snapshotId, path: newest.dir, published: false };
  }

  const final = path.join(environmentDir, snapshotId);
  if (pathExists(final)) {
    throw new LocalBackupError(`refusing to overwrite existing snapshot ${final}`, {
      stage: 'publish',
    });
  }
  await syncSnapshot(candidate.pkgDir);
  fs.renameSync(candidate.pkgDir, final);
  candidate.published = true;
  await syncDirectory(environmentDir);
  for (const snapshot of existingSnapshots) {
    await removeSnapshot(snapshot.dir);
  }
  if (existingSnapshots.length > 0) await syncDirectory(environmentDir);
  return { changed: true, snapshotId, path: final, published: true };
}

function sameContentAndRef(leftManifest, rightManifest) {
  return (
    sameSnapshotContent(leftManifest, rightManifest) &&
    leftManifest.sourceProjectRef === rightManifest.sourceProjectRef
  );
}

/** lstat-based existence that also sees dangling symlinks. */
function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
