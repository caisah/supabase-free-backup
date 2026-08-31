#!/usr/bin/env node
/**
 * Local backup entry point: package the ALREADY-RUNNING local Fragtrack
 * database into the private repository store.
 *
 *   vp run backup:local --environment <development|production>
 *
 * Flow: config (target metadata + workdir only, no hosted DB/R2/identity,
 * no ENCRYPT_KEY/recipient) -> validated local workdir -> read-only
 * connectivity/state guard -> shared dump/package pipeline with the
 * PLAINTEXT row-data codec -> full package validation -> compare with the
 * newest validated local snapshot -> unchanged: retain the prior ID;
 * changed: atomically publish the candidate, then remove older snapshots.
 *
 * Row data is gzip-compressed into plaintext `data.sql.gz.part-NNN` parts:
 * no age binary, no encryption, no ENCRYPT_KEY on this path. The local
 * stack is never started, stopped, reset, or migrated, and no R2 adapter,
 * bucket, upload, or hosted DB connection exists in this path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable } from '../src/process.js';
import { loadLocalBackupConfig, REPOSITORY_ROOT } from '../src/config.js';
import { dumpDatabase, locateSupabaseCli } from '../src/database.js';
import {
  resolveBackupExecutables,
  createBackupWorkspace,
  dumpAndPackageSnapshot,
} from '../src/backup.js';
import { packageSnapshot, validatePackagedDirectory } from '../src/snapshot.js';
import { PLAINTEXT_FORMAT } from '../src/encryption.js';
import { localDbUrl, validateWorkdir } from '../src/local-restore.js';
import {
  assertLocalStackRunning,
  readLocalDatabaseState,
  assertLocalDatabaseStateUnchanged,
  openLocalBackupStore,
  scanLocalBackupSnapshots,
  createLocalBackupCandidate,
  finalizeLocalBackup,
} from '../src/local-backup.js';
import { formatSnapshotId } from '../src/fingerprint.js';
import { parseLocalBackupArgs, LOCAL_BACKUP_USAGE } from './args.js';

/** Resolve the injectable dependency seam once; no R2 adapter ever appears. */
function resolveLocalBackupDeps(deps) {
  return {
    loadConfig: deps.loadConfig ?? loadLocalBackupConfig,
    doValidateWorkdir: deps.doValidateWorkdir ?? validateWorkdir,
    doResolveExecutables: deps.doResolveExecutables ?? resolveBackupExecutables,
    doAssertRunning: deps.doAssertRunning ?? assertLocalStackRunning,
    readSourceState: deps.readSourceState ?? readLocalDatabaseState,
    doDump: deps.doDump ?? dumpDatabase,
    doPackage: deps.doPackage ?? packageSnapshot,
    doValidate: deps.doValidate ?? validatePackagedDirectory,
    doOpenStore: deps.doOpenStore ?? openLocalBackupStore,
    doScan: deps.doScan ?? scanLocalBackupSnapshots,
    doCreateCandidate: deps.doCreateCandidate ?? createLocalBackupCandidate,
    doFinalize: deps.doFinalize ?? finalizeLocalBackup,
    run: deps.run ?? runCommand,
    now: deps.now ?? (() => new Date()),
    lookup: deps.lookup ?? lookupExecutable,
    locateCli: deps.locateCli ?? locateSupabaseCli,
    removeWorkspace:
      deps.removeWorkspace ??
      ((workspace) => fs.rmSync(workspace, { recursive: true, force: true })),
    removeCandidate:
      deps.removeCandidate ??
      ((candidateDir) => fs.rmSync(candidateDir, { recursive: true, force: true })),
  };
}

/**
 * The full local backup run. Every external adapter is injectable; `options`
 * is the validated `{ environment }` from the CLI parser.
 */
export async function runBackupLocal({
  options,
  env = process.env,
  repoRoot = REPOSITORY_ROOT,
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const d = resolveLocalBackupDeps(deps);
  const cfg = d.loadConfig({ environment: options.environment, vars: env, root: repoRoot });
  const fragtrack = d.doValidateWorkdir({ fragtrackWorkdir: cfg.fragtrackWorkdir, repoRoot });
  const executables = d.doResolveExecutables({
    lookup: d.lookup,
    locateCli: d.locateCli,
    root: repoRoot,
    platform: process.platform,
    requireAge: false,
  });
  const localUrl = localDbUrl(fragtrack.dbPort);
  logger.addSecret(localUrl);
  await d.doAssertRunning({
    dockerPath: executables.dockerPath,
    dbContainer: fragtrack.dbContainer,
    run: d.run,
  });

  const snapshotId = formatSnapshotId(d.now());
  const store = d.doOpenStore({ repoRoot, environment: cfg.environment });
  let workspace = null;
  let candidate = null;
  let result = null;
  let operationError = null;
  try {
    const existing = await d.doScan({
      environmentDir: store.environmentDir,
      environment: cfg.environment,
    });
    workspace = createBackupWorkspace();
    candidate = d.doCreateCandidate({ environmentDir: store.environmentDir });

    const stateProbe = {
      dockerPath: executables.dockerPath,
      dbContainer: fragtrack.dbContainer,
      run: d.run,
    };
    const beforeState = await d.readSourceState(stateProbe);
    const guardedDump = async (dumpOptions) => {
      const dumped = await d.doDump(dumpOptions);
      const afterState = await d.readSourceState(stateProbe);
      assertLocalDatabaseStateUnchanged(beforeState, afterState);
      return dumped;
    };

    const packaged = await dumpAndPackageSnapshot({
      dbUrl: localUrl, // never cfg.dbUrl: the local stack is the only source
      cwd: repoRoot, // never cfg.fragtrackWorkdir: dump uses the backup repo
      outDir: workspace.outDir,
      pkgDir: candidate.pkgDir,
      snapshotId,
      environment: cfg.environment,
      sourceProjectRef: cfg.projectRef,
      format: PLAINTEXT_FORMAT, // plaintext parts; no age binary, no ENCRYPT_KEY
      executables,
      doDump: guardedDump,
      doPackage: d.doPackage,
      run: d.run,
    });

    await d.doValidate(candidate.pkgDir, {
      expectedEnvironment: cfg.environment,
      expectedSnapshotId: snapshotId,
      expectedProjectRef: cfg.projectRef,
    });

    const finalized = await d.doFinalize({
      candidate,
      candidateManifest: packaged.manifest,
      existingSnapshots: existing,
      environmentDir: store.environmentDir,
      snapshotId,
    });
    result = { environment: cfg.environment, ...finalized };
  } catch (err) {
    operationError = err;
  }

  const cleanupErrors = [];
  if (workspace) {
    try {
      d.removeWorkspace(workspace.workspace);
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  if (candidate && !candidate.published) {
    try {
      d.removeCandidate(candidate.candidateDir);
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  try {
    store.release();
  } catch (err) {
    cleanupErrors.push(err);
  }

  if (operationError) {
    if (cleanupErrors.length > 0) {
      const cleanupSummary = cleanupErrors
        .map((error) => error.message ?? String(error))
        .join('; ');
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `${operationError.message}; backup:local cleanup failed: ${cleanupSummary}`,
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    const cleanupSummary = cleanupErrors.map((error) => error.message ?? String(error)).join('; ');
    throw new AggregateError(cleanupErrors, `backup:local cleanup failed: ${cleanupSummary}`);
  }

  logger.status(
    `backup:local ${cfg.environment}: ${result.changed ? 'created' : 'unchanged'} snapshot ${result.snapshotId} at ${result.path}`,
  );
  return result;
}

/** CLI entry point: the only place raw argv is parsed. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
  try {
    const parsed = parseLocalBackupArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${LOCAL_BACKUP_USAGE}\n`);
      return 0;
    }
    await runBackupLocal({ options: parsed, logger });
    process.exitCode = 0;
    return 0;
  } catch (err) {
    logger.error(`backup:local failed: ${logger.redact(err.message ?? String(err))}`);
    if (err.cause) logger.error(`cause: ${logger.redact(String(err.cause.message ?? err.cause))}`);
    process.exitCode = 1;
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
