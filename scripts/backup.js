#!/usr/bin/env node
/**
 * Daily backup entry point for one environment.
 *
 *   vp run backup --environment development
 *   vp run backup --environment production
 *   vp run backup --environment development --staging-dir <path>
 *
 * Flow: config (no private identity) -> private workspace -> logical dumps ->
 * package/fingerprint -> compare with newest valid R2 snapshot -> upload (when
 * changed) -> retention and same-day cleanup ->
 * optional staging output for the Sunday Git path -> GitHub outputs/summary.
 * All private plaintext intermediates are removed in `finally`.
 *
 * Every step reports secret-free progress through the shared redacting
 * `logger.status` path: `backup <environment>: <message>`. A failed operation
 * leaves its `starting` line unmatched; the final result summary is emitted
 * only after the private workspace cleanup completes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable } from '../src/process.js';
import { loadBackupConfig } from '../src/config.js';
import { dumpDatabase, locateSupabaseCli } from '../src/database.js';
import {
  resolveBackupExecutables,
  createBackupWorkspace,
  dumpAndPackageSnapshot,
} from '../src/backup.js';
import {
  packageSnapshot,
  verifyStoredFile,
  sameSnapshotContent,
  MANIFEST_NAME,
  LIMITS,
} from '../src/snapshot.js';
import { reportProgressSafely, ordinal } from '../src/progress.js';
import { formatSnapshotId } from '../src/fingerprint.js';
import {
  createS3Adapter,
  listSnapshotPrefixes,
  listValidSnapshots,
  selectLatest,
  computeRetentionDeletes,
  computeSameDayDelete,
  deletePrefix,
  uploadSnapshot,
  headBucketCheck,
  prefixOf,
  snapshotIdOf,
} from '../src/r2.js';
import { parseBackupArgs, BACKUP_USAGE } from './args.js';

function readEnv(name, env) {
  return env[name];
}

export async function requirePrivateContext(env) {
  if (env.GITHUB_ACTIONS !== 'true') return;
  if (readEnv('REPOSITORY_PRIVATE', env) !== 'true') {
    throw new Error('backup refuses to run in GitHub Actions unless the repository is private');
  }
}

/** Append GitHub output lines; no-op when the path is absent. */
function writeGitHubOutputs(env, values) {
  const outputPath = readEnv('GITHUB_OUTPUT', env);
  if (!outputPath) return;
  const lines = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

/** Append the step summary table; no-op when the path is absent. */
function writeStepSummary(env, rows) {
  const summaryPath = readEnv('GITHUB_STEP_SUMMARY', env);
  if (!summaryPath) return;
  const table = [
    '### Backup summary',
    '',
    '| environment | snapshot id | r2 changed | deleted prefixes | staging output |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.environment} | \`${r.snapshotId}\` | ${r.r2Changed} | ${r.deletedPrefixCount} | ${r.stagingPath ? 'yes' : 'no'} |`,
    ),
    '',
  ].join('\n');
  fs.appendFileSync(summaryPath, table);
}

/** Copy a validated packaged snapshot into a staging directory for the Sunday path. */
export async function emitStagedSnapshot({
  pkgDir,
  manifest,
  stagingDir,
  environment,
  snapshotId,
  onProgress,
}) {
  const root = path.join(stagingDir, environment, snapshotId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const total = manifest.files.length + 1;
    for (const [index, entry] of manifest.files.entries()) {
      onProgress?.(`starting staged file copy ${ordinal(index, total)}: ${entry.name}`);
      fs.copyFileSync(path.join(pkgDir, entry.name), path.join(root, entry.name));
      fs.chmodSync(path.join(root, entry.name), 0o600);
      await verifyStoredFile(path.join(root, entry.name), entry);
      onProgress?.(`completed staged file copy ${ordinal(index, total)}: ${entry.name}: verified`);
    }
    onProgress?.(`starting staged file copy ${total}/${total}: ${MANIFEST_NAME}`);
    fs.copyFileSync(path.join(pkgDir, MANIFEST_NAME), path.join(root, MANIFEST_NAME));
    fs.chmodSync(path.join(root, MANIFEST_NAME), 0o600);
    const manifestSize = fs.statSync(path.join(root, MANIFEST_NAME)).size;
    if (manifestSize > LIMITS.maxManifestBytes) {
      throw new Error('staged snapshot manifest exceeds size limit');
    }
    // The size bound is not an integrity check: the copied manifest must
    // match the packaged manifest that was validated in memory.
    const copiedManifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8'));
    if (JSON.stringify(copiedManifest) !== JSON.stringify(manifest)) {
      throw new Error('staged manifest does not match the packaged manifest');
    }
    onProgress?.(`completed staged file copy ${total}/${total}: ${MANIFEST_NAME}: verified`);
    return root;
  } catch (err) {
    reportProgressSafely(onProgress, 'starting incomplete-staged-snapshot cleanup attempt');
    fs.rmSync(root, { recursive: true, force: true });
    reportProgressSafely(onProgress, 'completed incomplete-staged-snapshot cleanup attempt');
    throw err;
  }
}

/** True when content hash or the encryption recipient differs from the newest valid snapshot. */
function snapshotHasChanged({ newest, contentSha256, recipient }) {
  if (!newest) return true;
  return !sameSnapshotContent(newest.manifest, { contentSha256, encryption: { recipient } });
}

/** Combine valid snapshots and incomplete canonical prefixes for retention. */
function buildRetentionSnapshotList({ valid, allPrefixes }) {
  return [
    ...valid.map((v) => ({ snapshotId: v.snapshotId, manifest: v.manifest })),
    ...[...allPrefixes]
      .filter((p) => !valid.some((v) => v.prefix === p))
      .map((p) => ({ snapshotId: snapshotIdOf(p), manifest: null })),
  ];
}

/** Convert manifest entries into upload descriptors. */
function buildUploadFiles({ manifest, pkgDir }) {
  return manifest.files.map((f) => ({
    name: f.name,
    path: path.join(pkgDir, f.name),
    sha256: f.sha256,
    contentType: f.name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
  }));
}

/** Upload the packaged snapshot before any existing prefix is deleted. */
async function uploadPackagedSnapshot({
  cfg,
  snapshotId,
  manifest,
  pkgDir,
  doUpload,
  adapter,
  onProgress,
}) {
  const files = buildUploadFiles({ manifest, pkgDir });
  await doUpload({
    adapter,
    bucket: cfg.bucket,
    prefix: prefixOf(snapshotId),
    files,
    manifest,
    manifestRaw: `${JSON.stringify(manifest, null, 2)}\n`,
    onProgress,
  });
}

/**
 * Secret-free GitHub outputs, step summary, and final status line for one
 * backup run. Runs only AFTER the private workspace is removed; publication
 * is best-effort reporting and never fails an already-completed backup.
 * Each channel is isolated so a write failure is logged explicitly, keeps
 * the other channel intact, and never suppresses the final status line.
 */
function publishBackupResult({ ctx, result }) {
  const { env, cfg, logger } = ctx;
  if (!result) return;
  const { snapshotId, deletedPrefixCount, stagingPath, r2Changed } = result;
  const onProgress = ctx.onProgress;
  if (readEnv('GITHUB_OUTPUT', env)) {
    onProgress('starting GitHub output write');
    try {
      writeGitHubOutputs(env, {
        snapshot_id: snapshotId,
        r2_changed: String(r2Changed),
        deleted_prefix_count: String(deletedPrefixCount),
        staging_path: stagingPath,
      });
      onProgress('completed GitHub output write');
    } catch (err) {
      logger.error(`backup ${cfg.environment}: GitHub output publication failed: ${err.message}`);
    }
  } else {
    onProgress('skipped GitHub output write: path not configured');
  }
  if (readEnv('GITHUB_STEP_SUMMARY', env)) {
    onProgress('starting step summary write');
    try {
      writeStepSummary(env, [
        {
          environment: cfg.environment,
          snapshotId,
          r2Changed: String(r2Changed),
          deletedPrefixCount,
          stagingPath,
        },
      ]);
      onProgress('completed step summary write');
    } catch (err) {
      logger.error(`backup ${cfg.environment}: step summary publication failed: ${err.message}`);
    }
  } else {
    onProgress('skipped step summary write: path not configured');
  }
  logger.status(
    `backup ${cfg.environment}: snapshot ${snapshotId} ${r2Changed ? 'uploaded' : 'unchanged (no upload)'}; ${deletedPrefixCount} prefix(es) cleaned`,
  );
}

/** Resolve the injectable dependency seam once; helpers never build adapters directly. */
function resolveBackupDeps(deps) {
  return {
    loadConfig: deps.loadConfig ?? loadBackupConfig,
    doDump: deps.doDump ?? dumpDatabase,
    doPackage: deps.doPackage ?? packageSnapshot,
    doListValid: deps.doListValid ?? listValidSnapshots,
    doSelectLatest: deps.doSelectLatest ?? selectLatest,
    doListPrefixes: deps.doListPrefixes ?? listSnapshotPrefixes,
    doRetention: deps.doRetention ?? computeRetentionDeletes,
    doSameDay: deps.doSameDay ?? computeSameDayDelete,
    doDeletePrefix: deps.doDeletePrefix ?? deletePrefix,
    doUpload: deps.doUpload ?? uploadSnapshot,
    doHeadBucket: deps.doHeadBucket ?? headBucketCheck,
    makeAdapter: deps.makeAdapter ?? createS3Adapter,
    locateCli: deps.locateCli ?? locateSupabaseCli,
    lookup: deps.lookup ?? lookupExecutable,
    run: deps.run ?? runCommand,
    now: deps.now ?? (() => new Date()),
    doEmitStagedSnapshot: deps.doEmitStagedSnapshot ?? emitStagedSnapshot,
    removeWorkspace:
      deps.removeWorkspace ??
      ((workspaceRoot) => fs.rmSync(workspaceRoot, { recursive: true, force: true })),
  };
}

/** Dump/package, inspect R2, and compare with the newest valid snapshot. */
async function dumpAndInspectR2(ctx) {
  const { manifest, contentSha256 } = await dumpAndPackageSnapshot({
    dbUrl: ctx.cfg.dbUrl,
    cwd: ctx.cwd,
    outDir: ctx.outDir,
    pkgDir: ctx.pkgDir,
    snapshotId: ctx.snapshotId,
    environment: ctx.cfg.environment,
    sourceProjectRef: ctx.cfg.projectRef,
    ageRecipient: ctx.cfg.ageRecipient,
    executables: ctx.executables,
    doDump: ctx.d.doDump,
    doPackage: ctx.d.doPackage,
    run: ctx.d.run,
    signal: undefined,
    onProgress: ctx.onProgress,
  });
  ctx.onProgress('starting valid-snapshot scan');
  const valid = await ctx.d.doListValid({
    adapter: ctx.adapter,
    bucket: ctx.cfg.bucket,
    expectedEnvironment: ctx.cfg.environment,
    onProgress: ctx.onProgress,
  });
  ctx.onProgress(`completed valid-snapshot scan: ${valid.length} valid snapshot(s)`);
  ctx.onProgress('starting newest-valid selection');
  const newest = ctx.d.doSelectLatest(valid);
  ctx.onProgress(`completed newest-valid selection: ${newest ? newest.snapshotId : 'none'}`);
  ctx.onProgress('starting content and recipient comparison');
  const changed = snapshotHasChanged({
    newest,
    contentSha256,
    recipient: manifest.encryption.recipient,
  });
  ctx.onProgress(
    changed
      ? 'completed content and recipient comparison: changed'
      : 'completed content and recipient comparison: unchanged',
  );
  ctx.onProgress('starting all-prefix scan');
  const listedPrefixes = await ctx.d.doListPrefixes({
    adapter: ctx.adapter,
    bucket: ctx.cfg.bucket,
  });
  const allPrefixes = new Set(
    listedPrefixes instanceof Map ? listedPrefixes.keys() : listedPrefixes,
  );
  ctx.onProgress(`completed all-prefix scan: ${allPrefixes.size} prefix(es)`);
  return { manifest, contentSha256, valid, changed, allPrefixes };
}

/** Upload first, then apply retention/same-day deletion (union, no double count). */
async function applyR2RetentionAndUpload(
  ctx,
  { valid, changed, allPrefixes, manifest, snapshotId },
) {
  const { onProgress, d, cfg } = ctx;
  onProgress('starting retention computation');
  const expired = await d.doRetention({
    snapshots: buildRetentionSnapshotList({ valid, allPrefixes }),
    now: ctx.runDate,
  });
  onProgress(`completed retention computation: ${expired.length} target(s)`);
  // Fatal conflict: an identical snapshot-ID prefix already exists. Uploading
  // would clobber it and the same-day delete would then remove our own fresh
  // upload, so the run aborts BEFORE any upload or deletion (upload-before-
  // delete ordering is contract). Re-run in a different UTC second or
  // reconcile the conflicting prefix manually.
  onProgress('starting target-prefix conflict check');
  if (changed && allPrefixes.has(prefixOf(snapshotId))) {
    throw new Error(
      `refusing to overwrite existing snapshot prefix ${prefixOf(snapshotId)}; re-run in a different UTC second or reconcile the conflicting prefix manually`,
    );
  }
  onProgress('completed target-prefix conflict check');
  let sameDay;
  if (changed) {
    onProgress('starting same-day cleanup computation');
    sameDay = await d.doSameDay({ snapshotId, prefixes: [...allPrefixes] });
    onProgress(`completed same-day cleanup computation: ${sameDay.length} target(s)`);
  } else {
    sameDay = [];
    onProgress('skipped same-day cleanup computation: snapshot content unchanged');
  }
  if (changed) {
    onProgress('starting snapshot upload');
    await uploadPackagedSnapshot({
      cfg,
      snapshotId,
      manifest,
      pkgDir: ctx.pkgDir,
      doUpload: d.doUpload,
      adapter: ctx.adapter,
      onProgress,
    });
    onProgress('completed snapshot upload');
  } else {
    onProgress('skipped R2 upload: snapshot content and encryption recipient are unchanged');
  }
  // One pass over the union of retention + same-day targets so a prefix
  // present in both sets is deleted and counted exactly once.
  const deleteTargets = new Map();
  for (const snap of expired) deleteTargets.set(prefixOf(snap.snapshotId), true);
  for (const prefix of sameDay) deleteTargets.set(prefix, true);
  const targets = [...deleteTargets.keys()];
  if (targets.length === 0) {
    onProgress('skipped R2 prefix cleanup: no cleanup targets');
  } else {
    onProgress(`starting R2 prefix cleanup: ${targets.length} target(s)`);
    for (let i = 0; i < targets.length; i++) {
      const prefix = targets[i];
      const prefixSnapshotId = snapshotIdOf(prefix);
      onProgress(
        `starting cleanup of snapshot prefix ${ordinal(i, targets.length)}: ${prefixSnapshotId}`,
      );
      await d.doDeletePrefix({ adapter: ctx.adapter, bucket: cfg.bucket, prefix, onProgress });
      onProgress(
        `completed cleanup of snapshot prefix ${ordinal(i, targets.length)}: ${prefixSnapshotId}`,
      );
    }
    onProgress(`completed R2 prefix cleanup: ${targets.length} target(s)`);
  }
  let stagingPath = null;
  if (ctx.stagingDir) {
    onProgress('starting staged snapshot emission');
    stagingPath = await d.doEmitStagedSnapshot({
      pkgDir: ctx.pkgDir,
      manifest,
      stagingDir: ctx.stagingDir,
      environment: ctx.cfg.environment,
      snapshotId,
      onProgress,
    });
    onProgress('completed staged snapshot emission');
  } else {
    onProgress('skipped staged snapshot emission: not requested');
  }
  return { deletedPrefixCount: deleteTargets.size, stagingPath };
}

/** Config, preflight, executables, and workspace for the current run. */
async function prepareBackupContext({ options, env, cwd, logger, d, onProgress }) {
  const { environment, stagingDir } = options;
  // Defense in depth: register the staging root before any operation can
  // interpolate or surface it.
  if (stagingDir) logger.addSecret(stagingDir);
  onProgress('starting configuration load');
  const cfg = d.loadConfig({ environment, vars: env, root: cwd });
  onProgress('completed configuration load');
  logger.addSecret(cfg.dbUrl);
  logger.addSecret(cfg.accessKeyId);
  logger.addSecret(cfg.secretAccessKey);
  logger.addSecret(cfg.projectRef);
  logger.addSecret(cfg.accountId);
  logger.addSecret(cfg.ageRecipient);
  onProgress('starting private-repository check');
  await requirePrivateContext(env);
  onProgress('completed private-repository check');
  onProgress('starting R2 client initialization');
  const adapter = d.makeAdapter({
    accountId: cfg.accountId,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  onProgress('completed R2 client initialization');
  onProgress('starting R2 bucket access check');
  await d.doHeadBucket({ adapter, bucket: cfg.bucket });
  onProgress('completed R2 bucket access check');
  onProgress('starting executable resolution');
  const executables = resolveBackupExecutables({
    lookup: d.lookup,
    locateCli: d.locateCli,
    root: cwd,
    platform: process.platform,
  });
  onProgress('completed executable resolution');
  // The start line must be emitted BEFORE the clock is read/formatting so a
  // failure of either still honors the unmatched-start contract.
  onProgress('starting snapshot-ID initialization');
  const currentDate = d.now();
  const snapshotId = formatSnapshotId(currentDate);
  onProgress(`completed snapshot-ID initialization: ${snapshotId}`);
  onProgress('starting private workspace initialization');
  const workspace = createBackupWorkspace();
  logger.addSecret(workspace.workspace);
  onProgress('completed private workspace initialization');
  return {
    env,
    logger,
    d,
    cfg,
    cwd,
    adapter,
    executables,
    snapshotId,
    workspace,
    outDir: workspace.outDir,
    pkgDir: workspace.pkgDir,
    environment,
    stagingDir,
    runDate: currentDate.getTime(),
    onProgress,
  };
}

/**
 * The full daily backup run. Every external adapter is injected so unit tests
 * can fake dump/package/R2/clock/file-system behavior; `options` is the
 * validated object from the CLI parser.
 */
export async function runBackup({
  options,
  env = process.env,
  cwd = process.cwd(),
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const d = resolveBackupDeps(deps);
  const environment = options.environment;
  const onProgress = (message) => {
    logger.status(`backup ${environment}: ${message}`);
  };
  onProgress('starting backup run');

  const ctx = await prepareBackupContext({ options, env, cwd, logger, d, onProgress });
  let result = null;
  let failure = null;
  try {
    const { manifest, contentSha256, valid, changed, allPrefixes } = await dumpAndInspectR2(ctx);
    const applied = await applyR2RetentionAndUpload(ctx, {
      valid,
      changed,
      allPrefixes,
      manifest,
      snapshotId: ctx.snapshotId,
    });
    result = {
      snapshotId: ctx.snapshotId,
      environment: ctx.cfg.environment,
      r2Changed: changed,
      deletedPrefixCount: applied.deletedPrefixCount,
      stagingPath: applied.stagingPath,
      changedDetected: changed,
      contentSha256,
    };
  } catch (err) {
    failure = err;
  }
  // Mandatory confidentiality cleanup runs on EVERY outcome. It must never
  // be skipped because progress reporting failed, and a cleanup failure
  // must never mask the primary failure.
  reportProgressSafely(ctx.onProgress, 'starting private workspace cleanup');
  try {
    await d.removeWorkspace(ctx.workspace.workspace);
  } catch (err) {
    if (failure) {
      ctx.logger.error(
        `backup ${ctx.cfg.environment}: private workspace cleanup failed: ${err.message}`,
      );
    } else {
      throw err;
    }
  }
  reportProgressSafely(ctx.onProgress, 'completed private workspace cleanup');
  // The final summary and GitHub publication happen only after the workspace
  // cleanup completed; publication is best-effort reporting and must never
  // turn an already-completed backup into a failed run.
  if (failure) throw failure;
  try {
    publishBackupResult({ ctx, result });
  } catch (err) {
    ctx.logger.error(`backup ${ctx.cfg.environment}: result publication failed: ${err.message}`);
  }
  return result;
}

/** CLI entry point: the only place raw argv is parsed. */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr, secrets: [process.env.SUPABASE_DB_URL] });
  try {
    const parsed = parseBackupArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${BACKUP_USAGE}\n`);
      return 0;
    }
    await runBackup({ options: parsed, logger });
    return 0;
  } catch (err) {
    logger.error(`backup failed: ${logger.redact(err.message ?? String(err))}`);
    if (err.cause) logger.error(`cause: ${logger.redact(String(err.cause.message ?? err.cause))}`);
    process.exitCode = 1;
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
