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

function fakeDeps({ configPath, overrides = {} } = {}) {
  const calls = { loadConfig: null, resets: [] };
  const deps = {
    loadConfig: ({ environment }) => {
      calls.loadConfig = environment;
      return { supabaseConfigPath: configPath, environment };
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

test('reset-local: fixed development identity and explicit --local reset in the derived project root', async () => {
  const sibling = siblingWorkdir();
  const { deps, calls } = fakeDeps({
    configPath: path.join(sibling, 'supabase', 'config.toml'),
  });
  await runLocalReset({ ...RUN, deps });
  assert.equal(calls.loadConfig, 'development');
  assert.deepEqual(calls.resets[0], {
    args: ['db', 'reset', '--local'],
    cwd: fs.realpathSync(sibling), // validateWorkdir derives the project root from the config file
  });
});

test('reset-local: relative SUPABASE_CONFIG_PATH and the self-reference check anchor to the repository root, never the caller cwd', async () => {
  // The default repo root must be REPOSITORY_ROOT even when the CLI is
  // invoked from another directory (npm scripts run from the repo root, but
  // `node scripts/reset-local.js` from a subdirectory must behave the same).
  const script = fileURLToPath(new URL('./reset-local.js', import.meta.url));
  const code = `
    import { runLocalReset } from ${JSON.stringify(script)};
    import { PINNED_SUPABASE_CLI_VERSION } from ${JSON.stringify(
      fileURLToPath(new URL('../src/database.js', import.meta.url)),
    )};
    const calls = { root: null, repoRoot: null };
    await runLocalReset({
      env: {},
      logger: { addSecret() {}, status() {}, warn() {}, error() {}, redact: (t) => t },
      deps: {
        loadConfig: (opts) => {
          calls.root = opts.root;
          return { supabaseConfigPath: '/abs/project/supabase/config.toml' };
        },
        doValidateWorkdir: (opts) => {
          calls.repoRoot = opts.repoRoot;
          return { workdir: '/abs/project', projectId: 'p', dbPort: 54322, dbContainer: 'c' };
        },
        locateCli: () => process.execPath,
        run: async (opts) =>
          opts.args.includes('--version')
            ? { stdout: PINNED_SUPABASE_CLI_VERSION + '\\n' }
            : {},
      },
    });
    process.stdout.write(JSON.stringify(calls));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: tmpdir('bp-reset-cwd-'),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const calls = JSON.parse(child.stdout);
  assert.equal(calls.root, REPO_ROOT, 'config loads must anchor at the repository root');
  assert.equal(calls.repoRoot, REPO_ROOT, 'the self-reference check must use the repository root');
});

test('reset-local: rejects this repository config and a missing config path before any run', async () => {
  // Self-reference: SUPABASE_CONFIG_PATH may never select this repository's
  // own supabase/config.toml.
  const selfRef = fakeDeps({
    configPath: path.join(REPO_ROOT, 'supabase', 'config.toml'),
  });
  await assert.rejects(
    () => runLocalReset({ ...RUN, deps: selfRef.deps }),
    /main project, not this repository/,
  );

  // A missing supabase/config.toml path is rejected before any run.
  const empty = tmpdir('bp-reset-local-');
  const { deps, calls } = fakeDeps({
    configPath: path.join(empty, 'supabase', 'config.toml'),
  });
  await assert.rejects(
    () => runLocalReset({ ...RUN, deps }),
    /SUPABASE_CONFIG_PATH does not exist/,
  );
  assert.equal(calls.resets.length, 0);
});

test('reset-local: unpinned CLI version aborts before any reset', async () => {
  const { deps, calls } = fakeDeps({
    configPath: path.join(siblingWorkdir(), 'supabase', 'config.toml'),
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
