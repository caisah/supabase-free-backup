import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHostedReset } from './reset-hosted.js';
import { PINNED_SUPABASE_CLI_VERSION } from '../src/database.js';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REF = 'a1b2c3d4e5f6a7b8c9d0';
const DB_URL = `postgresql://postgres.${REF}:the-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`;

function runCli(args) {
  const script = fileURLToPath(new URL('./reset-hosted.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function fakeDeps(overrides = {}) {
  const calls = { loadConfig: null, confirm: null, resets: [] };
  const readline = { write() {} };
  const deps = {
    loadConfig: ({ environment }) => {
      calls.loadConfig = environment;
      return { environment, projectRef: REF, sharedPoolerUrl: DB_URL };
    },
    locateCli: () => process.execPath, // real existing executable for the existence check
    doConfirm: async ({ expected, isTTY }) => {
      calls.confirm = expected;
      return isTTY !== false;
    },
    run: async (opts) => {
      if (opts.args.includes('--version')) return { stdout: `${PINNED_SUPABASE_CLI_VERSION}\n` };
      calls.resets.push({ args: opts.args, cwd: opts.cwd, secretArgs: opts.secretArgs });
      return {};
    },
    stdIn: { isTTY: true },
    stdErr: readline,
    ...overrides,
  };
  return { deps, calls };
}

const silentLogger = { addSecret() {}, status() {}, warn() {}, error() {}, redact: (t) => t };

const RUN = { env: {}, cwd: '/repo', logger: silentLogger };

test('reset-hosted: fixed target drives environment selection and the CLI reset argv', async () => {
  const { deps, calls } = fakeDeps();
  const result = await runHostedReset({ target: 'development', ...RUN, deps });
  assert.equal(result.confirmed, true);
  assert.equal(calls.loadConfig, 'development');
  assert.deepEqual(calls.resets[0], {
    args: ['db', 'reset', '--db-url', DB_URL, '--no-seed', '--yes'],
    cwd: '/repo',
    secretArgs: [DB_URL, 'the-password'],
  });
});

test('reset-hosted: production confirmation names the exact project ref', async () => {
  const { deps, calls } = fakeDeps();
  const result = await runHostedReset({ target: 'production', ...RUN, deps });
  assert.equal(result.confirmed, true);
  assert.equal(calls.loadConfig, 'production');
  assert.equal(calls.confirm, `RESET production ${REF}`);
});

test('reset-hosted: declined confirmation or non-TTY leaves the database untouched', async () => {
  const { deps, calls } = fakeDeps({ doConfirm: async () => false });
  const result = await runHostedReset({ target: 'production', ...RUN, deps });
  assert.equal(result.confirmed, false);
  assert.equal(calls.resets.length, 0, 'no destructive step may run');

  const { deps: deps2, calls: calls2 } = fakeDeps({ stdIn: { isTTY: false } });
  const result2 = await runHostedReset({ target: 'development', ...RUN, deps: deps2 });
  assert.equal(result2.confirmed, false);
  assert.equal(calls2.resets.length, 0, 'non-TTY may never reset');
});

test('reset-hosted: unpinned CLI version aborts before confirmation or reset', async () => {
  const { deps, calls } = fakeDeps({
    run: async (opts) => (opts.args.includes('--version') ? { stdout: '9.9.9\n' } : {}),
  });
  await assert.rejects(
    () => runHostedReset({ target: 'development', ...RUN, deps }),
    /must be exactly/,
  );
  assert.equal(calls.resets.length, 0);
});

test('reset-hosted CLI: bare invocation, invalid target, and stray options fail closed', () => {
  const bare = runCli([]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /requires a target/);

  const invalid = runCli(['staging']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /development\|production/);

  const stray = runCli(['development', '--source', 'r2']);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /unknown option/i);
});

test('reset-hosted CLI: help prints the usage and exits 0', () => {
  const res = runCli(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /usage: vp run reset:development\|reset:production/);
});
