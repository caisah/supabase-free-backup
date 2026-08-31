/**
 * Private local snapshot store: private root/environment dirs, per-environment
 * lock, read-only local-stack connectivity check, validated-snapshot scan,
 * and publish-before-retention finalization. No R2 adapter, no hosted DB, and
 * no stack lifecycle command may be reachable from this module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_BACKUP_DIRECTORY_NAME,
  LocalBackupError,
  assertLocalStackRunning,
  readLocalDatabaseState,
  openLocalBackupStore,
  scanLocalBackupSnapshots,
  createLocalBackupCandidate,
  finalizeLocalBackup,
} from './local-backup.js';
import { buildManifest, PLAINTEXT_ARTIFACTS, MANIFEST_NAME } from './snapshot.js';
import {
  tmpdir,
  writePrivateFile,
  sha256OfFile,
  AGE_RECIPIENT_1,
  AGE_RECIPIENT_2,
} from './test-fixtures.js';

const ENV = 'development';
const REF = 'a1b2c3d4e5f6a7b8c9d0';
const ID = '2026-08-24T03-17-09Z';
const ID_OLDER = '2026-08-23T03-17-09Z';
const ID_OLDEST = '2026-08-22T03-17-09Z';
const ID_OLDEST_2 = '2026-08-21T03-17-09Z';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validateFsArgs(opts) {
  return { dockerPath: '/bin/docker', dbContainer: 'supabase_db_fragtrack', run: opts.run };
}

function createdAt(id) {
  return `${id.slice(0, 10)}T${id.slice(11, 13)}:${id.slice(14, 16)}:${id.slice(17, 19)}Z`;
}

/** Build a full validated snapshot at `parent/<snapshotId>`. */
async function makeSnapshot(parent, snapshotId, overrides = {}) {
  const dir = path.join(parent, snapshotId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(dir, name), overrides.contents?.[name] ?? `content-of-${name}`);
    files.push({
      name,
      size: fs.statSync(path.join(dir, name)).size,
      sha256: await sha256OfFile(path.join(dir, name)),
      encrypted: name.startsWith('data.'),
    });
  }
  const manifest = buildManifest({
    environment: overrides.environment ?? ENV,
    sourceProjectRef: overrides.ref ?? REF,
    snapshotId,
    createdAt: createdAt(snapshotId),
    supabaseCliVersion: '2.114.0',
    contentSha256: overrides.contentSha256 ?? 'a'.repeat(64),
    encryption: { recipient: overrides.recipient ?? AGE_RECIPIENT_1 },
    files,
    dataParts: ['data.sql.gz.age.part-000'],
  });
  writePrivateFile(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, snapshotId, manifest };
}

function storeFor(root, environment = ENV) {
  return openLocalBackupStore({ repoRoot: root, environment });
}

test('local-backup: store creates private root and environment directories', () => {
  const root = tmpdir('bp-lb-store-');
  const store = storeFor(root);
  try {
    assert.equal(path.basename(store.root), LOCAL_BACKUP_DIRECTORY_NAME);
    assert.equal(path.dirname(store.environmentDir), store.root);
    assert.equal(path.basename(store.environmentDir), ENV);
    assert.equal(fs.statSync(store.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.environmentDir).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(store.lockPath));
    assert.equal(fs.statSync(store.lockPath).mode & 0o777, 0o600);
  } finally {
    store.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'local-backup: existing root and environment directories must already be private',
  { skip: process.platform === 'win32' },
  () => {
    const publicRoot = tmpdir('bp-lb-store-');
    const rootPath = path.join(publicRoot, LOCAL_BACKUP_DIRECTORY_NAME);
    fs.mkdirSync(rootPath, { mode: 0o700 });
    fs.chmodSync(rootPath, 0o755);
    assert.throws(
      () => storeFor(publicRoot),
      (err) => err instanceof LocalBackupError && /permissions/.test(err.message),
    );
    assert.ok(!fs.existsSync(path.join(rootPath, '.lock-development')));

    const publicEnvironment = tmpdir('bp-lb-store-');
    const privateRoot = path.join(publicEnvironment, LOCAL_BACKUP_DIRECTORY_NAME);
    const environmentPath = path.join(privateRoot, ENV);
    fs.mkdirSync(environmentPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(privateRoot, 0o700);
    fs.chmodSync(environmentPath, 0o777);
    assert.throws(
      () => storeFor(publicEnvironment),
      (err) => err instanceof LocalBackupError && /permissions/.test(err.message),
    );
    assert.ok(!fs.existsSync(path.join(privateRoot, '.lock-development')));

    fs.rmSync(publicRoot, { recursive: true, force: true });
    fs.rmSync(publicEnvironment, { recursive: true, force: true });
  },
);

test('local-backup: symlink or non-directory root/environment paths are rejected', () => {
  const root = tmpdir('bp-lb-store-');
  fs.mkdirSync(path.join(root, 'local-backups'), { mode: 0o700 });
  // Root exists as a file -> reject.
  const rootFile = tmpdir('bp-lb-store-');
  fs.writeFileSync(path.join(rootFile, 'local-backups'), 'not a dir');
  assert.throws(
    () => storeFor(rootFile),
    (err) => err instanceof LocalBackupError,
  );
  // Root exists as a symlink -> reject.
  const t2 = tmpdir('bp-lb-store-');
  const symlinkTarget = tmpdir('bp-lb-store-');
  fs.symlinkSync(symlinkTarget, path.join(t2, 'local-backups'));
  assert.throws(
    () => openLocalBackupStore({ repoRoot: t2, environment: ENV }),
    (err) => err instanceof LocalBackupError,
  );
  // Environment dir exists as a file -> reject.
  const envFile = tmpdir('bp-lb-store-');
  fs.mkdirSync(path.join(envFile, 'local-backups'), { mode: 0o700 });
  fs.writeFileSync(path.join(envFile, 'local-backups', ENV), 'not a dir');
  assert.throws(
    () => storeFor(envFile),
    (err) => err instanceof LocalBackupError,
  );
  // Root as a regular path with a child store: works.
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(rootFile, { recursive: true, force: true });
  fs.rmSync(envFile, { recursive: true, force: true });
  fs.rmSync(t2, { recursive: true, force: true });
  fs.rmSync(symlinkTarget, { recursive: true, force: true });
});

test('local-backup: same-environment lock excludes and releases; environments are independent', () => {
  const root = tmpdir('bp-lb-store-');
  const first = storeFor(root);
  try {
    assert.throws(
      () => storeFor(root),
      (err) => {
        assert.ok(err instanceof LocalBackupError);
        assert.ok(err.message.includes('.lock-development'), err.message);
        return true;
      },
    );
    // A different environment lock is never blocked.
    const second = openLocalBackupStore({ repoRoot: root, environment: 'production' });
    try {
      assert.ok(fs.existsSync(path.join(root, 'local-backups', '.lock-production')));
    } finally {
      second.release();
    }
  } finally {
    first.release();
  }
  // After release, the same environment can be locked again (idempotent release).
  const third = storeFor(root);
  third.release();
  third.release(); // idempotent
  const fourth = storeFor(root);
  fourth.release();
  assert.ok(!fs.existsSync(path.join(root, 'local-backups', '.lock-development')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('local-backup: release verifies ownership and never removes a replacement lock', () => {
  const root = tmpdir('bp-lb-store-');
  const first = storeFor(root);
  const originalLock = fs.readFileSync(first.lockPath, 'utf8');
  assert.ok(originalLock.length > 0, 'the lock carries an ownership token');

  fs.unlinkSync(first.lockPath);
  fs.writeFileSync(first.lockPath, 'replacement-owner', { mode: 0o600 });
  assert.throws(
    () => first.release(),
    (err) => err instanceof LocalBackupError && /ownership/.test(err.message),
  );
  assert.equal(fs.readFileSync(first.lockPath, 'utf8'), 'replacement-owner');

  fs.unlinkSync(first.lockPath);
  fs.rmSync(root, { recursive: true, force: true });
});

test('local-backup: setup failure after lock acquisition still releases the lock', () => {
  const root = tmpdir('bp-lb-store-');
  const first = storeFor(root);
  first.release();
  // Force a stale-candidate cleanup error AFTER the next open takes the lock.
  fs.symlinkSync(
    '/etc/hosts',
    path.join(root, 'local-backups', ENV, `.candidate-${'e'.repeat(16)}`),
  );
  assert.throws(
    () => storeFor(root),
    (err) => err instanceof LocalBackupError,
  );
  // The failed open must have released its lock.
  assert.ok(!fs.existsSync(path.join(root, 'local-backups', '.lock-development')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('local-backup: stale owned candidates are removed; symlinks and files are rejected', () => {
  const root = tmpdir('bp-lb-store-');
  const first = storeFor(root);
  first.release();
  const envDir = path.join(root, 'local-backups', ENV);
  const stale = path.join(envDir, `.candidate-${'d'.repeat(16)}`);
  fs.mkdirSync(stale, { mode: 0o700 });
  writePrivateFile(path.join(stale, 'pkg', 'roles.sql'), 'junk');
  const second = storeFor(root);
  try {
    assert.ok(!fs.existsSync(stale), 'canonical owned candidates are removed under lock');
  } finally {
    second.release();
  }
  // A real lookalike directory is user-owned: reject and preserve it.
  const lookalike = path.join(envDir, '.candidate-user-data');
  fs.mkdirSync(lookalike, { mode: 0o700 });
  writePrivateFile(path.join(lookalike, 'keep.txt'), 'keep');
  assert.throws(
    () => storeFor(root),
    (err) => err instanceof LocalBackupError,
  );
  assert.equal(fs.readFileSync(path.join(lookalike, 'keep.txt'), 'utf8'), 'keep');
  fs.rmSync(lookalike, { recursive: true, force: true });
  // A candidate symlink is rejected, never deleted.
  fs.symlinkSync('/tmp', path.join(envDir, '.candidate-link'));
  assert.throws(
    () => storeFor(root),
    (err) => err instanceof LocalBackupError,
  );
  assert.ok(fs.lstatSync(path.join(envDir, '.candidate-link')).isSymbolicLink());
  fs.unlinkSync(path.join(envDir, '.candidate-link'));
  // A candidate file is rejected, never deleted.
  writePrivateFile(path.join(envDir, '.candidate-file'), 'x');
  assert.throws(
    () => storeFor(root),
    (err) => err instanceof LocalBackupError,
  );
  assert.ok(fs.existsSync(path.join(envDir, '.candidate-file')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('local-backup: assertLocalStackRunning is read-only and requires the exact SELECT 1', async () => {
  const calls = [];
  const run = async ({ command, args }) => {
    calls.push({ command, args });
    if (args.includes('cant-write')) throw new Error('no such command');
    return { stdout: '1\n' };
  };
  await assertLocalStackRunning(validateFsArgs({ run }));
  assert.equal(calls.length, 1);
  assert.equal(path.basename(calls[0].command), 'docker');
  assert.deepEqual(calls[0].args.slice(0, 3), ['exec', 'supabase_db_fragtrack', 'psql']);
  const joined = calls[0].args.join(' ');
  for (const lifecycle of ['start', 'stop', 'reset', 'db reset', 'migrate']) {
    assert.ok(!joined.includes(lifecycle), `must not invoke lifecycle command ${lifecycle}`);
  }
  // Offline stack: connection failure surfaces a static LocalBackupError.
  await assert.rejects(
    () =>
      assertLocalStackRunning({
        dockerPath: '/bin/docker',
        dbContainer: 'supabase_db_fragtrack',
        run: async () => {
          throw new Error('container not running');
        },
      }),
    (err) => {
      assert.ok(err instanceof LocalBackupError);
      assert.match(err.message, /start the local stack/);
      assert.ok(err.cause, 'connection failure must keep its cause');
      return true;
    },
  );
  // Unexpected result is offline too.
  await assert.rejects(
    () =>
      assertLocalStackRunning({
        dockerPath: '/bin/docker',
        dbContainer: 'supabase_db_fragtrack',
        run: async () => ({ stdout: '0\n' }),
      }),
    (err) => err instanceof LocalBackupError && /start the local stack/.test(err.message),
  );
});

test('local-backup: database state token covers mutations, relations, sequences, and roles', async () => {
  const calls = [];
  const state =
    '00000000000000000000000000000000|0123456789abcdef0123456789abcdef|11111111111111111111111111111111|22222222222222222222222222222222';
  const result = await readLocalDatabaseState({
    dockerPath: '/bin/docker',
    dbContainer: 'supabase_db_fragtrack',
    run: async (opts) => {
      calls.push(opts);
      return { stdout: `${state}\n` };
    },
  });
  assert.equal(result, state);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /pg_stat_all_tables/);
  assert.match(calls[0].args.at(-1), /pg_relation_size/);
  assert.match(calls[0].args.at(-1), /catalog_state/);
  assert.match(calls[0].args.at(-1), /pg_sequences/);
  assert.match(calls[0].args.at(-1), /pg_roles/);

  await assert.rejects(
    () =>
      readLocalDatabaseState({
        dockerPath: '/bin/docker',
        dbContainer: 'supabase_db_fragtrack',
        run: async () => ({ stdout: 'malformed-state\n' }),
      }),
    (err) => err instanceof LocalBackupError && err.stage === 'consistency',
  );
});

test('local-backup: scan returns valid snapshots newest first and ignores nothing', async () => {
  const root = tmpdir('bp-lb-scan-');
  const store = storeFor(root);
  try {
    assert.deepEqual(
      await scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
      [],
    );
    await makeSnapshot(store.environmentDir, ID_OLDER, { contentSha256: 'a'.repeat(64) });
    await makeSnapshot(store.environmentDir, ID, { contentSha256: 'b'.repeat(64) });
    await makeSnapshot(store.environmentDir, ID_OLDEST, { contentSha256: 'c'.repeat(64) });
    const scanned = await scanLocalBackupSnapshots({
      environmentDir: store.environmentDir,
      environment: ENV,
    });
    assert.deepEqual(
      scanned.map((s) => s.snapshotId),
      [ID, ID_OLDER, ID_OLDEST],
    );
    for (const s of scanned) assert.ok(fs.existsSync(path.join(s.dir, MANIFEST_NAME)));
  } finally {
    store.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'local-backup: scan rejects completed snapshots with unsafe modes',
  { skip: process.platform === 'win32' },
  async () => {
    const root = tmpdir('bp-lb-scan-');
    const store = storeFor(root);
    try {
      const snapshot = await makeSnapshot(store.environmentDir, ID);
      fs.chmodSync(snapshot.dir, 0o755);
      await assert.rejects(
        () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
        (err) => err instanceof LocalBackupError && /permissions/.test(err.message),
      );

      fs.chmodSync(snapshot.dir, 0o700);
      fs.chmodSync(path.join(snapshot.dir, 'roles.sql'), 0o644);
      await assert.rejects(
        () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
        (err) => err instanceof LocalBackupError && /permissions/.test(err.message),
      );
    } finally {
      store.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('local-backup: scan rejects malformed, mismatched, unknown, and symlink entries', async () => {
  const root = tmpdir('bp-lb-scan-');
  const store = storeFor(root);
  try {
    // Malformed manifest (tampered).
    const good = await makeSnapshot(store.environmentDir, ID);
    fs.appendFileSync(path.join(good.dir, MANIFEST_NAME), '{"tampered":true}');
    await assert.rejects(
      () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
      (err) => err instanceof LocalBackupError || err.name === 'SnapshotError',
    );
    fs.rmSync(good.dir, { recursive: true, force: true });

    // Environment mismatch.
    await makeSnapshot(store.environmentDir, ID, { environment: 'production' });
    await assert.rejects(
      () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
      (err) => err instanceof LocalBackupError || err.name === 'SnapshotError',
    );
    const mismatch = path.join(store.environmentDir, ID);
    fs.rmSync(mismatch, { recursive: true, force: true });

    // Non-canonical directory.
    fs.mkdirSync(path.join(store.environmentDir, 'not-a-snapshot'), { mode: 0o700 });
    await assert.rejects(
      () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
      (err) => err instanceof LocalBackupError,
    );
    fs.rmdirSync(path.join(store.environmentDir, 'not-a-snapshot'));

    // Unknown file.
    writePrivateFile(path.join(store.environmentDir, 'notes.txt'), 'x');
    await assert.rejects(
      () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
      (err) => err instanceof LocalBackupError,
    );
    fs.unlinkSync(path.join(store.environmentDir, 'notes.txt'));

    // Unknown directory.
    fs.mkdirSync(path.join(store.environmentDir, 'random-dir'), { mode: 0o700 });
    await assert.rejects(
      () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
      (err) => err instanceof LocalBackupError,
    );
    fs.rmdirSync(path.join(store.environmentDir, 'random-dir'));

    // Symlink into a snapshot-shaped name.
    fs.symlinkSync(good.dir, path.join(store.environmentDir, ID));
    await assert.rejects(
      () => scanLocalBackupSnapshots({ environmentDir: store.environmentDir, environment: ENV }),
      (err) => err instanceof LocalBackupError,
    );
  } finally {
    store.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function finalizeFixture({
  newestSha,
  olderCount = 0,
  candidateSha,
  candidateRef,
  candidateRecipient,
}) {
  const root = tmpdir('bp-lb-final-');
  const store = storeFor(root);
  const older = [];
  for (let i = 0; i < olderCount; i++) {
    const id = [ID_OLDEST, ID_OLDEST_2][i];
    older.push(await makeSnapshot(store.environmentDir, id, { contentSha256: 'z'.repeat(64) }));
  }
  const newest = await makeSnapshot(store.environmentDir, ID_OLDER, {
    contentSha256: newestSha,
    ref: REF,
    recipient: AGE_RECIPIENT_1,
  });
  const candidate = createLocalBackupCandidate({ environmentDir: store.environmentDir });
  fs.mkdirSync(candidate.pkgDir, { mode: 0o700 });
  writePrivateFile(path.join(candidate.pkgDir, 'roles.sql'), 'candidate-roles');
  const candidateManifest = {
    contentSha256: candidateSha,
    sourceProjectRef: candidateRef ?? REF,
    encryption: { recipient: candidateRecipient ?? AGE_RECIPIENT_1 },
  };
  return { root, store, newest, older, candidate, candidateManifest };
}

async function publish(f, { snapshotId = ID, removeSnapshot, syncSnapshot, syncDirectory } = {}) {
  return finalizeLocalBackup({
    candidate: f.candidate,
    candidateManifest: f.candidateManifest,
    existingSnapshots: [f.newest, ...f.older].map((s) => ({
      dir: s.dir,
      snapshotId: s.snapshotId,
      manifest: s.manifest,
    })),
    environmentDir: f.store.environmentDir,
    snapshotId,
    removeSnapshot,
    syncSnapshot,
    syncDirectory,
  });
}

test('local-backup: unchanged keeps the prior ID and removes only older validated snapshots', async () => {
  const f = await finalizeFixture({
    newestSha: 'a'.repeat(64),
    olderCount: 1,
    candidateSha: 'a'.repeat(64),
  });
  try {
    const result = await publish(f);
    assert.equal(result.changed, false);
    assert.equal(result.snapshotId, ID_OLDER);
    assert.equal(result.path, f.newest.dir);
    assert.ok(fs.existsSync(f.newest.dir), 'newest remains');
    assert.ok(!fs.existsSync(f.older[0].dir), 'older validated snapshot removed');
    assert.ok(fs.existsSync(f.candidate.pkgDir), 'candidate stays unpublished for caller cleanup');
  } finally {
    f.store.release();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('local-backup: hash, recipient, or target-ref change publishes a new snapshot', async () => {
  for (const [label, candidateOverride] of [
    ['hash', { candidateSha: 'b'.repeat(64) }],
    ['recipient', { candidateRecipient: AGE_RECIPIENT_2 }],
    ['targetRef', { candidateRef: 'f0e9d8c7b6a5f4e3d2c1' }],
  ]) {
    const f = await finalizeFixture({
      newestSha: 'a'.repeat(64),
      olderCount: 0,
      candidateSha: 'a'.repeat(64),
      ...candidateOverride,
    });
    try {
      const result = await publish(f);
      assert.equal(result.changed, true, label);
      assert.equal(result.snapshotId, ID);
      assert.equal(result.path, path.join(f.store.environmentDir, ID));
      assert.ok(fs.existsSync(result.path), label);
    } finally {
      f.store.release();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('local-backup: publication is durable before retention starts', async () => {
  const f = await finalizeFixture({
    newestSha: 'a'.repeat(64),
    olderCount: 0,
    candidateSha: 'b'.repeat(64),
  });
  const events = [];
  let parentSyncs = 0;
  try {
    const result = await publish(f, {
      syncSnapshot: (dir) => {
        assert.equal(dir, f.candidate.pkgDir);
        assert.ok(fs.existsSync(dir), 'candidate exists while its files are synced');
        events.push('sync-snapshot');
      },
      syncDirectory: (dir) => {
        assert.equal(dir, f.store.environmentDir);
        parentSyncs += 1;
        assert.ok(fs.existsSync(path.join(dir, ID)), 'new snapshot exists before parent sync');
        if (parentSyncs === 1) {
          assert.ok(
            fs.existsSync(f.newest.dir),
            'old snapshot remains until publication is durable',
          );
        }
        events.push(`sync-parent-${parentSyncs}`);
      },
      removeSnapshot: async (dir) => {
        events.push('remove-old');
        fs.rmSync(dir, { recursive: true, force: true });
      },
    });
    assert.equal(result.changed, true);
    assert.deepEqual(events, ['sync-snapshot', 'sync-parent-1', 'remove-old', 'sync-parent-2']);
  } finally {
    f.store.release();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('local-backup: post-publication sync failure preserves the old snapshot', async () => {
  const f = await finalizeFixture({ newestSha: 'a'.repeat(64), candidateSha: 'b'.repeat(64) });
  try {
    await assert.rejects(
      () =>
        publish(f, {
          syncSnapshot: () => {},
          syncDirectory: () => {
            throw new Error('parent sync exploded');
          },
        }),
      /parent sync exploded/,
    );
    assert.ok(fs.existsSync(path.join(f.store.environmentDir, ID)), 'new snapshot remains present');
    assert.ok(
      fs.existsSync(f.newest.dir),
      'old snapshot is not removed before durable publication',
    );
    assert.ok(f.candidate.published, 'published output is never candidate-cleaned');
  } finally {
    f.store.release();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('local-backup: publication deletes every old snapshot after rename', async () => {
  const f = await finalizeFixture({
    newestSha: 'a'.repeat(64),
    olderCount: 1,
    candidateSha: 'b'.repeat(64),
  });
  try {
    const result = await publish(f);
    assert.equal(result.changed, true);
    assert.ok(!fs.existsSync(f.newest.dir), 'newest old snapshot removed after publish');
    assert.ok(!fs.existsSync(f.older[0].dir), 'older removed after publish');
  } finally {
    f.store.release();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('local-backup: collision never overwrites or deletes', async () => {
  const f = await finalizeFixture({ newestSha: 'a'.repeat(64), candidateSha: 'b'.repeat(64) });
  // Receive the canonical ID again: an identical snapshot dir already exists.
  await makeSnapshot(f.store.environmentDir, ID, { contentSha256: 'c'.repeat(64) });
  const markerPath = path.join(f.store.environmentDir, ID, 'roles.sql');
  const marker = fs.readFileSync(markerPath, 'utf8');
  try {
    await assert.rejects(
      () => publish(f, { snapshotId: ID }),
      (err) => {
        assert.ok(err instanceof LocalBackupError);
        assert.match(err.message, /overwrite/);
        return true;
      },
    );
    assert.ok(fs.existsSync(f.newest.dir), 'older snapshots remain on collision');
    assert.equal(
      fs.readFileSync(markerPath, 'utf8'),
      marker,
      'existing snapshot untouched by the refused collision',
    );
    assert.ok(!f.candidate.published, 'candidate never published on collision');
  } finally {
    f.store.release();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('local-backup: injected retention failure leaves the newly published snapshot present', async () => {
  const f = await finalizeFixture({
    newestSha: 'a'.repeat(64),
    olderCount: 1,
    candidateSha: 'b'.repeat(64),
  });
  try {
    await assert.rejects(
      () =>
        publish(f, {
          removeSnapshot: async () => {
            throw new Error('retention exploded');
          },
        }),
      /retention exploded/,
    );
    assert.ok(
      fs.existsSync(path.join(f.store.environmentDir, ID)),
      'new output survives retention failure',
    );
    assert.ok(f.candidate.published, 'candidate must be marked published after rename');
  } finally {
    f.store.release();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('local-backup: unchanged branches never delete the candidate and remove only older snapshots', async () => {
  const f = await finalizeFixture({
    newestSha: 'a'.repeat(64),
    olderCount: 2,
    candidateSha: 'a'.repeat(64),
  });
  // older[0] (ID_OLDER) and older[1] (ID_OLDER-x) are both older than ID.
  try {
    const result = await publish(f);
    assert.equal(result.changed, false);
    assert.ok(!fs.existsSync(f.older[0].dir));
    assert.ok(!fs.existsSync(f.older[1].dir));
  } finally {
    f.store.release();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('local-backup: no cross-environment reads, locks, or deletion', async () => {
  const root = tmpdir('bp-lb-store-');
  const dev = storeFor(root, 'development');
  const prod = openLocalBackupStore({ repoRoot: root, environment: 'production' });
  try {
    await makeSnapshot(dev.environmentDir, ID, { contentSha256: 'a'.repeat(64) });
    const devScanned = await scanLocalBackupSnapshots({
      environmentDir: dev.environmentDir,
      environment: 'development',
    });
    assert.equal(devScanned.length, 1);
    const prodScanned = await scanLocalBackupSnapshots({
      environmentDir: prod.environmentDir,
      environment: 'production',
    });
    assert.deepEqual(prodScanned, [], 'production must not see development snapshots');
    // Finalizing production never touches the development directory.
    const candidate = createLocalBackupCandidate({ environmentDir: prod.environmentDir });
    fs.mkdirSync(candidate.pkgDir, { mode: 0o700 });
    writePrivateFile(path.join(candidate.pkgDir, 'roles.sql'), 'x');
    const result = await finalizeLocalBackup({
      candidate,
      candidateManifest: {
        contentSha256: 'b'.repeat(64),
        sourceProjectRef: REF,
        encryption: { recipient: AGE_RECIPIENT_1 },
      },
      existingSnapshots: [],
      environmentDir: prod.environmentDir,
      snapshotId: ID,
    });
    assert.equal(result.changed, true);
    const devAfter = fs.readdirSync(dev.environmentDir);
    assert.ok(
      devAfter.includes(ID) && devAfter.length === 1,
      'development snapshots untouched by production publication',
    );
  } finally {
    dev.release();
    prod.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local-backup: module and candidate helpers generate unique private candidates', () => {
  const root = tmpdir('bp-lb-');
  const store = storeFor(root);
  try {
    const a = createLocalBackupCandidate({ environmentDir: store.environmentDir });
    const b = createLocalBackupCandidate({ environmentDir: store.environmentDir });
    assert.notEqual(a.candidateDir, b.candidateDir);
    assert.equal(fs.statSync(a.candidateDir).mode & 0o777, 0o700);
    assert.ok(!fs.existsSync(a.pkgDir), 'pkgDir stays owned by packageSnapshot');
    assert.equal(path.dirname(a.pkgDir), a.candidateDir);
  } finally {
    store.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local-backup: source files never reference the R2 adapter or read R2 credentials', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'local-backup.js'), 'utf8');
  assert.ok(!source.includes('r2.js'), 'src/local-backup.js must not import r2.js');
  for (const token of [
    'createS3Adapter',
    'headBucket',
    'uploadSnapshot',
    'deletePrefix',
    'R2_ACCESS',
    'R2_SECRET',
  ]) {
    assert.ok(!source.includes(token), `src/local-backup.js must not reference ${token}`);
  }
  assert.ok(source.includes('LocalBackupError'));
});
