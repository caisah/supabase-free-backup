import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWeeklyCommit, validateRepositoryRoot, assertBranchMaster } from './commit-weekly.js';
import { buildManifest, PLAINTEXT_ARTIFACTS, MANIFEST_NAME } from '../src/snapshot.js';
import { RepositoryError } from '../src/repository.js';
import { tmpdir, writePrivateFile, sha256OfFile, AGE_RECIPIENT_1 } from '../src/test-fixtures.js';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runCli(name, args) {
  const script = fileURLToPath(new URL('./' + name + '.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

const REF = 'a1b2c3d4e5f6a7b8c9d0';

async function makeSnapshotDir(
  dir,
  snapshotId,
  {
    contentSha256 = 'a'.repeat(64),
    recipient = AGE_RECIPIENT_1,
    contents,
    environment = 'development',
  } = {},
) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(dir, name), contents?.[name] ?? `content-${name}`);
    files.push({
      name,
      size: fs.statSync(path.join(dir, name)).size,
      sha256: await sha256OfFile(path.join(dir, name)),
      encrypted: name.startsWith('data.'),
    });
  }
  const manifest = buildManifest({
    environment,
    sourceProjectRef: REF,
    snapshotId,
    createdAt: new Date(
      `${snapshotId.slice(0, 10)}T${snapshotId.slice(11, 13)}:${snapshotId.slice(14, 16)}:${snapshotId.slice(17, 19)}Z`,
    ).toISOString(),
    supabaseCliVersion: '2.114.0',
    contentSha256,
    encryption: { recipient },
    files,
    dataParts: ['data.sql.gz.age.part-000'],
  });
  writePrivateFile(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Root with a fake .git pointing at master, and backups/ for both envs. */
function gitRepoRoot(prefix) {
  const root = tmpdir(prefix);
  fs.mkdirSync(path.join(root, '.git'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  for (const env of ['development', 'production']) {
    fs.mkdirSync(path.join(root, 'backups', env), { recursive: true, mode: 0o700 });
  }
  return root;
}

function makeStagedSnapshot(stagingDir, env, snapshotId, opts = {}) {
  const dir = path.join(stagingDir, env, snapshotId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return makeSnapshotDir(dir, snapshotId, { ...opts, environment: env });
}

const silentLogger = () => ({
  addSecret: () => {},
  status: () => {},
  warn: () => {},
  error: () => {},
  redact: (t) => t,
});

/** Capturing writable injected through deps.stdOut (no process.stdout patching). */
function captureStream() {
  let out = '';
  return {
    stream: {
      write: (chunk) => {
        out += String(chunk);
        return true;
      },
    },
    out: () => out,
  };
}

test('commit-weekly: empty repository commits first staged snapshots for both environments', async () => {
  const root = gitRepoRoot('bp-weekly-');
  const stagingDir = path.join(root, 'staging');
  await makeStagedSnapshot(stagingDir, 'development', '2026-08-24T03-17-09Z');
  await makeStagedSnapshot(stagingDir, 'production', '2026-08-24T03-17-09Z');
  const captured = captureStream();
  const result = await runWeeklyCommit({
    options: { stagingDir, repoRoot: root },
    env: {},
    logger: silentLogger(),
    deps: { stdOut: captured.stream },
  });
  assert.equal(result.changed, true);
  assert.equal(result.results.development.action, 'add');
  assert.equal(result.results.production.action, 'add');
  assert.ok(
    fs.existsSync(path.join(root, 'backups', 'development', '2026-08-24T03-17-09Z', MANIFEST_NAME)),
  );
  assert.ok(
    fs.existsSync(path.join(root, 'backups', 'production', '2026-08-24T03-17-09Z', MANIFEST_NAME)),
  );
  assert.ok(captured.out().includes('weekly: changed=true'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: a later-environment failure removes files copied by earlier environments', async () => {
  const repoRoot = gitRepoRoot('bp-weekly-');
  const stagingDir = tmpdir('bp-weekly-staging-');
  const devId = '2026-08-24T03-17-09Z';
  // Development has a NEW staged snapshot to commit...
  await makeStagedSnapshot(stagingDir, 'development', devId);
  // ...while production's staged snapshot is older than its newest committed
  // snapshot: planWeekly rejects, which fails the run AFTER development
  // already copied its files into backups/development/<id>.
  const newerId = '2026-08-25T03-17-09Z';
  await makeSnapshotDir(path.join(repoRoot, 'backups', 'production', newerId), newerId, {
    environment: 'production',
  });
  await makeStagedSnapshot(stagingDir, 'production', '2026-08-24T03-17-09Z', {
    environment: 'production',
  });
  const logger = silentLogger();
  await assert.rejects(
    () =>
      runWeeklyCommit({
        options: { stagingDir, repoRoot },
        env: {},
        logger,
        deps: {},
      }),
    (err) => err instanceof RepositoryError,
  );
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'backups', 'development', devId)),
    'the partially applied development copy must be rolled back',
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
});

test('commit-weekly: unchanged rerun is idempotent and reports changed=false', async () => {
  const root = gitRepoRoot('bp-weekly-');
  const stagingDir = path.join(root, 'staging');
  await makeStagedSnapshot(stagingDir, 'development', '2026-08-24T03-17-09Z');
  await makeStagedSnapshot(stagingDir, 'production', '2026-08-24T03-17-09Z');
  const captured = captureStream();
  const options = { stagingDir, repoRoot: root };
  const first = await runWeeklyCommit({
    options,
    env: {},
    logger: silentLogger(),
    deps: { stdOut: captured.stream },
  });
  assert.equal(first.changed, true);
  const second = await runWeeklyCommit({
    options,
    env: {},
    logger: silentLogger(),
    deps: { stdOut: captured.stream },
  });
  assert.equal(second.changed, false);
  assert.equal(second.results.development.action, 'skip');
  assert.equal(second.results.production.action, 'skip');
  assert.ok(second.results.development.reason.includes('already committed'));
  assert.ok(captured.out().includes('weekly: changed=false'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: changed development commits while unchanged production skips', async () => {
  const root = gitRepoRoot('bp-weekly-');
  const stagingDir = path.join(root, 'staging');
  // Existing commits.
  for (const env of ['development', 'production']) {
    await makeSnapshotDir(
      path.join(root, 'backups', env, '2026-08-17T03-17-09Z'),
      '2026-08-17T03-17-09Z',
      { environment: env },
    );
  }
  // Development changed, production identical.
  await makeStagedSnapshot(stagingDir, 'development', '2026-08-24T03-17-09Z', {
    contentSha256: 'b'.repeat(64),
  });
  await makeStagedSnapshot(stagingDir, 'production', '2026-08-24T03-17-09Z', {
    contentSha256: 'a'.repeat(64),
  });
  const result = await runWeeklyCommit({
    options: { stagingDir, repoRoot: root },
    env: {},
    logger: silentLogger(),
  });
  assert.equal(result.results.development.action, 'add');
  assert.equal(result.results.production.action, 'skip');
  assert.equal(result.changed, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: output never reveals SQL contents or secrets', async () => {
  const root = gitRepoRoot('bp-weekly-');
  const stagingDir = path.join(root, 'staging');
  await makeStagedSnapshot(stagingDir, 'development', '2026-08-24T03-17-09Z', {
    contents: { 'roles.sql': '-- SECRET-ROW-DATA\n' },
  });
  const captured = captureStream();
  await runWeeklyCommit({
    options: { stagingDir, repoRoot: root },
    env: {},
    logger: silentLogger(),
    deps: { stdOut: captured.stream },
  });
  assert.ok(!captured.out().includes('SECRET-ROW-DATA'));
  assert.ok(!captured.out().includes('content-'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: rejects non-master branches without changing anything', async () => {
  const root = gitRepoRoot('bp-weekly-');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-x\n');
  const stagingDir = path.join(root, 'staging');
  await makeStagedSnapshot(stagingDir, 'development', '2026-08-24T03-17-09Z');
  await assert.rejects(
    () =>
      runWeeklyCommit({
        options: { stagingDir, repoRoot: root },
        env: {},
        logger: silentLogger(),
      }),
    (err) => err instanceof RepositoryError && /master/.test(err.message),
  );
  assert.deepEqual(fs.readdirSync(path.join(root, 'backups', 'development')), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: detached HEAD matching refs/heads/master is accepted (GitHub Actions)', () => {
  const root = tmpdir('bp-weekly-');
  const sha = 'a'.repeat(40);
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), `${sha}\n`);
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'master'), `${sha}\n`);
  // actions/checkout leaves a detached HEAD whose commit equals the ref; the
  // planner must accept it because pull/push behave identically.
  assertBranchMaster(root);
  // A detached HEAD pointing at a different commit is still rejected.
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'master'), `${'b'.repeat(40)}\n`);
  assert.throws(() => assertBranchMaster(root), RepositoryError);
  // packed-refs resolution works when the loose ref is not present.
  fs.rmSync(path.join(root, '.git', 'refs', 'heads', 'master'));
  fs.writeFileSync(
    path.join(root, '.git', 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/master\n`,
  );
  assertBranchMaster(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: rejects non-repository roots', () => {
  const root = tmpdir('bp-weekly-');
  assert.throws(() => validateRepositoryRoot(root), /not a Git repository/);
  fs.mkdirSync(path.join(root, '.git'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  validateRepositoryRoot(root);
  assertBranchMaster(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: GITHUB_OUTPUT receives weekly_changed', async () => {
  const root = gitRepoRoot('bp-weekly-');
  const stagingDir = path.join(root, 'staging');
  await makeStagedSnapshot(stagingDir, 'development', '2026-08-24T03-17-09Z');
  const outputFile = path.join(root, 'out.txt');
  const result = await runWeeklyCommit({
    options: { stagingDir, repoRoot: root },
    env: { GITHUB_OUTPUT: outputFile },
    logger: silentLogger(),
  });
  assert.equal(result.changed, true);
  assert.ok(fs.readFileSync(outputFile, 'utf8').includes('weekly_changed=true'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit-weekly: CLI entry point responds to --help', () => {
  const res = runCli('commit-weekly', ['--help']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('usage: vp run commit:weekly'), res.stderr.slice(0, 300));
});

test('commit-weekly: unknown flag exits nonzero', () => {
  const res = runCli('commit-weekly', ['--staging-dir', '/tmp', '--bogus']);
  assert.notEqual(res.status, 0);
});
