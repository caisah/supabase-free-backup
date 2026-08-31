import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseWorkdirConfig, validateWorkdir, LocalStackError } from './local-stack.js';
import { tmpdir } from './test-fixtures.js';

const CONFIG_TOML = [
  'project_id = "fragtrack"',
  '',
  '[db]',
  'port = 54322',
  'shadow_port = 54320',
  'major_version = 17',
  '',
  '[db.pooler]',
  'enabled = false',
  '',
  '[api]',
  'port = 54321',
].join('\n');

function makeFragtrack(root) {
  const workdir = path.join(root, 'fragtrack');
  fs.mkdirSync(path.join(workdir, 'supabase'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workdir, 'supabase', 'config.toml'), CONFIG_TOML);
  return workdir;
}

test('local: workdir config parsing tolerates CRLF line endings', () => {
  // Git on Windows may check config.toml out with CRLF endings; parsing must
  // still find the [db] section, major version, port, and project id.
  const crlf = [
    'project_id = "fragtrack"',
    '',
    '[db]',
    'port = 54322',
    'major_version = 17',
    '',
  ].join('\r\n');
  const parsed = parseWorkdirConfig(crlf);
  assert.equal(parsed.projectId, 'fragtrack');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
});

test('local: workdir config parsing extracts project, version, and port', () => {
  const parsed = parseWorkdirConfig(CONFIG_TOML);
  assert.equal(parsed.projectId, 'fragtrack');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
  assert.equal(parseWorkdirConfig('[db]\nport = 5433\n').majorVersion, null);
});

test('local: workdir config section parsing tolerates EOF without a newline', () => {
  // A config whose [db] section is the LAST section and has NO trailing
  // newline must still parse: the old lookahead required `\n$`.
  const eof = ['project_id = "fragtrack"', '', '[db]', 'port = 54322', 'major_version = 17'].join(
    '\n',
  );
  const parsed = parseWorkdirConfig(eof);
  assert.equal(parsed.projectId, 'fragtrack');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
});

test('local: workdir config tolerates an inline comment on the [db] header', () => {
  const commented = [
    'project_id = "fragtrack"',
    '',
    '[db] # local database',
    'port = 54322',
    'major_version = 17',
    '',
    '[api]',
    'port = 54321',
  ].join('\n');
  const parsed = parseWorkdirConfig(commented);
  assert.equal(parsed.projectId, 'fragtrack');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
});

test('local: an absent [db] section still yields nulls, never a crash', () => {
  const noDb = ['project_id = "fragtrack"', '', '[api]', 'port = 54321'].join('\n');
  const parsed = parseWorkdirConfig(noDb);
  assert.equal(parsed.projectId, 'fragtrack');
  assert.equal(parsed.majorVersion, null);
  assert.equal(parsed.dbPort, null);
});

test('local: workdir validation accepts a real Fragtrack project and rejects bad targets', () => {
  const root = tmpdir('bp-local-');
  const workdir = makeFragtrack(root);

  const ok = validateWorkdir({ fragtrackWorkdir: workdir, repoRoot: root });
  assert.equal(ok.projectId, 'fragtrack');
  assert.equal(ok.dbContainer, 'supabase_db_fragtrack');
  assert.equal(ok.workdir, fs.realpathSync(workdir));

  // Missing directory.
  assert.throws(
    () => validateWorkdir({ fragtrackWorkdir: path.join(root, 'missing'), repoRoot: root }),
    (err) => err instanceof LocalStackError && /WORKDIR does not exist/.test(err.message),
  );
  // Missing config.
  fs.mkdirSync(path.join(root, 'bare'));
  assert.throws(
    () => validateWorkdir({ fragtrackWorkdir: path.join(root, 'bare'), repoRoot: root }),
    (err) => err instanceof LocalStackError && /config.toml/.test(err.message),
  );
  // The backup repository itself must not be the target.
  assert.throws(
    () => validateWorkdir({ fragtrackWorkdir: root, repoRoot: root }),
    (err) => err instanceof LocalStackError && /not this repository/.test(err.message),
  );
  // Wrong Postgres version.
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, 'supabase'), { recursive: true });
  fs.writeFileSync(
    path.join(other, 'supabase', 'config.toml'),
    CONFIG_TOML.replace('major_version = 17', 'major_version = 15'),
  );
  assert.throws(
    () => validateWorkdir({ fragtrackWorkdir: other, repoRoot: root }),
    (err) => err instanceof LocalStackError && /major version 17/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: a missing project_id is rejected before the container name is derived', () => {
  const root = tmpdir('bp-local-');
  const workdir = path.join(root, 'fragtrack');
  fs.mkdirSync(path.join(workdir, 'supabase'), { recursive: true });
  fs.writeFileSync(
    path.join(workdir, 'supabase', 'config.toml'),
    CONFIG_TOML.replace('project_id = "fragtrack"', '# project_id omitted'),
  );
  assert.throws(
    () => validateWorkdir({ fragtrackWorkdir: workdir, repoRoot: root }),
    (err) => err instanceof LocalStackError && /project_id/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});
