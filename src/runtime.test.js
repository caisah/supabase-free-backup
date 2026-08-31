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
  // Older major version must be rejected.
  assert.throws(() => assertNodeVersion({ version: olderMajorVersion }), pinnedVersionPattern);
});

test('runtime preflight: same major/minor with older patch is rejected', () => {
  // Skip if pinned patch is 0 (can't create a valid older patch version)
  if (pinnedPatch === 0) return;
  const olderPatchVersion = `v${pinnedMajor}.${pinnedMinor}.${pinnedPatch - 1}`;
  assert.throws(() => assertNodeVersion({ version: olderPatchVersion }), pinnedVersionPattern);
});

test('runtime preflight: later patch version is accepted', () => {
  assert.equal(assertNodeVersion({ version: laterPatchVersion }), laterPatchVersion);
});

test('runtime preflight: later major version is accepted', () => {
  assert.equal(assertNodeVersion({ version: laterMajorVersion }), laterMajorVersion);
});

test('runtime preflight: error names both the required and the current version', () => {
  assert.throws(
    () => assertNodeVersion({ version: olderMajorVersion }),
    new RegExp(`>= ${REQUIRED_NODE_VERSION.replace('.', '\.')}`),
  );
  assert.throws(
    () => assertNodeVersion({ version: olderMajorVersion }),
    new RegExp(olderMajorVersion.replaceAll('.', '\.')),
  );
});

test('runtime preflight: Node pin agrees across every machine-readable pin source', () => {
  const pkg = JSON.parse(readFileSync(repoFile('package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(repoFile('package-lock.json'), 'utf8'));
  assert.equal(pkg.engines.node, pinnedVersion);
  assert.equal(lock.packages[''].engines.node, pinnedVersion);
});
