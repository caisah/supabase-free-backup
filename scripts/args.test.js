import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseBackupArgs,
  parseCommitWeeklyArgs,
  parseHostedRestoreArgs,
  parseHostedResetArgs,
  parseLocalBackupArgs,
  parseLocalResetArgs,
  BACKUP_USAGE,
  COMMIT_WEEKLY_USAGE,
  HOSTED_RESTORE_USAGE,
  HOSTED_RESET_USAGE,
  LOCAL_BACKUP_USAGE,
  LOCAL_RESET_USAGE,
} from './args.js';

const CWD = '/repo/root';
const ID = '2026-08-24T03-17-09Z';

const UNKNOWN_OPTION = (e) => e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
const MISSING_VALUE = (e) => e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE';
const POSITIONAL = (e) => e?.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';

test('args: usage text constants are the single CLI grammar', () => {
  assert.match(BACKUP_USAGE, /usage: vp run backup --environment/);
  assert.match(COMMIT_WEEKLY_USAGE, /usage: vp run commit:weekly --staging-dir/);
  assert.match(HOSTED_RESTORE_USAGE, /usage: vp run restore:development\|restore:production/);
  assert.match(HOSTED_RESET_USAGE, /usage: vp run reset:development\|reset:production/);
  assert.match(LOCAL_RESET_USAGE, /^usage: vp run reset:local$/);
});

test('args: backup parses the documented invocation with defaults', () => {
  assert.deepEqual(parseBackupArgs(['--environment', 'development'], { cwd: CWD }), {
    environment: 'development',
    stagingDir: null,
  });
  const parsed = parseBackupArgs(['--environment', 'production', '--staging-dir', 'cands'], {
    cwd: CWD,
  });
  assert.deepEqual(parsed, {
    environment: 'production',
    stagingDir: path.join(CWD, 'cands'),
  });
});

test('args: backup help forms', () => {
  assert.deepEqual(parseBackupArgs(['--help']), { help: true });
  assert.deepEqual(parseBackupArgs(['-h']), { help: true });
  assert.deepEqual(parseBackupArgs(['--environment', 'dev', '--help']), { help: true });
});

test('args: backup rejects malformed input', () => {
  assert.throws(() => parseBackupArgs([]), /--environment/);
  assert.throws(() => parseBackupArgs(['--environment']), MISSING_VALUE);
  assert.throws(() => parseBackupArgs(['--environment', 'staging']), /development or production/);
  assert.throws(() => parseBackupArgs(['--environment', 'development', '--bogus']), UNKNOWN_OPTION);
  assert.throws(() => parseBackupArgs(['--environment', 'development', 'extra']), POSITIONAL);
  assert.throws(() => parseBackupArgs(['--', '--environment', 'development']), POSITIONAL);
});

test('args: commit-weekly parses the documented invocation and defaults repoRoot to the parser cwd', () => {
  const parsed = parseCommitWeeklyArgs(['--staging-dir', 'cands'], { cwd: CWD });
  assert.deepEqual(parsed, {
    stagingDir: path.join(CWD, 'cands'),
    repoRoot: CWD,
  });
  const withRepo = parseCommitWeeklyArgs(['--staging-dir', '/abs/cands', '--repo-root', 'repo'], {
    cwd: CWD,
  });
  assert.deepEqual(withRepo, {
    stagingDir: '/abs/cands',
    repoRoot: path.join(CWD, 'repo'),
  });
});

test('args: commit-weekly help forms', () => {
  assert.deepEqual(parseCommitWeeklyArgs(['--help']), { help: true });
  assert.deepEqual(parseCommitWeeklyArgs(['-h']), { help: true });
});

test('args: commit-weekly rejects malformed input', () => {
  assert.throws(() => parseCommitWeeklyArgs([]), /--staging-dir/);
  assert.throws(() => parseCommitWeeklyArgs(['--staging-dir']), MISSING_VALUE);
  assert.throws(() => parseCommitWeeklyArgs(['--bogus']), UNKNOWN_OPTION);
  assert.throws(() => parseCommitWeeklyArgs(['--staging-dir', 'c', 'extra']), POSITIONAL);
  assert.throws(() => parseCommitWeeklyArgs(['--', '--staging-dir', 'c']), POSITIONAL);
});

test('args: backup rejects empty path option values', () => {
  // An empty shell variable must never silently resolve to the working
  // directory; staging emission would write into the repository itself.
  assert.throws(
    () => parseBackupArgs(['--environment', 'development', '--staging-dir', ''], { cwd: CWD }),
    /non-empty/,
  );
  assert.throws(
    () => parseBackupArgs(['--environment', 'development', '--staging-dir', '   '], { cwd: CWD }),
    /non-empty/,
  );
});

test('args: commit-weekly rejects empty path option values', () => {
  assert.throws(() => parseCommitWeeklyArgs(['--staging-dir', ''], { cwd: CWD }), /non-empty/);
  assert.throws(
    () => parseCommitWeeklyArgs(['--staging-dir', 'c', '--repo-root', '   '], { cwd: CWD }),
    /non-empty/,
  );
});

test('args: hosted restore parses the fixed target positional and flags', () => {
  assert.deepEqual(
    parseHostedRestoreArgs(['development', '--source', 'r2', '--backup', 'latest']),
    { target: 'development', source: 'r2', backup: 'latest' },
  );
  assert.deepEqual(parseHostedRestoreArgs(['production', '--source', 'repo', '--backup', ID]), {
    target: 'production',
    source: 'repo',
    backup: ID,
  });
});

test('args: hosted restore help forms do not require a target', () => {
  assert.deepEqual(parseHostedRestoreArgs(['--help']), { help: true });
  assert.deepEqual(parseHostedRestoreArgs(['development', '--help']), { help: true });
  assert.deepEqual(parseHostedRestoreArgs(['-h']), { help: true });
});

test('args: hosted restore accepts the local store source', () => {
  assert.deepEqual(
    parseHostedRestoreArgs(['development', '--source', 'local', '--backup', 'latest']),
    { target: 'development', source: 'local', backup: 'latest' },
  );
  assert.deepEqual(parseHostedRestoreArgs(['production', '--source', 'local', '--backup', ID]), {
    target: 'production',
    source: 'local',
    backup: ID,
  });
});

test('args: hosted restore rejects untrusted source values', () => {
  for (const source of ['s3', 'LOCAL', 'r2 repo', '', 'local/']) {
    assert.throws(
      () => parseHostedRestoreArgs(['development', '--source', source, '--backup', 'latest']),
      /r2\|repo\|local/,
      source,
    );
  }
});

test('args: hosted restore rejects missing, invalid, or duplicated targets', () => {
  assert.throws(() => parseHostedRestoreArgs([]), /development\|production/);
  assert.throws(
    () => parseHostedRestoreArgs(['staging', '--source', 'r2', '--backup', 'latest']),
    /development\|production/,
  );
  assert.throws(
    () =>
      parseHostedRestoreArgs(['development', 'production', '--source', 'r2', '--backup', 'latest']),
    POSITIONAL,
  );
});

test('args: hosted restore rejects malformed flags', () => {
  assert.throws(
    () => parseHostedRestoreArgs(['development', '--source', 's3', '--backup', 'latest']),
    /r2\|repo/,
  );
  assert.throws(() => parseHostedRestoreArgs(['development', '--backup', 'latest']), /--source/);
  assert.throws(() => parseHostedRestoreArgs(['development', '--source', 'r2']), /--backup/);
  assert.throws(
    () => parseHostedRestoreArgs(['development', '--source', 'r2', '--bogus', 'latest']),
    UNKNOWN_OPTION,
  );
  assert.throws(
    () => parseHostedRestoreArgs(['development', '--source', 'r2', '--backup']),
    MISSING_VALUE,
  );
  assert.throws(() => parseHostedRestoreArgs(['development', '--', '--source', 'r2']), POSITIONAL);
  // `--backup --help` is a missing value for --backup, never the help branch:
  // an unparsed substring check must not hijack option values.
  assert.throws(
    () => parseHostedRestoreArgs(['development', '--source', 'r2', '--backup', '--help']),
    MISSING_VALUE,
  );
});

test('args: hosted reset parses the fixed target positional only', () => {
  assert.deepEqual(parseHostedResetArgs(['development']), { target: 'development' });
  assert.deepEqual(parseHostedResetArgs(['production']), { target: 'production' });
});

test('args: hosted reset help forms do not require a target', () => {
  assert.deepEqual(parseHostedResetArgs(['--help']), { help: true });
  assert.deepEqual(parseHostedResetArgs(['development', '--help']), { help: true });
  assert.deepEqual(parseHostedResetArgs(['-h']), { help: true });
});

test('args: hosted reset rejects missing, invalid, or stray tokens before any external work', () => {
  assert.throws(() => parseHostedResetArgs([]), /development\|production/);
  assert.throws(() => parseHostedResetArgs(['staging']), /development\|production/);
  // No option exists on this command; every other token fails closed.
  assert.throws(() => parseHostedResetArgs(['development', 'production']), POSITIONAL);
  assert.throws(() => parseHostedResetArgs(['development', 'extra']), POSITIONAL);
  assert.throws(() => parseHostedResetArgs(['development', '--bogus']), UNKNOWN_OPTION);
  assert.throws(() => parseHostedResetArgs(['development', '--source', 'r2']), UNKNOWN_OPTION);
  assert.throws(() => parseHostedResetArgs(['development', '--', 'x']), POSITIONAL);
});

test('args: local reset parses the bare invocation', () => {
  // No options exist: the local stack is the single fixed development
  // identity; the only valid value is `{}` (or the help marker).
  assert.deepEqual(parseLocalResetArgs([]), {});
});

test('args: local reset help forms', () => {
  assert.deepEqual(parseLocalResetArgs(['--help']), { help: true });
  assert.deepEqual(parseLocalResetArgs(['-h']), { help: true });
});

test('args: local reset rejects every malformed-token form before any external work', () => {
  // No environment or target token exists on this command; everything
  // other than --help/-h is grammar-invalid and fails closed.
  assert.throws(() => parseLocalResetArgs(['development']), POSITIONAL);
  assert.throws(() => parseLocalResetArgs(['--environment', 'development']), UNKNOWN_OPTION);
  assert.throws(() => parseLocalResetArgs(['--bogus']), UNKNOWN_OPTION);
  assert.throws(() => parseLocalResetArgs(['--bogus', '--help']), UNKNOWN_OPTION);
  assert.throws(() => parseLocalResetArgs(['extra']), POSITIONAL);
  assert.throws(() => parseLocalResetArgs(['--', 'x']), POSITIONAL);
});

test('args: local backup parses the bare invocation', () => {
  // No options exist: the single local stack and the `local` store label are
  // fixed in the runner; the only valid value is `{}` (or the help marker).
  assert.deepEqual(parseLocalBackupArgs([]), {});
});

test('args: local backup help forms', () => {
  assert.deepEqual(parseLocalBackupArgs(['--help']), { help: true });
  assert.deepEqual(parseLocalBackupArgs(['-h']), { help: true });
});

test('args: local backup rejects every malformed-token form before any external work', () => {
  assert.match(LOCAL_BACKUP_USAGE, /^usage: vp run backup:local$/);
  // The old --environment option no longer exists; every token other than
  // --help/-h is grammar-invalid and fails closed (never a config error).
  assert.throws(() => parseLocalBackupArgs(['--environment']), UNKNOWN_OPTION);
  assert.throws(() => parseLocalBackupArgs(['--environment', 'development']), UNKNOWN_OPTION);
  assert.throws(() => parseLocalBackupArgs(['--environment', 'staging']), UNKNOWN_OPTION);
  assert.throws(() => parseLocalBackupArgs(['--bogus']), UNKNOWN_OPTION);
  // Strict parsing: an unknown option is rejected even when --help is present.
  assert.throws(() => parseLocalBackupArgs(['--bogus', '--help']), UNKNOWN_OPTION);
  assert.throws(() => parseLocalBackupArgs(['extra']), POSITIONAL);
  assert.throws(() => parseLocalBackupArgs(['--', '--environment', 'development']), POSITIONAL);
  // No output-path or other value option may be introduced on this command.
  assert.throws(() => parseLocalBackupArgs(['--out', '/tmp/x']), UNKNOWN_OPTION);
});
