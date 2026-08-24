/**
 * The single CLI grammar boundary: every raw token from `process.argv` is
 * parsed only here. Application runners consume validated plain option
 * objects and never touch raw arguments.
 *
 * Uses the pinned runtime's `node:util` `parseArgs` in strict mode: unknown
 * flags, missing option values, unexpected positionals, and a literal `--`
 * separator all reject before any configuration loading or external work.
 * Enum validation (environment/source) happens after syntactic parsing.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { ENVIRONMENTS } from '../src/config.js';

export const BACKUP_USAGE =
  'usage: vp run backup --environment <development|production> [--staging-dir <path>]';
export const COMMIT_WEEKLY_USAGE =
  'usage: vp run commit:weekly --staging-dir <path> [--repo-root <path>]';
export const HOSTED_RESTORE_USAGE =
  'usage: vp run restore:development|restore:production --source <r2|repo> --backup <latest|snapshot-id>';
export const LOCAL_RESTORE_USAGE =
  'usage: vp run restore:local --environment <development|production> --source <r2|repo> --backup <latest|snapshot-id>';
export const LOCAL_BACKUP_USAGE =
  'usage: vp run backup:local --environment <development|production>';

const SOURCES = ['r2', 'repo'];

/** Map a restore result to its CLI exit code: 0 success/help, 2 declined. */
export function exitCodeForResult(result) {
  if (result?.help) return 0;
  if (result && result.confirmed === false) return 2;
  return 0;
}

/** Reject empty/whitespace-only path option values. */
function resolvePathOption(value, cwd, optionName) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${optionName} must be a non-empty path`);
  }
  return path.resolve(cwd, value);
}

const HELP_OPTIONS = { help: { type: 'boolean', short: 'h' } };
const BACKUP_OPTIONS = {
  ...HELP_OPTIONS,
  environment: { type: 'string' },
  'staging-dir': { type: 'string' },
};
const COMMIT_WEEKLY_OPTIONS = {
  ...HELP_OPTIONS,
  'staging-dir': { type: 'string' },
  'repo-root': { type: 'string' },
};
const RESTORE_OPTIONS = {
  ...HELP_OPTIONS,
  source: { type: 'string' },
  backup: { type: 'string' },
};
const LOCAL_RESTORE_OPTIONS = {
  ...RESTORE_OPTIONS,
  environment: { type: 'string' },
};
const LOCAL_BACKUP_OPTIONS = {
  ...HELP_OPTIONS,
  environment: { type: 'string' },
};

/**
 * Parse the daily-backup arguments.
 * @returns {{environment:string, stagingDir:string|null}|{help:true}}
 */
export function parseBackupArgs(argv, { cwd = process.cwd() } = {}) {
  const parsed = parseArgs({
    args: argv,
    options: BACKUP_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  const values = parsed.values;
  if (values.help) return { help: true };
  const environment = values.environment;
  if (environment === undefined) {
    throw new Error('backup requires --environment development|production');
  }
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error('backup --environment must be development or production');
  }
  const stagingDir = resolvePathOption(values['staging-dir'], cwd, 'backup --staging-dir') ?? null;
  return { environment, stagingDir };
}

/**
 * Parse the weekly commit-planning arguments.
 * `--repo-root` defaults to the parser's cwd.
 * @returns {{stagingDir:string, repoRoot:string}|{help:true}}
 */
export function parseCommitWeeklyArgs(argv, { cwd = process.cwd() } = {}) {
  const parsed = parseArgs({
    args: argv,
    options: COMMIT_WEEKLY_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  const values = parsed.values;
  if (values.help) return { help: true };
  const stagingDir = values['staging-dir'];
  if (stagingDir === undefined) {
    throw new Error('commit-weekly requires --staging-dir <path>');
  }
  const repoRoot = resolvePathOption(values['repo-root'], cwd, 'commit-weekly --repo-root') ?? cwd;
  return {
    stagingDir: resolvePathOption(stagingDir, cwd, 'commit-weekly --staging-dir'),
    repoRoot,
  };
}

/**
 * Parse the hosted restore arguments: a fixed target positional
 * (`development|production`) followed by `--source`/`--backup` flags.
 * @returns {{target:string, source:string, backup:string}|{help:true}}
 */
export function parseHostedRestoreArgs(argv) {
  if (argv.length === 0) {
    throw new Error('restore:development|production requires a target of development|production');
  }
  const [target, ...rest] = argv;
  if (target === '--help' || target === '-h') return { help: true };
  if (!ENVIRONMENTS.includes(target)) {
    throw new Error(
      `restore:development|production must fix the target environment; got ${target}`,
    );
  }
  const parsed = parseArgs({
    args: rest,
    options: RESTORE_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  const values = parsed.values;
  if (values.help) return { help: true };
  const source = values.source;
  if (source === undefined || !SOURCES.includes(source)) {
    throw new Error('restore requires --source r2|repo');
  }
  if (values.backup === undefined) {
    throw new Error('restore requires --backup latest|<snapshot-id>');
  }
  return { target, source, backup: values.backup };
}

/**
 * Parse the local-backup arguments: strict grammar, no output-path option.
 * @returns {{environment:string}|{help:true}}
 */
export function parseLocalBackupArgs(argv) {
  const parsed = parseArgs({
    args: argv,
    options: LOCAL_BACKUP_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  const values = parsed.values;
  if (values.help) return { help: true };
  const environment = values.environment;
  if (environment === undefined) {
    throw new Error('backup:local requires --environment development|production');
  }
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error('backup:local --environment must be development or production');
  }
  return { environment };
}

/**
 * Parse the local restore arguments.
 * @returns {{environment:string, source:string, backup:string}|{help:true}}
 */
export function parseLocalRestoreArgs(argv) {
  const parsed = parseArgs({
    args: argv,
    options: LOCAL_RESTORE_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  const values = parsed.values;
  if (values.help) return { help: true };
  const environment = values.environment;
  if (environment === undefined || !ENVIRONMENTS.includes(environment)) {
    throw new Error('restore:local requires --environment development|production');
  }
  const source = values.source;
  if (source === undefined || !SOURCES.includes(source)) {
    throw new Error('restore:local requires --source r2|repo');
  }
  if (values.backup === undefined) {
    throw new Error('restore:local requires --backup latest|<snapshot-id>');
  }
  return { environment, source, backup: values.backup };
}
