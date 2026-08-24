/**
 * Local project database restore (sub-plan 08).
 *
 * Restores a fully verified snapshot into the local Supabase database owned
 * by the configured PROJECT_WORKDIR (Docker volumes only, never tracked
 * sibling files) and restarts the full local stack. Destruction begins only
 * after source verification and the exact `RESTORE local` confirmation; the
 * combined logical file is private and removed in every outcome.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeWithBackpressure, endWritable } from './stream.js';
import {
  prepareRolesFile,
  scanDataSqlContent,
  countCreateTables,
  rowPresenceQuery,
} from './hosted-restore.js';
import { PLAINTEXT_ARTIFACTS } from './snapshot.js';
import {
  LocalRestoreError,
  parseWorkdirConfig,
  validateWorkdir,
  localDbUrl,
  localPsqlQuery,
} from './local-project.js';

// Discovery/query primitives live in the neutral local-project adapter; these
// re-exports keep existing restore-path callers on one import surface.
export { LocalRestoreError, parseWorkdirConfig, validateWorkdir, localDbUrl };

/**
 * The schema files applied in one transaction, in the same logical order the
 * snapshot fingerprint and the hosted restore use (schema, managed delta,
 * migration history). Derived from the shared manifest artifact list so the
 * two orderings can never drift.
 */
const COMBINED_SCHEMA_ORDER = PLAINTEXT_ARTIFACTS.filter((name) => name !== 'roles.sql');

/**
 * Build the private combined logical restore file: prepared roles, application
 * schema, managed auth/storage delta, migration-history schema, generated
 * cleanup (when provided), then the decrypted combined data. The padded data
 * dump is copied through a stream; the whole file is never held in memory.
 */
export async function buildCombinedLogicalFile({ prepared, outFile, cleanupFile, rolesSql }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  const writer = fs.createWriteStream(outFile, { mode: 0o600 });
  try {
    await writeWithBackpressure(
      writer,
      rolesSql === undefined
        ? await fs.promises.readFile(path.join(prepared.dir, 'roles.sql'))
        : Buffer.from(rolesSql, 'utf8'),
    );
    for (const name of COMBINED_SCHEMA_ORDER) {
      await writeWithBackpressure(
        writer,
        await fs.promises.readFile(path.join(prepared.dir, name)),
      );
    }
    if (cleanupFile) {
      await writeWithBackpressure(writer, await fs.promises.readFile(cleanupFile));
    }
    // The decrypted row data can be multi-gigabyte: stream it instead of
    // concat-buffering it alongside every schema file.
    for await (const chunk of fs.createReadStream(prepared.dataPath)) {
      await writeWithBackpressure(writer, chunk);
    }
    await endWritable(writer);
  } catch (err) {
    writer.destroy();
    throw err;
  }
  fs.chmodSync(outFile, 0o600);
  return outFile;
}

/**
 * The destructive local-stack sequence. Every external command is injectable.
 * The combined file is built only after the fresh baseline's roles are known
 * and is owned by the prepared workspace cleanup.
 *
 * Flow (validated against the pinned CLI 2.114.0):
 *  1. destroy the local DB volume;
 *  2. `supabase db start` fresh — the image bootstrap creates the full
 *     baseline (roles, passwords, managed schema owners);
 *  3. `supabase start` — gotrue/storage bootstrap the managed schemas;
 *  4. prepare roles against that fresh baseline, commenting only duplicate
 *     canonical CREATE ROLE statements;
 *  5. drop and recreate the `public` schema (the snapshot is the source of
 *     truth, never the workdir's current migrations);
 *  6. apply the VERIFIED combined logical restore in ONE transaction;
 *  7. restart the stack and verify connectivity, public tables, and
 *     migration history.
 *
 * NOTE: `supabase db start --from-backup` was evaluated and rejected for this
 * CLI version: it restores onto a bare volume (only supabase_admin exists),
 * which makes every pg_dump `OWNER TO postgres`/role statement fail and (with
 * the CLI's single-transaction restore) silently rolls back the whole file.
 */

/** Stop the stack (`--no-backup` deletes the volume), then fresh-bootstrap. */
async function bootstrapLocalStack({ supabasePath, workdir, run, signal }) {
  // An already-stopped stack is an expected state; real Docker failures
  // still surface as nonzero exits.
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
  await run({
    command: supabasePath,
    args: ['start', '--workdir', workdir],
    stdout: 'inherit',
    stderr: 'collect',
    signal,
  });
}

/** Prepare duplicate-safe roles and build the private combined restore file. */
async function prepareLocalCombinedFile({
  prepared,
  cleanupFile,
  dockerPath,
  dbContainer,
  run,
  signal,
  buildCombined,
}) {
  const recentRoles = await localPsqlQuery({
    dockerPath,
    dbContainer,
    query: 'SELECT rolname FROM pg_roles',
    run,
    signal,
  });
  const rolesSql = prepareRolesFile({
    rolesSql: fs.readFileSync(path.join(prepared.dir, 'roles.sql'), 'utf8'),
    existingRoles: recentRoles,
  });
  const outFile = path.join(prepared.dir, '.restore-combined.sql');
  return buildCombined({ prepared, outFile, cleanupFile, rolesSql });
}

/** Empty and recreate the `public` schema from the snapshot. */
async function replacePublicSchema({ dockerPath, dbContainer, run, signal }) {
  await run({
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
      '-c',
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION postgres; GRANT ALL ON SCHEMA public TO PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO postgres;',
    ],
    stdout: 'inherit',
    stderr: 'collect',
    signal,
  });
}

/** Apply the verified combined logical restore in ONE transaction over stdin. */
async function applyCombinedRestore({ dockerPath, dbContainer, combinedFile, run, signal }) {
  // Files piped over stdin: psql inside the container cannot read host paths.
  // Stream the combined file (the runner pipes Readables into child stdin)
  // instead of buffering the potentially multi-gigabyte dump in memory.
  await run({
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
      '--single-transaction',
    ],
    input: fs.createReadStream(combinedFile),
    stdout: 'inherit',
    stderr: 'collect',
    signal,
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

/**
 * The post-restore structural verification checks in the documented order,
 * plus snapshot-derived expectations: the schema-table lower bound from
 * schema.sql and per-table row-data presence probes from the decrypted
 * data.sql COPY blocks. `expectAtLeast` defaults to 1 (any non-empty result).
 */
async function buildLocalChecks({ prepared }) {
  const checks = [
    { label: 'connectivity', query: 'SELECT 1' },
    {
      label: 'public tables',
      query: "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
    },
    {
      label: 'migration history',
      query: "SELECT count(*) FROM pg_tables WHERE schemaname = 'supabase_migrations'",
    },
  ];
  const schemaTables = countCreateTables(
    fs.readFileSync(path.join(prepared.dir, 'schema.sql'), 'utf8'),
  );
  if (schemaTables > 0) {
    checks.push({
      label: 'snapshot schema tables',
      query:
        "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      expectAtLeast: schemaTables,
    });
  }
  const { tables } = await scanDataSqlContent({ dataPath: prepared.dataPath });
  for (const entry of tables) {
    if (entry.rows === 0) continue;
    checks.push({
      label: `rows in ${entry.schema}.${entry.table}`,
      query: rowPresenceQuery(entry),
      expectAtLeast: entry.rows,
    });
  }
  return checks;
}

/** Execute the verification checks and throw on the first failed check. */
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
    const value = Number(lines[0]);
    if (!Number.isInteger(value) || value < (check.expectAtLeast ?? 1)) {
      throw new LocalRestoreError(`local restore verification failed: ${check.label}`, {
        stage: 'verify',
      });
    }
  }
}

export async function restoreLocalStack({
  supabasePath,
  workdir,
  prepared,
  cleanupFile,
  dockerPath,
  dbContainer,
  dbPort,
  run,
  logger,
  signal,
  buildCombined = buildCombinedLogicalFile,
}) {
  // 1. Stop/delete the DB volume and bootstrap the full baseline stack.
  await bootstrapLocalStack({ supabasePath, workdir, run, signal });

  // 2. Prepare duplicate-safe roles against the fresh baseline.
  const restoreFile = await prepareLocalCombinedFile({
    prepared,
    cleanupFile,
    dockerPath,
    dbContainer,
    run,
    signal,
    buildCombined,
  });

  // 3. Public schema is fully replaced by the snapshot.
  await replacePublicSchema({ dockerPath, dbContainer, run, signal });

  // 4. Apply the verified combined logical restore in ONE transaction.
  await applyCombinedRestore({ dockerPath, dbContainer, combinedFile: restoreFile, run, signal });

  // 5. Restart services on the restored database (skipped on any earlier failure).
  await restartLocalStack({ supabasePath, workdir, run, signal });

  // 6. Verification: connectivity, public tables, migration history, and
  //    snapshot-derived schema/row-data presence.
  await verifyLocalRestore({
    dockerPath,
    dbContainer,
    run,
    logger,
    signal,
    checks: await buildLocalChecks({ prepared }),
  });
  return { verified: true, dbPort };
}
/** Secret-free completion summary. */
export function completionSummary({ environment, source, snapshotId, workdir }) {
  return [
    `Local restore complete:`,
    `  source environment: ${environment}`,
    `  source: ${source}`,
    `  snapshot: ${snapshotId}`,
    `  Project workdir: ${workdir}`,
    `Full local stack restarted; connectivity, public tables, migration history, and snapshot row data verified.`,
  ].join('\n');
}
