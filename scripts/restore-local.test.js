import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRestoreLocal } from './restore-local.js';
import { exitCodeForResult } from './args.js';
import { LocalRestoreError } from '../src/local-restore.js';
import { tmpdir, writePrivateFile } from '../src/test-fixtures.js';

const ID = '2026-08-24T03-17-09Z';

/** Validate the local-stack workdir fixture (no config.toml needed; runner injects it). */
function fakeDeps(overrides = {}) {
  const calls = { prepare: [], confirm: 0, restore: 0, cleanup: 0, validate: 0 };
  const deps = {
    loadConfig: ({ environment, source }) => {
      calls.loadConfig = { environment, source };
      return {
        environment,
        source,
        ageIdentity: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
        projectWorkdir: path.join('/', 'project'),
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: environment,
        accessKeyId: 'a',
        secretAccessKey: 'b',
      };
    },
    locateCli: () => process.execPath,
    assertPin: async () => {
      calls.pin += 1;
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
        sourceProjectRef: 'a1b2c3d4e5f6a7b8c9d0',
        cleanup: async () => {
          calls.cleanup += 1;
          fs.rmSync(preparedDir, { recursive: true, force: true });
        },
      };
    },
    doValidateWorkdir: () => {
      calls.validate += 1;
      return {
        workdir: path.join('/', 'project'),
        projectId: 'testproj',
        dbPort: 54322,
        dbContainer: 'supabase_db_testproj',
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
        workdir: path.join('/', 'project'),
        projectId: 'testproj',
        dbPort: 54322,
        dbContainer: 'supabase_db_testproj',
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

test('restore-local: the age identity is registered as a log secret alongside the R2 credentials', async () => {
  const secrets = [];
  const { deps } = fakeDeps();
  await runRestoreLocal({
    options: localOptions(),
    env: {},
    cwd: '/repo',
    logger: {
      status() {},
      warn() {},
      error() {},
      redact: (t) => t,
      addSecret(s) {
        secrets.push(s);
      },
    },
    deps,
  });
  assert.ok(
    secrets.includes('AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'),
    'the private age identity must be redacted in every log line',
  );
  assert.ok(secrets.includes('a'), 'access key id registered');
  assert.ok(secrets.includes('b'), 'secret access key registered');
});

test('restore-local: the warning names the exact container, port, and snapshot origin project', async () => {
  const writes = [];
  const { deps } = fakeDeps({
    doValidateWorkdir: () => {
      return {
        workdir: path.join('/', 'project'),
        projectId: 'testproj',
        dbPort: 54322,
        dbContainer: 'supabase_db_testproj',
      };
    },
    stdErr: {
      write(text) {
        writes.push(text);
      },
    },
  });
  await runRestoreLocal({
    options: localOptions({ environment: 'production', source: 'r2' }),
    env: {},
    cwd: '/repo',
    logger: silent,
    deps,
  });
  const warning = writes.join('');
  assert.ok(warning.includes('supabase_db_testproj'), 'container named in the warning');
  assert.ok(warning.includes('54322'), 'db port named in the warning');
  assert.ok(
    warning.includes('a1b2c3d4e5f6a7b8c9d0'),
    'the snapshot origin project ref must be confirmed before destruction',
  );
});

test('restore-local: workdir validation runs before the pinned-CLI version check', async () => {
  const order = [];
  const { deps } = fakeDeps({
    doValidateWorkdir: () => {
      order.push('validate');
      return {
        workdir: path.join('/', 'project'),
        projectId: 'testproj',
        dbPort: 54322,
        dbContainer: 'supabase_db_testproj',
      };
    },
    assertPin: async () => {
      order.push('pin');
    },
  });
  await runRestoreLocal({
    options: localOptions(),
    env: {},
    cwd: '/repo',
    logger: silent,
    deps,
  });
  assert.deepEqual(order, ['validate', 'pin'], 'cheap file checks precede the CLI spawn');
});

test('restore-local: the completion summary surfaces the snapshot origin project', async () => {
  const statuses = [];
  const { deps } = fakeDeps();
  await runRestoreLocal({
    options: localOptions(),
    env: {},
    cwd: '/repo',
    logger: {
      addSecret() {},
      warn() {},
      error() {},
      redact: (t) => t,
      status(text) {
        statuses.push(text);
      },
    },
    deps,
  });
  assert.ok(
    statuses.some((s) => s.includes('source project ref: a1b2c3d4e5f6a7b8c9d0')),
    'completion must name the project the data came from',
  );
});

test('restore-local: declined confirmation returns exit code 2; success and help return 0', () => {
  assert.equal(exitCodeForResult({ confirmed: false, environment: 'development' }), 2);
  assert.equal(exitCodeForResult({ confirmed: true, environment: 'development' }), 0);
  assert.equal(exitCodeForResult({ help: true }), 0);
});
