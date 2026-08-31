/**
 * Supabase logical dump adapter.
 *
 * Generates the six logical SQL inputs consumed by snapshot packaging using
 * the repository-pinned Supabase CLI (2.114.0). Everything runs through the
 * shared safe process runner with argument arrays and `shell: false`, the
 * database URL is always marked secret, and no URL or row data is ever
 * printed. Partial output cleanup is the CALLER's responsibility.
 */

import fs from 'node:fs';
import path from 'node:path';
import { lookupExecutable } from './process.js';
import { urlPassword } from './config.js';
import { ordinal } from './progress.js';
import { resolvePrivatePath, POSTGRES_MAJOR_VERSION } from './snapshot.js';

export const PINNED_SUPABASE_CLI_VERSION = '2.114.0';

/**
 * Supabase Postgres image pinned by immutable manifest DIGEST, never a
 * mutable tag: the registry verifies the digest, so a re-pointed or
 * compromised tag can never be executed by a destructive restore. The
 * reviewed human-readable tag kept below is documentation/upgrade context
 * ONLY — code executes the digest reference. Both pins come from the same
 * CLI release and must move together on upgrades; hosted restores run
 * `psql` 17 from this ephemeral image.
 */
export const PINNED_SUPABASE_POSTGRES_TAG = 'public.ecr.aws/supabase/postgres:17.6.1.158';
export const PINNED_SUPABASE_POSTGRES_IMAGE =
  'public.ecr.aws/supabase/postgres@sha256:99b1729aeb0bac314445024fc149fbd39306170b61dd50800ccf180327ab3459';

export const DUMP_FILE_NAMES = {
  roles: 'roles.sql',
  schema: 'schema.sql',
  managed: 'managed-schema.sql',
  migrationHistorySchema: 'migration-history-schema.sql',
  migrationHistoryData: 'migration-history-data.sql',
  databaseData: 'database-data.sql',
};

export const ALL_DUMP_FILES = Object.values(DUMP_FILE_NAMES);

export class DumpError extends Error {
  constructor(message, { cause, step } = {}) {
    super(message);
    this.name = 'DumpError';
    this.cause = cause;
    this.step = step;
  }
}

/** Locate the repository-pinned Supabase CLI executable. */
export function locateSupabaseCli({ root = process.cwd() } = {}) {
  const candidates = [path.join(root, 'node_modules', '.bin', 'supabase')];
  if (process.platform === 'win32') candidates.push(`${candidates[0]}.cmd`);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * Preflight: Docker present, CLI present, CLI version pinned. Runs nothing
 * network or Docker related; version read is a local command.
 */
export async function preflightSupabase({
  dockerPath,
  supabasePath,
  run,
  lookup = lookupExecutable,
}) {
  const docker = dockerPath ?? lookup(process.platform === 'win32' ? 'docker.exe' : 'docker');
  if (!docker || (dockerPath && !fs.existsSync(dockerPath))) {
    throw new DumpError(
      'Docker is required for Supabase dump/diff commands and was not found on PATH',
    );
  }
  if (!supabasePath || !fs.existsSync(supabasePath)) {
    throw new DumpError(
      `Supabase CLI not found at ${supabasePath ?? 'node_modules/.bin/supabase'}; run vp install --frozen-lockfile`,
    );
  }
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
    throw new DumpError('Supabase CLI version check failed', { cause: err });
  }
  if (version !== PINNED_SUPABASE_CLI_VERSION) {
    throw new DumpError(
      `Supabase CLI must be exactly ${PINNED_SUPABASE_CLI_VERSION}; found ${version}. Update the pin in package.json and run vp install.`,
    );
  }
  return { dockerPath: docker, supabasePath, cliVersion: version };
}

function fileArgs(outDir, name) {
  return ['--file', path.join(outDir, name)];
}

/**
 * Ordered declarative `db dump` command specs (file outputs). Immutable;
 * the builder never mutates them. The managed `db diff` step has its own
 * explicit spec below.
 */
const FILE_DUMP_SPECS = Object.freeze({
  roles: Object.freeze({
    name: 'roles',
    label: 'roles',
    file: DUMP_FILE_NAMES.roles,
    flags: Object.freeze(['--role-only']),
  }),
  schema: Object.freeze({
    name: 'schema',
    label: 'database schema',
    file: DUMP_FILE_NAMES.schema,
    flags: Object.freeze([]),
  }),
  migrationHistorySchema: Object.freeze({
    name: 'migrationHistorySchema',
    label: 'migration-history schema',
    file: DUMP_FILE_NAMES.migrationHistorySchema,
    flags: Object.freeze(['--schema', 'supabase_migrations']),
  }),
  migrationHistoryData: Object.freeze({
    name: 'migrationHistoryData',
    label: 'migration-history data',
    file: DUMP_FILE_NAMES.migrationHistoryData,
    flags: Object.freeze(['--schema', 'supabase_migrations', '--data-only', '--use-copy']),
  }),
  databaseData: Object.freeze({
    name: 'databaseData',
    label: 'database data',
    file: DUMP_FILE_NAMES.databaseData,
    flags: Object.freeze([
      '--data-only',
      '--use-copy',
      '--exclude',
      'storage.buckets_vectors',
      '--exclude',
      'storage.vector_indexes',
    ]),
  }),
});

/**
 * The managed auth/storage delta: `db diff` streamed to managed-schema.sql.
 * --output-format text makes the CLI emit raw SQL on stdout; the shared
 * runner streams it directly to the file (JSON mode would put an escaped
 * diff inside a JSON envelope instead).
 */
const MANAGED_DIFF_SPEC = Object.freeze({
  name: 'managed',
  label: 'managed auth/storage schema',
  file: DUMP_FILE_NAMES.managed,
  flags: Object.freeze(['--schema', 'auth,storage', '--use-migra', '--output-format', 'text']),
});

/** Small builder for one file-based `db dump` command. */
function buildFileDumpCommand({ spec, dbUrl, outDir }) {
  return {
    name: spec.name,
    label: spec.label,
    args: ['db', 'dump', '--db-url', dbUrl, ...fileArgs(outDir, spec.file), ...spec.flags],
    secretArgs: [dbUrl],
  };
}

/** Builder for the single managed `db diff` command with streamed stdout. */
function buildManagedDiffCommand({ dbUrl, outDir }) {
  return {
    name: MANAGED_DIFF_SPEC.name,
    label: MANAGED_DIFF_SPEC.label,
    args: ['db', 'diff', '--db-url', dbUrl, ...MANAGED_DIFF_SPEC.flags],
    stdout: { file: path.join(outDir, MANAGED_DIFF_SPEC.file) },
    secretArgs: [dbUrl],
  };
}

/**
 * The full six-command dump order, declared once: roles, schema, the managed
 * auth/storage delta (position 3, contract: schema files precede it and the
 * migration-history dump follows), then migration history, then row data.
 */
const DUMP_COMMAND_ORDER = Object.freeze([
  'roles',
  'schema',
  'managed',
  'migrationHistorySchema',
  'migrationHistoryData',
  'databaseData',
]);

/**
 * Pure builder: the six ordered commands with exact argument arrays.
 * The DB URL is marked secret on every command; shell is never enabled
 * (the shared runner guarantees `shell: false`).
 */
export function buildDumpCommands({ dbUrl, outDir }) {
  return DUMP_COMMAND_ORDER.map((name) =>
    name === MANAGED_DIFF_SPEC.name
      ? buildManagedDiffCommand({ dbUrl, outDir })
      : buildFileDumpCommand({ spec: FILE_DUMP_SPECS[name], dbUrl, outDir }),
  );
}

function sanitize(err, secrets) {
  let text = `${err.message ?? String(err)}`;
  for (const secret of secrets) {
    text = text.split(secret).join('[REDACTED]');
  }
  const stderrTail = err.stderrTail ? String(err.stderrTail) : '';
  let safeStderr = stderrTail;
  for (const secret of secrets) {
    safeStderr = safeStderr.split(secret).join('[REDACTED]');
  }
  return { message: text, stderrTail: safeStderr };
}

/**
 * Execute the six dumps sequentially with the pinned CLI. Stops on the first
 * failure. The URL password is additionally treated as a redaction secret so
 * CLI stderr echoing the URL can never surface.
 */
export async function runDumps({
  dbUrl,
  cwd,
  outDir,
  supabasePath,
  dockerPath,
  run,
  signal,
  onProgress,
}) {
  onProgress?.('starting Supabase CLI/Docker preflight');
  await preflightSupabase({ dockerPath, supabasePath, run });
  onProgress?.('completed Supabase CLI/Docker preflight');

  const commands = buildDumpCommands({ dbUrl, outDir });
  const secrets = [dbUrl, urlPassword(dbUrl)].filter(Boolean);
  try {
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      onProgress?.(`starting logical dump ${ordinal(i, commands.length)}: ${command.label}`);
      await run({
        command: supabasePath,
        args: command.args,
        secretArgs: command.secretArgs,
        stdout: command.stdout ?? 'inherit',
        stderr: 'collect',
        cwd,
        signal,
      });
      onProgress?.(`completed logical dump ${ordinal(i, commands.length)}: ${command.label}`);
    }
  } catch (err) {
    const safe = sanitize(err, secrets);
    throw new DumpError(
      `${safe.message}${safe.stderrTail ? ` (stderr: ${safe.stderrTail})` : ''}`,
      {
        cause: err,
        step: err.step,
      },
    );
  }
  return commands;
}

/** Inspect one declared dump output; returns its path+size or a problem text. */
function inspectDumpOutput({ outDir, name }) {
  const filePath = resolvePrivatePath(outDir, name);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { problem: `MISSING dump output ${name}` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { problem: `INVALID dump output ${name} (must be a regular file)` };
  }
  if (stat.size === 0 && name !== DUMP_FILE_NAMES.managed) {
    return { problem: `EMPTY dump output ${name}` };
  }
  return { filePath, size: stat.size };
}

/** Reject any file in the dump directory that is not a declared output. */
function collectUnexpectedDumpOutputs(outDir) {
  const problems = [];
  const entries = fs.readdirSync(outDir);
  for (const entry of entries) {
    if (!ALL_DUMP_FILES.includes(entry)) {
      problems.push(`UNEXPECTED dump output ${entry}`);
    }
  }
  return problems;
}

/** Normalize dump outputs to mode 0600 where the platform supports it. */
function applyPrivateDumpModes(files) {
  if (process.platform !== 'win32') {
    for (const filePath of Object.values(files)) {
      fs.chmodSync(filePath, 0o600);
    }
  }
}

/**
 * Validate the six outputs: regular private files only, inside the expected
 * directory, all nonempty except managed-schema.sql, mode 0600 where
 * supported.
 */
export function validateDumpOutputs(outDir) {
  const problems = [];
  const files = {};
  let managedSize = null;
  for (const [key, name] of Object.entries(DUMP_FILE_NAMES)) {
    const inspected = inspectDumpOutput({ outDir, name });
    if (inspected.problem) {
      problems.push(inspected.problem);
      continue;
    }
    files[key] = inspected.filePath;
    if (key === 'managed') managedSize = inspected.size;
  }
  problems.push(...collectUnexpectedDumpOutputs(outDir));
  if (problems.length > 0) {
    throw new DumpError(problems.join('; '));
  }
  applyPrivateDumpModes(files);
  return {
    files,
    managedSchemaEmpty: managedSize === 0,
  };
}

/**
 * Full adapter: preflight, sequential dumps, output validation.
 * Returns a stable result consumed by snapshot packaging. Callers own the
 * workspace and must remove private intermediates in their own finally.
 */
export async function dumpDatabase({
  dbUrl,
  cwd,
  outDir,
  supabasePath,
  dockerPath,
  run,
  signal,
  onProgress,
}) {
  await runDumps({ dbUrl, cwd, outDir, supabasePath, dockerPath, run, signal, onProgress });
  onProgress?.('starting dump output validation');
  const validated = validateDumpOutputs(outDir);
  onProgress?.('completed dump output validation');
  return {
    dir: outDir,
    files: validated.files,
    managedSchemaEmpty: validated.managedSchemaEmpty,
    cliVersion: PINNED_SUPABASE_CLI_VERSION,
    postgresMajorVersion: POSTGRES_MAJOR_VERSION,
  };
}
