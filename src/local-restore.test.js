import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { restoreLocalStack, LocalRestoreError } from './local-restore.js';
import { tmpdir, writePrivateFile } from './test-fixtures.js';

const ROLES_SQL = [
  'CREATE ROLE "anon";',
  'ALTER ROLE "anon" WITH NOLOGIN;',
  'CREATE ROLE "project_custom";',
  'GRANT USAGE ON SCHEMA "public" TO "anon";',
].join('\n');

// The dump carries both project-owned and Supabase-managed triggers; only
// the project-owned ones may replay (the fresh bootstrap created the rest).
const MANAGED_SQL = [
  '-- triggers',
  'CREATE TRIGGER create_account_for_new_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.create_account_for_new_user();',
  'CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();',
  'CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();',
].join('\n');

// The dumped migration history carries the canonical primary-key definition;
// the fresh bootstrap already created that key.
const HISTORY_SQL = [
  '-- history',
  'ALTER TABLE ONLY "supabase_migrations"."schema_migrations"',
  '    ADD CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version");',
].join('\n');

// Row data: a public table plus an empty managed COPY (the orchestrating
// cleanup truncates the dump's managed relations before their data replays).
const DATA_SQL = [
  'COPY "public"."t" FROM stdin;',
  '1',
  '\\.',
  'COPY "storage"."buckets" ("id", "name") FROM stdin;',
  '\\.',
  '',
].join('\n');

function makePrepared(root) {
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), 'CREATE TABLE public.t();\n');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), MANAGED_SQL);
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), HISTORY_SQL);
  writePrivateFile(prepared.dataPath, DATA_SQL);
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

/** Catalog probe lines for the managed schemas the fixture data references. */
function managedCatalogLines(overrides = {}) {
  const bucketsColumns = overrides.bucketsColumns ?? ['id', 'name'];
  return [
    `{"kind":"relation","schema":"storage","name":"buckets","columns":${JSON.stringify(bucketsColumns)}}`,
    '{"kind":"sequence","schema":"storage","name":"buckets_id_seq","columns":[]}',
  ].join('\n');
}

/** Fake run adapter answering every docker/supabase/psql query. */
function makeRun(calls, overrides = {}) {
  return async (opts) => {
    calls.push({ args: opts.args, input: await collectInput(opts.input) });
    if (!opts.args.includes('-c')) return { stdout: '' };
    const query = opts.args.at(-1);
    if (query.includes('pg_roles')) {
      return { stdout: 'postgres\nanon\nauthenticated\nservice_role\n' };
    }
    if (query.includes('json_build_object')) return { stdout: managedCatalogLines(overrides) };
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query.includes("nspname = 'public'")) {
      return { stdout: `${overrides.publicTableCount ?? '1'}\n` };
    }
    if (query.includes('schema_migrations')) return { stdout: '1\n' };
    if (query.includes('pg_trigger'))
      return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
    return { stdout: '' };
  };
}

const silent = { status() {}, warn() {}, error() {}, addSecret() {}, redact: (t) => t };

/** The shared happy-path restore arguments (prepared is caller-provided). */
function restoreArgs({ root, overrides }) {
  const workdir = path.join(root, 'project');
  fs.mkdirSync(workdir, { recursive: true });
  return {
    supabasePath: '/supabase',
    workdir,
    dockerPath: '/docker',
    dbContainer: 'supabase_db_testproj',
    logger: silent,
    ...overrides,
  };
}

/** The single-transaction restore input captured by the fake run. */
function restoreInput(calls) {
  return String((calls.find((c) => c.args.includes('--single-transaction')) ?? {}).input ?? '');
}

test('local restore: lifecycle is stop --no-backup, db start, restore, stop, start', async () => {
  const root = tmpdir('bp-local-');
  const calls = [];
  await restoreLocalStack({
    ...restoreArgs({ root }),
    prepared: makePrepared(root),
    run: makeRun(calls),
  });
  const flat = calls.map((c) => c.args.join(' '));
  const supabaseCalls = flat.filter(
    (c) =>
      c.startsWith('stop --workdir ') ||
      c.startsWith('db start --workdir ') ||
      c.startsWith('start --workdir '),
  );
  const workdir = path.join(root, 'project');
  // No `start` before the restore: services must never touch the database
  // while the snapshot replays; the final stop/start brings up the full stack.
  assert.deepEqual(supabaseCalls, [
    `stop --workdir ${workdir} --no-backup`,
    `db start --workdir ${workdir}`,
    `stop --workdir ${workdir}`,
    `start --workdir ${workdir}`,
  ]);

  // The compatibility probe and role query run against the FRESH bootstrap
  // (the actual restore target), after `db start`, not against the old stack.
  const dbStartIdx = flat.findIndex((c) => c.startsWith('db start --workdir'));
  const probeIdx = flat.findIndex((c) => c.includes('json_build_object'));
  const rolesQueryIdx = flat.findIndex((c) => c.includes('pg_roles'));
  const restoreIdx = flat.findIndex((c) => c.includes('--single-transaction'));
  assert.ok(dbStartIdx !== -1 && probeIdx > dbStartIdx, 'probe must follow the fresh bootstrap');
  assert.ok(rolesQueryIdx !== -1 && rolesQueryIdx > dbStartIdx, 'roles queried on fresh baseline');
  assert.ok(restoreIdx !== -1 && rolesQueryIdx < restoreIdx, 'roles queried before the restore');
  const finalStopIdx = flat.findIndex((c, i) => c.startsWith('stop --workdir') && i > restoreIdx);
  assert.ok(finalStopIdx > restoreIdx, 'full stack restarts only after the restore');
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: psql contract requires -X and --single-transaction with -f -', async () => {
  const root = tmpdir('bp-local-');
  const calls = [];
  await restoreLocalStack({
    ...restoreArgs({ root }),
    prepared: makePrepared(root),
    run: makeRun(calls),
  });
  const restore = calls.find((c) => c.args.includes('--single-transaction'));
  assert.ok(restore, 'restore invocation must exist');
  assert.deepEqual(restore.args, [
    'exec',
    '-i',
    'supabase_db_testproj',
    'psql',
    '-X',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '--single-transaction',
    '-f',
    '-',
  ]);
  assert.ok(
    !calls.some(
      (c) => c.args.includes('-c') && c.args.at(-1).includes('DROP SCHEMA IF EXISTS public'),
    ),
    'the public reset must never run as a separate committed -c statement',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: the streamed transaction starts with the atomic public schema reset', async () => {
  const root = tmpdir('bp-local-');
  const calls = [];
  await restoreLocalStack({
    ...restoreArgs({ root }),
    prepared: makePrepared(root),
    run: makeRun(calls),
  });
  const input = restoreInput(calls);
  assert.ok(input.includes('DROP SCHEMA IF EXISTS public CASCADE;'), 'public dropped');
  assert.ok(input.includes('CREATE SCHEMA public AUTHORIZATION postgres;'), 'public recreated');
  assert.ok(input.includes('GRANT ALL ON SCHEMA public TO PUBLIC;'), 'public granted');
  const resetAt = input.indexOf('DROP SCHEMA IF EXISTS public CASCADE;');
  const rolesAt = input.indexOf('CREATE ROLE "project_custom";');
  assert.ok(resetAt !== -1 && rolesAt !== -1 && resetAt < rolesAt, 'reset leads the transaction');
  assert.equal(
    input.split('CREATE SCHEMA public AUTHORIZATION postgres;').length - 1,
    1,
    'exactly one public schema recreation',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: artifacts stream in order and are newline-separated', async () => {
  const root = tmpdir('bp-local-');
  const calls = [];
  await restoreLocalStack({
    ...restoreArgs({ root }),
    prepared: makePrepared(root),
    run: makeRun(calls),
  });
  const input = restoreInput(calls);
  // The PREPARED roles (existing role commented once), then schema, managed,
  // history, cleanup, then row data, in the frozen hosted restore order.
  assert.ok(
    input.includes(
      '-- already exists on target; skipped by db-backup restore\n-- CREATE ROLE "anon";',
    ),
  );
  assert.ok(
    input.includes('-- ALTER ROLE "anon" WITH NOLOGIN;'),
    'existing role ALTER is commented',
  );
  assert.ok(input.includes('CREATE ROLE "project_custom";'), 'new role stays active');
  assert.ok(input.includes('CREATE TABLE public.t();'), 'schema included');
  assert.ok(input.includes('TRUNCATE TABLE "storage"."buckets" CASCADE;'), 'cleanup included');
  assert.ok(
    input.includes(
      '-- managed by hosted Supabase; CREATE TRIGGER enforce_bucket_name_length_trigger',
    ),
    'supabase-managed trigger must be commented',
  );
  assert.ok(input.includes('CREATE TRIGGER create_account_for_new_user'), 'project trigger stays');
  const dropIdx = input.indexOf('DROP CONSTRAINT IF EXISTS "schema_migrations_pkey"');
  const addIdx = input.indexOf('ADD CONSTRAINT "schema_migrations_pkey"');
  assert.ok(dropIdx !== -1 && dropIdx < addIdx, 'history key dropped before canonical replay');
  const order = ['reset', 'roles', 'schema', 'managed', 'history', 'cleanup', 'data'].map(
    (label) => {
      const markers = {
        reset: 'DROP SCHEMA IF EXISTS public CASCADE;',
        roles: 'CREATE ROLE "project_custom";',
        schema: 'CREATE TABLE public.t();',
        managed: '-- triggers',
        history: '-- history',
        cleanup: 'TRUNCATE TABLE "storage"."buckets"',
        data: 'COPY "public"."t" FROM stdin;',
      };
      return { label, at: input.indexOf(markers[label]) };
    },
  );
  assert.ok(order.every((o) => o.at !== -1));
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1].at < order[i].at, `${order[i - 1].label} before ${order[i].label}`);
  }
  // Every artifact is closed by a newline: a trailing comment in one file can
  // never swallow the first statement of the next.
  for (const marker of [
    'CREATE ROLE "project_custom";',
    'CREATE TABLE public.t();',
    'CREATE TRIGGER create_account_for_new_user',
    'TRUNCATE TABLE "storage"."buckets" CASCADE;',
  ]) {
    const at = input.indexOf(marker);
    assert.ok(at > 0 && input[at - 1] === '\n', `${marker} must follow a newline`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: non-empty incompatible managed data fails closed with a preflight LocalRestoreError', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  // The snapshot's storage data carries a column the fresh bootstrap lacks.
  writePrivateFile(
    prepared.dataPath,
    'COPY "storage"."buckets" ("id", "versioning_status") FROM stdin;\n1\nx\n\\.\n',
  );
  const calls = [];
  await assert.rejects(
    () =>
      restoreLocalStack({
        ...restoreArgs({ root }),
        prepared,
        run: makeRun(calls, { bucketsColumns: ['id', 'name'] }),
      }),
    (err) =>
      err instanceof LocalRestoreError &&
      err.stage === 'preflight' &&
      /cannot restore non-empty managed data for "storage"\."buckets"/.test(err.message),
  );
  assert.ok(
    !calls.some((c) => c.args.includes('--single-transaction')),
    'no restore may run after an incompatible snapshot',
  );
  assert.ok(
    !calls.some((c) => c.args[0] === 'stop --workdir' && !c.args.includes('--no-backup')),
    'the full stack must not restart after a failed preflight',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: empty incompatible managed data is skipped, never a failure', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  writePrivateFile(
    prepared.dataPath,
    [
      'COPY "public"."t" FROM stdin;',
      '1',
      '\\.',
      'COPY "storage"."buckets" ("id", "versioning_status") FROM stdin;',
      '\\.',
      '',
    ].join('\n'),
  );
  const calls = [];
  await restoreLocalStack({
    ...restoreArgs({ root }),
    prepared,
    run: makeRun(calls, { bucketsColumns: ['id', 'name'] }),
  });
  assert.ok(!restoreInput(calls).includes('versioning_status'), 'empty incompatible data skipped');
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: restore failure is a LocalRestoreError with rollback guidance and no restart', async () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'project');
  fs.mkdirSync(workdir, { recursive: true });
  const prepared = makePrepared(root);
  const calls = [];
  await assert.rejects(
    () =>
      restoreLocalStack({
        ...restoreArgs({ root }),
        prepared,
        run: async (opts) => {
          await drainInput(opts.input);
          calls.push(opts.args.join(' '));
          if (opts.args.includes('--single-transaction')) throw new Error('psql restore exploded');
          if (!opts.args.includes('-c')) return { stdout: '' };
          const query = opts.args.at(-1);
          if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
          if (query.includes('json_build_object')) return { stdout: managedCatalogLines() };
          if (query === 'SELECT 1') return { stdout: '1\n' };
          if (query.includes("nspname = 'public'")) return { stdout: '1\n' };
          if (query.includes('schema_migrations')) return { stdout: '1\n' };
          if (query.includes('pg_trigger'))
            return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
          return { stdout: '' };
        },
      }),
    (err) =>
      err instanceof LocalRestoreError &&
      err.stage === 'restore' &&
      /rolled back/.test(err.message) &&
      err.cause?.message === 'psql restore exploded',
  );
  const failedIdx = calls.findIndex((c) => c.includes('--single-transaction'));
  const after = calls.slice(failedIdx);
  assert.ok(
    !after.some((c) => c.startsWith('stop --workdir') || c.startsWith('start --workdir ')),
    'no stack restart after a failed restore',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: verification confirms schema, history, and auth-scoped triggers', async () => {
  const root = tmpdir('bp-local-');
  const prepared = makePrepared(root);
  const run = makeRun([]);
  await restoreLocalStack({ ...restoreArgs({ root }), prepared, run });

  // A missing custom trigger on auth relations fails verification.
  let missing = true;
  await assert.rejects(
    () =>
      restoreLocalStack({
        ...restoreArgs({ root }),
        prepared,
        run: async (opts) => {
          await drainInput(opts.input);
          if (!opts.args.includes('-c')) return { stdout: '' };
          const query = opts.args.at(-1);
          if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
          if (query.includes('json_build_object')) return { stdout: managedCatalogLines() };
          if (query === 'SELECT 1') return { stdout: '1\n' };
          if (query.includes("nspname = 'public'")) return { stdout: '1\n' };
          if (query.includes('schema_migrations')) return { stdout: '1\n' };
          if (query.includes('pg_trigger')) {
            if (missing) {
              missing = false;
              return { stdout: 'create_account_for_new_user\n' };
            }
            return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
          }
          return { stdout: '' };
        },
      }),
    (err) => err instanceof LocalRestoreError && /cleanup_deleted_user_vouches/.test(err.message),
  );

  // A public-table count that does not match the dump fails verification.
  await assert.rejects(
    () =>
      restoreLocalStack({
        ...restoreArgs({ root }),
        prepared,
        run: makeRun([], { publicTableCount: '2' }),
      }),
    (err) =>
      err instanceof LocalRestoreError &&
      /public tables/.test(err.message) &&
      /expected 1/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: signal is forwarded to every lifecycle and verification command', async () => {
  const root = tmpdir('bp-local-');
  const prepared = makePrepared(root);
  const controller = new AbortController();
  const calls = [];
  await restoreLocalStack({
    ...restoreArgs({ root }),
    prepared,
    signal: controller.signal,
    run: async (opts) => {
      await drainInput(opts.input);
      calls.push({ args: opts.args, signal: opts.signal });
      if (!opts.args.includes('-c')) return { stdout: '' };
      const query = opts.args.at(-1);
      if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
      if (query.includes('json_build_object')) return { stdout: managedCatalogLines() };
      if (query === 'SELECT 1') return { stdout: '1\n' };
      if (query.includes("nspname = 'public'")) return { stdout: '1\n' };
      if (query.includes('schema_migrations')) return { stdout: '1\n' };
      if (query.includes('pg_trigger')) {
        return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
      }
      return { stdout: '' };
    },
  });
  const lifecycle = calls.filter((c) => !c.args.includes('-c'));
  const queries = calls.filter((c) => c.args.includes('-c'));
  assert.ok(lifecycle.length >= 4, `expected the lifecycle commands, got ${lifecycle.length}`);
  assert.ok(queries.length >= 6, `expected the probe/verify queries, got ${queries.length}`);
  for (const call of calls) {
    assert.equal(call.signal, controller.signal, `signal not forwarded: ${call.args.join(' ')}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('local restore: db reset is never used against the project workdir', async () => {
  const root = tmpdir('bp-local-');
  const prepared = makePrepared(root);
  const calls = [];
  await restoreLocalStack({
    ...restoreArgs({ root }),
    prepared,
    run: async (opts) => {
      await drainInput(opts.input);
      calls.push(opts.args.join(' '));
      if (!opts.args.includes('-c')) return { stdout: '' };
      const query = opts.args.at(-1);
      if (query.includes('pg_roles')) return { stdout: 'postgres\nanon\n' };
      if (query.includes('json_build_object')) return { stdout: managedCatalogLines() };
      if (query === 'SELECT 1') return { stdout: '1\n' };
      if (query.includes("nspname = 'public'")) return { stdout: '1\n' };
      if (query.includes('schema_migrations')) return { stdout: '1\n' };
      if (query.includes('pg_trigger'))
        return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
      return { stdout: '' };
    },
  });
  assert.ok(
    !calls.some((c) => c.includes('db reset')),
    'db reset would apply migrations, not the backup',
  );
  fs.rmSync(root, { recursive: true, force: true });
});
