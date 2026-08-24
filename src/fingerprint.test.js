import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import {
  hashNormalizedSql,
  hashNormalizedText,
  computeAggregateFingerprint,
  formatSnapshotId,
  parseSnapshotId,
  isValidSnapshotId,
} from './fingerprint.js';
import { tmpdir, writePrivateFile } from './test-fixtures.js';

const FILES = [
  'roles.sql',
  'schema.sql',
  'managed-schema.sql',
  'migration-history-schema.sql',
  'data.sql',
];

function writeFiles(root, contents) {
  for (const name of FILES) {
    writePrivateFile(path.join(root, name), contents[name] ?? '');
  }
}

async function aggregate(root, contents) {
  writeFiles(root, contents);
  return computeAggregateFingerprint({
    files: FILES.map((name) => ({ name, path: path.join(root, name) })),
  });
}

test('fingerprint: different restrict nonces produce the same fingerprint', async () => {
  const rootA = tmpdir('bp-fp-');
  const rootB = tmpdir('bp-fp-');
  const base = {
    'roles.sql': '-- \\restrict nonce-aaaa1111\nCREATE ROLE x;\n-- \\unrestrict nonce-aaaa1111\n',
    'data.sql': 'COPY "public"."t" FROM stdin;\nrow1\n\\.\n',
  };
  const a = await aggregate(rootA, {
    'roles.sql': '-- \\restrict nonce-bbbb2222\nCREATE ROLE x;\n-- \\unrestrict nonce-bbbb2222\n',
    'data.sql': base['data.sql'],
  });
  const b = await aggregate(rootB, base);
  assert.equal(a.hex, b.hex);
  // Bare (non-comment) restrict lines are normalized too.
  const c = await aggregate(rootA, {
    'roles.sql': '\\restrict nonce-cccc3333\nCREATE ROLE x;\n\\unrestrict nonce-cccc3333\n',
    'data.sql': base['data.sql'],
  });
  assert.equal(c.hex, a.hex);
  rootA && fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
});

test('fingerprint: any logical content change changes the aggregate', async () => {
  const base = {
    'roles.sql': 'CREATE ROLE app;\n',
    'schema.sql': 'CREATE TABLE public.t (id int);\n',
    'managed-schema.sql': 'CREATE TRIGGER trg ON auth.users EXECUTE FUNCTION fn();\n',
    'migration-history-schema.sql':
      'CREATE TABLE supabase_migrations.schema_migrations (version text);\n',
    'data.sql': 'COPY "public"."t" FROM stdin;\n1\n\\.\n',
  };
  await Promise.all(
    FILES.map(async (name) => {
      const rootA = tmpdir('bp-fp-');
      const rootB = tmpdir('bp-fp-');
      const changed = { ...base };
      changed[name] =
        name === 'data.sql' ? `${base[name]}extra-row\n\\.\n` : `${base[name]}\nALTERED`;
      const a = await aggregate(rootA, base);
      const b = await aggregate(rootB, changed);
      assert.notEqual(a.hex, b.hex, `change in ${name} must alter the fingerprint`);
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }),
  );
});

test('fingerprint: seq/role/row changes are significant', async () => {
  const a = await hashNormalizedText(
    "CREATE SEQUENCE public.s START WITH 1;\nSELECT setval('public.s', 42, true);\n",
  );
  const b = await hashNormalizedText(
    "CREATE SEQUENCE public.s START WITH 1;\nSELECT setval('public.s', 43, true);\n",
  );
  assert.notEqual(a.hex, b.hex);
});

test('fingerprint: comment-like COPY rows remain significant', async () => {
  const dataA = 'COPY "public"."t" FROM stdin;\n-- a row that looks like a comment\n\\.\n';
  const dataB =
    'COPY "public"."t" FROM stdin;\n-- a DIFFERENT row that looks like a comment\n\\.\n';
  assert.notEqual((await hashNormalizedText(dataA)).hex, (await hashNormalizedText(dataB)).hex);
  // Neither is dropped: hashing must include them.
  const plain = await hashNormalizedText('COPY "public"."t" FROM stdin;\n\\.\n');
  assert.notEqual(plain.hex, (await hashNormalizedText(dataA)).hex);
});

test('fingerprint: filename/length boundaries prevent ambiguous concatenation', async () => {
  const rootA = tmpdir('bp-fp-');
  const rootB = tmpdir('bp-fp-');
  const rootC = tmpdir('bp-fp-');
  // "a"+"bc" and "ab"+"c" collide when files are concatenated without framing.
  const one = await aggregate(rootA, { 'roles.sql': 'a', 'schema.sql': 'bc' });
  const two = await aggregate(rootB, { 'roles.sql': 'ab', 'schema.sql': 'c' });
  const three = await aggregate(rootC, {
    'roles.sql': 'a',
    'schema.sql': 'b',
    'managed-schema.sql': 'c',
  });
  assert.notEqual(one.hex, two.hex);
  assert.notEqual(one.hex, three.hex);
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
  fs.rmSync(rootC, { recursive: true, force: true });
});

test('fingerprint: normalized byte counts are reported', async () => {
  const res = await hashNormalizedText('-- \\restrict nnn111222\nSELECT 1;\n');
  assert.equal(res.bytes, 'SELECT 1;\n'.length);
});

test('fingerprint: large data is processed as a stream', async () => {
  const root = tmpdir('bp-fp-');
  const big = path.join(root, 'big.sql');
  const chunk = Buffer.from('0123456789abcdef'.repeat(4096)); // 64 KiB
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 1024; i++) fs.writeSync(fd, chunk); // 64 MiB
  fs.closeSync(fd);
  const res = await hashNormalizedSql(createReadStream(big));
  assert.match(res.hex, /^[0-9a-f]{64}$/);
  assert.equal(res.bytes, 64 * 1024 * 1024);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fingerprint: snapshot id formatting is canonical UTC', () => {
  assert.equal(formatSnapshotId(new Date('2026-08-24T03:17:09Z')), '2026-08-24T03-17-09Z');
  assert.equal(formatSnapshotId(new Date('2026-01-02T00:00:00Z')), '2026-01-02T00-00-00Z');
});

test('fingerprint: strict snapshot id parsing', () => {
  const id = '2026-08-24T03-17-09Z';
  const parsed = parseSnapshotId(id);
  assert.equal(parsed.id, id);
  assert.equal(parsed.date.toISOString(), '2026-08-24T03:17:09.000Z');
  assert.equal(parsed.ms, Date.parse('2026-08-24T03:17:09Z'));
  assert.equal(isValidSnapshotId(id), true);
});

test('fingerprint: impossible and non-canonical snapshot ids are rejected', () => {
  for (const bad of [
    '2026-02-30T03-17-09Z',
    '2026-13-01T03-17-09Z',
    '2026-00-01T03-17-09Z',
    '2026-08-24T24-00-00Z',
    '2026-08-24T03-17-60Z',
    '2026-8-24T03-17-09Z',
    '2026-08-24t03-17-09z',
    '2026-08-24T03:17:09Z',
    '2026-08-24T03-17-09',
    'not-an-id',
    '',
  ]) {
    assert.equal(isValidSnapshotId(bad), false, bad);
    assert.throws(() => parseSnapshotId(bad), /snapshot id/i, bad);
  }
});
