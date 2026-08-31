/**
 * Snapshot contract: strict version-1 manifests, safe private path handling,
 * packaging (fingerprint -> gzip -> row-data codec -> 90 MiB parts ->
 * manifest last), and full verification/unpacking for restore preparation.
 *
 * Row-data storage is a CODEC chosen at package time and declared in the
 * manifest: `age-x25519` (encrypted) or `none` (plaintext). Part names, part
 * ordering, and the `encrypted` flag are validated from the codec derived
 * from `manifest.encryption.format` — callers never branch on provenance.
 *
 * Package directories and manifests are ALWAYS treated as untrusted input —
 * even when read from this repository.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { endWritable, sha256Readable } from './stream.js';
import { reportProgressSafely, ordinal } from './progress.js';
import { z } from 'zod';
import { ENVIRONMENTS, LOCAL_STORE_ENVIRONMENT, REPOSITORY_ROOT } from './config.js';
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from './local-store.js';
import {
  ENCRYPTION_FORMAT,
  PLAINTEXT_FORMAT,
  DEFAULT_FORMAT,
  PART_SIZE,
  PART_PREFIX,
  PLAINTEXT_PART_PREFIX,
  partName,
  partIndex,
  partNameFor,
  rowDataCodec,
  partIndexFor,
  gzipFile,
  gunzipFile,
  encryptFile,
  decryptFile,
  splitIntoParts,
  reassembleParts,
  ensurePrivateDir,
  removeFiles,
} from './encryption.js';

// Canonical part-name formatting lives in encryption.js; nothing here
// re-derives the codec patterns.
import {
  formatSnapshotId,
  parseSnapshotId,
  isValidSnapshotId,
  computeAggregateFingerprint,
} from './fingerprint.js';

export { PART_SIZE, PART_PREFIX, PLAINTEXT_PART_PREFIX, partName, partIndex, rowDataCodec };

export const MANIFEST_NAME = 'manifest.json';
export const PLAINTEXT_ARTIFACTS = [
  'roles.sql',
  'schema.sql',
  'managed-schema.sql',
  'migration-history-schema.sql',
];
/** Caller-owned private dump inputs consumed by packaging. */
export const ROW_DATA_INPUTS = ['migration-history-data.sql', 'database-data.sql'];
export const ALL_SOURCE_FILES = [...PLAINTEXT_ARTIFACTS, ...ROW_DATA_INPUTS];
export const ROW_DATA_FILE = 'data.sql';

export const POSTGRES_MAJOR_VERSION = 17;

export const LIMITS = Object.freeze({
  maxManifestBytes: 1 * 1024 * 1024,
  maxPlaintextBytes: 512 * 1024 * 1024,
  maxPartBytes: PART_SIZE,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
});

export class SnapshotError extends Error {
  constructor(problems) {
    super(Array.isArray(problems) ? problems.join('; ') : String(problems));
    this.name = 'SnapshotError';
    this.problems = Array.isArray(problems) ? problems : [problems];
  }
}

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve a stored filename inside a private root. Rejects absolute paths,
 * separators, traversal, symlinks, and empty names.
 */
export function resolvePrivatePath(root, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new SnapshotError(['unsafe path: empty name']);
  }
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new SnapshotError([`unsafe path: ${name}`]);
  }
  if (path.isAbsolute(name) || !FILE_NAME_RE.test(name)) {
    throw new SnapshotError([`unsafe path: ${name}`]);
  }
  const full = path.join(root, name);
  const relative = path.relative(root, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SnapshotError([`unsafe path: ${name}`]);
  }
  return full;
}

/** Deterministic manifest builder with stable key order. */
export function buildManifest({
  environment,
  sourceProjectRef,
  snapshotId,
  createdAt,
  supabaseCliVersion,
  postgresMajorVersion = POSTGRES_MAJOR_VERSION,
  contentSha256,
  encryption,
  files,
  dataParts,
}) {
  // Resolving through the codec rejects unknown formats here instead of
  // silently emitting a bare `recipient: undefined` for them.
  const format = encryption.format ?? DEFAULT_FORMAT;
  const codec = rowDataCodec(format);
  return {
    formatVersion: 1,
    environment,
    sourceProjectRef,
    snapshotId,
    createdAt,
    supabaseCliVersion,
    postgresMajorVersion,
    contentSha256,
    encryption: codec.encrypted
      ? { format, recipient: encryption.recipient }
      : { format: PLAINTEXT_FORMAT },
    files,
    dataParts,
  };
}

/**
 * Shared format normalization for content comparison. The single source of
 * truth for "what formats exist" is the ROW_DATA_CODECS registry in
 * encryption.js: a missing `encryption.format` means the legacy age-x25519
 * default (pre-format manifests), and any other FORMAT STRING is taken
 * verbatim as its own identity — adding a third codec to the registry
 * automatically joins format comparison here with NO second path to keep in
 * sync. Unregistered format strings (unvalidated input) therefore compare as
 * themselves and can never silently equal a registered format.
 */
function formatOf(m) {
  if (m.encryption?.format === undefined) return ENCRYPTION_FORMAT;
  return m.encryption.format;
}

/**
 * True only when both logical content AND the stored row-data codec match.
 * Absent or partial inputs never compare equal. For non-`none` formats both
 * recipients must be present, non-empty strings and equal; for `none`
 * content equality is sufficient. A missing `encryption.format` is treated
 * as `age-x25519`, so the hosted RHS partial object
 * `{ contentSha256, encryption: { recipient } }` keeps working. Shared by
 * the hosted R2 change detector, the weekly repository planner, and the
 * local store.
 */
export function sameSnapshotContent(leftManifest, rightManifest) {
  if (!leftManifest || !rightManifest) return false;
  if (leftManifest.contentSha256 !== rightManifest.contentSha256) return false;
  const leftFormat = formatOf(leftManifest);
  const rightFormat = formatOf(rightManifest);
  if (leftFormat !== rightFormat) return false;
  if (leftFormat === PLAINTEXT_FORMAT) return true;
  const leftRecipient = leftManifest.encryption?.recipient;
  const rightRecipient = rightManifest.encryption?.recipient;
  return (
    typeof leftRecipient === 'string' &&
    leftRecipient.length > 0 &&
    leftRecipient === rightRecipient
  );
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** Snapshot ID / createdAt equivalence: both canonical and matching. */
function snapshotIdEquivalenceIssues(m) {
  const issues = [];
  if (!isValidSnapshotId(m.snapshotId)) {
    issues.push('INVALID snapshotId (must be canonical YYYY-MM-DDTHH-mm-ssZ)');
  }
  const createdAt = new Date(m.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    issues.push('INVALID createdAt (must be an ISO-8601 UTC timestamp)');
  } else if (formatSnapshotId(createdAt) !== m.snapshotId) {
    issues.push('INVALID createdAt (must equal the snapshotId instant)');
  }
  return issues;
}

/** Required and allowlisted stored files, duplicates, and plaintext data.sql. */
function storedFileListIssues(m) {
  const issues = [];
  const codec = rowDataCodec(m.encryption.format);
  const names = m.files.map((f) => f.name);
  for (const artifact of PLAINTEXT_ARTIFACTS) {
    if (!names.includes(artifact)) issues.push(`MISSING stored file ${artifact}`);
  }
  if (names.includes(ROW_DATA_FILE)) {
    issues.push('INVALID stored file data.sql (row data must live only in row-data parts)');
  }
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) issues.push(`INVALID duplicate stored file ${duplicates[0]}`);
  for (const name of names) {
    if (!PLAINTEXT_ARTIFACTS.includes(name) && !codec.partRe.test(name)) {
      issues.push(`INVALID stored file ${name}`);
    }
  }
  return issues;
}

/** Plaintext artifacts must be unencrypted and bounded. */
function artifactFlagIssues(m) {
  const issues = [];
  for (const artifact of PLAINTEXT_ARTIFACTS) {
    const entry = m.files.find((f) => f.name === artifact);
    if (entry && entry.encrypted !== false) issues.push(`INVALID encrypted flag for ${artifact}`);
    if (entry && entry.size > LIMITS.maxPlaintextBytes)
      issues.push(`OVERSIZED stored file ${artifact}`);
  }
  return issues;
}

/** Contiguous dataParts, matching file entries, and part-size limits. */
function dataPartIssues(m) {
  const issues = [];
  const codec = rowDataCodec(m.encryption.format);
  m.dataParts.forEach((part, position) => {
    const index = partIndexFor(m.encryption.format, part);
    if (index === null) issues.push(`INVALID data part name ${part}`);
    else if (index !== position)
      issues.push(`INVALID data part order at ${partNameFor(m.encryption.format, position)}`);
    const entries = m.files.filter((f) => f.name === part);
    if (entries.length !== 1 || entries[0].encrypted !== codec.encrypted) {
      issues.push(`INVALID data part entry ${part}`);
    }
    if (entries[0] && entries[0].size > LIMITS.maxPartBytes)
      issues.push(`OVERSIZED data part ${part}`);
  });
  for (const file of m.files) {
    if (codec.partRe.test(file.name) && !m.dataParts.includes(file.name)) {
      issues.push(`INVALID data part not listed in dataParts: ${file.name}`);
    }
  }
  return issues;
}

/** Aggregate every focused semantic issue in the documented order. */
function collectManifestSemanticIssues(m) {
  return [
    ...snapshotIdEquivalenceIssues(m),
    ...storedFileListIssues(m),
    ...artifactFlagIssues(m),
    ...dataPartIssues(m),
  ];
}

/** Immutable file-entry schema. */
const FILE_ENTRY_SCHEMA = z
  .object({
    name: z.string().regex(FILE_NAME_RE),
    size: z.number().int().nonnegative(),
    sha256: sha256Hex,
    encrypted: z.boolean(),
  })
  .strict();

/** Immutable base manifest schema (structural fields only). */
// The environment enum is deliberately extended with the single local-store
// label: local snapshots are real repository artifacts consumed by hosted
// restores. Downstream consumers that validate manifests against the two
// hosted environments must accept the third label.
const MANIFEST_BASE_SCHEMA = z
  .object({
    formatVersion: z.literal(1),
    environment: z.enum([...ENVIRONMENTS, LOCAL_STORE_ENVIRONMENT]),
    sourceProjectRef: z.string().regex(/^[a-z0-9]{20}$/),
    snapshotId: z.string(),
    createdAt: z.string(),
    supabaseCliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    postgresMajorVersion: z.literal(POSTGRES_MAJOR_VERSION),
    contentSha256: sha256Hex,
    encryption: z.discriminatedUnion('format', [
      z
        .object({
          format: z.literal(ENCRYPTION_FORMAT),
          recipient: z.string().regex(/^age1[a-z0-9]{38,65}$/),
        })
        .strict(),
      z.object({ format: z.literal(PLAINTEXT_FORMAT) }).strict(),
    ]),
    files: z.array(FILE_ENTRY_SCHEMA),
    dataParts: z.array(z.string()).min(1),
  })
  .strict();

/** Strict version-1 manifest schema with all semantic refinements applied. */
export const MANIFEST_SCHEMA = MANIFEST_BASE_SCHEMA.superRefine((m, ctx) => {
  for (const message of collectManifestSemanticIssues(m)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

/** Parse a manifest object through the strict schema; throws SnapshotError. */
export function parseManifest(object) {
  const result = MANIFEST_SCHEMA.safeParse(object);
  if (!result.success) {
    throw new SnapshotError(result.error.issues.map((i) => i.message));
  }
  return result.data;
}

function lstatRegular(filePath, name, problems) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    problems.push(`MISSING stored file ${name}`);
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    problems.push(`INVALID stored file ${name} (must be a regular file, not a symlink)`);
    return null;
  }
  return stat;
}

/** Verify one stored file's size and SHA-256; throws SnapshotError on mismatch. */
export async function verifyStoredFile(filePath, entry) {
  const stat = lstatRegular(filePath, entry.name, []);
  if (!stat) throw new SnapshotError([`MISSING stored file ${entry.name}`]);
  if (stat.size !== entry.size) {
    throw new SnapshotError([`SIZE MISMATCH ${entry.name}`]);
  }
  const actual = await sha256Readable(createReadStream(filePath));
  if (actual !== entry.sha256) {
    throw new SnapshotError([`CHECKSUM MISMATCH ${entry.name}`]);
  }
}

/** Load the manifest (or accept a validated override) with a size bound. */
async function loadPackagedManifest(dir, { manifestOverride, lim }) {
  if (manifestOverride !== undefined) {
    return parseManifest(manifestOverride);
  }
  const manifestPath = path.join(dir, MANIFEST_NAME);
  const stat = lstatRegular(manifestPath, MANIFEST_NAME, []);
  if (!stat) throw new SnapshotError([`MISSING stored file ${MANIFEST_NAME}`]);
  if (stat.size > lim.maxManifestBytes) {
    throw new SnapshotError([`OVERSIZED manifest (${stat.size} bytes)`]);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new SnapshotError([`INVALID manifest JSON: ${err.message}`]);
  }
  return parseManifest(raw);
}

/** Assert the expected environment/snapshot-id/project-ref against the manifest. */
function assertManifestExpectations(
  manifest,
  { expectedEnvironment, expectedSnapshotId, expectedProjectRef },
) {
  if (expectedEnvironment && manifest.environment !== expectedEnvironment) {
    throw new SnapshotError([
      `ENVIRONMENT MISMATCH (manifest ${manifest.environment}, expected ${expectedEnvironment})`,
    ]);
  }
  if (expectedSnapshotId && manifest.snapshotId !== expectedSnapshotId) {
    throw new SnapshotError([
      `SNAPSHOT ID MISMATCH (manifest ${manifest.snapshotId}, expected ${expectedSnapshotId})`,
    ]);
  }
  if (expectedProjectRef && manifest.sourceProjectRef !== expectedProjectRef) {
    throw new SnapshotError([
      `PROJECT REF MISMATCH (manifest does not match the selected project)`,
    ]);
  }
}

/** Inspect the directory entries and account total size; rejects symlinks/unknowns. */
function inspectDirectoryEntries(dir, manifest, lim) {
  const problems = [];
  let totalBytes = 0;
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new SnapshotError([`cannot read snapshot directory: ${err.message}`]);
  }
  const allowed = new Set([...manifest.files.map((f) => f.name), MANIFEST_NAME]);
  for (const entry of dirents) {
    if (!allowed.has(entry.name)) {
      problems.push(`UNEXPECTED FILE ${entry.name}`);
    }
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      problems.push(`INVALID ENTRY ${entry.name} (must be a regular file, not a symlink)`);
    }
  }
  for (const file of manifest.files) {
    const filePath = resolvePrivatePath(dir, file.name);
    const stat = lstatRegular(filePath, file.name, problems);
    if (stat) {
      // Size is re-verified with the hash in verifyStoredFile; only account
      // the byte total here so limits are still enforced in this pass.
      totalBytes += stat.size;
    }
  }
  if (manifest.files.length > 0 && totalBytes > lim.maxTotalBytes) {
    problems.push(`OVERSIZED SNAPSHOT (total ${totalBytes} bytes)`);
  }
  if (problems.length > 0) {
    throw new SnapshotError(problems);
  }
}

/** Per-file size/hash verification for every stored entry. */
async function verifyAllStoredFiles(dir, manifest) {
  for (const file of manifest.files) {
    await verifyStoredFile(resolvePrivatePath(dir, file.name), file);
  }
}

/**
 * Validate a packaged directory without decrypting:
 * schema + expectations + on-disk entries, sizes, hashes, and limits.
 */
export async function validatePackagedDirectory(
  dir,
  { manifestOverride, expectedEnvironment, expectedSnapshotId, expectedProjectRef, limits } = {},
) {
  const lim = { ...LIMITS, ...(limits ?? {}) };
  const manifest = await loadPackagedManifest(dir, { manifestOverride, lim });
  assertManifestExpectations(manifest, {
    expectedEnvironment,
    expectedSnapshotId,
    expectedProjectRef,
  });
  inspectDirectoryEntries(dir, manifest, lim);
  await verifyAllStoredFiles(dir, manifest);
  return { manifest, dir };
}

/** Validate the source dump files (regular, nonempty except managed, bounded). */
function validateSourceFiles({ sourceDir, lim }) {
  const problems = [];
  const sourceStats = {};
  for (const name of ALL_SOURCE_FILES) {
    const filePath = resolvePrivatePath(sourceDir, name);
    const stat = lstatRegular(filePath, name, problems);
    if (stat) sourceStats[name] = stat;
  }
  for (const [k, v] of Object.entries(sourceStats)) {
    if (v.size === 0 && k !== 'managed-schema.sql') {
      problems.push(`EMPTY source file ${k} (only managed-schema.sql may be empty)`);
    }
    if (v.size > lim.maxPlaintextBytes) problems.push(`OVERSIZED source file ${k}`);
  }
  if (problems.length > 0) {
    throw new SnapshotError(problems);
  }
}

/** Create the destination (mode 0700) and the private packaging staging dir. */
function createPackagingPaths(destDir) {
  if (fs.existsSync(destDir)) {
    throw new SnapshotError([`destination already exists: ${path.basename(destDir)}`]);
  }
  ensurePrivateDir(destDir, 0o700);
  const tmpDir = path.join(destDir, '.packaging-tmp');
  ensurePrivateDir(tmpDir, PRIVATE_DIRECTORY_MODE);
  return { tmpDir, partsDir: destDir };
}

/** Concatenate migration-history rows then all other rows -> data.sql. */
async function concatenateRowData({ sourceDir, tmpDir }) {
  const dataSql = path.join(tmpDir, ROW_DATA_FILE);
  await combineStreams(
    [
      fs.createReadStream(path.join(sourceDir, ROW_DATA_INPUTS[0])),
      fs.createReadStream(path.join(sourceDir, ROW_DATA_INPUTS[1])),
    ],
    dataSql,
  );
  return dataSql;
}

/**
 * The fixed five ordered logical fingerprint inputs, shared by the package
 * and unpack paths so their aggregate fingerprints are byte-identical.
 */
function logicalFingerprintFiles({ sourceDir, dataSql }) {
  return [
    { name: 'roles.sql', path: path.join(sourceDir, 'roles.sql') },
    { name: 'schema.sql', path: path.join(sourceDir, 'schema.sql') },
    { name: 'managed-schema.sql', path: path.join(sourceDir, 'managed-schema.sql') },
    {
      name: 'migration-history-schema.sql',
      path: path.join(sourceDir, 'migration-history-schema.sql'),
    },
    { name: ROW_DATA_FILE, path: dataSql },
  ];
}

/** gzip -> (encrypt | plaintext) -> parts (parts live directly in partsDir). */
async function compressAndSplitRowData(opts, { tmpDir, partsDir, dataSql, onProgress }) {
  const codec = rowDataCodec(opts.format);
  const gzPath = path.join(tmpDir, `${ROW_DATA_FILE}.gz`);
  onProgress?.('starting row-data compression');
  await gzipFile({ input: dataSql, output: gzPath });
  onProgress?.('completed row-data compression');
  let input = gzPath;
  if (codec.encrypted) {
    const agePath_ = path.join(tmpDir, `${ROW_DATA_FILE}.gz.age`);
    onProgress?.('starting row-data encryption');
    await encryptFile({
      recipient: opts.ageRecipient,
      input: gzPath,
      output: agePath_,
      agePath: opts.agePath,
      run: opts.run,
      signal: opts.signal,
    });
    onProgress?.('completed row-data encryption');
    input = agePath_;
    onProgress?.('starting encrypted-part splitting');
  } else {
    onProgress?.('starting row-data split (plaintext format)');
  }
  const partNames = await splitIntoParts({ input, outputDir: partsDir, prefix: codec.partPrefix });
  if (partNames.length === 0) {
    throw new SnapshotError(['row data produced no parts']);
  }
  onProgress?.(
    codec.encrypted
      ? 'completed encrypted-part splitting'
      : 'completed row-data split (plaintext format)',
  );
  return partNames;
}

/** Copy plaintext artifacts into the packaged directory (mode 0600). */
async function copyPlaintextArtifacts({ sourceDir, destDir, onProgress }) {
  const total = PLAINTEXT_ARTIFACTS.length;
  for (let i = 0; i < total; i++) {
    const artifact = PLAINTEXT_ARTIFACTS[i];
    onProgress?.(`starting plaintext-artifact copy ${ordinal(i, total)}: ${artifact}`);
    await pipeline(
      fs.createReadStream(path.join(sourceDir, artifact)),
      createWriteStream(path.join(destDir, artifact), { mode: PRIVATE_FILE_MODE }),
    );
    onProgress?.(`completed plaintext-artifact copy ${ordinal(i, total)}: ${artifact}`);
  }
}

/** Hash and size every stored file (plaintext artifacts + parts). */
async function collectStoredFileSizes({ destDir, partNames, codec, onProgress }) {
  const files = [];
  const stored = [
    ...PLAINTEXT_ARTIFACTS.map((name) => ({ name, encrypted: false })),
    ...partNames.map((name) => ({ name, encrypted: codec.encrypted })),
  ];
  const total = stored.length;
  for (let i = 0; i < total; i++) {
    const { name, encrypted } = stored[i];
    onProgress?.(`starting stored-file hash ${ordinal(i, total)}: ${name}`);
    const entry = { name, size: 0, sha256: '', encrypted };
    files.push(await sizeAndHash(path.join(destDir, name), entry));
    onProgress?.(`completed stored-file hash ${ordinal(i, total)}: ${name}`);
  }
  return files;
}

/**
 * Package raw dumps into a validated snapshot directory.
 *
 * `sourceDir` must contain the six dump outputs (row-data inputs private).
 * `destDir` is created mode-0700 and removed on failure; plaintext
 * intermediates are removed on every outcome. `captureTmpDir` is exposed for
 * tests that inject encryption failures.
 * @param {object} opts
 * @param {string} opts.sourceDir
 * @param {string} opts.destDir
 * @param {string} opts.snapshotId
 * @param {string} opts.environment
 * @param {string} opts.sourceProjectRef
 * @param {string} opts.supabaseCliVersion
 * @param {string} opts.ageRecipient
 * @param {string} [opts.agePath]
 * @param {'age-x25519'|'none'} [opts.format] row-data codec; defaults to
 *   `age-x25519` (hosted behavior)
 * @param {Function} [opts.run] passed through to the encryption helpers,
 *   each of which defaults to `runCommand`
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.limits]
 * @param {(message: string) => void} [opts.onProgress]
 */
export async function packageSnapshot(opts) {
  const lim = { ...LIMITS, ...(opts.limits ?? {}) };
  const onProgress = opts.onProgress;
  const format = opts.format ?? DEFAULT_FORMAT;
  const codec = rowDataCodec(format);
  onProgress?.('starting source validation');
  validateSourceFiles({ sourceDir: opts.sourceDir, lim });
  onProgress?.('completed source validation');

  onProgress?.('starting package workspace creation');
  const { tmpDir, partsDir } = createPackagingPaths(opts.destDir);
  onProgress?.('completed package workspace creation');
  const createdAt = new Date(parseSnapshotId(opts.snapshotId).ms).toISOString();

  try {
    // 1. Concatenate migration-history rows then all other rows -> data.sql.
    onProgress?.('starting row-data concatenation');
    const dataSql = await concatenateRowData({ sourceDir: opts.sourceDir, tmpDir });
    onProgress?.('completed row-data concatenation');

    // 2. Aggregate normalized fingerprint over the five logical files.
    onProgress?.('starting content fingerprinting');
    const aggregate = await computeAggregateFingerprint({
      files: logicalFingerprintFiles({ sourceDir: opts.sourceDir, dataSql }),
    });
    onProgress?.('completed content fingerprinting');

    // 3. gzip -> (age encrypt | plaintext) -> split into parts.
    const partNames = await compressAndSplitRowData(opts, {
      tmpDir,
      partsDir,
      dataSql,
      onProgress,
    });

    // 4. Copy plaintext artifacts into the packaged directory (mode 0600).
    await copyPlaintextArtifacts({
      sourceDir: opts.sourceDir,
      destDir: opts.destDir,
      onProgress,
    });

    // 5. Hash and size every stored file (plaintext artifacts + parts).
    const files = await collectStoredFileSizes({
      destDir: opts.destDir,
      partNames,
      codec,
      onProgress,
    });

    // 6. manifest.json last.
    onProgress?.('starting manifest creation');
    const manifest = buildManifest({
      environment: opts.environment,
      sourceProjectRef: opts.sourceProjectRef,
      snapshotId: opts.snapshotId,
      createdAt,
      supabaseCliVersion: opts.supabaseCliVersion,
      contentSha256: aggregate.hex,
      encryption: { format, recipient: opts.ageRecipient },
      files,
      dataParts: partNames,
    });
    writeManifest(opts.destDir, manifest);
    onProgress?.('completed manifest creation');
    return { manifest, destDir: opts.destDir, contentSha256: aggregate.hex };
  } catch (err) {
    reportProgressSafely(onProgress, 'starting incomplete-package cleanup attempt');
    await removeFiles([opts.destDir]);
    reportProgressSafely(onProgress, 'completed incomplete-package cleanup attempt');
    throw err;
  } finally {
    reportProgressSafely(onProgress, 'starting staging cleanup attempt');
    await removeFiles([tmpDir]);
    reportProgressSafely(onProgress, 'completed staging cleanup attempt');
  }
}

export function writeManifest(destDir, manifest) {
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(destDir, MANIFEST_NAME), raw, { mode: 0o600 });
  return raw;
}

async function sizeAndHash(filePath, entry) {
  const stat = fs.statSync(filePath);
  entry.size = stat.size;
  entry.sha256 = await sha256Readable(createReadStream(filePath));
  return entry;
}

async function combineStreams(streams, output) {
  ensurePrivateDir(path.dirname(output), PRIVATE_DIRECTORY_MODE);
  const out = createWriteStream(output, { mode: PRIVATE_FILE_MODE });
  try {
    for (const stream of streams) {
      await pipeline(stream, out, { end: false });
    }
  } finally {
    // Shared ending semantics: resolves on finish/close, rejects on a stream
    // error, and never hangs on streams without a close event.
    await endWritable(out);
  }
}

/**
 * Fully verify and decrypt a packaged snapshot into a NEW private prepared
 * directory containing roles.sql, schema.sql, managed-schema.sql,
 * migration-history-schema.sql, data.sql, and manifest.json.
 *
 * Runs every integrity check (sizes, hashes, part order, identity decryption,
 * gunzip, aggregate fingerprint) before returning; removes intermediates and
 * the destination on failure.
 */
/** Copy verified plaintext artifacts and the manifest into the prepared dir. */
async function copyVerifiedPlaintext({ sourceDir, destDir }) {
  for (const artifact of PLAINTEXT_ARTIFACTS) {
    await pipeline(
      fs.createReadStream(path.join(sourceDir, artifact)),
      createWriteStream(path.join(destDir, artifact), { mode: PRIVATE_FILE_MODE }),
    );
  }
  await pipeline(
    fs.createReadStream(path.join(sourceDir, MANIFEST_NAME)),
    createWriteStream(path.join(destDir, MANIFEST_NAME), { mode: PRIVATE_FILE_MODE }),
  );
}

/** Reassemble the parts, decrypt (age formats only), and gunzip into data.sql. */
async function restoreRowData({
  sourceDir,
  destDir,
  tmpDir,
  manifest,
  identityFile,
  agePath,
  run,
  signal,
  lim,
}) {
  const codec = rowDataCodec(manifest.encryption.format);
  const gunzipped = path.join(tmpDir, `${ROW_DATA_FILE}.gz`);
  // Reassembly output and decrypt output are the SAME path for plaintext
  // codecs (decrypt is skipped): plaintext parts are gunzipped in place.
  const assembled = path.join(
    tmpDir,
    codec.encrypted ? `${ROW_DATA_FILE}.gz.age` : `${ROW_DATA_FILE}.gz`,
  );
  const dataPath = path.join(destDir, ROW_DATA_FILE);
  await reassembleParts({
    parts: manifest.dataParts.map((p) => path.join(sourceDir, p)),
    output: assembled,
  });
  if (codec.encrypted) {
    if (!identityFile) {
      throw new SnapshotError([
        'snapshot is age-encrypted but no identity file was provided (DECRYPT_KEY required)',
      ]);
    }
    await decryptFile({ identityFile, input: assembled, output: gunzipped, agePath, run, signal });
  }
  // The decompressed bound is the combined row-data inputs (each source file
  // is individually capped at maxPlaintextBytes when packaged), so a tiny
  // high-ratio gzip part can never exhaust the temp filesystem on restore.
  await gunzipFile({
    input: codec.encrypted ? gunzipped : assembled,
    output: dataPath,
    maxBytes: ROW_DATA_INPUTS.length * lim.maxPlaintextBytes,
  });
  return dataPath;
}

/** Recompute the aggregate fingerprint and require it to match the manifest. */
async function verifyAggregateFingerprint({ destDir, dataPath, contentSha256 }) {
  const aggregate = await computeAggregateFingerprint({
    files: logicalFingerprintFiles({ sourceDir: destDir, dataSql: dataPath }),
  });
  if (aggregate.hex !== contentSha256) {
    throw new SnapshotError(['FINGERPRINT MISMATCH (decrypted content differs from manifest)']);
  }
  return aggregate.hex;
}

export async function unpackAndVerify(opts) {
  const lim = { ...LIMITS, ...(opts.limits ?? {}) };
  const { manifest } = await validatePackagedDirectory(opts.sourceDir, {
    expectedEnvironment: opts.expectedEnvironment,
    expectedSnapshotId: opts.expectedSnapshotId,
    expectedProjectRef: opts.expectedProjectRef,
    limits: lim,
  });

  if (fs.existsSync(opts.destDir)) {
    throw new SnapshotError([`destination already exists: ${path.basename(opts.destDir)}`]);
  }
  ensurePrivateDir(opts.destDir, PRIVATE_DIRECTORY_MODE);
  const tmpDir = path.join(opts.destDir, '.unpack-tmp');
  ensurePrivateDir(tmpDir, PRIVATE_DIRECTORY_MODE);

  try {
    // Copy verified plaintext artifacts + manifest into the prepared dir.
    await copyVerifiedPlaintext({ sourceDir: opts.sourceDir, destDir: opts.destDir });

    // Reassemble, decrypt (age formats only), gunzip.
    const dataPath = await restoreRowData({
      sourceDir: opts.sourceDir,
      destDir: opts.destDir,
      tmpDir,
      manifest,
      identityFile: opts.identityFile,
      agePath: opts.agePath,
      run: opts.run,
      signal: opts.signal,
      lim,
    });

    // Recompute the complete normalized aggregate fingerprint.
    const contentSha256 = await verifyAggregateFingerprint({
      destDir: opts.destDir,
      dataPath,
      contentSha256: manifest.contentSha256,
    });
    return { dir: opts.destDir, dataPath, manifest, contentSha256 };
  } catch (err) {
    await removeFiles([opts.destDir]);
    throw err;
  } finally {
    await removeFiles([tmpDir]);
  }
}

export { REPOSITORY_ROOT };
