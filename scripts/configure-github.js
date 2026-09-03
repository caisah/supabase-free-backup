#!/usr/bin/env node
/**
 * Synchronize the two ignored local backup configuration files into GitHub
 * Environment secrets and variables.
 *
 *   vp run github:configure
 *   vp run github:configure OWNER/REPO
 *
 * Configuration validation is delegated ENTIRELY to the doctor: `runDoctor`
 * runs first in STATIC-ONLY mode (`live: false` — file contracts, shapes,
 * and workdir validation, no Docker/network probes) and this command
 * uploads only the exact in-memory values the doctor returned. Values come
 * only from `.env.<environment>.local` files (never from the process
 * environment). Only the fixed allowlists below are uploaded, secrets
 * travel exclusively over gh stdin, and the target repository must be
 * private. The repository-level BACKUPS_ENABLED opt-in is set to `true`
 * as the final step: only after every environment upsert and legacy-secret
 * deletion succeeded, so a partial configuration can never auto-enable
 * backups.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable, TRUNCATED_MARKER } from '../src/process.js';
import { REPOSITORY_ROOT, LEGACY_DB_URL_VARIABLE } from '../src/config.js';
import { runDoctor } from './doctor.js';

/** Upper bound for a single `github:configure` run. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** PUT body for creating a new environment without protection rules. */
const EMPTY_ENVIRONMENT_BODY = '{}';

/**
 * Immutable GitHub-name to validated config-property allowlists. Everything
 * writable is enumerated here so a future config field can never be uploaded
 * implicitly. Variables are written before secrets. Only the new Shared
 * Session Pooler secret is ever set; the legacy secret is handled by the
 * fixed deletion target below.
 */
export const GITHUB_SECRETS = Object.freeze({
  SUPABASE_SHARED_POOLER_URL: 'sharedPoolerUrl',
  R2_ACCESS_KEY_ID: 'accessKeyId',
  R2_SECRET_ACCESS_KEY: 'secretAccessKey',
});

/** Fixed legacy Environment secret that may be DELETED after all upserts. */
export const LEGACY_SUPABASE_SECRET = LEGACY_DB_URL_VARIABLE;

export const GITHUB_VARIABLES = Object.freeze({
  SUPABASE_PROJECT_REF: 'projectRef',
  CLOUDFLARE_ACCOUNT_ID: 'accountId',
  R2_BUCKET: 'bucket',
  ENCRYPT_KEY: 'ageRecipient',
});

/**
 * Repository-level variables, upserted after every environment mutation.
 * BACKUPS_ENABLED must be the exact lowercase string `true` for either
 * workflow job to run, so configure always pushes that fixed value.
 */
export const REPOSITORY_VARIABLES = Object.freeze({
  BACKUPS_ENABLED: 'true',
});

const REPOSITORY_ARG = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the `gh` executable across the platform's usual wrappers. Windows
 * package managers (npm/scoop/chocolatey) expose `gh.cmd`/`gh.bat`, not just
 * `gh.exe`, and `lookupExecutable` never auto-appends PATHEXT.
 */
export function resolveGhBin({ lookup, platform = process.platform }) {
  const names = platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh.bat', 'gh'] : ['gh'];
  for (const name of names) {
    const found = lookup(name);
    if (found) return found;
  }
  return null;
}

/**
 * CLI argument contract.
 *
 * - no arguments: null repository override (resolve from REPOSITORY_ROOT)
 * - one positional OWNER/REPO: repository override
 * - -h/--help: help without loading dotenv files or invoking gh
 */
export function parseConfigureGitHubArgs(argv) {
  const positional = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--') {
      throw new Error('github:configure does not accept "--"; pass OWNER/REPO directly');
    }
    if (arg.startsWith('-')) {
      throw new Error(`unexpected github:configure flag: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error('github:configure accepts at most one OWNER/REPO argument');
  }
  if (positional.length === 0) return { repository: null };
  const repository = positional[0];
  if (!REPOSITORY_ARG.test(repository)) {
    throw new Error(
      'github:configure OWNER/REPO must be exactly two non-empty, whitespace-free segments (OWNER/REPO)',
    );
  }
  return { repository };
}

function gitHubMapsFromConfig(config) {
  const secrets = {};
  const variables = {};
  for (const [name, property] of Object.entries(GITHUB_SECRETS)) secrets[name] = config[property];
  for (const [name, property] of Object.entries(GITHUB_VARIABLES)) {
    variables[name] = config[property];
  }
  // NOTE: GITHUB_VARIABLES values are intentionally public (project ref,
  // account id, bucket name, recipient) and are therefore NOT registered for
  // redaction. A future secret must be added to GITHUB_SECRETS instead.
  return { secrets, variables };
}

/**
 * Pure builder: map the EXACT validated in-memory doctor configs through the
 * fixed allowlists. Performs no filesystem read, parsing, or validation —
 * those all happened in the doctor, whose returned values are authoritative
 * here, so a later file mutation can never change what gets uploaded.
 * Registers every value that will be sent to gh so a later failure cannot
 * expose a credential through the logger/error path.
 *
 * @returns {{ configs: Record<string, {secrets: object, variables: object}>, environments: string[] }}
 */
export function buildGitHubEnvironmentConfigs({ validatedConfigs, environments, logger }) {
  const configs = {};
  for (const environment of environments) {
    const maps = gitHubMapsFromConfig(validatedConfigs[environment]);
    for (const value of Object.values(maps.secrets)) logger?.addSecret(value);
    configs[environment] = maps;
  }
  return { configs, environments };
}

/** Parse `gh repo view --json nameWithOwner,isPrivate` stdout defensively. */
function parseRepositoryInfo(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout || '{}');
  } catch {
    throw new Error('repository preflight failed: gh repo view returned malformed JSON');
  }
  const nameWithOwner = parsed?.nameWithOwner;
  if (typeof nameWithOwner !== 'string' || nameWithOwner.length === 0) {
    throw new Error('repository preflight failed: no canonical nameWithOwner returned');
  }
  if (parsed.isPrivate !== true) {
    throw new Error('repository preflight failed: target repository must be private');
  }
  return { nameWithOwner };
}

/**
 * Strip child-process output from an error object so the wrapped cause of a
 * `gh` failure can never leak a secret through logging or serialization.
 * Structured fields (command, exit code, signal) are kept; text fields are
 * redacted.
 */
function sanitizeCause(err, logger) {
  if (!err || typeof err !== 'object') return err;
  const safe = { name: typeof err.name === 'string' ? err.name : 'Error' };
  if (typeof err.command === 'string') safe.command = logger.redact(err.command);
  if (typeof err.exitCode === 'number') safe.exitCode = err.exitCode;
  if (typeof err.signal === 'string') safe.signal = err.signal;
  if (typeof err.message === 'string') safe.message = logger.redact(err.message);
  if (typeof err.stderrTail === 'string') safe.stderrTail = logger.redact(err.stderrTail);
  return safe;
}

/** Upsert one variable/secret; stop on failure and redact before rethrowing. */
async function setGitHubValue({
  run,
  ghBin,
  kind,
  name,
  environment,
  repository,
  value,
  logger,
  signal,
}) {
  // A null environment means repository scope (e.g. the BACKUPS_ENABLED opt-in).
  const args = [kind, 'set', name];
  if (environment) args.push('--env', environment);
  args.push('--repo', repository);
  const scope = environment ?? 'the repository';
  try {
    await run({ command: ghBin, args, input: value, stdout: 'collect', stderr: 'collect', signal });
  } catch (err) {
    throw new Error(
      `github configuration failed: ${kind} ${name} on ${scope}: ${logger.redact(err.message ?? String(err))}`,
      { cause: sanitizeCause(err, logger) },
    );
  }
  logger.status(`github ${repository}: ${kind} ${name} set on ${scope}`);
}

/** Parse `gh secret list --json name` stdout (list of { name }) defensively. */
function parseSecretInventory(stdout) {
  const text = String(stdout ?? '');
  if (text.startsWith(TRUNCATED_MARKER.stdout)) {
    throw new Error(
      'github configuration failed: the environment secret inventory exceeded the capture limit; refusing to guess which secrets already exist',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text || '[]');
  } catch {
    throw new Error('github configuration failed: gh secret list returned malformed JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('github configuration failed: gh secret list returned an unexpected shape');
  }
  const names = new Set();
  for (const entry of parsed) {
    if (entry && typeof entry.name === 'string' && entry.name.length > 0) names.add(entry.name);
  }
  return names;
}

/** Read-only inventory of existing secret names for every configured environment. */
async function inventoryEnvironmentSecrets({
  environments,
  existing,
  ghBin,
  nameWithOwner,
  run,
  root,
  signal,
}) {
  const inventory = {};
  for (const environment of environments) {
    // Environments that do not exist yet have no secrets; do not call the
    // list endpoint before creating them.
    if (!existing.has(environment)) {
      inventory[environment] = new Set();
      continue;
    }
    const res = await run({
      command: ghBin,
      args: ['secret', 'list', '--env', environment, '--repo', nameWithOwner, '--json', 'name'],
      stdout: 'collect',
      stderr: 'collect',
      cwd: root,
      signal,
    });
    inventory[environment] = parseSecretInventory(res.stdout);
  }
  return inventory;
}

/** Delete the fixed legacy secret for one environment; redact before rethrowing. */
async function deleteLegacyGitHubSecret({ run, ghBin, environment, repository, logger, signal }) {
  const args = [
    'secret',
    'delete',
    LEGACY_SUPABASE_SECRET,
    '--env',
    environment,
    '--repo',
    repository,
  ];
  try {
    await run({
      command: ghBin,
      args,
      stdout: 'collect',
      stderr: 'collect',
      signal,
    });
  } catch (err) {
    throw new Error(
      `github configuration failed: secret ${LEGACY_SUPABASE_SECRET} delete on ${environment}: ${logger.redact(err.message ?? String(err))}`,
      { cause: sanitizeCause(err, logger) },
    );
  }
  logger.status(`github ${repository}: secret ${LEGACY_SUPABASE_SECRET} deleted on ${environment}`);
}

/**
 * Full GitHub Environment synchronization. All external commands go through
 * the injected `lookup`/`run` adapters with argument arrays only. Mutation
 * ordering is a contract: validate all local files -> inspect private
 * repository -> list environments -> inventory existing environment secret
 * names -> create missing environments -> upsert every variable and every
 * new secret for every configured environment -> delete SUPABASE_DB_URL only
 * where the pre-mutation inventory showed it existed -> set the
 * repository-level BACKUPS_ENABLED opt-in last.
 */
export async function runConfigureGitHub({
  argv = process.argv.slice(2),
  root = REPOSITORY_ROOT,
  logger = createLogger({ stream: process.stderr }),
  deps = {},
  platform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const {
    doctor = runDoctor,
    buildConfigs = buildGitHubEnvironmentConfigs,
    lookup = lookupExecutable,
    run = runCommand,
  } = deps;

  const parsed = parseConfigureGitHubArgs(argv);
  if (parsed.help) return { help: true };

  // One overall deadline for the whole run, computed BEFORE the doctor: the
  // doctor receives the remaining budget (it still owns its own abort
  // controller) and the GitHub phase gets whatever is left, so a short
  // caller-supplied timeout bounds every phase. The doctor itself runs in
  // static-only mode: configure must work offline, in CI-like environments,
  // and without a running local stack or live hosted endpoints.
  const deadline = Date.now() + timeoutMs;
  const doctorResult = await doctor({
    argv: [],
    root,
    logger,
    timeoutMs: deadline - Date.now(),
    live: false,
  });
  const { configs, environments } = buildConfigs({
    validatedConfigs: doctorResult.configs,
    environments: doctorResult.environments,
    logger,
  });

  if (environments.length === 0) {
    throw new Error('no .env.*.local files found; nothing to configure');
  }

  const ghBin = resolveGhBin({ lookup, platform });
  if (!ghBin) {
    throw new Error('gh CLI not found on PATH; install and authenticate it, then retry');
  }

  // Overall deadline so a stalled `gh` network call cannot hang the run
  // indefinitely; every call shares the same abort signal.
  const remaining = deadline - Date.now();
  const controller = new AbortController();
  if (remaining <= 0) controller.abort();
  const timer =
    Number.isFinite(remaining) && remaining > 0
      ? setTimeout(() => controller.abort(), remaining)
      : null;
  const signal = controller.signal;

  try {
    // Read-only preflight: resolve and inspect the target. The canonical name
    // returned by GitHub is the only value ever used in later paths.
    const viewArgs = parsed.repository
      ? ['repo', 'view', parsed.repository, '--json', 'nameWithOwner,isPrivate']
      : ['repo', 'view', '--json', 'nameWithOwner,isPrivate'];
    const view = await run({
      command: ghBin,
      args: viewArgs,
      stdout: 'collect',
      stderr: 'collect',
      cwd: root,
      signal,
    });
    const { nameWithOwner } = parseRepositoryInfo(view.stdout);

    const list = await run({
      command: ghBin,
      args: [
        'api',
        '--method',
        'GET',
        '--paginate',
        `repos/${nameWithOwner}/environments?per_page=100`,
        '--jq',
        '.environments[].name',
      ],
      stdout: 'collect',
      stderr: 'collect',
      cwd: root,
      signal,
    });
    const listed = String(list.stdout ?? '');
    if (listed.startsWith(TRUNCATED_MARKER.stdout)) {
      throw new Error(
        'github configuration failed: the environment listing exceeded the capture limit; refusing to guess which environments already exist',
      );
    }
    const existing = new Set(
      listed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );

    // Read-only inventory BEFORE any mutation: every existing configured
    // environment's current secret names. Stops on the first failure so
    // environment creation, upserts, and deletion never start on a partial
    // view.
    const inventory = await inventoryEnvironmentSecrets({
      environments,
      existing,
      ghBin,
      nameWithOwner,
      run,
      root,
      signal,
    });

    // Create absent environments only; never touch protection on existing ones.
    const createdEnvironments = [];
    for (const environment of environments) {
      if (existing.has(environment)) continue;
      await run({
        command: ghBin,
        args: [
          'api',
          '--method',
          'PUT',
          `repos/${nameWithOwner}/environments/${encodeURIComponent(environment)}`,
          '--input',
          '-',
        ],
        input: EMPTY_ENVIRONMENT_BODY,
        stdout: 'collect',
        stderr: 'collect',
        cwd: root,
        signal,
      });
      createdEnvironments.push(environment);
      logger.status(`github ${nameWithOwner}: created environment ${environment}`);
    }

    const upserts = {};
    for (const environment of environments) {
      const counts = { variables: 0, secrets: 0 };
      for (const [name, value] of Object.entries(configs[environment].variables)) {
        await setGitHubValue({
          run,
          ghBin,
          kind: 'variable',
          name,
          environment,
          repository: nameWithOwner,
          value,
          logger,
          signal,
        });
        counts.variables += 1;
      }
      for (const [name, value] of Object.entries(configs[environment].secrets)) {
        await setGitHubValue({
          run,
          ghBin,
          kind: 'secret',
          name,
          environment,
          repository: nameWithOwner,
          value,
          logger,
          signal,
        });
        counts.secrets += 1;
      }
      upserts[environment] = counts;
    }

    if (signal.aborted) {
      throw new Error(`github:configure timed out after ${timeoutMs}ms`);
    }

    // Deletion phase: no legacy secret is touched until EVERY environment
    // completed all upserts. Only the fixed legacy name may be deleted, and
    // only where the pre-mutation inventory showed it existed (absent secrets
    // are skipped, so reruns converge). A deletion failure stops later
    // deletions but leaves the replacement secrets installed.
    const legacySecretDeletions = {};
    for (const environment of environments) {
      legacySecretDeletions[environment] = false;
      if (!inventory[environment].has(LEGACY_SUPABASE_SECRET)) continue;
      await deleteLegacyGitHubSecret({
        run,
        ghBin,
        environment,
        repository: nameWithOwner,
        logger,
        signal,
      });
      legacySecretDeletions[environment] = true;
    }

    // Repository-level opt-in, strictly last: a failed upsert or deletion
    // must never leave the backup jobs enabled on a partial configuration.
    await setGitHubValue({
      run,
      ghBin,
      kind: 'variable',
      name: 'BACKUPS_ENABLED',
      environment: null,
      repository: nameWithOwner,
      value: REPOSITORY_VARIABLES.BACKUPS_ENABLED,
      logger,
      signal,
    });

    return {
      repository: nameWithOwner,
      createdEnvironments,
      upserts,
      backupsEnabled: true,
      legacySecretDeletions,
    };
  } catch (err) {
    if (signal.aborted) {
      // A real child-process abort (ProcessAbortedError) or a stall both mean
      // the run exceeded its deadline; report that uniformly.
      throw new Error(`github:configure timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** CLI entry point. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
  try {
    const result = await runConfigureGitHub({ logger });
    if (result?.help) {
      process.stdout.write('usage: vp run github:configure [OWNER/REPO]\n');
      process.stdout.write(
        'Synchronizes both the development and production GitHub Environments from the local .env files.\n',
      );
    }
    return 0;
  } catch (err) {
    logger.error(`github configuration failed: ${logger.redact(err.message ?? String(err))}`);
    if (err.cause) {
      const cause = err.cause;
      const detail =
        (typeof cause.message === 'string' && cause.message) ||
        (typeof cause.stderrTail === 'string' && cause.stderrTail) ||
        String(cause);
      logger.error(`cause: ${logger.redact(String(detail))}`);
    }
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
