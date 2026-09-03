import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRestoreLocal } from './restore-local.js';
import { exitCodeForResult } from './args.js';
import { LocalRestoreError } from '../src/local-restore.js';
import { REPOSITORY_ROOT } from '../src/config.js';
import { tmpdir, writePrivateFile } from '../src/test-fixtures.js';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ID = '2026-08-24T03-17-09Z';

/** Fixture constants: the exact config file and the derived project root. */
const PROJECT_CONFIG = path.join('/', 'project', 'supabase', 'config.toml');
const PROJECT_ROOT = path.join('/', 'project');

function fakeDeps(overrides = {}) {
  const calls = { prepare: [], confirm: 0, restore: 0, cleanup: 0, validate: 0 };
  const deps = {
    loadConfig: ({ environment, source }) => {
      calls.loadConfig = { environment, source };
      return {
        environment,
        source,
        ageIdentity: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
        supabaseConfigPath: PROJECT_CONFIG,
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
    doValidateWorkdir: (opts) => {
      calls.validate += 1;
      calls.validateOpts = opts;
      return {
        workdir: PROJECT_ROOT,
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

test('restore-local: config loads and the self-reference check anchor to the repository root, never the caller cwd', async () => {
  const script = fileURLToPath(new URL('./restore-local.js', import.meta.url));
  const code = `
    import { runRestoreLocal } from ${JSON.stringify(script)};
    const calls = { root: null, repoRoot: null };
    await runRestoreLocal({
      options: { environment: 'development', source: 'r2', backup: 'latest' },
      env: {},
      logger: { addSecret() {}, status() {}, warn() {}, error() {}, redact: (t) => t },
      deps: {
        loadConfig: (opts) => {
          calls.root = opts.root;
          return {
            environment: 'development',
            source: 'r2',
            ageIdentity: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
            supabaseConfigPath: '/abs/project/supabase/config.toml',
            bucket: 'development',
            accessKeyId: 'a',
            secretAccessKey: 'b',
          };
        },
        locateCli: () => process.execPath,
        assertPin: async () => {},
        doValidateWorkdir: (opts) => {
          calls.repoRoot = opts.repoRoot;
          return { workdir: '/abs/project', projectId: 'p', dbPort: 54322, dbContainer: 'c' };
        },
        lookup: () => process.execPath,
        doPrepare: async () => ({ snapshotId: 'id', cleanup: async () => {} }),
        doConfirm: async () => false,
        stdIn: { isTTY: true },
        stdErr: { write() {} },
      },
    });
    process.stdout.write(JSON.stringify(calls));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: tmpdir('bp-restore-cwd-'),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const calls = JSON.parse(child.stdout);
  assert.equal(calls.root, REPOSITORY_ROOT, 'config loads must anchor at the repository root');
  assert.equal(
    calls.repoRoot,
    REPOSITORY_ROOT,
    'the self-reference check must use the repository root',
  );
});

test('restore-local: config-path validation precedes source preparation and receives the exact file', async () => {
  const { deps, calls } = fakeDeps({
    doValidateWorkdir: () => {
      throw new LocalRestoreError('SUPABASE_CONFIG_PATH does not exist: /bad');
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
    /SUPABASE_CONFIG_PATH does not exist/,
  );
  assert.equal(calls.prepare.length, 0, 'no snapshot download before a failing local check');
  assert.equal(calls.confirm, 0);
  assert.equal(calls.restore, 0);

  // The runner passes the config file path from the fixed development
  // identity and the repository root as the relative base.
  const { deps: deps2, calls: calls2 } = fakeDeps();
  await runRestoreLocal({
    options: localOptions({ source: 'repo' }),
    env: {},
    cwd: '/repo',
    logger: silent,
    deps: deps2,
  });
  assert.deepEqual(calls2.validateOpts, {
    supabaseConfigPath: PROJECT_CONFIG,
    repoRoot: '/repo',
  });

  // In the happy path the config-path check runs before doPrepare is invoked.
  const order = [];
  const { deps: deps3 } = fakeDeps({
    doValidateWorkdir: (opts) => {
      order.push('validate');
      return {
        workdir: opts.supabaseConfigPath ? PROJECT_ROOT : '/wrong',
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
        deps: deps3,
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
        workdir: PROJECT_ROOT,
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
        workdir: PROJECT_ROOT,
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
