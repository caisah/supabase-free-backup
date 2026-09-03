#!/usr/bin/env node
/**
 * Local-stack restore entry point: restore a verified hosted snapshot
 * (r2|repo) INTO the local `<workdir>` Supabase stack.
 *
 *   vp run restore:local --environment development --source r2 --backup latest
 *   vp run restore:local --environment production --source repo --backup <snapshot-id>
 *
 * `--environment` selects which hosted environment's snapshots are read; the
 * TARGET is always the local stack of the main project identified by
 * SUPABASE_CONFIG_PATH (never this repository's minimal workdir). Both
 * sources are encrypted, so the age identity is always resolved;
 * `--source local` is NOT offered — the plaintext local store only feeds
 * hosted restores (`restore:development|production --source local`).
 *
 * Source verification, the pinned CLI version gate, and the local-stack
 * SUPABASE_CONFIG_PATH checks (the sibling project's Postgres 17
 * supabase/config.toml) all complete BEFORE the interactive `RESTORE local`
 * confirmation gate; after the phrase, the stack is freshly bootstrapped
 * and a read-only managed-data compatibility probe runs before any data is
 * applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable } from '../src/process.js';
import { locateSupabaseCli, assertPinnedSupabaseCliVersion } from '../src/database.js';
import { loadLocalRestoreConfig, REPOSITORY_ROOT } from '../src/config.js';
import { prepareRestore, createRestoreAdapter } from '../src/restore.js';
import { createS3Adapter } from '../src/r2.js';
import { confirmExactPhrase } from '../src/hosted-restore.js';
import { validateWorkdir } from '../src/local-stack.js';
import { restoreLocalStack, completionSummary, LocalRestoreError } from '../src/local-restore.js';
import { parseLocalRestoreArgs, LOCAL_RESTORE_USAGE } from './args.js';
import { exitCodeForResult } from './args.js';

/** Discover the pinned Supabase CLI, Docker, and age; any miss aborts early. */
async function resolveLocalRestoreExecutables({ lookup, cli, cwd, platform }) {
  const supabasePath = cli({ root: cwd });
  if (!supabasePath || !fs.existsSync(supabasePath)) {
    throw new LocalRestoreError('Supabase CLI not found; run vp install');
  }
  const dockerPath = lookup(platform === 'win32' ? 'docker.exe' : 'docker');
  if (!dockerPath) throw new LocalRestoreError('Docker is required for the local stack restore');
  const ageBin = lookup(platform === 'win32' ? 'age.exe' : 'age');
  if (!ageBin) throw new LocalRestoreError('age executable not found on PATH');
  return { supabasePath, dockerPath, ageBin };
}

/**
 * Data-loss warning rendered on the confirmation gate. Contains only the
 * workdir, exact container/port, environment, source, snapshot ID, the
 * snapshot's origin project ref, and the fixed warning text.
 */
function renderLocalWarning({
  workdir,
  dbContainer,
  dbPort,
  environment,
  source,
  snapshotId,
  sourceProjectRef,
}) {
  const lines = [
    `Target               : local stack (${workdir})`,
    `Target container    : ${dbContainer} (port ${dbPort})`,
    `Source environment  : ${environment}`,
    `Source              : ${source}`,
    `Snapshot            : ${snapshotId}`,
  ];
  if (sourceProjectRef) {
    lines.push(`Source project ref  : ${sourceProjectRef}`);
  }
  lines.push(
    '',
    '!!! DATA-LOSS WARNING: this command STOPS the local Supabase stack and DELETES',
    '!!! its database volume before restoring from the verified snapshot.',
    '',
  );
  return lines.join('\n');
}

/** Resolve the injectable dependency seam once. */
function resolveLocalRestoreDeps(deps) {
  return {
    loadConfig: deps.loadConfig ?? loadLocalRestoreConfig,
    locateCli: deps.locateCli ?? locateSupabaseCli,
    assertPin: deps.assertPin ?? assertPinnedSupabaseCliVersion,
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

/**
 * Resolve the local target config file (cheap synchronous file checks first,
 * so an invalid target fails before any subprocess is spawned), then the
 * executables and the pinned-CLI version gate.
 */
async function prepareLocalTarget({ ctx, d }) {
  const stack = d.doValidateWorkdir({
    supabaseConfigPath: ctx.cfg.supabaseConfigPath,
    repoRoot: ctx.cwd,
  });
  const executables = await resolveLocalRestoreExecutables({
    lookup: d.lookup,
    cli: d.locateCli,
    cwd: ctx.cwd,
    platform: process.platform,
  });
  await d.assertPin({ supabasePath: executables.supabasePath, run: d.run });
  return { executables, workdir: stack };
}

/** Fully acquire, verify, and decrypt the selected snapshot source. */
async function prepareLocalRestoreSource({ ctx, d, executables }) {
  const adapter = createRestoreAdapter({
    source: ctx.source,
    cfg: ctx.cfg,
    makeAdapter: d.makeAdapter,
  });
  return d.doPrepare({
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
}

/** Render the data-loss warning and ask for the exact `RESTORE local` phrase. */
async function confirmLocalRestore({ ctx, d, prepared, stack, isTTY }) {
  d.stdErr.write(
    renderLocalWarning({
      workdir: stack.workdir,
      dbContainer: stack.dbContainer,
      dbPort: stack.dbPort,
      environment: ctx.environment,
      source: ctx.source,
      snapshotId: prepared.snapshotId,
      sourceProjectRef: prepared.sourceProjectRef,
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
async function applyLocalRestore({ ctx, d, prepared, executables, stack, logger }) {
  await d.doRestore({
    supabasePath: executables.supabasePath,
    workdir: stack.workdir,
    prepared,
    dockerPath: executables.dockerPath,
    dbContainer: stack.dbContainer,
    run: d.run,
    logger,
  });
  logger.status(
    completionSummary({
      environment: ctx.environment,
      source: ctx.source,
      snapshotId: prepared.snapshotId,
      workdir: stack.workdir,
      sourceProjectRef: prepared.sourceProjectRef,
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
 * Full local-stack restore orchestration. All heavy adapters are
 * injectable; `options` is the validated `{ environment, source, backup }`.
 */
export async function runRestoreLocal({
  options,
  env = process.env,
  cwd = REPOSITORY_ROOT,
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const d = resolveLocalRestoreDeps(deps);
  const ctx = createLocalRestoreContext({ options, env, cwd, d });
  logger.addSecret(ctx.cfg.accessKeyId);
  logger.addSecret(ctx.cfg.secretAccessKey);
  logger.addSecret(ctx.cfg.ageIdentity);
  const { executables, workdir: stack } = await prepareLocalTarget({ ctx, d });
  const prepared = await prepareLocalRestoreSource({ ctx, d, executables });
  for (const warning of prepared.warnings ?? []) {
    logger.warn(warning);
  }

  try {
    const ok = await confirmLocalRestore({
      ctx,
      d,
      prepared,
      stack,
      isTTY: deps.isTTY ?? Boolean(d.stdIn.isTTY),
    });
    if (!ok) {
      logger.status('confirmation failed or not answered; local stack untouched');
      return { confirmed: false, environment: ctx.environment };
    }
    return await applyLocalRestore({
      ctx,
      d,
      prepared,
      executables,
      stack,
      logger,
    });
  } finally {
    // Best-effort workspace cleanup: a cleanup failure must never mask the
    // primary outcome, and the private temp directory is removed on the
    // next successful pass anyway.
    await prepared.cleanup().catch(() => {});
  }
}

/** CLI entry point: parse, run, and map the result to the exit code. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
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
