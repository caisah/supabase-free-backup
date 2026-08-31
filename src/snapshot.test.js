import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  packageSnapshot,
  validatePackagedDirectory,
  unpackAndVerify,
  buildManifest,
  resolvePrivatePath,
  sameSnapshotContent,
  PLAINTEXT_ARTIFACTS,
  MANIFEST_NAME,
  SnapshotError,
  PART_PREFIX,
  MANIFEST_SCHEMA,
} from './snapshot.js';
import {
  tmpdir,
  writePrivateFile,
  fileMode,
  AGE_IDENTITY_1,
  AGE_RECIPIENT_1,
  AGE_IDENTITY_2,
  AGE_RECIPIENT_2,
  ageAvailable,
  agePath,
  sha256OfFile,
  fakeAge,
} from './test-fixtures.js';

const ENV = 'development';
const REF = 'a1b2c3d4e5f6a7b8c9d0';
const ID = '2026-08-24T03-17-09Z';

function makeSourceDir(root) {
  const dir = path.join(root, 'source');
  fs.mkdirSync(dir, { mode: 0o700 });
  writePrivateFile(path.join(dir, 'roles.sql'), 'CREATE ROLE app;\n');
  writePrivateFile(path.join(dir, 'schema.sql'), 'CREATE TABLE public.t (id int);\n');
  writePrivateFile(
    path.join(dir, 'managed-schema.sql'),
    'CREATE TRIGGER trg ON auth.users EXECUTE FUNCTION f();\n',
  );
  writePrivateFile(
    path.join(dir, 'migration-history-schema.sql'),
    'CREATE TABLE supabase_migrations.schema_migrations (version text);\n',
  );
  writePrivateFile(
    path.join(dir, 'migration-history-data.sql'),
    'COPY supabase_migrations.schema_migrations FROM stdin;\n1\n\\.\n',
  );
  writePrivateFile(path.join(dir, 'database-data.sql'), 'COPY "public"."t" FROM stdin;\n42\n\\.\n');
  return dir;
}

/** Deterministic age stand-in used only for structural tests. */
async function packageFixture(root, overrides = {}) {
  const sourceDir = makeSourceDir(root);
  const destDir = path.join(root, 'pkg');
  await packageSnapshot({
    sourceDir,
    destDir,
    snapshotId: overrides.snapshotId ?? ID,
    environment: overrides.environment ?? ENV,
    sourceProjectRef: overrides.sourceProjectRef ?? REF,
    supabaseCliVersion: overrides.supabaseCliVersion ?? '2.114.0',
    ageRecipient: AGE_RECIPIENT_1,
    run: fakeAge,
  });
  return { sourceDir, destDir };
}

/** Plaintext package fixture: no age binary, no run seam, no recipient. */
async function packageFixturePlain(root, overrides = {}) {
  const sourceDir = makeSourceDir(root);
  const destDir = path.join(root, 'pkg');
  await packageSnapshot({
    sourceDir,
    destDir,
    snapshotId: overrides.snapshotId ?? ID,
    environment: overrides.environment ?? ENV,
    sourceProjectRef: overrides.sourceProjectRef ?? REF,
    supabaseCliVersion: overrides.supabaseCliVersion ?? '2.114.0',
    format: 'none',
    ageRecipient: undefined,
  });
  return { sourceDir, destDir };
}

test('snapshot: sameSnapshotContent requires matching content hash AND encryption state', () => {
  const manifest = {
    contentSha256: 'a'.repeat(64),
    encryption: { recipient: AGE_RECIPIENT_1 },
  };
  const equal = {
    contentSha256: 'a'.repeat(64),
    encryption: { recipient: AGE_RECIPIENT_1 },
  };
  const hashChanged = {
    contentSha256: 'b'.repeat(64),
    encryption: { recipient: AGE_RECIPIENT_1 },
  };
  const recipientChanged = {
    contentSha256: 'a'.repeat(64),
    encryption: { recipient: AGE_RECIPIENT_2 },
  };
  assert.equal(sameSnapshotContent(manifest, equal), true);
  assert.equal(sameSnapshotContent(manifest, hashChanged), false, 'hash change must differ');
  assert.equal(
    sameSnapshotContent(manifest, recipientChanged),
    false,
    'recipient change must differ',
  );
  assert.equal(sameSnapshotContent(null, manifest), false, 'absent left input');
  assert.equal(sameSnapshotContent(manifest, undefined), false, 'absent right input');
  assert.equal(sameSnapshotContent(null, undefined), false, 'both absent');
  assert.equal(
    sameSnapshotContent({ contentSha256: 'a'.repeat(64) }, { contentSha256: 'a'.repeat(64) }),
    false,
    'missing recipients must never compare equal',
  );
});

test('snapshot: sameSnapshotContent is format-aware for plaintext snapshots', () => {
  const hash = 'a'.repeat(64);
  const noneA = { contentSha256: hash, encryption: { format: 'none' } };
  const noneB = { contentSha256: hash, encryption: { format: 'none' } };
  const agePartial = { contentSha256: hash, encryption: { recipient: AGE_RECIPIENT_1 } };
  const agePartialRd = { contentSha256: hash, encryption: { recipient: AGE_RECIPIENT_2 } };
  assert.equal(sameSnapshotContent(noneA, noneB), true, 'two none snapshots, same hash');
  assert.equal(
    sameSnapshotContent({ ...noneA, contentSha256: 'b'.repeat(64) }, noneB),
    false,
    'none snapshots with differing hashes must differ',
  );
  assert.equal(
    sameSnapshotContent(noneA, agePartial),
    false,
    'plaintext vs encrypted must never compare equal regardless of hash',
  );
  assert.equal(
    sameSnapshotContent(agePartial, agePartial),
    true,
    'age vs partial RHS, same recipient',
  );
  assert.equal(
    sameSnapshotContent(agePartial, agePartialRd),
    false,
    'age vs partial RHS with a different recipient must differ',
  );
});

test('snapshot: buildManifest rejects unknown formats instead of emitting bare recipients', () => {
  assert.throws(
    () =>
      buildManifest({
        environment: ENV,
        sourceProjectRef: REF,
        snapshotId: ID,
        createdAt: '2026-08-24T03:17:09.000Z',
        supabaseCliVersion: '2.114.0',
        contentSha256: 'a'.repeat(64),
        encryption: { format: 'aes-gcm' },
        files: [],
        dataParts: ['data.sql.gz.part-000'],
      }),
    /unknown row-data format: aes-gcm/,
  );
});

test('snapshot: plaintext package validates without age or encryption', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixturePlain(root);
  const { manifest } = await validatePackagedDirectory(destDir, {
    expectedEnvironment: ENV,
    expectedSnapshotId: ID,
  });
  assert.deepEqual(manifest.encryption, { format: 'none' }, 'no recipient key on plaintext');
  assert.ok(manifest.dataParts.length >= 1);
  assert.ok(
    manifest.dataParts.every((n) => /^data\.sql\.gz\.part-\d{3}$/.test(n)),
    'plaintext part names',
  );
  assert.ok(
    manifest.files
      .filter((f) => f.name.startsWith('data.sql.gz.part-'))
      .every((f) => f.encrypted === false),
    'plaintext part entries must be unencrypted',
  );
  for (const entry of manifest.files) {
    assert.equal(await sha256OfFile(path.join(destDir, entry.name)), entry.sha256, entry.name);
  }
  const entries = fs.readdirSync(destDir);
  for (const forbidden of ['data.sql', 'data.sql.gz', 'data.sql.gz.age', '.age']) {
    assert.ok(!entries.some((n) => n === forbidden || n.endsWith('.age')), forbidden);
  }
  assert.equal(fileMode(destDir), 0o700);
  for (const entry of entries) {
    if (entry === 'manifest.json') continue;
    assert.equal(fileMode(path.join(destDir, entry)), 0o600, entry);
  }
  // The none-format manifest must round-trip byte-identically through the builder.
  const raw = fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8');
  const rebuilt = JSON.stringify(buildManifest(JSON.parse(raw)), null, 2) + '\n';
  assert.equal(rebuilt, raw, 'none-format manifest round-trip must be byte-identical');
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: plaintext package unpacks without identity or age binary', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixturePlain(root);
  const unpackRoot = tmpdir('bp-unpack-');
  const prepared = await unpackAndVerify({
    sourceDir: destDir,
    destDir: path.join(unpackRoot, 'prepared'),
    expectedEnvironment: ENV,
  });
  const expected =
    'COPY supabase_migrations.schema_migrations FROM stdin;\n1\n\\.\nCOPY "public"."t" FROM stdin;\n42\n\\.\n';
  assert.equal(fs.readFileSync(prepared.dataPath, 'utf8'), expected);
  assert.equal(fileMode(prepared.dataPath), 0o600);
  const packagedManifest = JSON.parse(fs.readFileSync(path.join(destDir, MANIFEST_NAME), 'utf8'));
  assert.equal(
    prepared.contentSha256,
    packagedManifest.contentSha256,
    'aggregate fingerprint must match between package and unpack',
  );
  for (const name of [...PLAINTEXT_ARTIFACTS, MANIFEST_NAME]) {
    assert.ok(fs.existsSync(path.join(prepared.dir, name)), name);
  }
  const leftovers = fs.readdirSync(prepared.dir);
  assert.ok(
    !leftovers.some((n) => n.endsWith('.age') || n.endsWith('.gz') || n.includes('.part-')),
    leftovers.join(','),
  );
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(unpackRoot, { recursive: true, force: true });
});

test('snapshot: plaintext tampered parts and fingerprint mismatch fail', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixturePlain(root);
  const firstPart = path.join(destDir, 'data.sql.gz.part-000');
  const bytes = fs.readFileSync(firstPart);
  bytes[bytes.length - 5] ^= 0x01;
  fs.writeFileSync(firstPart, bytes);
  await assert.rejects(
    () =>
      unpackAndVerify({
        sourceDir: destDir,
        destDir: path.join(root, 'prepared-tampered'),
        expectedEnvironment: ENV,
      }),
    (err) => err instanceof SnapshotError && /SIZE|CHECKSUM/i.test(err.message),
  );
  assert.ok(!fs.existsSync(path.join(root, 'prepared-tampered')));

  const fresh = tmpdir('bp-snap-');
  const { destDir: freshDir } = await packageFixturePlain(fresh);
  const manifestPath = path.join(freshDir, MANIFEST_NAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.contentSha256 = 'f'.repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    () =>
      unpackAndVerify({
        sourceDir: freshDir,
        destDir: path.join(fresh, 'prepared-fingerprint'),
        expectedEnvironment: ENV,
      }),
    (err) => err instanceof SnapshotError && /FINGERPRINT MISMATCH/.test(err.message),
  );
  assert.ok(!fs.existsSync(path.join(fresh, 'prepared-fingerprint')));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
});

test('snapshot: valid version 1 package passes validation', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixture(root);
  const { manifest } = await validatePackagedDirectory(destDir, {
    expectedEnvironment: ENV,
    expectedSnapshotId: ID,
  });
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.environment, ENV);
  assert.equal(manifest.sourceProjectRef, REF);
  assert.equal(manifest.snapshotId, ID);
  assert.equal(manifest.postgresMajorVersion, 17);
  assert.equal(manifest.supabaseCliVersion, '2.114.0');
  assert.match(manifest.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.encryption.format, 'age-x25519');
  assert.equal(manifest.encryption.recipient, AGE_RECIPIENT_1);
  assert.deepEqual(
    manifest.files.map((f) => f.name).filter((n) => !n.startsWith(PART_PREFIX)),
    PLAINTEXT_ARTIFACTS,
  );
  assert.ok(manifest.dataParts.length >= 1);
  assert.ok(manifest.dataParts.every((n) => n.startsWith(PART_PREFIX)));
  // On-disk contents match the manifest hashes.
  for (const entry of manifest.files) {
    assert.equal(await sha256OfFile(path.join(destDir, entry.name)), entry.sha256, entry.name);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: packaged output contains no plaintext row-data intermediates', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir, sourceDir } = await packageFixture(root);
  const entries = fs.readdirSync(destDir);
  for (const forbidden of [
    'data.sql',
    'data.sql.gz',
    'data.sql.gz.age',
    'migration-history-data.sql',
    'database-data.sql',
  ]) {
    assert.ok(!entries.includes(forbidden), `${forbidden} must not be packaged`);
  }
  assert.ok(!fs.existsSync(path.join(destDir, '.packaging-tmp')));
  // Private modes: directory and stored files.
  assert.equal(fileMode(destDir), 0o700);
  for (const entry of entries) {
    if (entry === 'manifest.json') continue;
    assert.equal(fileMode(path.join(destDir, entry)), 0o600, entry);
  }
  // The dump sources remain owned by the caller.
  assert.ok(fs.existsSync(path.join(sourceDir, 'database-data.sql')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: manifest.json is stable JSON with a trailing newline', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixture(root);
  const raw = fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.formatVersion, 1);
  // Re-stringifying with the same builder yields identical bytes (stable order).
  const rebuilt = JSON.stringify(buildManifest(parsed), null, 2) + '\n';
  assert.equal(rebuilt, raw);
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  'snapshot: identical logical dumps yield the same contentSha256 with randomized ciphertext',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-snap-');
    const sourceDir = makeSourceDir(root);
    const destA = path.join(root, 'pkgA');
    const destB = path.join(root, 'pkgB');
    await packageSnapshot({
      sourceDir,
      destDir: destA,
      snapshotId: ID,
      environment: ENV,
      sourceProjectRef: REF,
      supabaseCliVersion: '2.114.0',
      ageRecipient: AGE_RECIPIENT_1,
      agePath: agePath(),
    });
    await packageSnapshot({
      sourceDir,
      destDir: destB,
      snapshotId: ID,
      environment: ENV,
      sourceProjectRef: REF,
      supabaseCliVersion: '2.114.0',
      ageRecipient: AGE_RECIPIENT_1,
      agePath: agePath(),
    });
    const { manifest: mA } = await validatePackagedDirectory(destA);
    const { manifest: mB } = await validatePackagedDirectory(destB);
    assert.equal(mA.contentSha256, mB.contentSha256);
    // Ciphertext itself is randomized: part bytes differ between packages.
    assert.notEqual(
      await sha256OfFile(path.join(destA, mA.dataParts[0])),
      await sha256OfFile(path.join(destB, mB.dataParts[0])),
    );
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test('snapshot: wrong environment or snapshot id in expectations fails', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixture(root);
  await assert.rejects(
    () => validatePackagedDirectory(destDir, { expectedEnvironment: 'production' }),
    (err) => err instanceof SnapshotError && /environment/i.test(err.message),
  );
  await assert.rejects(
    () => validatePackagedDirectory(destDir, { expectedSnapshotId: '2026-01-01T00-00-00Z' }),
    (err) => err instanceof SnapshotError && /snapshot/i.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: unknown versions, properties, and bad values fail manifest validation', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixture(root);
  const raw = JSON.parse(fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8'));

  const cases = [
    ['formatVersion 2', { ...raw, formatVersion: 2 }],
    ['unknown top-level property', { ...raw, adminNote: 'hi' }],
    ['unknown file entry property', { ...raw, files: [{ ...raw.files[0], evil: true }] }],
    [
      'unknown file name',
      {
        ...raw,
        files: [
          ...raw.files,
          { name: 'evil.sql', size: 1, sha256: '0'.repeat(64), encrypted: false },
        ],
      },
    ],
    [
      'plaintext data.sql entry',
      {
        ...raw,
        files: [
          ...raw.files,
          { name: 'data.sql', size: 1, sha256: '0'.repeat(64), encrypted: false },
        ],
      },
    ],
    [
      'traversal file name',
      {
        ...raw,
        files: [
          ...raw.files,
          { name: '../evil.sql', size: 1, sha256: '0'.repeat(64), encrypted: false },
        ],
      },
    ],
    [
      'path separator file name',
      {
        ...raw,
        files: [
          ...raw.files,
          { name: 'a/b.sql', size: 1, sha256: '0'.repeat(64), encrypted: false },
        ],
      },
    ],
    [
      'absent plaintext artifact',
      { ...raw, files: raw.files.filter((f) => f.name !== 'roles.sql') },
    ],
    ['duplicate part', { ...raw, dataParts: [...raw.dataParts, raw.dataParts[0]] }],
    ['reordered parts', { ...raw, dataParts: [raw.dataParts[0], 'data.sql.gz.age.part-001'] }],
    ['noncontiguous parts', { ...raw, dataParts: [raw.dataParts[0], 'data.sql.gz.age.part-002'] }],
    ['missing data parts', { ...raw, dataParts: [] }],
    [
      'oversized part',
      {
        ...raw,
        files: raw.files.map((f) =>
          f.name === raw.dataParts[0] ? { ...f, size: 95 * 1024 * 1024 } : f,
        ),
      },
    ],
    ['bad postgres version', { ...raw, postgresMajorVersion: 16 }],
    ['bad content hash', { ...raw, contentSha256: 'zz' }],
    ['bad recipient', { ...raw, encryption: { ...raw.encryption, recipient: 'nope' } }],
    ['bad encryption format', { ...raw, encryption: { ...raw.encryption, format: 'aes-gcm' } }],
    [
      'none format with a stray recipient',
      { ...raw, encryption: { format: 'none', recipient: AGE_RECIPIENT_1 } },
    ],
    [
      'age format with a plaintext part name',
      {
        ...raw,
        dataParts: raw.dataParts.map((n) => n.replace('.age.', '')),
        files: raw.files.map((f) =>
          f.name.startsWith('data.sql.gz.age.part-')
            ? { ...f, name: f.name.replace('.age.', '') }
            : f,
        ),
      },
    ],
    ['none format with an age part name', { ...raw, encryption: { format: 'none' } }],
    [
      'none format part marked encrypted',
      {
        ...raw,
        encryption: { format: 'none' },
        dataParts: raw.dataParts.map((n) => n.replace('.age.', '')),
        files: raw.files.map((f) =>
          f.name.startsWith('data.sql.gz.age.part-')
            ? { ...f, name: f.name.replace('.age.', ''), encrypted: true }
            : f,
        ),
      },
    ],
    [
      'identity in manifest',
      { ...raw, ageIdentity: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ' },
    ],
    ['db url in manifest', { ...raw, dbUrl: 'postgresql://user:pw@host:5432/db' }],
    ['non-canonical snapshot id', { ...raw, snapshotId: '2026-08-24T03:17:09' }],
    ['createdAt mismatch', { ...raw, createdAt: '2026-08-25T03:17:09.000Z' }],
    [
      'part with encrypted=false',
      {
        ...raw,
        files: raw.files.map((f) =>
          f.name.startsWith('data.sql.gz.age.part-') ? { ...f, encrypted: false } : f,
        ),
      },
    ],
  ];
  for (const [label, manifest] of cases) {
    await assert.rejects(
      () => validatePackagedDirectory(destDir, { manifestOverride: manifest }),
      (err) => err instanceof SnapshotError,
      label,
    );
    const schemaResult = MANIFEST_SCHEMA.safeParse(manifest);
    assert.equal(schemaResult.success, false, `schema must reject: ${label}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: size and hash mismatches fail directory validation', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixture(root);
  const schemaPath = path.join(destDir, 'schema.sql');
  fs.chmodSync(schemaPath, 0o600);
  fs.appendFileSync(schemaPath, '-- tampered');
  await assert.rejects(
    () => validatePackagedDirectory(destDir),
    (err) => err instanceof SnapshotError && /schema\.sql/i.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: missing file, extra file, and symlink fail directory validation', async () => {
  const root = tmpdir('bp-snap-');
  const { destDir } = await packageFixture(root);

  const extra = path.join(destDir, 'unlisted.sql');
  writePrivateFile(extra, 'not in manifest');
  await assert.rejects(
    () => validatePackagedDirectory(destDir),
    (err) => err instanceof SnapshotError && /unlisted\.sql/i.test(err.message),
  );
  fs.rmSync(extra);

  // Missing referenced part.
  fs.rmSync(path.join(destDir, 'schema.sql'));
  await assert.rejects(
    () => validatePackagedDirectory(destDir),
    (err) => err instanceof SnapshotError && /schema\.sql/i.test(err.message),
  );

  // Symlink instead of a real file.
  fs.rmSync(path.join(destDir, 'roles.sql'));
  fs.symlinkSync(path.join(root, 'outside-target'), path.join(destDir, 'roles.sql'));
  fs.writeFileSync(path.join(root, 'outside-target'), 'x');
  await assert.rejects(
    () => validatePackagedDirectory(destDir),
    (err) => err instanceof SnapshotError && /roles\.sql/i.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: plaintext packaging progress has no encryption lines and new split lines', async () => {
  const root = tmpdir('bp-snap-');
  const progress = [];
  const sourceDir = makeSourceDir(root);
  const destDir = path.join(root, 'pkg');
  await packageSnapshot({
    sourceDir,
    destDir,
    snapshotId: ID,
    environment: ENV,
    sourceProjectRef: REF,
    supabaseCliVersion: '2.114.0',
    format: 'none',
    onProgress: (message) => progress.push(message),
  });
  const compression = progress.indexOf('starting row-data compression');
  assert.ok(compression !== -1, 'compression starts');
  assert.deepEqual(progress.slice(compression, compression + 4), [
    'starting row-data compression',
    'completed row-data compression',
    'starting row-data split (plaintext format)',
    'completed row-data split (plaintext format)',
  ]);
  assert.ok(
    !progress.some((m) => m.includes('encryption') || m.includes('encrypted')),
    'no encryption progress lines for plaintext',
  );
  assert.ok(progress.includes('starting manifest creation'), 'pipeline completes');
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: packaging progress reports every stage and part count without sizes', async () => {
  const root = tmpdir('bp-snap-');
  const progress = [];
  const { dataParts } = await packageSnapshotWithProgress(root, progress);
  assert.ok(dataParts.length >= 1);
  const hashTotal = dataParts.length + PLAINTEXT_ARTIFACTS.length;
  const hashLines = dataParts.flatMap((name, i) => [
    `starting stored-file hash ${PLAINTEXT_ARTIFACTS.length + i + 1}/${hashTotal}: ${name}`,
    `completed stored-file hash ${PLAINTEXT_ARTIFACTS.length + i + 1}/${hashTotal}: ${name}`,
  ]);
  assert.deepEqual(progress, [
    'starting source validation',
    'completed source validation',
    'starting package workspace creation',
    'completed package workspace creation',
    'starting row-data concatenation',
    'completed row-data concatenation',
    'starting content fingerprinting',
    'completed content fingerprinting',
    'starting row-data compression',
    'completed row-data compression',
    'starting row-data encryption',
    'completed row-data encryption',
    'starting encrypted-part splitting',
    'completed encrypted-part splitting',
    'starting plaintext-artifact copy 1/4: roles.sql',
    'completed plaintext-artifact copy 1/4: roles.sql',
    'starting plaintext-artifact copy 2/4: schema.sql',
    'completed plaintext-artifact copy 2/4: schema.sql',
    'starting plaintext-artifact copy 3/4: managed-schema.sql',
    'completed plaintext-artifact copy 3/4: managed-schema.sql',
    'starting plaintext-artifact copy 4/4: migration-history-schema.sql',
    'completed plaintext-artifact copy 4/4: migration-history-schema.sql',
    ...['roles.sql', 'schema.sql', 'managed-schema.sql', 'migration-history-schema.sql'].flatMap(
      (name, i) => [
        `starting stored-file hash ${i + 1}/${hashTotal}: ${name}`,
        `completed stored-file hash ${i + 1}/${hashTotal}: ${name}`,
      ],
    ),
    ...hashLines,
    'starting manifest creation',
    'completed manifest creation',
    'starting staging cleanup attempt',
    'completed staging cleanup attempt',
  ]);
  // Part count is visible through the part ordinals, never through sizes.
  assert.ok(
    progress.some((m) =>
      m.includes(`starting stored-file hash ${hashTotal}/${hashTotal}: ${dataParts[0]}`),
    ),
    'the last stored-file ordinal must expose the part count',
  );
  assert.ok(!progress.some((m) => /MiB|bytes|\d{4,}/.test(m)), 'no sizes or hashes may appear');
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: packaging progress never leaks paths, identifiers, hashes, or row data', async () => {
  const root = tmpdir('bp-snap-');
  const progress = [];
  const { sourceDir } = await packageSnapshotWithProgress(root, progress);
  const text = progress.join('\n');
  for (const forbidden of [
    sourceDir,
    path.join(root, 'pkg'),
    REF,
    AGE_RECIPIENT_1,
    'a1b2c3d4e5f6a7b8c9d0',
    'age1',
    'CREATE ROLE',
    'COPY',
    '42',
  ]) {
    assert.ok(!text.includes(forbidden), `progress leaked: ${forbidden}`);
  }
  assert.ok(!/[0-9a-f]{64}/.test(text), 'no content hash may appear');
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: injected encryption failure stops the pipeline but still cleans up', async () => {
  const root = tmpdir('bp-snap-');
  const sourceDir = makeSourceDir(root);
  const destDir = path.join(root, 'pkg');
  const progress = [];
  await assert.rejects(
    () =>
      packageSnapshot({
        sourceDir,
        destDir,
        snapshotId: ID,
        environment: ENV,
        sourceProjectRef: REF,
        supabaseCliVersion: '2.114.0',
        ageRecipient: AGE_RECIPIENT_1,
        run: async () => {
          throw new Error('injected encryption failure');
        },
        onProgress: (message) => progress.push(message),
      }),
    /injected encryption failure/,
  );
  assert.ok(progress.includes('starting row-data encryption'));
  assert.ok(!progress.includes('completed row-data encryption'));
  assert.ok(!progress.some((m) => m.includes('encrypted-part splitting')));
  assert.ok(!progress.some((m) => m.includes('manifest')));
  assert.ok(progress.includes('starting incomplete-package cleanup attempt'));
  assert.ok(progress.includes('completed incomplete-package cleanup attempt'));
  assert.ok(progress.includes('starting staging cleanup attempt'));
  assert.ok(progress.includes('completed staging cleanup attempt'));
  assert.ok(!fs.existsSync(destDir), 'partial destination must be removed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: packaging cleanup runs even when progress throws', async () => {
  const root = tmpdir('bp-snap-');
  const sourceDir = makeSourceDir(root);
  const destDir = path.join(root, 'pkg');
  await assert.rejects(
    () =>
      packageSnapshot({
        sourceDir,
        destDir,
        snapshotId: ID,
        environment: ENV,
        sourceProjectRef: REF,
        supabaseCliVersion: '2.114.0',
        ageRecipient: AGE_RECIPIENT_1,
        run: async () => {
          throw new Error('injected encryption failure');
        },
        onProgress: (message) => {
          if (message.includes('cleanup attempt')) throw new Error('progress exploded');
        },
      }),
    /injected encryption failure/,
    'the primary failure, not the progress failure, must propagate',
  );
  assert.ok(
    !fs.existsSync(destDir),
    'partial destination must be removed despite progress failure',
  );
  fs.rmSync(root, { recursive: true, force: true });
});
async function packageSnapshotWithProgress(root, progress) {
  const sourceDir = makeSourceDir(root);
  const destDir = path.join(root, 'pkg');
  const { manifest } = await packageSnapshot({
    sourceDir,
    destDir,
    snapshotId: ID,
    environment: ENV,
    sourceProjectRef: REF,
    supabaseCliVersion: '2.114.0',
    ageRecipient: AGE_RECIPIENT_1,
    run: fakeAge,
    onProgress: (message) => progress.push(message),
  });
  return { manifest, destDir, dataParts: manifest.dataParts, sourceDir };
}

test('snapshot: packaging failure removes the destination and intermediates', async () => {
  const root = tmpdir('bp-snap-');
  const sourceDir = makeSourceDir(root);
  const destDir = path.join(root, 'pkg');
  await assert.rejects(
    () =>
      packageSnapshot({
        sourceDir,
        destDir,
        snapshotId: ID,
        environment: ENV,
        sourceProjectRef: REF,
        supabaseCliVersion: '2.114.0',
        ageRecipient: AGE_RECIPIENT_1,
        run: async () => {
          throw new Error('injected encryption failure');
        },
      }),
    /injected encryption failure/,
  );
  assert.ok(!fs.existsSync(destDir), 'partial destination must be removed');
  fs.rmSync(root, { recursive: true, force: true });
});
test(
  'snapshot: unpack verifies, decrypts, and recomputes the fingerprint',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-snap-');
    const sourceDir = makeSourceDir(root);
    const destDir = path.join(root, 'pkg');
    await packageSnapshot({
      sourceDir,
      destDir,
      snapshotId: ID,
      environment: ENV,
      sourceProjectRef: REF,
      supabaseCliVersion: '2.114.0',
      ageRecipient: AGE_RECIPIENT_1,
      agePath: agePath(),
    });

    const unpackRoot = tmpdir('bp-unpack-');
    const prepared = await unpackAndVerify({
      sourceDir: destDir,
      destDir: path.join(unpackRoot, 'prepared'),
      identityFile: writePrivateFile(path.join(unpackRoot, 'identity.txt'), `${AGE_IDENTITY_1}\n`),
      agePath: agePath(),
      expectedEnvironment: ENV,
    });

    // Decrypted combined data = migration-history rows then database rows.
    const expected =
      'COPY supabase_migrations.schema_migrations FROM stdin;\n1\n\\.\nCOPY "public"."t" FROM stdin;\n42\n\\.\n';
    assert.equal(fs.readFileSync(prepared.dataPath, 'utf8'), expected);
    assert.equal(fileMode(prepared.dataPath), 0o600);
    // Package and unpack use the identical five-file fingerprint ordering.
    const packagedManifest = JSON.parse(fs.readFileSync(path.join(destDir, MANIFEST_NAME), 'utf8'));
    assert.equal(
      prepared.contentSha256,
      packagedManifest.contentSha256,
      'aggregate fingerprint must match between package and unpack',
    );
    for (const name of PLAINTEXT_ARTIFACTS) {
      assert.ok(fs.existsSync(path.join(prepared.dir, name)), name);
    }
    assert.ok(fs.existsSync(path.join(prepared.dir, 'manifest.json')));
    // Intermediates (reassembled ciphertext, gz) removed.
    const leftovers = fs.readdirSync(prepared.dir);
    assert.ok(
      !leftovers.some((n) => n.endsWith('.age') || n.endsWith('.gz') || n.endsWith('.part-')),
      leftovers.join(','),
    );
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unpackRoot, { recursive: true, force: true });
  },
);

test(
  'snapshot: unpack fails on wrong identity and on tampered parts',
  { skip: !ageAvailable() },
  async () => {
    const root = tmpdir('bp-snap-');
    const sourceDir = makeSourceDir(root);
    const destDir = path.join(root, 'pkg');
    await packageSnapshot({
      sourceDir,
      destDir,
      snapshotId: ID,
      environment: ENV,
      sourceProjectRef: REF,
      supabaseCliVersion: '2.114.0',
      ageRecipient: AGE_RECIPIENT_1,
      agePath: agePath(),
    });

    const wrongIdentity = tmpdir('bp-unpack-');
    await assert.rejects(
      () =>
        unpackAndVerify({
          sourceDir: destDir,
          destDir: path.join(wrongIdentity, 'prepared'),
          identityFile: writePrivateFile(
            path.join(wrongIdentity, 'identity.txt'),
            `${AGE_IDENTITY_2}\n`,
          ),
          agePath: agePath(),
          expectedEnvironment: ENV,
        }),
      (err) => err instanceof SnapshotError || err.name === 'ProcessError',
    );
    assert.ok(
      !fs.existsSync(path.join(wrongIdentity, 'prepared')),
      'no partial prepared dir on failure',
    );

    // Tampered part: flip a byte in the first part.
    const partPath = path.join(destDir, 'data.sql.gz.age.part-000');
    const bytes = fs.readFileSync(partPath);
    bytes[bytes.length - 5] ^= 0x01;
    fs.writeFileSync(partPath, bytes);
    const tampered = tmpdir('bp-unpack-');
    await assert.rejects(
      () =>
        unpackAndVerify({
          sourceDir: destDir,
          destDir: path.join(tampered, 'prepared'),
          identityFile: writePrivateFile(
            path.join(tampered, 'identity.txt'),
            `${AGE_IDENTITY_1}\n`,
          ),
          agePath: agePath(),
          expectedEnvironment: ENV,
        }),
      (err) => err instanceof SnapshotError,
    );
    assert.ok(!fs.existsSync(path.join(tampered, 'prepared')));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wrongIdentity, { recursive: true, force: true });
    fs.rmSync(tampered, { recursive: true, force: true });
  },
);

test('snapshot: unpackAndVerify bounds plaintext decompression by the row-data limit', async () => {
  const root = tmpdir('bp-snap-');
  const sourceDir = makeSourceDir(root);
  // ~4 MiB of repeated bytes: gzip shrinks it hard, so the combined
  // row-data bound (2 inputs x maxPlaintextBytes) must be enforced during
  // gunzip, long before the decompressed 4 MiB would exhaust disk.
  fs.writeFileSync(
    path.join(sourceDir, 'database-data.sql'),
    `COPY "public"."t" FROM stdin;\n${'a'.repeat(4 * 1024 * 1024)}\n\\.\n`,
  );
  const destDir = path.join(root, 'pkg');
  await packageSnapshot({
    sourceDir,
    destDir,
    snapshotId: ID,
    environment: ENV,
    sourceProjectRef: REF,
    supabaseCliVersion: '2.114.0',
    format: 'none',
  });
  await assert.rejects(
    () =>
      unpackAndVerify({
        sourceDir: destDir,
        destDir: path.join(root, 'prepared'),
        expectedEnvironment: ENV,
        limits: { maxPlaintextBytes: 1024 * 1024 },
      }),
    (err) => /exceeds/.test(err.message),
  );
  assert.ok(!fs.existsSync(path.join(root, 'prepared')), 'no partial prepared dir on overflow');

  // Default limits still unpack the same package.
  const ok = await unpackAndVerify({
    sourceDir: destDir,
    destDir: path.join(root, 'prepared-ok'),
    expectedEnvironment: ENV,
  });
  assert.ok(fs.readFileSync(ok.dataPath, 'utf8').includes('a'.repeat(4096)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot: private path resolution rejects traversal, separators, and absolute paths', () => {
  const root = '/tmp/bp-safe-root';
  assert.equal(resolvePrivatePath(root, 'roles.sql'), path.join(root, 'roles.sql'));
  for (const bad of ['../evil.sql', 'a/b.sql', '/abs.sql', '..', '.', 'a\\b.sql', '']) {
    assert.throws(() => resolvePrivatePath(root, bad), SnapshotError, bad);
  }
});
