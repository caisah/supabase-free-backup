/**
 * Shared fixtures for unit tests. Contains ONLY throwaway test identities —
 * never real credentials.
 */

import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lookupExecutable } from './process.js';

export const AGE_IDENTITY_1 =
  'AGE-SECRET-KEY-19QAFE2ZTQCL043CWG3PKCDFESVCTYY3PXXTKUSZLKSH8Y49CDMXS3JLNMM';
export const AGE_RECIPIENT_1 = 'age1rz8dtx9s7r2fyjejpq9wmewumm23ukwfdfqy0zjq0063ua6twfuqh0vyk9';

export const AGE_IDENTITY_2 =
  'AGE-SECRET-KEY-10PEZ8L2FVCC8DMPH9V2JZAW5WU467R4YKKXK3RY73JDDYSNPRGHQ4Z68QM';
export const AGE_RECIPIENT_2 = 'age108fhkxghqgg9u0qaw7dr20x4qymupgvf8wjgancknwgla9l5vvusrfdy09';

let cachedAgePath;
let cachedAgeCheck = null;

/** Absolute path to the age executable, or null when not installed. */
export function agePath() {
  if (cachedAgePath === undefined) {
    cachedAgePath = lookupExecutable(process.platform === 'win32' ? 'age.exe' : 'age');
  }
  return cachedAgePath;
}

/** True when a real age binary is usable; encryption round-trip tests skip otherwise. */
export function ageAvailable() {
  if (cachedAgeCheck === null) cachedAgeCheck = agePath() !== null;
  return cachedAgeCheck;
}

/** Deterministic age stand-in for structural tests: copies input to the -o output. */
export async function fakeAge({ args }) {
  const outIdx = args.indexOf('-o');
  if (outIdx === -1) throw new Error(`fake age expects -o: ${args.join(' ')}`);
  fs.copyFileSync(args.at(-1), args[outIdx + 1]);
}

export function tmpdir(prefix = 'bp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writePrivateFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

/** Write a private file with deterministic random-looking bytes. */
export function writePrivateBytes(filePath, size) {
  const chunk = Buffer.alloc(64 * 1024, 7);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, 'w', 0o600);
  let remaining = size;
  while (remaining > 0) {
    const writeSize = Math.min(chunk.length, remaining);
    fs.writeSync(fd, chunk, 0, writeSize, null);
    remaining -= writeSize;
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

export async function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
