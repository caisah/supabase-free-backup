import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  scanRepositorySnapshots,
  planWeekly,
  copyStagedSnapshot,
  loadStagedSnapshots,
  RepositoryError,
} from './repository.js';
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

async function makeSnapshot(root, snapshotId = ID, overrides = {}) {
  const dir = path.join(root, snapshotId);
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
    sourceProjectRef: REF,
    snapshotId,
    createdAt: new Date(
      `${snapshotId.slice(0, 10)}T${snapshotId.slice(11, 13)}:${snapshotId.slice(14, 16)}:${snapshotId.slice(17, 19)}Z`,
    ).toISOString(),
    supabaseCliVersion: '2.114.0',
    contentSha256: overrides.contentSha256 ?? 'a'.repeat(64),
    encryption: { recipient: overrides.recipient ?? AGE_RECIPIENT_1 },
    files,
    dataParts: ['data.sql.gz.age.part-000'],
  });
  writePrivateFile(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, snapshotId, manifest };
}

function repoWithBackups(root) {
  const backups = path.join(root, 'backups', ENV);
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  return backups;
}

async function stagingDirFixture(root, envContents = {}) {
  const staging = path.join(root, 'staging');
  for (const [env, id] of Object.entries(envContents)) {
    const dir = path.join(staging, env, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
      writePrivateFile(path.join(dir, name), `staged-${env}-${name}`);
    }
    const files = [];
    for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
      files.push({
        name,
        size: fs.statSync(path.join(dir, name)).size,
        sha256: await sha256OfFile(path.join(dir, name)),
        encrypted: name.startsWith('data.'),
      });
    }
    const manifest = buildManifest({
      environment: env,
      sourceProjectRef: REF,
      snapshotId: id,
      createdAt: new Date(
        `${id.slice(0, 10)}T${id.slice(11, 13)}:${id.slice(14, 16)}:${id.slice(17, 19)}Z`,
      ).toISOString(),
      supabaseCliVersion: '2.114.0',
      contentSha256: 'b'.repeat(64),
      encryption: { recipient: AGE_RECIPIENT_1 },
      files,
      dataParts: ['data.sql.gz.age.part-000'],
    });
    writePrivateFile(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return staging;
}

test('repository: empty repository accepts first development and production staged snapshots', async () => {
  const root = tmpdir('bp-repo-');
  const stagingDir = await stagingDirFixture(root, {
    development: '2026-08-24T03-17-09Z',
    production: '2026-08-24T03-17-09Z',
  });
  const staged = await loadStagedSnapshots({ stagingDir: stagingDir });
  assert.ok(staged.development);
  assert.ok(staged.production);

  const repos = repoWithBackups(root);
  const existingDev = (
    await scanRepositorySnapshots({ repoRoot: root, environment: 'development' })
  ).snapshots;
  assert.equal(existingDev.length, 0);
  assert.ok(fs.existsSync(repos));
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: identical staged snapshot is skipped', async () => {
  const root = tmpdir('bp-repo-');
  const backups = repoWithBackups(root);
  const { manifest } = await makeSnapshot(backups, '2026-08-23T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
  });
  const plan = planWeekly({
    existing: { snapshotId: '2026-08-23T03-17-09Z', manifest },
    staged: { snapshotId: '2026-08-24T03-17-09Z', manifest },
  });
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /identical/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: different fingerprint creates a dated directory', async () => {
  const root = tmpdir('bp-repo-');
  const backups = repoWithBackups(root);
  const existing = await makeSnapshot(backups, '2026-08-23T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
  });
  const staged = await makeSnapshot(root, '2026-08-24T03-17-09Z', {
    contentSha256: 'b'.repeat(64),
  });
  const plan = planWeekly({ existing, staged });
  assert.equal(plan.action, 'add');
  const dest = await copyStagedSnapshot({
    stagingDir: staged.dir,
    repoRoot: root,
    environment: ENV,
    manifest: staged.manifest,
    snapshotId: staged.snapshotId,
  });
  assert.ok(fs.existsSync(path.join(dest, MANIFEST_NAME)));
  assert.ok(fs.existsSync(path.join(dest, 'data.sql.gz.age.part-000')));
  const scanned = await scanRepositorySnapshots({ repoRoot: root, environment: ENV });
  assert.equal(scanned.snapshots.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: different recipient creates a dated directory even with same logical content', async () => {
  const root = tmpdir('bp-repo-');
  const backups = repoWithBackups(root);
  const existing = await makeSnapshot(backups, '2026-08-23T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
    recipient: AGE_RECIPIENT_1,
  });
  const staged = await makeSnapshot(root, '2026-08-24T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
    recipient: AGE_RECIPIENT_2,
  });
  const plan = planWeekly({ existing, staged });
  assert.equal(plan.action, 'add');
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: environments are planned independently', async () => {
  const root = tmpdir('bp-repo-');
  const devBackups = path.join(root, 'backups', 'development');
  fs.mkdirSync(devBackups, { recursive: true, mode: 0o700 });
  const prodBackups = path.join(root, 'backups', 'production');
  fs.mkdirSync(prodBackups, { recursive: true, mode: 0o700 });
  const devExisting = await makeSnapshot(devBackups, '2026-08-23T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
  });
  const prodExisting = await makeSnapshot(prodBackups, '2026-08-23T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
  });

  const devStaged = await makeSnapshot(root, '2026-08-24T03-17-09Z', {
    contentSha256: 'b'.repeat(64),
  });
  const prodStaged = await makeSnapshot(root, '2026-08-24T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
  });

  assert.equal(planWeekly({ existing: devExisting, staged: devStaged }).action, 'add');
  assert.equal(planWeekly({ existing: prodExisting, staged: prodStaged }).action, 'skip');
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: malformed existing snapshots are never selected', async () => {
  const root = tmpdir('bp-repo-');
  const backups = repoWithBackups(root);
  await makeSnapshot(backups, '2026-08-23T03-17-09Z', { contentSha256: 'a'.repeat(64) });
  // Malformed newer directory: no manifest.
  const bad = path.join(backups, '2026-08-24T03-17-09Z');
  fs.mkdirSync(bad, { mode: 0o700 });
  writePrivateFile(path.join(bad, 'roles.sql'), 'orphan file');
  // Non-canonical directory name.
  fs.mkdirSync(path.join(backups, 'just-some-dir'), { mode: 0o700 });

  const { snapshots, warnings } = await scanRepositorySnapshots({
    repoRoot: root,
    environment: ENV,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].snapshotId, '2026-08-23T03-17-09Z');
  assert.ok(warnings.length >= 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: malformed staged snapshot fails before any copy', async () => {
  const root = tmpdir('bp-repo-');
  repoWithBackups(root);
  const staging = path.join(root, 'staging', ENV, '2026-08-24T03-17-09Z');
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  writePrivateFile(path.join(staging, 'roles.sql'), 'only one file, no manifest');
  await assert.rejects(
    () => loadStagedSnapshots({ stagingDir: path.join(root, 'staging') }),
    (err) => err instanceof RepositoryError || err.name === 'SnapshotError',
  );
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'backups', ENV)).filter((e) => !e.startsWith('.')),
    [],
    'nothing may be copied from a malformed staged snapshot',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: hash mismatch fails and removes the partial destination', async () => {
  const root = tmpdir('bp-repo-');
  repoWithBackups(root);
  const staged = await makeSnapshot(root, '2026-08-24T03-17-09Z', {
    contentSha256: 'b'.repeat(64),
  });
  // Tamper the staged snapshot's source file so post-copy verification fails.
  fs.appendFileSync(path.join(staged.dir, 'roles.sql'), '-- tampered');
  await assert.rejects(
    () =>
      copyStagedSnapshot({
        stagingDir: staged.dir,
        repoRoot: root,
        environment: ENV,
        manifest: staged.manifest,
        snapshotId: staged.snapshotId,
      }),
    (err) => err instanceof RepositoryError && /roles\.sql/.test(err.message),
  );
  assert.ok(
    !fs.existsSync(path.join(root, 'backups', ENV, '2026-08-24T03-17-09Z')),
    'no partial destination',
  );
  assert.ok(
    !fs.readdirSync(path.join(root, 'backups', ENV)).some((e) => e.startsWith('.tmp-')),
    'temp copy removed',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: collision fails without overwrite', async () => {
  const root = tmpdir('bp-repo-');
  const backups = repoWithBackups(root);
  const existing = await makeSnapshot(backups, '2026-08-24T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
  });
  const staged = await makeSnapshot(root, '2026-08-24T03-17-09Z', {
    contentSha256: 'b'.repeat(64),
  });
  await assert.rejects(
    () =>
      copyStagedSnapshot({
        stagingDir: staged.dir,
        repoRoot: root,
        environment: ENV,
        manifest: staged.manifest,
        snapshotId: staged.snapshotId,
      }),
    (err) => err instanceof RepositoryError && /already exists/.test(err.message),
  );
  const marker = fs.readFileSync(path.join(existing.dir, 'roles.sql'), 'utf8');
  assert.ok(marker.includes('content-of-'), 'existing snapshot untouched');
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: older staged snapshot is rejected', async () => {
  const existing = {
    snapshotId: '2026-08-24T03-17-09Z',
    manifest: { contentSha256: 'a'.repeat(64), encryption: { recipient: AGE_RECIPIENT_1 } },
  };
  const staged = {
    snapshotId: '2026-08-23T03-17-09Z',
    manifest: { contentSha256: 'b'.repeat(64), encryption: { recipient: AGE_RECIPIENT_1 } },
  };
  assert.equal(planWeekly({ existing, staged }).action, 'reject');
});

test('repository: traversal, symlink, and unknown-file staged snapshots fail', async () => {
  const root = tmpdir('bp-repo-');
  repoWithBackups(root);
  const staging = path.join(root, 'staging', ENV, '2026-08-24T03-17-09Z');
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(staging, name), 'x');
  }
  // Symlink instead of a real manifest breaks directory validation.
  fs.symlinkSync('/etc/hosts', path.join(staging, MANIFEST_NAME));
  await assert.rejects(() => loadStagedSnapshots({ stagingDir: path.join(root, 'staging') }));
  fs.rmSync(path.join(staging, MANIFEST_NAME));

  // Extra unknown file in the staging directory fails validation.
  writePrivateFile(path.join(staging, 'evil.sh'), 'rm -rf /');
  const manifest = (await makeSnapshot(root, '2026-08-24T03-17-09Z')).manifest;
  fs.writeFileSync(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    () => loadStagedSnapshots({ stagingDir: path.join(root, 'staging') }),
    /evil\.sh|UNEXPECTED/i,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('repository: scanner treats the repository layout as untrusted', async () => {
  const root = tmpdir('bp-repo-');
  const backups = repoWithBackups(root);
  // A stray file (not a directory) is warned, never selected.
  writePrivateFile(path.join(backups, 'notes.txt'), 'not a snapshot');
  const { snapshots, warnings } = await scanRepositorySnapshots({
    repoRoot: root,
    environment: ENV,
  });
  assert.equal(snapshots.length, 0);
  assert.ok(warnings.some((w) => w.includes('notes.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});
