/**
 * Local-stack database restore (restore:local).
 *
 * Restores a fully verified hosted snapshot (r2|repo, decrypted) into the
 * local Supabase database owned by `PROJECT_WORKDIR` (Docker volumes only,
 * never tracked sibling files) and restarts the full local stack.
 * Destruction begins only after source verification and the exact
 * `RESTORE local` confirmation.
 *
 * Lifecycle (validated against the pinned CLI 2.114.0):
 *  0. `supabase stop --no-backup` deletes the DB volume, then
 *     `supabase db start` bootstraps a FRESH baseline (roles, managed
 *     schemas, migrations/seed). Services are NOT started here: the
 *     snapshot replays while only the database container runs. NOTE: a
 *     fresh bootstrap applies the workdir's own migrations/seed; the
 *     transaction below replaces the `public` schema and replays the dump
 *     over the baseline, so migration/seed output in `public` never
 *     survives. Custom non-public schemas created by those migrations can
 *     conflict with the dump; the failure is a visible single-transaction
 *     rollback (never silent corruption) and the same baseline exists on
 *     the hosted restore path (`db reset`).
 *  1. read-only catalog probe + role preparation against the FRESH
 *     baseline (the actual restore target): non-empty managed data that
 *     cannot replay (missing relations, columns, or sequences) fails
 *     closed before anything is applied;
 *  2. apply the VERIFIED snapshot in ONE psql transaction, starting with
 *     an atomic `public` schema replacement (DROP/CREATE/GRANT), then
 *     prepared roles, the three canonical schema artifacts, generated
 *     cleanup, and row data — streamed over stdin, never materialized;
 *  3. restart the full stack and verify connectivity, the restored public
 *     table count, migration history, and project triggers.
 *
 * On any failure after the bootstrap, the stack is left freshly
 * bootstrapped with nothing applied; retrying from the same verified
 * snapshot recreates the same baseline.
 *
 * Workdir parsing/validation and the read-only psql probe are shared with
 * `backup:local` via local-stack.js; role preparation, cleanup generation,
 * restore-stream assembly, and the trigger names come from hosted-restore.js
 * so the two restore paths can never drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  prepareRestoreAuxiliaryFiles,
  createRestoreInputStream,
  parseTargetManagedDataObjects,
  TARGET_MANAGED_DATA_OBJECTS_QUERY,
  trackInputDelivery,
  HOSTED_RESTORE_SCHEMA_ARTIFACTS,
  PROJECT_TRIGGERS,
} from './hosted-restore.js';
import { localPsqlQuery } from './local-stack.js';

export class LocalRestoreError extends Error {
  constructor(message, { cause, stage } = {}) {
    super(message);
    this.name = 'LocalRestoreError';
    this.cause = cause;
    this.stage = stage;
  }
}

/**
 * The atomic `public` schema replacement that LEADS the restore transaction:
 * the snapshot is the source of truth for the public schema, and moving the
 * DROP inside the single transaction keeps a failed restore fully rolled
 * back (the old code committed the DROP before the transaction, so a
 * mid-restore failure left `public` deleted).
 */
const PUBLIC_SCHEMA_RESET_SQL = [
  'DROP SCHEMA IF EXISTS public CASCADE;',
  'CREATE SCHEMA public AUTHORIZATION postgres;',
  'GRANT ALL ON SCHEMA public TO PUBLIC;',
  'GRANT USAGE, CREATE ON SCHEMA public TO postgres;',
  '',
].join('\n');

/** Stop the stack (`--no-backup` deletes the volume), then fresh-bootstrap. */
async function bootstrapLocalStack({ supabasePath, workdir, run, signal }) {
  // An already-stopped stack is an expected state; real Docker failures
  // still surface as nonzero exits. Only `db start` runs: services must not
  // connect to the database while the snapshot replays.
  await run({
    command: supabasePath,
    args: ['stop', '--workdir', workdir, '--no-backup'],
    stdout: 'inherit',
    stderr: 'collect',
    signal,
  });
  await run({
    command: supabasePath,
    args: ['db', 'start', '--workdir', workdir],
    stdout: 'inherit',
    stderr: 'collect',
    signal,
  });
}

/**
 * Read-only catalog probe of the freshly bootstrapped local stack's managed
 * schemas (relations with columns, sequences), the same probe the hosted
 * flow runs against its target. Result is the actual restore target, so
 * the compatibility check cannot be fooled by stale pre-bootstrap state.
 */
async function readLocalTargetManagedDataObjects({ dockerPath, dbContainer, run, signal }) {
  const lines = await localPsqlQuery({
    dockerPath,
    dbContainer,
    query: TARGET_MANAGED_DATA_OBJECTS_QUERY,
    run,
    signal,
  });
  return parseTargetManagedDataObjects(lines);
}

/** Apply the verified snapshot in ONE transaction over stdin. */
async function applyCombinedRestore({ dockerPath, dbContainer, input, run, signal }) {
  // Files piped over stdin: psql inside the container cannot read host
  // paths. `-X` ignores any psqlrc, `--single-transaction` requires an
  // explicit `-f -` script source (a bare stdin read is rejected), and the
  // rollback wording distinguishes "SQL was delivered and rolled back"
  // from "the transaction never started" (e.g. Docker failed to launch).
  const delivery = trackInputDelivery(input);
  return run({
    command: dockerPath,
    args: [
      'exec',
      '-i',
      dbContainer,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '--single-transaction',
      '-f',
      '-',
    ],
    input: delivery.stream,
    stdout: 'inherit',
    stderr: 'collect',
    signal,
  }).catch((err) => {
    // Decorate the raw subprocess error with whether ANY SQL reached the
    // child before the failure; the caller picks the rollback wording.
    err.deliveryStarted = delivery.state.started;
    throw err;
  });
}

/** Restart full services on the restored database. */
async function restartLocalStack({ supabasePath, workdir, run, signal }) {
  await run({
    command: supabasePath,
    args: ['stop', '--workdir', workdir],
    stdout: 'inherit',
    stderr: 'collect',
    signal,
  });
  await run({
    command: supabasePath,
    args: ['start', '--workdir', workdir],
    stdout: 'inherit',
    stderr: 'collect',
    signal,
  });
}

/** The post-restore verification queries and their expected outcomes. */
function buildLocalChecks(triggerNames, expectedPublicTables) {
  return [
    { label: 'connectivity', query: 'SELECT 1', expect: ['1'] },
    {
      label: 'public tables',
      // The count of restored real tables in `public` must exactly match the
      // number of distinct public COPY targets the dump carried: a snapshot
      // with zero public tables verifies as zero, and a silently empty
      // replay cannot pass.
      query:
        "SELECT count(*) FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')",
      expectExactly: expectedPublicTables,
    },
    {
      label: 'migration history',
      // The canonical migration-history table itself, not any table in the
      // supabase_migrations schema.
      query:
        "SELECT count(*) FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'supabase_migrations' AND c.relname = 'schema_migrations'",
      expectNonZero: true,
    },
    {
      label: 'custom auth triggers',
      // Scoped to triggers ON auth-schema relations: an unrelated trigger
      // with the same name in another schema must not satisfy the check.
      query: `SELECT t.tgname FROM pg_trigger AS t JOIN pg_class AS c ON t.tgrelid = c.oid JOIN pg_namespace AS n ON c.relnamespace = n.oid WHERE t.tgname IN (${triggerNames.map((t) => `'${t}'`).join(', ')}) AND n.nspname = 'auth'`,
      expectAll: triggerNames,
    },
  ];
}

/** Execute the verification queries and throw on the first failed check. */
async function verifyLocalRestore({ dockerPath, dbContainer, run, logger, signal, checks }) {
  for (const check of checks) {
    const lines = await localPsqlQuery({
      dockerPath,
      dbContainer,
      query: check.query,
      run,
      signal,
    });
    logger.status(`local verify ${check.label}: ${lines.join(',') || '(empty)'}`);
    if (check.expect) {
      for (const wanted of check.expect) {
        if (!lines.includes(wanted)) {
          throw new LocalRestoreError(
            `local restore verification failed: ${check.label} (missing ${wanted})`,
            { stage: 'verify' },
          );
        }
      }
    } else if (check.expectAll) {
      for (const wanted of check.expectAll) {
        if (!lines.includes(wanted)) {
          throw new LocalRestoreError(
            `local restore verification failed: ${check.label} (missing ${wanted})`,
            { stage: 'verify' },
          );
        }
      }
    } else if (check.expectExactly !== undefined) {
      if (lines.length === 0 || Number(lines[0]) !== check.expectExactly) {
        throw new LocalRestoreError(
          `local restore verification failed: ${check.label} (expected ${check.expectExactly})`,
          { stage: 'verify' },
        );
      }
    } else if (check.expectNonZero && (lines.length === 0 || lines[0] === '0')) {
      throw new LocalRestoreError(`local restore verification failed: ${check.label}`, {
        stage: 'verify',
      });
    }
  }
}

/**
 * Failures after the fresh bootstrap must not leak foreign error classes or
 * raw subprocess errors: the operator needs to know the stack state (freshly
 * bootstrapped, nothing applied) and that a retry is safe.
 */
function preflightFailure(err) {
  if (err instanceof LocalRestoreError) return err;
  return new LocalRestoreError(
    `local restore preflight failed against the freshly bootstrapped stack (left running, no data applied): ${err.message}`,
    { cause: err, stage: 'preflight' },
  );
}

export async function restoreLocalStack({
  supabasePath,
  workdir,
  prepared,
  dockerPath,
  dbContainer,
  run,
  logger,
  signal,
  triggerNames = PROJECT_TRIGGERS,
}) {
  // 1. Delete the DB volume and bootstrap the fresh baseline (services down).
  logger.status(
    'local restore: deleting the database volume and bootstrapping a fresh baseline...',
  );
  await bootstrapLocalStack({ supabasePath, workdir, run, signal });

  // 2. Prepare against the FRESH baseline: roles, managed delta, migration
  // history, and the compatibility scan (non-empty managed data that cannot
  // replay fails closed, and the scan also yields the cleanup SQL and the
  // expected public table count).
  logger.status('local restore: preparing the verified snapshot against the fresh baseline...');
  let aux;
  try {
    const recentRoles = await localPsqlQuery({
      dockerPath,
      dbContainer,
      query: 'SELECT rolname FROM pg_roles',
      run,
      signal,
    });
    const targetDataObjects = await readLocalTargetManagedDataObjects({
      dockerPath,
      dbContainer,
      run,
      signal,
    });
    aux = await prepareRestoreAuxiliaryFiles({
      prepared,
      recentRoles,
      targetDataObjects,
    });
  } catch (err) {
    throw preflightFailure(err);
  }

  // 3. ONE transactional restore: the atomic public replacement leads, then
  // prepared roles, the frozen schema artifact order, cleanup, and row data.
  // The whole stream is piped over stdin; nothing is materialized on disk.
  logger.status('local restore: applying the verified snapshot in one transaction...');
  const auxDir = path.join(prepared.dir, '.restore-aux');
  const publicResetFile = path.join(auxDir, 'public-reset.sql');
  fs.writeFileSync(publicResetFile, PUBLIC_SCHEMA_RESET_SQL, { mode: 0o600 });
  const schemaOverrides = {
    'managed-schema.sql': path.join(auxDir, 'managed-schema.prepared.sql'),
    'migration-history-schema.sql': path.join(auxDir, 'migration-history-schema.prepared.sql'),
  };
  const input = createRestoreInputStream(
    [
      publicResetFile,
      path.join(auxDir, 'roles.prepared.sql'),
      ...HOSTED_RESTORE_SCHEMA_ARTIFACTS.map(
        (name) => schemaOverrides[name] ?? path.join(prepared.dir, name),
      ),
      path.join(auxDir, 'cleanup.sql'),
      prepared.dataPath,
    ],
    {
      dataPath: prepared.dataPath,
      skippedRelations: aux.skippedRelations,
      skippedSequences: aux.skippedSequences,
    },
  );
  try {
    await applyCombinedRestore({ dockerPath, dbContainer, input, run, signal });
  } catch (err) {
    throw new LocalRestoreError(
      err.deliveryStarted
        ? 'restore transaction failed and was rolled back; the local stack is freshly bootstrapped and nothing was applied — retry from the same verified snapshot'
        : 'restore failed before the transaction started; the local stack is freshly bootstrapped and nothing was applied — retry from the same verified snapshot',
      { cause: err, stage: 'restore' },
    );
  }

  // 4. Restart full services on the restored database.
  logger.status('local restore: restarting the full local stack...');
  await restartLocalStack({ supabasePath, workdir, run, signal });

  // 5. Verification: connectivity, public table count vs the dump, migration
  // history, auth-scoped project triggers.
  await verifyLocalRestore({
    dockerPath,
    dbContainer,
    run,
    logger,
    signal,
    checks: buildLocalChecks(triggerNames, aux.publicTables.size),
  });
  return { verified: true };
}

/** Secret-free completion summary. */
export function completionSummary({ environment, source, snapshotId, workdir, sourceProjectRef }) {
  const lines = [
    'Local restore complete:',
    `  source environment: ${environment}`,
    `  source: ${source}`,
    `  snapshot: ${snapshotId}`,
    `  project workdir: ${workdir}`,
  ];
  if (sourceProjectRef) {
    lines.push(`  source project ref: ${sourceProjectRef}`);
  }
  lines.push(
    'Full local stack restarted; the public schema, migration history, and custom auth triggers were verified against the snapshot.',
  );
  return lines.join('\n');
}
