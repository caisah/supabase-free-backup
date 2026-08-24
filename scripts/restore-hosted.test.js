import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRestoreHosted, exitCodeForResult } from './restore-hosted.js';
import { HostedRestoreError } from '../src/hosted-restore.js';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runCli(name, args) {
  const script = fileURLToPath(new URL('./' + name + '.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

const REF = 'a1b2c3d4e5f6a7b8c9d0';
const DB_URL = `postgresql://postgres.${REF}:the-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`;

function captureStream() {
  let text = '';
  return {
    stream: {
      write: (t) => {
        text += String(t);
      },
    },
    get: () => text,
  };
}

function fakeDeps(overrides = {}) {
  const calls = { prepare: [], confirm: 0, execute: 0, preflight: 0, cleanup: 0, buckets: [] };
  const readline = { write() {} };
  const deps = {
    loadConfig: ({ environment, source }) => {
      calls.loadConfig = { environment, source };
      return {
        environment,
        source,
        dbUrl: DB_URL,
        projectRef: REF,
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: environment,
        accessKeyId: 'a',
        secretAccessKey: 'b',
        ageIdentity: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
      };
    },
    doPreflight: async () => {
      calls.preflight += 1;
    },
    doPrepare: async (opts) => {
      calls.prepare.push({
        source: opts.source,
        selector: opts.selector,
        environment: opts.environment,
      });
      calls.buckets.push(opts.bucket);
      return {
        snapshotId: '2026-08-24T03-17-09Z',
        dir: '/prepared',
        dataPath: '/prepared/data.sql',
        manifest: { environment: opts.environment },
        cleanup: async () => {
          calls.cleanup += 1;
        },
      };
    },
    doConfirm: async ({ isTTY: tty }) => tty !== false,
    doExecute: async () => {
      calls.execute += 1;
    },
    makeAdapter: () => ({}),
    lookup: () => process.execPath, // real existing executable for preflight existence checks
    run: async () => ({}),
    stdIn: { isTTY: true },
    stdErr: readline,
    stdOut: readline,
    ...overrides,
  };
  return { deps, calls };
}

/** Validated options for a runner invocation. */
function hostedOptions({ target = 'development', source = 'r2', backup = 'latest' } = {}) {
  return { target, source, backup };
}

const silentLogger = { addSecret() {}, status() {}, warn() {}, error() {}, redact: (t) => t };

test('restore-hosted: the fixed target drives environment selection and cannot cross buckets', async () => {
  const { deps, calls } = fakeDeps();
  const result = await runRestoreHosted({
    options: hostedOptions({ target: 'development', source: 'r2' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(result.target, 'development');
  assert.equal(calls.loadConfig.environment, 'development');
  assert.equal(calls.execute, 1);

  // Production alias targets production only.
  const { deps: deps2, calls: calls2 } = fakeDeps();
  await runRestoreHosted({
    options: hostedOptions({ target: 'production', source: 'repo' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps: deps2,
  });
  assert.equal(calls2.loadConfig.environment, 'production');
  assert.equal(calls2.buckets[0], 'production');
});

test('restore-hosted: repo and r2 selectors reach the common preparation', async () => {
  const { deps, calls } = fakeDeps();
  await runRestoreHosted({
    options: hostedOptions({ source: 'repo', backup: '2026-08-24T03-17-09Z' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.deepEqual(calls.prepare[0], {
    source: 'repo',
    selector: '2026-08-24T03-17-09Z',
    environment: 'development',
  });

  const { deps: deps2, calls: calls2 } = fakeDeps();
  await runRestoreHosted({
    options: hostedOptions({ source: 'r2' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps: deps2,
  });
  assert.deepEqual(calls2.prepare[0], {
    source: 'r2',
    selector: 'latest',
    environment: 'development',
  });
});

test('restore-hosted: non-TTY or wrong phrase leaves the target untouched', async () => {
  const { deps, calls } = fakeDeps({ doConfirm: async () => false });
  const result = await runRestoreHosted({
    options: hostedOptions(),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(result.confirmed, false);
  assert.equal(calls.execute, 0, 'no destructive step may run');

  const { deps: deps2, calls: calls2 } = fakeDeps({ isTTY: false });
  await runRestoreHosted({
    options: hostedOptions({ target: 'production' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps: deps2,
  });
  assert.equal(calls2.execute, 0, 'non-TTY may never restore');
});

test('restore-hosted: production confirmation includes the exact project ref', async () => {
  let expected = null;
  const { deps } = fakeDeps({
    doConfirm: async ({ expected: e }) => {
      expected = e;
      return true;
    },
  });
  await runRestoreHosted({
    options: hostedOptions({ target: 'production', source: 'repo' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(expected, `RESTORE production ${REF}`);
});

test('restore-hosted: source verification failure prevents prompt and reset', async () => {
  let confirmed = 0;
  const { deps, calls } = fakeDeps({
    doPrepare: async () => {
      throw new HostedRestoreError('fingerprint mismatch');
    },
    doConfirm: async () => {
      confirmed += 1;
      return true;
    },
  });
  await assert.rejects(
    () =>
      runRestoreHosted({
        options: hostedOptions(),
        env: {},
        cwd: '/repo',
        logger: silentLogger,
        deps,
      }),
    /fingerprint mismatch/,
  );
  assert.equal(confirmed, 0, 'no prompt after verification failure');
  assert.equal(calls.execute, 0);
  assert.equal(calls.cleanup, 0, 'preparation failure cleans up after itself');
});

test('restore-hosted: preflight failure prevents everything else', async () => {
  const { deps, calls } = fakeDeps({
    doPreflight: async () => {
      throw new HostedRestoreError('cannot reach target');
    },
  });
  await assert.rejects(
    () =>
      runRestoreHosted({
        options: hostedOptions(),
        env: {},
        cwd: '/repo',
        logger: silentLogger,
        deps,
      }),
    /cannot reach target/,
  );
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.execute, 0);
});

test('restore-hosted: cleanup runs on every outcome', async () => {
  const { deps, calls } = fakeDeps({
    doExecute: async () => {
      throw new HostedRestoreError('restore exploded');
    },
  });
  await assert.rejects(
    () =>
      runRestoreHosted({
        options: hostedOptions(),
        env: {},
        cwd: '/repo',
        logger: silentLogger,
        deps,
      }),
    /restore exploded/,
  );
  assert.equal(calls.cleanup, 1);
});

test('restore-hosted: logs never contain the DB URL or password', async () => {
  const log = captureStream();
  const { deps } = fakeDeps();
  await runRestoreHosted({
    options: hostedOptions(),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  const text = log.get();
  const portable = JSON.stringify(text);
  assert.ok(!portable.includes('the-password'));
});

test('restore-hosted: missing executables fail before target contact', async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    () =>
      runRestoreHosted({
        options: hostedOptions(),
        env: {},
        cwd: '/repo',
        logger: silentLogger,
        deps: { ...deps, lookup: () => null },
      }),
    /psql/,
  );
});

test('restore-hosted: declined confirmation maps to a distinct exit code', () => {
  assert.equal(exitCodeForResult({ help: true }), 0);
  assert.equal(exitCodeForResult(undefined), 0);
  assert.equal(exitCodeForResult({ confirmed: true, target: 'development' }), 0);
  assert.equal(exitCodeForResult({ confirmed: false, target: 'development' }), 2);
});

test('restore-hosted: CLI entry point responds to --help', () => {
  const res = runCli('restore-hosted', ['development', '--help']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('usage: vp run restore:development'), res.stderr.slice(0, 300));
});

test('restore-hosted: R2 credentials are registered for redaction', async () => {
  const added = [];
  const { deps, calls } = fakeDeps({
    doConfirm: async () => true,
  });
  await runRestoreHosted({
    options: hostedOptions({ target: 'development', source: 'r2', backup: 'latest' }),
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
  assert.ok(added.includes(DB_URL), 'DB URL must be registered');
  assert.ok(added.includes('a'), 'access key id must be registered');
  assert.ok(added.includes('b'), 'secret access key must be registered');
  assert.equal(calls.execute, 1);
});

test('restore-hosted: unknown flag exits nonzero before external contact', () => {
  const res = runCli('restore-hosted', ['development', '--source', 'r2', '--bogus', 'latest']);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('Unknown option') || res.stderr.includes('restore'));
});
