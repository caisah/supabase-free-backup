/**
 * Hosted development/production restore operations (sub-plan 07).
 *
 * Everything destructive happens ONLY after: full source verification
 * (sub-plan 06), read-only target preflight, and an exact interactive
 * confirmation phrase. Reset cleans the target; the restore then runs as ONE
 * Dockerized psql transaction (single `-f -` script scope: any session state
 * set in one artifact persists into the next; current dumps contain none)
 * with strict ordering: prepared roles, application schema, managed
 * auth/storage delta, migration-history schema, generated cleanup SQL, then
 * decrypted combined data. Never logs URLs, passwords, identities, or SQL
 * contents.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { urlPassword } from './config.js';
import { PINNED_SUPABASE_POSTGRES_IMAGE } from './database.js';
import { POSTGRES_MAJOR_VERSION } from './snapshot.js';
import { psqlOutputLines } from './process.js';

export class HostedRestoreError extends Error {
  constructor(message, { cause, stage } = {}) {
    super(message);
    this.name = 'HostedRestoreError';
    this.cause = cause;
    this.stage = stage;
  }
}

export const PROJECT_TRIGGERS = ['create_account_for_new_user', 'cleanup_deleted_user_vouches'];
export const CREATE_ROLE_LINE = /^\s*CREATE ROLE "((?:[^"]|"")+)"\s*;\s*$/;

/**
 * Canonical restore ORDER of the plaintext schema artifacts inside the ONE
 * transactional restore: application schema, managed auth/storage delta,
 * migration-history schema. Deliberately decoupled from the packaging
 * artifact list (`PLAINTEXT_ARTIFACTS`) so a packaging reorder or addition
 * can never silently change the destructive restore stream.
 */
export const HOSTED_RESTORE_SCHEMA_ARTIFACTS = Object.freeze([
  'schema.sql',
  'managed-schema.sql',
  'migration-history-schema.sql',
]);

/**
 * Prepare roles in ONE pass and report how many canonical CREATE ROLE
 * statements were commented because the role already exists on the target.
 */
function prepareRolesFileWithCount({
  rolesSql,
  existingRoles = [],
  marker = '-- already exists on target; skipped by db-backup restore',
}) {
  const existing = new Set(existingRoles);
  const lines = rolesSql.split(/\r?\n/);
  const out = [];
  let skipped = 0;
  for (const line of lines) {
    const match = CREATE_ROLE_LINE.exec(line);
    if (match) {
      const role = match[1].replaceAll('""', '"');
      if (existing.has(role)) {
        out.push(`-- ${marker}\n${line}`);
        skipped += 1;
        continue;
      }
      out.push(line);
      continue;
    }
    if (/\bCREATE ROLE\b/.test(line)) {
      throw new HostedRestoreError(
        'unexpected CREATE ROLE syntax in roles dump; refusing broad replacement',
        { stage: 'roles' },
      );
    }
    out.push(line);
  }
  return { sql: out.join('\n'), skipped };
}

/**
 * Strictly prepare the roles file for the TARGET database: comment ONLY the
 * canonical `CREATE ROLE "x";` statements whose roles already exist; preserve
 * every ALTER ROLE/GRANT line; reject any other CREATE ROLE syntax.
 *
 * @param {{rolesSql:string, existingRoles:string[], marker?:string}} opts
 */
export function prepareRolesFile(opts) {
  return prepareRolesFileWithCount(opts).sql;
}

/**
 * Generate deduplicated TRUNCATE ... CASCADE statements from the canonical
 * COPY headers of the decrypted data dump. Identifiers are decoded and safely
 * re-quoted; malformed COPY targets are rejected.
 */
export function generateCleanupSql({ dataSql }) {
  const scanner = createCleanupScanner();
  for (const line of dataSql.split(/\r?\n/)) scanner.push(line);
  return scanner.result();
}

/**
 * Streaming variant of `generateCleanupSql`: reads the data dump line by
 * line from `dataPath` instead of loading the whole (possibly multi-gigabyte)
 * file into memory. Same semantics; read failures reject.
 */
export async function generateCleanupSqlFromFile({ dataPath }) {
  const scanner = createCleanupScanner();
  const lines = readline.createInterface({
    input: fs.createReadStream(dataPath),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) scanner.push(line);
  } finally {
    lines.close();
  }
  return scanner.result();
}

/**
 * Shared single-pass COPY-header scanner for the in-memory and streaming
 * cleanup builders; throws HostedRestoreError on malformed input.
 */
function createCleanupScanner() {
  const COPY_HEADER = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)"(?: \(.*\))? FROM stdin;$/;
  const seen = new Set();
  const truncates = [];
  let inCopyData = false;
  return {
    push(line) {
      if (inCopyData) {
        if (line === '\\.') inCopyData = false;
        return;
      }
      if (!line.startsWith('COPY ')) return;
      const match = COPY_HEADER.exec(line);
      if (!match) {
        throw new HostedRestoreError(`malformed COPY target in data dump: ${line.slice(0, 60)}`, {
          stage: 'cleanup',
        });
      }
      inCopyData = true;
      const schema = match[1].replaceAll('""', '"');
      const table = match[2].replaceAll('""', '"');
      // Public-schema tables are freshly replaced by the clean step in both
      // hosted (db reset) and local (DROP SCHEMA public) restores; TRUNCATE
      // has no IF EXISTS, so they are excluded from the truncate list.
      if (schema === 'public') return;
      const target = `${schema}.${table}`;
      if (seen.has(target)) return;
      seen.add(target);
      truncates.push(
        `TRUNCATE TABLE "${schema.replaceAll('"', '""')}"."${table.replaceAll('"', '""')}" CASCADE;`,
      );
    },
    result() {
      if (inCopyData) {
        throw new HostedRestoreError('unterminated COPY data block in data dump', {
          stage: 'cleanup',
        });
      }
      return `${truncates.join('\n')}\n`;
    },
  };
}

/** One hardening argument (and its value, when it has one) for the client. */
export const DOCKER_HARDENING_FLAGS = Object.freeze([
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--user=postgres',
  // Writable scratch for psql while the container rootfs stays read-only: a
  // multi-gigabyte stdin stream must never fail because psql needed a temp
  // file. tmpfs lives in memory, is wiped with the container, and offers no
  // host or image filesystem reach.
  '--tmpfs',
  '/tmp',
  '--entrypoint=psql',
]);

/**
 * Pure Docker argv builder for the ephemeral pinned psql 17 client. Docker
 * flags come before the image, psql flags after it; `--interactive` is only
 * added when SQL is streamed to the container's stdin. The target is a
 * remote Supabase host reachable over TLS, so default bridge networking is
 * used: host networking (—network=host) is never requested because it would
 * widen a compromised client's reach to host services and is unsupported on
 * parts of Docker Desktop.
 */
export function buildDockerPsqlArgs({
  postgresImage = PINNED_SUPABASE_POSTGRES_IMAGE,
  psqlArgs,
  interactive = false,
}) {
  const dockerFlags = [
    'run',
    '--rm',
    ...(interactive ? ['--interactive'] : []),
    ...DOCKER_HARDENING_FLAGS,
  ];
  return [...dockerFlags, postgresImage, ...psqlArgs];
}

/** Parse the canonical `psql (PostgreSQL) N` version text; returns the major or null. */
export function parsePsqlMajorVersion(versionText) {
  const match = /^psql \(PostgreSQL\) (\d+)/.exec(String(versionText ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Run `psql --version` in the pinned ephemeral image, require the configured
 * Postgres major, and return the trimmed canonical version text. Any launch,
 * image, or daemon failure is bounded to a static preflight message that
 * never reproduces command arguments.
 */
export async function preflightDockerPsql({
  dockerPath,
  postgresImage = PINNED_SUPABASE_POSTGRES_IMAGE,
  run,
  signal,
}) {
  let version;
  try {
    const res = await run({
      command: dockerPath,
      args: buildDockerPsqlArgs({ postgresImage, psqlArgs: ['--version'] }),
      stdout: 'collect',
      stderr: 'collect',
      signal,
    });
    version = (res.stdout ?? '').trim();
  } catch (err) {
    throw new HostedRestoreError('Dockerized PostgreSQL client preflight failed', {
      cause: err,
      stage: 'preflight',
    });
  }
  if (parsePsqlMajorVersion(version) !== POSTGRES_MAJOR_VERSION) {
    throw new HostedRestoreError(
      `Dockerized psql must report PostgreSQL ${POSTGRES_MAJOR_VERSION}; refusing to touch the target`,
      { stage: 'preflight' },
    );
  }
  return version;
}

/** Read-only psql query; returns trimmed stdout lines. */
export async function psqlQuery({
  dockerPath,
  postgresImage = PINNED_SUPABASE_POSTGRES_IMAGE,
  dbUrl,
  query,
  run,
  signal,
}) {
  const res = await run({
    command: dockerPath,
    args: buildDockerPsqlArgs({
      postgresImage,
      psqlArgs: ['-X', '-q', '-t', '-A', '-c', query, dbUrl],
    }),
    secretArgs: [dbUrl, urlPassword(dbUrl)].filter(Boolean),
    stdout: 'collect',
    stderr: 'collect',
    signal,
  });
  return psqlOutputLines(res.stdout);
}

/** Read-only connectivity preflight: image/version, then a live target. */
export async function readOnlyPreflight({
  dockerPath,
  postgresImage = PINNED_SUPABASE_POSTGRES_IMAGE,
  dbUrl,
  run,
  signal,
}) {
  await preflightDockerPsql({ dockerPath, postgresImage, run, signal });
  const lines = await psqlQuery({
    dockerPath,
    postgresImage,
    dbUrl,
    query: 'SELECT 1',
    run,
    signal,
  });
  if (!lines.includes('1')) {
    throw new HostedRestoreError('target database did not answer the read-only preflight', {
      stage: 'preflight',
    });
  }
}

/**
 * Generate and write the private auxiliary SQL (prepared roles + cleanup) into
 * the prepared workspace with mode 0600. Returns the role/cleanup paths and
 * the truncated-table count for the result summary. The cleanup pass streams
 * the data dump line by line so multi-gigabyte restores never buffer the
 * whole file in memory.
 */
async function prepareHostedAuxiliaryFiles({
  prepared,
  recentRoles,
  writeFile = fs.writeFileSync,
}) {
  const rolesSql = fs.readFileSync(path.join(prepared.dir, 'roles.sql'), 'utf8');
  const rolesPrepared = prepareRolesFileWithCount({ rolesSql, existingRoles: recentRoles });
  const cleanupSql = await generateCleanupSqlFromFile({ dataPath: prepared.dataPath });
  const auxDir = path.join(prepared.dir, '.restore-aux');
  fs.mkdirSync(auxDir, { mode: 0o700 });
  const rolesFile = path.join(auxDir, 'roles.prepared.sql');
  const cleanupFile = path.join(auxDir, 'cleanup.sql');
  writeFile(rolesFile, rolesPrepared.sql);
  writeFile(cleanupFile, cleanupSql);
  fs.chmodSync(rolesFile, 0o600);
  fs.chmodSync(cleanupFile, 0o600);
  const cleanupLines = cleanupSql.trim();
  return {
    rolesFile,
    cleanupFile,
    rolesSkipped: rolesPrepared.skipped,
    truncatedTables: cleanupLines ? cleanupLines.split('\n').length : 0,
  };
}

/** Clean the hosted target with the repository workdir's `db reset` step. */
async function resetHostedDatabase({ supabasePath, repoRoot, dbUrl, secretArgs, run, signal }) {
  await run({
    command: supabasePath,
    args: ['db', 'reset', '--db-url', dbUrl, '--no-seed', '--yes'],
    secretArgs,
    stdout: 'inherit',
    stderr: 'collect',
    cwd: repoRoot,
    signal,
  });
}

/**
 * Lazy restore stdin stream: one file at a time, chunked with backpressure,
 * each file closed before a single newline separator advances the sequence.
 * The multi-gigabyte data file is never buffered in full and nothing is ever
 * bind-mounted into the client container.
 */
export function createRestoreInputStream(filePaths) {
  return Readable.from(restoreFileGenerator(filePaths));
}

async function* restoreFileGenerator(filePaths) {
  for (const filePath of filePaths) {
    const file = fs.createReadStream(filePath);
    try {
      for await (const chunk of file) yield chunk;
    } finally {
      file.destroy();
    }
    yield Buffer.from('\n');
  }
}

/**
 * One transactional psql restore in the documented order: prepared roles
 * (existing roles commented), the three canonical schema artifacts, the
 * generated cleanup SQL, then decrypted row data. All SQL crosses the
 * host/container boundary via stdin only (no bind mounts). The rollback
 * wording distinguishes "SQL was delivered and the transaction rolled back"
 * from "the transaction never started" (e.g. the container could not even
 * launch); both leave the target CLEAN because reset ran first.
 */
async function applyHostedRestore({
  dockerPath,
  postgresImage,
  dbUrl,
  secretArgs,
  aux,
  prepared,
  run,
  signal,
}) {
  const input = createRestoreInputStream([
    aux.rolesFile,
    ...HOSTED_RESTORE_SCHEMA_ARTIFACTS.map((name) => path.join(prepared.dir, name)),
    aux.cleanupFile,
    prepared.dataPath,
  ]);
  const delivery = trackInputDelivery(input);
  try {
    await run({
      command: dockerPath,
      args: buildDockerPsqlArgs({
        postgresImage,
        interactive: true,
        psqlArgs: ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-', dbUrl],
      }),
      secretArgs,
      input: delivery.stream,
      stdout: 'inherit',
      stderr: 'collect',
      signal,
    });
  } catch (err) {
    throw new HostedRestoreError(
      delivery.state.started
        ? 'restore transaction failed and was rolled back; the target is CLEAN after reset — retry from the same verified snapshot'
        : 'restore failed before the transaction started; the target is CLEAN after reset — retry from the same verified snapshot',
      { cause: err, stage: 'restore' },
    );
  }
}

/**
 * Wrap the lazy restore input so the caller can tell whether ANY SQL was
 * actually delivered to the child before a failure: docker never launching
 * must not be reported as "the transaction was rolled back".
 */
function trackInputDelivery(input) {
  const state = { started: false };
  const stream = Readable.from(
    (async function* () {
      for await (const chunk of input) {
        state.started = true;
        yield chunk;
      }
    })(),
  );
  return { stream, state };
}

/** The post-restore probes: connectivity, public schema, custom triggers. */
function buildHostedProbes(triggerNames) {
  return [
    { label: 'connectivity', query: 'SELECT 1', expect: ['1'] },
    {
      label: 'public schema',
      query: "SELECT count(*) FROM pg_namespace WHERE nspname = 'public'",
      expectGtZero: true,
    },
    {
      label: 'custom auth triggers',
      query: `SELECT tgname FROM pg_trigger WHERE tgname IN (${triggerNames.map((t) => `'${t}'`).join(', ')})`,
      expect: triggerNames,
    },
  ];
}

/** Run every probe and throw on the first missing expectation. */
async function verifyHostedRestore({ dockerPath, postgresImage, dbUrl, run, signal, probes }) {
  for (const probe of probes) {
    const lines = await psqlQuery({
      dockerPath,
      postgresImage,
      dbUrl,
      query: probe.query,
      run,
      signal,
    });
    if (probe.expect) {
      for (const wanted of probe.expect) {
        if (!lines.includes(wanted)) {
          throw new HostedRestoreError(
            `post-restore verification failed: ${probe.label} (missing ${wanted})`,
            { stage: 'verify' },
          );
        }
      }
    } else if (probe.expectGtZero && (lines.length === 0 || lines[0] === '0')) {
      throw new HostedRestoreError(`post-restore verification failed: ${probe.label}`, {
        stage: 'verify',
      });
    }
  }
}

/**
 * Execute the destructive hosted restore. Every step is injectable for unit
 * tests; `prepared` is the fully verified workspace from sub-plan 06 and
 * `confirm` was already satisfied by the caller.
 */
export async function executeHostedRestore({
  config,
  prepared,
  dockerPath,
  postgresImage = PINNED_SUPABASE_POSTGRES_IMAGE,
  supabasePath,
  run,
  logger,
  signal,
  triggerNames = PROJECT_TRIGGERS,
  writeFile = fs.writeFileSync,
}) {
  const { dbUrl } = config;
  const repoRoot = config.repoRoot ?? process.cwd();
  const secretArgs = [dbUrl, urlPassword(dbUrl)].filter(Boolean);

  // 1. Duplicate-role preparation against the live target (read-only query).
  const recentRoles = await psqlQuery({
    dockerPath,
    postgresImage,
    dbUrl,
    query: 'SELECT rolname FROM pg_roles',
    run,
    signal,
  });
  const aux = await prepareHostedAuxiliaryFiles({ prepared, recentRoles, writeFile });

  // 2. Clean the target (`db reset` from this repository's minimal workdir).
  await resetHostedDatabase({ supabasePath, repoRoot, dbUrl, secretArgs, run, signal });

  // 3. One transactional Dockerized psql restore in the documented order.
  await applyHostedRestore({
    dockerPath,
    postgresImage,
    dbUrl,
    secretArgs,
    aux,
    prepared,
    run,
    signal,
  });

  // 4. Post-restore verification.
  await verifyHostedRestore({
    dockerPath,
    postgresImage,
    dbUrl,
    run,
    signal,
    probes: buildHostedProbes(triggerNames),
  });

  logger.status(
    `restored ${config.environment}: snapshot verified, reset applied, single-transaction restore committed, post-checks passed`,
  );
  return {
    rolesSkipped: aux.rolesSkipped,
    truncatedTables: aux.truncatedTables,
  };
}

/**
 * Exact interactive confirmation gate. Requires a real TTY; EOF, non-TTY
 * input, typos, or mismatches return false and nothing destructive runs.
 */
export async function confirmExactPhrase({
  expected,
  input = process.stdin,
  output = process.stderr,
  isTTY = Boolean(process.stdin.isTTY),
}) {
  if (!isTTY) return false;
  output.write(`Type exactly to confirm: ${expected}\n> `);
  const line = await readLineOnce(input);
  if (line === expected) return true;
  // Immediate diagnostic feedback for typos/casing; the user's own input is
  // never echoed back.
  output.write(`confirmation mismatch — expected exactly: ${expected}\n`);
  return false;
}

function readLineOnce(input) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        cleanup();
        resolve(buffer.slice(0, idx).trim());
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer.trim());
    };
    // A stream failure is an operational error, not a declined confirmation:
    // reject so the caller never mistakes an I/O failure for a safe "no".
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

/** CHECK.js-style readable summary for the confirmation gate. */
export function confirmationSummary({
  environment,
  source,
  snapshotId,
  projectRef,
  sourceProjectRef,
}) {
  const maskedRef = projectRef
    ? `${projectRef.slice(0, 4)}****${projectRef.slice(-4)}`
    : '(unknown)';
  const lines = [
    `Target environment : ${environment}`,
    `Source             : ${source}`,
    `Snapshot           : ${snapshotId}`,
    `Project ref        : ${maskedRef}`,
  ];
  // Local-store snapshots carry their ORIGIN project; it must never be
  // hidden, because a local snapshot may be restored into any hosted target.
  if (source === 'local' && sourceProjectRef) {
    lines.push(`Source project ref : ${sourceProjectRef}`);
  }
  if (source === 'local' && sourceProjectRef && sourceProjectRef !== projectRef) {
    lines.push('');
    lines.push('!!! WARNING: this snapshot comes from a DIFFERENT project than the target.');
    lines.push("!!! The exact phrase includes the snapshot's source ref: type it to confirm.");
  }
  lines.push(
    '',
    '!!! DATA-LOSS WARNING: this command RESETS the hosted database and replaces',
    '!!! all of its contents with the verified snapshot.',
    '',
  );
  return lines.join('\n');
}
