import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRestoreLocal, exitCodeForResult } from './restore-local.js';
import { LocalRestoreError } from '../src/local-restore.js';
import { tmpdir, writePrivateFile } from '../src/test-fixtures.js';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runCli(name, args) {
  const script = fileURLToPath(new URL('./' + name + '.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

const ID = '2026-08-24T03-17-09Z';

function makeFragtrack(root) {
  const workdir = path.join(root, 'fragtrack');
  fs.mkdirSync(path.join(workdir, 'supabase'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(workdir, 'supabase', 'config.toml'),
    'project_id = "fragtrack"\n\n[db]\nport = 54322\nshadow_port = 54320\nmajor_version = 17\n',
  );
  return workdir;
}

function fakeDeps(overrides = {}) {
  const calls = { prepare: [], confirm: 0, restore: 0, cleanup: 0, validate: 0 };
  const deps = {
    loadConfig: ({ environment, source }) => {
      calls.loadConfig = { environment, source };
      return {
        environment,
        source,
        ageIdentity: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
        fragtrackWorkdir: '/fragtrack',
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: environment,
        accessKeyId: 'a',
        secretAccessKey: 'b',
      };
    },
    doPrepare: async (opts) => {
      calls.prepare.push({
        source: opts.source,
        selector: opts.selector,
        environment: opts.environment,
      });
      calls.buckets = calls.buckets ?? [];
      calls.buckets.push(opts.bucket);
      const preparedDir = tmpdir('bp-rl-prepared-');
      for (const name of [
        'roles.sql',
        'schema.sql',
        'managed-schema.sql',
        'migration-history-schema.sql',
      ]) {
        writePrivateFile(path.join(preparedDir, name), `-- ${name}\n`);
      }
      writePrivateFile(
        path.join(preparedDir, 'data.sql'),
        'COPY "public"."t" FROM stdin;\n1\n\\.\n',
      );
      return {
        snapshotId: ID,
        dir: preparedDir,
        dataPath: path.join(preparedDir, 'data.sql'),
        manifest: { environment: opts.environment },
        cleanup: async () => {
          calls.cleanup += 1;
          fs.rmSync(preparedDir, { recursive: true, force: true });
        },
      };
    },
    doValidateWorkdir: () => {
      calls.validate += 1;
      return {
        workdir: '/fragtrack',
        projectId: 'fragtrack',
        dbPort: 54322,
        dbContainer: 'supabase_db_fragtrack',
      };
    },
    doConfirm: async ({ isTTY: tty }) => {
      calls.confirm += 1;
      return tty !== false;
    },
    doRestore: async () => {
      calls.restore += 1;
    },
    makeAdapter: () => ({}),
    lookup: () => process.execPath,
    run: async () => ({}),
    stdIn: { isTTY: true },
    stdErr: { write() {} },
    stdOut: { write() {} },
    ...overrides,
  };
  return { deps, calls };
}

const silent = { addSecret() {}, status() {}, warn() {}, error() {}, redact: (t) => t };

/** Validated options for a runner invocation. */
function localOptions({ environment = 'development', source = 'r2', backup = 'latest' } = {}) {
  return { environment, source, backup };
}

test('restore-local: every environment/source combination reaches common preparation', async () => {
  for (const environment of ['development', 'production']) {
    for (const source of ['r2', 'repo']) {
      const { deps, calls } = fakeDeps();
      await runRestoreLocal({
        options: localOptions({ environment, source }),
        env: {},
        cwd: '/repo',
        logger: silent,
        deps,
      });
      assert.deepEqual(
        calls.prepare[0],
        { source, selector: 'latest', environment },
        `${environment}/${source}`,
      );
      assert.equal(calls.restore, 1);
      assert.equal(calls.cleanup, 1);
    }
  }
});

test('restore-local: cheap workdir validation precedes expensive source preparation', async () => {
  const { deps, calls } = fakeDeps({
    doValidateWorkdir: () => {
      throw new LocalRestoreError('PROJECT_WORKDIR has no supabase/config.toml: /bad');
    },
  });
  await assert.rejects(
    () =>
      runRestoreLocal({
        options: localOptions({ source: 'repo' }),
        env: {},
        cwd: '/repo',
        logger: silent,
        deps,
      }),
    /config\.toml/,
  );
  assert.equal(calls.prepare.length, 0, 'no snapshot download before a failing local check');
  assert.equal(calls.confirm, 0);
  assert.equal(calls.restore, 0);

  // In the happy path the workdir check runs before doPrepare is invoked.
  const order = [];
  const { deps: deps2 } = fakeDeps({
    doValidateWorkdir: () => {
      order.push('validate');
      return {
        workdir: '/fragtrack',
        projectId: 'fragtrack',
        dbPort: 54322,
        dbContainer: 'supabase_db_fragtrack',
      };
    },
    doPrepare: async () => {
      order.push('prepare');
      throw new LocalRestoreError('stop after ordering check');
    },
  });
  await assert.rejects(
    () =>
      runRestoreLocal({
        options: localOptions({ source: 'repo' }),
        env: {},
        cwd: '/repo',
        logger: silent,
        deps: deps2,
      }),
    /ordering check/,
  );
  assert.deepEqual(order, ['validate', 'prepare']);
});

test('restore-local: source verification precedes confirmation and stack changes', async () => {
  const { deps, calls } = fakeDeps({
    doPrepare: async () => {
      throw new LocalRestoreError('decryption failed');
    },
  });
  await assert.rejects(
    () =>
      runRestoreLocal({
        options: localOptions(),
        env: {},
        cwd: '/repo',
        logger: silent,
        deps,
      }),
    /decryption failed/,
  );
  assert.equal(calls.validate, 1, 'cheap workdir validation runs before source verification');
  assert.equal(calls.confirm, 0);
  assert.equal(calls.restore, 0);
});

test('restore-local: non-TTY or wrong phrase leaves the stack untouched', async () => {
  const { deps, calls } = fakeDeps({ isTTY: false });
  const result = await runRestoreLocal({
    options: localOptions(),
    env: {},
    cwd: '/repo',
    logger: silent,
    deps,
  });
  assert.equal(result.confirmed, false);
  assert.equal(calls.restore, 0);

  const { deps: deps2, calls: calls2 } = fakeDeps({
    doConfirm: async () => false,
  });
  await runRestoreLocal({
    options: localOptions({ environment: 'production', source: 'repo' }),
    env: {},
    cwd: '/repo',
    logger: silent,
    deps: deps2,
  });
  assert.equal(calls2.restore, 0);
});

test('restore-local: combined SQL and prepared workspace are removed in every outcome', async () => {
  const { deps, calls } = fakeDeps({
    doRestore: async () => {
      throw new LocalRestoreError('local db start failed');
    },
  });
  await assert.rejects(
    () =>
      runRestoreLocal({
        options: localOptions(),
        env: {},
        cwd: '/repo',
        logger: silent,
        deps,
      }),
    /local db start failed/,
  );
  assert.equal(calls.cleanup, 1);
});

test('restore-local: prepared workspace is cleaned when cleanup SQL generation fails', async () => {
  const { deps, calls } = fakeDeps({
    doPrepare: async () => {
      const preparedDir = tmpdir('bp-rl-malformed-');
      const dataPath = path.join(preparedDir, 'data.sql');
      writePrivateFile(dataPath, 'COPY public.bad FROM stdin;\n');
      return {
        snapshotId: ID,
        dir: preparedDir,
        dataPath,
        cleanup: async () => {
          calls.cleanup += 1;
          fs.rmSync(preparedDir, { recursive: true, force: true });
        },
      };
    },
  });
  await assert.rejects(
    () =>
      runRestoreLocal({
        options: localOptions(),
        env: {},
        cwd: '/repo',
        logger: silent,
        deps,
      }),
    /malformed COPY/,
  );
  assert.equal(calls.cleanup, 1, 'prepared cleanup must run after auxiliary-file failure');
});

test('restore-local: full flow with a real workdir and prepared workspace', async () => {
  const root = tmpdir('bp-rl-');
  makeFragtrack(root);
  const wdInfo = {
    workdir: fs.realpathSync(path.join(root, 'fragtrack')),
    projectId: 'fragtrack',
    dbPort: 54322,
    dbContainer: 'supabase_db_fragtrack',
  };
  const { deps } = fakeDeps({
    doValidateWorkdir: () => wdInfo,
  });
  const execSeq = [];
  const result = await runRestoreLocal({
    options: localOptions({ source: 'repo', backup: ID }),
    env: {},
    cwd: '/repo',
    logger: silent,
    deps: {
      ...deps,
      doRestore: async ({ prepared, cleanupFile, workdir, dbContainer, dbPort }) => {
        execSeq.push({ prepared, cleanupFile, workdir, dbContainer, dbPort });
        assert.ok(prepared.dir, 'prepared workspace passed through');
        assert.ok(cleanupFile, 'cleanup file passed through');
        assert.equal(dbContainer, 'supabase_db_fragtrack');
        assert.equal(dbPort, 54322);
      },
    },
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.snapshotId, ID);
  assert.equal(execSeq.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore-local: declined confirmation maps to a distinct exit code', () => {
  assert.equal(exitCodeForResult({ help: true }), 0);
  assert.equal(exitCodeForResult(undefined), 0);
  assert.equal(exitCodeForResult({ confirmed: true, environment: 'development' }), 0);
  assert.equal(exitCodeForResult({ confirmed: false, environment: 'development' }), 2);
});

test('restore-local: output never contains URL/password/SQL data', async () => {
  const out = {
    text: '',
    write(t) {
      this.text += String(t);
    },
  };
  const { deps } = fakeDeps({ stdErr: out, stdOut: out });
  await runRestoreLocal({
    options: localOptions({ source: 'repo', backup: ID }),
    env: {},
    cwd: '/repo',
    logger: silent,
    deps,
  });
  const text = out.text;
  assert.ok(!text.includes('AGE-SECRET-KEY-1Q'));
  assert.ok(!text.includes('data.sql'));
  assert.ok(text.includes('RESTORE local') || text.includes('snapshot'), text.slice(0, 200));
});

test('restore-local: CLI entry point responds to --help', () => {
  const res = runCli('restore-local', ['--help']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('usage: vp run restore:local'), res.stderr.slice(0, 300));
});

test('restore-local: R2 credentials are registered for redaction', async () => {
  const added = [];
  const { deps } = fakeDeps();
  await runRestoreLocal({
    options: localOptions(),
    env: {},
    cwd: '/repo',
    logger: {
      addSecret: (v) => {
        added.push(v);
      },
      status() {},
      warn() {},
      error() {},
      redact: (t) => t,
    },
    deps,
  });
  assert.ok(added.includes('a'), 'access key id must be registered');
  assert.ok(added.includes('b'), 'secret access key must be registered');
});

test('restore-local: unknown flag exits nonzero', () => {
  const res = runCli('restore-local', ['--environment', 'development', '--bogus', 'latest']);
  assert.notEqual(res.status, 0);
});
