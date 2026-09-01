import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { runBackup, emitStagedSnapshot } from './backup.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, PLAINTEXT_ARTIFACTS, MANIFEST_NAME } from '../src/snapshot.js';
import { prefixOf, R2Error } from '../src/r2.js';
import { createLogger } from '../src/logger.js';
import {
  tmpdir,
  writePrivateFile,
  sha256OfFile,
  AGE_RECIPIENT_1,
  AGE_RECIPIENT_2,
  fakeAge,
} from '../src/test-fixtures.js';

const REF = 'a1b2c3d4e5f6a7b8c9d0';
const DB_URL = `postgresql://postgres.${REF}:the-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`;
const ID = '2026-08-24T03-17-09Z';

/** Logger backed by the real redacting createLogger; captures every line. */
function captureLogger() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ stream });
  return {
    logger,
    output() {
      return chunks.join('');
    },
  };
}

/** Progress messages with the environment prefix stripped. */
function messages(capture) {
  return capture
    .output()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^backup development: /, ''));
}

function sha256Sync(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const BASE_CONFIG = {
  BACKUP_ENVIRONMENT: 'development',
  SUPABASE_PROJECT_REF: REF,
  SUPABASE_SHARED_POOLER_URL: DB_URL,
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_BUCKET: 'development',
  R2_ACCESS_KEY_ID: 'access-key-12345',
  R2_SECRET_ACCESS_KEY: 'secret-key-abcdefghijklmnop',
  ENCRYPT_KEY: AGE_RECIPIENT_1,
};

function makePkgDir(root) {
  const pkgDir = path.join(root, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), `content-of-${name}`);
  }
  return pkgDir;
}

async function makeManifestFile(pkgDir, overrides = {}) {
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    const p = path.join(pkgDir, name);
    files.push({
      name,
      size: fs.statSync(p).size,
      sha256: await sha256OfFile(p),
      encrypted: name.startsWith('data.'),
    });
  }
  const manifest = buildManifest({
    environment: overrides.environment ?? 'development',
    sourceProjectRef: REF,
    snapshotId: overrides.snapshotId ?? ID,
    createdAt: '2026-08-24T03:17:09.000Z',
    supabaseCliVersion: '2.114.0',
    contentSha256: overrides.contentSha256 ?? 'c'.repeat(64),
    encryption: { recipient: overrides.recipient ?? AGE_RECIPIENT_1 },
    files,
    dataParts: ['data.sql.gz.age.part-000'],
  });
  writePrivateFile(path.join(pkgDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Fake S3 adapter + in-memory bucket honoring the r2 adapter contract. */
function fakeBucket() {
  const objects = new Map();
  const calls = [];
  const adapter = {
    calls,
    async headBucket({ bucket: _bucket }) {
      calls.push(['headBucket', _bucket]);
    },
    async listObjects({ bucket, prefix = '', continuationToken }) {
      calls.push(['listObjects', bucket, prefix]);
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = continuationToken ? Number(continuationToken) : 0;
      return {
        keys: keys.slice(start, start + 1000).map((key) => ({ key, size: objects.get(key).size })),
        isTruncated: false,
      };
    },
    async headObject({ bucket, key }) {
      calls.push(['headObject', bucket, key]);
      const o = objects.get(key);
      if (!o) throw new R2Error(`missing ${key}`);
      return { size: o.size, metadata: o.metadata };
    },
    async getObject({ bucket: _bucket, key }) {
      const o = objects.get(key);
      if (!o) throw new R2Error(`missing ${key}`);
      const { Readable } = await import('node:stream');
      return { size: o.size, metadata: o.metadata, body: Readable.from([o.body]) };
    },
    async putObject({ bucket: _bucket, key, body, contentLength: _contentLength, metadata }) {
      calls.push(['putObject', _bucket, key]);
      const chunks = [];
      for await (const c of body) chunks.push(c);
      const buffer = Buffer.concat(chunks);
      objects.set(key, { body: buffer, size: buffer.length, metadata });
    },
    async deleteObjects({ bucket, keys }) {
      calls.push(['deleteObjects', bucket, keys.length]);
      for (const key of keys) objects.delete(key);
    },
  };
  return { adapter, objects, calls };
}

function backupDeps({
  contentSha256,
  recipient,
  oldContentSha256 = 'c'.repeat(64),
  oldRecipient = AGE_RECIPIENT_1,
  extra = {},
}) {
  const fake = fakeBucket();
  const root = tmpdir('bp-backup-');
  const pkgDir = makePkgDir(root);
  const calls = { dump: 0, package: 0 };
  const newest = makeManifestFileSync(pkgDir, {
    contentSha256: oldContentSha256,
    recipient: oldRecipient,
    snapshotId: '2026-08-23T03-17-09Z',
  });
  // store the "existing" newest snapshot in the fake bucket (valid manifest)
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    const body = Buffer.from(`old-${name}`);
    fake.objects.set(`${prefixOf('2026-08-23T03-17-09Z')}${name}`, {
      body,
      size: body.length,
      metadata: {},
    });
  }
  const manifestBody = Buffer.from(`${JSON.stringify(newest, null, 2)}\n`);
  fake.objects.set(`${prefixOf('2026-08-23T03-17-09Z')}${MANIFEST_NAME}`, {
    body: manifestBody,
    size: manifestBody.length,
    metadata: {},
  });
  const deps = {
    loadConfig: ({ environment, vars: _vars, root: _root }) => ({
      environment,
      projectRef: REF,
      sharedPoolerUrl: DB_URL,
      accountId: BASE_CONFIG.CLOUDFLARE_ACCOUNT_ID,
      bucket: BASE_CONFIG.R2_BUCKET,
      accessKeyId: BASE_CONFIG.R2_ACCESS_KEY_ID,
      secretAccessKey: BASE_CONFIG.R2_SECRET_ACCESS_KEY,
      ageRecipient: recipient ?? BASE_CONFIG.ENCRYPT_KEY,
    }),
    doDump: async () => {
      calls.dump += 1;
    },
    doPackage: async ({ destDir, ageRecipient, snapshotId, environment, sourceProjectRef }) => {
      calls.package += 1;
      // Mirror the real packageSnapshot contract: the packager owns
      // destination creation (0700) and must not find it pre-existing.
      fs.mkdirSync(destDir, { mode: 0o700 });
      for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
        fs.copyFileSync(path.join(pkgDir, name), path.join(destDir, name));
      }
      const manifest = buildManifest({
        environment,
        sourceProjectRef,
        snapshotId,
        createdAt: '2026-08-24T03:17:09.000Z',
        supabaseCliVersion: '2.114.0',
        contentSha256: contentSha256 ?? 'c'.repeat(64),
        encryption: { recipient: ageRecipient },
        files: manifestFiles(pkgDir),
        dataParts: ['data.sql.gz.age.part-000'],
      });
      writePrivateFile(path.join(destDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
      return { manifest, destDir, contentSha256: manifest.contentSha256 };
    },
    doListValid: async ({ adapter: _a, bucket: _b }) => {
      const prefix = prefixOf('2026-08-23T03-17-09Z');
      if (!fake.objects.has(`${prefix}${MANIFEST_NAME}`)) return [];
      const raw = fake.objects.get(`${prefix}${MANIFEST_NAME}`).body.toString('utf8');
      return [
        {
          prefix,
          snapshotId: '2026-08-23T03-17-09Z',
          manifest: JSON.parse(raw),
          keys: new Set(),
        },
      ];
    },
    doSelectLatest: (valid) => (valid.length ? valid[0] : null),
    doListPrefixes: async ({ adapter: _a, bucket: _b }) => {
      const entries = [...fake.objects.keys()]
        .filter((k) => k.startsWith('snapshots/'))
        .map((k) => k.slice(0, k.indexOf('/', 'snapshots/'.length) + 1));
      return new Set(entries);
    },
    doRetention: async ({ snapshots, now }) => {
      calls.retention = { snapshots: snapshots.length, now };
      return [];
    },
    doSameDay: () => [],
    doDeletePrefix: async () => {
      calls.deletes = (calls.deletes ?? 0) + 1;
    },
    doUpload: async ({ bucket: b }) => {
      calls.uploadBucket = b;
      calls.uploads = (calls.uploads ?? 0) + 1;
    },
    doHeadBucket: async ({ bucket }) => {
      fake.calls.push(['headBucket', bucket]);
    },
    makeAdapter: () => fake.adapter,
    locateCli: () => '/fake/supabase',
    lookup: () => '/fake/age',
    run: async () => {},
    now: () => new Date('2026-08-24T03:17:09Z'),
    doEmitStagedSnapshot: extra.doEmitStagedSnapshot,
    ...extra,
  };
  return { deps, calls, fake, root, pkgDir };
}

function manifestFiles(pkgDir) {
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    const p = path.join(pkgDir, name);
    files.push({
      name,
      size: fs.statSync(p).size,
      sha256: 'h',
      encrypted: name.startsWith('data.'),
    });
  }
  return files;
}

function makeManifestFileSync(pkgDir, overrides) {
  // synchronous variant of makeManifestFile for setup
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    const p = path.join(pkgDir, name);
    files.push({
      name,
      size: fs.statSync(p).size,
      sha256: 'h',
      encrypted: name.startsWith('data.'),
    });
  }
  const manifest = buildManifest({
    environment: 'development',
    sourceProjectRef: REF,
    snapshotId: overrides.snapshotId,
    createdAt: '2026-08-23T03:17:09.000Z',
    supabaseCliVersion: '2.114.0',
    contentSha256: overrides.contentSha256,
    encryption: { recipient: overrides.recipient },
    files,
    dataParts: ['data.sql.gz.age.part-000'],
  });
  return manifest;
}

const silentLogger = () => ({
  addSecret: () => {},
  status: () => {},
  warn: () => {},
  error: () => {},
  redact: (t) => t,
});

test('backup: dump/package failure performs no delete and no upload', async () => {
  const { deps, calls } = backupDeps({ contentSha256: 'x'.repeat(64), recipient: AGE_RECIPIENT_1 });
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: silentLogger(),
        deps: {
          ...deps,
          doDump: async () => {
            throw new Error('dump exploded');
          },
        },
      }),
    /dump exploded/,
  );
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: silentLogger(),
        deps: {
          ...deps,
          doPackage: async () => {
            throw new Error('package exploded');
          },
        },
      }),
    /package exploded/,
  );
  assert.equal(calls.deletes ?? 0, 0);
  assert.equal(calls.uploads ?? 0, 0);
});

test('backup: real packageSnapshot succeeds inside runBackup workspace wiring', async () => {
  // Regression guard: createBackupWorkspace pre-creates workspace/pkg, but
  // packageSnapshot owns destination creation and refuses an existing dir.
  // This test keeps the REAL packageSnapshot so the wiring is exercised
  // end-to-end (dump -> package -> upload), not just a fake doPackage.
  const { deps, calls } = backupDeps({ contentSha256: 'x'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps: {
      ...deps,
      // Fake only the dump (writes the six logical outputs) and R2. The
      // package step uses the default real packageSnapshot.
      doDump: async ({ outDir }) => {
        calls.dump += 1;
        for (const name of [
          ...PLAINTEXT_ARTIFACTS,
          'migration-history-data.sql',
          'database-data.sql',
        ]) {
          writePrivateFile(path.join(outDir, name), `content-of-${name}\n`);
        }
      },
      doPackage: undefined,
      // Deterministic age stand-in so the real packageSnapshot pipeline runs.
      run: fakeAge,
    },
  });
  assert.equal(calls.dump, 1);
  assert.equal(result.r2Changed, true);
  assert.equal(calls.uploads, 1);
  assert.equal(calls.uploadBucket, BASE_CONFIG.R2_BUCKET);
  assert.equal(calls.deletes ?? 0, 0);
});

test('backup: identical content and recipient skips upload but still cleans retention', async () => {
  const { deps, calls } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.r2Changed, false);
  assert.equal(calls.uploads ?? 0, 0);
  assert.ok(calls.retention, 'retention cleanup must run even when unchanged');
  assert.equal(calls.retention.snapshots, 1);
});

test('backup: changed content uploads once', async () => {
  const { deps, calls } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.r2Changed, true);
  assert.equal(calls.uploads, 1);
});

test('backup: the validated shared pooler URL reaches the lower-level dump as dbUrl', async () => {
  const { deps, calls } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  let receivedDbUrl = null;
  await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps: {
      ...deps,
      doDump: async (opts) => {
        calls.dump += 1;
        receivedDbUrl = opts.dbUrl;
      },
    },
  });
  assert.equal(receivedDbUrl, DB_URL, 'the exact validated shared pooler URL must flow as dbUrl');
});

test('backup: recipient change forces upload even with identical content', async () => {
  const { deps, calls } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_2 });
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.r2Changed, true);
  assert.equal(calls.uploads, 1);
});

test('backup: no existing snapshot means changed', async () => {
  const { deps, calls, fake } = backupDeps({
    contentSha256: 'c'.repeat(64),
    recipient: AGE_RECIPIENT_1,
  });
  fake.objects.clear();
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.r2Changed, true);
  assert.equal(calls.uploads, 1);
});

test('backup: package/listing precede upload; all deletion follows upload; staging is last', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const stagingDir = path.join(tmpdir('bp-backup-'), 'staging');
  const order = [];
  const runDeps = {
    ...deps,
    doPackage: async (opts) => {
      order.push('package');
      return deps.doPackage(opts);
    },
    doListValid: async () => {
      order.push('listValid');
      return [];
    },
    doListPrefixes: async () => {
      order.push('listPrefixes');
      return new Set(['snapshots/2026-08-10T00-00-00Z/', 'snapshots/2026-08-24T00-00-00Z/']);
    },
    doRetention: async () => {
      order.push('retention');
      return [{ snapshotId: '2026-08-10T00-00-00Z', manifest: null }];
    },
    doSameDay: async () => {
      order.push('sameDay');
      return ['snapshots/2026-08-24T00-00-00Z/'];
    },
    doDeletePrefix: async ({ prefix }) => {
      order.push(`delete:${prefix}`);
    },
    doUpload: async () => {
      order.push('upload');
    },
    doEmitStagedSnapshot: async () => {
      order.push('staging');
      return path.join(stagingDir, 'development', ID);
    },
  };
  const result = await runBackup({
    options: { environment: 'development', stagingDir },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps: runDeps,
  });
  const idx = (x) => {
    const i = order.indexOf(x);
    assert.notEqual(i, -1, `${x} not observed in ${order.join(',')}`);
    return i;
  };
  assert.ok(idx('package') < idx('listValid'), 'package must complete before listing');
  assert.ok(idx('package') < idx('listPrefixes'), 'package must precede prefix listing');
  assert.ok(
    idx('upload') < idx('delete:snapshots/2026-08-10T00-00-00Z/'),
    'upload must succeed before retention deletion',
  );
  assert.ok(
    idx('delete:snapshots/2026-08-10T00-00-00Z/') < idx('delete:snapshots/2026-08-24T00-00-00Z/'),
    'retention deletion must precede same-day deletion',
  );
  assert.ok(
    idx('delete:snapshots/2026-08-24T00-00-00Z/') < idx('staging'),
    'staging emission must follow R2 cleanup',
  );
  assert.equal(result.deletedPrefixCount, 2);
  fs.rmSync(path.dirname(stagingDir), { recursive: true, force: true });
});

test('backup: staging output occurs independently of R2 change', async () => {
  const stagingDir = path.join(tmpdir('bp-backup-'), 'staging');
  const emit = async ({ pkgDir, manifest, stagingDir: cd, environment, snapshotId }) => {
    const root = path.join(cd, environment, snapshotId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const entry of manifest.files) {
      fs.copyFileSync(path.join(pkgDir, entry.name), path.join(root, entry.name));
    }
    fs.copyFileSync(path.join(pkgDir, MANIFEST_NAME), path.join(root, MANIFEST_NAME));
    return root;
  };
  // Unchanged content: staged snapshot still emitted.
  const { deps, pkgDir } = backupDeps({
    contentSha256: 'c'.repeat(64),
    recipient: AGE_RECIPIENT_1,
    extra: { doEmitStagedSnapshot: emit },
  });
  const result = await runBackup({
    options: { environment: 'development', stagingDir },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.r2Changed, false);
  assert.equal(result.stagingPath, path.join(stagingDir, 'development', ID));
  assert.ok(fs.existsSync(path.join(stagingDir, 'development', ID, MANIFEST_NAME)));
  // Health: pkgDir from the fixture leaked nothing into the staging directory
  assert.ok(!fs.readdirSync(path.join(stagingDir, 'development', ID)).includes('data.sql'));
  fs.rmSync(path.dirname(stagingDir), { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test('backup: current environment never accesses the other bucket', async () => {
  const { deps, fake } = backupDeps({ contentSha256: 'q'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.environment, 'development');
  const buckets = [...new Set(fake.calls.filter((c) => c[1] === 'production').map((c) => c[1]))];
  assert.deepEqual(buckets, [], 'no call may touch the production bucket');
  const devCalls = fake.calls.filter((c) => c[1] === 'development');
  assert.ok(devCalls.length > 0);
});

test('backup: plaintext workspace cleanup occurs on every failure', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith(`db-backup-${process.pid}-`));
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: silentLogger(),
        deps: {
          ...deps,
          doUpload: async () => {
            throw new Error('upload exploded');
          },
        },
      }),
    /upload exploded/,
  );
  const after = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith(`db-backup-${process.pid}-`));
  assert.deepEqual(after, before, 'workspace must be removed after failure');
});

test('backup: GitHub outputs and summary contain no secrets or row data', async () => {
  const root = tmpdir('bp-backup-');
  const outFile = path.join(root, 'outputs.txt');
  const summaryFile = path.join(root, 'summary.md');
  const { deps } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const env = {
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_ACTIONS: 'true',
    REPOSITORY_PRIVATE: 'true',
  };
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env,
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.r2Changed, false);
  const outputs = fs.readFileSync(outFile, 'utf8');
  assert.ok(outputs.includes('snapshot_id='));
  assert.ok(outputs.includes('r2_changed=false'));
  assert.ok(outputs.includes('deleted_prefix_count=0'));
  const summary = fs.readFileSync(summaryFile, 'utf8');
  for (const secret of [DB_URL, 'the-password', REF, 'content-of-', AGE_RECIPIENT_1]) {
    assert.ok(!outputs.includes(secret), `secret leaked into outputs: ${secret}`);
    assert.ok(!summary.includes(secret), `secret leaked into summary: ${secret}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: refuses to run without private-repository context in GitHub Actions', async () => {
  const { deps } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: { GITHUB_ACTIONS: 'true', REPOSITORY_PRIVATE: 'false' },
        cwd: '/repo',
        logger: silentLogger(),
        deps,
      }),
    /private/,
  );
});

test('backup: emitStagedSnapshot copies only allowlisted files and verifies hashes', async () => {
  const root = tmpdir('bp-backup-');
  const pkgDir = makePkgDir(root);
  const manifest = await makeManifestFile(pkgDir);
  const stagingRoot = path.join(root, 'staging');
  const emitted = await emitStagedSnapshot({
    pkgDir,
    manifest,
    stagingDir: stagingRoot,
    environment: 'development',
    snapshotId: ID,
  });
  const files = fs.readdirSync(emitted).sort();
  assert.deepEqual(
    files,
    [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000', MANIFEST_NAME].sort(),
  );
  // Tampering the source then emitting again must fail and remove the destination.
  fs.appendFileSync(path.join(pkgDir, 'roles.sql'), '-- tampered');
  await assert.rejects(
    () =>
      emitStagedSnapshot({
        pkgDir,
        manifest,
        stagingDir: stagingRoot,
        environment: 'development',
        snapshotId: '2026-08-25T00-00-00Z',
      }),
    /roles\.sql|MISMATCH/,
  );
  assert.ok(!fs.existsSync(path.join(stagingRoot, 'development', '2026-08-25T00-00-00Z')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: emitStagedSnapshot reports per-file progress with manifest last', async () => {
  const root = tmpdir('bp-backup-');
  const pkgDir = makePkgDir(root);
  const manifest = await makeManifestFile(pkgDir);
  const stagingDir = path.join(root, 'candidates');
  const progress = [];
  const emitted = await emitStagedSnapshot({
    pkgDir,
    manifest,
    stagingDir: stagingDir,
    environment: 'development',
    snapshotId: ID,
    onProgress: (message) => progress.push(message),
  });
  const files = manifest.files;
  assert.deepEqual(progress, [
    ...files.flatMap((entry, i) => [
      `starting staged file copy ${i + 1}/${files.length + 1}: ${entry.name}`,
      `completed staged file copy ${i + 1}/${files.length + 1}: ${entry.name}: verified`,
    ]),
    `starting staged file copy ${files.length + 1}/${files.length + 1}: ${MANIFEST_NAME}`,
    `completed staged file copy ${files.length + 1}/${files.length + 1}: ${MANIFEST_NAME}: verified`,
  ]);
  assert.ok(progress.at(-1).endsWith(': verified'));
  assert.ok(fs.existsSync(path.join(emitted, MANIFEST_NAME)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: emitStagedSnapshot tampering reports cleanup and never leaks paths', async () => {
  const root = tmpdir('bp-backup-');
  const pkgDir = makePkgDir(root);
  const manifest = await makeManifestFile(pkgDir);
  fs.appendFileSync(path.join(pkgDir, 'roles.sql'), '-- tampered');
  const stagingDir = path.join(root, 'candidates');
  const progress = [];
  await assert.rejects(
    () =>
      emitStagedSnapshot({
        pkgDir,
        manifest,
        stagingDir: stagingDir,
        environment: 'development',
        snapshotId: '2026-08-25T00-00-00Z',
        onProgress: (message) => progress.push(message),
      }),
    /roles\.sql|MISMATCH/,
  );
  assert.ok(progress.includes('starting staged file copy 1/6: roles.sql'));
  assert.ok(!progress.includes('completed staged file copy 1/6: roles.sql: verified'));
  assert.ok(
    !progress.some((m) => m.includes(MANIFEST_NAME)),
    'manifest must not start after a failure',
  );
  assert.ok(progress.includes('starting incomplete-staged-snapshot cleanup attempt'));
  assert.ok(progress.includes('completed incomplete-staged-snapshot cleanup attempt'));
  assert.ok(!fs.existsSync(path.join(stagingDir, 'development', '2026-08-25T00-00-00Z')));
  const all = progress.join('\n');
  assert.ok(!all.includes(stagingDir), 'staging root must never appear');
  assert.ok(!all.includes(pkgDir), 'package dir must never appear');
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: CLI entry point responds to --help', () => {
  const script = fileURLToPath(new URL('./backup.js', import.meta.url));
  const res = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('usage: vp run backup'), res.stderr.slice(0, 300));
});

test('backup: registers R2 credentials with the logger for redaction', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const added = [];
  const logger = {
    ...silentLogger(),
    addSecret: (value) => {
      added.push(value);
    },
  };
  await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger,
    deps,
  });
  assert.ok(added.includes(DB_URL), 'DB URL must be registered');
  assert.ok(added.includes('access-key-12345'), 'access key id must be registered');
  assert.ok(added.includes('secret-key-abcdefghijklmnop'), 'secret access key must be registered');
});

test('backup: deletions happen only after a successful upload', async () => {
  const order = [];
  const { deps } = backupDeps({
    contentSha256: 'd'.repeat(64),
    recipient: AGE_RECIPIENT_1,
    extra: {
      doRetention: async () => [{ snapshotId: '2026-08-17T03-17-09Z', manifest: null }],
      doDeletePrefix: async () => {
        order.push('delete');
      },
      doUpload: async () => {
        order.push('upload');
      },
    },
  });
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(result.r2Changed, true);
  assert.ok(order.includes('upload'), 'a changed run must upload');
  assert.ok(order.includes('delete'), 'retention deletion must run');
  assert.ok(
    order.indexOf('upload') < order.indexOf('delete'),
    'an upload failure can never delete the prior snapshot',
  );
});

test('backup: upload failure preserves retention and same-day snapshots', async () => {
  let deletes = 0;
  const { deps } = backupDeps({
    contentSha256: 'd'.repeat(64),
    recipient: AGE_RECIPIENT_1,
    extra: {
      doRetention: async () => [{ snapshotId: '2026-08-17T03-17-09Z', manifest: null }],
      doSameDay: async () => ['snapshots/2026-08-24T01-00-00Z/'],
      doDeletePrefix: async () => {
        deletes += 1;
      },
      doUpload: async () => {
        throw new Error('upload failed');
      },
    },
  });
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: silentLogger(),
        deps,
      }),
    /upload failed/,
  );
  assert.equal(deletes, 0);
});

test('backup: a prefix in both retention and same-day sets is deleted and counted once', async () => {
  const deleted = [];
  const { deps } = backupDeps({
    contentSha256: 'd'.repeat(64),
    recipient: AGE_RECIPIENT_1,
    extra: {
      doRetention: async () => [{ snapshotId: '2026-08-24T01-00-00Z', manifest: null }],
      doSameDay: async () => ['snapshots/2026-08-24T01-00-00Z/'],
      doDeletePrefix: async ({ prefix }) => {
        deleted.push(prefix);
      },
    },
  });
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: silentLogger(),
    deps,
  });
  assert.equal(deleted.length, 1, 'an overlapping prefix must be deleted exactly once');
  assert.equal(
    result.deletedPrefixCount,
    1,
    'metrics must never double-count a prefix present in both sets',
  );
});

test('backup: changed run reports the complete ordered lifecycle with nested progress', async () => {
  const { deps, pkgDir, calls } = backupDeps({
    contentSha256: 'd'.repeat(64),
    recipient: AGE_RECIPIENT_1,
  });
  const stagingDir = path.join(tmpdir('bp-backup-'), 'candidates');
  const root = tmpdir('bp-backup-');
  const outFile = path.join(root, 'outputs.txt');
  const summaryFile = path.join(root, 'summary.md');
  const order = [];
  const runDeps = {
    ...deps,
    doDump: async (opts) => {
      calls.dump += 1;
      order.push('dump');
      assert.equal(typeof opts.onProgress, 'function', 'doDump must receive onProgress');
      opts.onProgress('nested dump stage');
    },
    // Real-hash package mirror so the REAL emitStagedSnapshot verification passes.
    doPackage: async (opts) => {
      calls.package += 1;
      order.push('package');
      assert.equal(typeof opts.onProgress, 'function', 'doPackage must receive onProgress');
      fs.mkdirSync(opts.destDir, { mode: 0o700 });
      for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
        fs.copyFileSync(path.join(pkgDir, name), path.join(opts.destDir, name));
      }
      const files = [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000'].map((name) => ({
        name,
        size: fs.statSync(path.join(opts.destDir, name)).size,
        sha256: sha256Sync(path.join(opts.destDir, name)),
        encrypted: name.startsWith('data.'),
      }));
      const manifest = buildManifest({
        environment: opts.environment,
        sourceProjectRef: REF,
        snapshotId: opts.snapshotId,
        createdAt: '2026-08-24T03:17:09.000Z',
        supabaseCliVersion: '2.114.0',
        contentSha256: 'd'.repeat(64),
        encryption: { recipient: opts.ageRecipient },
        files,
        dataParts: ['data.sql.gz.age.part-000'],
      });
      writePrivateFile(
        path.join(opts.destDir, MANIFEST_NAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      return { manifest, destDir: opts.destDir, contentSha256: manifest.contentSha256 };
    },
    doListValid: async (opts) => {
      order.push('listValid');
      assert.equal(typeof opts.onProgress, 'function', 'doListValid must receive onProgress');
      return deps.doListValid(opts);
    },
    doListPrefixes: async () => {
      order.push('listPrefixes');
      return new Set(['snapshots/2026-08-10T00-00-00Z/', 'snapshots/2026-08-24T00-00-00Z/']);
    },
    doRetention: async () => {
      order.push('retention');
      return [{ snapshotId: '2026-08-10T00-00-00Z', manifest: null }];
    },
    doSameDay: async () => {
      order.push('sameDay');
      return ['snapshots/2026-08-24T00-00-00Z/'];
    },
    doDeletePrefix: async ({ prefix }) => {
      order.push(`delete:${prefix}`);
    },
    doUpload: async (opts) => {
      order.push('upload');
      assert.equal(typeof opts.onProgress, 'function', 'doUpload must receive onProgress');
    },
    // real default emitStagedSnapshot is exercised end-to-end
    doEmitStagedSnapshot: undefined,
  };
  const capture = captureLogger();
  const result = await runBackup({
    options: { environment: 'development', stagingDir },
    env: { GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summaryFile },
    cwd: '/repo',
    logger: capture.logger,
    deps: runDeps,
  });
  const lines = messages(capture);
  const idx = (m) => {
    const i = lines.indexOf(m);
    assert.notEqual(i, -1, `${m} missing from:\n${lines.join('\n')}`);
    return i;
  };
  // High-level ordered lifecycle with start/completion pairs.
  assert.ok(idx('starting backup run') < idx('starting configuration load'));
  assert.ok(idx('completed configuration load') < idx('starting private-repository check'));
  assert.ok(idx('completed private-repository check') < idx('starting R2 client initialization'));
  assert.ok(idx('completed R2 client initialization') < idx('starting R2 bucket access check'));
  assert.ok(idx('completed R2 bucket access check') < idx('starting executable resolution'));
  assert.ok(idx('completed executable resolution') < idx('starting snapshot-ID initialization'));
  assert.ok(
    idx('completed snapshot-ID initialization: ' + ID) <
      idx('starting private workspace initialization'),
  );
  assert.ok(
    idx('completed private workspace initialization') < idx('starting logical database dump'),
  );
  assert.ok(idx('completed logical database dump') < idx('starting snapshot packaging'));
  assert.ok(idx('completed snapshot packaging') < idx('starting valid-snapshot scan'));
  assert.ok(
    idx('completed valid-snapshot scan: 1 valid snapshot(s)') <
      idx('starting newest-valid selection'),
  );
  assert.ok(
    idx('completed newest-valid selection: 2026-08-23T03-17-09Z') <
      idx('starting content and recipient comparison'),
  );
  assert.ok(
    idx('completed content and recipient comparison: changed') < idx('starting all-prefix scan'),
  );
  assert.ok(idx('completed all-prefix scan: 2 prefix(es)') < idx('starting retention computation'));
  assert.ok(
    idx('completed retention computation: 1 target(s)') <
      idx('starting target-prefix conflict check'),
  );
  assert.ok(
    idx('completed target-prefix conflict check') < idx('starting same-day cleanup computation'),
  );
  assert.ok(
    idx('completed same-day cleanup computation: 1 target(s)') < idx('starting snapshot upload'),
  );
  assert.ok(
    idx('completed snapshot upload') <
      idx('starting cleanup of snapshot prefix 1/2: 2026-08-10T00-00-00Z'),
  );
  assert.ok(
    idx('starting cleanup of snapshot prefix 1/2: 2026-08-10T00-00-00Z') <
      idx('starting cleanup of snapshot prefix 2/2: 2026-08-24T00-00-00Z'),
  );
  assert.ok(
    idx('completed cleanup of snapshot prefix 2/2: 2026-08-24T00-00-00Z') <
      idx('starting staged snapshot emission'),
  );
  assert.ok(idx('completed staged snapshot emission') < idx('starting private workspace cleanup'));
  assert.ok(idx('completed private workspace cleanup') < idx('starting GitHub output write'));
  assert.ok(idx('completed GitHub output write') < idx('starting step summary write'));
  assert.ok(
    idx('completed step summary write') <
      idx('snapshot 2026-08-24T03-17-09Z uploaded; 2 prefix(es) cleaned'),
  );
  // Nested callback propagation reaches the leaf modules.
  assert.ok(idx('nested dump stage') > idx('starting logical database dump'));
  // Upload-before-delete and operation ordering contracts.
  assert.equal(result.deletedPrefixCount, 2);
  const uploadIdx = order.indexOf('upload');
  for (const entry of order) {
    if (entry.startsWith('delete:')) {
      assert.ok(uploadIdx !== -1 && uploadIdx < order.indexOf(entry));
    }
  }
  // Metadata publication: exact keys and summary columns.
  const outputs = fs.readFileSync(outFile, 'utf8');
  assert.ok(outputs.includes('snapshot_id=' + ID));
  assert.ok(outputs.includes('r2_changed=true'));
  assert.ok(outputs.includes('deleted_prefix_count=2'));
  assert.ok(outputs.includes('staging_path='));
  const summary = fs.readFileSync(summaryFile, 'utf8');
  assert.ok(summary.includes('| development | `2026-08-24T03-17-09Z` | true | 2 | yes |'));
  fs.rmSync(path.dirname(stagingDir), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: unchanged run reports explicit skips and still runs retention', async () => {
  const { deps, calls } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const capture = captureLogger();
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: capture.logger,
    deps,
  });
  const lines = messages(capture);
  assert.ok(calls.retention, 'retention must run even when unchanged');
  assert.ok(lines.includes('completed retention computation: 0 target(s)'));
  assert.ok(lines.includes('skipped same-day cleanup computation: snapshot content unchanged'));
  assert.ok(
    lines.includes('skipped R2 upload: snapshot content and encryption recipient are unchanged'),
  );
  assert.ok(lines.includes('skipped R2 prefix cleanup: no cleanup targets'));
  assert.ok(lines.includes('skipped staged snapshot emission: not requested'));
  assert.ok(lines.includes('skipped GitHub output write: path not configured'));
  assert.ok(lines.includes('skipped step summary write: path not configured'));
  assert.equal(result.r2Changed, false);
  assert.ok(
    capture
      .output()
      .includes(`backup development: snapshot ${ID} unchanged (no upload); 0 prefix(es) cleaned`),
  );
});

test('backup: changed run with no cleanup targets reports the explicit cleanup skip', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const capture = captureLogger();
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger: capture.logger,
    deps,
  });
  const lines = messages(capture);
  assert.equal(result.r2Changed, true);
  assert.ok(lines.includes('completed snapshot upload'));
  assert.ok(lines.includes('skipped R2 prefix cleanup: no cleanup targets'));
});

test('backup: staged snapshot absence is explicit and staged snapshot progress is detailed', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const stagingDir = path.join(tmpdir('bp-backup-'), 'candidates');
  const capture = captureLogger();
  const result = await runBackup({
    options: { environment: 'development', stagingDir },
    env: {},
    cwd: '/repo',
    logger: capture.logger,
    deps: {
      ...deps,
      doEmitStagedSnapshot: async ({ onProgress }) => {
        assert.equal(typeof onProgress, 'function', 'doEmitStagedSnapshot must receive onProgress');
        onProgress('starting staged file copy 1/6: roles.sql');
        onProgress('completed staged file copy 1/6: roles.sql: verified');
        onProgress('starting staged file copy 6/6: manifest.json');
        onProgress('completed staged file copy 6/6: manifest.json: verified');
        return path.join(stagingDir, 'development', ID);
      },
    },
  });
  const lines = messages(capture);
  assert.ok(lines.includes('starting staged snapshot emission'));
  assert.ok(lines.includes('starting staged file copy 1/6: roles.sql'));
  assert.ok(lines.includes('completed staged file copy 6/6: manifest.json: verified'));
  assert.ok(lines.includes('completed staged snapshot emission'));
  assert.ok(!lines.includes('skipped staged snapshot emission: not requested'));
  assert.equal(result.stagingPath, path.join(stagingDir, 'development', ID));
  assert.ok(!capture.output().includes(stagingDir), 'staging path must never be logged');
});

test('backup: every operational failure leaves its start unmatched and cleans the workspace', async () => {
  const base = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const stagingDir = path.join(tmpdir('bp-backup-'), 'candidates');
  const cases = [
    {
      name: 'dump failure',
      options: { environment: 'development', stagingDir: null },
      start: 'starting logical database dump',
      complete: 'completed logical database dump',
      deps: {
        doDump: async () => {
          throw new Error('dump exploded');
        },
      },
    },
    {
      name: 'package failure',
      options: { environment: 'development', stagingDir: null },
      start: 'starting snapshot packaging',
      complete: 'completed snapshot packaging',
      deps: {
        doPackage: async () => {
          throw new Error('package exploded');
        },
      },
    },
    {
      name: 'upload failure',
      options: { environment: 'development', stagingDir: null },
      start: 'starting snapshot upload',
      complete: 'completed snapshot upload',
      deps: {
        doUpload: async () => {
          throw new Error('upload exploded');
        },
      },
    },
    {
      name: 'delete failure',
      options: { environment: 'development', stagingDir: null },
      start: 'starting cleanup of snapshot prefix 1/1: 2026-08-10T03-17-09Z',
      complete: 'completed cleanup of snapshot prefix 1/1: 2026-08-10T03-17-09Z',
      deps: {
        doRetention: async () => [{ snapshotId: '2026-08-10T03-17-09Z', manifest: null }],
        doDeletePrefix: async ({ onProgress }) => {
          onProgress?.('starting cleanup object listing');
          throw new Error('delete exploded');
        },
      },
    },
    {
      name: 'staged snapshot failure',
      options: { environment: 'development', stagingDir },
      start: 'starting staged snapshot emission',
      complete: 'completed staged snapshot emission',
      // The REAL emitStagedSnapshot fails verification against the fake manifest
      // (sha256 'h') and reports its own cleanup attempt.
      deps: {},
    },
  ];
  for (const c of cases) {
    const capture = captureLogger();
    await assert.rejects(
      () =>
        runBackup({
          options: c.options,
          env: {},
          cwd: '/repo',
          logger: capture.logger,
          deps: { ...base.deps, ...c.deps },
        }),
      undefined,
      c.name,
    );
    const lines = messages(capture);
    assert.ok(lines.includes(c.start), `${c.name}: start must be reported`);
    assert.ok(!lines.includes(c.complete), `${c.name}: completion must be absent`);
    assert.ok(
      !lines.some((l) => l.startsWith('snapshot ') && l.includes(' cleaned')),
      `${c.name}: no final success line`,
    );
    assert.ok(lines.includes('starting private workspace cleanup'), c.name);
    assert.ok(lines.includes('completed private workspace cleanup'), c.name);
    if (c.name === 'delete failure') {
      assert.ok(lines.includes('starting cleanup object listing'));
      assert.ok(!lines.includes('completed R2 prefix cleanup: 1 target(s)'));
    }
    if (c.name === 'staged snapshot failure') {
      assert.ok(lines.includes('starting incomplete-staged-snapshot cleanup attempt'));
      assert.ok(lines.includes('completed incomplete-staged-snapshot cleanup attempt'));
    }
  }
  fs.rmSync(path.dirname(stagingDir), { recursive: true, force: true });
});

test('backup: output write failure is logged but never fails a completed backup', async () => {
  const { deps } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const capture = captureLogger();
  const outFile = path.join(tmpdir('bp-backup-'), 'missing-dir', 'outputs.txt');
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: { GITHUB_OUTPUT: outFile },
    cwd: '/repo',
    logger: capture.logger,
    deps,
  });
  assert.equal(result.r2Changed, false, 'backup itself still succeeds');
  const lines = messages(capture);
  assert.ok(lines.includes('starting GitHub output write'));
  assert.ok(!lines.includes('completed GitHub output write'));
  assert.ok(lines.some((l) => l.includes('GitHub output publication failed')));
  assert.ok(
    lines.some((l) => l.startsWith('snapshot ') && l.includes(' cleaned')),
    'final success line is still reported',
  );
  assert.ok(!lines.includes('starting step summary write'));
  assert.ok(lines.includes('completed private workspace cleanup'));
});

test('backup: step summary failure after a successful output write is isolated', async () => {
  const root = tmpdir('bp-backup-');
  const outFile = path.join(root, 'outputs.txt');
  const summaryFile = path.join(root, 'missing-dir', 'summary.md');
  const { deps } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const capture = captureLogger();
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: { GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summaryFile },
    cwd: '/repo',
    logger: capture.logger,
    deps,
  });
  assert.equal(result.r2Changed, false);
  const outputs = fs.readFileSync(outFile, 'utf8');
  assert.ok(outputs.includes('snapshot_id='), 'machine-readable output must be published');
  const lines = messages(capture);
  assert.ok(lines.includes('completed GitHub output write'));
  assert.ok(lines.includes('starting step summary write'));
  assert.ok(!lines.includes('completed step summary write'));
  assert.ok(lines.some((l) => l.includes('step summary publication failed')));
  assert.ok(
    lines.some((l) => l.startsWith('snapshot ') && l.includes(' cleaned')),
    'final success line is still reported',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: cleanup failure never masks the primary failure', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const capture = captureLogger();
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: capture.logger,
        deps: {
          ...deps,
          doDump: async () => {
            throw new Error('dump exploded');
          },
          removeWorkspace: async () => {
            throw new Error('cleanup exploded');
          },
        },
      }),
    /dump exploded/,
    'the primary failure must not be masked by the cleanup failure',
  );
  const lines = messages(capture);
  assert.ok(
    lines.some(
      (l) => l.includes('private workspace cleanup failed') && l.includes('cleanup exploded'),
    ),
    'the cleanup failure is reported alongside the primary failure',
  );
});

test('backup: a throwing progress observer never skips private workspace cleanup', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  let removed = false;
  const logger = {
    status(message) {
      if (message.includes('private workspace cleanup')) throw new Error('progress exploded');
    },
    addSecret() {},
    error() {},
    redact: (text) => text,
  };
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger,
        deps: {
          ...deps,
          doDump: async () => {
            throw new Error('dump exploded');
          },
          removeWorkspace: async () => {
            removed = true;
          },
        },
      }),
    /dump exploded/,
    'the operational error, not the progress error, must propagate',
  );
  assert.equal(removed, true, 'cleanup must run even though progress reporting threw');
});

test('backup: throwing cleanup progress still completes and reports success', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  let removed = false;
  const logger = {
    status(message) {
      if (message.includes('private workspace cleanup')) throw new Error('progress exploded');
    },
    addSecret() {},
    error() {},
    redact: (text) => text,
  };
  const result = await runBackup({
    options: { environment: 'development', stagingDir: null },
    env: {},
    cwd: '/repo',
    logger,
    deps: {
      ...deps,
      removeWorkspace: async () => {
        removed = true;
      },
    },
  });
  assert.equal(removed, true);
  assert.equal(result.r2Changed, true);
});

test('backup: snapshot-ID start is reported before the clock is read', async () => {
  const { deps } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const capture = captureLogger();
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: capture.logger,
        deps: {
          ...deps,
          now: () => {
            throw new Error('clock exploded');
          },
        },
      }),
    /clock exploded/,
  );
  const lines = messages(capture);
  assert.ok(lines.includes('starting snapshot-ID initialization'));
  assert.ok(!lines.includes('completed snapshot-ID initialization'));
});

test('backup: emitStagedSnapshot cleanup runs even when progress throws', async () => {
  const root = tmpdir('bp-backup-');
  const pkgDir = makePkgDir(root);
  const manifest = await makeManifestFile(pkgDir);
  fs.appendFileSync(path.join(pkgDir, 'roles.sql'), '-- tampered');
  const stagingDir = path.join(root, 'candidates');
  await assert.rejects(
    () =>
      emitStagedSnapshot({
        pkgDir,
        manifest,
        stagingDir: stagingDir,
        environment: 'development',
        snapshotId: '2026-08-25T00-00-00Z',
        onProgress: (message) => {
          if (message.includes('cleanup attempt')) throw new Error('progress exploded');
        },
      }),
    /roles\.sql|MISMATCH/,
    'the verification error, not the progress error, must propagate',
  );
  assert.ok(!fs.existsSync(path.join(stagingDir, 'development', '2026-08-25T00-00-00Z')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: emitStagedSnapshot verifies the copied manifest against the packaged manifest', async () => {
  const root = tmpdir('bp-backup-');
  const pkgDir = makePkgDir(root);
  const manifest = await makeManifestFile(pkgDir);
  const raw = fs.readFileSync(path.join(pkgDir, MANIFEST_NAME), 'utf8');
  fs.writeFileSync(
    path.join(pkgDir, MANIFEST_NAME),
    raw.replace(/(contentSha256": ")([0-9a-f])([0-9a-f]*)/, (_, p, c, rest) => {
      return `${p}${c === 'c' ? 'd' : 'c'}${rest}`;
    }),
  );
  const stagingDir = path.join(root, 'candidates');
  const progress = [];
  await assert.rejects(
    () =>
      emitStagedSnapshot({
        pkgDir,
        manifest,
        stagingDir: stagingDir,
        environment: 'development',
        snapshotId: '2026-08-25T00-00-00Z',
        onProgress: (message) => progress.push(message),
      }),
    /does not match the packaged manifest/,
  );
  assert.ok(progress.includes('starting staged file copy 6/6: manifest.json'));
  assert.ok(!progress.includes('completed staged file copy 6/6: manifest.json: verified'));
  assert.ok(progress.includes('starting incomplete-staged-snapshot cleanup attempt'));
  assert.ok(progress.includes('completed incomplete-staged-snapshot cleanup attempt'));
  assert.ok(!fs.existsSync(path.join(stagingDir, 'development', '2026-08-25T00-00-00Z')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup: injected removeWorkspace failure never publishes success', async () => {
  const { deps } = backupDeps({ contentSha256: 'c'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const capture = captureLogger();
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: capture.logger,
        deps: {
          ...deps,
          removeWorkspace: async () => {
            throw new Error('cleanup exploded');
          },
        },
      }),
    /cleanup exploded/,
  );
  const lines = messages(capture);
  assert.ok(lines.includes('starting private workspace cleanup'));
  assert.ok(!lines.includes('completed private workspace cleanup'));
  assert.ok(
    !lines.some((l) => l.startsWith('snapshot ') && l.includes(' cleaned')),
    'no final success line after a cleanup failure',
  );
});

test('backup: injected secrets in progress are redacted and never leak', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const stagingDir = path.join(tmpdir('bp-backup-'), 'candidates');
  const capture = captureLogger();
  const injected = [
    DB_URL,
    'the-password',
    REF,
    BASE_CONFIG.CLOUDFLARE_ACCOUNT_ID,
    BASE_CONFIG.R2_ACCESS_KEY_ID,
    BASE_CONFIG.R2_SECRET_ACCESS_KEY,
    AGE_RECIPIENT_1,
    stagingDir,
  ];
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir },
        env: {},
        cwd: '/repo',
        logger: capture.logger,
        deps: {
          ...deps,
          doDump: async ({ outDir, onProgress }) => {
            const workspace = path.dirname(outDir);
            injected.push(workspace);
            for (const value of injected) {
              onProgress?.(`leaked ${value}`);
            }
            throw new Error('injected dump failure');
          },
        },
      }),
    /injected dump failure/,
  );
  const output = capture.output();
  assert.ok(output.includes('[REDACTED]'), 'registered secrets must be redacted');
  for (const value of injected) {
    assert.ok(!output.includes(value), `raw value leaked: ${value}`);
  }
  assert.ok(!output.includes('backup development: snapshot '), 'no final success line on failure');
  assert.ok(output.includes('completed private workspace cleanup'));
});

test('backup: successful transcript contains no sensitive values or paths', async () => {
  const { deps } = backupDeps({ contentSha256: 'd'.repeat(64), recipient: AGE_RECIPIENT_1 });
  const stagingDir = path.join(tmpdir('bp-backup-'), 'candidates');
  const capture = captureLogger();
  const result = await runBackup({
    options: { environment: 'development', stagingDir },
    env: {},
    cwd: '/repo',
    logger: capture.logger,
    deps: {
      ...deps,
      doEmitStagedSnapshot: async ({ onProgress }) => {
        onProgress('starting staged file copy 1/6: roles.sql');
        onProgress('completed staged file copy 1/6: roles.sql: verified');
        onProgress('starting staged file copy 6/6: manifest.json');
        onProgress('completed staged file copy 6/6: manifest.json: verified');
        return path.join(stagingDir, 'development', ID);
      },
    },
  });
  assert.equal(result.r2Changed, true);
  const output = capture.output();
  for (const forbidden of [
    DB_URL,
    'the-password',
    REF,
    BASE_CONFIG.CLOUDFLARE_ACCOUNT_ID,
    BASE_CONFIG.R2_ACCESS_KEY_ID,
    BASE_CONFIG.R2_SECRET_ACCESS_KEY,
    AGE_RECIPIENT_1,
    stagingDir,
    'content-of-',
  ]) {
    assert.ok(!output.includes(forbidden), `transcript leaked: ${forbidden}`);
  }
  assert.ok(!/[0-9a-f]{64}/.test(output), 'no content hash may appear');
  assert.ok(
    output.includes(
      'backup development: snapshot 2026-08-24T03-17-09Z uploaded; 0 prefix(es) cleaned',
    ),
  );
  fs.rmSync(path.dirname(stagingDir), { recursive: true, force: true });
});

test('backup: existing target prefix is never overwritten', async () => {
  let uploads = 0;
  const { deps } = backupDeps({
    contentSha256: 'd'.repeat(64),
    recipient: AGE_RECIPIENT_1,
    extra: {
      doListPrefixes: async () => new Set([prefixOf(ID)]),
      doUpload: async () => {
        uploads += 1;
      },
    },
  });
  await assert.rejects(
    () =>
      runBackup({
        options: { environment: 'development', stagingDir: null },
        env: {},
        cwd: '/repo',
        logger: silentLogger(),
        deps,
      }),
    /existing snapshot prefix/,
  );
  assert.equal(uploads, 0);
});

test('backup: unknown flag exits nonzero without external contact', () => {
  const script = fileURLToPath(new URL('./backup.js', import.meta.url));
  const res = spawnSync(process.execPath, [script, '--environment', 'development', '--bogus'], {
    encoding: 'utf8',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unknown option|backup failed/);
});
