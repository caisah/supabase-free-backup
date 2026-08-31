/**
 * Read-only local-stack helpers for `backup:local`.
 *
 * Hosts the workdir parsing/validation and the read-only psql probe used by
 * the local backup store. Nothing here starts, stops, resets, or migrates
 * the local stack, and no restore flow exists: a local snapshot carries the
 * store label `local` and NO project ref — the hosted restore target is
 * chosen at RESTORE time (`restore:development|production --source local`)
 * and is never expected on a local snapshot's manifest.
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
  const major = /major_version\s*=\s*(\d+)/.exec(dbSection);
  const port = /^\s*port\s*=\s*(\d+)/m.exec(dbSection);
  const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(normalized);
  return {
    projectId: projectId ? projectId[1] : null,
    majorVersion: major ? Number(major[1]) : null,
    dbPort: port ? Number(port[1]) : null,
  };
}

/** Resolve PROJECT_WORKDIR and enforce the type/self-reference checks. */
function resolveWorkdirPath({ projectWorkdir, repoRoot }) {
  const resolved = path.resolve(projectWorkdir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new LocalStackError(`PROJECT_WORKDIR does not exist: ${resolved}`, {
      stage: 'workdir',
    });
  }
  if (!stat.isDirectory()) {
    throw new LocalStackError(`PROJECT_WORKDIR is not a directory: ${resolved}`, {
      stage: 'workdir',
    });
  }
  const realRoot = fs.realpathSync(resolved);
  const realRepo = fs.realpathSync(repoRoot);
  if (realRoot === realRepo) {
    throw new LocalStackError(
      'PROJECT_WORKDIR must point at the sibling project, not this repository',
      { stage: 'workdir' },
    );
  }
  return { realRoot };
}

/** Load the workdir's supabase/config.toml text and canonical path. */
function loadWorkdirConfig({ realRoot, projectWorkdir }) {
  const configPath = path.join(realRoot, 'supabase', 'config.toml');
  let configToml;
  try {
    configToml = fs.readFileSync(configPath, 'utf8');
  } catch {
    throw new LocalStackError(
      `PROJECT_WORKDIR has no supabase/config.toml: ${path.join(projectWorkdir, 'supabase')}`,
      { stage: 'workdir' },
    );
  }
  return { configPath, configToml };
}

/**
 * Validate the parsed config: a project_id, the pinned Postgres major
 * version, and a [db] port. `project_id` must be present BEFORE the
 * `supabase_db_<project>` container name is derived.
 */
function validateParsedWorkdirConfig({ configToml, configPath, expectedMajorVersion }) {
  const parsed = parseWorkdirConfig(configToml);
  if (!parsed.projectId) {
    throw new LocalStackError(`The project config must set project_id: ${configPath}`, {
      stage: 'workdir',
    });
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
function buildWorkdirResult({ realRoot, configPath, parsed }) {
  return {
    workdir: realRoot,
    projectId: parsed.projectId,
    dbPort: parsed.dbPort,
    dbContainer: `supabase_db_${parsed.projectId}`,
    configPath,
  };
}

/**
 * Validate the project workdir: a real directory (not the backup repo
 * itself) containing supabase/config.toml with Postgres major version 17.
 */
export function validateWorkdir({
  projectWorkdir,
  repoRoot,
  expectedMajorVersion = POSTGRES_MAJOR_VERSION,
}) {
  const { realRoot } = resolveWorkdirPath({ projectWorkdir, repoRoot });
  const { configPath, configToml } = loadWorkdirConfig({ realRoot, projectWorkdir });
  const parsed = validateParsedWorkdirConfig({ configToml, configPath, expectedMajorVersion });
  return buildWorkdirResult({ realRoot, configPath, parsed });
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
