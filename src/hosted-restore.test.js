import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepareRolesFile,
  generateCleanupSql,
  generateCleanupSqlFromFile,
  readOnlyPreflight,
  executeHostedRestore,
  psqlQuery,
  confirmationSummary,
  HostedRestoreError,
  buildHostedProbes,
  scanDataSqlContent,
  countCreateTables,
} from './hosted-restore.js';
import { tmpdir, writePrivateFile } from './test-fixtures.js';
import { confirmExactPhrase } from './hosted-restore.js';

const DB_URL =
  'postgresql://postgres.a1b2c3d4e5f6a7b8c9d0:the-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require';

const ROLES_SQL = [
  'SET statement_timeout = 0;',
  'CREATE ROLE "anon";',
  'ALTER ROLE "anon" WITH NOLOGIN;',
  'CREATE ROLE "application_user";',
  'ALTER ROLE "application_user" WITH LOGIN;',
  'GRANT USAGE ON SCHEMA "public" TO "anon";',
].join('\n');

test('hosted: duplicate roles are commented narrowly, others untouched', () => {
  const out = prepareRolesFile({ rolesSql: ROLES_SQL, existingRoles: ['anon'] });
  const lines = out.split('\n');
  const anonCreate = lines.findIndex((l) => l.includes('CREATE ROLE "anon"'));
  assert.ok(lines[anonCreate - 1].startsWith('-- '), 'existing role CREATE is commented');
  assert.ok(
    lines.some((l) => l.includes('ALTER ROLE "anon"')),
    'ALTER preserved',
  );
  assert.ok(
    lines.some((l) => !l.startsWith('--') && l.includes('CREATE ROLE "application_user"')),
    'new role kept active',
  );
  assert.ok(
    lines.some((l) => l.includes('ALTER ROLE "application_user" WITH LOGIN')),
    'its ALTER preserved',
  );
  assert.ok(
    lines.some((l) => l.includes('GRANT USAGE')),
    'grants preserved',
  );
});

test('hosted: unexpected role creation syntax fails instead of broad replacement', () => {
  assert.throws(
    () => prepareRolesFile({ rolesSql: 'CREATE ROLE anon;\n', existingRoles: [] }),
    (err) => err instanceof HostedRestoreError && /CREATE ROLE/.test(err.message),
  );
  assert.throws(
    () =>
      prepareRolesFile({
        rolesSql: 'CREATE ROLE "a" WITH LOGIN PASSWORD \'x\';\n',
        existingRoles: [],
      }),
    HostedRestoreError,
  );
});

test('hosted: cleanup SQL parses quoted COPY targets, decodes, dedupes', () => {
  const dataSql = [
    'COPY "public"."records" ("id", "value") FROM stdin;',
    '1\talpha\n\\.',
    'COPY "auth"."users" ("id") FROM stdin;',
    '\\.',
    'COPY "public"."records" ("id", "value") FROM stdin;',
    '\\.',
    'COPY "storage"."buckets" FROM stdin;',
    '\\.',
  ].join('\n');
  const sql = generateCleanupSql({ dataSql });
  const lines = sql.trim().split('\n');
  assert.deepEqual(lines, [
    'TRUNCATE TABLE "auth"."users" CASCADE;',
    'TRUNCATE TABLE "storage"."buckets" CASCADE;',
  ]);
});

test('hosted: cleanup SQL handles escaped quotes and rejects injection', () => {
  const sql = generateCleanupSql({ dataSql: 'COPY "we""ird"."ta""ble" FROM stdin;\n\\.\n' });
  assert.ok(sql.includes('"we""ird"."ta""ble"'));
  assert.throws(
    () => generateCleanupSql({ dataSql: 'COPY public.records FROM stdin;\n' }),
    (err) => err instanceof HostedRestoreError && /malformed COPY/.test(err.message),
  );
  assert.throws(
    () => generateCleanupSql({ dataSql: 'COPY "public"."t"; DROP TABLE x; -- FROM stdin;\n' }),
    HostedRestoreError,
  );
});

test('hosted: a failing confirmation input stream rejects instead of declining silently', async () => {
  const { Readable, Writable } = await import('node:stream');
  const input = new Readable({
    read() {
      this.destroy(new Error('input stream exploded'));
    },
  });
  const output = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  // A real stream failure is NOT a declined confirmation: it must reject so
  // the caller treats it as an operational failure, never a safe "no".
  await assert.rejects(
    () =>
      confirmExactPhrase({
        expected: 'RESTORE development',
        input,
        output,
        isTTY: true,
      }),
    /input stream exploded/,
  );
});

test('hosted: a wrong phrase prints the expected phrase as immediate feedback', async () => {
  const { Readable, Writable } = await import('node:stream');
  const chunks = [];
  const output = new Writable({
    write(c, _e, cb) {
      chunks.push(String(c));
      cb();
    },
  });
  const ok = await confirmExactPhrase({
    expected: 'RESTORE local',
    input: Readable.from([Buffer.from('RESTORE development\n')]),
    output,
    isTTY: true,
  });
  assert.equal(ok, false);
  assert.ok(
    chunks.join('').includes('expected exactly: RESTORE local'),
    'a mismatch must show the expected phrase so the user can retype it',
  );
});

test('hosted: snapshot row-data scan counts every COPY block table', async () => {
  const root = tmpdir('bp-hosted-');
  const dataPath = path.join(root, 'data.sql');
  writePrivateFile(
    dataPath,
    [
      'COPY "public"."records" ("id") FROM stdin;',
      '1',
      '2',
      '3',
      '\\.',
      'COPY "auth"."users" FROM stdin;',
      '\\.',
      'COPY "public"."records" ("id") FROM stdin;',
      '4',
      '\\.',
    ].join('\n'),
  );
  const { tables } = await scanDataSqlContent({ dataPath });
  assert.deepEqual(tables, [
    { schema: 'public', table: 'records', rows: 4 },
    { schema: 'auth', table: 'users', rows: 0 },
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: CREATE TABLE counting covers plain and unlogged tables only', () => {
  const sql = [
    'CREATE TABLE public.a (id int);',
    'CREATE UNLOGGED TABLE public.b (id int);',
    'CREATE FOREIGN TABLE public.c (id int) SERVER s;',
    'CREATE VIEW public.v AS SELECT 1;',
  ].join('\n');
  assert.equal(countCreateTables(sql), 2);
  assert.equal(countCreateTables('-- CREATE TABLE comment\n'), 0);
  assert.equal(countCreateTables(''), 0);
});

test('hosted: post-restore probes derive schema and row-data expectations from snapshot content', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(
    path.join(prepared.dir, 'schema.sql'),
    'CREATE TABLE public.a (id int);\nCREATE TABLE public.b (id int);\n',
  );
  writePrivateFile(
    prepared.dataPath,
    'COPY "public"."a" FROM stdin;\n1\n2\n\\.\nCOPY "auth"."users" FROM stdin;\n3\n\\.\n',
  );
  const probes = await buildHostedProbes({ prepared });
  assert.deepEqual(
    probes.map((p) => p.label),
    [
      'connectivity',
      'public schema',
      'snapshot schema tables',
      'rows in public.a',
      'rows in auth.users',
    ],
  );
  const schemaProbe = probes[2];
  assert.equal(schemaProbe.expectAtLeast, 2);
  assert.match(schemaProbe.query, /pg_tables/);
  assert.match(
    schemaProbe.query,
    /NOT IN \('pg_catalog','information_schema'\)/,
    'system schemas excluded from the count',
  );
  const rowProbe = probes[3];
  assert.equal(rowProbe.expectAtLeast, 2);
  assert.match(rowProbe.query, /FROM "public"\."a" LIMIT 2/);
  const usersProbe = probes[4];
  assert.equal(usersProbe.expectAtLeast, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: empty snapshots keep only the baseline probes', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), '');
  writePrivateFile(prepared.dataPath, '');
  const probes = await buildHostedProbes({ prepared });
  assert.deepEqual(
    probes.map((p) => p.label),
    ['connectivity', 'public schema'],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: cleanup SQL streams from the data file with identical semantics', async () => {
  const root = tmpdir('bp-hosted-');
  const dataPath = path.join(root, 'data.sql');
  writePrivateFile(
    dataPath,
    [
      'COPY "auth"."users" ("id") FROM stdin;',
      '\\.',
      'COPY "public"."records" FROM stdin;',
      '1\talpha',
      '\\.',
    ].join('\n'),
  );
  const sql = await generateCleanupSqlFromFile({ dataPath });
  assert.equal(sql.trim(), 'TRUNCATE TABLE "auth"."users" CASCADE;');
  // Unterminated COPY data must still be detected through the stream.
  writePrivateFile(dataPath, 'COPY "auth"."users" FROM stdin;\n1\n');
  await assert.rejects(
    () => generateCleanupSqlFromFile({ dataPath }),
    (err) => err instanceof HostedRestoreError && /unterminated COPY/.test(err.message),
  );
  // A failing read stream rejects instead of being swallowed.
  await assert.rejects(() =>
    generateCleanupSqlFromFile({ dataPath: path.join(root, 'missing.sql') }),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: read-only preflight requires a live target', async () => {
  const run = async ({ secretArgs }) => {
    assert.ok(secretArgs.includes(DB_URL), 'url must be secret');
    return { stdout: '1\n' };
  };
  await readOnlyPreflight({ psqlPath: '/psql', dbUrl: DB_URL, run });
  const failing = async () => ({ stdout: '' });
  await assert.rejects(
    () => readOnlyPreflight({ psqlPath: '/psql', dbUrl: DB_URL, run: failing }),
    (err) => err instanceof HostedRestoreError,
  );
});

test('hosted: psqlQuery never prints the URL or password', async () => {
  const run = async ({ args, secretArgs }) => {
    assert.ok(args.includes(DB_URL));
    assert.ok(secretArgs.includes(DB_URL));
    return { stdout: 'a\nb\n' };
  };
  const lines = await psqlQuery({ psqlPath: '/psql', dbUrl: DB_URL, query: 'SELECT 1', run });
  assert.deepEqual(lines, ['a', 'b']);
});

test('hosted: executeHostedRestore resets only after confirmation and restores in one transaction with exact file order', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), 'CREATE TABLE public.t();\n');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '-- triggers\n');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '-- history\n');
  writePrivateFile(prepared.dataPath, 'COPY "public"."t" FROM stdin;\n1\n\\.\n');

  const calls = [];
  async function run(opts) {
    calls.push(opts);
    if (opts.args[0] === '--version') return { stdout: '2.114.0\n' };
    const cIdx = opts.args.indexOf('-c');
    const query = cIdx !== -1 ? opts.args[cIdx + 1] : null;
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query?.startsWith('SELECT rolname'))
      return { stdout: 'postgres\nanon\napplication_user\n' };
    if (query?.includes('pg_namespace')) return { stdout: '1\n' };
    if (query?.includes('pg_tables')) return { stdout: '1\n' };
    if (query?.includes('FROM "public"."t"')) return { stdout: '1\n' };
    return { stdout: '' };
  }

  await executeHostedRestore({
    environment: 'development',
    config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
    prepared,
    psqlPath: '/psql',
    supabasePath: '/supabase',
    run,
    logger: {
      status: () => {},
      warn: () => {},
      error: () => {},
      addSecret: () => {},
      redact: (t) => t,
    },
  });

  // Structural verification: role discovery precedes reset; the
  // post-restore probes are connectivity, the public-schema existence query,
  // then snapshot-derived schema/row-data expectations; no named-trigger
  // query may ever run.
  const resetIdx = calls.findIndex((c) => c.args[1] === 'reset');
  const qIdx = (match) =>
    calls.findIndex((c) => {
      const i = c.args.indexOf('-c');
      return i !== -1 && match(c.args[i + 1]);
    });
  const rolesIdx = qIdx((q) => q.startsWith('SELECT rolname'));
  const selectOneIdx = qIdx((q) => q === 'SELECT 1');
  const schemaIdx = qIdx((q) => q.includes('pg_namespace'));
  const snapshotTablesIdx = qIdx((q) => q.includes('pg_tables'));
  const rowPresenceIdx = qIdx((q) => q.includes('FROM "public"."t"'));
  const triggerQuery = calls.find((c) => {
    const i = c.args.indexOf('-c');
    return i !== -1 && c.args[i + 1].includes('pg_trigger');
  });
  assert.ok(rolesIdx !== -1, 'role discovery must run');
  assert.ok(rolesIdx < resetIdx, 'role discovery must precede the reset');
  assert.ok(selectOneIdx > resetIdx, 'post-restore connectivity probe must run');
  assert.ok(schemaIdx > resetIdx, 'post-restore public-schema probe must run');
  assert.ok(snapshotTablesIdx > resetIdx, 'snapshot schema-table probe must run');
  assert.ok(rowPresenceIdx > resetIdx, 'snapshot row-data probe must run');
  assert.ok(!triggerQuery, 'no named-trigger query may run');

  const resetCall = calls.find((c) => c.args[1] === 'reset');
  assert.ok(resetCall, 'db reset must run');
  assert.deepEqual(resetCall.args, ['db', 'reset', '--db-url', DB_URL, '--no-seed', '--yes']);
  assert.ok(resetCall.secretArgs.includes(DB_URL));

  const psqlCalls = calls.filter(
    (c) => c.command === '/psql' && c.args.includes('--single-transaction'),
  );
  assert.equal(psqlCalls.length, 1, 'restore must be a single psql invocation');
  const restore = psqlCalls[0];
  assert.ok(restore.args.includes('ON_ERROR_STOP=1'));
  const files = restore.args.filter((a, i) => restore.args[i - 1] === '-f');
  assert.deepEqual(
    files.map((f) => path.basename(f)),
    [
      'roles.prepared.sql',
      'schema.sql',
      'managed-schema.sql',
      'migration-history-schema.sql',
      'cleanup.sql',
      'data.sql',
    ],
    'cleanup must run after schema files and before data; roles must be the prepared file',
  );
  // The prepared roles file comments only existing CREATE ROLE statements and
  // keeps ALTER/GRANT lines; the auxiliary files are private (0600).
  const rolesPrepared = fs.readFileSync(
    path.join(prepared.dir, '.restore-aux', 'roles.prepared.sql'),
    'utf8',
  );
  const lines = rolesPrepared.split('\n');
  const anonCreate = lines.findIndex((l) => l.includes('CREATE ROLE "anon"'));
  assert.ok(lines[anonCreate - 1].startsWith('-- '), 'existing canonical CREATE ROLE commented');
  assert.ok(lines.find((l) => l.includes('CREATE ROLE "application_user"')));
  assert.ok(lines.find((l) => l.includes('ALTER ROLE "application_user" WITH LOGIN')));
  assert.ok(lines.find((l) => l.includes('GRANT USAGE')));
  for (const name of ['roles.prepared.sql', 'cleanup.sql']) {
    assert.equal(
      fs.statSync(path.join(prepared.dir, '.restore-aux', name)).mode & 0o777,
      0o600,
      name,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: cleanup SQL treats row data beginning with COPY as data, not a header', () => {
  // A COPY block whose first column value starts with "COPY " is data; it must
  // not abort the restore as a malformed target.
  const dataSql = [
    'COPY "public"."recipes" ("story") FROM stdin;',
    'COPY pasta FROM stdin;',
    'COPY pasta salad',
    '\\.',
  ].join('\n');
  const sql = generateCleanupSql({ dataSql });
  assert.equal(sql.trim(), '', 'public-schema COPY headers produce no truncates');
});

test('hosted: rolesSkipped counts only roles that were actually prepared away', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), 'CREATE TABLE public.t();\n');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '-- triggers\n');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '-- history\n');
  writePrivateFile(prepared.dataPath, 'COPY "public"."t" FROM stdin;\n1\n\\.\n');
  async function run(opts) {
    if (opts.args[1] === 'reset') return { stdout: '' };
    if (opts.args.includes('--single-transaction')) return { stdout: '' };
    const cIdx = opts.args.indexOf('-c');
    const query = cIdx !== -1 ? opts.args[cIdx + 1] : null;
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query?.startsWith('SELECT rolname')) {
      // Only 'anon' already exists; application_user does not yet exist.
      return { stdout: 'postgres\nanon\n' };
    }
    if (query?.includes('pg_namespace')) return { stdout: '1\n' };
    if (query?.includes('pg_tables')) return { stdout: '1\n' };
    if (query?.includes('FROM "public"."t"')) return { stdout: '1\n' };
    return { stdout: '' };
  }
  const result = await executeHostedRestore({
    environment: 'development',
    config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
    prepared,
    psqlPath: '/psql',
    supabasePath: '/supabase',
    run,
    logger: {
      status: () => {},
      warn: () => {},
      error: () => {},
      addSecret: () => {},
      redact: (t) => t,
    },
  });
  assert.equal(result.rolesSkipped, 1, 'only the single existing role is counted');
  assert.equal(result.truncatedTables, 0, 'public-only data needs no truncate statements');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: restore transaction failure is reported with clean-target semantics', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = { dir: root, dataPath: path.join(root, 'data.sql') };
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '');
  writePrivateFile(prepared.dataPath, '');
  let failures = 0;
  async function run(opts) {
    if (opts.args[1] === 'reset') return { stdout: '' };
    if (opts.args.includes('--single-transaction')) {
      failures += 1;
      throw new Error('psql constraint violation');
    }
    return { stdout: '' };
  }
  await assert.rejects(
    () =>
      executeHostedRestore({
        environment: 'development',
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        psqlPath: '/psql',
        supabasePath: '/supabase',
        run,
        logger: {
          status: () => {},
          warn: () => {},
          error: () => {},
          addSecret: () => {},
          redact: (t) => t,
        },
      }),
    (err) =>
      err instanceof HostedRestoreError &&
      /rolled back/.test(err.message) &&
      /CLEAN/.test(err.message),
  );
  assert.equal(failures, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: post-restore verification failures propagate', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = { dir: root, dataPath: path.join(root, 'data.sql') };
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '');
  writePrivateFile(prepared.dataPath, '');
  let phase = 'pre';
  async function run(opts) {
    if (opts.args[1] === 'reset') {
      phase = 'post';
      return { stdout: '' };
    }
    if (opts.args.includes('--single-transaction')) return { stdout: '' };
    if (phase === 'post') return { stdout: '' }; // triggers missing
    return { stdout: '' };
  }
  await assert.rejects(
    () =>
      executeHostedRestore({
        environment: 'development',
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        psqlPath: '/psql',
        supabasePath: '/supabase',
        run,
        logger: {
          status: () => {},
          warn: () => {},
          error: () => {},
          addSecret: () => {},
          redact: (t) => t,
        },
      }),
    (err) => err instanceof HostedRestoreError && /verification failed/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: post-restore verification fails when restored row data falls short of the snapshot', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), 'CREATE TABLE public.t (id int);\n');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '-- triggers\n');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '-- history\n');
  // The snapshot contains TWO rows for public.t.
  writePrivateFile(prepared.dataPath, 'COPY "public"."t" FROM stdin;\n1\n2\n\\.\n');
  async function run(opts) {
    if (opts.args[1] === 'reset') return { stdout: '' };
    if (opts.args.includes('--single-transaction')) return { stdout: '' };
    const cIdx = opts.args.indexOf('-c');
    const query = cIdx !== -1 ? opts.args[cIdx + 1] : null;
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query?.startsWith('SELECT rolname')) return { stdout: 'postgres\n' };
    if (query?.includes('pg_namespace')) return { stdout: '1\n' };
    if (query?.includes('pg_tables')) return { stdout: '1\n' };
    // Only ONE of the two snapshot rows is present in the restored database.
    if (query?.includes('FROM "public"."t"')) return { stdout: '1\n' };
    return { stdout: '' };
  }
  await assert.rejects(
    () =>
      executeHostedRestore({
        environment: 'development',
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        psqlPath: '/psql',
        supabasePath: '/supabase',
        run,
        logger: {
          status: () => {},
          warn: () => {},
          error: () => {},
          addSecret: () => {},
          redact: (t) => t,
        },
      }),
    (err) =>
      err instanceof HostedRestoreError &&
      /verification failed: rows in public\.t/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: a zero-count public schema fails post-restore verification', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = { dir: root, dataPath: path.join(root, 'data.sql') };
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '');
  writePrivateFile(prepared.dataPath, '');
  async function run(opts) {
    if (opts.args[1] === 'reset') return { stdout: '' };
    if (opts.args.includes('--single-transaction')) return { stdout: '' };
    const cIdx = opts.args.indexOf('-c');
    const query = cIdx !== -1 ? opts.args[cIdx + 1] : null;
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query?.startsWith('SELECT rolname')) return { stdout: 'postgres\n' };
    // The public schema EXISTS in pg_namespace with zero count in the probe
    // query: the schema is missing and verification MUST fail.
    if (query?.includes('pg_namespace')) return { stdout: '0\n' };
    return { stdout: '' };
  }
  await assert.rejects(
    () =>
      executeHostedRestore({
        environment: 'development',
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        psqlPath: '/psql',
        supabasePath: '/supabase',
        run,
        logger: {
          status: () => {},
          warn: () => {},
          error: () => {},
          addSecret: () => {},
          redact: (t) => t,
        },
      }),
    (err) =>
      err instanceof HostedRestoreError && /verification failed: public schema/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: the isolated db URL password is registered as a secret for every command', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), 'CREATE TABLE public.t();\n');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '-- triggers\n');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '-- history\n');
  writePrivateFile(prepared.dataPath, 'COPY "public"."t" FROM stdin;\n1\n\\.\n');
  const seenSecrets = [];
  async function run(opts) {
    seenSecrets.push(opts.secretArgs ?? []);
    if (opts.args[1] === 'reset') return { stdout: '' };
    const cIdx = opts.args.indexOf('-c');
    const query = cIdx !== -1 ? opts.args[cIdx + 1] : null;
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query?.startsWith('SELECT rolname')) return { stdout: 'postgres\n' };
    if (query?.includes('pg_namespace')) return { stdout: '1\n' };
    if (query?.includes('pg_tables')) return { stdout: '1\n' };
    if (query?.includes('FROM "public"."t"')) return { stdout: '1\n' };
    return { stdout: '' };
  }
  await executeHostedRestore({
    environment: 'development',
    config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
    prepared,
    psqlPath: '/psql',
    supabasePath: '/supabase',
    run,
    logger: {
      status: () => {},
      warn: () => {},
      error: () => {},
      addSecret: () => {},
      redact: (t) => t,
    },
  });
  assert.ok(seenSecrets.length >= 5, 'every psql/probe/reset/restore command must carry secrets');
  for (const secrets of seenSecrets) {
    assert.ok(secrets.includes(DB_URL), 'db url must be registered as a secret');
    assert.ok(
      secrets.includes('the-password'),
      'the isolated password must be registered so a tool echoing it alone is redacted',
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: confirmation summary masks the project ref and warns about data loss', () => {
  const summary = confirmationSummary({
    environment: 'production',
    source: 'r2',
    snapshotId: '2026-08-24T03-17-09Z',
    projectRef: 'a1b2c3d4e5f6a7b8c9d0',
  });
  assert.ok(summary.includes('a1b2****c9d0'));
  assert.ok(!summary.includes('a1b2c3d4e5f6a7b8c9d0'));
  assert.ok(summary.includes('DATA-LOSS'));
});

test('hosted: exact confirmation requires a TTY and the exact phrase', async () => {
  const { Readable } = await import('node:stream');
  const { Writable } = await import('node:stream');
  const mkInput = (text) => Readable.from([Buffer.from(text)]);
  const output = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });

  assert.equal(
    await confirmExactPhrase({
      expected: 'RESTORE development',
      input: mkInput(''),
      output,
      isTTY: false,
    }),
    false,
  );
  assert.equal(
    await confirmExactPhrase({
      expected: 'RESTORE development',
      input: mkInput('RESTORE development\n'),
      output,
      isTTY: true,
    }),
    true,
  );
  assert.equal(
    await confirmExactPhrase({
      expected: 'RESTORE development',
      input: mkInput('RESTORE production\n'),
      output,
      isTTY: true,
    }),
    false,
  );
  // EOF with no input must not confirm.
  assert.equal(
    await confirmExactPhrase({
      expected: 'RESTORE development',
      input: mkInput(''),
      output,
      isTTY: true,
    }),
    false,
  );
});

test('hosted: the duplicate-role skip marker has the canonical shape', () => {
  const out = prepareRolesFile({ rolesSql: ROLES_SQL, existingRoles: ['anon'] });
  const lines = out.split('\n');
  const anonCreate = lines.findIndex((l) => l.includes('CREATE ROLE "anon"'));
  assert.match(lines[anonCreate - 1], /^-- .*skipped by restore$/);
});
