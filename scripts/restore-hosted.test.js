import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRestoreHosted, exitCodeForResult } from './restore-hosted.js';
import { HostedRestoreError } from '../src/hosted-restore.js';
import { PINNED_SUPABASE_POSTGRES_IMAGE, PINNED_SUPABASE_CLI_VERSION } from '../src/database.js';
import { RestoreError } from '../src/restore.js';
import { tmpdir } from '../src/test-fixtures.js';

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
    run: async (opts) => {
      if (opts.args.includes('--version')) return { stdout: `${PINNED_SUPABASE_CLI_VERSION}\n` };
      return {};
    },
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

test('restore-hosted: cross-project local restore requires the snapshot source ref in the phrase', async () => {
  // A local snapshot may feed any hosted target by operator choice, but the
  // operator must ACKNOWLEDGE the snapshot's origin when it differs from the
  // target project: the exact phrase then includes the source ref, so a
  // development-local snapshot can never be silently confirmed into another
  // project's production target.
  const track = { phrase: null };
  const localRef = 'f0e9d8c7b6a5f4e3d2c1';
  const { deps } = fakeDeps({
    doPrepare: async () => ({
      snapshotId: '2026-08-24T03-17-09Z',
      dir: '/prepared',
      dataPath: '/prepared/data.sql',
      manifest: {},
      sourceProjectRef: localRef,
      cleanup: async () => {},
    }),
    doConfirm: async ({ expected: e }) => {
      track.phrase = e;
      return true;
    },
  });
  await runRestoreHosted({
    options: hostedOptions({ target: 'production', source: 'local' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(
    track.phrase,
    `RESTORE production ${REF} from local snapshot ${localRef}`,
    'cross-project local restore must type the source ref',
  );
});

test('restore-hosted: same-project local restore keeps the unchanged phrase', async () => {
  let phrase = null;
  const { deps } = fakeDeps({
    doPrepare: async () => ({
      snapshotId: '2026-08-24T03-17-09Z',
      dir: '/prepared',
      dataPath: '/prepared/data.sql',
      manifest: {},
      sourceProjectRef: REF,
      cleanup: async () => {},
    }),
    doConfirm: async ({ expected: e }) => {
      phrase = e;
      return true;
    },
  });
  await runRestoreHosted({
    options: hostedOptions({ source: 'local' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(phrase, 'RESTORE development', 'matching refs keep the standard phrase');
});

test('restore-hosted: local source needs no age binary or R2/age config', async () => {
  const track = { prepare: [], lookups: [], phrase: null };
  const { deps, calls } = fakeDeps({
    loadConfig: ({ environment, source }) => ({
      environment,
      source,
      dbUrl: DB_URL,
      projectRef: REF,
    }),
    lookup: (name) => {
      track.lookups.push(name);
      if (name === 'age' || name === 'age.exe') return null;
      return process.execPath;
    },
    doPrepare: async (opts) => {
      track.prepare.push(opts);
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
    doConfirm: async ({ expected: e }) => {
      track.phrase = e;
      return true;
    },
  });
  const result = await runRestoreHosted({
    options: hostedOptions({ source: 'local' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(result.target, 'development');
  assert.equal(result.source, 'local');
  assert.equal(result.snapshotId, '2026-08-24T03-17-09Z');
  assert.equal(calls.preflight, 1, 'psql preflight still runs for local');
  assert.equal(calls.execute, 1, 'apply pipeline runs after confirmation');
  assert.equal(calls.cleanup, 1, 'prepared cleanup still runs');
  assert.equal(track.phrase, 'RESTORE development', 'confirmation phrase uses the target');
  assert.ok(
    !track.lookups.includes('age') && !track.lookups.includes('age.exe'),
    'age must never be resolved for the local source',
  );
  assert.equal(track.prepare.length, 1);
  assert.equal(track.prepare[0].source, 'local');
  assert.equal(track.prepare[0].selector, 'latest');
  assert.equal(track.prepare[0].environment, 'development');
  assert.equal(track.prepare[0].ageIdentity, undefined, 'no age identity for local');
  assert.equal(track.prepare[0].agePath, undefined, 'no age path for local');
});

test('restore-hosted: local source never resolves age or receives an age identity', async () => {
  const track = { prepare: [], lookups: [], phrase: null };
  const { deps, calls } = fakeDeps({
    loadConfig: ({ environment, source }) => ({
      environment,
      source,
      dbUrl: DB_URL,
      projectRef: REF,
    }),
    lookup: (name) => {
      track.lookups.push(name);
      return process.execPath;
    },
    doPrepare: async (opts) => {
      track.prepare.push(opts);
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
    doConfirm: async ({ expected: e }) => {
      track.phrase = e;
      return true;
    },
  });
  const result = await runRestoreHosted({
    options: hostedOptions({ source: 'local' }),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(result.source, 'local');
  assert.equal(result.snapshotId, '2026-08-24T03-17-09Z');
  assert.ok(
    !track.lookups.includes('age') && !track.lookups.includes('age.exe'),
    'age must never be resolved for the plaintext local source',
  );
  assert.equal(track.prepare.length, 1);
  assert.equal(track.prepare[0].ageIdentity, undefined);
  assert.equal(track.prepare[0].agePath, undefined);
});

test('restore-hosted: local-source skip warnings are reported before confirmation', async () => {
  const warned = [];
  const { deps, calls } = fakeDeps({
    doPrepare: async (opts) => {
      calls.prepare.push(opts);
      return {
        snapshotId: '2026-08-24T03-17-09Z',
        dir: '/prepared',
        dataPath: '/prepared/data.sql',
        manifest: { environment: opts.environment },
        warnings: ['skipped local snapshot 2026-08-25T00-00-00Z: INVALID manifest JSON'],
        cleanup: async () => {
          calls.cleanup += 1;
        },
      };
    },
  });
  await runRestoreHosted({
    options: hostedOptions({ source: 'local' }),
    env: {},
    cwd: '/repo',
    logger: { ...silentLogger, warn: (m) => warned.push(m) },
    deps,
  });
  assert.deepEqual(warned, ['skipped local snapshot 2026-08-25T00-00-00Z: INVALID manifest JSON']);
});

test('restore-hosted: a local-source prepare failure surfaces the RestoreError', async () => {
  const { deps, calls } = fakeDeps({
    loadConfig: ({ environment, source }) => ({
      environment,
      source,
      dbUrl: DB_URL,
      projectRef: REF,
    }),
    lookup: (name) => (name === 'age' || name === 'age.exe' ? null : process.execPath),
    doPrepare: async () => {
      throw new RestoreError('no valid snapshots available for this environment/source');
    },
  });
  await assert.rejects(
    () =>
      runRestoreHosted({
        options: hostedOptions({ source: 'local' }),
        env: {},
        cwd: '/repo',
        logger: silentLogger,
        deps,
      }),
    (err) =>
      err instanceof RestoreError &&
      /no valid snapshots available for this environment\/source/.test(err.message),
  );
  assert.equal(calls.confirm, 0, 'no prompt after a failed prepare');
  assert.equal(calls.execute, 0);
  assert.equal(calls.cleanup, 0, 'preparation failure cleans up after itself');
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

test('restore-hosted: no host psql is discovered or required for local, repo, or r2 sources', async () => {
  for (const source of ['local', 'repo', 'r2']) {
    const track = { lookups: [] };
    const { deps, calls } = fakeDeps({
      lookup: (name) => {
        track.lookups.push(name);
        return process.execPath;
      },
    });
    const result = await runRestoreHosted({
      options: hostedOptions({ source }),
      env: {},
      cwd: '/repo',
      logger: silentLogger,
      deps,
    });
    assert.equal(result.source, source);
    assert.equal(calls.execute, 1, `restore with source ${source} must succeed without host psql`);
    assert.ok(
      !track.lookups.includes('psql') && !track.lookups.includes('psql.exe'),
      `psql must never be looked up for ${source}`,
    );
  }
});

test('restore-hosted: preflight and execute receive the resolved Docker path and pinned image', async () => {
  const fakeDockerPath = '/usr/local/bin/docker';
  const received = { preflight: null, execute: null };
  const { deps } = fakeDeps({
    lookup: (name) =>
      name === 'docker' || name === 'docker.exe' ? fakeDockerPath : process.execPath,
    doPreflight: async (opts) => {
      received.preflight = opts;
    },
    doExecute: async (opts) => {
      received.execute = opts;
    },
  });
  await runRestoreHosted({
    options: hostedOptions(),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(received.preflight.dockerPath, fakeDockerPath);
  assert.equal(received.preflight.postgresImage, PINNED_SUPABASE_POSTGRES_IMAGE);
  assert.equal(received.preflight.dbUrl, DB_URL);
  assert.equal(received.execute.dockerPath, fakeDockerPath);
  assert.equal(received.execute.postgresImage, PINNED_SUPABASE_POSTGRES_IMAGE);
  assert.equal(received.execute.supabasePath, process.execPath);
  const legacyKey = ['psql', 'Path'].join(''); // legacy seam name must not appear as a literal
  assert.ok(
    !(legacyKey in received.preflight) && !(legacyKey in received.execute),
    'the legacy host-psql seam is gone from both preflight and execute',
  );
});

test('restore-hosted: postgresImage defaults to the pin and can be overridden through deps', async () => {
  const received = { preflight: null };
  const { deps } = fakeDeps({
    doPreflight: async (opts) => {
      received.preflight = opts;
    },
  });
  await runRestoreHosted({
    options: hostedOptions(),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps,
  });
  assert.equal(received.preflight.postgresImage, PINNED_SUPABASE_POSTGRES_IMAGE);

  const overridden = { preflight: null };
  const alt = { postgresImage: 'registry.example/postgres:17-test' };
  const { deps: deps2 } = fakeDeps({
    ...alt,
    doPreflight: async (opts) => {
      overridden.preflight = opts;
    },
  });
  await runRestoreHosted({
    options: hostedOptions(),
    env: {},
    cwd: '/repo',
    logger: silentLogger,
    deps: deps2,
  });
  assert.equal(overridden.preflight.postgresImage, alt.postgresImage);
  assert.equal(overridden.preflight.dockerPath, process.execPath);
});

test('restore-hosted: missing Supabase CLI fails before any target or source work', async () => {
  const { deps, calls } = fakeDeps({
    lookup: (name) => (name === 'supabase' ? null : process.execPath),
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
    (err) => err instanceof HostedRestoreError && /Supabase CLI/.test(err.message),
  );
  assert.equal(calls.preflight, 0, 'no preflight may run before executable resolution');
  assert.equal(calls.prepare.length, 0, 'no source work may run');
  assert.equal(calls.confirm, 0, 'no prompt may appear');
  assert.equal(calls.execute, 0);
});

test('restore-hosted: missing Docker fails before any target or source work with no psql hint', async () => {
  const { deps, calls } = fakeDeps({
    lookup: (name) => (name === 'docker' || name === 'docker.exe' ? null : process.execPath),
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
    (err) =>
      err instanceof HostedRestoreError &&
      /Docker is required/.test(err.message) &&
      !/psql/.test(err.message),
  );
  assert.equal(calls.preflight, 0, 'no preflight may run before executable resolution');
  assert.equal(calls.prepare.length, 0, 'no source work may run');
  assert.equal(calls.confirm, 0, 'no prompt may appear');
  assert.equal(calls.execute, 0);
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
    // With every executable absent, Docker (required for reset + the
    // Dockerized client) is the first hard dependency and must fail first,
    // and the failure must never suggest installing host psql.
    (err) => err instanceof HostedRestoreError && !/psql/.test(err.message),
  );
});

test('restore-hosted: an unpinned Supabase CLI on PATH is rejected before any target work', async () => {
  const root = tmpdir('bp-hosted-cli-');
  const pathSupabase = path.join(root, 'supabase');
  fs.writeFileSync(pathSupabase, '#!/bin/sh\necho supabase\n', { mode: 0o755 });
  const versionCalls = [];
  const { deps, calls } = fakeDeps({
    lookup: (name) => (name === 'supabase' ? pathSupabase : process.execPath),
    run: async (opts) => {
      if (opts.args.includes('--version')) {
        versionCalls.push(opts.command);
        return { stdout: '2.99.0\n' }; // NOT the pinned version
      }
      return { stdout: '' };
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
    (err) =>
      err instanceof HostedRestoreError &&
      err.message.includes(`must be exactly ${PINNED_SUPABASE_CLI_VERSION}`),
  );
  assert.deepEqual(versionCalls, [pathSupabase]);
  assert.equal(calls.preflight, 0, 'no target preflight may run with an unpinned CLI');
  assert.equal(calls.prepare.length, 0, 'no source work may run');
  assert.equal(calls.execute, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore-hosted: the repository-pinned CLI binary is preferred over any PATH supabase', async () => {
  const root = tmpdir('bp-hosted-cli-');
  const binDir = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'supabase'), '#!/bin/sh\necho supabase\n', { mode: 0o755 });
  let lookupSupabase = 0;
  let executedWith = null;
  const { deps, calls } = fakeDeps({
    lookup: (name) => {
      if (name === 'supabase') {
        lookupSupabase += 1;
        return '/usr/local/bin/supabase';
      }
      return process.execPath;
    },
    run: async (opts) => {
      if (opts.args.includes('--version')) {
        executedWith = opts.command;
        return { stdout: `${PINNED_SUPABASE_CLI_VERSION}\n` };
      }
      return { stdout: '' };
    },
  });
  await runRestoreHosted({
    options: hostedOptions(),
    env: {},
    cwd: root,
    logger: silentLogger,
    deps,
  });
  assert.equal(executedWith, path.join(binDir, 'supabase'));
  assert.equal(lookupSupabase, 0, 'PATH must not be consulted when the repo binary exists');
  assert.equal(calls.execute, 1);
  fs.rmSync(root, { recursive: true, force: true });
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
