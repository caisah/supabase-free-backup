#!/usr/bin/env node
/**
 * Local project restore entry point (sub-plan 08).
 *
 *   vp run restore:local --environment development --source r2 --backup latest
 *   vp run restore:local --environment production --source repo --backup <snapshot-id>
 *
 * Destroys ONLY the local Supabase project Docker volume after full source
 * verification and the exact `RESTORE local` confirmation; tracked files in
 * the project workdir are never touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable } from '../src/process.js';
import { loadLocalRestoreConfig } from '../src/config.js';
import {
  prepareRestore,
  createRestoreAdapter,
  RESTORE_WORKSPACE_PREFIXES,
} from '../src/restore.js';
import { createS3Adapter } from '../src/r2.js';
import { confirmExactPhrase, generateCleanupSqlFromFile } from '../src/hosted-restore.js';
import {
  validateWorkdir,
  restoreLocalStack,
  completionSummary,
  LocalRestoreError,
} from '../src/local-restore.js';
import { parseLocalRestoreArgs, LOCAL_RESTORE_USAGE, exitCodeForResult } from './args.js';

export { exitCodeForResult };

/** Discover Supabase CLI, Docker, and age; any miss aborts early. */
function resolveLocalRestoreExecutables({ lookup, cwd, platform }) {
  const supabasePath = lookup('supabase') ?? path.join(cwd, 'node_modules', '.bin', 'supabase');
  if (!supabasePath || !fs.existsSync(supabasePath))
    throw new LocalRestoreError('Supabase CLI not found; run vp install');
  const dockerPath = lookup(platform === 'win32' ? 'docker.exe' : 'docker');
  if (!dockerPath) throw new LocalRestoreError('Docker is required for the local Supabase stack');
  const ageBin = lookup(platform === 'win32' ? 'age.exe' : 'age');
  if (!ageBin) throw new LocalRestoreError('age executable not found on PATH');
  return { supabasePath, dockerPath, ageBin };
}

/** Create the private cleanup SQL workspace; the caller owns its removal. */
export async function createCleanupWorkspace(prepared) {
  const cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), RESTORE_WORKSPACE_PREFIXES.cleanup));
  fs.chmodSync(cleanupDir, 0o700);
  const cleanupFile = path.join(cleanupDir, 'cleanup.sql');
  try {
    // Stream the decrypted dump: the cleanup pass must never buffer a
    // multi-gigabyte data file in memory.
    const cleanupSql = await generateCleanupSqlFromFile({ dataPath: prepared.dataPath });
    fs.writeFileSync(cleanupFile, cleanupSql, { mode: 0o600 });
    fs.chmodSync(cleanupFile, 0o600);
  } catch (err) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    throw err;
  }
  return { cleanupDir, cleanupFile };
}

/**
 * Data-loss warning rendered on the confirmation gate. Contains only the
 * workdir, environment, source, snapshot ID, and the fixed warning text.
 */
function renderLocalWarning({ workdir, environment, source, snapshotId }) {
  return [
    `Target               : local Supabase project (${workdir})`,
    `Source environment   : ${environment}`,
    `Source               : ${source}`,
    `Snapshot             : ${snapshotId}`,
    '',
    '!!! DATA-LOSS WARNING: this command STOPS the local Supabase stack and DELETES',
    '!!! its database volume before restoring from the verified snapshot.',
    '',
  ].join('\n');
}

/** Resolve the injectable dependency seam once. */
function resolveLocalRestoreDeps(deps) {
  return {
    loadConfig: deps.loadConfig ?? loadLocalRestoreConfig,
    doPrepare: deps.doPrepare ?? prepareRestore,
    doValidateWorkdir: deps.doValidateWorkdir ?? validateWorkdir,
    doConfirm: deps.doConfirm ?? confirmExactPhrase,
    doRestore: deps.doRestore ?? restoreLocalStack,
    makeAdapter: deps.makeAdapter ?? createS3Adapter,
    lookup: deps.lookup ?? lookupExecutable,
    run: deps.run ?? runCommand,
    stdIn: deps.stdIn ?? process.stdin,
    stdErr: deps.stdErr ?? process.stderr,
  };
}

/** Load configuration and fix the validated environment/source/backup options. */
function createLocalRestoreContext({ options, env, cwd, d }) {
  const { environment, source, backup } = options;
  const cfg = d.loadConfig({ environment, source, vars: env, root: cwd });
  return { environment, source, backup, cfg, cwd };
}

/** Resolve executables and validate the local target before source acquisition. */
function prepareLocalTarget({ ctx, d }) {
  const executables = resolveLocalRestoreExecutables({
    lookup: d.lookup,
    cwd: ctx.cwd,
    platform: process.platform,
  });
  const localProject = d.doValidateWorkdir({
    projectWorkdir: ctx.cfg.projectWorkdir,
    repoRoot: ctx.cwd,
  });
  return { executables, localProject };
}

/** Fully acquire, verify, and decrypt the selected snapshot source. */
async function prepareLocalRestoreSource({ ctx, d, executables }) {
  const adapter = createRestoreAdapter({
    source: ctx.source,
    cfg: ctx.cfg,
    makeAdapter: d.makeAdapter,
  });
  const prepared = await d.doPrepare({
    environment: ctx.environment,
    source: ctx.source,
    selector: ctx.backup,
    ageIdentity: ctx.cfg.ageIdentity,
    agePath: executables.ageBin,
    repoRoot: ctx.cwd,
    adapter,
    bucket: ctx.cfg.bucket,
    run: d.run,
  });
  return prepared;
}

/** Render the data-loss warning and ask for the exact `RESTORE local` phrase. */
async function confirmLocalRestore({ ctx, d, prepared, localProject, isTTY }) {
  d.stdErr.write(
    renderLocalWarning({
      workdir: localProject.workdir,
      environment: ctx.environment,
      source: ctx.source,
      snapshotId: prepared.snapshotId,
    }),
  );
  return d.doConfirm({
    expected: 'RESTORE local',
    input: d.stdIn,
    output: d.stdErr,
    isTTY,
  });
}

/** Execute the destructive local restore and report completion. */
async function applyLocalRestore({
  ctx,
  d,
  prepared,
  executables,
  localProject,
  cleanupFile,
  logger,
}) {
  await d.doRestore({
    supabasePath: executables.supabasePath,
    workdir: localProject.workdir,
    prepared,
    cleanupFile,
    dockerPath: executables.dockerPath,
    dbContainer: localProject.dbContainer,
    dbPort: localProject.dbPort,
    run: d.run,
    logger,
  });
  logger.status(
    completionSummary({
      environment: ctx.environment,
      source: ctx.source,
      snapshotId: prepared.snapshotId,
      workdir: localProject.workdir,
    }),
  );
  return {
    confirmed: true,
    environment: ctx.environment,
    snapshotId: prepared.snapshotId,
    source: ctx.source,
  };
}

/**
 * Full local project restore orchestration. All heavy adapters are
 * injectable; `options` is the validated `{ environment, source, backup }`.
 */
export async function runRestoreLocal({
  options,
  env = process.env,
  cwd = process.cwd(),
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const d = resolveLocalRestoreDeps(deps);
  const ctx = createLocalRestoreContext({ options, env, cwd, d });
  logger.addSecret(ctx.cfg.dbUrl);
  logger.addSecret(ctx.cfg.accessKeyId);
  logger.addSecret(ctx.cfg.secretAccessKey);
  const { executables, localProject } = prepareLocalTarget({ ctx, d });
  const prepared = await prepareLocalRestoreSource({ ctx, d, executables });

  let cleanupDir = null;
  try {
    const workspace = await createCleanupWorkspace(prepared);
    cleanupDir = workspace.cleanupDir;
    const ok = await confirmLocalRestore({
      ctx,
      d,
      prepared,
      localProject,
      isTTY: deps.isTTY ?? Boolean(d.stdIn.isTTY),
    });
    if (!ok) {
      logger.status('confirmation failed or not answered; local volume untouched');
      return { confirmed: false, environment: ctx.environment };
    }
    return await applyLocalRestore({
      ctx,
      d,
      prepared,
      executables,
      localProject,
      cleanupFile: workspace.cleanupFile,
      logger,
    });
  } finally {
    try {
      await prepared.cleanup();
    } finally {
      if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  }
}

/** CLI entry point: parse, run, and map the result to the exit code. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr, secrets: [process.env.SUPABASE_DB_URL] });
  try {
    const parsed = parseLocalRestoreArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${LOCAL_RESTORE_USAGE}\n`);
      return 0;
    }
    const result = await runRestoreLocal({ options: parsed, logger });
    const code = exitCodeForResult(result);
    process.exitCode = code;
    return code;
  } catch (err) {
    logger.error(`restore:local failed: ${logger.redact(err.message ?? String(err))}`);
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
