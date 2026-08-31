import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDumpCommands,
  runDumps,
  validateDumpOutputs,
  preflightSupabase,
  dumpDatabase,
  PINNED_SUPABASE_CLI_VERSION,
  PINNED_SUPABASE_POSTGRES_IMAGE,
  PINNED_SUPABASE_POSTGRES_TAG,
} from './database.js';
import { POSTGRES_MAJOR_VERSION } from './snapshot.js';
import { tmpdir, writePrivateFile, fileMode } from './test-fixtures.js';

const DB_URL =
  'postgresql://postgres.a1b2c3d4e5f6a7b8c9d0:the-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require';

/** Create an executable stand-in so preflight existence checks pass. */
function makeSupabaseBin(root) {
  const bin = path.join(root, 'fake-supabase');
  fs.writeFileSync(bin, '#!/bin/sh\necho 2.114.0\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

let FAKE_DOCKER;
function fakeDocker() {
  if (!FAKE_DOCKER) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-docker-'));
    FAKE_DOCKER = path.join(dir, 'docker');
    fs.writeFileSync(FAKE_DOCKER, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(FAKE_DOCKER, 0o755);
  }
  return FAKE_DOCKER;
}

function captureRun() {
  const calls = [];
  async function run(opts) {
    if (opts.args[0] === '--version') return { stdout: `${PINNED_SUPABASE_CLI_VERSION}\n` };
    calls.push(opts);
    return { stdout: null };
  }
  return { run, calls };
}

function outDirFixture(root) {
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o700 });
  return out;
}

test('database: Postgres image is pinned by an immutable digest, never a mutable tag', () => {
  assert.equal(PINNED_SUPABASE_CLI_VERSION, '2.114.0');
  assert.match(
    PINNED_SUPABASE_POSTGRES_IMAGE,
    /^public\.ecr\.aws\/supabase\/postgres@sha256:[0-9a-f]{64}$/,
    'the image reference must be a digest (registry-verified), not a tag',
  );
  // The reviewed human-readable tag is kept for documentation/upgrades only:
  // code must NEVER execute the tag form, only the digest above.
  assert.equal(PINNED_SUPABASE_POSTGRES_TAG, 'public.ecr.aws/supabase/postgres:17.6.1.158');
  assert.ok(
    PINNED_SUPABASE_POSTGRES_TAG.includes(`:${POSTGRES_MAJOR_VERSION}.`),
    `tag ${PINNED_SUPABASE_POSTGRES_TAG} must begin with the configured Postgres major ${POSTGRES_MAJOR_VERSION}`,
  );
});

test('database: exact executable and argument arrays for every command', async () => {
  const root = tmpdir('bp-db-');
  const SUPABASE_BIN = makeSupabaseBin(root);
  const out = outDirFixture(root);
  const { run, calls } = captureRun();
  await runDumps({
    dbUrl: DB_URL,
    cwd: root,
    outDir: out,
    supabasePath: SUPABASE_BIN,
    dockerPath: fakeDocker(),
    run,
  });
  const paths = {
    roles: path.join(out, 'roles.sql'),
    schema: path.join(out, 'schema.sql'),
    managed: path.join(out, 'managed-schema.sql'),
    historySchema: path.join(out, 'migration-history-schema.sql'),
    historyData: path.join(out, 'migration-history-data.sql'),
    databaseData: path.join(out, 'database-data.sql'),
  };
  const expected = [
    {
      name: 'roles',
      args: ['db', 'dump', '--db-url', DB_URL, '--file', paths.roles, '--role-only'],
    },
    { name: 'schema', args: ['db', 'dump', '--db-url', DB_URL, '--file', paths.schema] },
    {
      name: 'managed',
      args: [
        'db',
        'diff',
        '--db-url',
        DB_URL,
        '--schema',
        'auth,storage',
        '--use-migra',
        '--output-format',
        'text',
      ],
    },
    {
      name: 'historySchema',
      args: [
        'db',
        'dump',
        '--db-url',
        DB_URL,
        '--file',
        paths.historySchema,
        '--schema',
        'supabase_migrations',
      ],
    },
    {
      name: 'historyData',
      args: [
        'db',
        'dump',
        '--db-url',
        DB_URL,
        '--file',
        paths.historyData,
        '--schema',
        'supabase_migrations',
        '--data-only',
        '--use-copy',
      ],
    },
    {
      name: 'databaseData',
      args: [
        'db',
        'dump',
        '--db-url',
        DB_URL,
        '--file',
        paths.databaseData,
        '--data-only',
        '--use-copy',
        '--exclude',
        'storage.buckets_vectors',
        '--exclude',
        'storage.vector_indexes',
      ],
    },
  ];
  assert.equal(calls.length, 6);
  calls.forEach((call, i) => {
    assert.equal(call.command, SUPABASE_BIN, `command[${i}]`);
    assert.deepEqual(call.args, expected[i].args, `args[${i}]`);
    assert.ok(call.secretArgs.includes(DB_URL), `url secret[${i}]`);
    assert.equal(call.cwd, root, `cwd[${i}]`);
    assert.equal(call.shell, undefined, `shell flag never set for ${expected[i].name}`);
  });
  // Exact vector exclusions and migration-history separation.
  const dataCall = calls[5];
  assert.deepEqual(
    dataCall.args.filter((a) => a === '--exclude'),
    ['--exclude', '--exclude'],
  );
  assert.ok(!dataCall.args.some((a) => a.includes('supabase_migrations')));
  assert.ok(calls[4].args.includes('--schema'));
  assert.ok(calls[4].args.includes('supabase_migrations'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: managed diff is streamed straight to managed-schema.sql', async () => {
  const root = tmpdir('bp-db-');
  const SUPABASE_BIN = makeSupabaseBin(root);
  const out = outDirFixture(root);
  const { run, calls } = captureRun();
  await runDumps({
    dbUrl: DB_URL,
    cwd: root,
    outDir: out,
    supabasePath: SUPABASE_BIN,
    dockerPath: fakeDocker(),
    run,
  });
  const managed = calls.find((c) => c.args.includes('--use-migra'));
  assert.ok(managed);
  assert.deepEqual(managed.stdout, { file: path.join(out, 'managed-schema.sql') });
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: commands run sequentially in the documented order', async () => {
  const root = tmpdir('bp-db-');
  const out = outDirFixture(root);
  const SUPABASE_BIN = makeSupabaseBin(root);
  const order = [];
  async function run(opts) {
    if (opts.args[0] === '--version') return { stdout: '2.114.0\n' };
    order.push(opts.args[1]); // subcommand: dump|diff
    return { stdout: null };
  }
  await runDumps({
    dbUrl: DB_URL,
    cwd: root,
    outDir: out,
    supabasePath: SUPABASE_BIN,
    dockerPath: fakeDocker(),
    run,
  });
  assert.deepEqual(order, ['dump', 'dump', 'diff', 'dump', 'dump', 'dump']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: first failure prevents later commands', async () => {
  const root = tmpdir('bp-db-');
  const out = outDirFixture(root);
  const SUPABASE_BIN = makeSupabaseBin(root);
  const calls = [];
  async function run(opts) {
    if (opts.args[0] === '--version') return { stdout: '2.114.0\n' };
    calls.push(opts.args[1] ?? opts.args[0]);
    if (opts.args[1] === 'diff') throw new Error('diff exploded');
    return { stdout: null };
  }
  await assert.rejects(
    () =>
      runDumps({
        dbUrl: DB_URL,
        cwd: root,
        outDir: out,
        supabasePath: SUPABASE_BIN,
        dockerPath: fakeDocker(),
        run,
      }),
    /diff exploded/,
  );
  assert.deepEqual(calls, ['dump', 'dump', 'diff']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: version preflight runs before any dump and must match the pin', async () => {
  const root = tmpdir('bp-db-');
  const out = outDirFixture(root);
  const SUPABASE_BIN = makeSupabaseBin(root);
  const calls = [];
  async function run(opts) {
    calls.push(opts);
    return { stdout: '2.113.9\n' };
  }
  await assert.rejects(
    () =>
      runDumps({
        dbUrl: DB_URL,
        cwd: root,
        outDir: out,
        supabasePath: SUPABASE_BIN,
        dockerPath: fakeDocker(),
        run,
      }),
    /2\.114\.0/,
  );
  assert.ok(calls.length === 1);
  assert.ok(calls[0].args.includes('--version'));
  assert.ok(!calls[0].secretArgs || calls[0].secretArgs.length === 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: docker and cli preflight fail before dumping', async () => {
  const root0 = tmpdir('bp-db-');
  const BIN0 = makeSupabaseBin(root0);
  await assert.rejects(
    () =>
      preflightSupabase({
        dockerPath: '/definitely/missing/docker',
        supabasePath: BIN0,
        run: captureRun().run,
      }),
    /docker/i,
  );
  fs.rmSync(root0, { recursive: true, force: true });
  const root = tmpdir('bp-db-');
  const out = outDirFixture(root);
  await assert.rejects(
    () =>
      dumpDatabase({
        dbUrl: DB_URL,
        cwd: root,
        outDir: out,
        supabasePath: '/missing/supabase',
        dockerPath: fakeDocker(),
        run: captureRun().run,
      }),
    /supabase/i,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: buildDumpCommands is a pure builder with exact shape', () => {
  const out = '/tmp/out';
  const commands = buildDumpCommands({ dbUrl: DB_URL, outDir: out });
  assert.equal(commands.length, 6);
  for (const c of commands) {
    assert.ok(Array.isArray(c.args));
    assert.ok(Array.isArray(c.secretArgs));
    assert.ok(c.secretArgs.includes(DB_URL));
    assert.ok(c.args.includes(DB_URL));
    assert.ok(!c.args.some((a) => a.includes('the-password') && !a.includes('@')));
  }
  const names = commands.map((c) => c.name);
  assert.deepEqual(names, [
    'roles',
    'schema',
    'managed',
    'migrationHistorySchema',
    'migrationHistoryData',
    'databaseData',
  ]);
  assert.deepEqual(
    commands.map((c) => c.label),
    [
      'roles',
      'database schema',
      'managed auth/storage schema',
      'migration-history schema',
      'migration-history data',
      'database data',
    ],
    'every command must carry its fixed human-readable progress label',
  );
});

test('database: dump outputs must be regular private files inside the out dir', async () => {
  const root = tmpdir('bp-db-');
  const out = outDirFixture(root);
  const contents = {
    'roles.sql': 'CREATE ROLE x;\n',
    'schema.sql': 'CREATE TABLE t();\n',
    'managed-schema.sql': '',
    'migration-history-schema.sql':
      'CREATE TABLE supabase_migrations.schema_migrations (x text);\n',
    'migration-history-data.sql': 'COPY ...;\n',
    'database-data.sql': 'COPY ...;\n',
  };
  for (const [name, content] of Object.entries(contents)) {
    writePrivateFile(path.join(out, name), content);
  }

  // Valid fixture passes and normalizes modes.
  const ok = validateDumpOutputs(out);
  assert.equal(Object.keys(ok.files).length, 6);
  assert.equal(ok.managedSchemaEmpty, true);

  // Missing file fails.
  fs.rmSync(path.join(out, 'roles.sql'));
  assert.throws(() => validateDumpOutputs(out), /roles\.sql/);

  // Empty non-managed file fails.
  writePrivateFile(path.join(out, 'roles.sql'), '');
  assert.throws(() => validateDumpOutputs(out), /roles\.sql/);

  // Symlinked output fails.
  fs.rmSync(path.join(out, 'roles.sql'));
  fs.symlinkSync('/etc/hosts', path.join(out, 'roles.sql'));
  assert.throws(() => validateDumpOutputs(out), /roles\.sql/);

  // Unknown extra files fail.
  fs.rmSync(path.join(out, 'roles.sql'));
  writePrivateFile(path.join(out, 'roles.sql'), 'CREATE ROLE x;\n');
  writePrivateFile(path.join(out, 'surprise.sql'), 'x');
  assert.throws(() => validateDumpOutputs(out), /surprise\.sql/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('database: errors never contain the supplied URL or password', async () => {
  const root = tmpdir('bp-db-');
  const SUPABASE_BIN = makeSupabaseBin(root);
  const out = outDirFixture(root);
  async function run(opts) {
    const err = new Error(`failed near ${DB_URL}`);
    err.name = 'ProcessError';
    err.stderrTail = `supabase error: could not connect to ${DB_URL} password=the-password`;
    err.redactedArgs = opts.args.map(() => '***');
    throw err;
  }
  await assert.rejects(
    () =>
      runDumps({
        dbUrl: DB_URL,
        cwd: root,
        outDir: out,
        supabasePath: SUPABASE_BIN,
        dockerPath: fakeDocker(),
        run,
      }),
    (err) => {
      const text = `${err.message} ${err.stderrTail ?? ''}`;
      assert.ok(!text.includes('a1b2c3d4e5f6a7b8c9d0'), 'project ref leaked');
      assert.ok(!text.includes('the-password'), 'password leaked');
      assert.ok(!text.includes('pooler.supabase.com'), 'host leaked');
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: runDumps reports preflight and every dump success in exact order', async () => {
  const root = tmpdir('bp-db-');
  const SUPABASE_BIN = makeSupabaseBin(root);
  const out = outDirFixture(root);
  const progress = [];
  const { run } = captureRun();
  await runDumps({
    dbUrl: DB_URL,
    cwd: root,
    outDir: out,
    supabasePath: SUPABASE_BIN,
    dockerPath: fakeDocker(),
    run,
    onProgress: (message) => progress.push(message),
  });
  assert.deepEqual(progress, [
    'starting Supabase CLI/Docker preflight',
    'completed Supabase CLI/Docker preflight',
    'starting logical dump 1/6: roles',
    'completed logical dump 1/6: roles',
    'starting logical dump 2/6: database schema',
    'completed logical dump 2/6: database schema',
    'starting logical dump 3/6: managed auth/storage schema',
    'completed logical dump 3/6: managed auth/storage schema',
    'starting logical dump 4/6: migration-history schema',
    'completed logical dump 4/6: migration-history schema',
    'starting logical dump 5/6: migration-history data',
    'completed logical dump 5/6: migration-history data',
    'starting logical dump 6/6: database data',
    'completed logical dump 6/6: database data',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: failed command leaves its start unmatched and blocks later commands', async () => {
  const root = tmpdir('bp-db-');
  const SUPABASE_BIN = makeSupabaseBin(root);
  const out = outDirFixture(root);
  const progress = [];
  const calls = [];
  async function run(opts) {
    if (opts.args[0] === '--version') return { stdout: '2.114.0\n' };
    calls.push(opts.args[1] ?? opts.args[0]);
    if (opts.args[1] === 'diff') {
      const err = new Error(`failed near ${DB_URL}`);
      err.name = 'ProcessError';
      err.stderrTail = `supabase error: password=the-password at ${DB_URL}`;
      err.redactedArgs = opts.args.map(() => '***');
      throw err;
    }
    return { stdout: null };
  }
  await assert.rejects(
    () =>
      runDumps({
        dbUrl: DB_URL,
        cwd: root,
        outDir: out,
        supabasePath: SUPABASE_BIN,
        dockerPath: fakeDocker(),
        run,
        onProgress: (message) => progress.push(message),
      }),
    (err) => {
      const text = `${err.message} ${err.stderrTail ?? ''}`;
      assert.ok(!text.includes('a1b2c3d4e5f6a7b8c9d0'), 'project ref leaked');
      assert.ok(!text.includes('the-password'), 'password leaked');
      return true;
    },
  );
  assert.deepEqual(calls, ['dump', 'dump', 'diff']);
  assert.ok(progress.includes('starting logical dump 3/6: managed auth/storage schema'));
  assert.ok(!progress.includes('completed logical dump 3/6: managed auth/storage schema'));
  assert.ok(!progress.some((m) => m.includes('migration-history') || m.includes('database data')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: dumpDatabase reports validation immediately after dump completion', async () => {
  const root = tmpdir('bp-db-');
  const SUPABASE_BIN = makeSupabaseBin(root);
  const out = outDirFixture(root);
  const contents = {
    'roles.sql': 'CREATE ROLE x;\n',
    'schema.sql': 'CREATE TABLE t();\n',
    'managed-schema.sql': '',
    'migration-history-schema.sql':
      'CREATE TABLE supabase_migrations.schema_migrations (x text);\n',
    'migration-history-data.sql': 'COPY ...;\n',
    'database-data.sql': 'COPY ...;\n',
  };
  async function run(opts) {
    if (opts.args.includes('--version')) return { stdout: '2.114.0\n' };
    const fileIdx = opts.args.indexOf('--file');
    if (fileIdx !== -1) {
      const file = opts.args[fileIdx + 1];
      writePrivateFile(file, contents[path.basename(file)] ?? '');
    }
    if (opts.args.includes('--use-migra') && opts.stdout?.file) {
      writePrivateFile(opts.stdout.file, '-- managed diff output\n');
    }
    return { stdout: null };
  }
  const progress = [];
  const result = await dumpDatabase({
    dbUrl: DB_URL,
    cwd: root,
    outDir: out,
    supabasePath: SUPABASE_BIN,
    dockerPath: fakeDocker(),
    run,
    onProgress: (message) => progress.push(message),
  });
  assert.equal(result.cliVersion, '2.114.0');
  const completeIndex = progress.indexOf('completed logical dump 6/6: database data');
  assert.ok(completeIndex !== -1);
  assert.deepEqual(progress.slice(completeIndex + 1), [
    'starting dump output validation',
    'completed dump output validation',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('database: dumpDatabase assembles and validates the full result', async () => {
  const root = tmpdir('bp-db-');
  const SUPABASE_BIN = makeSupabaseBin(root);
  const out = outDirFixture(root);
  const contents = {
    'roles.sql': 'CREATE ROLE x;\n',
    'schema.sql': 'CREATE TABLE t();\n',
    'managed-schema.sql': '',
    'migration-history-schema.sql':
      'CREATE TABLE supabase_migrations.schema_migrations (x text);\n',
    'migration-history-data.sql': 'COPY ...;\n',
    'database-data.sql': 'COPY ...;\n',
  };
  async function run(opts) {
    if (opts.args.includes('--version')) return { stdout: '2.114.0\n' };
    const fileIdx = opts.args.indexOf('--file');
    if (fileIdx !== -1) {
      const file = opts.args[fileIdx + 1];
      writePrivateFile(file, contents[path.basename(file)] ?? '');
    }
    if (opts.args.includes('--use-migra') && opts.stdout?.file) {
      writePrivateFile(opts.stdout.file, '-- managed diff output\n');
    }
    return { stdout: null };
  }
  const result = await dumpDatabase({
    dbUrl: DB_URL,
    cwd: root,
    outDir: out,
    supabasePath: SUPABASE_BIN,
    dockerPath: fakeDocker(),
    run,
  });
  assert.equal(result.cliVersion, '2.114.0');
  assert.equal(result.postgresMajorVersion, 17);
  assert.equal(fileMode(result.files.databaseData), 0o600);
  assert.ok(path.dirname(result.files.databaseData) === out);
  fs.rmSync(root, { recursive: true, force: true });
});
