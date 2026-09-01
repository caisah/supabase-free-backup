/**
 * `backup:local` orchestration and CLI tests.
 *
 * Heavy adapters are injected; the package step runs the REAL
 * `packageSnapshot` with the deterministic age stand-in, and the store,
 * validation, and scan use their real implementations against disposable
 * repository roots. One full real-run test proves the retained package
 * passes complete validation (schema, sizes, hashes, expectations).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runBackupLocal } from './backup-local.js';
import { validatePackagedDirectory, packageSnapshot } from '../src/snapshot.js';
import { resolveBackupExecutables } from '../src/backup.js';
import {
  assertLocalStackRunning,
  openLocalBackupStore,
  finalizeLocalBackup,
} from '../src/local-backup.js';
import { createLogger } from '../src/logger.js';
import {
  LOCAL_STACK_ENVIRONMENT,
  LOCAL_STORE_ENVIRONMENT,
  REPOSITORY_ROOT,
} from '../src/config.js';
import { tmpdir, writePrivateFile } from '../src/test-fixtures.js';

const REPO_ROOT = REPOSITORY_ROOT;

const REF = 'a1b2c3d4e5f6a7b8c9d0';
const REF_PROD = 'f0e9d8c7b6a5f4e3d2c1';
const PORT = 54322;
const LOCAL_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const ID1 = '2026-08-24T03-17-09Z';
const ID2 = '2026-08-24T03-17-11Z';
const T1 = new Date('2026-08-24T03:17:09Z');
const T2 = new Date('2026-08-24T03:17:11Z');

const SIX = [
  'roles.sql',
  'schema.sql',
  'managed-schema.sql',
  'migration-history-schema.sql',
  'migration-history-data.sql',
  'database-data.sql',
];

const EXECUTABLES = {
  supabasePath: '/fake/supabase',
  dockerPath: '/fake/docker',
};
const PROJECT_STACK = {
  workdir: '/workdir/project',
  dbPort: PORT,
  dbContainer: 'supabase_db_project',
};

function runCli(args, env = {}) {
  const script = fileURLToPath(new URL('./backup-local.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
}

function captureLogger() {
  const chunks = [];
  const logger = createLogger({
    stream: { write: (c) => (chunks.push(String(c)), true) },
  });
  return { logger, text: () => chunks.join('') };
}

function silentLogger() {
  return {
    addSecret: () => {},
    status: () => {},
    warn: () => {},
    error: () => {},
    redact: (t) => t,
  };
}

/** Deterministic dump content; `seed` makes content change across runs. */
function dumpContent(seed = 'a') {
  return [
    `-- seed ${seed}`,
    'CREATE ROLE app;',
    'CREATE TABLE public.t (id int);',
    '-- managed',
    'CREATE TABLE supabase_migrations.schema_migrations (version text);',
    'COPY supabase_migrations.schema_migrations FROM stdin;',
    '1',
    '\\.',
    'COPY "public"."t" FROM stdin;',
    '42',
    '\\.',
  ].join('\n');
}

function makeRun({ calls } = {}) {
  const logged = calls ?? [];
  return async (opts) => {
    logged.push(opts);
    const base = path.basename(String(opts.command));
    if (base === 'age') {
      // Plaintext local backups never run age: this branch is an assertion
      // trap, not an executable path.
      throw new Error('age must never be invoked on the plaintext local path');
    }
    if (base === 'docker') {
      const joined = String(opts.args.join(' '));
      if (joined.includes('inspect')) return { stdout: 'true\n' };
      if (joined.includes('server_version_num')) return { stdout: '170006\n' };
      if (joined.includes('pg_stat_all_tables')) {
        return {
          stdout:
            '00000000000000000000000000000000|0123456789abcdef0123456789abcdef|11111111111111111111111111111111|22222222222222222222222222222222\n',
        };
      }
      return { stdout: '1\n' };
    }
    throw new Error(`unexpected command ${opts.command}`);
  };
}

function depsFor({ repoRoot: _repoRoot, runAt, seed = 'a', extra = {} } = {}) {
  const calls = { dump: [], run: [], validate: 0, finalize: 0 };
  const run = makeRun({ calls: calls.run });
  return {
    deps: {
      // The runner fixes config identity to the development dotenv; the stub
      // mirrors that with the LOCAL_STACK_ENVIRONMENT constant.
      loadConfig: () => ({
        environment: LOCAL_STACK_ENVIRONMENT,
        projectRef: REF,
        projectWorkdir: PROJECT_STACK.workdir,
      }),
      doValidateWorkdir: () => PROJECT_STACK,
      doResolveExecutables: () => EXECUTABLES,
      doAssertRunning: assertLocalStackRunning,
      doDump: async (opts) => {
        calls.dump.push(opts);
        for (const name of SIX)
          writePrivateFile(path.join(opts.outDir, name), `${dumpContent(seed)}\n`);
      },
      doPackage: undefined, // real packageSnapshot via the seam default
      doValidate: validatePackagedDirectory,
      doFinalize: (opts) => {
        calls.finalize += 1;
        return finalizeLocalBackup(opts);
      },
      run,
      now: () => new Date(runAt),
      ...extra,
    },
    calls,
    run,
  };
}

async function runOnce({
  repoRoot,
  runAt,
  seed = 'a',
  logger = silentLogger(),
  env = {},
  extra = {},
}) {
  const { deps, calls } = depsFor({ repoRoot, runAt, seed, extra });
  const result = await runBackupLocal({ env, repoRoot, logger, deps });
  return { result, calls };
}

function envDir(repoRoot, environment = LOCAL_STORE_ENVIRONMENT) {
  return path.join(repoRoot, 'local-backups', environment);
}

test('backup-local: first run creates a fully validated package at the fixed private path', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { result, calls } = await runOnce({ repoRoot, runAt: T1 });
  assert.equal(result.environment, LOCAL_STORE_ENVIRONMENT);
  assert.equal(result.changed, true);
  assert.equal(result.snapshotId, ID1);
  assert.equal(result.path, path.join(envDir(repoRoot), ID1));
  assert.equal(calls.dump.length, 1);
  // Full independent validation of the retained package.
  const { manifest } = await validatePackagedDirectory(result.path, {
    expectedEnvironment: LOCAL_STORE_ENVIRONMENT,
    expectedSnapshotId: ID1,
    expectedProjectRef: REF,
  });
  assert.equal(manifest.sourceProjectRef, REF);
  assert.deepEqual(manifest.encryption, { format: 'none' }, 'plaintext manifest, no recipient');
  assert.ok(
    manifest.dataParts.every((n) => n.startsWith('data.sql.gz.part-')),
    'plaintext part names',
  );
  assert.ok(
    manifest.files
      .filter((f) => f.name.startsWith('data.sql.gz.part-'))
      .every((f) => f.encrypted === false),
    'part entries are unencrypted',
  );
  assert.ok(
    !calls.run.some((c) => path.basename(String(c.command)) === 'age'),
    'no age command may run',
  );
  assert.equal(fs.statSync(envDir(repoRoot)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o700);
  assert.ok(!fs.readdirSync(result.path).includes('data.sql'), 'no plaintext row data retained');
  // Workspace cleaned; the empty published candidate parent may remain for
  // the next run's lock-time stale-candidate cleanup; the lock is released.
  const leftoverCandidates = fs
    .readdirSync(envDir(repoRoot))
    .filter((e) => e.startsWith('.candidate-'));
  assert.ok(leftoverCandidates.length <= 1, 'at most the empty published candidate parent remains');
  if (leftoverCandidates.length === 1) {
    assert.deepEqual(fs.readdirSync(path.join(envDir(repoRoot), leftoverCandidates[0])), []);
  }
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')));
  assert.ok(
    !fs.readdirSync(os.tmpdir()).some((e) => e.startsWith(`db-backup-${process.pid}-`)),
    'private OS workspace removed',
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: identical later run retains the first ID and path', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const first = await runOnce({ repoRoot, runAt: T1 });
  const second = await runOnce({ repoRoot, runAt: T2 });
  assert.equal(first.result.changed, true);
  assert.equal(second.result.changed, false);
  assert.equal(second.result.snapshotId, ID1, 'unchanged keeps the existing ID');
  assert.equal(second.result.path, first.result.path, 'unchanged keeps the existing path');
  assert.equal(second.calls.dump.length, 1, 'a dump still runs to detect changes');
  assert.deepEqual(fs.readdirSync(envDir(repoRoot)), [ID1]);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: changed content or target ref publishes a new snapshot and removes the old', async () => {
  for (const [label, change] of [
    ['content', { seed: 'b' }],
    ['targetRef', {}],
  ]) {
    const repoRoot = tmpdir('bp-bl-');
    let extra = {};
    if (label === 'targetRef') {
      extra = {
        loadConfig: ({ environment }) => ({
          environment,
          projectRef: REF_PROD,
          projectWorkdir: PROJECT_STACK.workdir,
        }),
      };
    }
    const first = await runOnce({ repoRoot, runAt: T1 });
    const second = await runOnce({ repoRoot, runAt: T2, seed: change.seed ?? 'a', extra });
    assert.equal(first.result.snapshotId, ID1, `${label}: baseline seeded`);
    assert.equal(second.result.changed, true, label);
    assert.equal(second.result.snapshotId, ID2, label);
    const { manifest } = await validatePackagedDirectory(second.result.path, {
      expectedEnvironment: LOCAL_STORE_ENVIRONMENT,
      expectedSnapshotId: ID2,
      expectedProjectRef: label === 'targetRef' ? REF_PROD : REF,
    });
    assert.deepEqual(manifest.encryption, { format: 'none' }, label);
    const entries = fs.readdirSync(envDir(repoRoot)).filter((e) => !e.startsWith('.candidate-'));
    assert.deepEqual(entries, [ID2], `${label}: old snapshot removed after publish`);
    assert.ok(!fs.existsSync(first.result.path), `${label}: baseline path was removed`);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('backup-local: dump cwd is the backup repository; source URL is only the workdir port', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { calls } = await runOnce({ repoRoot, runAt: T1 });
  assert.equal(calls.dump.length, 1);
  assert.equal(calls.dump[0].dbUrl, LOCAL_URL, 'source derives only from the local workdir port');
  assert.ok(!calls.dump[0].dbUrl.includes('pooler.supabase.com'));
  assert.ok(!calls.dump[0].dbUrl.includes('.supabase.co'));
  assert.equal(calls.dump[0].cwd, repoRoot, 'dump runs with the backup repo as cwd');
  assert.notEqual(repoRoot, PROJECT_STACK.workdir, 'never the sibling workdir');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: no stack lifecycle command and no R2/credential access', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { calls } = await runOnce({ repoRoot, runAt: T1 });
  assert.ok(calls.run.length >= 1);
  for (const call of calls.run) {
    const base = path.basename(String(call.command));
    assert.notEqual(base, 'supabase', 'local backup never runs the Supabase CLI');
    if (base === 'docker') {
      if (call.args[0] === 'exec') {
        assert.deepEqual(call.args.slice(0, 2), ['exec', PROJECT_STACK.dbContainer]);
      } else if (call.args[0] === 'inspect') {
        assert.ok(
          call.args.includes('{{.State.Running}}') && call.args.includes(PROJECT_STACK.dbContainer),
          'container probe targets the derived container',
        );
      }
      for (const forbidden of ['start', 'stop', 'reset', 'migrate']) {
        assert.ok(!call.args.includes(forbidden), `no lifecycle command ${forbidden}`);
      }
    }
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: always targets the single local store regardless of config', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { result } = await runOnce({ repoRoot, runAt: T1 });
  assert.equal(result.environment, LOCAL_STORE_ENVIRONMENT);
  assert.equal(path.basename(path.dirname(result.path)), LOCAL_STORE_ENVIRONMENT);
  // lock is the fixed local-store lock
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')));
  assert.deepEqual(
    fs.readdirSync(envDir(repoRoot)).filter((e) => !e.startsWith('.candidate-')),
    [ID1],
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: source mutation during the six dumps rejects the candidate', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const first = await runOnce({ repoRoot, runAt: T1 });
  const states = [
    '00000000000000000000000000000000|0123456789abcdef0123456789abcdef|11111111111111111111111111111111|22222222222222222222222222222222',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|fedcba9876543210fedcba9876543210|33333333333333333333333333333333|44444444444444444444444444444444',
  ];
  let packaged = false;

  await assert.rejects(
    () =>
      runOnce({
        repoRoot,
        runAt: T2,
        seed: 'b',
        extra: {
          readSourceState: async () => states.shift(),
          doPackage: async () => {
            packaged = true;
            throw new Error('package must not run for a mixed-state dump');
          },
        },
      }),
    (err) => err instanceof Error && /changed while the backup was being dumped/.test(err.message),
  );

  assert.equal(packaged, false, 'mutation is rejected before packaging');
  assert.ok(fs.existsSync(first.result.path), 'the previous completed snapshot remains');
  assert.deepEqual(
    fs.readdirSync(envDir(repoRoot)).filter((entry) => !entry.startsWith('.candidate-')),
    [ID1],
  );
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: dump/package/validation/publication failures preserve the old snapshot', async () => {
  const breaks = [
    [
      'dump',
      {
        doDump: async () => {
          throw new Error('dump exploded');
        },
      },
      /dump exploded/,
    ],
    [
      'package',
      {
        doPackage: async () => {
          throw new Error('package exploded');
        },
      },
      /package exploded/,
    ],
    [
      'validation',
      {
        doValidate: async () => {
          throw new Error('validation exploded');
        },
      },
      /validation exploded/,
    ],
    [
      'publication',
      {
        doFinalize: async () => {
          throw new Error('publish exploded');
        },
      },
      /publish exploded/,
    ],
  ];
  for (const [label, breakDeps, pattern] of breaks) {
    const repoRoot = tmpdir('bp-bl-');
    const first = await runOnce({ repoRoot, runAt: T1 });
    await assert.rejects(
      () => runOnce({ repoRoot, runAt: T2, seed: 'b', extra: breakDeps }),
      pattern,
    );
    const entries = fs.readdirSync(envDir(repoRoot)).filter((e) => !e.startsWith('.candidate-'));
    assert.deepEqual(
      entries,
      [first.result.snapshotId],
      `${label}: old snapshot preserved on failure`,
    );
    assert.ok(
      !fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')),
      `${label}: lock released`,
    );
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('backup-local: workspaces, unpublished candidates, and locks clean up on an early failure', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith(`db-backup-${process.pid}-`));
  await assert.rejects(
    () =>
      runOnce({
        repoRoot,
        runAt: T1,
        extra: {
          doDump: async () => {
            throw new Error('dump exploded');
          },
        },
      }),
    /dump exploded/,
  );
  const after = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith(`db-backup-${process.pid}-`));
  assert.deepEqual(after, before, 'private OS workspace removed after failure');
  assert.ok(
    !fs.readdirSync(envDir(repoRoot)).some((e) => e.startsWith('.candidate-')),
    'unpublished candidate removed after failure',
  );
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: cleanup failures never prevent lock release', async () => {
  const repoRoot = tmpdir('bp-bl-');
  let releases = 0;
  await assert.rejects(
    () =>
      runOnce({
        repoRoot,
        runAt: T1,
        extra: {
          doOpenStore: (opts) => {
            const store = openLocalBackupStore(opts);
            return {
              ...store,
              release: () => {
                releases += 1;
                return store.release();
              },
            };
          },
          removeWorkspace: () => {
            throw new Error('workspace cleanup exploded');
          },
        },
      }),
    /workspace cleanup exploded/,
  );
  assert.equal(releases, 1);
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: a release failure is retained without hiding the primary error', async () => {
  const repoRoot = tmpdir('bp-bl-');
  await assert.rejects(
    () =>
      runOnce({
        repoRoot,
        runAt: T1,
        extra: {
          doOpenStore: (opts) => {
            const store = openLocalBackupStore(opts);
            return {
              ...store,
              release: () => {
                store.release();
                throw new Error('release exploded');
              },
            };
          },
          doDump: async () => {
            throw new Error('dump exploded first');
          },
        },
      }),
    (err) => {
      assert.ok(err instanceof AggregateError);
      assert.match(err.message, /dump exploded first/);
      assert.ok(!/release exploded/.test(err.message), 'message stays short; detail in .errors');
      assert.match(err.message, /cleanup also failed/);
      assert.equal(err.errors[0].message, 'dump exploded first');
      assert.ok(err.errors.some((failure) => /release exploded/.test(failure.message)));
      return true;
    },
  );
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: logs reveal only environment, state, ID, and path', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { logger, text } = captureLogger();
  await runOnce({ repoRoot, runAt: T1, logger });
  const log = text();
  assert.ok(log.includes('backup:local: created snapshot'), 'status line is logged');
  assert.ok(log.includes(ID1), 'retained snapshot id is logged');
  for (const secret of [
    LOCAL_URL,
    'postgres:postgres',
    REF,
    'CREATE ROLE',
    '42',
    'formatVersion',
    'contentSha256',
  ]) {
    assert.ok(!log.includes(secret), `log leaked: ${secret}`);
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: --help prints usage and exits zero without external work', () => {
  const clean = { PATH: process.env.PATH, HOME: os.homedir() };
  for (const flag of ['--help', '-h']) {
    const res = runCli([flag], clean);
    assert.equal(res.status, 0, flag);
    assert.ok(res.stdout.includes('usage: vp run backup:local'), flag);
    assert.equal(res.stderr, '', `${flag}: no configuration or external error output`);
  }
});

test('backup-local: the snapshot id is derived only after the store lock is held', async () => {
  // The id is captured at RUN start (inside the exclusive store lock), not
  // at CLI entry: with the lock serializing runs, two serialized full runs
  // would have to finish inside the same wall-clock second to collide, and
  // the canonical second-resolution id then still reflects the actual run.
  const repoRoot = tmpdir('bp-bl-');
  const order = [];
  let runAtOf = T1;
  const { deps } = depsFor({
    repoRoot,
    runAt: T1,
    extra: {
      now: () => {
        order.push('now');
        return new Date(runAtOf);
      },
      doOpenStore: (opts) => {
        order.push('open');
        return openLocalBackupStore(opts);
      },
    },
  });
  const result = await runBackupLocal({ env: {}, repoRoot, logger: silentLogger(), deps });
  assert.equal(result.snapshotId, ID1);
  assert.deepEqual(
    order.slice(0, 2),
    ['open', 'now'],
    'the id must be captured after the store lock is acquired',
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: malformed CLI exits nonzero before external work', () => {
  for (const args of [
    ['--bogus'],
    ['--environment'],
    ['--environment', 'development'],
    ['--environment', 'staging'],
    ['--environment', 'development', 'extra'],
    ['--', '--environment', 'development'],
  ]) {
    const res = runCli(args, { PATH: process.env.PATH });
    assert.notEqual(res.status, 0, `expected nonzero exit for ${JSON.stringify(args)}`);
  }
});

test('backup-local: bare invocation is grammar-safe and never touches the real local store', () => {
  // The real `.env.development.local` satisfies config on a developer machine,
  // so a bare CLI spawn with a clean env would execute the REAL dump/package/
  // retention cycle (docker + Supabase CLI + the local store) from a unit
  // test. Force a deterministic BACKUP_ENVIRONMENT mismatch instead: when the
  // dotenv file exists (developer machine) the process value conflicts with
  // it, and when it is absent (CI) the value is simply invalid. Either way
  // the CLI must fail fast at the config gate, report the problem (names
  // only), and never run external work or mutate the developer's store.
  const storeDir = path.join(REPO_ROOT, 'local-backups', LOCAL_STORE_ENVIRONMENT);
  const before = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
  const res = runCli([], { PATH: process.env.PATH, BACKUP_ENVIRONMENT: 'staging' });
  assert.notEqual(res.status, 0, 'config gate must fail under the mismatched env');
  assert.ok(!res.stderr.includes('requires'), 'grammar accepted the bare invocation');
  assert.match(res.stderr, /Backup configuration error/, 'config gate is the failure point');
  assert.match(
    res.stderr,
    /(CONFLICT|INVALID) BACKUP_ENVIRONMENT/,
    'the gate failure must name BACKUP_ENVIRONMENT',
  );
  assert.ok(!res.stderr.includes('created snapshot'), 'no backup run may be reported');
  const after = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
  assert.deepEqual(after, before, 'a unit test must never publish into the real store');
});

test('backup-local: no age executable is resolved', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const packageOpts = [];
  const { deps } = depsFor({
    repoRoot,
    runAt: T1,
    extra: {
      doResolveExecutables: (opts) => resolveBackupExecutables(opts),
      lookup: (name) => {
        if (name === 'age' || name === 'age.exe') throw new Error('age must not be resolved');
        if (name === 'docker') return '/bin/docker';
        return null;
      },
      locateCli: () => '/fake/supabase',
      doPackage: async (opts) => {
        packageOpts.push(opts);
        return packageSnapshot(opts);
      },
    },
  });
  const result = await runBackupLocal({ env: {}, repoRoot, logger: silentLogger(), deps });
  assert.equal(result.changed, true);
  assert.equal(packageOpts.length, 1);
  assert.equal(packageOpts[0].format, 'none', 'dump/package options carry the plaintext codec');
  assert.equal(packageOpts[0].agePath, undefined);
  const { manifest } = await validatePackagedDirectory(result.path, {
    expectedEnvironment: LOCAL_STORE_ENVIRONMENT,
    expectedSnapshotId: ID1,
    expectedProjectRef: REF,
  });
  assert.deepEqual(manifest.encryption, { format: 'none' });
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-local')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: the whole local path never references R2 operations or credentials', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const relative of ['scripts/backup-local.js', 'src/local-backup.js', 'src/backup.js']) {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.ok(
      !source.includes("'./r2.js'") && !source.includes("'../src/r2.js'"),
      `${relative} must not import r2.js`,
    );
    for (const token of [
      'createS3Adapter',
      'headBucket',
      'uploadSnapshot',
      'deletePrefix',
      'R2_ACCESS',
      'R2_SECRET',
    ]) {
      assert.ok(!source.includes(token), `${relative} must not reference ${token}`);
    }
  }
});
