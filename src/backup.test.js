/**
 * Shared remote-independent backup mechanics: executable preflight, private
 * workspace creation, and the dump-then-package orchestration consumed by
 * both `scripts/backup.js` (hosted R2) and `scripts/backup-local.js` (local
 * store). Nothing here may import the R2 adapter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveBackupExecutables,
  createBackupWorkspace,
  dumpAndPackageSnapshot,
  BACKUP_WORKSPACE_PREFIX,
} from './backup.js';
import { PINNED_SUPABASE_CLI_VERSION } from './database.js';
import { tmpdir } from './test-fixtures.js';

const REF = 'a1b2c3d4e5f6a7b8c9d0';
const ID = '2026-08-24T03-17-09Z';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RECIPIENT = 'age1rz8dtx9s7r2fyjejpq9wmewumm23ukwfdfqy0zjq0063ua6twfuqh0vyk9';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('backup: createBackupWorkspace is private and leaves the package path nonexistent', () => {
  assert.equal(BACKUP_WORKSPACE_PREFIX, 'supabase-db-backup-');
  const ws = createBackupWorkspace();
  try {
    assert.equal(fs.statSync(ws.workspace).mode & 0o777, 0o700);
    assert.equal(fs.statSync(ws.outDir).mode & 0o777, 0o700);
    assert.equal(path.basename(ws.outDir), 'dumps');
    // packageSnapshot owns destination creation and rejects a pre-existing
    // dir, so the caller must hand over a path that does not exist yet.
    assert.ok(!fs.existsSync(ws.pkgDir), 'pkgDir must not exist yet');
    assert.equal(path.dirname(ws.pkgDir), ws.workspace);
  } finally {
    fs.rmSync(ws.workspace, { recursive: true, force: true });
  }
});

test('backup: missing age, pinned CLI, or Docker fails preflight before any dump', () => {
  const root = tmpdir('bp-backup-src-');
  const ok = {
    lookup: (name) => `/bin/${name}`,
    locateCli: () => '/repo/node_modules/.bin/supabase',
    root,
    platform: 'linux',
  };
  assert.deepEqual(resolveBackupExecutables(ok), {
    ageBin: '/bin/age',
    supabasePath: '/repo/node_modules/.bin/supabase',
    dockerPath: '/bin/docker',
  });
  assert.throws(
    () => resolveBackupExecutables({ ...ok, lookup: (name) => (name === 'age' ? null : '/bin/x') }),
    /age executable not found/,
  );
  assert.throws(
    () => resolveBackupExecutables({ ...ok, locateCli: () => null }),
    /Supabase CLI not found/,
  );
  assert.throws(
    () =>
      resolveBackupExecutables({
        ...ok,
        lookup: (name) => (name === 'docker' ? null : '/bin/x'),
      }),
    /Docker is required/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: dump precedes package and receives the URL only as its source input', async () => {
  const order = [];
  const run = async () => {};
  const executables = {
    ageBin: '/bin/age',
    supabasePath: '/cli/supabase',
    dockerPath: '/bin/docker',
  };
  const signal = { aborted: false };
  await dumpAndPackageSnapshot({
    dbUrl: DB_URL,
    cwd: '/repo',
    outDir: '/ws/dumps',
    pkgDir: '/ws/pkg',
    snapshotId: ID,
    environment: 'development',
    sourceProjectRef: REF,
    ageRecipient: RECIPIENT,
    executables,
    run,
    signal,
    doDump: async (opts) => {
      order.push('dump');
      assert.deepEqual(opts, {
        dbUrl: DB_URL,
        cwd: '/repo',
        outDir: '/ws/dumps',
        supabasePath: '/cli/supabase',
        dockerPath: '/bin/docker',
        run,
        signal,
        onProgress: undefined,
      });
    },
    doPackage: async (opts) => {
      order.push('package');
      assert.deepEqual(opts, {
        sourceDir: '/ws/dumps',
        destDir: '/ws/pkg',
        snapshotId: ID,
        environment: 'development',
        sourceProjectRef: REF,
        supabaseCliVersion: PINNED_SUPABASE_CLI_VERSION,
        ageRecipient: RECIPIENT,
        agePath: '/bin/age',
        run,
        onProgress: undefined,
      });
      return { manifest: { snapshotId: ID }, contentSha256: 'a'.repeat(64) };
    },
  });
  assert.deepEqual(order, ['dump', 'package']);
});

test('backup: dump failure prevents package; package failure propagates', async () => {
  const executable = {
    ageBin: '/bin/age',
    supabasePath: '/cli/supabase',
    dockerPath: '/bin/docker',
  };
  let packaged = 0;
  await assert.rejects(
    () =>
      dumpAndPackageSnapshot({
        dbUrl: DB_URL,
        cwd: '/repo',
        outDir: '/ws/dumps',
        pkgDir: '/ws/pkg',
        snapshotId: ID,
        environment: 'development',
        sourceProjectRef: REF,
        ageRecipient: RECIPIENT,
        executables: executable,
        run: async () => {},
        doDump: async () => {
          throw new Error('dump exploded');
        },
        doPackage: async () => {
          packaged += 1;
        },
      }),
    /dump exploded/,
  );
  assert.equal(packaged, 0, 'package must never run after a dump failure');
  await assert.rejects(
    () =>
      dumpAndPackageSnapshot({
        dbUrl: DB_URL,
        cwd: '/repo',
        outDir: '/ws/dumps',
        pkgDir: '/ws/pkg',
        snapshotId: ID,
        environment: 'development',
        sourceProjectRef: REF,
        ageRecipient: RECIPIENT,
        executables: executable,
        run: async () => {},
        doDump: async () => {},
        doPackage: async () => {
          throw new Error('package exploded');
        },
      }),
    /package exploded/,
  );
});

test('backup: shared module never imports the R2 adapter or reads R2 credentials', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'backup.js'), 'utf8');
  assert.ok(
    !source.includes("'./r2.js'") && !source.includes("'../src/r2.js'"),
    'src/backup.js must not import r2.js',
  );
  for (const token of [
    'createS3Adapter',
    'headBucket',
    'uploadSnapshot',
    'deletePrefix',
    'R2_ACCESS',
    'R2_SECRET',
  ]) {
    assert.ok(!source.includes(token), `src/backup.js must not reference ${token}`);
  }
});
