import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseBackupArgs,
  parseCommitWeeklyArgs,
  parseHostedRestoreArgs,
  parseLocalRestoreArgs,
  parseLocalBackupArgs,
  BACKUP_USAGE,
  COMMIT_WEEKLY_USAGE,
  HOSTED_RESTORE_USAGE,
  LOCAL_RESTORE_USAGE,
  LOCAL_BACKUP_USAGE,
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
  assert.match(LOCAL_RESTORE_USAGE, /usage: vp run restore:local --environment/);
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

test('args: local restore still rejects the local source', () => {
  assert.throws(
    () =>
      parseLocalRestoreArgs([
        '--environment',
        'development',
        '--source',
        'local',
        '--backup',
        'latest',
      ]),
    /r2\|repo/,
  );
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

test('args: local backup parses the documented invocation for both environments', () => {
  assert.deepEqual(parseLocalBackupArgs(['--environment', 'development']), {
    environment: 'development',
  });
  assert.deepEqual(parseLocalBackupArgs(['--environment', 'production']), {
    environment: 'production',
  });
});

test('args: local backup help forms bypass required-value validation', () => {
  assert.deepEqual(parseLocalBackupArgs(['--help']), { help: true });
  assert.deepEqual(parseLocalBackupArgs(['-h']), { help: true });
  assert.deepEqual(parseLocalBackupArgs(['--environment', 'bad', '--help']), { help: true });
});

test('args: local backup rejects every malformed-token form before any external work', () => {
  assert.match(LOCAL_BACKUP_USAGE, /usage: vp run backup:local --environment/);
  assert.throws(() => parseLocalBackupArgs([]), /--environment/);
  assert.throws(() => parseLocalBackupArgs(['--environment']), MISSING_VALUE);
  assert.throws(
    () => parseLocalBackupArgs(['--environment', 'staging']),
    /development or production/,
  );
  assert.throws(() => parseLocalBackupArgs(['--bogus']), UNKNOWN_OPTION);
  assert.throws(
    () => parseLocalBackupArgs(['--environment', 'development', '--bogus']),
    UNKNOWN_OPTION,
  );
  assert.throws(() => parseLocalBackupArgs(['--environment', 'development', 'extra']), POSITIONAL);
  assert.throws(() => parseLocalBackupArgs(['--', '--environment', 'development']), POSITIONAL);
  // No output-path option may be introduced on this command.
  assert.throws(
    () => parseLocalBackupArgs(['--environment', 'development', '--out', '/tmp/x']),
    UNKNOWN_OPTION,
  );
});

test('args: local restore parses the documented invocation', () => {
  assert.deepEqual(
    parseLocalRestoreArgs(['--environment', 'development', '--source', 'r2', '--backup', 'latest']),
    { environment: 'development', source: 'r2', backup: 'latest' },
  );
  assert.deepEqual(
    parseLocalRestoreArgs(['--environment', 'production', '--source', 'repo', '--backup', ID]),
    { environment: 'production', source: 'repo', backup: ID },
  );
});

test('args: local restore help forms', () => {
  assert.deepEqual(parseLocalRestoreArgs(['--help']), { help: true });
  assert.deepEqual(parseLocalRestoreArgs(['-h']), { help: true });
});

test('args: local restore rejects malformed input', () => {
  assert.throws(() => parseLocalRestoreArgs([]), /requires --environment/);
  assert.throws(
    () => parseLocalRestoreArgs(['--environment', 'x', '--source', 'r2', '--backup', 'latest']),
    /development\|production/,
  );
  assert.throws(
    () =>
      parseLocalRestoreArgs([
        '--environment',
        'development',
        '--source',
        's3',
        '--backup',
        'latest',
      ]),
    /r2\|repo/,
  );
  assert.throws(
    () => parseLocalRestoreArgs(['--environment', 'development', '--source', 'r2']),
    /--backup/,
  );
  assert.throws(
    () => parseLocalRestoreArgs(['--environment', 'development', '--source', 'r2', '--bogus']),
    UNKNOWN_OPTION,
  );
  assert.throws(
    () => parseLocalRestoreArgs(['--environment', 'development', '--source', 'r2', 'extra']),
    POSITIONAL,
  );
  assert.throws(() => parseLocalRestoreArgs(['--', '--environment', 'development']), POSITIONAL);
});
