import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseWorkdirConfig,
  validateWorkdir,
  localDbUrl,
  restoreLocalStack,
  completionSummary,
  LocalRestoreError,
} from './local-restore.js';
import { tmpdir, writePrivateFile } from './test-fixtures.js';

const CONFIG_TOML = [
  'project_id = "example-project"',
  '',
  '[db]',
  'port = 54322',
  'shadow_port = 54320',
  'major_version = 17',
  '',
  '[db.pooler]',
  'enabled = false',
  '',
  '[api]',
  'port = 54321',
].join('\n');

function makeProject(root) {
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(path.join(workdir, 'supabase'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workdir, 'supabase', 'config.toml'), CONFIG_TOML);
  return workdir;
}

const ROLES_SQL = [
  'CREATE ROLE "anon";',
  'ALTER ROLE "anon" WITH NOLOGIN;',
  'CREATE ROLE "application_user";',
  'GRANT USAGE ON SCHEMA "public" TO "anon";',
].join('\n');

function makePrepared(root) {
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
  return prepared;
}

/** Drain any stream stdin payload the fake run ignores (restores stream the input). */
async function drainInput(input) {
  if (input && typeof input.pipe === 'function') {
    for await (const chunk of input) {
      void chunk; // discard: this fake does not consume stdin
    }
  }
}

/** Fake run adapter answering every docker/supabase/psql query. */
function makeRun(calls) {
  return async (opts) => {
    calls.push({ args: opts.args, input: await collectInput(opts.input) });
    if (!opts.args.includes('-c')) return { stdout: '' };
    const query = opts.args.at(-1);
    if (query.includes('pg_roles')) {
      return { stdout: 'postgres\nanon\nauthenticated\nservice_role\n' };
    }
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query.includes(' pg_tables')) return { stdout: '3\n' };
    if (query.includes('FROM "public"."t"')) return { stdout: '1\n' };
    if (query.includes('DROP SCHEMA')) return { stdout: '' };
    if (query.includes('ALTER ROLE')) return { stdout: '' };
    return { stdout: '' };
  };
}

/** Resolve the recorded stdin payload (a Buffer or the content of a stream). */
async function collectInput(input) {
  if (input === undefined || input === null) return input;
  if (typeof input.pipe === 'function') {
    const chunks = [];
    for await (const chunk of input) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return input;
}

const silent = { status() {}, warn() {}, error() {}, addSecret() {}, redact: (t) => t };

test('local: workdir config parsing tolerates CRLF line endings', () => {
  // Git on Windows may check config.toml out with CRLF endings; parsing must
  // still find the [db] section, major version, port, and project id.
  const crlf = [
    'project_id = "example-project"',
    '',
    '[db]',
    'port = 54322',
    'major_version = 17',
    '',
  ].join('\r\n');
  const parsed = parseWorkdirConfig(crlf);
  assert.equal(parsed.projectId, 'example-project');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
});

test('local: workdir config parsing extracts project, version, and port', () => {
  const parsed = parseWorkdirConfig(CONFIG_TOML);
  assert.equal(parsed.projectId, 'example-project');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
  assert.equal(parseWorkdirConfig('[db]\nport = 5433\n').majorVersion, null);
});

test('local: workdir validation accepts a real project workdir and rejects bad targets', () => {
  const root = tmpdir('bp-local-');
  const workdir = makeProject(root);

  const ok = validateWorkdir({ projectWorkdir: workdir, repoRoot: root });
  assert.equal(ok.projectId, 'example-project');
  assert.equal(ok.dbContainer, 'supabase_db_example-project');
  assert.equal(ok.workdir, fs.realpathSync(workdir));

  // Missing directory.
  assert.throws(
    () => validateWorkdir({ projectWorkdir: path.join(root, 'missing'), repoRoot: root }),
    (err) => err instanceof LocalRestoreError && /WORKDIR does not exist/.test(err.message),
  );
  // Missing config.
  fs.mkdirSync(path.join(root, 'bare'));
  assert.throws(
    () => validateWorkdir({ projectWorkdir: path.join(root, 'bare'), repoRoot: root }),
    (err) => err instanceof LocalRestoreError && /config.toml/.test(err.message),
  );
  // The backup repository itself must not be the target.
  assert.throws(
    () => validateWorkdir({ projectWorkdir: root, repoRoot: root }),
    (err) => err instanceof LocalRestoreError && /not this repository/.test(err.message),
  );
  // Wrong Postgres version.
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, 'supabase'), { recursive: true });
  fs.writeFileSync(
    path.join(other, 'supabase', 'config.toml'),
    CONFIG_TOML.replace('major_version = 17', 'major_version = 15'),
  );
  assert.throws(
    () => validateWorkdir({ projectWorkdir: other, repoRoot: root }),
    (err) => err instanceof LocalRestoreError && /major version 17/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: db url uses the configured local port', () => {
  assert.equal(localDbUrl(55322), 'postgresql://postgres:postgres@127.0.0.1:55322/postgres');
});

test('local: baseline start precedes role preparation; clean precedes restore; full stack restarts after restore', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  const cleanupFile = path.join(root, 'cleanup.sql');
  writePrivateFile(cleanupFile, 'TRUNCATE TABLE "auth"."x" CASCADE;\n');

  const calls = [];
  await restoreLocalStack({
    supabasePath: '/supabase',
    workdir,
    prepared,
    cleanupFile,
    dockerPath: '/docker',
    dbContainer: 'supabase_db_example-project',
    dbPort: 54322,
    run: makeRun(calls),
    logger: silent,
  });
  const flat = calls.map((c) => c.args.join(' '));

  // Exact supabase lifecycle: stop --no-backup, db start, start, stop, start.
  const supabaseCalls = flat.filter(
    (c) =>
      c.startsWith('stop --workdir ') ||
      c.startsWith('db start --workdir ') ||
      c.startsWith('start --workdir '),
  );
  assert.deepEqual(supabaseCalls, [
    `stop --workdir ${workdir} --no-backup`,
    `db start --workdir ${workdir}`,
    `start --workdir ${workdir}`,
    `stop --workdir ${workdir}`,
    `start --workdir ${workdir}`,
  ]);

  // Role preparation happens AFTER the baseline start but BEFORE the restore.
  const rolesQueryIdx = flat.findIndex((c) => c.includes('pg_roles'));
  const startIdx = flat.findIndex((c) => c.startsWith('start --workdir'));
  const restoreIdx = flat.findIndex((c) => c.includes('--single-transaction'));
  assert.ok(rolesQueryIdx !== -1, 'fresh-baseline roles must be queried');
  assert.ok(startIdx !== -1 && startIdx < rolesQueryIdx, 'roles queried only after start');
  assert.ok(restoreIdx !== -1 && rolesQueryIdx < restoreIdx);

  // The clean step precedes the single-transaction restore.
  const wipeIdx = flat.findIndex((c) => c.includes('DROP SCHEMA IF EXISTS public'));
  assert.ok(wipeIdx !== -1 && wipeIdx < restoreIdx, 'clean must precede restore');

  // The restore input carries the PREPARED roles (existing role commented),
  // then schema, managed, history, cleanup, then row data, in that order.
  const input = String(
    (calls.find((c) => c.args.includes('--single-transaction')) ?? {}).input ?? '',
  );
  assert.ok(
    /-- .*\nCREATE ROLE "anon";/.test(input),
    'duplicate anon CREATE ROLE must be commented out',
  );
  assert.ok(input.includes('CREATE ROLE "application_user";'), 'new role stays active');
  assert.ok(input.includes('CREATE TABLE public.t();'), 'schema included');
  assert.ok(input.includes('TRUNCATE TABLE "auth"."x" CASCADE;'), 'cleanup included');
  assert.ok(input.includes('COPY "public"."t" FROM stdin;'), 'row data included');
  const order = ['roles', 'schema', 'managed', 'history', 'cleanup', 'data'].map((label) => {
    const markers = {
      roles: 'CREATE ROLE "application_user";',
      schema: 'CREATE TABLE public.t();',
      managed: '-- triggers',
      history: '-- history',
      cleanup: 'TRUNCATE TABLE "auth"."x"',
      data: 'COPY "public"."t" FROM stdin;',
    };
    return { label, at: input.indexOf(markers[label]) };
  });
  assert.ok(order.every((o) => o.at !== -1));
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1].at < order[i].at, `${order[i - 1].label} before ${order[i].label}`);
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test('local: restore failure must not restart the stack', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  const cleanupFile = path.join(root, 'cleanup.sql');
  writePrivateFile(cleanupFile, '-- none\n');
  const calls = [];
  let failRestore = true;
  await assert.rejects(
    () =>
      restoreLocalStack({
        supabasePath: '/supabase',
        workdir,
        prepared,
        cleanupFile,
        dockerPath: '/docker',
        dbContainer: 'supabase_db_example-project',
        dbPort: 54322,
        run: async (opts) => {
          await drainInput(opts.input);
          calls.push(opts.args.join(' '));
          if (failRestore && opts.args.includes('--single-transaction'))
            throw new Error('psql restore exploded');
          if (!opts.args.includes('-c')) return { stdout: '' };
          const query = opts.args.at(-1);
          if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
          if (query === 'SELECT 1') return { stdout: '1\n' };
          if (query.includes(' pg_tables')) return { stdout: '1\n' };
          return { stdout: '' };
        },
        logger: silent,
      }),
    /psql restore exploded/,
  );
  const failedIdx = calls.findIndex((c) => c.includes('--single-transaction'));
  const after = calls.slice(failedIdx);
  assert.ok(
    !after.some((c) => c.startsWith('stop --workdir') || c.startsWith('start --workdir ')),
    'no stack restart after a failed restore',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: verification confirms snapshot-derived schema and row-data presence', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  writePrivateFile(path.join(root, 'cl.sql'), 'TRUNCATE TABLE "public"."t" CASCADE;\n');
  const verificationQueries = [];
  await restoreLocalStack({
    supabasePath: '/supabase',
    workdir,
    prepared,
    cleanupFile: path.join(root, 'cl.sql'),
    dockerPath: '/docker',
    dbContainer: 'supabase_db_example-project',
    dbPort: 54322,
    run: async (opts) => {
      await drainInput(opts.input);
      if (!opts.args.includes('-c')) return { stdout: '' };
      const query = opts.args.at(-1);
      verificationQueries.push(query);
      if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
      if (query.includes('DROP SCHEMA')) return { stdout: '' };
      if (query.includes('ALTER ROLE')) return { stdout: '' };
      if (query === 'SELECT 1') return { stdout: '1\n' };
      if (query.includes('pg_tables') && query.includes("'public'")) return { stdout: '3\n' };
      if (query.includes('pg_tables') && query.includes('supabase_migrations'))
        return { stdout: '1\n' };
      if (query.includes('pg_tables') && query.includes('NOT IN')) return { stdout: '2\n' };
      if (query.includes('FROM "public"."t"')) return { stdout: '1\n' };
      return { stdout: '' };
    },
    logger: silent,
  });

  // Structural checks plus snapshot-derived expectations, in contract order:
  // connectivity, public tables, migration history, snapshot schema tables,
  // then per-table row-data presence.
  assert.deepEqual(
    verificationQueries.filter((q) => !q.includes('pg_roles') && !q.includes('DROP SCHEMA')),
    [
      'SELECT 1',
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'supabase_migrations'",
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      'SELECT count(*) FROM (SELECT 1 FROM "public"."t" LIMIT 1) x',
    ],
    'verification must run the structural checks and the snapshot-derived checks',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: short row-data presence fails verification naming the snapshot table', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  writePrivateFile(path.join(root, 'cl.sql'), '-- none\n');
  await assert.rejects(
    () =>
      restoreLocalStack({
        supabasePath: '/supabase',
        workdir,
        prepared,
        cleanupFile: path.join(root, 'cl.sql'),
        dockerPath: '/docker',
        dbContainer: 'supabase_db_example-project',
        dbPort: 54322,
        run: async (opts) => {
          await drainInput(opts.input);
          if (!opts.args.includes('-c')) return { stdout: '' };
          const query = opts.args.at(-1);
          if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
          if (query.includes('DROP SCHEMA')) return { stdout: '' };
          if (query === 'SELECT 1') return { stdout: '1\n' };
          if (query.includes('pg_tables')) return { stdout: '1\n' };
          if (query.includes('FROM "public"."t"')) return { stdout: '0\n' };
          return { stdout: '' };
        },
        logger: silent,
      }),
    (err) =>
      err instanceof LocalRestoreError &&
      /verification failed: rows in public\.t/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: verification queries confirm connectivity, public tables, and migration history plus snapshot checks', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  writePrivateFile(path.join(root, 'cl.sql'), 'TRUNCATE TABLE "public"."t" CASCADE;\n');
  let queryCount = 0;
  const verificationQueries = [];
  await restoreLocalStack({
    supabasePath: '/supabase',
    workdir,
    prepared,
    cleanupFile: path.join(root, 'cl.sql'),
    dockerPath: '/docker',
    dbContainer: 'supabase_db_example-project',
    dbPort: 54322,
    run: async (opts) => {
      await drainInput(opts.input);
      if (!opts.args.includes('-c')) return { stdout: '' };
      const query = opts.args.at(-1);
      verificationQueries.push(query);
      if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
      if (query.includes('DROP SCHEMA')) return { stdout: '' };
      if (query.includes('ALTER ROLE')) return { stdout: '' };
      if (query === 'SELECT 1') return { stdout: '1\n' };
      if (query.includes('pg_tables') && query.includes("'public'")) return { stdout: '3\n' };
      if (query.includes('pg_tables') && query.includes('supabase_migrations'))
        return { stdout: '1\n' };
      if (query.includes('pg_tables') && query.includes('NOT IN')) return { stdout: '2\n' };
      if (query.includes('FROM "public"."t"')) return { stdout: '1\n' };
      queryCount += 1;
      return { stdout: '' };
    },
    logger: silent,
  });
  assert.equal(queryCount, 0, 'all expected queries were answered');

  // The structural checks plus snapshot-derived checks ran; no named-trigger
  // query ran. The full query list is asserted by the dedicated
  // snapshot-derived verification test above; here the failure semantics are
  // the focus.
  assert.ok(
    verificationQueries.includes(
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
    ),
    'snapshot schema-table check must run',
  );
  assert.ok(
    verificationQueries.includes('SELECT count(*) FROM (SELECT 1 FROM "public"."t" LIMIT 1) x'),
    'snapshot row-data check must run',
  );

  // A zero structural result fails verification and names the failed label.
  await assert.rejects(
    () =>
      restoreLocalStack({
        supabasePath: '/supabase',
        workdir,
        prepared,
        cleanupFile: path.join(root, 'cl.sql'),
        dockerPath: '/docker',
        dbContainer: 'supabase_db_example-project',
        dbPort: 54322,
        run: async (opts) => {
          await drainInput(opts.input);
          if (opts.args.includes('-c')) {
            const query = opts.args.at(-1);
            if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
            if (query.includes('DROP SCHEMA')) return { stdout: '' };
            if (query === 'SELECT 1') return { stdout: '1\n' };
            if (query.includes('pg_tables') && query.includes("'public'")) return { stdout: '0\n' };
            if (query.includes('pg_tables') && query.includes('supabase_migrations'))
              return { stdout: '1\n' };
            if (query.includes('pg_tables')) return { stdout: '1\n' };
            if (query.includes('FROM "public"."t"')) return { stdout: '1\n' };
            return { stdout: '1\n' };
          }
          return { stdout: '' };
        },
        logger: silent,
      }),
    (err) =>
      err instanceof LocalRestoreError && /verification failed: public tables/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: a missing project_id is rejected before the container name is derived', () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(path.join(workdir, 'supabase'), { recursive: true });
  fs.writeFileSync(
    path.join(workdir, 'supabase', 'config.toml'),
    CONFIG_TOML.replace('project_id = "example-project"', '# project_id omitted'),
  );
  assert.throws(
    () => validateWorkdir({ projectWorkdir: workdir, repoRoot: root }),
    (err) => err instanceof LocalRestoreError && /project_id/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: signal is forwarded to every destructive and verification command', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  const cleanupFile = path.join(root, 'c.sql');
  writePrivateFile(cleanupFile, '-- none\n');
  const controller = new AbortController();
  const calls = [];
  await restoreLocalStack({
    supabasePath: '/supabase',
    workdir,
    prepared,
    cleanupFile,
    dockerPath: '/docker',
    dbContainer: 'supabase_db_example-project',
    dbPort: 54322,
    run: async (opts) => {
      await drainInput(opts.input);
      calls.push({ args: opts.args, signal: opts.signal });
      if (!opts.args.includes('-c')) return { stdout: '' };
      const query = opts.args.at(-1);
      if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
      if (query === 'SELECT 1') return { stdout: '1\n' };
      if (query.includes('pg_tables')) return { stdout: '1\n' };
      if (query.includes('FROM "public"."t"')) return { stdout: '1\n' };
      return { stdout: '' };
    },
    logger: { status() {}, warn() {}, error() {}, addSecret() {}, redact: (t) => t },
    signal: controller.signal,
  });
  const lifecycle = calls.filter((c) => !c.args.includes('-c'));
  const queries = calls.filter((c) => c.args.includes('-c'));
  assert.ok(lifecycle.length >= 5, `expected the lifecycle commands, got ${lifecycle.length}`);
  assert.equal(
    queries.length,
    7,
    'public-schema wipe, roles discovery, and five verification checks (connectivity, public tables, migration history, snapshot schema tables, snapshot row data)',
  );
  for (const call of calls) {
    assert.equal(call.signal, controller.signal, `signal not forwarded: ${call.args.join(' ')}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: completion summary labels the configured project workdir and all checks', () => {
  const text = completionSummary({
    environment: 'development',
    source: 'repository',
    snapshotId: '2026-08-24T03-17-09Z',
    workdir: '/workdir/example-project',
  });
  assert.ok(text.includes('Project workdir: /workdir/example-project'), text);
  assert.match(
    text,
    /connectivity, public tables, migration history, and snapshot row data verified/,
    'summary must report every check actually performed',
  );
});

test('local: rejecting a self-referencing workdir names the local Supabase project', () => {
  const root = tmpdir('bp-local-');
  fs.mkdirSync(root, { recursive: true });
  assert.throws(
    () => validateWorkdir({ projectWorkdir: root, repoRoot: root }),
    (err) => err instanceof LocalRestoreError && /local Supabase project/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: db reset is never used against the local project workdir', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'example-project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  writePrivateFile(path.join(root, 'c.sql'), 'x\n');
  const calls = [];
  await restoreLocalStack({
    supabasePath: '/supabase',
    workdir,
    prepared,
    cleanupFile: path.join(root, 'c.sql'),
    dockerPath: '/docker',
    dbContainer: 'supabase_db_example-project',
    dbPort: 54322,
    run: async (opts) => {
      await drainInput(opts.input);
      calls.push(opts.args.join(' '));
      if (!opts.args.includes('-c')) return { stdout: '' };
      const query = opts.args.at(-1);
      if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
      if (query === 'SELECT 1') return { stdout: '1\n' };
      if (query.includes(' pg_tables')) return { stdout: '1\n' };
      if (query.includes('FROM "public"."t"')) return { stdout: '1\n' };
      return { stdout: '' };
    },
    logger: silent,
  });
  assert.ok(
    !calls.some((c) => c.includes('db reset')),
    'db reset would apply migrations, not the backup',
  );
  fs.rmSync(root, { recursive: true, force: true });
});
