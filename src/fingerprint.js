/**
 * Deterministic logical-content fingerprints and the canonical snapshot ID.
 *
 * The content fingerprint hashes NORMALIZED row-bearing SQL — never encrypted
 * bytes — in a fixed file order with unambiguous filename/length framing, so
 * structurally different inputs cannot collide and age's randomized
 * ciphertext never affects the fingerprint.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export class SnapshotIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotIdError';
  }
}

/**
 * Format a Date as the canonical snapshot ID: `YYYY-MM-DDTHH-mm-ssZ` (UTC).
 */
export function formatSnapshotId(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}T${p2(
    date.getUTCHours(),
  )}-${p2(date.getUTCMinutes())}-${p2(date.getUTCSeconds())}Z`;
}

const SNAPSHOT_ID_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/;

/**
 * Parse and strictly validate a snapshot ID. Rejects impossible dates and
 * non-canonical values. Snapshot IDs sort lexicographically = chronologically.
 */
export function parseSnapshotId(id) {
  const match = SNAPSHOT_ID_RE.exec(typeof id === 'string' ? id : '');
  if (!match) {
    throw new SnapshotIdError(`invalid snapshot id (expected YYYY-MM-DDTHH-mm-ssZ): ${id}`);
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (formatSnapshotId(date) !== id) {
    throw new SnapshotIdError(`non-canonical snapshot id: ${id}`);
  }
  return { id, date, ms: date.getTime() };
}

export function isValidSnapshotId(id) {
  try {
    parseSnapshotId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exact whole-line patterns for the only volatile dump lines normalized away:
 * PostgreSQL 17 `\restrict`/`\unrestrict` nonce lines, optionally emitted as
 * comments by the Supabase CLI. Everything else — comments, COPY rows, and
 * schema ordering — is preserved verbatim.
 */
const RESTRICT_LINE_RE = /^[ \t]*(?:--[ \t]*)?\\(?:un)?restrict[ \t]+\S+[ \t]*\r?$/;

function isVolatileLine(line) {
  return RESTRICT_LINE_RE.test(line);
}

/**
 * Streaming normalized hasher over a readable stream of SQL bytes.
 * Returns the hex digest and the normalized byte count.
 * Never reads the full input into memory.
 */
export async function hashNormalizedSql(readable, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let pending = '';

  for await (const chunk of readable) {
    pending += decoder.write(chunk);
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!isVolatileLine(line)) {
        hash.update(line);
        hash.update('\n');
        bytes += Buffer.byteLength(line, 'utf8') + 1;
      }
    }
  }
  pending += decoder.end();
  if (pending.length > 0 && !isVolatileLine(pending)) {
    hash.update(pending);
    bytes += Buffer.byteLength(pending, 'utf8');
  }
  return { hex: hash.digest('hex'), bytes };
}

/** Convenience wrapper for small in-memory inputs (tests). */
export async function hashNormalizedText(text, algorithm = 'sha256') {
  const { Readable } = await import('node:stream');
  return hashNormalizedSql(Readable.from([Buffer.from(text, 'utf8')]), algorithm);
}

/**
 * Aggregate fingerprint over logical files in the FIXED order:
 * roles.sql, schema.sql, managed-schema.sql, migration-history-schema.sql,
 * data.sql. Each file contributes `name:normalizedBytes:digest\n` framing so
 * concatenation can never collide structurally.
 *
 * @param {{files: {name:string, path:string}[]}} opts
 */
export async function computeAggregateFingerprint({ files, algorithm = 'sha256' } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('computeAggregateFingerprint requires a non-empty ordered file list');
  }
  const aggregate = createHash(algorithm);
  const fileDigests = {};
  let totalBytes = 0;
  for (const { name, path: filePath } of files) {
    const { hex, bytes } = await hashNormalizedSql(createReadStream(filePath), algorithm);
    fileDigests[name] = { hex, bytes };
    aggregate.update(`${name}:${bytes}:${hex}\n`);
    totalBytes += bytes;
  }
  return { hex: aggregate.digest('hex'), fileDigests, totalBytes };
}
