import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNodeVersion,
  currentNodeVersion,
  REQUIRED_NODE_VERSION,
  REQUIRED_NODE_VERSION_LABEL,
} from './runtime.js';

function repoFile(relativePath) {
  return new URL(`../${relativePath}`, import.meta.url);
}

// `.node-version` is the single source of truth for the Node pin; every
// expectation below derives from it so a pin bump never leaves stale
// hardcoded versions in the tests.
const pinnedVersion = readFileSync(repoFile('.node-version'), 'utf8').trim();
const pinnedVersionPattern = new RegExp(pinnedVersion.replaceAll('.', '\\.'));
const [pinnedMajor, pinnedMinor, pinnedPatch] = pinnedVersion.split('.').map(Number);
const olderMajorVersion = `v${pinnedMajor - 1}.${pinnedMinor}.${pinnedPatch}`;
const laterPatchVersion = `v${pinnedMajor}.${pinnedMinor}.${pinnedPatch + 1}`;
const laterMajorVersion = `v${pinnedMajor + 1}.1.0`;

test('runtime preflight: exact pinned version passes', () => {
  assert.equal(REQUIRED_NODE_VERSION, pinnedVersion);
  assert.equal(REQUIRED_NODE_VERSION_LABEL, `v${pinnedVersion}`);
  assert.equal(currentNodeVersion(), process.version);
  // Under the pinned runtime this must not throw.
  assertNodeVersion();
});

test('runtime preflight: older version is rejected', () => {
  // Different older major, mirroring the pre-pin-change boundary coverage.
  assert.throws(() => assertNodeVersion({ version: olderMajorVersion }), pinnedVersionPattern);
});

test('runtime preflight: unreviewed later release is rejected', () => {
  assert.throws(() => assertNodeVersion({ version: laterPatchVersion }), pinnedVersionPattern);
});

test('runtime preflight: error names both the required and the current version', () => {
  assert.throws(() => assertNodeVersion({ version: laterMajorVersion }), pinnedVersionPattern);
  assert.throws(
    () => assertNodeVersion({ version: laterMajorVersion }),
    new RegExp(laterMajorVersion.replaceAll('.', '\\.')),
  );
  assert.throws(
    () => assertNodeVersion({ version: laterMajorVersion }),
    /Supabase DB backup requires Node\.js/,
    'the version error must carry the canonical generic label',
  );
});

test('runtime preflight: Node pin agrees across every machine-readable pin source', () => {
  const pkg = JSON.parse(readFileSync(repoFile('package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(repoFile('package-lock.json'), 'utf8'));
  assert.equal(pkg.engines.node, pinnedVersion);
  assert.equal(lock.packages[''].engines.node, pinnedVersion);
});
