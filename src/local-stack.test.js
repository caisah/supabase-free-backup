import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseWorkdirConfig, validateWorkdir, LocalStackError } from './local-stack.js';
import { tmpdir } from './test-fixtures.js';

const CONFIG_TOML = [
  'project_id = "project"',
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

function makeProjectFixture(root, configToml = CONFIG_TOML) {
  const configDir = path.join(root, 'project', 'supabase');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(configPath, configToml);
  return { projectRoot: path.join(root, 'project'), configPath };
}

test('local: workdir config parsing accepts single-quoted and indented project_id entries', () => {
  // Valid TOML: literal single-quoted strings and leading indentation are
  // legal for top-level scalar keys; the parser must not depend on the
  // exact supabase-generated double-quoted, column-0 form.
  const singleQuoted = [
    "project_id = 'project'",
    '',
    '[db]',
    'port = 54322',
    'major_version = 17',
  ].join('\n');
  assert.equal(parseWorkdirConfig(singleQuoted).projectId, 'project');

  const indented = [
    '  project_id = "project"',
    '',
    '[db]',
    '  port = 54322',
    '  major_version = 17',
  ].join('\n');
  const parsed = parseWorkdirConfig(indented);
  assert.equal(parsed.projectId, 'project');
  assert.equal(parsed.dbPort, 54322);
  assert.equal(parsed.majorVersion, 17);
});

test('local: workdir config parsing ignores commented-out lookalikes inside the [db] section', () => {
  const commented = [
    'project_id = "project"',
    '',
    '[db]',
    '# port = 54399',
    '# major_version = 15',
    'port = 54322',
    'major_version = 17',
  ].join('\n');
  const parsed = parseWorkdirConfig(commented);
  assert.equal(parsed.projectId, 'project');
  assert.equal(parsed.dbPort, 54322, 'a commented-out port must not win');
  assert.equal(parsed.majorVersion, 17, 'a commented-out major_version must not win');
});

test('local: workdir config parsing tolerates CRLF line endings', () => {
  // Git on Windows may check config.toml out with CRLF endings; parsing must
  // still find the [db] section, major version, port, and project id.
  const crlf = [
    'project_id = "project"',
    '',
    '[db]',
    'port = 54322',
    'major_version = 17',
    '',
  ].join('\r\n');
  const parsed = parseWorkdirConfig(crlf);
  assert.equal(parsed.projectId, 'project');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
});

test('local: workdir config parsing extracts project, version, and port', () => {
  const parsed = parseWorkdirConfig(CONFIG_TOML);
  assert.equal(parsed.projectId, 'project');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
  assert.equal(parseWorkdirConfig('[db]\nport = 5433\n').majorVersion, null);
});

test('local: workdir config section parsing tolerates EOF without a newline', () => {
  // A config whose [db] section is the LAST section and has NO trailing
  // newline must still parse: the old lookahead required `\n$`.
  const eof = ['project_id = "project"', '', '[db]', 'port = 54322', 'major_version = 17'].join(
    '\n',
  );
  const parsed = parseWorkdirConfig(eof);
  assert.equal(parsed.projectId, 'project');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
});

test('local: workdir config tolerates an inline comment on the [db] header', () => {
  const commented = [
    'project_id = "project"',
    '',
    '[db] # local database',
    'port = 54322',
    'major_version = 17',
    '',
    '[api]',
    'port = 54321',
  ].join('\n');
  const parsed = parseWorkdirConfig(commented);
  assert.equal(parsed.projectId, 'project');
  assert.equal(parsed.majorVersion, 17);
  assert.equal(parsed.dbPort, 54322);
});

test('local: an absent [db] section still yields nulls, never a crash', () => {
  const noDb = ['project_id = "project"', '', '[api]', 'port = 54321'].join('\n');
  const parsed = parseWorkdirConfig(noDb);
  assert.equal(parsed.projectId, 'project');
  assert.equal(parsed.majorVersion, null);
  assert.equal(parsed.dbPort, null);
});

test('local: workdir validation canonicalizes the config file and derives the project root', () => {
  const root = tmpdir('bp-local-');
  fs.mkdirSync(path.join(root, 'repo'));
  const { projectRoot, configPath } = makeProjectFixture(root);

  const ok = validateWorkdir({ supabaseConfigPath: configPath, repoRoot: path.join(root, 'repo') });
  assert.equal(ok.projectId, 'project');
  assert.equal(ok.dbContainer, 'supabase_db_project');
  assert.equal(ok.workdir, fs.realpathSync(projectRoot));
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: workdir validation rejects missing, non-file, and wrongly located paths', () => {
  const root = tmpdir('bp-local-');
  fs.mkdirSync(path.join(root, 'repo'));
  const repoRoot = path.join(root, 'repo');
  const { projectRoot, configPath } = makeProjectFixture(root);

  // Missing file.
  assert.throws(
    () =>
      validateWorkdir({
        supabaseConfigPath: path.join(projectRoot, 'supabase', 'missing.toml'),
        repoRoot,
      }),
    (err) =>
      err instanceof LocalStackError && /SUPABASE_CONFIG_PATH does not exist/.test(err.message),
  );
  // The former directory-style value (the project directory) is not a file.
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: projectRoot, repoRoot }),
    (err) =>
      err instanceof LocalStackError && /SUPABASE_CONFIG_PATH is not a file/.test(err.message),
  );
  // A regular TOML file outside the exact supabase/config.toml layout.
  const loose = path.join(root, 'loose');
  fs.mkdirSync(loose);
  fs.writeFileSync(path.join(loose, 'config.toml'), CONFIG_TOML);
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: path.join(loose, 'config.toml'), repoRoot }),
    (err) =>
      err instanceof LocalStackError &&
      /SUPABASE_CONFIG_PATH must point to <project>\/supabase\/config\.toml/.test(err.message),
  );
  // The selected project root is the backup repository itself.
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: configPath, repoRoot: projectRoot }),
    (err) => err instanceof LocalStackError && /not this repository/.test(err.message),
  );
  // Wrong Postgres version.
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, 'supabase'), { recursive: true });
  const otherConfig = path.join(other, 'supabase', 'config.toml');
  fs.writeFileSync(otherConfig, CONFIG_TOML.replace('major_version = 17', 'major_version = 15'));
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: otherConfig, repoRoot }),
    (err) => err instanceof LocalStackError && /major version 17/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: this repository config is rejected as self-reference, also through a symlink', () => {
  const root = tmpdir('bp-local-');
  // The "repository" carries its own minimal supabase/config.toml.
  const ownConfigDir = path.join(root, 'supabase');
  fs.mkdirSync(ownConfigDir, { recursive: true });
  const ownConfig = path.join(ownConfigDir, 'config.toml');
  fs.writeFileSync(ownConfig, CONFIG_TOML);
  const message = /must point at the main project, not this repository/;

  // Direct selection of this repository's own config file.
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: ownConfig, repoRoot: root }),
    (err) => err instanceof LocalStackError && message.test(err.message),
  );
  // A symlinked path resolving into this repository's config is rejected by
  // canonical comparison, not by path matching.
  const aliasDir = path.join(root, 'alias');
  fs.mkdirSync(path.join(aliasDir, 'supabase'), { recursive: true });
  const aliasConfig = path.join(aliasDir, 'supabase', 'config.toml');
  fs.symlinkSync(ownConfig, aliasConfig);
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: aliasConfig, repoRoot: root }),
    (err) => err instanceof LocalStackError && message.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: a symlinked config.toml keeps the project root at the configured path, never the link target', () => {
  const root = tmpdir('bp-local-');
  fs.mkdirSync(path.join(root, 'repo'));
  const repoRoot = path.join(root, 'repo');
  // The real file lives in a shared config tree (e.g. ../shared-configs).
  const sharedRoot = path.join(root, 'shared-configs');
  const { projectRoot: sharedProject, configPath: sharedConfig } = makeProjectFixture(sharedRoot);
  // The configured path is the sibling project's own supabase/config.toml,
  // symlinked to the shared file (migrations stay in the sibling project).
  const { projectRoot, configPath } = makeProjectFixture(root);
  fs.rmSync(configPath);
  fs.symlinkSync(sharedConfig, configPath);

  const ok = validateWorkdir({ supabaseConfigPath: configPath, repoRoot });
  assert.equal(ok.projectId, 'project');
  assert.equal(
    ok.workdir,
    fs.realpathSync(projectRoot),
    'the derived workdir must be the configured project, not the symlink target dir',
  );
  assert.notEqual(ok.workdir, fs.realpathSync(sharedProject));
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: a symlink alias with a different name cannot bypass the layout contract', () => {
  const root = tmpdir('bp-local-');
  const { configPath } = makeProjectFixture(root);
  // A misnamed symlink resolving into <project>/supabase/config.toml must be
  // rejected on its CONFIGURED name, before canonicalization.
  const alias = path.join(root, 'custom-link.toml');
  fs.symlinkSync(configPath, alias);
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: alias, repoRoot: root }),
    (err) =>
      err instanceof LocalStackError &&
      /SUPABASE_CONFIG_PATH must point to <project>\/supabase\/config\.toml/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: a config nested inside the repository is rejected as self-reference', () => {
  const root = tmpdir('bp-local-');
  // tests/fixtures/project/supabase/config.toml INSIDE the backup repository.
  const nestedRoot = path.join(root, 'tests', 'fixtures', 'project');
  const { configPath } = makeProjectFixture(nestedRoot);
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: configPath, repoRoot: root }),
    (err) => err instanceof LocalStackError && /not this repository/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: a non-string config path fails as a LocalStackError, never a TypeError', () => {
  const root = tmpdir('bp-local-');
  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(
      () => validateWorkdir({ supabaseConfigPath: bad, repoRoot: root }),
      (err) =>
        err instanceof LocalStackError &&
        /SUPABASE_CONFIG_PATH must be a non-empty string/.test(err.message),
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: workdir errors report the variable name only, never the filesystem path', () => {
  const root = tmpdir('bp-local-');
  const missing = path.join(root, 'supabase', 'missing.toml');
  let err;
  try {
    validateWorkdir({ supabaseConfigPath: missing, repoRoot: root });
    assert.fail('expected a LocalStackError');
  } catch (caught) {
    err = caught;
  }
  assert.ok(err instanceof LocalStackError);
  assert.ok(!err.message.includes(root), 'absolute path leaked into the message');
  assert.ok(!err.message.includes('missing.toml'), 'config path leaked into the message');
  assert.equal(err.cause?.code, 'ENOENT', 'the original error must survive as the cause');
  fs.rmSync(root, { recursive: true, force: true });
});

test('local: a missing project_id or [db] port is rejected before the container name is derived', () => {
  const root = tmpdir('bp-local-');
  fs.mkdirSync(path.join(root, 'repo'));
  const repoRoot = path.join(root, 'repo');
  const noId = path.join(root, 'no-id');
  fs.mkdirSync(path.join(noId, 'supabase'), { recursive: true });
  const noIdConfig = path.join(noId, 'supabase', 'config.toml');
  fs.writeFileSync(
    noIdConfig,
    CONFIG_TOML.replace('project_id = "project"', '# project_id omitted'),
  );
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: noIdConfig, repoRoot }),
    (err) => err instanceof LocalStackError && /project_id/.test(err.message),
  );
  const noPort = path.join(root, 'no-port');
  fs.mkdirSync(path.join(noPort, 'supabase'), { recursive: true });
  const noPortConfig = path.join(noPort, 'supabase', 'config.toml');
  fs.writeFileSync(noPortConfig, CONFIG_TOML.replace('port = 54322\n', ''));
  assert.throws(
    () => validateWorkdir({ supabaseConfigPath: noPortConfig, repoRoot }),
    (err) => err instanceof LocalStackError && /\[db\] port/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});
