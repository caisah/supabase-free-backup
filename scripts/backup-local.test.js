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
import { BACKUP_WORKSPACE_PREFIX } from '../src/backup.js';
import { validatePackagedDirectory } from '../src/snapshot.js';
import {
  assertLocalStackRunning,
  openLocalBackupStore,
  finalizeLocalBackup,
  LocalBackupError,
} from '../src/local-backup.js';
import { createLogger } from '../src/logger.js';
import {
  tmpdir,
  writePrivateFile,
  AGE_RECIPIENT_1,
  AGE_RECIPIENT_2,
  fakeAge,
} from '../src/test-fixtures.js';

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
  ageBin: '/fake/age',
  supabasePath: '/fake/supabase',
  dockerPath: '/fake/docker',
};
const LOCAL_PROJECT = {
  workdir: '/workdir/example-project',
  dbPort: PORT,
  dbContainer: 'supabase_db_example-project',
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

function makeRun({ calls, ageFail = false } = {}) {
  const logged = calls ?? [];
  return async (opts) => {
    logged.push(opts);
    const base = path.basename(String(opts.command));
    if (base === 'age') {
      if (ageFail) throw new Error('age exploded');
      return fakeAge(opts);
    }
    if (base === 'docker') {
      // `docker port <container> <port>/tcp` publication mapping.
      if (String(opts.args[0]) === 'port') {
        return { stdout: `0.0.0.0:${PORT}\n[::]:${PORT}\n` };
      }
      const query = String(opts.args.at(-1));
      if (query.includes('pg_stat_all_tables')) {
        return {
          stdout:
            '00000000000000000000000000000000|0123456789abcdef0123456789abcdef|11111111111111111111111111111111|22222222222222222222222222222222\n',
        };
      }
      if (query.includes('pg_locks')) {
        return { stdout: 't\n' }; // barrier already granted
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
      loadConfig: ({ environment }) => ({
        environment,
        projectRef: environment === 'production' ? REF_PROD : REF,
        ageRecipient: AGE_RECIPIENT_1,
        projectWorkdir: LOCAL_PROJECT.workdir,
      }),
      doValidateWorkdir: () => LOCAL_PROJECT,
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
  const result = await runBackupLocal({
    options: { environment: 'development' },
    env,
    repoRoot,
    logger,
    deps,
  });
  return { result, calls };
}

function envDir(repoRoot, environment = 'development') {
  return path.join(repoRoot, 'local-backups', environment);
}

test('backup-local: first run creates a fully validated package at the fixed private path', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { result, calls } = await runOnce({ repoRoot, runAt: T1 });
  assert.equal(result.environment, 'development');
  assert.equal(result.changed, true);
  assert.equal(result.snapshotId, ID1);
  assert.equal(result.path, path.join(envDir(repoRoot), ID1));
  assert.equal(calls.dump.length, 1);
  // Full independent validation of the retained package.
  const { manifest } = await validatePackagedDirectory(result.path, {
    expectedEnvironment: 'development',
    expectedSnapshotId: ID1,
    expectedProjectRef: REF,
  });
  assert.equal(manifest.sourceProjectRef, REF);
  assert.equal(manifest.encryption.recipient, AGE_RECIPIENT_1);
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
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')));
  assert.ok(
    !fs
      .readdirSync(os.tmpdir())
      .some((e) => e.startsWith(`${BACKUP_WORKSPACE_PREFIX}${process.pid}-`)),
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

test('backup-local: changed content, recipient, or target ref publishes a new snapshot and removes the old', async () => {
  for (const [label, change] of [
    ['content', { seed: 'b' }],
    ['recipient', {}],
    ['targetRef', {}],
  ]) {
    const repoRoot = tmpdir('bp-bl-');
    let extra = {};
    if (label === 'recipient') {
      extra = {
        loadConfig: ({ environment }) => ({
          environment,
          projectRef: REF,
          ageRecipient: AGE_RECIPIENT_2,
          projectWorkdir: LOCAL_PROJECT.workdir,
        }),
      };
    }
    if (label === 'targetRef') {
      extra = {
        loadConfig: ({ environment }) => ({
          environment,
          projectRef: REF_PROD,
          ageRecipient: AGE_RECIPIENT_1,
          projectWorkdir: LOCAL_PROJECT.workdir,
        }),
      };
    }
    const first = await runOnce({ repoRoot, runAt: T1 });
    const second = await runOnce({ repoRoot, runAt: T2, seed: change.seed ?? 'a', extra });
    assert.equal(first.result.snapshotId, ID1, `${label}: baseline seeded`);
    assert.equal(second.result.changed, true, label);
    assert.equal(second.result.snapshotId, ID2, label);
    const { manifest } = await validatePackagedDirectory(second.result.path, {
      expectedEnvironment: 'development',
      expectedSnapshotId: ID2,
      expectedProjectRef: label === 'targetRef' ? REF_PROD : REF,
    });
    assert.equal(
      manifest.encryption.recipient,
      label === 'recipient' ? AGE_RECIPIENT_2 : AGE_RECIPIENT_1,
      label,
    );
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
  assert.notEqual(repoRoot, LOCAL_PROJECT.workdir, 'never the sibling workdir');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: container-to-host port identity is verified before any probe or dump', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { calls } = await runOnce({ repoRoot, runAt: T1 });
  const indexOf = (predicate) => calls.run.findIndex(predicate);
  const portIdx = indexOf((c) => c.args[0] === 'port');
  const stateIdx = indexOf((c) => String(c.args.at(-1)).includes('pg_stat_all_tables'));
  const holderIdx = indexOf((c) => c.args[0] === 'exec' && c.args.includes('-i'));
  assert.ok(portIdx !== -1, '`docker port` identity check must run');
  assert.ok(portIdx < stateIdx, 'port identity must be proven before the state probe');
  assert.ok(portIdx < holderIdx, 'port identity must be proven before the write barrier');
  assert.deepEqual(
    calls.run[portIdx].args,
    ['port', LOCAL_PROJECT.dbContainer, `${PORT}/tcp`],
    'the check must ask exactly for the config.toml port of the derived container',
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: the source is write-barriered across the whole dump window', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const events = [];
  await runOnce({
    repoRoot,
    runAt: T1,
    extra: {
      doAcquireBarrier: async ({ dbContainer }) => {
        events.push(`acquire:${dbContainer}`);
        return {
          release: async () => {
            events.push('release');
          },
        };
      },
      doReleaseBarrier: async (barrier) => barrier.release(),
      doDump: async (opts) => {
        events.push('dump');
        for (const name of SIX)
          writePrivateFile(path.join(opts.outDir, name), `${dumpContent('a')}\n`);
      },
    },
  });
  assert.equal(events[0], `acquire:${LOCAL_PROJECT.dbContainer}`);
  assert.equal(events[1], 'dump');
  assert.equal(events[2], 'release');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: an unpublishable config port aborts before any probe or dump', async () => {
  const repoRoot = tmpdir('bp-bl-');
  let dumpRan = false;
  await assert.rejects(
    () =>
      runOnce({
        repoRoot,
        runAt: T1,
        extra: {
          doAssertPortPublished: async () => {
            throw new LocalBackupError(
              'the local database port from supabase/config.toml is not published by the derived container',
              { stage: 'connect' },
            );
          },
          doDump: async () => {
            dumpRan = true;
          },
        },
      }),
    (err) => err instanceof LocalBackupError && /not published/.test(err.message),
  );
  assert.equal(dumpRan, false, 'no dump may run when the source identity is unproven');
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: a broken barrier fails the run before any snapshot is published', async () => {
  const repoRoot = tmpdir('bp-bl-');
  await assert.rejects(
    () =>
      runOnce({
        repoRoot,
        runAt: T1,
        extra: {
          doAcquireBarrier: async () => {
            throw new LocalBackupError(
              'cannot establish the local database write barrier; no snapshot was published',
              { stage: 'consistency' },
            );
          },
        },
      }),
    /cannot establish the local database write barrier/,
  );
  const entries = fs.readdirSync(envDir(repoRoot)).filter((e) => !e.startsWith('.candidate-'));
  assert.deepEqual(entries, [], 'no snapshot may be published without the barrier');
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: no stack lifecycle command and no R2/credential access', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { calls } = await runOnce({ repoRoot, runAt: T1 });
  assert.ok(calls.run.length >= 1);
  for (const call of calls.run) {
    const base = path.basename(String(call.command));
    assert.notEqual(base, 'supabase', 'local backup never runs the Supabase CLI');
    if (base === 'docker' && call.args[0] === 'exec') {
      // `docker exec <container> ...` and the holder `docker exec -i <container> ...`
      const container = call.args[1] === '-i' ? call.args[2] : call.args[1];
      assert.equal(
        container,
        LOCAL_PROJECT.dbContainer,
        'every exec targets the derived container',
      );
      for (const forbidden of ['start', 'stop', 'reset', 'migrate']) {
        assert.ok(!call.args.includes(forbidden), `no lifecycle command ${forbidden}`);
      }
    }
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: target environments write to isolated destinations', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const dev = await runOnce({ repoRoot, runAt: T1 });
  const prodDeps = depsFor({ repoRoot, runAt: T2 });
  const deployed = await runBackupLocal({
    options: { environment: 'production' },
    env: {},
    repoRoot,
    logger: silentLogger(),
    deps: prodDeps.deps,
  });
  assert.equal(deployed.changed, true);
  assert.equal(deployed.environment, 'production');
  assert.equal(deployed.path, path.join(envDir(repoRoot, 'production'), ID2));
  assert.deepEqual(
    fs.readdirSync(envDir(repoRoot)).filter((e) => !e.startsWith('.candidate-')),
    [dev.result.snapshotId],
  );
  assert.deepEqual(
    fs.readdirSync(envDir(repoRoot, 'production')).filter((e) => !e.startsWith('.candidate-')),
    [ID2],
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
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')));
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
      !fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')),
      `${label}: lock released`,
    );
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('backup-local: workspaces, unpublished candidates, and locks clean up on an early failure', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith(`${BACKUP_WORKSPACE_PREFIX}${process.pid}-`));
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
    .filter((n) => n.startsWith(`${BACKUP_WORKSPACE_PREFIX}${process.pid}-`));
  assert.deepEqual(after, before, 'private OS workspace removed after failure');
  assert.ok(
    !fs.readdirSync(envDir(repoRoot)).some((e) => e.startsWith('.candidate-')),
    'unpublished candidate removed after failure',
  );
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')));
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
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')));
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
      assert.match(err.message, /release exploded/);
      assert.match(err.errors[0].message, /dump exploded first/);
      assert.ok(err.errors.some((failure) => /release exploded/.test(failure.message)));
      return true;
    },
  );
  assert.ok(!fs.existsSync(path.join(repoRoot, 'local-backups', '.lock-development')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('backup-local: logs reveal only environment, state, ID, and path', async () => {
  const repoRoot = tmpdir('bp-bl-');
  const { logger, text } = captureLogger();
  await runOnce({ repoRoot, runAt: T1, logger });
  const log = text();
  assert.ok(log.includes('backup:local development'), 'environment name is logged');
  assert.ok(log.includes(ID1), 'retained snapshot id is logged');
  for (const secret of [
    LOCAL_URL,
    'postgres:postgres',
    REF,
    AGE_RECIPIENT_1,
    'CREATE ROLE',
    '42',
    'formatVersion',
    'contentSha256',
  ]) {
    assert.ok(!log.includes(secret), `log leaked: ${secret}`);
  }
  assert.ok(!log.includes(LOCAL_PROJECT.workdir), 'no workdir dump in logs');
  assert.ok(!log.includes(LOCAL_PROJECT.dbContainer), 'no container name in logs');
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

test('backup-local: malformed CLI exits nonzero before external work', () => {
  for (const args of [
    [],
    ['--bogus'],
    ['--environment'],
    ['--environment', 'staging'],
    ['--environment', 'development', 'extra'],
    ['--', '--environment', 'development'],
  ]) {
    const res = runCli(args, { PATH: process.env.PATH });
    assert.notEqual(res.status, 0, `expected nonzero exit for ${JSON.stringify(args)}`);
  }
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
