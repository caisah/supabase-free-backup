#!/usr/bin/env node
/**
 * Hosted development/production database reset entry point.
 *
 *   vp run reset:development
 *   vp run reset:production
 *
 * The package alias fixes the target environment (argv[0]). The target is
 * never `--linked`: linking is global mutable CLI state that could silently
 * point at the wrong project. Instead the per-environment
 * `.env.<environment>.local` connection URL selects the target, and the
 * config loader cross-checks that URL against the project ref.
 *
 * This repository's Supabase workdir has NO migrations or seeds (see
 * supabase/config.toml), so the pinned CLI's `db reset --db-url` leaves the
 * target CLEAN — the exact clean step the restore pipeline performs before
 * applying a snapshot. A standalone reset applies nothing afterwards, so
 * production requires typing the exact phrase that names the project ref,
 * interactively; non-TTY runs always decline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand } from '../src/process.js';
import { locateSupabaseCli, assertPinnedSupabaseCliVersion } from '../src/database.js';
import { loadHostedResetConfig, urlPassword } from '../src/config.js';
import { confirmExactPhrase } from '../src/hosted-restore.js';
import { parseHostedResetArgs, HOSTED_RESET_USAGE, exitCodeForResult } from './args.js';

/** The exact phrase: production always names the target project ref. */
function expectedPhrase(environment, projectRef) {
  return environment === 'production' ? `RESET production ${projectRef}` : 'RESET development';
}

/**
 * Render the reset summary and ask for the exact phrase. The full project
 * ref is shown (it is not a secret) so the operator can type it correctly;
 * the phrase is the acknowledgement of what is being wiped.
 */
async function requestResetConfirmation({
  environment,
  projectRef,
  stdErr,
  stdIn,
  doConfirm,
  isTTY,
}) {
  stdErr.write(
    [
      `Target environment : ${environment}`,
      `Project ref        : ${projectRef}`,
      '',
      '!!! DATA-LOSS WARNING: this RESETS the hosted database to empty.',
      '!!! Nothing is restored afterwards. Type the exact phrase to confirm.',
      '',
    ].join('\n') + '\n',
  );
  return doConfirm({
    expected: expectedPhrase(environment, projectRef),
    input: stdIn,
    output: stdErr,
    isTTY,
  });
}

/** Run the pinned CLI's remote reset against the environment-scoped URL. */
async function resetHostedDatabase({ supabasePath, dbUrl, cwd, run }) {
  await run({
    command: supabasePath,
    args: ['db', 'reset', '--db-url', dbUrl, '--no-seed', '--yes'],
    secretArgs: [dbUrl, urlPassword(dbUrl)].filter(Boolean),
    stdout: 'inherit',
    stderr: 'collect',
    cwd,
  });
}

/** Full hosted reset orchestration; heavy deps are injectable for tests. */
export async function runHostedReset({
  target,
  env = process.env,
  cwd = process.cwd(),
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const d = {
    loadConfig: deps.loadConfig ?? loadHostedResetConfig,
    doConfirm: deps.doConfirm ?? confirmExactPhrase,
    run: deps.run ?? runCommand,
    locateCli: deps.locateCli ?? locateSupabaseCli,
    stdIn: deps.stdIn ?? process.stdin,
    stdErr: deps.stdErr ?? process.stderr,
  };
  const cfg = d.loadConfig({ environment: target, vars: env, root: cwd });
  logger.addSecret(cfg.sharedPoolerUrl);

  const supabasePath = d.locateCli({ root: cwd });
  if (!supabasePath || !fs.existsSync(supabasePath)) {
    throw new Error('Supabase CLI not found; run vp install');
  }
  await assertPinnedSupabaseCliVersion({ supabasePath, run: d.run });

  const confirmed = await requestResetConfirmation({
    environment: target,
    projectRef: cfg.projectRef,
    stdErr: d.stdErr,
    stdIn: d.stdIn,
    doConfirm: d.doConfirm,
    isTTY: deps.isTTY ?? Boolean(d.stdIn.isTTY),
  });
  if (!confirmed) {
    logger.status('confirmation failed or not answered; database untouched');
    return { confirmed: false, target };
  }

  await resetHostedDatabase({ supabasePath, dbUrl: cfg.sharedPoolerUrl, cwd, run: d.run });
  logger.status(`db reset complete for ${target}`);
  return { confirmed: true, target };
}

/** CLI entry point: parse, run, and map the result to the exit code. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
  try {
    const parsed = parseHostedResetArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${HOSTED_RESET_USAGE}\n`);
      return 0;
    }
    const result = await runHostedReset({ target: parsed.target, logger });
    const code = exitCodeForResult(result);
    process.exitCode = code;
    return code;
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
