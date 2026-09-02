import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runLocalReset } from './reset-local.js';
import { PINNED_SUPABASE_CLI_VERSION } from '../src/database.js';
import { tmpdir } from '../src/test-fixtures.js';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Minimal sibling-project workdir satisfying validateWorkdir. */
function siblingWorkdir() {
  const root = tmpdir('bp-reset-local-');
  fs.mkdirSync(path.join(root, 'supabase'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'supabase', 'config.toml'),
    'project_id = "sibling"\n[db]\nport = 54322\nmajor_version = 17\n',
  );
  return root;
}

function runCli(args) {
  const script = fileURLToPath(new URL('./reset-local.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function fakeDeps({ projectWorkdir, overrides = {} } = {}) {
  const calls = { loadConfig: null, resets: [] };
  const deps = {
    loadConfig: ({ environment }) => {
      calls.loadConfig = environment;
      return { projectWorkdir, environment };
    },
    locateCli: () => process.execPath, // real existing executable for the existence check
    run: async (opts) => {
      if (opts.args.includes('--version')) return { stdout: `${PINNED_SUPABASE_CLI_VERSION}\n` };
      calls.resets.push({ args: opts.args, cwd: opts.cwd });
      return {};
    },
    ...overrides,
  };
  return { deps, calls };
}

const silentLogger = { addSecret() {}, status() {}, warn() {}, error() {}, redact: (t) => t };
const RUN = { env: {}, cwd: REPO_ROOT, logger: silentLogger };

test('reset-local: fixed development identity and explicit --local reset in the sibling workdir', async () => {
  const sibling = siblingWorkdir();
  const { deps, calls } = fakeDeps({ projectWorkdir: sibling });
  await runLocalReset({ ...RUN, deps });
  assert.equal(calls.loadConfig, 'development');
  assert.deepEqual(calls.resets[0], {
    args: ['db', 'reset', '--local'],
    cwd: fs.realpathSync(sibling), // validateWorkdir canonicalizes the workdir
  });
});

test('reset-local: rejects the repository itself and missing config.toml as workdir', async () => {
  // Self-reference: PROJECT_WORKDIR may never be this repository.
  const selfRef = fakeDeps({ projectWorkdir: REPO_ROOT });
  await assert.rejects(
    () => runLocalReset({ ...RUN, deps: selfRef.deps }),
    /sibling project, not this repository/,
  );

  // A directory without supabase/config.toml is rejected before any run.
  const empty = tmpdir('bp-reset-local-');
  const { deps, calls } = fakeDeps({ projectWorkdir: empty });
  await assert.rejects(() => runLocalReset({ ...RUN, deps }), /no supabase\/config\.toml/);
  assert.equal(calls.resets.length, 0);
});

test('reset-local: unpinned CLI version aborts before any reset', async () => {
  const { deps, calls } = fakeDeps({
    projectWorkdir: siblingWorkdir(),
    overrides: {
      run: async (opts) => (opts.args.includes('--version') ? { stdout: '9.9.9\n' } : {}),
    },
  });
  await assert.rejects(() => runLocalReset({ ...RUN, deps }), /must be exactly/);
  assert.equal(calls.resets.length, 0);
});

test('reset-local CLI: stray tokens fail closed before any config load', () => {
  const stray = runCli(['development']);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /reset failed/);
});

test('reset-local CLI: help prints the usage and exits 0', () => {
  const res = runCli(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /usage: vp run reset:local/);
});
