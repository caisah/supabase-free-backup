/**
 * Strict environment configuration for the backup/restore tooling.
 *
 * - loads only the dotenv file matching the selected environment
 * - a variable present in BOTH the process environment and the dotenv file
 *   with DIFFERENT values is a hard CONFLICT error (names only, never
 *   values), scoped to the variables the selected operation consumes
 * - FILE_PRIORITY_VARIABLES are the exception: the dotenv value is
 *   authoritative, and a present file that omits one fails closed instead of
 *   falling back to a process export; a file absent entirely (CI) may be
 *   configured purely from the process environment
 * - validates every value against the shared environment contract
 * - validation errors identify variable NAMES, never values
 * - operation-specific loaders so backup never requires the private age
 *   identity and repository restore never requires R2 credentials
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';

export const ENVIRONMENTS = ['development', 'production'];

/** Config/dotenv identity of the single local project stack: selects the
 * `.env.<value>.local` file and must equal the BACKUP_ENVIRONMENT inside it.
 * Deliberately NOT derived from ENVIRONMENTS[0]: the hosted environment list
 * may change without the local stack's config identity changing, and the
 * two lists serve different purposes. */
export const LOCAL_STACK_ENVIRONMENT = 'development';

/** Store label of local snapshots: the single fixed `local` subdirectory. */
export const LOCAL_STORE_ENVIRONMENT = 'local';

/** Fixed bucket mapping: the bucket name always equals the environment. */
export const BUCKET_BY_ENVIRONMENT = Object.freeze({
  development: 'development',
  production: 'production',
});

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT_REF_SHAPE = /^[a-z0-9]{20}$/;
const ACCOUNT_ID_SHAPE = /^[0-9a-f]{32}$/i;
const R2_ACCESS_KEY_MIN = 8;
const R2_SECRET_MIN = 16;
const AGE_RECIPIENT_SHAPE = /^age1[a-z0-9]{38,65}$/;
const AGE_IDENTITY_SHAPE = /^AGE-SECRET-KEY-[A-Z0-9]{30,100}$/;

/** The only SSL modes accepted for hosted connections. */
const SECURE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/** Host suffix of the Shared Session Pooler endpoint. */
const POOLER_HOST_SUFFIX = '.pooler.supabase.com';

/** The only port the Shared Session Pooler listens on. */
const SHARED_POOLER_PORT = '5432';

/** The only database path the dashboard pooler contract exposes. */
const POOLER_DATABASE_PATH = '/postgres';

/** Literal legacy hosted-connection variable name (hard-cutover gate only). */
export const LEGACY_DB_URL_VARIABLE = 'SUPABASE_DB_URL';

/** Literal legacy local-workdir variable name (hard-cutover gate only). */
export const LEGACY_PROJECT_WORKDIR_VARIABLE = 'PROJECT_WORKDIR';

/** Stable diagnostic keyword for source disagreements; shared with tests. */
export const CONFLICT_PREFIX = 'CONFLICT';

/** File-authoritative account ID: the dotenv file always wins for this name. */
const CLOUDFLARE_ACCOUNT_ID = 'CLOUDFLARE_ACCOUNT_ID';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Backup configuration error:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Extract the password from a connection URL (secret registration only). */
export function urlPassword(dbUrl) {
  try {
    return new URL(dbUrl).password;
  } catch {
    return null;
  }
}

/** Transport-level URL parsing: scheme, SSL, username, and password checks. */
function parseDbUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, code: 'unparsable' };
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { ok: false, code: 'scheme' };
  }
  // libpq parses the query as connection options and lets later values
  // override earlier ones, so the WHATWG view of the URL must not be
  // trusted: no parameter other than exactly one sslmode is allowed.
  const params = [...parsed.searchParams];
  const hasOnlySslmode = params.length === 1 && params[0][0] === 'sslmode';
  if (params.length > 0 && !hasOnlySslmode) {
    return { ok: false, code: 'params' };
  }
  const sslmode = hasOnlySslmode ? params[0][1] : null;
  if (sslmode == null || !SECURE_SSL_MODES.has(sslmode)) {
    return { ok: false, code: 'ssl' };
  }
  let user;
  try {
    user = decodeURIComponent(parsed.username);
  } catch {
    return { ok: false, code: 'username' };
  }
  if (!user) return { ok: false, code: 'username' };
  if (!parsed.password) return { ok: false, code: 'password' };
  return { ok: true, user, parsed };
}

/**
 * Classify a hosted Supabase connection URL against a project reference as a
 * Shared Session Pooler connection. Only the one canonical form is accepted:
 * `postgres://postgres.<project-ref>:<password>@<pool>.pooler.supabase.com:5432/postgres?sslmode=...`
 * with exactly one secure sslmode parameter, no multi-host authority, and the
 * canonical `/postgres` database. Static failure codes only; never includes
 * any part of the URL or a derived host.
 */
export function classifySharedPoolerUrl(input, projectRef) {
  const parsed = parseDbUrl(input);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const { user, parsed: url } = parsed;
  const host = url.hostname.toLowerCase();
  const port = url.port || SHARED_POOLER_PORT;
  // A comma-separated authority is a libpq multi-host list: the suffix check
  // below would pass while libpq connects to the first listed host.
  if (host.includes(',')) return { ok: false, code: 'multihost' };
  // libpq derives the target database from the path; a different database
  // would let backup/restore protect the wrong target.
  if (url.pathname !== POOLER_DATABASE_PATH) return { ok: false, code: 'dbname' };
  if (!host.endsWith(POOLER_HOST_SUFFIX)) return { ok: false, code: 'host' };
  if (user.endsWith('.transaction')) return { ok: false, code: 'transaction-pooler' };
  if (port !== SHARED_POOLER_PORT) return { ok: false, code: 'pooler-port' };
  if (user !== `postgres.${projectRef}`) return { ok: false, code: 'pooler-user' };
  return { ok: true };
}

const SHARED_POOLER_URL_PROBLEM =
  'INVALID SUPABASE_SHARED_POOLER_URL (must be a Supabase Shared Session Pooler URL on port 5432 for the matching project reference, with a secure sslmode)';

// Zod-backed per-variable schemas. Every message is static: variable names only.
function fieldSchema(name, options = {}) {
  const { shape, hint } = options;
  // Optional at the object level: absent variables are reported by the
  // requirements logic below, never by the schema. Empty strings are already
  // filtered out before parsing, so a present value is always a non-empty
  // string and can be shape-checked safely.
  let schema = z.custom((v) => v === undefined || (typeof v === 'string' && v.length > 0), {
    message: `MISSING ${name}`,
  });
  if (shape) {
    schema = schema.refine((v) => v === undefined || shape.test(v), {
      message: `INVALID ${name}${hint ? ` (${hint})` : ''}`,
    });
  }
  return schema.optional();
}

const VARIABLE_SCHEMAS = {
  BACKUP_ENVIRONMENT: fieldSchema('BACKUP_ENVIRONMENT'),
  SUPABASE_PROJECT_REF: fieldSchema('SUPABASE_PROJECT_REF', {
    shape: PROJECT_REF_SHAPE,
    hint: 'expected 20 lowercase alphanumeric characters',
  }),
  SUPABASE_SHARED_POOLER_URL: fieldSchema('SUPABASE_SHARED_POOLER_URL'),
  [CLOUDFLARE_ACCOUNT_ID]: fieldSchema(CLOUDFLARE_ACCOUNT_ID, {
    shape: ACCOUNT_ID_SHAPE,
    hint: 'expected 32 hexadecimal characters',
  }),
  R2_ACCESS_KEY_ID: fieldSchema('R2_ACCESS_KEY_ID').refine(
    (v) => v === undefined || v.length >= R2_ACCESS_KEY_MIN,
    { message: 'INVALID R2_ACCESS_KEY_ID' },
  ),
  R2_SECRET_ACCESS_KEY: fieldSchema('R2_SECRET_ACCESS_KEY').refine(
    (v) => v === undefined || v.length >= R2_SECRET_MIN,
    { message: 'INVALID R2_SECRET_ACCESS_KEY' },
  ),
  R2_BUCKET: fieldSchema('R2_BUCKET'),
  ENCRYPT_KEY: fieldSchema('ENCRYPT_KEY', {
    shape: AGE_RECIPIENT_SHAPE,
    hint: 'expected an age1... X25519 recipient',
  }),
  DECRYPT_KEY: fieldSchema('DECRYPT_KEY', {
    shape: AGE_IDENTITY_SHAPE,
    hint: 'expected an AGE-SECRET-KEY-... identity',
  }),
  // The main project's exact supabase/config.toml file. PROJECT_WORKDIR is
  // deliberately NOT a schema entry: the legacy name is only ever read from
  // the raw sources by the hard-cutover diagnostic below.
  SUPABASE_CONFIG_PATH: fieldSchema('SUPABASE_CONFIG_PATH'),
};

function shapeProblems(fields) {
  const problems = [];
  const schema = z.object({ ...VARIABLE_SCHEMAS }).passthrough();
  const result = schema.safeParse(fields);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(issue.message);
    }
  }
  return problems;
}

/**
 * Source conflicts: the dotenv file and the process environment both define
 * the same variable with DIFFERENT values. Process values keep precedence,
 * but the mismatch is always a hard error (variable names only, never values)
 * so a stale shell export cannot silently override the per-environment file.
 * Checks are scoped to the variables the selected operation consumes (plus
 * the universal BACKUP_ENVIRONMENT), so an unused export can never block a
 * valid run. FILE_PRIORITY_VARIABLES are exempt: the dotenv value is
 * authoritative there, so a differing process value is never a conflict.
 */
function collectConflictProblems({ requirements, filePath, vars, fileValues }) {
  const problems = [];
  const scoped = conflictScopedNames(requirements);
  for (const name of Object.keys(VARIABLE_SCHEMAS)) {
    if (!scoped.has(name)) continue;
    if (FILE_PRIORITY_VARIABLES.has(name)) continue;
    const fromProcess = vars[name];
    const fromFile = fileValues[name];
    if (
      typeof fromProcess === 'string' &&
      fromProcess.length > 0 &&
      typeof fromFile === 'string' &&
      fromFile.length > 0 &&
      fromProcess !== fromFile
    ) {
      problems.push(
        `${CONFLICT_PREFIX} ${name} (process environment value differs from ${path.basename(filePath)})`,
      );
    }
  }
  return problems;
}

/** Variable names consumed by an operation: universal fields + requirements. */
function conflictScopedNames(requirements) {
  const names = ['BACKUP_ENVIRONMENT'];
  if (requirements.projectRef) names.push('SUPABASE_PROJECT_REF');
  if (requirements.sharedPoolerUrl) names.push('SUPABASE_SHARED_POOLER_URL');
  if (requirements.accountId) names.push(CLOUDFLARE_ACCOUNT_ID);
  if (requirements.r2) names.push('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET');
  if (requirements.ageRecipient) names.push('ENCRYPT_KEY');
  if (requirements.ageIdentity) names.push('DECRYPT_KEY');
  if (requirements.supabaseConfigPath) names.push('SUPABASE_CONFIG_PATH');
  return new Set(names);
}

/**
 * Fail-closed boundary for file-authoritative variables: when the dotenv
 * file EXISTS but omits one, a process export must not silently take over
 * (the export would select the R2 endpoint). CI has no dotenv file, so
 * process-only configuration keeps working there.
 */
function collectFileAuthorityProblems({ filePath, vars, fileValues, fieldNames }) {
  const problems = [];
  for (const name of FILE_PRIORITY_VARIABLES) {
    if (!fieldNames.has(name)) continue;
    if (typeof vars[name] === 'string' && vars[name].length > 0) {
      const fromFile = fileValues[name];
      if (!(typeof fromFile === 'string' && fromFile.length > 0)) {
        problems.push(
          `${CONFLICT_PREFIX} ${name} (${path.basename(filePath)} is authoritative for this variable but omits it; add it to the file or remove the process export)`,
        );
      }
    }
  }
  return problems;
}

/** Selected-environment check: BACKUP_ENVIRONMENT present and matching. */
function selectedEnvironmentProblems({ environment, resolved }) {
  const environmentValue = resolved.BACKUP_ENVIRONMENT;
  const problems = [];
  if (!environmentValue) {
    problems.push('MISSING BACKUP_ENVIRONMENT');
  } else if (environmentValue !== environment) {
    problems.push('INVALID BACKUP_ENVIRONMENT (must match the selected --environment)');
  }
  return problems;
}

/** Operation-specific missing-requirement checks (names only). */
function collectRequirementProblems({ requirements, resolved }) {
  const problems = [];
  if (requirements.projectRef && !resolved.SUPABASE_PROJECT_REF) {
    problems.push('MISSING SUPABASE_PROJECT_REF');
  }
  if (requirements.sharedPoolerUrl && !resolved.SUPABASE_SHARED_POOLER_URL) {
    problems.push('MISSING SUPABASE_SHARED_POOLER_URL');
  }
  if (requirements.accountId && !resolved.CLOUDFLARE_ACCOUNT_ID) {
    problems.push('MISSING CLOUDFLARE_ACCOUNT_ID');
  }
  if (requirements.r2) {
    if (!resolved.R2_ACCESS_KEY_ID) problems.push('MISSING R2_ACCESS_KEY_ID');
    if (!resolved.R2_SECRET_ACCESS_KEY) problems.push('MISSING R2_SECRET_ACCESS_KEY');
    if (!resolved.R2_BUCKET) problems.push('MISSING R2_BUCKET');
  }
  if (requirements.ageRecipient && !resolved.ENCRYPT_KEY) {
    problems.push('MISSING ENCRYPT_KEY');
  }
  if (requirements.ageIdentity && !resolved.DECRYPT_KEY) {
    problems.push('MISSING DECRYPT_KEY');
  }
  if (requirements.supabaseConfigPath && !resolved.SUPABASE_CONFIG_PATH) {
    problems.push('MISSING SUPABASE_CONFIG_PATH');
  }
  return problems;
}

/**
 * Hard-cutover diagnostics for legacy variable names. Each runs only when
 * the selected operation consumes the replacement field; inspects BOTH
 * process and dotenv sources; never resolves or returns the old value;
 * fails even when the new field is also present so stale configuration
 * cannot silently linger. Reports variable names only.
 */
function collectLegacyVariableProblems({ requirements, vars, fileValues }) {
  const problems = [];
  const isConfigured = (name) =>
    [vars[name], fileValues[name]].some((value) => typeof value === 'string' && value.length > 0);

  if (requirements.sharedPoolerUrl && isConfigured(LEGACY_DB_URL_VARIABLE)) {
    problems.push('UNSUPPORTED SUPABASE_DB_URL (rename to SUPABASE_SHARED_POOLER_URL)');
  }

  if (requirements.supabaseConfigPath && isConfigured(LEGACY_PROJECT_WORKDIR_VARIABLE)) {
    problems.push(
      `UNSUPPORTED ${LEGACY_PROJECT_WORKDIR_VARIABLE} (rename to SUPABASE_CONFIG_PATH)`,
    );
  }

  return problems;
}

/** Cross-field checks: bucket/environment mapping and Shared Pooler URL classification. */
function collectCrossFieldProblems({ environment, requirements, resolved }) {
  const problems = [];
  if (
    resolved.R2_BUCKET &&
    requirements.r2 &&
    resolved.R2_BUCKET !== BUCKET_BY_ENVIRONMENT[environment]
  ) {
    problems.push('INVALID R2_BUCKET (must equal the selected environment)');
  }
  if (resolved.SUPABASE_SHARED_POOLER_URL && resolved.SUPABASE_PROJECT_REF) {
    const classified = classifySharedPoolerUrl(
      resolved.SUPABASE_SHARED_POOLER_URL,
      resolved.SUPABASE_PROJECT_REF,
    );
    if (!classified.ok) problems.push(SHARED_POOLER_URL_PROBLEM);
  }
  return problems;
}

/** Resolve SUPABASE_CONFIG_PATH against the repository root. */
function resolveSupabaseConfigPath({ resolved, root }) {
  if (!resolved.SUPABASE_CONFIG_PATH) return undefined;
  return path.isAbsolute(resolved.SUPABASE_CONFIG_PATH)
    ? resolved.SUPABASE_CONFIG_PATH
    : path.resolve(root, resolved.SUPABASE_CONFIG_PATH);
}

/** Select the fields this operation is allowed to resolve. */
function operationFieldNames(requirements) {
  return requirements.consumedOnly
    ? conflictScopedNames(requirements)
    : new Set(Object.keys(VARIABLE_SCHEMAS));
}

/** Resolve selected variables; file-first for FILE_PRIORITY_VARIABLES, else process-over-dotenv. */
function resolveConfigFields({ vars, fileValues, fieldNames }) {
  const resolved = {};
  for (const name of fieldNames) {
    const value = resolveValue(name, vars, fileValues);
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
}

/** Build the stable public config shape from validated fields. */
function buildOperationConfig({ environment, requirements, resolved, supabaseConfigPath }) {
  const config = {
    environment,
    projectRef: resolved.SUPABASE_PROJECT_REF,
    sharedPoolerUrl: resolved.SUPABASE_SHARED_POOLER_URL,
    accountId: resolved.CLOUDFLARE_ACCOUNT_ID,
    bucket: resolved.R2_BUCKET,
    accessKeyId: resolved.R2_ACCESS_KEY_ID,
    secretAccessKey: resolved.R2_SECRET_ACCESS_KEY,
    ageRecipient: resolved.ENCRYPT_KEY,
    ageIdentity: resolved.DECRYPT_KEY,
    supabaseConfigPath,
    r2Endpoint: resolved.CLOUDFLARE_ACCOUNT_ID
      ? `https://${resolved.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined,
  };
  if (!requirements.consumedOnly) return config;

  const scoped = { environment };
  if (requirements.projectRef) scoped.projectRef = config.projectRef;
  if (requirements.sharedPoolerUrl) scoped.sharedPoolerUrl = config.sharedPoolerUrl;
  if (requirements.accountId) {
    scoped.accountId = config.accountId;
    scoped.r2Endpoint = config.r2Endpoint;
  }
  if (requirements.r2) {
    scoped.bucket = config.bucket;
    scoped.accessKeyId = config.accessKeyId;
    scoped.secretAccessKey = config.secretAccessKey;
  }
  if (requirements.ageRecipient) scoped.ageRecipient = config.ageRecipient;
  if (requirements.ageIdentity) scoped.ageIdentity = config.ageIdentity;
  if (requirements.supabaseConfigPath) scoped.supabaseConfigPath = supabaseConfigPath;
  return scoped;
}

const BACKUP_REQUIREMENTS = {
  projectRef: true,
  sharedPoolerUrl: true,
  accountId: true,
  r2: true,
  ageRecipient: true,
  consumedOnly: true,
};

/** Local backup: target metadata + config path only, never age or the hosted path. */
const LOCAL_BACKUP_REQUIREMENTS = {
  projectRef: true,
  supabaseConfigPath: true,
  consumedOnly: true,
};

const HOSTED_RESTORE_REQUIREMENTS = {
  r2: { ...BACKUP_REQUIREMENTS, ageIdentity: true },
  repo: { projectRef: true, sharedPoolerUrl: true, ageRecipient: true, ageIdentity: true },
  // Plaintext local-store snapshots need target URL + ref only; the local
  // path is plaintext-only (the legacy encrypted-local compatibility claim
  // was removed together with the pre-single-store layout).
  local: { projectRef: true, sharedPoolerUrl: true, consumedOnly: true },
};

function loadDotenvValues(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { fileValues: {}, filePresent: false };
    throw err;
  }
  const parsed = dotenv.parse(raw);
  // dotenv keeps surrounding whitespace inside quoted values; normalize so
  // conflict comparison and resolution never disagree on trailing spaces.
  const fileValues = {};
  for (const [name, value] of Object.entries(parsed)) {
    fileValues[name] = typeof value === 'string' ? value.trim() : value;
  }
  return { fileValues, filePresent: true };
}

/**
 * Variables whose per-environment dotenv file value wins over the process
 * environment. CLOUDFLARE_ACCOUNT_ID is exported globally in developer shells
 * (shared with other Cloudflare tooling) while the backup account is
 * environment-scoped, so the dotenv file is the more specific source. Such
 * variables are also exempt from conflict detection: a differing shell export
 * is ignored by design, never an error. Adding a file-priority variable
 * requires: (1) this Set, (2) a VARIABLE_SCHEMAS entry, (3) the .env.example
 * and README precedence notes.
 */
const FILE_PRIORITY_VARIABLES = new Set([CLOUDFLARE_ACCOUNT_ID]);

function resolveValue(name, vars, fileValues) {
  const fromFile = fileValues[name];
  if (FILE_PRIORITY_VARIABLES.has(name) && typeof fromFile === 'string' && fromFile.length > 0) {
    return fromFile;
  }
  const fromProcess = vars[name];
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess;
  if (typeof fromFile === 'string' && fromFile.length > 0) return fromFile;
  return undefined;
}

/**
 * Core loader.
 *
 * @param {object} opts
 * @param {'development'|'production'} opts.environment
 * @param {object} opts.requirements flags selecting required variables
 * @param {object} [opts.vars] process-environment override source
 * @param {string} [opts.root] repository root (tests use fixtures)
 * @param {string} [opts.dotenvPath] explicit dotenv file (tests)
 */
export function loadOperationConfig({
  environment,
  requirements,
  vars = process.env,
  root = REPOSITORY_ROOT,
  dotenvPath,
}) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new ConfigError([`environment must be one of: ${ENVIRONMENTS.join(', ')}`]);
  }

  const filePath = dotenvPath ?? path.join(root, `.env.${environment}.local`);
  const { fileValues, filePresent } = loadDotenvValues(filePath);
  const fieldNames = operationFieldNames(requirements);
  const resolved = resolveConfigFields({ vars, fileValues, fieldNames });

  // Problem ordering is contract: shape, source conflicts, selected
  // environment, requirements, legacy-variable gate, then cross-field
  // relationships.
  const problems = shapeProblems(resolved);
  problems.push(...collectConflictProblems({ requirements, filePath, vars, fileValues }));
  if (filePresent) {
    problems.push(...collectFileAuthorityProblems({ filePath, vars, fileValues, fieldNames }));
  }
  problems.push(...selectedEnvironmentProblems({ environment, resolved }));
  problems.push(...collectRequirementProblems({ requirements, resolved }));
  problems.push(...collectLegacyVariableProblems({ requirements, vars, fileValues }));
  problems.push(...collectCrossFieldProblems({ environment, requirements, resolved }));

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return buildOperationConfig({
    environment,
    requirements,
    resolved,
    supabaseConfigPath: resolveSupabaseConfigPath({ resolved, root }),
  });
}

/** Backup: needs everything except the private age identity. */
export function loadBackupConfig(opts) {
  return loadOperationConfig({ ...opts, requirements: BACKUP_REQUIREMENTS });
}

/** Local backup: consumes only matching env, target ref, and workdir. */
export function loadLocalBackupConfig(opts) {
  return loadOperationConfig({ ...opts, requirements: LOCAL_BACKUP_REQUIREMENTS });
}

/** Hosted restore (development/production). Requires the age identity. */
export function loadHostedRestoreConfig({ source, ...opts }) {
  const requirements = HOSTED_RESTORE_REQUIREMENTS[source];
  if (!requirements) {
    throw new ConfigError(['source must be one of: r2, repo, local']);
  }
  return loadOperationConfig({ ...opts, requirements });
}

/**
 * Local-stack restore: hosted snapshot (r2|repo) into the sibling project
 * stack. Consumes the source credentials of the SELECTED environment (the
 * snapshot source) but never the hosted connection URL/ref: the target is
 * always the local stack, so no hosted URL exists on this path. The target
 * config path is read from the FIXED local-stack environment
 * (LOCAL_STACK_ENVIRONMENT), exactly like backup:local/reset:local —
 * selecting a production snapshot can never redirect the destructive local
 * target to a production workdir.
 * Restore only decrypts, so the encryption recipient (ENCRYPT_KEY) is
 * neither required nor consumed.
 */
const LOCAL_RESTORE_REQUIREMENTS = {
  r2: {
    accountId: true,
    r2: true,
    ageIdentity: true,
    consumedOnly: true,
  },
  repo: {
    ageIdentity: true,
    consumedOnly: true,
  },
};

/**
 * Local-stack restore (development/production snapshot). The source
 * credentials resolve from the selected environment; SUPABASE_CONFIG_PATH
 * is resolved from the FIXED local-stack environment file, so the snapshot
 * environment never selects the destructive target.
 */
export function loadLocalRestoreConfig({ source, root, vars, dotenvPath, ...opts }) {
  const requirements = LOCAL_RESTORE_REQUIREMENTS[source];
  if (!requirements) {
    throw new ConfigError(['source must be one of: r2, repo']);
  }
  const sourceCfg = loadOperationConfig({ ...opts, dotenvPath, root, vars, requirements });
  const targetCfg = loadOperationConfig({
    environment: LOCAL_STACK_ENVIRONMENT,
    root,
    vars,
    requirements: LOCAL_RESET_REQUIREMENTS,
    dotenvPath,
  });
  return { ...sourceCfg, supabaseConfigPath: targetCfg.supabaseConfigPath };
}

/** Hosted reset: target URL and ref only, same consumed-scope as local restores. */
const HOSTED_RESET_REQUIREMENTS = {
  projectRef: true,
  sharedPoolerUrl: true,
  consumedOnly: true,
};

/** Hosted reset (development/production): the environment-scoped URL fixes the target. */
export function loadHostedResetConfig(opts) {
  return loadOperationConfig({ ...opts, requirements: HOSTED_RESET_REQUIREMENTS });
}

/** Local reset: sibling config path only; the stack identity is the fixed development dotenv. */
const LOCAL_RESET_REQUIREMENTS = {
  supabaseConfigPath: true,
  consumedOnly: true,
};

/** Local reset: config-path-only loader from the fixed development identity. */
export function loadLocalResetConfig(opts) {
  return loadOperationConfig({ ...opts, requirements: LOCAL_RESET_REQUIREMENTS });
}
