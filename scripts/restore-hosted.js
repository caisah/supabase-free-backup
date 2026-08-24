#!/usr/bin/env node
/**
 * Hosted development/production restore entry point (sub-plan 07).
 *
 *   vp run restore:development --source r2 --backup latest
 *   vp run restore:production  --source repo --backup <snapshot-id>
 *
 * The package alias fixes the target environment (passed as argv[0]). Every
 * verification, decryption, and read-only preflight completes BEFORE the
 * interactive confirmation gate; nothing destructive runs without the exact
 * phrase. Production additionally requires the exact project ref.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable } from '../src/process.js';
import { loadHostedRestoreConfig } from '../src/config.js';
import { prepareRestore, createRestoreAdapter } from '../src/restore.js';
import { createS3Adapter } from '../src/r2.js';
import {
  readOnlyPreflight,
  confirmExactPhrase,
  confirmationSummary,
  executeHostedRestore,
  HostedRestoreError,
} from '../src/hosted-restore.js';
import { parseHostedRestoreArgs, HOSTED_RESTORE_USAGE, exitCodeForResult } from './args.js';

export { exitCodeForResult };

function expectedPhrase(environment, projectRef) {
  return environment === 'production' ? `RESTORE production ${projectRef}` : 'RESTORE development';
}

/** Discover psql, the pinned Supabase CLI, Docker, and age; any miss aborts early. */
function resolveHostedRestoreExecutables({ lookup, cwd, platform }) {
  const psqlPath = lookup(platform === 'win32' ? 'psql.exe' : 'psql');
  if (!psqlPath) throw new HostedRestoreError('psql (PostgreSQL 17 client) not found on PATH');
  const supabasePath = lookup('supabase') ?? path.join(cwd, 'node_modules', '.bin', 'supabase');
  if (!supabasePath || !fs.existsSync(supabasePath))
    throw new HostedRestoreError('Supabase CLI not found; run vp install');
  const dockerPath = lookup(platform === 'win32' ? 'docker.exe' : 'docker');
  if (!dockerPath)
    throw new HostedRestoreError('Docker is required for the Supabase clean/reset step');
  // Bundled with the other executables like restore-local: decryption needs
  // the age binary and the same preflight guarantees apply before source work.
  const ageBin = lookup(platform === 'win32' ? 'age.exe' : 'age');
  if (!ageBin) throw new HostedRestoreError('age executable not found on PATH');
  return { psqlPath, supabasePath, dockerPath, ageBin };
}

/** Render the summary and ask for the exact phrase; true only when confirmed. */
async function requestHostedConfirmation({
  target,
  source,
  projectRef,
  snapshotId,
  stdErr,
  stdIn,
  doConfirm,
  isTTY,
}) {
  stdErr.write(confirmationSummary({ environment: target, source, snapshotId, projectRef }));
  return doConfirm({
    expected: expectedPhrase(target, projectRef),
    input: stdIn,
    output: stdErr,
    isTTY,
  });
}

/** Resolve the injectable dependency seam once. */
function resolveHostedRestoreDeps(deps) {
  return {
    loadConfig: deps.loadConfig ?? loadHostedRestoreConfig,
    doPrepare: deps.doPrepare ?? prepareRestore,
    doPreflight: deps.doPreflight ?? readOnlyPreflight,
    doConfirm: deps.doConfirm ?? confirmExactPhrase,
    doExecute: deps.doExecute ?? executeHostedRestore,
    makeAdapter: deps.makeAdapter ?? createS3Adapter,
    lookup: deps.lookup ?? lookupExecutable,
    run: deps.run ?? runCommand,
    stdIn: deps.stdIn ?? process.stdin,
    stdErr: deps.stdErr ?? process.stderr,
  };
}

/** Load configuration and fix the validated target/source/backup options. */
function createHostedRestoreContext({ options, env, cwd, d }) {
  const { target, source, backup } = options;
  const cfg = d.loadConfig({ environment: target, source, vars: env, root: cwd });
  return { target, source, backup, cfg, cwd };
}

/**
 * Preflight the target (read-only), resolve executables, and acquire/verify
 * the snapshot source. Ordering is contract: no source work before preflight.
 */
async function prepareHostedRestore({ ctx, d, logger }) {
  logger.addSecret(ctx.cfg.dbUrl);
  logger.addSecret(ctx.cfg.accessKeyId);
  logger.addSecret(ctx.cfg.secretAccessKey);
  const executables = resolveHostedRestoreExecutables({
    lookup: d.lookup,
    cwd: ctx.cwd,
    platform: process.platform,
  });
  await d.doPreflight({ psqlPath: executables.psqlPath, dbUrl: ctx.cfg.dbUrl, run: d.run });
  const adapter = createRestoreAdapter({
    source: ctx.source,
    cfg: ctx.cfg,
    makeAdapter: d.makeAdapter,
  });
  const prepared = await d.doPrepare({
    environment: ctx.target,
    source: ctx.source,
    selector: ctx.backup,
    ageIdentity: ctx.cfg.ageIdentity,
    agePath: executables.ageBin,
    projectRef: ctx.cfg.projectRef,
    repoRoot: ctx.cwd,
    adapter,
    bucket: ctx.cfg.bucket,
    run: d.run,
  });
  return { prepared, executables };
}

/**
 * Full hosted restore orchestration. All heavy adapters are injectable so
 * unit tests never touch a real database; `options` is the validated
 * `{ target, source, backup }` from the CLI parser.
 */
export async function runRestoreHosted({
  options,
  env = process.env,
  cwd = process.cwd(),
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const d = resolveHostedRestoreDeps(deps);
  const ctx = createHostedRestoreContext({ options, env, cwd, d });
  const { prepared, executables } = await prepareHostedRestore({ ctx, d, logger });

  try {
    const ok = await requestHostedConfirmation({
      target: ctx.target,
      source: ctx.source,
      projectRef: ctx.cfg.projectRef,
      snapshotId: prepared.snapshotId,
      stdErr: d.stdErr,
      stdIn: d.stdIn,
      doConfirm: d.doConfirm,
      isTTY: deps.isTTY ?? Boolean(d.stdIn.isTTY),
    });
    if (!ok) {
      logger.status('confirmation failed or not answered; target untouched');
      return { confirmed: false, target: ctx.target };
    }

    await d.doExecute({
      environment: ctx.target,
      config: { ...ctx.cfg, repoRoot: ctx.cwd },
      prepared,
      psqlPath: executables.psqlPath,
      supabasePath: executables.supabasePath,
      run: d.run,
      logger,
    });
    logger.status(`restore ${ctx.target} complete`);
    return {
      confirmed: true,
      target: ctx.target,
      snapshotId: prepared.snapshotId,
      source: ctx.source,
    };
  } finally {
    await prepared.cleanup();
  }
}

/** CLI entry point: parse, run, and map the result to the exit code. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr, secrets: [process.env.SUPABASE_DB_URL] });
  try {
    const parsed = parseHostedRestoreArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${HOSTED_RESTORE_USAGE}\n`);
      return 0;
    }
    const result = await runRestoreHosted({ options: parsed, logger });
    const code = exitCodeForResult(result);
    process.exitCode = code;
    return code;
  } catch (err) {
    logger.error(`restore failed: ${logger.redact(err.message ?? String(err))}`);
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
