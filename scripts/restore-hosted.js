#!/usr/bin/env node
/**
 * Hosted development/production restore entry point.
 *
 *   vp run restore:development --source r2|repo|local --backup latest
 *   vp run restore:production  --source r2|repo|local --backup <snapshot-id>
 *
 * The package alias fixes the target environment (passed as argv[0]).
 * `--source local` reads the single private store (`local-backups/local/`)
 * with NO decryption — local snapshots are plaintext; DECRYPT_KEY, age, and
 * R2 credentials are never resolved on this path. Every verification and
 * read-only preflight completes BEFORE the interactive confirmation gate;
 * nothing destructive runs without the exact phrase. Production additionally
 * requires the exact project ref, and a local snapshot whose origin project
 * differs from the target names the SOURCE ref in the phrase as well.
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
import { PINNED_SUPABASE_POSTGRES_IMAGE, PINNED_SUPABASE_CLI_VERSION } from '../src/database.js';
import { parseHostedRestoreArgs, HOSTED_RESTORE_USAGE, exitCodeForResult } from './args.js';

export { exitCodeForResult };

/**
 * The exact confirmation phrase. Production always names the target ref;
 * a LOCAL-store snapshot additionally names its SOURCE ref when the origin
 * project differs from the target, so cross-project restores require an
 * explicit typed acknowledgement of what is being reset and where the data
 * came from.
 */
function expectedPhrase(environment, projectRef, source, sourceProjectRef) {
  const phrase =
    environment === 'production' ? `RESTORE production ${projectRef}` : 'RESTORE development';
  if (source === 'local' && sourceProjectRef && sourceProjectRef !== projectRef) {
    return `${phrase} from local snapshot ${sourceProjectRef}`;
  }
  return phrase;
}

/**
 * Discover the pinned Supabase CLI and Docker always; age only when
 * `requireAge` is set. No host psql is ever discovered: every hosted
 * PostgreSQL client operation runs psql 17 from the pinned ephemeral
 * Supabase Postgres image (see `PINNED_SUPABASE_POSTGRES_IMAGE`).
 *
 * The repository-pinned CLI (`node_modules/.bin/supabase`) is resolved
 * FIRST and its exact version is enforced (matching the dump path's
 * preflight) BEFORE any target contact: the destructive `db reset` must
 * never run through an arbitrary PATH CLI while the operator is told the
 * toolchain is pinned.
 */
async function resolveHostedRestoreExecutables({ lookup, cwd, platform, requireAge, run }) {
  const repoCli = path.join(cwd, 'node_modules', '.bin', 'supabase');
  const supabasePath = fs.existsSync(repoCli)
    ? repoCli
    : (lookup('supabase') ?? path.join(cwd, 'node_modules', '.bin', 'supabase'));
  if (!supabasePath || !fs.existsSync(supabasePath))
    throw new HostedRestoreError('Supabase CLI not found; run vp install');
  await assertPinnedSupabaseCliVersion({ supabasePath, run });
  const dockerPath = lookup(platform === 'win32' ? 'docker.exe' : 'docker');
  if (!dockerPath)
    throw new HostedRestoreError(
      'Docker is required for the Supabase clean/reset step and the Dockerized PostgreSQL restore client',
    );
  let ageBin;
  if (requireAge) {
    ageBin = lookup(platform === 'win32' ? 'age.exe' : 'age');
    if (!ageBin) throw new HostedRestoreError('age executable not found on PATH');
  }
  return { supabasePath, dockerPath, ageBin };
}

/**
 * The destructive hosted path enforces the SAME exact CLI pin the dump path
 * uses, before confirmation and target mutation. Errors are static (no
 * arguments) and never reproduce credentials.
 */
async function assertPinnedSupabaseCliVersion({ supabasePath, run }) {
  let version;
  try {
    const res = await run({
      command: supabasePath,
      args: ['--version'],
      stdout: 'collect',
      stderr: 'collect',
    });
    version = (res.stdout ?? '').trim();
  } catch (err) {
    throw new HostedRestoreError('Supabase CLI version check failed', { cause: err });
  }
  if (version !== PINNED_SUPABASE_CLI_VERSION) {
    throw new HostedRestoreError(
      `Supabase CLI must be exactly ${PINNED_SUPABASE_CLI_VERSION}; found ${version || '(unreadable)'}. Update the pin in package.json and run vp install.`,
    );
  }
}

/** Render the summary and ask for the exact phrase; true only when confirmed. */
async function requestHostedConfirmation({
  target,
  source,
  projectRef,
  sourceProjectRef,
  snapshotId,
  stdErr,
  stdIn,
  doConfirm,
  isTTY,
}) {
  stdErr.write(
    confirmationSummary({
      environment: target,
      source,
      snapshotId,
      projectRef,
      sourceProjectRef,
    }),
  );
  return doConfirm({
    expected: expectedPhrase(target, projectRef, source, sourceProjectRef),
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
    postgresImage: deps.postgresImage ?? PINNED_SUPABASE_POSTGRES_IMAGE,
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
  const executables = await resolveHostedRestoreExecutables({
    lookup: d.lookup,
    cwd: ctx.cwd,
    platform: process.platform,
    run: d.run,
    // repo/r2 restores always need age; the local source is plaintext-only
    // and never resolves the age binary.
    requireAge: ctx.source !== 'local',
  });
  await d.doPreflight({
    dockerPath: executables.dockerPath,
    postgresImage: d.postgresImage,
    dbUrl: ctx.cfg.dbUrl,
    run: d.run,
  });
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
  for (const warning of prepared.warnings ?? []) {
    logger.warn(warning);
  }

  try {
    const ok = await requestHostedConfirmation({
      target: ctx.target,
      source: ctx.source,
      projectRef: ctx.cfg.projectRef,
      sourceProjectRef: prepared.sourceProjectRef,
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
      dockerPath: executables.dockerPath,
      postgresImage: d.postgresImage,
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
