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
 * Canonical pg_dumpall `ALTER ROLE <name> ...` lines, quoted or (for simple
 * identifiers) unquoted. The semantic guard is NOT this regex: a line is
 * only commented when its role also exists on the target (the CREATE branch
 * fails closed on any other syntax, and ALTER mirrors that below).
 */
export const ALTER_ROLE_LINE = /^\s*ALTER ROLE (?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))\s/;

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

const SUPABASE_MANAGED_TRIGGER_STATEMENTS = new Set([
  'CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();',
  'CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();',
  'CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();',
  'CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();',
]);

const MIGRATION_HISTORY_PRIMARY_KEY_SQL =
  'ALTER TABLE ONLY "supabase_migrations"."schema_migrations"\n    ADD CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version");';
const DROP_MIGRATION_HISTORY_PRIMARY_KEY_SQL =
  'ALTER TABLE ONLY "supabase_migrations"."schema_migrations"\n    DROP CONSTRAINT IF EXISTS "schema_migrations_pkey";';

/**
 * Keep only project-owned auth/storage changes in the managed delta: every
 * Supabase-managed Storage trigger line is commented, because the target
 * platform owns those triggers — a hosted `db reset` preserves them and a
 * fresh local-stack bootstrap creates them — so replaying the canonical
 * dump would fail with `already exists`.
 */
export function prepareManagedSchemaSql(managedSql) {
  return managedSql
    .split(/\r?\n/)
    .map((line) =>
      SUPABASE_MANAGED_TRIGGER_STATEMENTS.has(line.trim())
        ? `-- managed by hosted Supabase; ${line.trim()}`
        : line,
    )
    .join('\n');
}

/**
 * Replace the canonical migration-history primary-key definition with a
 * DROP-IF-EXISTS followed by the canonical ADD: every restore target
 * already owns the constraint (a hosted reset truncates the table but
 * preserves the key; a local-stack bootstrap creates it), so replaying
 * the dump verbatim would fail with `already exists`.
 */
export function prepareMigrationHistorySql(migrationHistorySql) {
  return migrationHistorySql.replace(
    MIGRATION_HISTORY_PRIMARY_KEY_SQL,
    `${DROP_MIGRATION_HISTORY_PRIMARY_KEY_SQL}\n\n${MIGRATION_HISTORY_PRIMARY_KEY_SQL}`,
  );
}

/**
 * Prepare roles in ONE pass and report how many roles were prepared away
 * because they already exist on the target. Existing roles keep BOTH their
 * canonical CREATE ROLE and every paired ALTER ROLE statement commented: a
 * role that exists on the target is platform- or migration-owned, and the
 * hosted session (non-superuser pooler) is rejected when it tries to modify
 * reserved platform roles (e.g. supabase_admin). New roles stay fully
 * active with their attributes. `skipped` counts roles, not lines, and the
 * skip marker is emitted once per role.
 */
function prepareRolesFileWithCount({
  rolesSql,
  existingRoles = [],
  marker = 'already exists on target; skipped by db-backup restore',
}) {
  const existing = new Set(existingRoles);
  const lines = rolesSql.split(/\r?\n/);
  const out = [];
  const marked = new Set();
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === 'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";') {
      out.push(`-- managed by hosted Supabase; ${line.trim()}`);
      continue;
    }
    const createMatch = CREATE_ROLE_LINE.exec(line);
    if (createMatch) {
      const role = decodeIdentifier(createMatch[1]);
      if (existing.has(role)) {
        if (!marked.has(role)) {
          out.push(`-- ${marker}`);
          marked.add(role);
        }
        out.push(`-- ${line}`);
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
    const alterMatch = ALTER_ROLE_LINE.exec(line);
    if (alterMatch) {
      const role = decodeIdentifier(alterMatch[1] ?? alterMatch[2]);
      if (existing.has(role)) {
        if (!marked.has(role)) {
          out.push(`-- ${marker}`);
          marked.add(role);
        }
        out.push(`-- ${line}`);
        continue;
      }
      out.push(line);
      continue;
    }
    if (/^\s*ALTER ROLE\b/.test(line)) {
      // Symmetric with the CREATE branch: an unrecognized ALTER ROLE shape
      // must fail during preparation, never silently replay un-commented.
      throw new HostedRestoreError(
        'unexpected ALTER ROLE syntax in roles dump; refusing broad replacement',
        { stage: 'roles' },
      );
    }
    out.push(line);
  }
  return { sql: out.join('\n'), skipped };
}

function decodeIdentifier(identifier) {
  return identifier.replaceAll('""', '"');
}

/**
 * Strictly prepare the roles file for the TARGET database: comment the
 * canonical `CREATE ROLE "x";` and every paired ALTER ROLE statement for
 * roles that already exist (never modifying an existing role: some are
 * reserved platform roles the hosted non-superuser session cannot alter) and
 * the local-stack parameter grant managed by hosted Supabase; preserve every
 * other ALTER ROLE/GRANT line for new roles; reject any other CREATE ROLE
 * syntax.
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
  return (await scanDataDumpFile({ dataPath })).cleanupSql;
}

const COPY_HEADER = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)"(?: \((.*)\))? FROM stdin;$/;
const SETVAL_LINE = /^SELECT pg_catalog\.setval\('"((?:[^"]|"")+)"\."((?:[^"]|"")+)"', .*\);$/;
const TARGET_MANAGED_DATA_SCHEMAS = new Set(['auth', 'storage', 'supabase_functions']);

function objectKey(schema, name) {
  return JSON.stringify([schema, name]);
}

function parseCopyHeader(line) {
  const match = COPY_HEADER.exec(line);
  if (!match) {
    throw new HostedRestoreError(`malformed COPY target in data dump: ${line.slice(0, 60)}`, {
      stage: 'cleanup',
    });
  }
  const columns = [];
  if (match[3] !== undefined) {
    const column = /"((?:[^"]|"")+)"(?:, |$)/y;
    while (column.lastIndex < match[3].length) {
      const parsed = column.exec(match[3]);
      if (!parsed) {
        throw new HostedRestoreError(`malformed COPY columns in data dump: ${line.slice(0, 60)}`, {
          stage: 'cleanup',
        });
      }
      columns.push(decodeIdentifier(parsed[1]));
    }
  }
  return {
    schema: decodeIdentifier(match[1]),
    table: decodeIdentifier(match[2]),
    columns,
  };
}

function parseSetval(line) {
  const match = SETVAL_LINE.exec(line);
  return match
    ? { schema: decodeIdentifier(match[1]), sequence: decodeIdentifier(match[2]) }
    : null;
}

/**
 * Shared single-pass data scanner. Besides cleanup SQL, a hosted scan can
 * identify empty COPY blocks and sequence state for managed objects absent
 * from the target. Non-empty incompatible data fails before target reset.
 */
function createCleanupScanner({ targetRelations, targetSequences } = {}) {
  const seen = new Set();
  const truncates = [];
  const skippedRelations = new Set();
  const skippedSequences = new Set();
  const publicTables = new Set();
  let activeCopy = null;
  return {
    skippedRelations,
    skippedSequences,
    publicTables,
    push(line) {
      if (activeCopy) {
        if (line === '\\.') {
          if (activeCopy.problem) {
            skippedRelations.add(objectKey(activeCopy.schema, activeCopy.table));
          }
          activeCopy = null;
          return;
        }
        if (activeCopy.problem) {
          throw new HostedRestoreError(
            `cannot restore non-empty managed data for "${activeCopy.schema}"."${activeCopy.table}": ${activeCopy.problem}`,
            { stage: 'compatibility' },
          );
        }
        return;
      }
      if (line.startsWith('COPY ')) {
        const header = parseCopyHeader(line);
        let problem = null;
        let relationExists = true;
        if (targetRelations && TARGET_MANAGED_DATA_SCHEMAS.has(header.schema)) {
          const targetColumns = targetRelations.get(objectKey(header.schema, header.table));
          if (!targetColumns) {
            problem = 'relation does not exist on the target';
            relationExists = false;
          } else {
            const missing = header.columns.filter((column) => !targetColumns.has(column));
            if (missing.length > 0) problem = `target is missing columns: ${missing.join(', ')}`;
          }
        }
        activeCopy = { ...header, problem };
        if (header.schema === 'public') {
          publicTables.add(objectKey(header.schema, header.table));
        }
        if (!relationExists || header.schema === 'public') return;
        const key = objectKey(header.schema, header.table);
        if (seen.has(key)) return;
        seen.add(key);
        truncates.push(
          `TRUNCATE TABLE "${header.schema.replaceAll('"', '""')}"."${header.table.replaceAll('"', '""')}" CASCADE;`,
        );
        return;
      }
      const setval = parseSetval(line);
      if (setval && targetSequences && TARGET_MANAGED_DATA_SCHEMAS.has(setval.schema)) {
        const key = objectKey(setval.schema, setval.sequence);
        if (targetSequences.has(key)) return;
        const emptyMissingHooks =
          setval.schema === 'supabase_functions' &&
          setval.sequence === 'hooks_id_seq' &&
          skippedRelations.has(objectKey('supabase_functions', 'hooks'));
        if (!emptyMissingHooks) {
          throw new HostedRestoreError(
            `cannot restore managed sequence "${setval.schema}"."${setval.sequence}": sequence does not exist on the target`,
            { stage: 'compatibility' },
          );
        }
        skippedSequences.add(key);
      }
    },
    result() {
      if (activeCopy) {
        throw new HostedRestoreError('unterminated COPY data block in data dump', {
          stage: 'cleanup',
        });
      }
      return `${truncates.join('\n')}\n`;
    },
  };
}

export async function scanDataDumpFile({ dataPath, targetRelations, targetSequences }) {
  const scanner = createCleanupScanner({ targetRelations, targetSequences });
  const lines = readline.createInterface({
    input: fs.createReadStream(dataPath),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) scanner.push(line);
  } finally {
    lines.close();
  }
  return {
    cleanupSql: scanner.result(),
    skippedRelations: scanner.skippedRelations,
    skippedSequences: scanner.skippedSequences,
    // Distinct COPY targets in the `public` schema (the verification count
    // the local restore checks the committed result against).
    publicTables: scanner.publicTables,
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

export const TARGET_MANAGED_DATA_OBJECTS_QUERY = `
SELECT json_build_object(
  'kind', CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'relation' END,
  'schema', c.relnamespace::regnamespace::name,
  'name', c.relname,
  'columns', COALESCE((
    SELECT json_agg(a.attname ORDER BY a.attnum)
    FROM pg_attribute AS a
    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  ), '[]'::json)
)::text
FROM pg_class AS c
WHERE c.relkind IN ('r', 'p', 'S')
  AND c.relnamespace::regnamespace::name IN ('auth', 'storage', 'supabase_functions')
ORDER BY c.relnamespace::regnamespace::name, c.relname`;

/**
 * Parse the target catalog probe output (one JSON object per line) into
 * relation->column-set and sequence maps. Malformed lines fail closed: a
 * corrupted probe could bypass managed-data compatibility checks.
 */
export function parseTargetManagedDataObjects(lines) {
  const relations = new Map();
  const sequences = new Set();
  for (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new HostedRestoreError('target catalog probe returned malformed data', {
        stage: 'preflight',
      });
    }
    if (
      !item ||
      !['relation', 'sequence'].includes(item.kind) ||
      typeof item.schema !== 'string' ||
      typeof item.name !== 'string' ||
      !Array.isArray(item.columns) ||
      !item.columns.every((column) => typeof column === 'string')
    ) {
      throw new HostedRestoreError('target catalog probe returned malformed data', {
        stage: 'preflight',
      });
    }
    const key = objectKey(item.schema, item.name);
    if (item.kind === 'sequence') sequences.add(key);
    else relations.set(key, new Set(item.columns));
  }
  return { relations, sequences };
}

async function readTargetManagedDataObjects({ dockerPath, postgresImage, dbUrl, run, signal }) {
  const lines = await psqlQuery({
    dockerPath,
    postgresImage,
    dbUrl,
    query: TARGET_MANAGED_DATA_OBJECTS_QUERY,
    run,
    signal,
  });
  return parseTargetManagedDataObjects(lines);
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
 * Generate private target-adapted SQL (roles, managed delta, migration
 * history, cleanup) in the prepared workspace with mode 0600. The cleanup
 * pass streams multi-gigabyte row data; the schema metadata stays bounded by
 * verified snapshot limits. Shared by the hosted and local-stack restore
 * flows against their own target catalogs; the caller supplies the target's
 * recent roles and managed data objects.
 */
export async function prepareRestoreAuxiliaryFiles({
  prepared,
  recentRoles,
  targetDataObjects,
  writeFile = fs.writeFileSync,
}) {
  const rolesSql = fs.readFileSync(path.join(prepared.dir, 'roles.sql'), 'utf8');
  const rolesPrepared = prepareRolesFileWithCount({ rolesSql, existingRoles: recentRoles });
  // Remote reset preserves Supabase-owned Storage triggers, so the managed
  // delta must retain only project-owned auth/storage changes.
  // ponytail: these files are bounded at 512 MiB; stream the rewrites if
  // managed schema deltas ever approach that limit.
  const managedPreparedSql = prepareManagedSchemaSql(
    fs.readFileSync(path.join(prepared.dir, 'managed-schema.sql'), 'utf8'),
  );
  // Remote reset truncates but preserves this table and primary key. Replace
  // the key transactionally before replaying its canonical dumped definition.
  const migrationHistoryPreparedSql = prepareMigrationHistorySql(
    fs.readFileSync(path.join(prepared.dir, 'migration-history-schema.sql'), 'utf8'),
  );
  const dataScan = await scanDataDumpFile({
    dataPath: prepared.dataPath,
    targetRelations: targetDataObjects.relations,
    targetSequences: targetDataObjects.sequences,
  });
  const cleanupSql = dataScan.cleanupSql;
  const auxDir = path.join(prepared.dir, '.restore-aux');
  fs.mkdirSync(auxDir, { recursive: true, mode: 0o700 });
  const rolesFile = path.join(auxDir, 'roles.prepared.sql');
  const managedFile = path.join(auxDir, 'managed-schema.prepared.sql');
  const migrationHistoryFile = path.join(auxDir, 'migration-history-schema.prepared.sql');
  const cleanupFile = path.join(auxDir, 'cleanup.sql');
  for (const [file, sql] of [
    [rolesFile, rolesPrepared.sql],
    [managedFile, managedPreparedSql],
    [migrationHistoryFile, migrationHistoryPreparedSql],
    [cleanupFile, cleanupSql],
  ]) {
    writeFile(file, sql);
    fs.chmodSync(file, 0o600);
  }
  const cleanupLines = cleanupSql.trim();
  return {
    rolesFile,
    managedFile,
    migrationHistoryFile,
    cleanupFile,
    skippedRelations: dataScan.skippedRelations,
    skippedSequences: dataScan.skippedSequences,
    rolesSkipped: rolesPrepared.skipped,
    truncatedTables: cleanupLines ? cleanupLines.split('\n').length : 0,
    // Distinct public COPY targets in the dump; the local flow verifies the
    // restored public table count against this set after the transaction.
    publicTables: dataScan.publicTables,
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
 * Lazy restore stdin stream: one file at a time with backpressure, each file
 * closed before a newline separator advances the sequence. When target schema
 * drift requires filtering empty managed COPY blocks, row data remains
 * line-streamed and is never buffered in full. Nothing is bind-mounted.
 */
export function createRestoreInputStream(
  filePaths,
  { dataPath, skippedRelations = new Set(), skippedSequences = new Set() } = {},
) {
  return Readable.from(
    restoreFileGenerator(filePaths, { dataPath, skippedRelations, skippedSequences }),
  );
}

async function* restoreFileGenerator(filePaths, filter) {
  for (const filePath of filePaths) {
    if (
      filePath === filter.dataPath &&
      (filter.skippedRelations.size > 0 || filter.skippedSequences.size > 0)
    ) {
      yield* filteredDataFileGenerator(filePath, filter);
    } else {
      const file = fs.createReadStream(filePath);
      try {
        for await (const chunk of file) yield chunk;
      } finally {
        file.destroy();
      }
    }
    yield Buffer.from('\n');
  }
}

async function* filteredDataFileGenerator(dataPath, { skippedRelations, skippedSequences }) {
  const lines = readline.createInterface({
    input: fs.createReadStream(dataPath),
    crlfDelay: Infinity,
  });
  let activeCopy = null;
  try {
    for await (const line of lines) {
      if (activeCopy) {
        if (line === '\\.') {
          if (!activeCopy.skip) yield Buffer.from('\\.\n');
          activeCopy = null;
        } else if (activeCopy.skip) {
          throw new HostedRestoreError(
            `refusing to discard non-empty managed data for "${activeCopy.schema}"."${activeCopy.table}"`,
            { stage: 'compatibility' },
          );
        } else {
          yield Buffer.from(`${line}\n`);
        }
        continue;
      }
      if (line.startsWith('COPY ')) {
        const header = parseCopyHeader(line);
        activeCopy = {
          ...header,
          skip: skippedRelations.has(objectKey(header.schema, header.table)),
        };
        if (!activeCopy.skip) yield Buffer.from(`${line}\n`);
        continue;
      }
      const setval = parseSetval(line);
      if (setval && skippedSequences.has(objectKey(setval.schema, setval.sequence))) {
        continue;
      }
      yield Buffer.from(`${line}\n`);
    }
  } finally {
    lines.close();
  }
  if (activeCopy) {
    throw new HostedRestoreError('unterminated COPY data block in data dump', {
      stage: 'compatibility',
    });
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
  const schemaOverrides = {
    'managed-schema.sql': aux.managedFile,
    'migration-history-schema.sql': aux.migrationHistoryFile,
  };
  const input = createRestoreInputStream(
    [
      aux.rolesFile,
      ...HOSTED_RESTORE_SCHEMA_ARTIFACTS.map(
        (name) => schemaOverrides[name] ?? path.join(prepared.dir, name),
      ),
      aux.cleanupFile,
      prepared.dataPath,
    ],
    {
      dataPath: prepared.dataPath,
      skippedRelations: aux.skippedRelations,
      skippedSequences: aux.skippedSequences,
    },
  );
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
 *
 * @param {import('node:stream').Readable} input
 * @returns {{stream: import('node:stream').Readable, state: {started: boolean}}}
 */
export function trackInputDelivery(input) {
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

  // 1. Read-only target catalog probes and fail-closed compatibility preparation.
  const recentRoles = await psqlQuery({
    dockerPath,
    postgresImage,
    dbUrl,
    query: 'SELECT rolname FROM pg_roles',
    run,
    signal,
  });
  const targetDataObjects = await readTargetManagedDataObjects({
    dockerPath,
    postgresImage,
    dbUrl,
    run,
    signal,
  });
  const aux = await prepareRestoreAuxiliaryFiles({
    prepared,
    recentRoles,
    targetDataObjects,
    writeFile,
  });

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
      // The gate reads stdin exactly once. A still-flowing interactive input
      // (TTY) keeps a pending read handle on the event loop, so the CLI would
      // hang after the confirmation is answered instead of exiting. Pausing
      // stops that read; the caller never reads stdin again.
      if (typeof input.pause === 'function') input.pause();
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
