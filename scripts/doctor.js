#!/usr/bin/env node
/**
 * Standalone local-configuration doctor.
 *
 *   npm run doctor
 *
 * Validates the complete local configuration against the fixed dotenv files:
 * every checked file must be a private 0600 regular file (no symlinks, no
 * group/world access) containing all supported variables — except the
 * restore-only DECRYPT_KEY, which warns when absent and must match the
 * recipient when present. All static checks complete before any external
 * call, and a green static phase is followed by sequential READ-ONLY live
 * probes (Dockerized psql SELECT 1 per environment, R2 HeadBucket, age
 * key-pair derivation via `age-keygen -y`, and the selected local stack);
 * `live: false` skips the probes entirely (github:configure uses this).
 * Diagnostics name files, environments, variables, and check types only:
 * never values, URLs, passwords, credentials, age keys, or configured paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable } from '../src/process.js';
import {
  loadDoctorConfig,
  ConfigError,
  DOCTOR_VARIABLE_NAMES,
  ENVIRONMENTS,
  LEGACY_VARIABLE_RENAMES,
  REPOSITORY_ROOT,
} from '../src/config.js';
import { PINNED_SUPABASE_POSTGRES_IMAGE } from '../src/database.js';
import { readOnlyPreflight } from '../src/hosted-restore.js';
import { headBucketCheck, createS3Adapter } from '../src/r2.js';
import { assertLocalStackRunning } from '../src/local-backup.js';
import { validateWorkdir } from '../src/local-stack.js';
import { resolveAgeKeygen } from './generate-age-keys.js';

/** Operational deadline convention shared with the other scripts. */
export const DEFAULT_DOCTOR_TIMEOUT_MS = 10 * 60 * 1000;

/** Aggregated, fully sanitized doctor failure. Never carries raw causes. */
export class DoctorError extends Error {
  constructor(problems) {
    super(
      `Doctor failed with ${problems.length} error(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'DoctorError';
    this.problems = problems;
  }
}

/** Fixed check order: development first, then required production. Derived
 * from the canonical environment list; only the production-required policy
 * lives here. */
const DOCTOR_ENVIRONMENTS = Object.freeze(
  ENVIRONMENTS.map((environment) => ({ environment, required: environment === 'production' })),
);

/** Fixed dotenv basename per environment (the only path ever named). */
function dotenvFilePath(root, environment) {
  return path.join(root, `.env.${environment}.local`);
}

/**
 * Scan raw active assignment names without changing dotenv resolution.
 * Supports ordinary assignments and the optional `export` prefix; comments
 * and blank lines never count. The key charset matches dotenv's parser
 * (`[\w.-]+`, `=` or `: ` separators) so duplicate counts cover every key
 * dotenv accepts. `dotenv.parse` remains authoritative for effective values.
 */
function scanAssignments(raw) {
  const counts = new Map();
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*|\s*:\s+)/.exec(line);
    if (!match) continue;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return counts;
}

/** Warning-only contract: legacy, unknown, missing restore-only fields, and duplicate assignment names. */
function collectDoctorWarnings({ environment, parsed, assignments, logger }) {
  const supported = new Set(DOCTOR_VARIABLE_NAMES);
  // Effective keys come from the parser itself, so every key dotenv accepts
  // is covered and the warning set can never drift from the parse result.
  for (const name of Object.keys(parsed)) {
    if (LEGACY_VARIABLE_RENAMES[name]) {
      logger.warn(
        `${environment}: UNSUPPORTED ${name} (rename to ${LEGACY_VARIABLE_RENAMES[name]})`,
      );
    } else if (!supported.has(name)) {
      logger.warn(`${environment}: UNKNOWN ${name}`);
    }
  }
  // The private identity is restore-only: never required, always warned so a
  // later r2/repo restore cannot surprise a backup-only setup.
  if (!Object.hasOwn(parsed, 'DECRYPT_KEY')) {
    logger.warn(`${environment}: MISSING DECRYPT_KEY (r2/repo restores only)`);
  }
  for (const [name, count] of assignments) {
    if (count > 1) logger.warn(`${environment}: DUPLICATE ${name} (${count} assignments)`);
  }
}

const TIMEOUT_FAILURE_PREFIX = 'doctor timed out after ';

/**
 * Static phase: read every fixed dotenv path, enforce the file-ownership
 * contract, register every parsed credential value for redaction, scan
 * warnings, load the file-only doctor config, and independently validate
 * SUPABASE_CONFIG_PATH. Any static problem aborts before a single lookup,
 * subprocess, Docker, database, or R2 call.
 */
function runStaticPhase({ root, logger, doValidateWorkdir, platform }) {
  const staticProblems = [];
  const configs = {};
  const validatedWorkdirs = {};
  const environments = [];

  for (const { environment, required } of DOCTOR_ENVIRONMENTS) {
    const filePath = dotenvFilePath(root, environment);
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (required) {
          staticProblems.push(`MISSING .env.${environment}.local`);
        } else {
          logger.status('doctor: skipped development (no .env.development.local file)');
        }
        continue;
      }
      staticProblems.push(`${environment}: unreadable dotenv file`);
      continue;
    }
    // The file now holds the hosted DB password, R2 credentials, and the
    // private age identity: a successful doctor must not bless config already
    // exposed to other local users. Symlinks are rejected outright (the path
    // is fixed; a link can only redirect elsewhere). Windows stat modes are
    // not meaningful, so the ownership check is skipped there.
    if (!stat.isFile()) {
      staticProblems.push(
        `${environment}: INSECURE .env.${environment}.local (must be a regular file, not a symlink)`,
      );
      continue;
    }
    if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      staticProblems.push(
        `${environment}: INSECURE .env.${environment}.local (must be readable only by the owner; run chmod 600)`,
      );
      continue;
    }

    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      staticProblems.push(`${environment}: unreadable dotenv file`);
      continue;
    }

    const parsed = dotenv.parse(raw);
    registerDoctorSecrets(parsed, logger);
    collectDoctorWarnings({ environment, parsed, assignments: scanAssignments(raw), logger });

    const rawConfigPath = parsed.SUPABASE_CONFIG_PATH;
    const rawConfigPathValue = typeof rawConfigPath === 'string' ? rawConfigPath.trim() : '';
    try {
      const doctorConfig = loadDoctorConfig({
        environment,
        root,
        vars: {},
        dotenvPath: filePath,
        dotenvContent: raw,
      });
      configs[environment] = doctorConfig;
      logger.status(`doctor ${environment}: configuration contract valid`);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      for (const problem of err.problems) staticProblems.push(`${environment}: ${problem}`);
    }

    // Independent of the loader result: a file whose contract failed still
    // reports its config-path problem so static diagnostics stay complete.
    if (rawConfigPathValue.length > 0) {
      const resolved = path.isAbsolute(rawConfigPathValue)
        ? rawConfigPathValue
        : path.resolve(root, rawConfigPathValue);
      try {
        const workdirResult = doValidateWorkdir({ supabaseConfigPath: resolved, repoRoot: root });
        validatedWorkdirs[environment] = workdirResult;
      } catch {
        // Static label only: the validator's raw message is discarded so a
        // failing validator can never surface values or configured paths.
        staticProblems.push(`${environment}: INVALID SUPABASE_CONFIG_PATH`);
      }
    }
    environments.push(environment);
  }

  return { staticProblems, configs, validatedWorkdirs, environments };
}

/**
 * Register ONLY credential-carrying fields for redaction. Public labels
 * (BACKUP_ENVIRONMENT, R2_BUCKET, project ref, account ID, recipient,
 * config path) must stay readable in diagnostics: redacting them would make
 * failures from both files indistinguishable.
 */
const DOCTOR_SECRET_FIELDS = new Set([
  'SUPABASE_SHARED_POOLER_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'DECRYPT_KEY',
]);

function registerDoctorSecrets(parsed, logger) {
  for (const [name, value] of Object.entries(parsed)) {
    if (DOCTOR_SECRET_FIELDS.has(name) && typeof value === 'string' && value.length > 0) {
      logger.addSecret(value);
    }
  }
}

/**
 * Full doctor run: static barrier, then (unless `live: false`) sequential
 * read-only live probes in deterministic environment order, then the
 * selected local stack. Every live failure is stored as one allowlisted
 * static problem; raw errors, stderr, and causes are discarded. Returns the
 * EXACT validated in-memory configs.
 */
export async function runDoctor({
  argv = process.argv.slice(2),
  root = REPOSITORY_ROOT,
  logger = createLogger({ stream: process.stderr }),
  deps = {},
  platform = process.platform,
  timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS,
  live = true,
} = {}) {
  const {
    lookup = lookupExecutable,
    run = runCommand,
    createAdapter = createS3Adapter,
    doPreflight = readOnlyPreflight,
    doHeadBucket = headBucketCheck,
    doLocalStack = assertLocalStackRunning,
    doValidateWorkdir = validateWorkdir,
    resolveAge = resolveAgeKeygen,
  } = deps;

  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.length > 0) {
    throw new DoctorError(['doctor does not accept command-line arguments']);
  }

  const controller = new AbortController();
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  const signal = controller.signal;

  try {
    const { staticProblems, configs, validatedWorkdirs, environments } = runStaticPhase({
      root,
      logger,
      doValidateWorkdir,
      platform,
    });
    if (staticProblems.length > 0) {
      throw new DoctorError(staticProblems);
    }

    const localEnvironment = configs.development ? 'development' : 'production';
    if (!live) {
      // Static-only mode for github:configure: no Docker, no network, no
      // probes — the exact validated values are still returned. The age
      // identity is absent from backup-only files, which is fine here too.
      logger.status(
        `doctor: ${environments.length} environment(s) validated; static checks passed (live probes skipped)`,
      );
      return { environments, configs, localEnvironment };
    }

    const liveProblems = [];
    const timeoutProblem = `${TIMEOUT_FAILURE_PREFIX}${Math.round(timeoutMs)}ms`;

    const dockerPath = lookup(platform === 'win32' ? 'docker.exe' : 'docker');
    const ageKeygen = resolveAge({ lookup, platform });
    if (!dockerPath) {
      liveProblems.push(
        'docker executable not found (hosted Supabase and local database checks skipped)',
      );
    }
    if (!ageKeygen) {
      liveProblems.push('age-keygen executable not found (age key-pair checks skipped)');
    }

    for (const environment of environments) {
      const cfg = configs[environment];
      if (!cfg || signal.aborted) continue;

      if (dockerPath && !signal.aborted) {
        try {
          await doPreflight({
            dockerPath,
            postgresImage: PINNED_SUPABASE_POSTGRES_IMAGE,
            dbUrl: cfg.sharedPoolerUrl,
            run,
            signal,
          });
          logger.status(`doctor ${environment}: hosted database reachable (SELECT 1)`);
        } catch {
          liveProblems.push(`${environment}: SUPABASE connection failed`);
        }
      }
      if (signal.aborted) break;

      let adapter = null;
      if (!signal.aborted) {
        try {
          adapter = createAdapter({
            accountId: cfg.accountId,
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
          });
        } catch {
          // Client construction is not an access failure; label it distinctly
          // so adapter bugs are not confused with credential/scope problems.
          liveProblems.push(`${environment}: R2 client initialization failed`);
        }
      }
      if (adapter && !signal.aborted) {
        try {
          await doHeadBucket({ adapter, bucket: cfg.bucket, signal });
          logger.status(`doctor ${environment}: R2 bucket reachable (HeadBucket)`);
        } catch {
          liveProblems.push(`${environment}: R2 bucket access failed`);
        }
      }
      if (signal.aborted) break;

      if (ageKeygen && cfg.ageIdentity && !signal.aborted) {
        try {
          const res = await run({
            command: ageKeygen,
            args: ['-y'],
            input: `${cfg.ageIdentity}\n`,
            // The identity is the only secret here: the recipient is PUBLIC
            // (github:configure uploads it as a variable) AND it is the very
            // stdout this probe compares against — registering it would have
            // the redactor rewrite the captured output to "***" and fail the
            // comparison for every environment.
            secretArgs: [cfg.ageIdentity],
            stdout: 'collect',
            stderr: 'collect',
            signal,
          });
          const lines = String(res.stdout ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          if (lines.length !== 1 || lines[0] !== cfg.ageRecipient) {
            throw new Error('age key-pair output mismatch');
          }
          logger.status(`doctor ${environment}: age key pair valid`);
        } catch {
          liveProblems.push(`${environment}: age key-pair validation failed`);
        }
      }
    }

    const localStack = validatedWorkdirs[localEnvironment];
    if (dockerPath && localStack && !signal.aborted) {
      try {
        await doLocalStack({ dockerPath, dbContainer: localStack.dbContainer, run, signal });
        logger.status('doctor: local database stack reachable (SELECT 1)');
      } catch {
        liveProblems.push('local database connection failed');
      }
    }

    if (signal.aborted) liveProblems.push(timeoutProblem);

    if (liveProblems.length > 0) {
      // staticProblems is always empty here: the static barrier above already
      // threw, so only live failures can reach this point.
      throw new DoctorError(liveProblems);
    }

    logger.status(
      `doctor: ${environments.length} environment(s) validated; all read-only checks passed`,
    );
    return { environments, configs, localEnvironment };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** CLI entry point: help, then run, exit 0/1. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
  try {
    const result = await runDoctor({ logger });
    if (result?.help) {
      process.stdout.write('usage: npm run doctor\n');
      process.stdout.write(
        'Validates the complete local configuration with read-only hosted database, R2 bucket, age key-pair, and local database connectivity checks.\n',
      );
    }
    return 0;
  } catch (err) {
    logger.error(
      `doctor failed: ${err instanceof DoctorError ? err.message : logger.redact(err.message ?? String(err))}`,
    );
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
