/**
 * Private row-data intermediate handling: gzip, age encryption/decryption,
 * fixed 90 MiB part splitting, ordered reassembly, and private file modes.
 *
 * Never pass a private age identity as a process argument — decryptFile takes
 * an identity FILE only. Backup encryption needs only the public recipient.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline, finished } from 'node:stream/promises';
import { runCommand, lookupExecutable } from './process.js';
import { writeWithBackpressure, endWritable } from './stream.js';

export const ENCRYPTION_FORMAT = 'age-x25519';
export const PLAINTEXT_FORMAT = 'none';
export const DEFAULT_FORMAT = ENCRYPTION_FORMAT;
export const PART_SIZE = 90 * 1024 * 1024;
export const PART_PREFIX = 'data.sql.gz.age.part-';
export const PLAINTEXT_PART_PREFIX = 'data.sql.gz.part-';

/** Escape regex metacharacters so a prefix can be embedded in a pattern. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the canonical part-name matcher (with the index capture) for a prefix. */
function partNameMatcher(prefix) {
  return new RegExp(`^${escapeRegExp(prefix)}(\\d{3})$`);
}

/**
 * Row-data storage codecs, keyed by `manifest.encryption.format`. Part
 * names, ordering, and the `encrypted` flag are validated exclusively
 * through the codec derived from the manifest format (one code path, no
 * per-source branches). Each codec is deeply frozen: the exported registry
 * is immutable validation policy, never caller-mutable state.
 */
export const ROW_DATA_CODECS = Object.freeze({
  [ENCRYPTION_FORMAT]: Object.freeze({
    partPrefix: PART_PREFIX,
    partRe: partNameMatcher(PART_PREFIX),
    encrypted: true,
  }),
  [PLAINTEXT_FORMAT]: Object.freeze({
    partPrefix: PLAINTEXT_PART_PREFIX,
    partRe: partNameMatcher(PLAINTEXT_PART_PREFIX),
    encrypted: false,
  }),
});

/** Resolve the row-data codec for a manifest format; unknown formats throw. */
export function rowDataCodec(format) {
  const codec = ROW_DATA_CODECS[format ?? DEFAULT_FORMAT];
  if (!codec) throw new Error(`unknown row-data format: ${format}`);
  return codec;
}

/** Parse a part filename for a given format; returns its index or null. */
export function partIndexFor(format, name) {
  if (typeof name !== 'string') return null;
  const match = rowDataCodec(format).partRe.exec(name);
  return match ? Number(match[1]) : null;
}

/** Canonical part name for a format and position. */
export function partNameFor(format, index) {
  return `${rowDataCodec(format).partPrefix}${String(index).padStart(3, '0')}`;
}

export function partName(index) {
  return partNameFor(DEFAULT_FORMAT, index);
}

/** Parse an age-format part filename; returns its index or null. */
export function partIndex(name) {
  return partIndexFor(DEFAULT_FORMAT, name);
}

export function ensurePrivateDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
}

export function writePrivateFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { mode });
  fs.chmodSync(filePath, mode);
}

export async function removeFiles(paths) {
  for (const p of paths) {
    try {
      await fs.promises.rm(p, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function mode0600Stream(output) {
  return fs.createWriteStream(output, { mode: 0o600 });
}

/** Streaming gzip of a private file. */
export async function gzipFile({ input, output }) {
  ensurePrivateDir(path.dirname(output), 0o700);
  await pipeline(fs.createReadStream(input), zlib.createGzip(), mode0600Stream(output));
}

/** Streaming gunzip to a private file with a hard decompressed-size bound. */
export async function gunzipFile({ input, output, maxBytes }) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive integer; got ${maxBytes}`);
  }
  ensurePrivateDir(path.dirname(output), 0o700);
  const target = mode0600Stream(output);
  const state = { written: 0, overflow: false };
  try {
    await pipeline(
      fs.createReadStream(input),
      zlib.createGunzip(),
      countDecompressedBytes(maxBytes, state),
      target,
    );
  } catch (err) {
    if (state.overflow) await removeFiles([output]);
    throw err;
  }
}

/**
 * Named pipeline transform that counts decompressed bytes and aborts
 * (removing the partial output) once the bound is exceeded: a small valid
 * gzip must never expand unbounded into the temporary filesystem during
 * restore.
 */
function countDecompressedBytes(maxBytes, state) {
  return async function* (chunks) {
    for await (const chunk of chunks) {
      state.written += chunk.length;
      if (state.written > maxBytes) {
        state.overflow = true;
        throw new Error(`decompressed data exceeds the ${maxBytes}-byte limit`);
      }
      yield chunk;
    }
  };
}

function resolveAge(agePath) {
  if (agePath) return agePath;
  const found = lookupExecutable(process.platform === 'win32' ? 'age.exe' : 'age');
  if (!found) {
    throw new Error('age executable not found on PATH; install age (brew install age) and retry');
  }
  return found;
}

/**
 * Encrypt a file with the PUBLIC recipient. `run` defaults to the shared safe
 * process runner. Never requires the private identity.
 */
export async function encryptFile({ recipient, input, output, agePath, run = runCommand, signal }) {
  const age = resolveAge(agePath);
  ensurePrivateDir(path.dirname(output), 0o700);
  try {
    await run({
      command: age,
      args: ['-r', recipient, '-o', output, input],
      stderr: 'collect',
      signal,
    });
  } finally {
    try {
      fs.chmodSync(output, 0o600);
    } catch {
      // output may not exist on failure; caller cleanup handles it
    }
  }
}

/**
 * Decrypt an age file using an identity FILE. The identity content is never
 * passed as an argument.
 */
export async function decryptFile({
  identityFile,
  input,
  output,
  agePath,
  run = runCommand,
  signal,
}) {
  const age = resolveAge(agePath);
  ensurePrivateDir(path.dirname(output), 0o700);
  try {
    await run({
      command: age,
      args: ['-d', '-i', identityFile, '-o', output, input],
      stderr: 'collect',
      signal,
    });
  } finally {
    try {
      fs.chmodSync(output, 0o600);
    } catch {
      // output may not exist on failure; caller cleanup handles it
    }
  }
}

/**
 * Split a file into fixed-size parts named `data.sql.gz.age.part-NNN`.
 * Every part is exactly `partSize` bytes except the last. Returns the ordered
 * part names. Any source/read/write failure closes the open part writer
 * before propagating.
 */
export async function splitIntoParts({
  input,
  outputDir,
  partSize = PART_SIZE,
  prefix = PART_PREFIX,
}) {
  if (!Number.isInteger(partSize) || partSize <= 0) {
    throw new Error(`partSize must be a positive integer; got ${partSize}`);
  }
  ensurePrivateDir(outputDir, 0o700);
  const names = [];
  let index = 0;
  let writer = null;
  let written = 0;
  const source = fs.createReadStream(input);
  try {
    for await (const chunk of source) {
      let offset = 0;
      while (offset < chunk.length) {
        if (!writer || written === partSize) {
          if (writer) await endWritable(writer);
          const created = createPartWriter(outputDir, prefix, index);
          writer = created.writer;
          names.push(created.name);
          written = 0;
          index += 1;
        }
        const room = partSize - written;
        const take = Math.min(room, chunk.length - offset);
        await writePartSlice(writer, chunk, offset, take);
        written += take;
        offset += take;
      }
    }
    if (writer) {
      await endWritable(writer);
      writer = null; // success path: the finally must not end it a second time
    }
    return names;
  } finally {
    if (writer) {
      await endWritable(writer);
      // endWritable settles on 'finish' (a stream may never emit 'close');
      // the fd close lags one step behind, so wait for it explicitly: the
      // failure must not propagate while the open writer's fd is still held.
      await finished(writer);
    }
  }
}

/** Open one private part writer; returns the canonical name and the stream. */
function createPartWriter(outputDir, prefix, index) {
  const name = `${prefix}${String(index).padStart(3, '0')}`;
  const writer = fs.createWriteStream(path.join(outputDir, name), { mode: 0o600 });
  return { name, writer };
}

/** Backpressure-safe slice write to a part writer. */
async function writePartSlice(writer, chunk, offset, take) {
  await writeWithBackpressure(writer, chunk.subarray(offset, offset + take));
}

/** Concatenate ordered parts (byte-identical) to one private output file. */
export async function reassembleParts({ parts, output }) {
  ensurePrivateDir(path.dirname(output), 0o700);
  const out = fs.createWriteStream(output, { mode: 0o600 });
  try {
    for (const part of parts) {
      await pipeline(fs.createReadStream(part), out, { end: false });
    }
  } finally {
    await endWritable(out);
  }
}
