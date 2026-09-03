#!/usr/bin/env node
/**
 * Local-stack reset entry point: wipe the ALREADY-RUNNING local Supabase
 * stack database and rebuild it from the sibling project's own migrations
 * and seed.
 *
 *   vp run reset:local
 *
 * No environment selection: the local stack is a single database whose
 * config identity is fixed to the development dotenv (`.env.development.local`,
 * BACKUP_ENVIRONMENT must be `development`), and the target is the main
 * project identified by SUPABASE_CONFIG_PATH — never this repository's
 * minimal workdir (which has no migrations) and never `supabase link`
 * state: the reset runs with the explicit `--local` flag in the derived
 * project root, so a linked or stray CLI can never redirect it at a hosted
 * project.
 *
 * The pinned CLI version gate applies as on every destructive path. Docker
 * and a running local stack are required; the CLI fails with its own clear
 * error if either is missing. Unlike the hosted resets there is NO
 * typed-phrase gate: the local stack is a reproducible developer database
 * and `supabase db reset` is its canonical day-to-day command — a warning
 * is printed before the run instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand } from '../src/process.js';
import { locateSupabaseCli, assertPinnedSupabaseCliVersion } from '../src/database.js';
import { loadLocalResetConfig, LOCAL_STACK_ENVIRONMENT, REPOSITORY_ROOT } from '../src/config.js';
import { validateWorkdir } from '../src/local-stack.js';
import { parseLocalResetArgs, LOCAL_RESET_USAGE } from './args.js';

/** Run the pinned CLI's local reset in the sibling project workdir. */
async function resetLocalDatabase({ supabasePath, workdir, run }) {
  await run({
    command: supabasePath,
    args: ['db', 'reset', '--local'],
    stdout: 'inherit',
    stderr: 'collect',
    cwd: workdir,
  });
}

/** Full local-stack reset orchestration; heavy deps are injectable for tests. */
export async function runLocalReset({
  env = process.env,
  cwd = REPOSITORY_ROOT,
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const d = {
    loadConfig: deps.loadConfig ?? loadLocalResetConfig,
    doValidateWorkdir: deps.doValidateWorkdir ?? validateWorkdir,
    run: deps.run ?? runCommand,
    locateCli: deps.locateCli ?? locateSupabaseCli,
  };
  const cfg = d.loadConfig({ environment: LOCAL_STACK_ENVIRONMENT, vars: env, root: cwd });
  const stack = d.doValidateWorkdir({
    supabaseConfigPath: cfg.supabaseConfigPath,
    repoRoot: cwd,
  });

  const supabasePath = d.locateCli({ root: cwd });
  if (!supabasePath || !fs.existsSync(supabasePath)) {
    throw new Error('Supabase CLI not found; run vp install');
  }
  await assertPinnedSupabaseCliVersion({ supabasePath, run: d.run });

  logger.status(
    `Resetting local stack database (project ${stack.projectId}, container ${stack.dbContainer})`,
  );
  logger.status(
    `WARNING: all current data in ${stack.workdir} will be lost and rebuilt from its migrations/seed.`,
  );
  await resetLocalDatabase({ supabasePath, workdir: stack.workdir, run: d.run });
  logger.status(`db reset complete for local stack ${stack.workdir}`);
}

/** CLI entry point: parse, run, and map the result to the exit code. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
  try {
    const parsed = parseLocalResetArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${LOCAL_RESET_USAGE}\n`);
      return 0;
    }
    await runLocalReset({ logger });
    return 0;
  } catch (err) {
    logger.error(`reset failed: ${logger.redact(err.message ?? String(err))}`);
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
