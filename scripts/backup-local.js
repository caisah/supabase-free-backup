#!/usr/bin/env node
/**
 * Local backup entry point: package the ALREADY-RUNNING local Supabase
 * project database into the private repository store.
 *
 *   vp run backup:local --environment <development|production>
 *
 * Flow: config (target metadata + recipient + workdir only, no hosted
 * DB/R2/identity) -> validated local workdir -> read-only connectivity/state
 * guard -> shared dump/package pipeline -> full package validation -> compare with
 * the newest validated local snapshot -> unchanged: retain the prior ID;
 * changed: atomically publish the candidate, then remove older snapshots.
 *
 * The local stack is never started, stopped, reset, or migrated, and no R2
 * adapter, bucket, upload, or hosted DB connection exists in this path.
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
import { localDbUrl, validateWorkdir } from '../src/local-project.js';
import {
  assertLocalStackRunning,
  assertLocalDbPortPublished,
  readLocalDatabaseState,
  assertLocalDatabaseStateUnchanged,
  acquireLocalDatabaseBarrier,
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
    doAssertPortPublished: deps.doAssertPortPublished ?? assertLocalDbPortPublished,
    readSourceState: deps.readSourceState ?? readLocalDatabaseState,
    doAcquireBarrier: deps.doAcquireBarrier ?? acquireLocalDatabaseBarrier,
    doReleaseBarrier: deps.doReleaseBarrier ?? ((barrier) => barrier.release()),
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
  const project = d.doValidateWorkdir({ projectWorkdir: cfg.projectWorkdir, repoRoot });
  const executables = d.doResolveExecutables({
    lookup: d.lookup,
    locateCli: d.locateCli,
    root: repoRoot,
    platform: process.platform,
  });
  const localUrl = localDbUrl(project.dbPort);
  logger.addSecret(localUrl);
  await d.doAssertRunning({
    dockerPath: executables.dockerPath,
    dbContainer: project.dbContainer,
    run: d.run,
  });
  // Source identity: the probes run INSIDE the derived container while the
  // dumps go through the host port, so require the container to publish
  // exactly the config.toml port before reading either route.
  await d.doAssertPortPublished({
    dockerPath: executables.dockerPath,
    dbContainer: project.dbContainer,
    dbPort: project.dbPort,
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
      dbContainer: project.dbContainer,
      run: d.run,
    };
    // Write barrier: SHARE-lock every user table for the whole dump window so
    // no row write can commit between the six dumps; the state token below is
    // the backstop for sequence/catalog/role drift. The barrier is released
    // before packaging, so encryption of multi-gigabyte dumps never holds
    // database locks.
    const dumpWindow = async (dump) => {
      const barrier = await d.doAcquireBarrier({
        dockerPath: executables.dockerPath,
        dbContainer: project.dbContainer,
        run: d.run,
      });
      try {
        return await dump();
      } finally {
        await d.doReleaseBarrier(barrier);
      }
    };
    const guardedDump = async (dumpOptions) => {
      const beforeState = await d.readSourceState(stateProbe);
      const dumped = await d.doDump(dumpOptions);
      const afterState = await d.readSourceState(stateProbe);
      assertLocalDatabaseStateUnchanged(beforeState, afterState);
      return dumped;
    };

    const packaged = await dumpAndPackageSnapshot({
      dbUrl: localUrl, // never cfg.dbUrl: the local stack is the only source
      cwd: repoRoot, // never cfg.projectWorkdir: dump uses the backup repo
      outDir: workspace.outDir,
      pkgDir: candidate.pkgDir,
      snapshotId,
      environment: cfg.environment,
      sourceProjectRef: cfg.projectRef,
      ageRecipient: cfg.ageRecipient,
      executables,
      doDump: (dumpOptions) => dumpWindow(() => guardedDump(dumpOptions)),
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
