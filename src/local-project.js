/**
 * Neutral local Supabase project adapter.
 *
 * Discovery and read-only query primitives shared by the DESTRUCTIVE local
 * restore flow and the READ-ONLY local backup flow: config.toml parsing,
 * workdir validation, the derived container/port contract, and container-side
 * psql queries. Nothing here starts, stops, resets, or migrates a stack, and
 * nothing here imports the restore or backup orchestrators, so each workflow
 * can depend on it without coupling to the other's destructive surface.
 */

import fs from 'node:fs';
import path from 'node:path';
import { POSTGRES_MAJOR_VERSION } from './snapshot.js';

export class LocalRestoreError extends Error {
  constructor(message, { cause, stage } = {}) {
    super(message);
    this.name = 'LocalRestoreError';
    this.cause = cause;
    this.stage = stage;
  }
}

/** Parse the [db] section of a Supabase config.toml (CRLF-tolerant). */
export function parseWorkdirConfig(configToml) {
  // Normalize CRLF so a Windows-checked-out config.toml parses identically.
  const normalized = configToml.replace(/\r\n/g, '\n');
  const dbMatch = /\[db\]\n([\s\S]*?)(?=\n\[[a-z]|\n$)/.exec(normalized);
  const dbSection = dbMatch ? dbMatch[1] : '';
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
    throw new LocalRestoreError(`PROJECT_WORKDIR does not exist: ${resolved}`, {
      stage: 'workdir',
    });
  }
  if (!stat.isDirectory()) {
    throw new LocalRestoreError(`PROJECT_WORKDIR is not a directory: ${resolved}`, {
      stage: 'workdir',
    });
  }
  const realRoot = fs.realpathSync(resolved);
  const realRepo = fs.realpathSync(repoRoot);
  if (realRoot === realRepo) {
    throw new LocalRestoreError(
      'PROJECT_WORKDIR must point at the local Supabase project workdir, not this repository',
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
    throw new LocalRestoreError(
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
    throw new LocalRestoreError(`Project config must set project_id: ${configPath}`, {
      stage: 'workdir',
    });
  }
  if (parsed.majorVersion !== expectedMajorVersion) {
    throw new LocalRestoreError(
      `Project config must use Postgres major version ${expectedMajorVersion}`,
      { stage: 'workdir' },
    );
  }
  if (!parsed.dbPort) {
    throw new LocalRestoreError('Project config must expose a [db] port', { stage: 'workdir' });
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
 * Validate the local project workdir: a real directory (not the backup repo
 * itself) containing supabase/config.toml with the pinned Postgres major
 * version.
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

/** The local stack DB url: fixed credentials, the configured host port. */
export function localDbUrl(dbPort) {
  return `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`;
}

/** Read-only psql query against the local fixture DB container. */
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
  return (res.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
