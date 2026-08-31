/**
 * Dependency-neutral local-store layout and private-path policy tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_BACKUP_DIRECTORY_NAME,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  privateDirectoryProblem,
  privateSnapshotProblem,
  sortSnapshotsNewestFirst,
} from './local-store.js';

test('local-store: newest-first sort orders by descending snapshot id', () => {
  const newer = { snapshotId: '2026-08-24T03-17-11Z' };
  const mid = { snapshotId: '2026-08-24T03-17-09Z' };
  const older = { snapshotId: '2026-08-23T03-17-09Z' };
  assert.deepEqual(sortSnapshotsNewestFirst([older, newer, mid]), [newer, mid, older]);
  assert.deepEqual(sortSnapshotsNewestFirst([newer, older]), [newer, older]);
});

test('local-store: newest-first sort is stable for equal snapshot ids', () => {
  const a = { snapshotId: '2026-08-24T03-17-09Z', tag: 'a' };
  const b = { snapshotId: '2026-08-24T03-17-09Z', tag: 'b' };
  assert.deepEqual(sortSnapshotsNewestFirst([a, b]), [a, b]);
  assert.deepEqual(sortSnapshotsNewestFirst([b, a]), [b, a]);
});

test('local-store: newest-first sort handles an empty or single list', () => {
  assert.deepEqual(sortSnapshotsNewestFirst([]), []);
  assert.deepEqual(sortSnapshotsNewestFirst([{ snapshotId: 'x' }]), [{ snapshotId: 'x' }]);
});

test('local-store: constants and policy helpers are exported', () => {
  assert.equal(LOCAL_BACKUP_DIRECTORY_NAME, 'local-backups');
  assert.equal(PRIVATE_DIRECTORY_MODE, 0o700);
  assert.equal(PRIVATE_FILE_MODE, 0o600);
  assert.equal(typeof privateDirectoryProblem, 'function');
  assert.equal(typeof privateSnapshotProblem, 'function');
});
