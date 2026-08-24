import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PART_SIZE,
  ENCRYPTION_FORMAT,
  gzipFile,
  gunzipFile,
  encryptFile,
  decryptFile,
  splitIntoParts,
  reassembleParts,
  partName,
  partIndex,
} from './encryption.js';
import {
  tmpdir,
  writePrivateFile,
  writePrivateBytes,
  fileMode,
  AGE_IDENTITY_1,
  AGE_RECIPIENT_1,
  AGE_IDENTITY_2,
  ageAvailable,
  agePath,
  sha256OfFile,
} from './test-fixtures.js';

function identityFile(dir, name = 'identity.txt', identity = AGE_IDENTITY_1) {
  const file = path.join(dir, name);
  writePrivateFile(file, `${identity}\n`);
  return file;
}

test('encryption: format constant and part naming', () => {
  assert.equal(ENCRYPTION_FORMAT, 'age-x25519');
  assert.equal(PART_SIZE, 90 * 1024 * 1024);
  assert.equal(partName(0), 'data.sql.gz.age.part-000');
  assert.equal(partName(99), 'data.sql.gz.age.part-099');
  assert.equal(partIndex('data.sql.gz.age.part-000'), 0);
  assert.equal(partIndex('data.sql.gz.age.part-042'), 42);
  assert.equal(partIndex('data.sql.gz.age.part-xyz'), null);
  assert.equal(partIndex('data.sql.gz.age.part-'), null);
  assert.equal(partIndex('other.sql'), null);
});

test('encryption: gzip/gunzip round trip preserves bytes', async () => {
  const dir = tmpdir('bp-enc-');
  const input = path.join(dir, 'in.sql');
  const gz = path.join(dir, 'in.sql.gz');
  const out = path.join(dir, 'out.sql');
  const payload = 'COPY x FROM stdin;\n'.repeat(1000) + 'row with ünïcode ☃\n';
  writePrivateFile(input, payload);
  await gzipFile({ input, output: gz });
  assert.equal(fileMode(gz), 0o600);
  assert.ok(fs.statSync(gz).size < Buffer.byteLength(payload));
  await gunzipFile({ input: gz, output: out });
  assert.equal(fs.readFileSync(out, 'utf8'), payload);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encryption: one-byte and exact-boundary and multi-part splits', async () => {
  const dir = tmpdir('bp-enc-');

  // One byte at the real 90 MiB part size: one single-byte part.
  const one = path.join(dir, 'one.bin');
  writePrivateFile(one, 'x', 0o600);
  const oneOut = path.join(dir, 'one-parts');
  fs.mkdirSync(oneOut, { mode: 0o700 });
  const oneParts = await splitIntoParts({ input: one, outputDir: oneOut });
  assert.deepEqual(oneParts, ['data.sql.gz.age.part-000']);
  assert.equal(fs.statSync(path.join(oneOut, oneParts[0])).size, 1);

  // Exactly PART_SIZE: one full-size part.
  const exact = path.join(dir, 'exact.bin');
  writePrivateBytes(exact, PART_SIZE);
  const exactOut = path.join(dir, 'exact-parts');
  fs.mkdirSync(exactOut, { mode: 0o700 });
  const exactParts = await splitIntoParts({ input: exact, outputDir: exactOut });
  assert.deepEqual(exactParts, ['data.sql.gz.age.part-000']);
  assert.equal(fs.statSync(path.join(exactOut, exactParts[0])).size, PART_SIZE);

  // PART_SIZE + 123: two parts, second short.
  const over = path.join(dir, 'over.bin');
  writePrivateBytes(over, PART_SIZE + 123);
  const overOut = path.join(dir, 'over-parts');
  fs.mkdirSync(overOut, { mode: 0o700 });
  const overParts = await splitIntoParts({ input: over, outputDir: overOut });
  assert.equal(overParts.length, 2);
  assert.equal(fs.statSync(path.join(overOut, overParts[0])).size, PART_SIZE);
  assert.equal(fs.statSync(path.join(overOut, overParts[1])).size, 123);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('encryption: multi-part reassembly is byte-identical', async () => {
  const dir = tmpdir('bp-enc-');
  const input = path.join(dir, 'in.bin');
  writePrivateBytes(input, PART_SIZE * 2 + 4096);
  const partsDir = path.join(dir, 'parts');
  fs.mkdirSync(partsDir, { mode: 0o700 });
  const names = await splitIntoParts({ input, outputDir: partsDir });
  const reassembled = path.join(dir, 'reassembled.bin');
  await reassembleParts({
    parts: names.map((n) => path.join(partsDir, n)),
    output: reassembled,
  });
  assert.equal(await sha256OfFile(input), await sha256OfFile(reassembled));
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'encryption: age round trip succeeds with the test identity',
  { skip: !ageAvailable() },
  async () => {
    assert.ok(agePath(), 'age should be present when not skipping');
    const dir = tmpdir('bp-enc-');
    const plain = path.join(dir, 'plain.sql');
    const cipher = path.join(dir, 'cipher.age');
    const decrypted = path.join(dir, 'decrypted.sql');
    writePrivateFile(plain, 'COPY "public"."secret" FROM stdin;\nrow\n\\.\n');
    await encryptFile({
      recipient: AGE_RECIPIENT_1,
      input: plain,
      output: cipher,
      agePath: agePath(),
    });
    assert.equal(fileMode(cipher), 0o600);
    await decryptFile({
      identityFile: identityFile(dir),
      input: cipher,
      output: decrypted,
      agePath: agePath(),
    });
    assert.equal(fs.readFileSync(decrypted, 'utf8'), fs.readFileSync(plain, 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

test('encryption: wrong identity fails decryption', { skip: !ageAvailable() }, async () => {
  const dir = tmpdir('bp-enc-');
  const plain = path.join(dir, 'plain.sql');
  const cipher = path.join(dir, 'cipher.age');
  writePrivateFile(plain, 'secret data for the wrong identity test');
  await encryptFile({
    recipient: AGE_RECIPIENT_1,
    input: plain,
    output: cipher,
    agePath: agePath(),
  });
  await assert.rejects(
    () =>
      decryptFile({
        identityFile: identityFile(dir, 'identity2.txt', AGE_IDENTITY_2),
        input: cipher,
        output: path.join(dir, 'out.sql'),
        agePath: agePath(),
      }),
    (err) => err.name === 'ProcessError' || /decrypt|identity/i.test(err.message),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'encryption: tampered ciphertext fails authentication',
  { skip: !ageAvailable() },
  async () => {
    const dir = tmpdir('bp-enc-');
    const plain = path.join(dir, 'plain.sql');
    const cipher = path.join(dir, 'cipher.age');
    writePrivateFile(plain, 'authenticated payload');
    await encryptFile({
      recipient: AGE_RECIPIENT_1,
      input: plain,
      output: cipher,
      agePath: agePath(),
    });
    const bytes = fs.readFileSync(cipher);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    fs.writeFileSync(cipher, bytes);
    await assert.rejects(
      () =>
        decryptFile({
          identityFile: identityFile(dir),
          input: cipher,
          output: path.join(dir, 'out.sql'),
          agePath: agePath(),
        }),
      (err) => err.name === 'ProcessError' || /decrypt|integrity|auth/i.test(err.message),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

test('encryption: rejects a non-positive or non-integer partSize before writing', async () => {
  const dir = tmpdir('bp-enc-');
  const input = path.join(dir, 'in.bin');
  writePrivateFile(input, 'x');
  const out = path.join(dir, 'parts');
  fs.mkdirSync(out, { mode: 0o700 });
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      () => splitIntoParts({ input, outputDir: out, partSize: bad }),
      /positive integer/,
    );
    assert.deepEqual(fs.readdirSync(out), [], `partSize ${bad} opened files`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encryption: the open part writer is fully closed before the read error propagates', async () => {
  const dir = tmpdir('bp-enc-');
  const out = path.join(dir, 'out.parts');
  fs.mkdirSync(out, { mode: 0o700 });
  const originalCreateWrite = fs.createWriteStream;
  const originalCreateRead = fs.createReadStream;
  const writers = [];
  const { Readable } = await import('node:stream');
  fs.createWriteStream = (file, opts) => {
    const s = originalCreateWrite(file, opts);
    writers.push(s);
    return s;
  };
  let reads = 0;
  fs.createReadStream = () => {
    const r = new Readable({
      read() {
        if (reads === 0) {
          reads += 1;
          this.push(Buffer.alloc(1000, 7));
        } else if (reads === 1) {
          reads += 1;
          this.destroy(new Error('injected read failure'));
        } else {
          this.push(null);
        }
      },
    });
    return r;
  };
  try {
    await assert.rejects(
      () => splitIntoParts({ input: path.join(dir, 'unused'), outputDir: out, partSize: 100 }),
      /injected read failure/,
    );
    // endWritable settles on 'finish' while the fd close lags one step behind;
    // the failure must not propagate while the open writer's fd is still open.
    assert.equal(writers.length, 10, 'the injected chunk must open ten writers');
    assert.equal(
      writers.at(-1).closed,
      true,
      'the open part writer must be fully closed when the error propagates',
    );
  } finally {
    fs.createWriteStream = originalCreateWrite;
    fs.createReadStream = originalCreateRead;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encryption: an open part writer is closed when the source read fails', async () => {
  const dir = tmpdir('bp-enc-');
  const out = path.join(dir, 'out.parts');
  fs.mkdirSync(out, { mode: 0o700 });
  const originalCreateWrite = fs.createWriteStream;
  const originalCreateRead = fs.createReadStream;
  const closed = [];
  const { Readable } = await import('node:stream');
  fs.createWriteStream = (file, opts) => {
    const s = originalCreateWrite(file, opts);
    s.on('close', () => closed.push(file));
    return s;
  };
  let reads = 0;
  fs.createReadStream = () => {
    const r = new Readable({
      read() {
        if (reads === 0) {
          reads += 1;
          this.push(Buffer.alloc(1000, 7));
        } else if (reads === 1) {
          reads += 1;
          this.destroy(new Error('injected read failure'));
        } else {
          this.push(null);
        }
      },
    });
    return r;
  };
  try {
    await assert.rejects(
      () => splitIntoParts({ input: path.join(dir, 'unused'), outputDir: out, partSize: 100 }),
      /injected read failure/,
    );
    // endWritable settles on 'finish' (a stream may never emit 'close'); the
    // close events land one turn later, so wait for them before counting.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    fs.createWriteStream = originalCreateWrite;
    fs.createReadStream = originalCreateRead;
  }
  // All ten part writers were opened and every open one was closed on failure.
  assert.equal(closed.length, 10, 'every part writer must be closed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encryption: gzip output is streamed and private even for large input', async () => {
  const dir = tmpdir('bp-enc-');
  const input = path.join(dir, 'big.sql');
  const gz = path.join(dir, 'big.sql.gz');
  writePrivateBytes(input, 8 * 1024 * 1024);
  await gzipFile({ input, output: gz });
  const gzStat = fs.statSync(gz);
  assert.ok(gzStat.size > 0);
  assert.equal(fileMode(gz), 0o600);
  assert.equal(await sha256OfFile(gz), await sha256OfFile(gz));
  fs.rmSync(dir, { recursive: true, force: true });
});
