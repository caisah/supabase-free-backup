/**
 * Hosted development/production restore operations (sub-plan 07).
 *
 * Everything destructive happens ONLY after: full source verification
 * (sub-plan 06), read-only target preflight, and an exact interactive
 * confirmation phrase. Reset cleans the target; the restore then runs as ONE
 * psql transaction with strict ordering: prepared roles, application schema,
 * managed auth/storage delta, migration-history schema, generated cleanup
 * SQL, then decrypted combined data. Never logs URLs, passwords, identities,
 * or SQL contents.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { urlPassword } from './config.js';

export class HostedRestoreError extends Error {
  constructor(message, { cause, stage } = {}) {
    super(message);
    this.name = 'HostedRestoreError';
    this.cause = cause;
    this.stage = stage;
  }
}

export const CREATE_ROLE_LINE = /^\s*CREATE ROLE "((?:[^"]|"")+)"\s*;\s*$/;

/**
 * Prepare roles in ONE pass and report how many canonical CREATE ROLE
 * statements were commented because the role already exists on the target.
 */
function prepareRolesFileWithCount({
  rolesSql,
  existingRoles = [],
  marker = '-- already exists on target; skipped by restore',
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
 * cleanup builders; throws HostedRestoreError on malformed input. Each COPY
 * block is validated and its data lines counted per target table so restore
 * verification can assert snapshot-derived row presence.
 */
function createCleanupScanner() {
  const COPY_HEADER = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)"(?: \(.*\))? FROM stdin;$/;
  const seen = new Set();
  const truncates = [];
  const tableByKey = new Map();
  const tables = [];
  let inCopyData = false;
  let current = null;
  return {
    push(line) {
      if (inCopyData) {
        if (line === '\\.') {
          inCopyData = false;
          current = null;
        } else if (current) {
          // COPY text format escapes embedded newlines, so every physical
          // line before the terminator is exactly one row.
          current.rows += 1;
        }
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
      const key = `${schema}\u0000${table}`;
      let tracked = tableByKey.get(key);
      if (!tracked) {
        tracked = { schema, table, rows: 0 };
        tableByKey.set(key, tracked);
        tables.push(tracked);
      }
      current = tracked;
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
    content() {
      return { tables };
    },
  };
}

/**
 * Stream the decrypted data dump and report every COPY target with its row
 * count in first-seen order: `{ tables: [{ schema, table, rows }] }`. Used by
 * restore verification so the row-data checks are derived from the snapshot
 * content instead of hard-coded object names.
 */
export async function scanDataSqlContent({ dataPath }) {
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
  return scanner.content();
}

/**
 * Count user-table CREATE statements in a pg_dump schema file. Only plain
 * and UNLOGGED tables count: foreign tables never appear in pg_tables, so
 * including them would make the restored-table lower bound unsound.
 */
export function countCreateTables(schemaSql) {
  const matches = schemaSql.match(/^CREATE (?:UNLOGGED )?TABLE\b/gm);
  return matches ? matches.length : 0;
}

/**
 * Row-presence probe for one snapshot table: `LIMIT n` proves the restored
 * database holds AT LEAST n rows without a full-table count. Table/schema
 * names come from the verified snapshot and are re-quoted like the cleanup
 * SQL builder; only the row count is numeric.
 */
export function rowPresenceQuery({ schema, table, rows }) {
  const quotedSchema = schema.replaceAll('"', '""');
  const quotedTable = table.replaceAll('"', '""');
  return `SELECT count(*) FROM (SELECT 1 FROM "${quotedSchema}"."${quotedTable}" LIMIT ${rows}) x`;
}

/** Read-only psql query; returns trimmed stdout lines. */
export async function psqlQuery({ psqlPath, dbUrl, query, run, signal }) {
  const res = await run({
    command: psqlPath,
    args: ['-X', '-q', '-t', '-A', '-c', query, dbUrl],
    secretArgs: [dbUrl, urlPassword(dbUrl)].filter(Boolean),
    stdout: 'collect',
    stderr: 'collect',
    signal,
  });
  return (res.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Read-only connectivity preflight against the hosted target. */
export async function readOnlyPreflight({ psqlPath, dbUrl, run, signal }) {
  const lines = await psqlQuery({ psqlPath, dbUrl, query: 'SELECT 1', run, signal });
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
 * One transactional psql restore in the documented order. The prepared roles
 * file (existing roles commented) leads; rollback wording is contract.
 */
async function applyHostedRestore({ psqlPath, dbUrl, secretArgs, aux, prepared, run, signal }) {
  const restoreArgs = [
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '--single-transaction',
    '-f',
    aux.rolesFile,
    '-f',
    path.join(prepared.dir, 'schema.sql'),
    '-f',
    path.join(prepared.dir, 'managed-schema.sql'),
    '-f',
    path.join(prepared.dir, 'migration-history-schema.sql'),
    '-f',
    aux.cleanupFile,
    '-f',
    prepared.dataPath,
    dbUrl,
  ];
  try {
    await run({
      command: psqlPath,
      args: restoreArgs,
      secretArgs,
      stdout: 'inherit',
      stderr: 'collect',
      signal,
    });
  } catch (err) {
    throw new HostedRestoreError(
      'restore transaction failed and was rolled back; the target is CLEAN after reset — retry from the same verified snapshot',
      { cause: err, stage: 'restore' },
    );
  }
}

/**
 * The post-restore structural probes: connectivity, public-schema existence,
 * then snapshot-derived expectations. `prepared` is the verified snapshot
 * workspace: the schema-table lower bound comes from `schema.sql` and the
 * row-data presence probes come from the COPY blocks of the decrypted
 * `data.sql`, so the verification always checks what this snapshot actually
 * contains.
 */
export async function buildHostedProbes({ prepared }) {
  const probes = [
    { label: 'connectivity', query: 'SELECT 1', expect: ['1'] },
    {
      label: 'public schema',
      query: "SELECT count(*) FROM pg_namespace WHERE nspname = 'public'",
      expectGtZero: true,
    },
  ];
  const schemaTables = countCreateTables(
    fs.readFileSync(path.join(prepared.dir, 'schema.sql'), 'utf8'),
  );
  if (schemaTables > 0) {
    probes.push({
      label: 'snapshot schema tables',
      query:
        "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      expectAtLeast: schemaTables,
    });
  }
  const { tables } = await scanDataSqlContent({ dataPath: prepared.dataPath });
  for (const entry of tables) {
    if (entry.rows === 0) continue;
    probes.push({
      label: `rows in ${entry.schema}.${entry.table}`,
      query: rowPresenceQuery(entry),
      expectAtLeast: entry.rows,
    });
  }
  return probes;
}

/** Run every probe and throw on the first missing expectation. */
async function verifyHostedRestore({ psqlPath, dbUrl, run, signal, probes }) {
  for (const probe of probes) {
    const lines = await psqlQuery({ psqlPath, dbUrl, query: probe.query, run, signal });
    if (probe.expect) {
      for (const wanted of probe.expect) {
        if (!lines.includes(wanted)) {
          throw new HostedRestoreError(
            `post-restore verification failed: ${probe.label} (missing ${wanted})`,
            { stage: 'verify' },
          );
        }
      }
    } else if (probe.expectAtLeast !== undefined) {
      const value = Number(lines[0]);
      if (!Number.isInteger(value) || value < probe.expectAtLeast) {
        throw new HostedRestoreError(`post-restore verification failed: ${probe.label}`, {
          stage: 'verify',
        });
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
  environment: _environment,
  config,
  prepared,
  psqlPath,
  supabasePath,
  run,
  logger,
  signal,
  writeFile = fs.writeFileSync,
}) {
  const { dbUrl } = config;
  const repoRoot = config.repoRoot ?? process.cwd();
  const secretArgs = [dbUrl, urlPassword(dbUrl)].filter(Boolean);

  // 1. Duplicate-role preparation against the live target (read-only query).
  const recentRoles = await psqlQuery({
    psqlPath,
    dbUrl,
    query: 'SELECT rolname FROM pg_roles',
    run,
    signal,
  });
  const aux = await prepareHostedAuxiliaryFiles({ prepared, recentRoles, writeFile });

  // 2. Clean the target (`db reset` from this repository's minimal workdir).
  await resetHostedDatabase({ supabasePath, repoRoot, dbUrl, secretArgs, run, signal });

  // 3. One transactional psql restore in the documented order.
  await applyHostedRestore({ psqlPath, dbUrl, secretArgs, aux, prepared, run, signal });

  // 4. Post-restore structural verification (connectivity, public schema)
  //    plus snapshot-derived schema and row-data presence checks.
  await verifyHostedRestore({
    psqlPath,
    dbUrl,
    run,
    signal,
    probes: await buildHostedProbes({ prepared }),
  });

  logger.status(
    `restored ${config.environment}: snapshot verified, reset applied, single-transaction restore committed, post-checks and snapshot row-data presence passed`,
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
export function confirmationSummary({ environment, source, snapshotId, projectRef }) {
  const maskedRef = projectRef
    ? `${projectRef.slice(0, 4)}****${projectRef.slice(-4)}`
    : '(unknown)';
  return [
    `Target environment : ${environment}`,
    `Source             : ${source}`,
    `Snapshot           : ${snapshotId}`,
    `Project ref        : ${maskedRef}`,
    '',
    '!!! DATA-LOSS WARNING: this command RESETS the hosted database and replaces',
    '!!! all of its contents with the verified snapshot.',
    '',
  ].join('\n');
}
