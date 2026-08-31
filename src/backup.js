/**
 * Shared remote-independent backup mechanics.
 *
 * Consumed by both `scripts/backup.js` (hosted R2 pipeline) and
 * `scripts/backup-local.js` (private local store): executable preflight,
 * the private OS workspace, and the dump-then-package orchestration.
 * Row-data storage is a codec choice (age-encrypted | plaintext), not an
 * unconditional age step: `requireAge: false` skips the age lookup entirely
 * and `format` selects the packaging codec. Nothing in this module may
 * import `src/r2.js`; the local backup path must never gain a remote-
 * storage dependency or credential seam.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PINNED_SUPABASE_CLI_VERSION } from './database.js';
import { ENCRYPTION_FORMAT } from './encryption.js';

/**
 * Resolve age (only when required), the pinned Supabase CLI, and Docker;
 * any required miss aborts preflight. With `requireAge: false` age is
 * neither looked up nor required.
 */
export function resolveBackupExecutables({ lookup, locateCli, root, platform, requireAge = true }) {
  let ageBin;
  if (requireAge) {
    ageBin = lookup(platform === 'win32' ? 'age.exe' : 'age');
    if (!ageBin) throw new Error('age executable not found on PATH; install it and retry');
  }
  const supabasePath = locateCli({ root });
  if (!supabasePath) throw new Error('Supabase CLI not found; run vp install first');
  const dockerPath = lookup(platform === 'win32' ? 'docker.exe' : 'docker');
  if (!dockerPath)
    throw new Error('Docker is required for Supabase dump/diff and was not found on PATH');
  return { ageBin, supabasePath, dockerPath };
}

/**
 * Create the private root/dump workspace; packageSnapshot owns the pkg dir.
 * The prefix embeds the process id so cross-process workspace scans (tests)
 * never see another process's directories.
 */
export function createBackupWorkspace(token = process.pid) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `fragtrack-backup-${token}-`));
  fs.chmodSync(workspace, 0o700);
  const outDir = path.join(workspace, 'dumps');
  // NOT pre-created: packageSnapshot (and unpackAndVerify) own destination
  // directory creation and reject a pre-existing destDir, so the caller must
  // hand over a path that does not exist yet.
  const pkgDir = path.join(workspace, 'pkg');
  fs.mkdirSync(outDir, { mode: 0o700 });
  return { workspace, outDir, pkgDir };
}

/**
 * Dump and package the snapshot; validated before ANY deletion. `dbUrl` is
 * the ONLY source input; `cwd` is the working directory for the dump
 * commands (the backup repository for local runs, never the Fragtrack
 * workdir). `pkgDir` is caller-owned: the remote pipeline uses the OS
 * workspace, the local pipeline a candidate on the destination filesystem
 * for the same-filesystem atomic rename.
 */
export async function dumpAndPackageSnapshot({
  dbUrl,
  cwd,
  outDir,
  pkgDir,
  snapshotId,
  environment,
  sourceProjectRef,
  ageRecipient,
  executables,
  doDump,
  doPackage,
  run,
  signal,
  onProgress,
  format = ENCRYPTION_FORMAT,
}) {
  onProgress?.('starting logical database dump');
  await doDump({
    dbUrl,
    cwd,
    outDir,
    supabasePath: executables.supabasePath,
    dockerPath: executables.dockerPath,
    run,
    signal,
    onProgress,
  });
  onProgress?.('completed logical database dump');
  onProgress?.('starting snapshot packaging');
  const packaged = await doPackage({
    sourceDir: outDir,
    destDir: pkgDir,
    snapshotId,
    environment,
    sourceProjectRef,
    supabaseCliVersion: PINNED_SUPABASE_CLI_VERSION,
    format,
    ageRecipient,
    agePath: executables.ageBin,
    run,
    onProgress,
  });
  onProgress?.('completed snapshot packaging');
  return { manifest: packaged.manifest, contentSha256: packaged.contentSha256 };
}
