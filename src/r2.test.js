import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createS3Adapter,
  r2Endpoint,
  listSnapshotPrefixes,
  listValidSnapshots,
  selectLatest,
  computeRetentionDeletes,
  computeSameDayDelete,
  deletePrefix,
  uploadSnapshot,
  downloadSnapshot,
  headBucketCheck,
  prefixOf,
  R2Error,
} from './r2.js';
import { S3Client } from '@aws-sdk/client-s3';
import { tmpdir, writePrivateFile, sha256OfFile, AGE_RECIPIENT_1 } from './test-fixtures.js';
import { buildManifest, PLAINTEXT_ARTIFACTS } from './snapshot.js';
import { parseSnapshotId } from './fingerprint.js';

const ENV = 'development';
const REF = 'a1b2c3d4e5f6a7b8c9d0';
const ID = '2026-08-24T03-17-09Z';
const PREFIX = `snapshots/${ID}/`;

/** In-memory object store implementing the S3 adapter contract. */
export function memoryStore() {
  const objects = new Map(); // key -> { body: Buffer, size, metadata }
  const calls = [];
  const adapter = {
    callLog: calls,
    async headBucket() {
      calls.push('headBucket');
    },
    async listObjects({ prefix = '', continuationToken }) {
      calls.push(['listObjects', prefix]);
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const pageSize = 1000;
      const start = continuationToken ? Number(continuationToken) : 0;
      const page = keys.slice(start, start + pageSize);
      return {
        keys: page.map((key) => ({ key, size: objects.get(key).size })),
        isTruncated: start + pageSize < keys.length,
        nextToken: start + pageSize < keys.length ? String(start + pageSize) : undefined,
      };
    },
    async headObject({ key }) {
      calls.push(['headObject', key]);
      const o = objects.get(key);
      if (!o) throw new R2Error(`object not found: ${key}`);
      return { size: o.size, metadata: o.metadata };
    },
    async getObject({ key }) {
      calls.push(['getObject', key]);
      const o = objects.get(key);
      if (!o) throw new R2Error(`object not found: ${key}`);
      const { Readable } = await import('node:stream');
      return { size: o.size, metadata: o.metadata, body: Readable.from([o.body]) };
    },
    async putObject({ key, body, contentLength, contentType, metadata }) {
      calls.push(['putObject', key]);
      let buffer;
      if (Buffer.isBuffer(body)) {
        buffer = body;
      } else {
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk);
        buffer = Buffer.concat(chunks);
      }
      assert.equal(buffer.length, contentLength, `contentLength mismatch for ${key}`);
      objects.set(key, {
        body: buffer,
        size: buffer.length,
        metadata: { ...metadata, contentType },
      });
    },
    async deleteObjects({ keys }) {
      assert.ok(keys.length <= 1000, 'fake API limit: DeleteObjects accepts at most 1,000 keys');
      calls.push(['deleteObjects', keys.length]);
      for (const key of keys) objects.delete(key);
    },
    _objects: objects,
  };
  return { adapter, objects, calls };
}

function putManifest(store, prefix, manifest) {
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  store.objects.set(`${prefix}manifest.json`, { body: raw, size: raw.length, metadata: {} });
}

function putValidSnapshot(store, id, overrides = {}) {
  const prefix = `snapshots/${id}/`;
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    store.objects.set(`${prefix}${name}`, { body: Buffer.from('x'), size: 1, metadata: {} });
  }
  putManifest(store, prefix, makeManifest({ snapshotId: id, ...overrides }));
}

function makeManifest(overrides = {}) {
  const files = overrides.files ?? [
    { name: 'roles.sql', size: 3, sha256: '0'.repeat(64), encrypted: false },
    { name: 'schema.sql', size: 3, sha256: '0'.repeat(64), encrypted: false },
    { name: 'managed-schema.sql', size: 0, sha256: '0'.repeat(64), encrypted: false },
    { name: 'migration-history-schema.sql', size: 3, sha256: '0'.repeat(64), encrypted: false },
    { name: 'data.sql.gz.age.part-000', size: 3, sha256: '0'.repeat(64), encrypted: true },
  ];
  const snapshotId = overrides.snapshotId ?? ID;
  return buildManifest({
    environment: overrides.environment ?? ENV,
    sourceProjectRef: REF,
    snapshotId,
    createdAt: new Date(parseSnapshotId(snapshotId).ms).toISOString(),
    supabaseCliVersion: '2.114.0',
    contentSha256: overrides.contentSha256 ?? 'a'.repeat(64),
    encryption: { recipient: overrides.recipient ?? AGE_RECIPIENT_1 },
    files,
    dataParts: files.filter((f) => f.name.startsWith('data.sql.gz.age.part-')).map((f) => f.name),
  });
}

test('r2: pagination beyond 1,000 keys is grouped correctly', async () => {
  const { adapter, objects } = memoryStore();
  const base = Buffer.from('x');
  for (let i = 0; i < 1200; i++) {
    const date = `2026-08-${String((i % 20) + 1).padStart(2, '0')}`;
    objects.set(`snapshots/${date}T00-00-00Z/f${String(i).padStart(4, '0')}.bin`, {
      body: base,
      size: 1,
      metadata: {},
    });
  }
  const prefixes = await listSnapshotPrefixes({ adapter, bucket: 'development' });
  assert.equal(prefixes.size, 20);
  let total = 0;
  for (const keys of prefixes.values()) total += keys.length;
  assert.equal(total, 1200);
  const listCalls = adapter.callLog.filter((c) => Array.isArray(c) && c[0] === 'listObjects');
  assert.ok(listCalls.length >= 2, 'listObjects must paginate');
});

test('r2: canonical grouping ignores malformed and non-snapshot prefixes', async () => {
  const { adapter, objects } = memoryStore();
  const base = Buffer.from('x');
  const good = 'snapshots/2026-08-24T03-17-09Z/';
  objects.set(`${good}manifest.json`, { body: base, size: 1, metadata: {} });
  objects.set('snapshots/garbage/roles.sql', { body: base, size: 1, metadata: {} });
  objects.set('snapshots/2026-08-24T03-17-09/roles.sql', { body: base, size: 1, metadata: {} });
  objects.set('other/2026-08-24T03-17-09Z/roles.sql', { body: base, size: 1, metadata: {} });
  objects.set('snapshots/2026-02-30T00-00-00Z/roles.sql', { body: base, size: 1, metadata: {} });
  objects.set(`${good}manifest.json/extra`, { body: base, size: 1, metadata: {} });
  const prefixes = await listSnapshotPrefixes({ adapter, bucket: 'development' });
  assert.deepEqual([...prefixes.keys()], [good]);
});

test('r2: newest valid manifest selection; incomplete prefixes are never latest', async () => {
  const store = memoryStore();
  const { adapter, objects } = store;
  const oldId = '2026-08-20T03-17-09Z';
  const midId = '2026-08-22T03-17-09Z';
  const newId = '2026-08-23T03-17-09Z';
  putValidSnapshot(store, oldId);
  putValidSnapshot(store, midId);
  putValidSnapshot(store, newId);
  // An incomplete newer prefix: files exist but no manifest.
  objects.set('snapshots/2026-08-24T00-00-00Z/roles.sql', {
    body: Buffer.from('x'),
    size: 1,
    metadata: {},
  });

  const valid = await listValidSnapshots({
    adapter,
    bucket: 'development',
    expectedEnvironment: ENV,
  });
  assert.deepEqual(
    valid.map((v) => v.snapshotId),
    [oldId, midId, newId],
  );
  const latest = selectLatest(valid);
  assert.equal(latest.snapshotId, newId);

  const incomplete = await listSnapshotPrefixes({ adapter, bucket: 'development' });
  assert.ok(incomplete.has('snapshots/2026-08-24T00-00-00Z/'));
});

test('r2: wrong environment manifests are excluded from selection', async () => {
  const store = memoryStore();
  putValidSnapshot(store, ID, { environment: 'production' });
  const valid = await listValidSnapshots({
    adapter: store.adapter,
    bucket: 'development',
    expectedEnvironment: ENV,
  });
  assert.equal(valid.length, 0);
});

test('r2: exact seven-day retention boundary (manifest timestamp based)', () => {
  const now = new Date('2026-08-24T03:17:09Z').getTime();
  const day = 24 * 60 * 60 * 1000;
  const snapshots = [
    { snapshotId: '2026-08-17T03-17-09Z', manifest: {} },
    { snapshotId: '2026-08-17T03-17-10Z', manifest: {} },
    { snapshotId: '2026-08-18T03-17-09Z', manifest: {} },
    { snapshotId: '2026-08-24T03-17-09Z', manifest: {} },
    { snapshotId: '2026-08-24T10-00-00Z', manifest: {} },
  ];
  const deletes = computeRetentionDeletes({ snapshots, now, retentionDays: 7 });
  assert.deepEqual(
    deletes.map((d) => d.snapshotId),
    ['2026-08-17T03-17-09Z'],
    'exactly seven days old is deleted; 7 days minus a second is kept',
  );
  assert.equal(day, 86400000);
});

test('r2: same-day prefix deletion targets only the matching UTC date', () => {
  const deletes = computeSameDayDelete({
    snapshotId: '2026-08-24T03-17-09Z',
    prefixes: [
      'snapshots/2026-08-24T00-00-00Z/',
      'snapshots/2026-08-24T23-59-59Z/',
      'snapshots/2026-08-23T03-17-09Z/',
      'snapshots/2026-08-25T03-17-09Z/',
    ],
  });
  assert.deepEqual(deletes, ['snapshots/2026-08-24T00-00-00Z/', 'snapshots/2026-08-24T23-59-59Z/']);
});

test('r2: a local read failure during upload is surfaced, never swallowed', async () => {
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  // A directory cannot be read as a file: the upload stream fails with EISDIR.
  const brokenPath = path.join(pkgDir, 'not-a-file');
  fs.mkdirSync(brokenPath, { mode: 0o700 });
  const files = [
    {
      name: 'schema.sql',
      path: brokenPath,
      sha256: '0'.repeat(64),
      contentType: 'application/octet-stream',
    },
  ];
  const manifest = makeManifest();
  // SDK-style adapter: the request fails when the body stream errors.
  const grumpy = {
    async putObject({ body }) {
      try {
        for await (const chunk of body) {
          void chunk; // consume like the SDK request pipeline does
        }
      } catch {
        // the body errored, so the request fails
      }
      throw new Error('Request failed: stream transfer error');
    },
    async headObject() {
      return { size: 0, metadata: {} };
    },
  };
  await assert.rejects(
    () =>
      uploadSnapshot({
        adapter: grumpy,
        bucket: 'development',
        prefix: PREFIX,
        files,
        manifest,
        manifestRaw: '{}',
      }),
    (err) => err instanceof R2Error && /read failed.*schema\.sql/.test(err.message),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: upload verifies with HeadObject and uploads manifest last', async () => {
  const { adapter, calls } = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), `content-${name}`);
    files.push({ name, path: path.join(pkgDir, name), contentType: 'application/octet-stream' });
  }
  const manifest = makeManifest();

  await uploadSnapshot({
    adapter,
    bucket: 'development',
    prefix: PREFIX,
    files: files.map((f) => ({ ...f, sha256: '0'.repeat(64) })),
    manifest,
    manifestRaw: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  const putKeys = calls.filter((c) => c[0] === 'putObject').map((c) => c[1]);
  assert.equal(putKeys.length, 6);
  assert.equal(putKeys[5], `${PREFIX}manifest.json`, 'manifest must upload last');
  assert.ok(!putKeys.slice(0, 5).includes(`${PREFIX}manifest.json`));
  const headKeys = calls.filter((c) => c[0] === 'headObject').map((c) => c[1]);
  assert.ok(headKeys.includes(`${PREFIX}manifest.json`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: manifest upload is verified by size and sha256 like every other object', async () => {
  const store = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), `content-${name}`);
    files.push({ name, path: path.join(pkgDir, name), sha256: '0'.repeat(64) });
  }
  const manifest = makeManifest();
  const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
  // The manifest object is the root of trust: a stored object that differs
  // from the sent bytes (partial/transiently-corrupt write) must fail the
  // upload instead of passing silently until a later restore.
  const tampering = {
    ...store.adapter,
    async putObject(opts) {
      await store.adapter.putObject(opts);
      if (opts.key.endsWith(`${PREFIX}manifest.json`)) {
        store.objects.set(opts.key, {
          body: Buffer.from('{"partial'),
          size: 9,
          metadata: { sha256: '0'.repeat(64) },
        });
      }
    },
  };
  await assert.rejects(
    () =>
      uploadSnapshot({
        adapter: tampering,
        bucket: 'development',
        prefix: PREFIX,
        files,
        manifest,
        manifestRaw,
      }),
    (err) => err instanceof R2Error && /manifest\.json/.test(err.message),
  );
  // A sha256 mismatch alone (correct size, wrong stored hash) is also caught.
  const hashTampering = {
    ...store.adapter,
    async putObject(opts) {
      await store.adapter.putObject(opts);
      if (opts.key.endsWith(`${PREFIX}manifest.json`)) {
        const body = Buffer.from(manifestRaw);
        store.objects.set(opts.key, {
          body,
          size: body.length,
          metadata: { sha256: 'f'.repeat(64) },
        });
      }
    },
  };
  await assert.rejects(
    () =>
      uploadSnapshot({
        adapter: hashTampering,
        bucket: 'development',
        prefix: PREFIX,
        files,
        manifest,
        manifestRaw,
      }),
    (err) => err instanceof R2Error && /manifest\.json/.test(err.message),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: failed upload leaves an incomplete, unselectable prefix', async () => {
  const store = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), 'x');
    files.push({ name, path: path.join(pkgDir, name), sha256: '0'.repeat(64) });
  }
  let count = 0;
  const failing = {
    ...store.adapter,
    async putObject(opts) {
      count += 1;
      if (count === 3) throw new R2Error('injected mid failure');
      await store.adapter.putObject(opts);
    },
  };
  await assert.rejects(
    () =>
      uploadSnapshot({
        adapter: failing,
        bucket: 'development',
        prefix: PREFIX,
        files,
        manifest: makeManifest(),
        manifestRaw: '{}',
      }),
    /injected mid failure/,
  );
  const valid = await listValidSnapshots({
    adapter: store.adapter,
    bucket: 'development',
    expectedEnvironment: ENV,
  });
  assert.equal(valid.length, 0, 'prefix without manifest is never selectable');
  assert.ok(!store.objects.has(`${PREFIX}manifest.json`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: download verifies size and sha256 and rejects mismatches', async () => {
  const store = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), `v-${name}`);
    files.push({ name, path: path.join(pkgDir, name) });
  }
  const manifest = makeManifest({
    files: files.map((f) => ({
      name: f.name,
      size: fs.statSync(f.path).size,
      sha256: 'x',
      encrypted: f.name.startsWith('data.'),
    })),
  });
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of files) {
    const body = fs.readFileSync(f.path);
    store.objects.set(`${PREFIX}${f.name}`, {
      body,
      size: body.length,
      metadata: { sha256: await sha256OfFile(f.path) },
    });
  }
  store.objects.set(`${PREFIX}manifest.json`, { body: raw, size: raw.length, metadata: {} });
  // Real hashes must be in the manifest for verification below.
  for (const f of files) {
    const entry = manifest.files.find((e) => e.name === f.name);
    entry.sha256 = await sha256OfFile(f.path);
  }

  const dest = path.join(dir, 'download');
  const downloaded = await downloadSnapshot({
    adapter: store.adapter,
    bucket: 'development',
    prefix: PREFIX,
    manifest,
    destDir: dest,
  });
  assert.equal(downloaded.length, 6); // five stored files + manifest.json
  for (const entry of manifest.files) {
    assert.equal(await sha256OfFile(path.join(dest, entry.name)), entry.sha256, entry.name);
  }

  // Tamper one object: bytes no longer match the manifest hash.
  const tampered = store.objects.get(`${PREFIX}roles.sql`);
  tampered.body = Buffer.from('tampered-bytes');
  tampered.size = tampered.body.length;
  const dest2 = path.join(dir, 'download2');
  await assert.rejects(
    () =>
      downloadSnapshot({
        adapter: store.adapter,
        bucket: 'development',
        prefix: PREFIX,
        manifest,
        destDir: dest2,
      }),
    (err) => err instanceof R2Error && /roles\.sql/.test(err.message),
  );
  assert.ok(!fs.existsSync(dest2), 'failed download must not leave a partial directory');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: valid-snapshot scan reports ordered valid/ignored outcomes only', async () => {
  const store = memoryStore();
  const validId = '2026-08-20T03-17-09Z';
  const ignoredMissingManifest = '2026-08-21T03-17-09Z';
  const ignoredWrongEnv = '2026-08-22T03-17-09Z';
  putValidSnapshot(store, validId);
  // Incomplete: files but no manifest.json.
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    store.objects.set(`snapshots/${ignoredMissingManifest}/${name}`, {
      body: Buffer.from('x'),
      size: 1,
      metadata: {},
    });
  }
  // Valid manifest but wrong environment.
  putValidSnapshot(store, ignoredWrongEnv, { environment: 'production' });
  const progress = [];
  const valid = await listValidSnapshots({
    adapter: store.adapter,
    bucket: 'development',
    expectedEnvironment: ENV,
    onProgress: (message) => progress.push(message),
  });
  assert.deepEqual(
    valid.map((v) => v.snapshotId),
    [validId],
  );
  assert.deepEqual(progress, [
    `starting snapshot inspection 1/3: ${validId}`,
    `completed snapshot inspection 1/3: ${validId}: valid`,
    `starting snapshot inspection 2/3: ${ignoredMissingManifest}`,
    `completed snapshot inspection 2/3: ${ignoredMissingManifest}: ignored`,
    `starting snapshot inspection 3/3: ${ignoredWrongEnv}`,
    `completed snapshot inspection 3/3: ${ignoredWrongEnv}: ignored`,
  ]);
  assert.ok(
    progress.every((m) => !m.includes('manifest')),
    'rejection reasons must stay hidden',
  );
});

test('r2: upload progress follows put/head order and ends with verified manifest', async () => {
  const store = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), `content-${name}`);
    files.push({ name, path: path.join(pkgDir, name), sha256: '0'.repeat(64) });
  }
  const progress = [];
  await uploadSnapshot({
    adapter: store.adapter,
    bucket: 'development',
    prefix: PREFIX,
    files,
    manifest: makeManifest(),
    manifestRaw: '{}',
    onProgress: (message) => progress.push(message),
  });
  assert.ok(
    progress[0].startsWith(`starting snapshot object upload 1/6: ${PLAINTEXT_ARTIFACTS[0]}`),
  );
  assert.ok(progress[1].endsWith(': verified'));
  assert.equal(
    progress[progress.length - 1],
    'completed snapshot object upload 6/6: manifest.json: verified',
  );
  assert.equal(progress[progress.length - 2], 'starting snapshot object upload 6/6: manifest.json');
  // Every completion line directly follows the corresponding put+head pair.
  const putKeys = store.calls.filter((c) => c[0] === 'putObject').map((c) => c[1]);
  const headKeys = store.calls.filter((c) => c[0] === 'headObject').map((c) => c[1]);
  assert.ok(
    progress[1] === `completed snapshot object upload 1/6: ${PLAINTEXT_ARTIFACTS[0]}: verified`,
  );
  assert.ok(progress[0].includes(putKeys[0].split('/').at(-1)));
  assert.ok(progress[1].includes(headKeys[0].split('/').at(-1)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: head mismatch suppresses completion and later objects', async () => {
  const store = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), `content-${name}`);
    files.push({ name, path: path.join(pkgDir, name), sha256: '0'.repeat(64) });
  }
  const progress = [];
  const failing = {
    ...store.adapter,
    async headObject(opts) {
      await store.adapter.headObject(opts);
      if (opts.key.endsWith('schema.sql')) {
        return { size: 1, metadata: { sha256: 'f'.repeat(64) } };
      }
      const o = store.objects.get(opts.key);
      return { size: o.size, metadata: o.metadata };
    },
  };
  await assert.rejects(
    () =>
      uploadSnapshot({
        adapter: failing,
        bucket: 'development',
        prefix: PREFIX,
        files,
        manifest: makeManifest(),
        manifestRaw: '{}',
        onProgress: (message) => progress.push(message),
      }),
    (err) => err instanceof R2Error && /schema\.sql/.test(err.message),
  );
  assert.ok(progress.includes('starting snapshot object upload 2/6: schema.sql'));
  assert.ok(!progress.includes('completed snapshot object upload 2/6: schema.sql'));
  assert.ok(!progress.some((m) => m.includes('3/6') || m.includes('manifest.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: deletePrefix reports listing count and every delete batch', async () => {
  const { adapter, calls, objects } = memoryStore();
  const base = Buffer.from('x');
  const prefix = 'snapshots/2026-08-01T00-00-00Z/';
  for (let i = 0; i < 2500; i++) {
    objects.set(`${prefix}part-${String(i).padStart(4, '0')}`, {
      body: base,
      size: 1,
      metadata: {},
    });
  }
  const progress = [];
  await deletePrefix({
    adapter,
    bucket: 'development',
    prefix,
    onProgress: (message) => progress.push(message),
  });
  assert.deepEqual(progress.slice(0, 2), [
    'starting cleanup object listing',
    'completed cleanup object listing: 2500 object(s)',
  ]);
  const batches = calls.filter((c) => c[0] === 'deleteObjects').map((c) => c[1]);
  assert.equal(batches.length, 3);
  assert.deepEqual(progress.slice(2), [
    'starting delete batch 1/3: 1000 object(s)',
    'completed delete batch 1/3: 1000 object(s)',
    'starting delete batch 2/3: 1000 object(s)',
    'completed delete batch 2/3: 1000 object(s)',
    'starting delete batch 3/3: 500 object(s)',
    'completed delete batch 3/3: 500 object(s)',
  ]);
  assert.equal(objects.size, 0);
});

test('r2: failed delete batch has no completion line', async () => {
  const { adapter, objects } = memoryStore();
  const base = Buffer.from('x');
  const prefix = 'snapshots/2026-08-01T00-00-00Z/';
  for (let i = 0; i < 2500; i++) {
    objects.set(`${prefix}part-${String(i).padStart(4, '0')}`, {
      body: base,
      size: 1,
      metadata: {},
    });
  }
  const progress = [];
  let count = 0;
  const failing = {
    ...adapter,
    async deleteObjects(opts) {
      count += 1;
      if (count === 2) throw new R2Error('injected batch failure');
      await adapter.deleteObjects(opts);
    },
  };
  await assert.rejects(
    () =>
      deletePrefix({
        adapter: failing,
        bucket: 'development',
        prefix,
        onProgress: (message) => progress.push(message),
      }),
    /injected batch failure/,
  );
  assert.ok(progress.includes('starting delete batch 2/3: 1000 object(s)'));
  assert.ok(!progress.includes('completed delete batch 2/3: 1000 object(s)'));
  assert.ok(!progress.some((m) => m.includes('3/3')));
});

test('r2: deleteObjects reports per-key failures from a resolved response', async () => {
  const adapter = createS3Adapter({
    accountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  });
  const seen = [];
  test.mock.method(S3Client.prototype, 'send', async (command) => {
    seen.push(command.constructor.name);
    return {
      Errors: [
        { Key: 'snapshots/2026-08-01T00-00-00Z/roles.sql', Code: 'InternalError', Message: 'boom' },
        {
          Key: 'snapshots/2026-08-01T00-00-00Z/schema.sql',
          Code: 'InternalError',
          Message: 'boom',
        },
      ],
    };
  });
  await assert.rejects(
    () => adapter.deleteObjects({ bucket: 'development', keys: ['a', 'b'] }),
    (err) =>
      err instanceof R2Error &&
      /delete failed for 2 object\(s\)/.test(err.message) &&
      /roles\.sql/.test(err.message),
    'a resolved response with per-key Errors must not be treated as success',
  );
  assert.deepEqual(seen, ['DeleteObjectsCommand']);
});

test('r2: deleteObjects accepts a resolved response without per-key errors', async () => {
  const adapter = createS3Adapter({
    accountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  });
  const seen = [];
  test.mock.method(S3Client.prototype, 'send', async (command) => {
    seen.push(command.constructor.name);
    return {};
  });
  await adapter.deleteObjects({ bucket: 'development', keys: ['a', 'b'] });
  assert.deepEqual(seen, ['DeleteObjectsCommand']);
});

test('r2: deletePrefix on an empty prefix reports the listing count only', async () => {
  const { adapter, calls } = memoryStore();
  const progress = [];
  const count = await deletePrefix({
    adapter,
    bucket: 'development',
    prefix: 'snapshots/2026-08-01T00-00-00Z/',
    onProgress: (message) => progress.push(message),
  });
  assert.equal(count, 0);
  assert.deepEqual(progress, [
    'starting cleanup object listing',
    'completed cleanup object listing: 0 object(s)',
  ]);
  assert.equal(calls.filter((c) => c[0] === 'deleteObjects').length, 0);
});

test('r2: deletePrefix lists every object and deletes in API-sized batches', async () => {
  const { adapter, calls, objects } = memoryStore();
  const base = Buffer.from('x');
  const prefix = 'snapshots/2026-08-01T00-00-00Z/';
  for (let i = 0; i < 2500; i++) {
    objects.set(`${prefix}part-${String(i).padStart(4, '0')}`, {
      body: base,
      size: 1,
      metadata: {},
    });
  }
  await deletePrefix({ adapter, bucket: 'development', prefix });
  const batches = calls.filter((c) => c[0] === 'deleteObjects').map((c) => c[1]);
  assert.equal(batches.length, 3);
  for (const batchSize of batches) {
    assert.ok(batchSize <= 1000, `batch of ${batchSize} exceeds API limit`);
  }
  assert.equal(objects.size, 0, 'every listed object must be deleted');
});

test('r2: headBucketCheck passes and surfaces failures cleanly', async () => {
  const { adapter } = memoryStore();
  await headBucketCheck({ adapter, bucket: 'development' });
  const failing = {
    ...adapter,
    async headBucket() {
      throw new R2Error('AccessDenied');
    },
  };
  await assert.rejects(
    () => headBucketCheck({ adapter: failing, bucket: 'development' }),
    (err) => err instanceof R2Error && /development/.test(err.message),
  );
});

test('r2: createS3Adapter accepts a custom endpoint override for local fixtures', () => {
  const adapter = createS3Adapter({
    accountId: '0123456789abcdef0123456789abcdef',
    accessKeyId: 'akid',
    secretAccessKey: 'secret',
    endpoint: 'http://127.0.0.1:9000',
  });
  assert.ok(adapter.headBucket);
  // Endpoint is config, not credentials: it must serialize without exposing
  // keys just like the default adapter test.
  const serialized = JSON.stringify(adapter);
  assert.ok(!serialized.includes('akid'));
  assert.ok(!serialized.includes('secret'));
});

test('r2: prefix helpers build canonical object names', () => {
  assert.equal(prefixOf(ID), PREFIX);
  assert.equal(`${prefixOf(ID)}manifest.json`, `${PREFIX}manifest.json`);
});

test('r2: createS3Adapter builds the R2 endpoint without exposing credentials', () => {
  assert.equal(
    r2Endpoint('0123456789abcdef0123456789abcdef'),
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  );
  const adapter = createS3Adapter({
    accountId: '0123456789abcdef0123456789abcdef',
    accessKeyId: 'akid',
    secretAccessKey: 'top-secret-cred',
  });
  const serialized = JSON.stringify(adapter);
  assert.ok(!serialized.includes('akid'), 'access key must not serialize');
  assert.ok(!serialized.includes('top-secret-cred'), 'secret key must not serialize');
});

test('r2: manifest-download size failure removes the destination', async () => {
  const store = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), name);
    files.push({
      name,
      size: fs.statSync(path.join(pkgDir, name)).size,
      sha256: await sha256OfFile(path.join(pkgDir, name)),
      encrypted: name.startsWith('data.'),
    });
  }
  const manifest = makeManifest({ files });
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of files) {
    store.objects.set(`${PREFIX}${f.name}`, {
      body: fs.readFileSync(path.join(pkgDir, f.name)),
      size: f.size,
      metadata: {},
    });
  }
  store.objects.set(`${PREFIX}manifest.json`, { body: raw, size: raw.length, metadata: {} });
  const dest = path.join(dir, 'download');
  await assert.rejects(
    () =>
      downloadSnapshot({
        adapter: store.adapter,
        bucket: 'development',
        prefix: PREFIX,
        manifest,
        destDir: dest,
        limits: { maxManifestBytes: 4 },
      }),
    (err) => err instanceof R2Error && /manifest exceeds size limit/.test(err.message),
  );
  assert.ok(!fs.existsSync(dest), 'destination must be removed after manifest-download failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: a mid-stream transfer failure removes the destination', async () => {
  const store = memoryStore();
  const dir = tmpdir('bp-r2-');
  const pkgDir = path.join(dir, 'pkg');
  fs.mkdirSync(pkgDir, { mode: 0o700 });
  const files = [];
  for (const name of [...PLAINTEXT_ARTIFACTS, 'data.sql.gz.age.part-000']) {
    writePrivateFile(path.join(pkgDir, name), name);
    files.push({
      name,
      size: fs.statSync(path.join(pkgDir, name)).size,
      sha256: await sha256OfFile(path.join(pkgDir, name)),
      encrypted: name.startsWith('data.'),
    });
  }
  const manifest = makeManifest({ files });
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of files) {
    store.objects.set(`${PREFIX}${f.name}`, {
      body: fs.readFileSync(path.join(pkgDir, f.name)),
      size: f.size,
      metadata: {},
    });
  }
  store.objects.set(`${PREFIX}manifest.json`, { body: raw, size: raw.length, metadata: {} });
  const { Readable } = await import('node:stream');
  const failing = {
    ...store.adapter,
    async getObject({ key }) {
      const real = await store.adapter.getObject({ key });
      let pushed = false;
      const body = new Readable({
        read() {
          if (!pushed) {
            pushed = true;
            this.push(Buffer.from('partial'));
          } else {
            this.destroy(new Error('stream transfer failed'));
          }
        },
      });
      return { ...real, body };
    },
  };
  const dest = path.join(dir, 'download');
  await assert.rejects(
    () =>
      downloadSnapshot({
        adapter: failing,
        bucket: 'development',
        prefix: PREFIX,
        manifest,
        destDir: dest,
      }),
    /stream transfer failed/,
  );
  assert.ok(!fs.existsSync(dest), 'destination must be removed after a transfer failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r2: retention never deletes the last valid snapshot (unchanged-database availability)', () => {
  const now = new Date('2026-08-24T03:17:09Z').getTime();
  // A single valid snapshot far older than the window must survive: an
  // unchanged database would otherwise lose its only R2 copy.
  const old = { snapshotId: '2026-08-10T03-17-09Z', manifest: {} };
  assert.deepEqual(
    computeRetentionDeletes({ snapshots: [old], now, retentionDays: 7 }),
    [],
    'the only snapshot must survive retention',
  );
  // With a never-valid (incomplete) newer prefix present, only the incomplete
  // prefix is deletable; the newest VALID snapshot is kept.
  const mixed = [
    { snapshotId: '2026-08-10T03-17-09Z', manifest: {} },
    { snapshotId: '2026-08-11T00-00-00Z', manifest: null },
  ];
  assert.deepEqual(
    computeRetentionDeletes({ snapshots: mixed, now, retentionDays: 7 }).map((d) => d.snapshotId),
    ['2026-08-11T00-00-00Z'],
    'incomplete prefixes are still cleaned; the valid snapshot is kept',
  );
  // A recent incomplete prefix must NOT bypass the guard: the valid snapshot
  // is expired, the incomplete prefix is not, and deleting the expired set
  // would remove the only recoverable copy.
  const guardBypass = [
    { snapshotId: '2026-08-10T03-17-09Z', manifest: {} },
    { snapshotId: '2026-08-22T00-00-00Z', manifest: null },
  ];
  assert.deepEqual(
    computeRetentionDeletes({ snapshots: guardBypass, now, retentionDays: 7 }).map(
      (d) => d.snapshotId,
    ),
    [],
    'the only valid snapshot must survive even when a recent incomplete prefix exists',
  );
  // Normal many-snapshot cleanup is unchanged: recent snapshots stay, old ones go.
  const many = [
    { snapshotId: '2026-08-10T03-17-09Z', manifest: {} },
    { snapshotId: '2026-08-12T03-17-09Z', manifest: {} },
    { snapshotId: '2026-08-24T03-17-09Z', manifest: {} },
  ];
  assert.deepEqual(
    computeRetentionDeletes({ snapshots: many, now, retentionDays: 7 }).map((d) => d.snapshotId),
    ['2026-08-10T03-17-09Z', '2026-08-12T03-17-09Z'],
    'the recent snapshot stays; both expired ones go',
  );
});
