#!/usr/bin/env node
/**
 * Weekly Sunday staged-snapshot commit planner (sub-plan 05).
 *
 *   vp run commit:weekly --staging-dir <path>
 *
 * Compares validated staged snapshots against the newest committed valid
 * manifests per environment and copies changed snapshots into append-only dated
 * directories under `backups/`. Never invokes Git itself; the workflow owns
 * pull/commit/push. Exits zero with a machine-readable `changed=` result even
 * when nothing changed (Sunday reruns are idempotent).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import {
  scanRepositorySnapshots,
  loadStagedSnapshots,
  newestOf,
  planWeekly,
  copyStagedSnapshot,
  RepositoryError,
} from '../src/repository.js';
import { parseCommitWeeklyArgs, COMMIT_WEEKLY_USAGE } from './args.js';

export function validateRepositoryRoot(repoRoot) {
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new RepositoryError(`not a Git repository: ${repoRoot}`);
  }
}

/**
 * Verify the branch expectation WITHOUT invoking Git: read `.git/HEAD` and
 * require it to point at `refs/heads/master`. A detached HEAD (a raw commit
 * SHA, as produced by GitHub Actions `actions/checkout`) is accepted only
 * when that commit is exactly what `refs/heads/master` resolves to locally
 * (loose ref or packed-refs) — the operations `commit:weekly` performs are
 * then identical to running them on the branch. Never changes branches.
 */
export function assertBranchMaster(repoRoot) {
  const gitDir = path.join(repoRoot, '.git');
  const headFile = path.join(gitDir, 'HEAD');
  let head;
  try {
    head = fs.readFileSync(headFile, 'utf8').trim();
  } catch {
    return; // no HEAD readable: nothing to enforce
  }
  if (head.endsWith('refs/heads/master')) return;
  if (/^[0-9a-f]{40}$/.test(head) && resolveMasterCommit(gitDir) === head) return;
  throw new RepositoryError(`weekly commit expects branch master; current HEAD: ${head}`);
}

/** Resolve `refs/heads/master` to a commit SHA from the loose ref or packed-refs. */
function resolveMasterCommit(gitDir) {
  try {
    const loose = fs.readFileSync(path.join(gitDir, 'refs', 'heads', 'master'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(loose)) return loose;
  } catch {
    // no loose ref; packed-refs may still have it
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const match = /^([0-9a-f]{40}) refs\/heads\/master$/.exec(line.trim());
      if (match) return match[1];
    }
  } catch {
    // no packed-refs
  }
  return null;
}

/**
 * Plan and apply one environment's weekly staged snapshot. Returns
 * `{ result, changed }` where `result` matches the public per-environment
 * shape and `changed` reports whether a new snapshot was committed.
 */
async function applyWeeklyEnvironment({
  environment,
  repoRoot,
  staged,
  doScan,
  doPlan,
  doCopy,
  logger,
}) {
  const existing = newestOf((await doScan({ repoRoot, environment })).snapshots);
  const stagedSnapshot = staged[environment] ?? null;
  const plan = doPlan({ existing, staged: stagedSnapshot });
  const result = {
    action: plan.action,
    reason: plan.reason,
    snapshotId: stagedSnapshot?.snapshotId ?? null,
  };
  if (plan.action === 'reject') {
    throw new RepositoryError(`weekly ${environment}: ${plan.reason}`);
  }
  if (plan.action === 'add') {
    const dest = await doCopy({
      stagingDir: stagedSnapshot.dir,
      repoRoot,
      environment,
      manifest: stagedSnapshot.manifest,
      snapshotId: stagedSnapshot.snapshotId,
    });
    result.dir = dest;
    logger.status(`weekly ${environment}: ${stagedSnapshot.snapshotId} committed (${plan.reason})`);
    return { result, changed: true };
  }
  logger.status(`weekly ${environment}: skipped (${plan.reason})`);
  return { result, changed: false };
}

/** Publish the machine-readable result to stdout and GITHUB_OUTPUT. */
function publishWeeklyResult({ env, stdOut, changed, results }) {
  stdOut.write(`weekly: changed=${changed}\n`);
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `weekly_changed=${changed}\n`);
  }
  return { changed, results };
}

/**
 * Plan and apply weekly staged snapshots for both environments.
 * Returns { changed, results: {environment: {action, reason, dir?}} }.
 */
export async function runWeeklyCommit({
  options,
  env = process.env,
  logger = createLogger({ stream: process.stderr }),
  deps = {},
} = {}) {
  const {
    doScan = scanRepositorySnapshots,
    doLoadStagedSnapshots = loadStagedSnapshots,
    doPlan = planWeekly,
    doCopy = copyStagedSnapshot,
    stdOut = process.stdout,
  } = deps;

  const { stagingDir, repoRoot } = options;
  validateRepositoryRoot(repoRoot);
  assertBranchMaster(repoRoot);

  const staged = await doLoadStagedSnapshots({ stagingDir, logger });
  const results = {};
  const createdDirs = [];
  let changedAny = false;
  try {
    for (const environment of ['development', 'production']) {
      const applied = await applyWeeklyEnvironment({
        environment,
        repoRoot,
        staged,
        doScan,
        doPlan,
        doCopy,
        logger,
      });
      if (applied.result.dir) createdDirs.push(applied.result.dir);
      results[environment] = applied.result;
      if (applied.changed) changedAny = true;
    }
  } catch (err) {
    // A later environment failure must not leave the repository partially
    // staged: remove every snapshot directory copied by this run.
    for (const dir of createdDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    throw err;
  }

  return publishWeeklyResult({ env, stdOut, changed: changedAny, results });
}

export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
  try {
    const parsed = parseCommitWeeklyArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${COMMIT_WEEKLY_USAGE}\n`);
      return 0;
    }
    await runWeeklyCommit({ options: parsed, logger });
    return 0;
  } catch (err) {
    logger.error(`commit-weekly failed: ${logger.redact(err.message ?? String(err))}`);
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
