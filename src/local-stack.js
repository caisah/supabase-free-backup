/**
 * Read-only local-stack helpers for `backup:local` and `restore:local`.
 *
 * Hosts the workdir parsing/validation and the read-only psql probe used by
 * the local backup store and the local restore flow (which lives in
 * local-restore.js). Nothing here starts, stops, resets, or migrates the
 * local stack, and a local snapshot carries the store label `local` and NO
 * project ref — the hosted restore target is chosen at RESTORE time
 * (`restore:development|production --source local`) and is never expected
 * on a local snapshot's manifest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { POSTGRES_MAJOR_VERSION } from './snapshot.js';
import { psqlOutputLines } from './process.js';

export class LocalStackError extends Error {
  constructor(message, { cause, stage } = {}) {
    super(message);
    this.name = 'LocalStackError';
    this.cause = cause;
    this.stage = stage;
  }
}

/**
 * Extract the `[db]` section lines from a normalized (LF) config.toml.
 * The header may carry an inline comment (`[db] # notes`), and the section
 * may run to EOF with no trailing newline; the scan stops at the next line
 * that starts any section header (`[`). Returns the section text or ''.
 */
function dbSectionOf(configToml) {
  const lines = configToml.split('\n');
  const start = lines.findIndex((l) => /^\[db\]\s*(#.*)?$/.test(l.trim()));
  if (start === -1) return '';
  const section = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('[')) break;
    section.push(lines[i]);
  }
  return section.join('\n');
}

/** Parse the [db] section of a Supabase config.toml (CRLF-tolerant). */
export function parseWorkdirConfig(configToml) {
  // Normalize CRLF so a Windows-checked-out config.toml parses identically.
  const normalized = configToml.replace(/\r\n/g, '\n');
  const dbSection = dbSectionOf(normalized);
  // Line-anchored within the section so commented-out lookalikes
  // (`# major_version = 15`) can never win over the real assignment;
  // keys may be indented and strings single- or double-quoted (valid TOML).
  const major = /^\s*major_version\s*=\s*(\d+)/m.exec(dbSection);
  const port = /^\s*port\s*=\s*(\d+)/m.exec(dbSection);
  const projectId = /^\s*project_id\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(normalized);
  return {
    projectId: projectId ? (projectId[1] ?? projectId[2]) : null,
    majorVersion: major ? Number(major[1]) : null,
    dbPort: port ? Number(port[1]) : null,
  };
}

const SUPABASE_CONFIG_BASENAME = 'config.toml';
const SUPABASE_DIRNAME = 'supabase';
const DB_CONTAINER_PREFIX = 'supabase_db_';

/**
 * Validate SUPABASE_CONFIG_PATH as the exact main-project config file.
 * Error messages name the variable only (never the filesystem path),
 * matching the config.js names-only policy. Order matters: existence/file
 * checks and the LAYOUT check run on the configured path BEFORE
 * canonicalization, so a symlink alias with a different name cannot bypass
 * the <project>/supabase/config.toml contract and a valid symlinked
 * config.toml stays valid. The project root is derived from the CONFIGURED
 * path (never the symlink target: migrations live in the configured
 * project), then canonicalized so a symlinked project directory and
 * symlinked /tmp ancestors resolve to the real directory. Canonical paths
 * are used only for the self-reference containment check and the read, so
 * validation and use never resolve the file at different moments.
 */
function loadProjectConfig({ supabaseConfigPath, repoRoot }) {
  if (typeof supabaseConfigPath !== 'string' || supabaseConfigPath.trim().length === 0) {
    throw new LocalStackError('SUPABASE_CONFIG_PATH must be a non-empty string', {
      stage: 'workdir',
    });
  }
  const resolved = path.resolve(supabaseConfigPath);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LocalStackError('SUPABASE_CONFIG_PATH does not exist', {
        stage: 'workdir',
        cause: err,
      });
    }
    // EACCES, ELOOP, ENOTDIR, EINVAL: never masquerade as a missing file.
    throw new LocalStackError('Cannot access SUPABASE_CONFIG_PATH', {
      stage: 'workdir',
      cause: err,
    });
  }
  if (!stat.isFile()) {
    throw new LocalStackError('SUPABASE_CONFIG_PATH is not a file', { stage: 'workdir' });
  }

  // Layout check on the CONFIGURED path, before canonicalization.
  const supabaseDir = path.dirname(resolved);
  if (
    path.basename(resolved) !== SUPABASE_CONFIG_BASENAME ||
    path.basename(supabaseDir) !== SUPABASE_DIRNAME
  ) {
    throw new LocalStackError(
      `SUPABASE_CONFIG_PATH must point to <project>/${SUPABASE_DIRNAME}/${SUPABASE_CONFIG_BASENAME}`,
      { stage: 'workdir' },
    );
  }

  let canonicalConfigPath;
  let canonicalRepoRoot;
  try {
    canonicalConfigPath = fs.realpathSync(resolved);
    canonicalRepoRoot = fs.realpathSync(repoRoot);
  } catch (err) {
    throw new LocalStackError('Cannot resolve SUPABASE_CONFIG_PATH', {
      stage: 'workdir',
      cause: err,
    });
  }

  // Self-reference containment on the CANONICAL paths: a config inside this
  // repository (directly or nested under subdirectories, through symlinks)
  // must never feed the destructive local commands.
  const workdirCandidate = path.dirname(supabaseDir);
  if (
    canonicalConfigPath === canonicalRepoRoot ||
    canonicalConfigPath.startsWith(canonicalRepoRoot + path.sep)
  ) {
    throw new LocalStackError(
      'SUPABASE_CONFIG_PATH must point at the main project, not this repository',
      { stage: 'workdir' },
    );
  }

  let configToml;
  try {
    configToml = fs.readFileSync(canonicalConfigPath, 'utf8');
  } catch (err) {
    throw new LocalStackError('Cannot read SUPABASE_CONFIG_PATH', {
      stage: 'workdir',
      cause: err,
    });
  }
  return { configToml, projectRoot: fs.realpathSync(workdirCandidate) };
}

/**
 * Validate the parsed config: a project_id, the pinned Postgres major
 * version, and a [db] port. `project_id` must be present BEFORE the
 * `supabase_db_<project>` container name is derived.
 */
function validateParsedWorkdirConfig({ configToml, expectedMajorVersion }) {
  const parsed = parseWorkdirConfig(configToml);
  if (!parsed.projectId) {
    throw new LocalStackError('The project config must set project_id', { stage: 'workdir' });
  }
  if (parsed.majorVersion !== expectedMajorVersion) {
    throw new LocalStackError(
      `The project config must use Postgres major version ${expectedMajorVersion}`,
      { stage: 'workdir' },
    );
  }
  if (!parsed.dbPort) {
    throw new LocalStackError('The project config must expose a [db] port', { stage: 'workdir' });
  }
  return parsed;
}

/** Build the stable validated-workdir result shape. */
function buildWorkdirResult({ projectRoot, parsed }) {
  return {
    workdir: projectRoot,
    projectId: parsed.projectId,
    dbPort: parsed.dbPort,
    dbContainer: `${DB_CONTAINER_PREFIX}${parsed.projectId}`,
  };
}

/**
 * Validate the main project's config file: an existing regular
 * `<project>/supabase/config.toml` (never this backup repository's own
 * config, also through a symlink) with Postgres major version 17.
 */
export function validateWorkdir({
  supabaseConfigPath,
  repoRoot,
  expectedMajorVersion = POSTGRES_MAJOR_VERSION,
}) {
  const { configToml, projectRoot } = loadProjectConfig({ supabaseConfigPath, repoRoot });
  const parsed = validateParsedWorkdirConfig({ configToml, expectedMajorVersion });
  return buildWorkdirResult({ projectRoot, parsed });
}

/**
 * Read-only psql query against the local fixture DB container. `query` is
 * passed as a psql `-c` argument (never stdin) and MUST therefore contain
 * only repository-owned SQL — never untrusted input.
 */
export async function localPsqlQuery({ dockerPath, dbContainer, query, run, signal }) {
  const res = await run({
    command: dockerPath,
    args: [
      'exec',
      dbContainer,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-t',
      '-A',
      '-c',
      query,
    ],
    stdout: 'collect',
    stderr: 'collect',
    signal,
  });
  return psqlOutputLines(res.stdout);
}
