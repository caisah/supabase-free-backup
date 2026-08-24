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
export const PART_SIZE = 90 * 1024 * 1024;
export const PART_PREFIX = 'data.sql.gz.age.part-';

export function partName(index) {
  return `${PART_PREFIX}${String(index).padStart(3, '0')}`;
}

/** Parse a part filename; returns its index or null when not canonical. */
export function partIndex(name) {
  if (typeof name !== 'string') return null;
  const match = /^data\.sql\.gz\.age\.part-(\d{3})$/.exec(name);
  if (!match) return null;
  return Number(match[1]);
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

/** Streaming gunzip to a private file. */
export async function gunzipFile({ input, output }) {
  ensurePrivateDir(path.dirname(output), 0o700);
  await pipeline(fs.createReadStream(input), zlib.createGunzip(), mode0600Stream(output));
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
