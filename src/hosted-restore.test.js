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
  buildDockerPsqlArgs,
  preflightDockerPsql,
  createRestoreInputStream,
  confirmationSummary,
  HostedRestoreError,
  PROJECT_TRIGGERS,
  HOSTED_RESTORE_SCHEMA_ARTIFACTS,
  parsePsqlMajorVersion,
} from './hosted-restore.js';
import { PINNED_SUPABASE_POSTGRES_IMAGE } from './database.js';
import { PLAINTEXT_ARTIFACTS } from './snapshot.js';
import { runCommand } from './process.js';
import { tmpdir, writePrivateFile } from './test-fixtures.js';
import { confirmExactPhrase } from './hosted-restore.js';

const DB_URL =
  'postgresql://postgres.a1b2c3d4e5f6a7b8c9d0:the-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require';

/** Same connection without its password: the only form ever allowed in argv. */
const SAFE_DB_URL =
  'postgresql://postgres.a1b2c3d4e5f6a7b8c9d0@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require';

const ROLES_SQL = [
  'SET statement_timeout = 0;',
  'CREATE ROLE "anon";',
  'ALTER ROLE "anon" WITH NOLOGIN;',
  'CREATE ROLE "app_custom";',
  'ALTER ROLE "app_custom" WITH LOGIN;',
  'GRANT USAGE ON SCHEMA "public" TO "anon";',
].join('\n');

test('hosted: a restore input read failure rejects through the real process runner', async () => {
  // End-to-end through the PRODUCTION process seam (runCommand), not a mock
  // run: the child is a psql-like process that commits (exits 0) when its
  // stdin reaches EOF, and the data file vanishes before the lazy generator
  // opens it. A partial SQL prefix must never be reported as success.
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  // The fake "docker" is an executable psql-like child: it ignores the
  // docker argv and behaves like `psql --single-transaction -f -` (commit
  // and exit 0 on stdin EOF).
  const fakeDocker = path.join(root, 'fake-docker');
  fs.writeFileSync(
    fakeDocker,
    '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n',
    { mode: 0o755 },
  );
  // The fake "supabase" deletes the data file when `db reset` runs, i.e.
  // AFTER cleanup generation but BEFORE the lazy restore stream opens it.
  const fakeSupabase = path.join(root, 'fake-supabase');
  fs.writeFileSync(
    fakeSupabase,
    `#!/usr/bin/env node\nrequire('fs').rmSync(${JSON.stringify(prepared.dataPath)});\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), 'CREATE TABLE public.t();\n');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '-- triggers\n');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '-- history\n');
  writePrivateFile(prepared.dataPath, 'COPY "public"."t" FROM stdin;\n1\n\\.\n');
  await assert.rejects(
    () =>
      executeHostedRestore({
        environment: 'development',
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        dockerPath: fakeDocker,
        supabasePath: fakeSupabase,
        run: runCommand,
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
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: restore-order artifacts are explicit and independent of the packaging list', () => {
  assert.deepEqual(HOSTED_RESTORE_SCHEMA_ARTIFACTS, [
    'schema.sql',
    'managed-schema.sql',
    'migration-history-schema.sql',
  ]);
  // Today the two lists coincide after the leading roles.sql; the hosted
  // restore order must NEVER silently follow packaging reorders, so the
  // contract is pinned here.
  assert.deepEqual(HOSTED_RESTORE_SCHEMA_ARTIFACTS, PLAINTEXT_ARTIFACTS.slice(1));
});

test('hosted: restore order is decoupled from PLAINTEXT_ARTIFACTS', async () => {
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
  // Simulate packaging drift: an extra plaintext artifact must NOT be
  // injected into the transactional restore stream.
  writePrivateFile(path.join(prepared.dir, 'drift.sql'), '-- DRIFT_MARKER\n');
  PLAINTEXT_ARTIFACTS.push('drift.sql');
  const streamed = [];
  try {
    async function run(opts) {
      if (opts.input) {
        let all = '';
        for await (const chunk of opts.input) all += chunk.toString();
        streamed.push(all);
      }
      if (opts.args[1] === 'reset') return { stdout: '' };
      if (opts.args.includes('--single-transaction')) return { stdout: '' };
      const cIdx = opts.args.indexOf('-c');
      const query = cIdx !== -1 ? opts.args[cIdx + 1] : null;
      if (query === 'SELECT 1') return { stdout: '1\n' };
      if (query?.startsWith('SELECT rolname')) return { stdout: 'postgres\n' };
      if (query?.includes('pg_namespace')) return { stdout: '1\n' };
      if (query?.includes('pg_trigger'))
        return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
      return { stdout: '' };
    }
    await executeHostedRestore({
      environment: 'development',
      config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
      prepared,
      dockerPath: '/docker',
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
  } finally {
    PLAINTEXT_ARTIFACTS.pop();
  }
  assert.equal(streamed.length, 1, 'exactly one streamed restore input');
  assert.ok(
    !streamed[0].includes('DRIFT_MARKER'),
    'a packaging-list addition must never change the restore stream',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: the ephemeral client uses default networking and a writable /tmp scratch', () => {
  for (const args of [
    buildDockerPsqlArgs({ psqlArgs: ['--version'] }),
    buildDockerPsqlArgs({
      psqlArgs: ['-X', '-f', '-', 'dburl'],
      interactive: true,
    }),
  ]) {
    assert.ok(
      !args.includes('--network=host'),
      'host networking must never be requested: default bridge networking already reaches the remote target',
    );
    const tmpIdx = args.indexOf('--tmpfs');
    assert.ok(tmpIdx !== -1 && args[tmpIdx + 1] === '/tmp', 'writable /tmp scratch required');
  }
});

test('hosted: restore input stream yields only Buffer chunks', async () => {
  const root = tmpdir('bp-hosted-');
  const file = path.join(root, 'a.sql');
  writePrivateFile(file, 'AAA');
  const input = createRestoreInputStream([file]);
  for await (const chunk of input) {
    assert.ok(Buffer.isBuffer(chunk), 'every chunk must be a Buffer (no mixed string chunks)');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: parsePsqlMajorVersion parses canonical version text and rejects garbage', () => {
  assert.equal(parsePsqlMajorVersion('psql (PostgreSQL) 17.6\n'), 17);
  assert.equal(parsePsqlMajorVersion('psql (PostgreSQL) 16.4'), 16);
  assert.equal(parsePsqlMajorVersion('not psql output'), null);
  assert.equal(parsePsqlMajorVersion(''), null);
});

test('hosted: a Docker launch failure before any SQL is delivered is not reported as a rollback', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = { dir: root, dataPath: path.join(root, 'data.sql') };
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(path.join(prepared.dir, 'schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'managed-schema.sql'), '');
  writePrivateFile(path.join(prepared.dir, 'migration-history-schema.sql'), '');
  writePrivateFile(prepared.dataPath, '');
  async function run(opts) {
    if (opts.args[1] === 'reset') return { stdout: '' };
    // The container never launches (daemon unreachable): the restore input
    // stream is never even consumed, so no transaction could have started.
    if (opts.args.includes('--single-transaction')) {
      throw new Error('docker daemon unreachable');
    }
    return { stdout: '' };
  }
  await assert.rejects(
    () =>
      executeHostedRestore({
        environment: 'development',
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        dockerPath: '/docker',
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
      /before the transaction started/.test(err.message) &&
      !/rolled back/.test(err.message) &&
      /CLEAN/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: existing roles are fully untouched, new roles keep their attributes', () => {
  const out = prepareRolesFile({ rolesSql: ROLES_SQL, existingRoles: ['anon'] });
  const lines = out.split('\n');
  const anonCreate = lines.findIndex((l) => l.includes('CREATE ROLE "anon"'));
  assert.equal(
    lines.filter((l) => l.startsWith('-- already exists on target')).length,
    1,
    'the skip marker is emitted ONCE per role, not per line',
  );
  assert.ok(lines[anonCreate - 1].includes('already exists on target'));
  assert.ok(lines[anonCreate].startsWith('-- '), 'existing role CREATE is commented');
  const anonAlter = lines.findIndex((l) => l.includes('ALTER ROLE "anon"'));
  assert.ok(
    lines[anonAlter].startsWith('-- '),
    'existing role ALTER is commented: modifying it would fail on reserved roles and is meaningless for any existing role',
  );
  assert.ok(
    lines.some((l) => !l.startsWith('--') && l.includes('CREATE ROLE "app_custom"')),
    'new role kept active',
  );
  assert.ok(
    lines.some((l) => !l.startsWith('--') && l.includes('ALTER ROLE "app_custom" WITH LOGIN')),
    'its ALTER preserved',
  );
  assert.ok(
    lines.some((l) => !l.startsWith('--') && l.includes('GRANT USAGE')),
    'grants preserved',
  );
});

test('hosted: unquoted ALTER ROLE identifiers are commented for existing roles and kept for new roles', () => {
  const out = prepareRolesFile({
    rolesSql:
      'CREATE ROLE "anon";\nALTER ROLE anon WITH NOLOGIN;\nALTER ROLE app_custom WITH LOGIN;\n',
    existingRoles: ['anon'],
  });
  const lines = out.split('\n');
  assert.ok(
    lines.some((l) => l.startsWith('-- ') && l.includes('ALTER ROLE anon WITH NOLOGIN')),
    'unquoted existing-role ALTER must be commented (pooler cannot modify it)',
  );
  assert.ok(
    lines.some((l) => !l.startsWith('--') && l.includes('ALTER ROLE app_custom WITH LOGIN')),
    'unquoted new-role ALTER stays active',
  );
});

test('hosted: unexpected ALTER ROLE syntax fails closed like unexpected CREATE ROLE', () => {
  assert.throws(
    () =>
      prepareRolesFile({
        rolesSql: 'CREATE ROLE "anon";\nALTER ROLE anon;\n',
        existingRoles: ['anon'],
      }),
    (err) => err instanceof HostedRestoreError && /ALTER ROLE/.test(err.message),
  );
});

test('hosted: reserved platform roles already on the target are never modified', () => {
  const rolesSql = [
    'CREATE ROLE "supabase_admin";',
    'ALTER ROLE "supabase_admin" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;',
    'ALTER ROLE "supabase_admin" SET search_path TO public;',
  ].join('\n');
  const out = prepareRolesFile({
    rolesSql,
    existingRoles: ['postgres', 'supabase_admin'],
  });
  for (const line of out.split('\n')) {
    if (line.includes('supabase_admin')) {
      assert.ok(line.startsWith('--'), `reserved role statement must be commented: ${line}`);
    }
  }
});

test('hosted: local managed parameter grant is commented and other grants are preserved', () => {
  const managed = 'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";';
  const custom = 'GRANT SET ON PARAMETER "work_mem" TO "app_custom";';
  const lines = prepareRolesFile({
    rolesSql: `${managed}\n${custom}\n`,
    existingRoles: [],
  }).split('\n');
  assert.equal(lines[0], `-- managed by hosted Supabase; ${managed}`);
  assert.equal(lines[1], custom);
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
    'COPY "public"."perfumes" ("id", "name") FROM stdin;',
    '1\tRose\n\\.',
    'COPY "auth"."users" ("id") FROM stdin;',
    '\\.',
    'COPY "public"."perfumes" ("id", "name") FROM stdin;',
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
    () => generateCleanupSql({ dataSql: 'COPY public.perfumes FROM stdin;\n' }),
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

test('hosted: cleanup SQL streams from the data file with identical semantics', async () => {
  const root = tmpdir('bp-hosted-');
  const dataPath = path.join(root, 'data.sql');
  writePrivateFile(
    dataPath,
    [
      'COPY "auth"."users" ("id") FROM stdin;',
      '\\.',
      'COPY "public"."perfumes" FROM stdin;',
      '1\tRose',
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

test('hosted: buildDockerPsqlArgs yields a hardened ephemeral psql command', () => {
  const cases = [
    {
      name: 'query form omits --interactive',
      input: { psqlArgs: ['-X', '-q', '-t', '-A', '-c', 'SELECT 1', 'dburl'], interactive: false },
      expects: { interactive: 0 },
    },
    {
      name: 'restore form adds exactly one --interactive before the image',
      input: {
        psqlArgs: ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-', 'dburl'],
        interactive: true,
      },
      expects: { interactive: 1 },
    },
  ];
  const HARDENING = [
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=postgres',
    '--tmpfs',
    '/tmp',
    '--entrypoint=psql',
  ];
  for (const { name, input, expects } of cases) {
    const args = buildDockerPsqlArgs(input);
    assert.equal(args[0], 'run', `${name}: docker subcommand`);
    assert.equal(args.filter((a) => a === '--rm' && a).length, 1, `${name}: exactly one --rm`);
    assert.ok(!args.includes('--network=host'), `${name}: host networking must never be requested`);
    const interactiveIdx = args.indexOf('--interactive');
    assert.equal(
      args.filter((a) => a === '--interactive').length,
      expects.interactive,
      `${name}: --interactive count`,
    );
    if (expects.interactive === 1) {
      const imageIdx = args.indexOf(PINNED_SUPABASE_POSTGRES_IMAGE);
      assert.ok(
        interactiveIdx !== -1 && imageIdx !== -1 && interactiveIdx < imageIdx,
        `${name}: --interactive must precede the image`,
      );
    }
    for (const flag of HARDENING) {
      assert.equal(
        args.filter((a) => a === flag).length,
        1,
        `${name}: hardening flag ${flag} exactly once`,
      );
    }
    assert.equal(args.filter((a) => a === 'docker').length, 0, 'no docker binary prefix');
    assert.equal(
      args.includes(PINNED_SUPABASE_POSTGRES_IMAGE),
      true,
      `${name}: pinned image present`,
    );
    // No mount/container/shell/file-path leakage from the builder. The
    // container-side scratch `/tmp` is the only path argument and is not a
    // host path.
    const imageIdx = args.indexOf(PINNED_SUPABASE_POSTGRES_IMAGE);
    const dockerFlags = args.slice(1, imageIdx);
    for (const bad of ['--mount', '~', '/', 'docker exec', '&&', 'supabase_db']) {
      assert.ok(
        !dockerFlags.some((a) => a.includes(bad) && a !== '/tmp'),
        `${name}: docker flags must not contain ${bad}`,
      );
    }
    assert.ok(
      args.slice(imageIdx + 1).every((a) => !a.includes('~') || a.startsWith('-')),
      `${name}: psql args carry no host path`,
    );
  }
});

test('hosted: buildDockerPsqlArgs defaults to the pinned image and non-interactive', () => {
  const args = buildDockerPsqlArgs({ psqlArgs: ['--version'] });
  assert.equal(args.includes('--interactive'), false);
  assert.ok(args.includes(PINNED_SUPABASE_POSTGRES_IMAGE));
  assert.deepEqual(args.slice(-1), ['--version']);
});

test('hosted: preflightDockerPsql runs the pinned image and returns psql 17 version text', async () => {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    return { stdout: 'psql (PostgreSQL) 17.6\n' };
  };
  const version = await preflightDockerPsql({ dockerPath: '/docker', run });
  assert.equal(version, 'psql (PostgreSQL) 17.6');
  assert.deepEqual(calls[0].args.slice(0, 2), ['run', '--rm']);
  assert.ok(calls[0].args.includes(PINNED_SUPABASE_POSTGRES_IMAGE));
  assert.ok(calls[0].args.includes('--entrypoint=psql'));
  assert.ok(calls[0].args.includes('--version'));
  assert.ok(
    !calls[0].secretArgs || calls[0].secretArgs.length === 0,
    'version probe has no secrets',
  );
});

test('hosted: preflightDockerPsql rejects non-17 or malformed version output before target contact', async () => {
  for (const stdout of ['psql (PostgreSQL) 16.4\n', 'not psql output\n', '\n']) {
    await assert.rejects(
      () => preflightDockerPsql({ dockerPath: '/docker', run: async () => ({ stdout }) }),
      (err) => err instanceof HostedRestoreError && err.stage === 'preflight',
    );
  }
});

test('hosted: preflightDockerPsql wraps launch/image/daemon failures with a static message', async () => {
  await assert.rejects(
    () =>
      preflightDockerPsql({
        dockerPath: '/docker',
        run: async () => {
          throw new Error('docker: image not found');
        },
      }),
    (err) =>
      err instanceof HostedRestoreError &&
      err.stage === 'preflight' &&
      !/image not found/.test(err.message),
  );
});

test('hosted: read-only preflight preflights the pinned image then requires a live target', async () => {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    if (opts.args.includes('--version')) return { stdout: 'psql (PostgreSQL) 17.6\n' };
    return { stdout: '1\n' };
  };
  await readOnlyPreflight({ dockerPath: '/docker', dbUrl: DB_URL, run });
  assert.ok(calls[0].args.includes('--version'), 'version preflight runs first');
  assert.ok(calls[0].args.includes(PINNED_SUPABASE_POSTGRES_IMAGE));
  const selectCall = calls.find((c) => c.args.includes('-c'));
  assert.ok(selectCall, 'SELECT 1 query must run');
  assert.ok(selectCall.args.includes('SELECT 1'));
  assert.ok(
    !selectCall.args.some((a) => a.includes('the-password')),
    'the password must never appear in the docker argv',
  );
  assert.ok(selectCall.args.includes(SAFE_DB_URL), 'the argv URL carries no password');
  assert.ok(selectCall.args.includes('-e') && selectCall.args.includes('PGPASSWORD'));
  assert.equal(selectCall.env.PGPASSWORD, 'the-password', 'password travels via the client env');
  assert.ok(selectCall.secretArgs.includes(SAFE_DB_URL), 'target query marks url secret');
  assert.ok(selectCall.secretArgs.includes('the-password'), 'target query marks password secret');
  assert.ok(calls.indexOf(selectCall) > 0, 'target query follows the version preflight');
  const failing = async (opts) => {
    if (opts.args.includes('--version')) return { stdout: 'psql (PostgreSQL) 17.6\n' };
    return { stdout: '' };
  };
  await assert.rejects(
    () => readOnlyPreflight({ dockerPath: '/docker', dbUrl: DB_URL, run: failing }),
    (err) => err instanceof HostedRestoreError && err.stage === 'preflight',
  );
});

test('hosted: psqlQuery runs Dockerized psql and never prints the URL or password', async () => {
  const run = async ({ args, secretArgs, env }) => {
    assert.ok(args.includes(SAFE_DB_URL));
    assert.ok(!args.includes(DB_URL), 'the password-bearing URL must never reach argv');
    assert.ok(args.includes('--entrypoint=psql'));
    assert.ok(args.includes(PINNED_SUPABASE_POSTGRES_IMAGE));
    assert.ok(args.includes('-e') && args.includes('PGPASSWORD'));
    assert.equal(env.PGPASSWORD, 'the-password');
    assert.ok(secretArgs.includes(SAFE_DB_URL));
    assert.ok(secretArgs.includes('the-password'));
    return { stdout: 'a\nb\n' };
  };
  const lines = await psqlQuery({ dockerPath: '/docker', dbUrl: DB_URL, query: 'SELECT 1', run });
  assert.deepEqual(lines, ['a', 'b']);
});

test('hosted: psqlQuery forwards the abort signal to the Dockerized client', async () => {
  const signal = new AbortController().signal;
  let forwarded = false;
  await psqlQuery({
    dockerPath: '/docker',
    dbUrl: DB_URL,
    query: 'SELECT 1',
    run: async (opts) => {
      forwarded = opts.signal === signal;
      return { stdout: '1\n' };
    },
    signal,
  });
  assert.equal(forwarded, true);
});

test('hosted: psqlQuery sends a password-less URL over argv and PGPASSWORD over the client env', async () => {
  const run = async ({ args, secretArgs, env }) => {
    assert.ok(args.includes(SAFE_DB_URL));
    assert.ok(!args.includes(DB_URL), 'the password-bearing URL must never reach argv');
    assert.deepEqual(env.PGPASSWORD, 'the-password');
    assert.ok(secretArgs.includes('the-password'));
    return { stdout: 'a\nb\n' };
  };
  const lines = await psqlQuery({ dockerPath: '/docker', dbUrl: DB_URL, query: 'SELECT 1', run });
  assert.deepEqual(lines, ['a', 'b']);
});

test('hosted: non-empty incompatible managed data fails before reset', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = { dir: root, dataPath: path.join(root, 'data.sql') };
  for (const [name, sql] of [
    ['roles.sql', 'RESET ALL;\n'],
    ['schema.sql', '-- schema\n'],
    ['managed-schema.sql', ''],
    ['migration-history-schema.sql', ''],
    ['data.sql', 'COPY "storage"."future_table" ("id") FROM stdin;\n1\n\\.\n'],
  ]) {
    writePrivateFile(path.join(root, name), sql);
  }
  let reset = false;
  const run = async (opts) => {
    if (opts.args[1] === 'reset') reset = true;
    const cIdx = opts.args.indexOf('-c');
    const query = cIdx === -1 ? '' : opts.args[cIdx + 1];
    if (query.includes("c.relkind IN ('r', 'p', 'S')")) {
      return {
        stdout: `${JSON.stringify({
          kind: 'relation',
          schema: 'storage',
          name: 'future_table',
          columns: ['different_column'],
        })}\n`,
      };
    }
    return { stdout: '' };
  };
  await assert.rejects(
    () =>
      executeHostedRestore({
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        dockerPath: '/docker',
        supabasePath: '/supabase',
        run,
        logger: { status: () => {} },
      }),
    (err) =>
      err instanceof HostedRestoreError &&
      err.stage === 'compatibility' &&
      /missing columns/.test(err.message),
  );
  assert.equal(reset, false, 'incompatible non-empty data must fail before target reset');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: missing managed sequence state fails before reset', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = { dir: root, dataPath: path.join(root, 'data.sql') };
  for (const [name, sql] of [
    ['roles.sql', 'RESET ALL;\n'],
    ['schema.sql', '-- schema\n'],
    ['managed-schema.sql', ''],
    ['migration-history-schema.sql', ''],
    ['data.sql', `SELECT pg_catalog.setval('"auth"."missing_id_seq"', 1, false);\n`],
  ]) {
    writePrivateFile(path.join(root, name), sql);
  }
  let reset = false;
  const run = async (opts) => {
    if (opts.args[1] === 'reset') reset = true;
    return { stdout: '' };
  };
  await assert.rejects(
    () =>
      executeHostedRestore({
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        dockerPath: '/docker',
        supabasePath: '/supabase',
        run,
        logger: { status: () => {} },
      }),
    (err) =>
      err instanceof HostedRestoreError &&
      err.stage === 'compatibility' &&
      /sequence does not exist/.test(err.message),
  );
  assert.equal(reset, false, 'missing sequence state must fail before target reset');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: executeHostedRestore restores in one Dockerized transaction streaming the exact ordered files', async () => {
  const root = tmpdir('bp-hosted-');
  const prepared = {
    dir: path.join(root, 'prepared'),
    dataPath: path.join(root, 'prepared', 'data.sql'),
  };
  fs.mkdirSync(prepared.dir, { mode: 0o700 });
  writePrivateFile(path.join(prepared.dir, 'roles.sql'), ROLES_SQL);
  writePrivateFile(
    path.join(prepared.dir, 'schema.sql'),
    '-- SCHEMA_MARKER\nCREATE TABLE public.t();\n',
  );
  const customManagedTrigger =
    'CREATE TRIGGER custom_auth_trigger AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.custom_auth_trigger();';
  const supabaseManagedTriggers = [
    'CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();',
    'CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();',
    'CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();',
    'CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();',
  ];
  writePrivateFile(
    path.join(prepared.dir, 'managed-schema.sql'),
    `-- MANAGED_MARKER\n${customManagedTrigger}\n${supabaseManagedTriggers.join('\n')}\n`,
  );
  writePrivateFile(
    path.join(prepared.dir, 'migration-history-schema.sql'),
    '-- HISTORY_MARKER\nALTER TABLE ONLY "supabase_migrations"."schema_migrations"\n    ADD CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version");\n',
  );
  writePrivateFile(
    prepared.dataPath,
    [
      '-- DATA_MARKER',
      'COPY "public"."t" FROM stdin;',
      'COPY row data',
      '\\.',
      'COPY "storage"."buckets" ("id") FROM stdin;',
      '\\.',
      'COPY "storage"."iceberg_namespaces" ("id") FROM stdin;',
      '\\.',
      'COPY "storage"."objects" ("source_only_column") FROM stdin;',
      '\\.',
      'COPY "supabase_functions"."hooks" ("id") FROM stdin;',
      '\\.',
      `SELECT pg_catalog.setval('"auth"."refresh_tokens_id_seq"', 30, true);`,
      `SELECT pg_catalog.setval('"supabase_functions"."hooks_id_seq"', 1, false);`,
      '',
    ].join('\n'),
  );

  const calls = [];
  const streamed = [];
  async function run(opts) {
    calls.push(opts);
    if (opts.input) {
      let all = '';
      for await (const chunk of opts.input) all += chunk.toString();
      streamed.push(all);
    }
    if (opts.args[0] === '--version') return { stdout: '2.114.0\n' };
    const cIdx = opts.args.indexOf('-c');
    const query = cIdx !== -1 ? opts.args[cIdx + 1] : null;
    if (query === 'SELECT 1') return { stdout: '1\n' };
    if (query?.startsWith('SELECT rolname')) return { stdout: 'postgres\nanon\napp_custom\n' };
    if (query?.includes("c.relkind IN ('r', 'p', 'S')")) {
      return {
        stdout: [
          JSON.stringify({
            kind: 'sequence',
            schema: 'auth',
            name: 'refresh_tokens_id_seq',
            columns: [],
          }),
          JSON.stringify({
            kind: 'relation',
            schema: 'storage',
            name: 'buckets',
            columns: ['id'],
          }),
          JSON.stringify({
            kind: 'relation',
            schema: 'storage',
            name: 'objects',
            columns: ['id'],
          }),
          '',
        ].join('\n'),
      };
    }
    if (query?.includes('pg_namespace')) return { stdout: '1\n' };
    if (query?.includes('pg_trigger'))
      return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
    return { stdout: '' };
  }

  await executeHostedRestore({
    environment: 'development',
    config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
    prepared,
    dockerPath: '/docker',
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

  const resetCall = calls.find((c) => c.args[1] === 'reset');
  assert.ok(resetCall, 'db reset must run');
  assert.deepEqual(resetCall.args, ['db', 'reset', '--db-url', DB_URL, '--no-seed', '--yes']);
  assert.ok(resetCall.secretArgs.includes(DB_URL));

  const restoreCalls = calls.filter(
    (c) => c.command === '/docker' && c.args.includes('--single-transaction'),
  );
  assert.equal(restoreCalls.length, 1, 'restore must be a single Dockerized invocation');
  const restore = restoreCalls[0];
  assert.ok(restore.args.includes('ON_ERROR_STOP=1'));
  assert.ok(
    restore.args.includes('--interactive'),
    'stdin restore must attach the container stdin',
  );
  assert.ok(restore.input, 'the ordered files must be streamed as stdin input');
  const fIdx = restore.args.indexOf('-f');
  assert.deepEqual(restore.args.slice(fIdx, fIdx + 2), ['-f', '-'], 'SQL must come from stdin');
  assert.equal(restore.args.filter((a) => a === '-f').length, 1);
  assert.ok(
    !restore.args.some((a) => a.includes('.sql') || a.endsWith('data.sql')),
    'no host file path may appear in Docker argv',
  );
  assert.ok(!restore.args.some((a) => a === '--mount' || a.startsWith('--volume')), 'no mounts');
  assert.equal(streamed.length, 1, 'exactly one streamed restore input');
  const stream = streamed[0];
  const positions = ['SCHEMA_MARKER', 'MANAGED_MARKER', 'HISTORY_MARKER', 'DATA_MARKER'].map((m) =>
    stream.indexOf(m),
  );
  for (const pos of positions) assert.ok(pos !== -1, 'every restore file must be streamed');
  for (let i = 1; i < positions.length; i++) {
    assert.ok(
      positions[i] > positions[i - 1],
      'schema, managed, history, and data must stream in the exact required order',
    );
  }
  assert.ok(
    stream.indexOf('-- already exists on target') < positions[0],
    'the prepared roles file (with commented duplicates) must lead the stream',
  );
  const streamLines = stream.split('\n');
  assert.ok(streamLines.includes(customManagedTrigger), 'project-owned trigger must be restored');
  for (const statement of supabaseManagedTriggers) {
    assert.ok(
      streamLines.includes(`-- managed by hosted Supabase; ${statement}`),
      'Supabase-owned trigger must be commented',
    );
    assert.ok(!streamLines.includes(statement), 'Supabase-owned trigger must not be recreated');
  }
  const historyDrop = stream.indexOf('DROP CONSTRAINT IF EXISTS "schema_migrations_pkey"');
  const historyAdd = stream.indexOf('ADD CONSTRAINT "schema_migrations_pkey"');
  assert.ok(
    historyDrop > positions[2] && historyAdd > historyDrop,
    'reset-preserved migration primary key must be replaced before its dumped definition',
  );
  assert.ok(stream.includes('COPY row data'), 'COPY-shaped row data must remain untouched');
  assert.ok(stream.includes('TRUNCATE TABLE "storage"."buckets" CASCADE;'));
  assert.ok(stream.includes('COPY "storage"."buckets" ("id") FROM stdin;'));
  assert.ok(stream.includes('TRUNCATE TABLE "storage"."objects" CASCADE;'));
  assert.ok(!stream.includes('COPY "storage"."objects"'));
  assert.ok(stream.includes(`setval('"auth"."refresh_tokens_id_seq"'`));
  assert.ok(!stream.includes('COPY "storage"."iceberg_namespaces"'));
  assert.ok(!stream.includes('COPY "supabase_functions"."hooks"'));
  assert.ok(!stream.includes(`setval('"supabase_functions"."hooks_id_seq"'`));

  // The prepared roles file comments existing CREATE ROLE statements; the
  // auxiliary files are private (0600).
  const rolesPrepared = fs.readFileSync(
    path.join(prepared.dir, '.restore-aux', 'roles.prepared.sql'),
    'utf8',
  );
  const lines = rolesPrepared.split('\n');
  const anonCreate = lines.findIndex((l) => l.includes('CREATE ROLE "anon"'));
  assert.ok(lines[anonCreate - 1].includes('already exists on target'));
  assert.ok(lines[anonCreate].startsWith('-- '), 'existing canonical CREATE ROLE commented');
  assert.ok(lines.find((l) => l.includes('CREATE ROLE "app_custom"')));
  assert.ok(lines.find((l) => l.includes('ALTER ROLE "app_custom" WITH LOGIN')));
  assert.ok(lines.find((l) => l.includes('GRANT USAGE')));
  for (const name of [
    'roles.prepared.sql',
    'managed-schema.prepared.sql',
    'migration-history-schema.prepared.sql',
    'cleanup.sql',
  ]) {
    assert.equal(
      fs.statSync(path.join(prepared.dir, '.restore-aux', name)).mode & 0o777,
      0o600,
      name,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: restore input stream yields files in order, one open at a time, newline separated', async () => {
  const root = tmpdir('bp-hosted-');
  const files = ['a.sql', 'b.sql', 'c.sql'].map((n) => path.join(root, n));
  writePrivateFile(files[0], 'AAA');
  writePrivateFile(files[1], 'BBB');
  writePrivateFile(files[2], 'CCC');
  const input = createRestoreInputStream(files);
  let all = '';
  for await (const chunk of input) all += chunk.toString();
  assert.equal(all, 'AAA\nBBB\nCCC\n', 'each file is followed by one newline separator');
  assert.equal(input.destroyed, true, 'a fully consumed stream releases its file handles');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: restore input stream read failure propagates, closes open files, and rejects', async () => {
  const root = tmpdir('bp-hosted-');
  const good = path.join(root, 'good.sql');
  const missing = path.join(root, 'missing.sql');
  writePrivateFile(good, 'GOOD');
  const input = createRestoreInputStream([good, missing]);
  let all = '';
  await assert.rejects(
    (async () => {
      for await (const chunk of input) all += chunk.toString();
    })(),
    (err) => err.code === 'ENOENT',
  );
  assert.equal(all, 'GOOD\n', 'content before the failure is delivered, then the stream rejects');
  assert.equal(input.destroyed, true, 'the input pipeline is destroyed after a read failure');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hosted: a restore stream read failure rejects and never reports success', async () => {
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
  let restoreInput = null;
  async function run(opts) {
    if (opts.args[1] === 'reset') return { stdout: '' };
    if (opts.args.includes('--single-transaction')) {
      restoreInput = opts.input;
      // Simulate the container failing when its stdin pipe breaks: the mock
      // drains the lazy stream; a missing data file surfaces here.
      fs.rmSync(prepared.dataPath); // remove the data file before it is opened
      let drained = 0;
      for await (const chunk of restoreInput) drained += chunk.length;
      assert.ok(drained > 0, 'the streamed files must reach the container before the failure');
      return { stdout: '' };
    }
    return { stdout: '' };
  }
  await assert.rejects(
    () =>
      executeHostedRestore({
        environment: 'development',
        config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
        prepared,
        dockerPath: '/docker',
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
  assert.ok(restoreInput, 'the restore container must have started');
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
      // Only 'anon' already exists; app_custom does not yet exist.
      return { stdout: 'postgres\nanon\n' };
    }
    if (query?.includes('pg_namespace')) return { stdout: '1\n' };
    if (query?.includes('pg_trigger'))
      return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
    return { stdout: '' };
  }
  const result = await executeHostedRestore({
    environment: 'development',
    config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
    prepared,
    dockerPath: '/docker',
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
        dockerPath: '/docker',
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
      /before the transaction started/.test(err.message) &&
      !/rolled back/.test(err.message) &&
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
        dockerPath: '/docker',
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
        dockerPath: '/docker',
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
    if (query?.includes('pg_trigger'))
      return { stdout: 'create_account_for_new_user\ncleanup_deleted_user_vouches\n' };
    return { stdout: '' };
  }
  await executeHostedRestore({
    environment: 'development',
    config: { dbUrl: DB_URL, environment: 'development', repoRoot: root },
    prepared,
    dockerPath: '/docker',
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
    assert.ok(
      secrets.includes(DB_URL) || secrets.includes(SAFE_DB_URL),
      'the connection URL (password-bearing or argv-safe form) must be registered as a secret',
    );
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

test('hosted: local-source summary surfaces the snapshot origin and a cross-project warning', () => {
  const same = confirmationSummary({
    environment: 'development',
    source: 'local',
    snapshotId: '2026-08-24T03-17-09Z',
    projectRef: 'a1b2c3d4e5f6a7b8c9d0',
    sourceProjectRef: 'a1b2c3d4e5f6a7b8c9d0',
  });
  assert.ok(same.includes('Source project ref : a1b2c3d4e5f6a7b8c9d0'));
  assert.ok(!same.includes('DIFFERENT project'), 'same refs must not warn');

  const cross = confirmationSummary({
    environment: 'production',
    source: 'local',
    snapshotId: '2026-08-24T03-17-09Z',
    projectRef: 'a1b2c3d4e5f6a7b8c9d0',
    sourceProjectRef: 'f0e9d8c7b6a5f4e3d2c1',
  });
  assert.ok(cross.includes('Source project ref : f0e9d8c7b6a5f4e3d2c1'));
  assert.ok(cross.includes('DIFFERENT project'), 'differing refs must warn');
  assert.ok(cross.includes('DATA-LOSS'));

  const none = confirmationSummary({
    environment: 'development',
    source: 'r2',
    snapshotId: '2026-08-24T03-17-09Z',
    projectRef: 'a1b2c3d4e5f6a7b8c9d0',
  });
  assert.ok(!none.includes('Source project ref'), 'non-local sources have no source ref line');
});

test('hosted: trigger names default to the project triggers', () => {
  assert.deepEqual(PROJECT_TRIGGERS, [
    'create_account_for_new_user',
    'cleanup_deleted_user_vouches',
  ]);
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
