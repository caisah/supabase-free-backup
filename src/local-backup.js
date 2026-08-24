/**
 * Private local snapshot store for `backup:local`.
 *
 * Owns the fixed `local-backups/<environment>/` tree, a per-environment
 * lock, read-only local-stack connectivity/state checks (backed by a held
 * PostgreSQL write barrier during the dump window), the validated
 * existing-snapshot scan, and publish-before-retention finalization. The
 * local stack is READ-ONLY outside the dump window: nothing starts, stops,
 * resets, or migrates it, and no R2 adapter or hosted DB connection is
 * imported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { isValidSnapshotId } from './fingerprint.js';
import { MANIFEST_NAME, validatePackagedDirectory, sameEncryptedContent } from './snapshot.js';
import { localPsqlQuery } from './local-project.js';

export const LOCAL_BACKUP_DIRECTORY_NAME = 'local-backups';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CANDIDATE_PREFIX = '.candidate-';
const CANDIDATE_SUFFIX_LENGTH = 16;
const CANDIDATE_NAME_PATTERN = new RegExp(
  `^${CANDIDATE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f]{${CANDIDATE_SUFFIX_LENGTH}}$`,
);
const DATABASE_STATE_PATTERN = /^[0-9a-f]{32}\|[0-9a-f]{32}\|[0-9a-f]{32}\|[0-9a-f]{32}$/;

/**
 * The single declaration of the local consistency-guard scope: every
 * non-system schema. The CLI dumps every user schema (data dump excludes
 * only two storage tables), so a guard that excludes any application or
 * managed schema would silently stop watching dump content; declaring the
 * scope as a superset here makes drift from the dump commands impossible.
 */
const USER_NAMESPACE_PREDICATE = "nspname !~ '^pg_' AND nspname <> 'information_schema'";

/** Session-scoped advisory key proving the barrier holder is alive. */
const BARRIER_ADVISORY_LOCK = Object.freeze({ classid: 1900701, objid: 424201 });
/**
 * State token over the FULL consistency-guard scope (all non-system
 * schemas): per-relation mutation counters, catalog row xmins, sequence
 * values, roles, role memberships, default privileges, and per-database role
 * settings. It is a backstop to the SHARE-mode write barrier: the barrier
 * blocks row writes during the dump window, and this token rejects the
 * candidate if any sequence/catalog/role state moves anyway.
 */
const LOCAL_DATABASE_STATE_QUERY = `
WITH relevant_namespaces AS (
  SELECT oid, nspname, xmin::text AS row_xmin
  FROM pg_namespace
  WHERE ${USER_NAMESPACE_PREDICATE}
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
      SELECT string_agg(to_jsonb(member_row)::text, E'\\n' ORDER BY roleid, member)
      FROM (
        SELECT roleid,
               member,
               grantor,
               admin_option,
               inherit_option,
               set_option
        FROM pg_auth_members
      ) AS member_row
    ), '') || E'\\n' ||
    COALESCE((
      SELECT string_agg(to_jsonb(acl_row)::text, E'\\n' ORDER BY defaclrole, defaclnamespace, defaclobjtype)
      FROM (
        SELECT defaclrole,
               defaclnamespace,
               defaclobjtype,
               defaclacl
        FROM pg_default_acl
      ) AS acl_row
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

/**
 * True only when the barrier is fully ready: the holder's advisory marker is
 * granted (holder alive and script started) AND no SHARE-mode relation lock
 * is still waiting. A pending SHARE request means an in-flight writer holds
 * a conflicting lock, so the dumps must not start yet; once granted, every
 * pre-existing writer has committed and is part of all six dumps.
 */
const LOCAL_DATABASE_BARRIER_READY_QUERY = `
SELECT
  (SELECT NOT bool_or(NOT granted)
     FROM pg_locks
    WHERE locktype = 'advisory'
      AND classid = ${BARRIER_ADVISORY_LOCK.classid}
      AND objid = ${BARRIER_ADVISORY_LOCK.objid}
      AND pid <> pg_backend_pid()) = 't'
  AND NOT EXISTS (
    SELECT 1 FROM pg_locks
    WHERE locktype = 'relation' AND mode = 'ShareLock' AND NOT granted
  )
`;

/** psql script fed to the held-open barrier session (block writers, allow readers). */
export function buildLocalDatabaseBarrierScript() {
  return [
    'BEGIN;',
    `SELECT pg_advisory_lock(${BARRIER_ADVISORY_LOCK.classid}, ${BARRIER_ADVISORY_LOCK.objid});`,
    'DO $block$',
    'DECLARE',
    '  lock_sql text;',
    'BEGIN',
    "  SELECT 'LOCK TABLE ' || string_agg(format('%I.%I', ns.nspname, c.relname), ', ') || ' IN SHARE MODE'",
    '    INTO lock_sql',
    '    FROM pg_class AS c',
    `    JOIN (SELECT oid, nspname FROM pg_namespace WHERE ${USER_NAMESPACE_PREDICATE}) AS ns`,
    '      ON ns.oid = c.relnamespace',
    "   WHERE c.relkind IN ('r', 'p', 'm');",
    '  IF lock_sql IS NOT NULL THEN',
    '    EXECUTE lock_sql;',
    '  END IF;',
    'END',
    '$block$;',
    '\\echo LOCKS-HELD',
    '',
  ].join('\n');
}

export const LOCAL_DATABASE_CHANGED_MESSAGE =
  'local database changed while the backup was being dumped; no snapshot was published; retry when local writes are quiesced';

export const LOCAL_DB_PORT_MISMATCH_MESSAGE =
  'the local database port from supabase/config.toml is not published by the derived container; the dump would target a different server than the one probed; start the stack with the config.toml port and retry';

export const LOCAL_DATABASE_BARRIER_FAILED_MESSAGE =
  'cannot establish the local database write barrier; no snapshot was published';

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
  'local stack is not reachable; start the local stack in the project workdir (supabase start) and retry';

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
 * Verify the container derived from `project_id` actually publishes the
 * config.toml `[db] port` on the host. The connectivity/state probes run
 * inside the container (`docker exec`) while the six dumps connect to
 * `127.0.0.1:<port>`, so the publication mapping is what proves both routes
 * reach the SAME database server. Fails closed before any state probe or
 * dump when the mapping is missing or points at a different port.
 */
export async function assertLocalDbPortPublished({ dockerPath, dbContainer, dbPort, run }) {
  let stdout;
  try {
    const res = await run({
      command: dockerPath,
      args: ['port', dbContainer, `${dbPort}/tcp`],
      stdout: 'collect',
      stderr: 'collect',
    });
    stdout = res.stdout ?? '';
  } catch (err) {
    throw new LocalBackupError(LOCAL_DB_PORT_MISMATCH_MESSAGE, { cause: err, stage: 'connect' });
  }
  const published = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!published.some((line) => line.endsWith(`:${dbPort}`))) {
    throw new LocalBackupError(LOCAL_DB_PORT_MISMATCH_MESSAGE, { stage: 'connect' });
  }
  return published;
}

/**
 * Hold a PostgreSQL write barrier for the dump window.
 *
 * A held-open `docker exec -i` psql session runs `buildLocalDatabaseBarrierScript`:
 * a transactional SHARE lock on every user table (SHARE blocks INSERT/UPDATE/
 * DELETE/TRUNCATE/DROP while remaining compatible with the ACCESS SHARE locks
 * pg_dump takes) plus a session advisory marker. Row writes cannot commit
 * between the six dumps anymore; the state token remains as the backstop for
 * sequences, catalog changes, and role state. Returns an idempotent
 * `release()` that ends the session (EOF) and surfaces a lost barrier as an
 * error so no mixed-state candidate can be published.
 */
export async function acquireLocalDatabaseBarrier({
  dockerPath,
  dbContainer,
  run,
  signal,
  timeoutMs = 30_000,
  pollIntervalMs = 250,
}) {
  const input = new PassThrough();
  let holderFailure = null;
  const holder = run({
    command: dockerPath,
    args: [
      'exec',
      '-i',
      dbContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    input,
    stdout: 'collect',
    stderr: 'collect',
    signal,
  });
  holder.catch((err) => {
    holderFailure = err;
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (holderFailure) {
        throw new LocalBackupError(LOCAL_DATABASE_BARRIER_FAILED_MESSAGE, {
          cause: holderFailure,
          stage: 'consistency',
        });
      }
      if (signal?.aborted) {
        throw new LocalBackupError(LOCAL_DATABASE_BARRIER_FAILED_MESSAGE, {
          stage: 'consistency',
        });
      }
      const lines = await localPsqlQuery({
        dockerPath,
        dbContainer,
        query: LOCAL_DATABASE_BARRIER_READY_QUERY,
        run,
        signal,
      });
      if (lines[0] === 't') {
        return {
          release: makeBarrierRelease({ input, holder }),
        };
      }
      if (Date.now() >= deadline) {
        throw new LocalBackupError(
          'the local database write barrier could not be established before the timeout; no snapshot was published',
          { stage: 'consistency' },
        );
      }
      await delay(pollIntervalMs);
    }
  } catch (err) {
    // The holder exits when its stdin closes; never await it here so the
    // failure path cannot hang (its rejection is already observed above).
    input.end();
    if (err instanceof LocalBackupError) throw err;
    throw new LocalBackupError(LOCAL_DATABASE_BARRIER_FAILED_MESSAGE, {
      cause: err,
      stage: 'consistency',
    });
  }
}

/** Idempotent release: EOF the holder session and require a clean exit. */
function makeBarrierRelease({ input, holder }) {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    input.end();
    try {
      await holder;
    } catch (err) {
      throw new LocalBackupError(
        'the local database write barrier was lost while the backup ran; no snapshot was published',
        { cause: err, stage: 'consistency' },
      );
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture the state token around the six dumps as the backstop to the write
 * barrier: relation mutation counters plus relation/catalog, sequence, role,
 * role-membership, and default-privilege digests over every non-system
 * schema. Any movement rejects the candidate rather than publishing
 * mixed-state files.
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
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new LocalBackupError(`${label} is not a directory: ${dir}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LocalBackupError(`${label} must be a real directory, not a symlink or file: ${dir}`);
  }
  return stat;
}

/** Require the documented private directory mode on POSIX. */
function assertPrivateDirectoryMode(stat, label) {
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new LocalBackupError(
      `${label} has unsafe permissions; require mode 0700 before running backup:local`,
      { stage: 'permissions' },
    );
  }
  return stat;
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
  return assertPrivateDirectoryMode(assertRealDirectory(dir, label), label);
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
    // Preserve the ORIGINAL initialization error even when the cleanup of
    // the half-initialized lock also fails: losing either the close or the
    // removal error would hide a real filesystem failure behind the init
    // fault (or vice versa).
    const cleanupFailures = [];
    try {
      fs.closeSync(lockFd);
    } catch (closeErr) {
      cleanupFailures.push(closeErr);
    }
    lockFd = null;
    try {
      fs.rmSync(lockPath, { force: true });
    } catch (rmErr) {
      cleanupFailures.push(rmErr);
    }
    const cause =
      cleanupFailures.length > 0 ? new AggregateError([err, ...cleanupFailures], err.message) : err;
    throw new LocalBackupError('cannot initialize the local backup lock', {
      cause,
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
  if (process.platform === 'win32') return;
  assertPrivateDirectoryMode(fs.lstatSync(dir), 'completed local snapshot directory');
  for (const name of [...manifest.files.map((file) => file.name), MANIFEST_NAME]) {
    const stat = fs.lstatSync(path.join(dir, name));
    if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new LocalBackupError(
        `completed local snapshot file has unsafe permissions: ${name}; require mode 0600`,
        { stage: 'permissions' },
      );
    }
  }
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
    // One declared format: the prefix constant, the 16-hex suffix length,
    // and the canonical pattern are all derived from the same literals so a
    // format change can never desynchronize the generator and the validator.
    const name = `${CANDIDATE_PREFIX}${randomUUID().replaceAll('-', '').slice(0, CANDIDATE_SUFFIX_LENGTH)}`;
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
    sameEncryptedContent(leftManifest, rightManifest) &&
    leftManifest.sourceProjectRef === rightManifest.sourceProjectRef
  );
}

/** lstat-based existence that also sees dangling symlinks; only absence hides. */
function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    // A permission or I/O failure is NOT "absent": rethrow so the caller's
    // "refusing to overwrite" path never misreports a broken destination as
    // a free one.
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
