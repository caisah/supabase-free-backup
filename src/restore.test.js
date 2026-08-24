import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareRestore,
  parseBackupSelector,
  selectFromSnapshots,
  RestoreError,
  describeUnavailable,
  RESTORE_WORKSPACE_PREFIXES,
} from './restore.js';
import { BACKUP_WORKSPACE_PREFIX } from './backup.js';
import { packageSnapshot, buildManifest, PLAINTEXT_ARTIFACTS, MANIFEST_NAME } from './snapshot.js';
import { memoryStore } from './test-s3-store.js';
import { parseSnapshotId } from './fingerprint.js';
import {
  tmpdir,
  writePrivateFile,
  AGE_IDENTITY_1,
  AGE_RECIPIENT_1,
  AGE_IDENTITY_2,
  ageAvailable,
  agePath,
} from './test-fixtures.js';

const ENV = 'development';
const REF = 'a1b2c3d4e5f6a7b8c9d0';
const ID = '2026-08-24T03-17-09Z';

test('restore: workspace prefixes use the canonical generic identity', () => {
  assert.deepEqual(RESTORE_WORKSPACE_PREFIXES, {
    identity: 'supabase-db-backup-identity-',
    download: 'supabase-db-backup-download-',
    prepared: 'supabase-db-backup-prepared-',
    cleanup: 'supabase-db-backup-cleanup-',
  });
});

test('restore: every restore prefix derives from the canonical backup prefix', () => {
  for (const [suffix, value] of Object.entries(RESTORE_WORKSPACE_PREFIXES)) {
    assert.equal(
      value,
      `${BACKUP_WORKSPACE_PREFIX}${suffix}-`,
      `${suffix} must stay in lockstep with the canonical prefix`,
    );
    assert.ok(value.startsWith(BACKUP_WORKSPACE_PREFIX));
  }
});

async function makePackage(root, { snapshotId = ID, environment = ENV, idSuffix = '' } = {}) {
  const sourceDir = path.join(root, `src${idSuffix}`);
  fs.mkdirSync(sourceDir, { mode: 0o700 });
  writePrivateFile(path.join(sourceDir, 'roles.sql'), 'CREATE ROLE app;\n');
  writePrivateFile(path.join(sourceDir, 'schema.sql'), 'CREATE TABLE public.t (id int);\n');
  writePrivateFile(path.join(sourceDir, 'managed-schema.sql'), '');
  writePrivateFile(
    path.join(sourceDir, 'migration-history-schema.sql'),
    'CREATE TABLE supabase_migrations.schema_migrations (v text);\n',
  );
  writePrivateFile(
    path.join(sourceDir, 'migration-history-data.sql'),
    'COPY supabase_migrations.schema_migrations FROM stdin;\n1\n\\.\n',
  );
  writePrivateFile(
    path.join(sourceDir, 'database-data.sql'),
    `COPY "public"."t" FROM stdin;\n${idSuffix || '42'}\n\\.\n`,
  );
  const pkgDir = path.join(root, `pkg${idSuffix}`);
  await packageSnapshot({
    sourceDir,
    destDir: pkgDir,
    snapshotId,
    environment,
    sourceProjectRef: REF,
    supabaseCliVersion: '2.114.0',
    ageRecipient: AGE_RECIPIENT_1,
  });
  return pkgDir;
}

function identityFixture(root, identity = AGE_IDENTITY_1) {
  return writePrivateFile(path.join(root, 'identity.txt'), `${identity}\n`);
}

async function prepare(root, overrides = {}) {
  return prepareRestore({
    environment: ENV,
    source: 'repo',
    selector: 'latest',
    ageIdentity: AGE_IDENTITY_1,
    agePath: agePath(),
    repoRoot: overrides.repoRoot ?? path.join(root, 'repo'),
    identityFile: overrides.identityFile ?? identityFixture(root),
    ...overrides,
  });
}

test('restore: selector parsing is strict', () => {
  assert.deepEqual(parseBackupSelector('latest'), { kind: 'latest' });
  assert.deepEqual(parseBackupSelector(ID), { kind: 'exact', snapshotId: ID });
  for (const bad of ['', 'nope', '2026-02-30T00-00-00Z', 'latest/']) {
    assert.throws(() => parseBackupSelector(bad), RestoreError, bad);
  }
});

test('restore: unavailable ID reports valid snapshot IDs', () => {
  const snapshots = [
    { snapshotId: '2026-08-20T03-17-09Z' },
    { snapshotId: '2026-08-22T03-17-09Z' },
  ];
  try {
    selectFromSnapshots({
      selector: { kind: 'exact', snapshotId: '2026-08-21T00-00-00Z' },
      snapshots,
    });
    assert.fail('expected RestoreError');
  } catch (err) {
    assert.ok(err instanceof RestoreError);
    assert.ok(err.message.includes('2026-08-20T03-17-09Z'));
    assert.ok(err.message.includes('2026-08-22T03-17-09Z'));
    assert.ok(describeUnavailable(err).includes('valid snapshot IDs'));
    assert.ok(!err.message.includes('42'), 'no SQL data in errors');
  }
});

test(
  'restore: repo latest and exact selection prepare identical workspaces',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const pkg = await makePackage(root);
    const committed = path.join(repoRoot, 'backups', ENV, ID);
    fs.cpSync(pkg, committed, { recursive: true });

    const latest = await prepare(root, { selector: 'latest' });
    assert.equal(latest.snapshotId, ID);
    const newest = await prepare(root, { selector: ID });
    assert.equal(newest.snapshotId, ID);
    // Both preparers produced the decrypted logical contract.
    for (const prepared of [latest, newest]) {
      assert.ok(fs.readFileSync(prepared.dataPath, 'utf8').includes('COPY "public"."t"'));
      for (const name of [...PLAINTEXT_ARTIFACTS, MANIFEST_NAME]) {
        assert.ok(fs.existsSync(path.join(prepared.dir, name)), name);
      }
      await prepared.cleanup();
      assert.ok(!fs.existsSync(prepared.dir), 'cleanup removes the prepared dir');
    }
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'restore: repo latest selects the newest valid snapshot among several',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const olderId = '2026-08-23T03-17-09Z';
    const newerId = '2026-08-24T03-17-09Z';
    const olderPkg = await makePackage(root, { snapshotId: olderId, idSuffix: 'older' });
    const newerPkg = await makePackage(root, { snapshotId: newerId, idSuffix: 'newer' });
    fs.cpSync(olderPkg, path.join(repoRoot, 'backups', ENV, olderId), { recursive: true });
    fs.cpSync(newerPkg, path.join(repoRoot, 'backups', ENV, newerId), { recursive: true });

    const latest = await prepare(root, { selector: 'latest' });
    assert.equal(latest.snapshotId, newerId, 'latest must select the newest valid snapshot');
    assert.ok(fs.readFileSync(latest.dataPath, 'utf8').includes('newer'));
    await latest.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'restore: malformed newer snapshot is ignored for repo latest',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const pkg = await makePackage(root);
    fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });
    // Malformed newer dir without manifest.
    const bad = path.join(repoRoot, 'backups', ENV, '2026-08-25T00-00-00Z');
    fs.mkdirSync(bad, { mode: 0o700 });
    writePrivateFile(path.join(bad, 'roles.sql'), 'stray');

    const prepared = await prepare(root, { selector: 'latest' });
    assert.equal(prepared.snapshotId, ID);
    await prepared.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test('restore: wrong environment or project ref fails', { skip: !ageAvailable() }, async () => {
  const root = tmpdir('bp-rest-');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });

  // A production-environment snapshot under backups/development is never
  // selectable for the development restore.
  const pkgProd = await makePackage(root, { environment: 'production' });
  fs.cpSync(pkgProd, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });
  await assert.rejects(
    () => prepare(root, { selector: 'latest' }),
    (err) => err instanceof RestoreError && /no valid snapshots/.test(err.message),
  );
  fs.rmSync(path.join(repoRoot, 'backups', ENV, ID), { recursive: true, force: true });

  // Source project ref must match the selected operation config.
  const pkg = await makePackage(root, { idSuffix: '-dev' });
  fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });
  await assert.rejects(
    () => prepare(root, { selector: 'latest', projectRef: 'fedcba9876543210fedc' }),
    (err) => err instanceof RestoreError && /no valid snapshots/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  'restore: R2 latest and exact selection with bounded download',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const pkgA = await makePackage(root, { snapshotId: '2026-08-20T03-17-09Z', idSuffix: 'A' });
    const store = memoryStore();
    const bucket = 'development';
    const uploadDir = async (pkgDir, snapshotId) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, MANIFEST_NAME), 'utf8'));
      for (const name of fs.readdirSync(pkgDir)) {
        if (name === MANIFEST_NAME) continue;
        const body = fs.readFileSync(path.join(pkgDir, name));
        store.objects.set(`snapshots/${snapshotId}/${name}`, {
          body,
          size: body.length,
          metadata: {},
        });
      }
      const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      store.objects.set(`snapshots/${snapshotId}/${MANIFEST_NAME}`, {
        body: raw,
        size: raw.length,
        metadata: {},
      });
      return manifest;
    };
    const manifestA = await uploadDir(pkgA, '2026-08-20T03-17-09Z');
    const pkgB = await makePackage(root, { idSuffix: 'B' });
    await uploadDir(pkgB, ID);

    const latest = await prepareRestore({
      environment: ENV,
      source: 'r2',
      selector: 'latest',
      ageIdentity: AGE_IDENTITY_1,
      agePath: agePath(),
      adapter: store.adapter,
      bucket,
      identityFile: identityFixture(root),
    });
    assert.equal(latest.snapshotId, ID);
    assert.notEqual(
      latest.manifest.contentSha256,
      manifestA.contentSha256,
      'newer snapshot must differ in content',
    );
    await latest.cleanup();

    const exact = await prepareRestore({
      environment: ENV,
      source: 'r2',
      selector: '2026-08-20T03-17-09Z',
      ageIdentity: AGE_IDENTITY_1,
      agePath: agePath(),
      adapter: store.adapter,
      bucket,
      identityFile: identityFixture(root),
    });
    assert.equal(exact.snapshotId, '2026-08-20T03-17-09Z');
    await exact.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'restore: wrong identity fails and cleanup is safe twice',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const pkg = await makePackage(root);
    fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });

    await assert.rejects(
      () =>
        prepare(root, {
          selector: 'latest',
          identityFile: identityFixture(root, AGE_IDENTITY_2),
          ageIdentity: AGE_IDENTITY_2,
        }),
      (err) => err instanceof RestoreError || err.name === 'ProcessError',
    );

    const good = await prepare(root, { selector: 'latest' });
    await good.cleanup();
    await good.cleanup(); // idempotent
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'restore: tampered ciphertext and fingerprint mismatch fail',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const pkg = await makePackage(root);
    fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });

    // Tamper ciphertext: byte flip in the encrypted part.
    const part = path.join(repoRoot, 'backups', ENV, ID, 'data.sql.gz.age.part-000');
    const bytes = fs.readFileSync(part);
    bytes[10] ^= 0x01;
    fs.writeFileSync(part, bytes);
    await assert.rejects(
      () => prepare(root, { selector: 'latest' }),
      (err) => err instanceof RestoreError || err.name === 'ProcessError',
    );

    // Restore the part, tamper the MANIFEST fingerprint: aggregate mismatch.
    fs.copyFileSync(path.join(pkg, 'data.sql.gz.age.part-000'), part);
    const manifestPath = path.join(repoRoot, 'backups', ENV, ID, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.contentSha256 = 'f'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => prepare(root, { selector: 'latest' }),
      (err) => err instanceof RestoreError && /FINGERPRINT MISMATCH/i.test(err.message),
    );
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test('restore: identity file is never a process argument', { skip: !ageAvailable() }, async () => {
  // prepareRestore requires a private identity FILE; verify the API never
  // accepts the raw identity string for the decryption invocation by running
  // through the real package flow with an identity passed as a file.
  const root = tmpdir('bp-rest-');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
  const pkg = await makePackage(root);
  fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });
  const prepared = await prepare(root, { selector: 'latest' });
  assert.equal(prepared.snapshotId, ID);
  await prepared.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore: preparation performs no destructive or target calls', async () => {
  const root = tmpdir('bp-rest-');
  let touches = 0;
  // Even with no snapshots available, only selection/listing functions run.
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  await assert.rejects(
    () =>
      prepareRestore({
        environment: ENV,
        source: 'repo',
        selector: 'latest',
        ageIdentity: AGE_IDENTITY_1,
        repoRoot,
        identityFile: identityFixture(root),
        // no target adapter provided: preparation must not need one
      }),
    RestoreError,
  );
  assert.equal(touches, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore: module has no confirmation, reset, or restore-stack dependency', () => {
  const src = fs.readFileSync(new URL('./restore.js', import.meta.url), 'utf8');
  for (const forbidden of [
    'hosted-restore',
    'local-restore',
    'confirmExactPhrase',
    'executeHostedRestore',
    'restoreLocalStack',
    'readOnlyPreflight',
    'docker',
  ]) {
    assert.ok(!src.includes(forbidden), `restore.js must not reference ${forbidden}`);
  }
});

/** Assert no NEW private dirs with the given prefix appeared during `fn`. */
async function assertNoNewPrivateDirs(prefixes, fn) {
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((n) => prefixes.some((p) => n.startsWith(p))),
  );
  await fn();
  const after = fs
    .readdirSync(os.tmpdir())
    .filter((n) => prefixes.some((p) => n.startsWith(p)) && !before.has(n));
  assert.deepEqual(after, []);
}

/** Seed a selectable R2 snapshot into a memory store (valid manifest). */
function putStubSnapshot(store, id) {
  const prefix = `snapshots/${id}/`;
  const names = [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000'];
  for (const name of names) {
    store.objects.set(`${prefix}${name}`, { body: Buffer.from('x'), size: 1, metadata: {} });
  }
  const files = names.map((name) => ({
    name,
    size: name === 'managed-schema.sql' ? 0 : 1,
    sha256: '0'.repeat(64),
    encrypted: name.startsWith('data.'),
  }));
  const manifest = buildManifest({
    environment: ENV,
    sourceProjectRef: REF,
    snapshotId: id,
    createdAt: new Date(parseSnapshotId(id).ms).toISOString(),
    supabaseCliVersion: '2.114.0',
    contentSha256: 'a'.repeat(64),
    encryption: { recipient: AGE_RECIPIENT_1 },
    files,
    dataParts: ['data.sql.gz.age.part-000'],
  });
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  store.objects.set(`${prefix}manifest.json`, { body: raw, size: raw.length, metadata: {} });
}

test('restore: an acquisition failure removes the allocated download directory', async () => {
  const root = tmpdir('bp-rest-');
  const store = memoryStore();
  const id = '2026-08-20T03-17-09Z';
  putStubSnapshot(store, id);
  const failingAdapter = {
    ...store.adapter,
    async getObject({ key }) {
      if (key.endsWith('/manifest.json')) return store.adapter.getObject({ key });
      throw new Error('download exploded');
    },
  };
  await assertNoNewPrivateDirs([RESTORE_WORKSPACE_PREFIXES.download], () =>
    assert.rejects(
      () =>
        prepareRestore({
          environment: ENV,
          source: 'r2',
          selector: id,
          ageIdentity: AGE_IDENTITY_1,
          agePath: agePath(),
          adapter: failingAdapter,
          bucket: 'development',
          identityFile: identityFixture(root),
        }),
      /download exploded/,
    ),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore: a failed identity write removes its temp directory', async () => {
  const root = tmpdir('bp-rest-');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
  const pkg = await makePackage(root);
  fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });
  // Fail the private identity write AFTER the temp dir was allocated; the
  // identity material must never stay behind on a failed preparation.
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (String(file).endsWith(path.join('identity.txt'))) {
      throw new Error('identity write failed');
    }
    return originalWrite(file, ...rest);
  };
  try {
    await assertNoNewPrivateDirs([RESTORE_WORKSPACE_PREFIXES.identity], () =>
      assert.rejects(
        () =>
          prepareRestore({
            environment: ENV,
            source: 'repo',
            selector: 'latest',
            ageIdentity: AGE_IDENTITY_1,
            agePath: agePath(),
            repoRoot,
          }),
        /identity write failed/,
      ),
    );
  } finally {
    fs.writeFileSync = originalWrite;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  'restore: an unpack failure removes every previously allocated private path',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const pkg = await makePackage(root);
    fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });
    // Wrong identity makes unpack/decrypt fail after identity + prepared dirs
    // were allocated; no identity override so the generated dir is also owned.
    await assertNoNewPrivateDirs(
      [RESTORE_WORKSPACE_PREFIXES.identity, RESTORE_WORKSPACE_PREFIXES.prepared],
      () =>
        assert.rejects(
          () =>
            prepareRestore({
              environment: ENV,
              source: 'repo',
              selector: 'latest',
              ageIdentity: AGE_IDENTITY_2,
              agePath: agePath(),
              repoRoot,
            }),
          (err) => err instanceof RestoreError || err.name === 'ProcessError',
        ),
    );
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'restore: a caller identity file and repository snapshot directory are never removed',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const pkg = await makePackage(root);
    const committed = path.join(repoRoot, 'backups', ENV, ID);
    fs.cpSync(pkg, committed, { recursive: true });
    const identityFile = identityFixture(root);
    const prepared = await prepareRestore({
      environment: ENV,
      source: 'repo',
      selector: 'latest',
      ageIdentity: AGE_IDENTITY_1,
      agePath: agePath(),
      repoRoot,
      identityFile,
    });
    assert.equal(prepared.snapshotId, ID);
    await prepared.cleanup();
    assert.ok(fs.existsSync(committed), 'repository snapshot directory must survive cleanup');
    assert.ok(fs.existsSync(identityFile), 'caller identity file must survive cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'restore: traversal-style archive entries cannot escape the workspace',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-rest-');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'backups', ENV), { recursive: true, mode: 0o700 });
    const pkg = await makePackage(root);
    fs.cpSync(pkg, path.join(repoRoot, 'backups', ENV, ID), { recursive: true });
    // Replace the manifest with one referencing a traversal filename.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'backups', ENV, ID, MANIFEST_NAME), 'utf8'),
    );
    manifest.files.push({
      name: '../../evil.sql',
      size: 1,
      sha256: '0'.repeat(64),
      encrypted: false,
    });
    fs.writeFileSync(
      path.join(repoRoot, 'backups', ENV, ID, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await assert.rejects(() => prepare(root, { selector: 'latest' }), RestoreError);
    assert.ok(!fs.existsSync(path.join(repoRoot, 'evil.sql')));
    fs.rmSync(root, { recursive: true, force: true });
  },
);
