import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runConfigureGitHub,
  parseConfigureGitHubArgs,
  loadGitHubEnvironmentConfigs,
  resolveGhBin,
} from './configure-github.js';
import { loadBackupConfig, REPOSITORY_ROOT } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { ProcessError } from '../src/process.js';
import { tmpdir, writePrivateFile, AGE_RECIPIENT_1, AGE_IDENTITY_1 } from '../src/test-fixtures.js';

const REF_DEV = 'a1b2c3d4e5f6a7b8c9d0';
const REF_PROD = 'f0e9d8c7b6a5f4e3d2c1';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ACCESS_KEY = 'r2-access-key-1234567890';
const SECRET_KEY = 'r2-secret-key-abcdefghijklmnopqrstuv';
const AGE_RECIPIENT = AGE_RECIPIENT_1;
const AGE_IDENTITY = AGE_IDENTITY_1;
const WORKDIR = '/tmp/fragtrack-workdir';
const UNKNOWN_SENTINEL = 'unknown-sentinel-value-never-uploaded';
const CANONICAL = 'owner/canonical-repo';

function dbUrl(environment) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  return `postgresql://postgres.${ref}:env-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`;
}

/** All fixture values that must never appear outside stdin / never be uploaded. */
function sentinelValues(environment) {
  return [
    dbUrl(environment),
    'env-password',
    ACCESS_KEY,
    SECRET_KEY,
    AGE_IDENTITY,
    UNKNOWN_SENTINEL,
    environment === 'development' ? REF_DEV : REF_PROD,
    ACCOUNT_ID,
    AGE_RECIPIENT,
    WORKDIR,
  ];
}

function envFileValues(environment, overrides = {}) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  const merged = {
    BACKUP_ENVIRONMENT: environment,
    SUPABASE_PROJECT_REF: ref,
    SUPABASE_DB_URL: dbUrl(environment),
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    R2_BUCKET: environment,
    R2_ACCESS_KEY_ID: ACCESS_KEY,
    R2_SECRET_ACCESS_KEY: SECRET_KEY,
    ENCRYPT_KEY: AGE_RECIPIENT,
    DECRYPT_KEY: AGE_IDENTITY,
    PROJECT_WORKDIR: WORKDIR,
    SOME_UNKNOWN_KEY: UNKNOWN_SENTINEL,
    ...overrides,
  };
  // An explicit undefined override removes the key (simulates an absent field).
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[name];
  }
  return merged;
}

function writeEnvFile(root, environment, overrides = {}) {
  const values = envFileValues(environment, overrides);
  writePrivateFile(
    path.join(root, `.env.${environment}.local`),
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
  );
}

function writeEnvFiles(root, { development, production } = {}) {
  writeEnvFile(root, 'development', development ?? {});
  writeEnvFile(root, 'production', production ?? {});
}

/** Stub config used when the repository root must not be read from disk. */
function stubConfig(environment) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  return {
    environment,
    projectRef: ref,
    dbUrl: dbUrl(environment),
    accountId: ACCOUNT_ID,
    bucket: environment,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ageRecipient: AGE_RECIPIENT,
    ageIdentity: AGE_IDENTITY,
    fragtrackWorkdir: WORKDIR,
  };
}

function stubLoadConfig({ environment }) {
  return stubConfig(environment);
}

/**
 * Fake gh runner recording every invocation. `script` returns the fake
 * `{ stdout, stderr }` runCommand result; `failAt` makes call N reject.
 */
function makeGh({ view, environments = '', failAt } = {}) {
  const calls = [];
  const run = async (opts) => {
    calls.push({ args: opts.args, input: opts.input, cwd: opts.cwd });
    const index = calls.length - 1;
    if (failAt !== undefined && index === failAt) {
      throw new Error(`gh command failed (fake): ${opts.input ?? ''}`);
    }
    const [group, verb] = opts.args;
    if (group === 'repo' && verb === 'view') {
      return {
        stdout: view ?? JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }),
        stderr: '',
      };
    }
    if (group === 'api' && opts.args.some((a) => a.includes('/environments?'))) {
      return { stdout: environments, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, run };
}

function silentLogger() {
  return {
    addSecret() {
      return this;
    },
    status() {},
    warn() {},
    error() {},
    redact: (text) => text,
  };
}

function makeDeps(overrides = {}) {
  const gh = makeGh(overrides);
  return {
    deps: {
      loadConfig: overrides.loadConfig ?? loadBackupConfig,
      lookup: () => '/usr/local/bin/gh',
      run: gh.run,
    },
    calls: gh.calls,
    logger: silentLogger(),
  };
}

function capturingLogger() {
  const chunks = [];
  const logger = createLogger({
    stream: { write: (chunk) => chunks.push(String(chunk)) },
    isGitHubActions: false,
  });
  return { logger, output: () => chunks.join('') };
}

function expectedSetCalls(configs) {
  const calls = [];
  const values = [];
  for (const environment of ['development', 'production']) {
    for (const [name, value] of Object.entries(configs[environment].variables)) {
      calls.push(['variable', 'set', name, '--env', environment, '--repo', CANONICAL]);
      values.push(value);
    }
    for (const [name, value] of Object.entries(configs[environment].secrets)) {
      calls.push(['secret', 'set', name, '--env', environment, '--repo', CANONICAL]);
      values.push(value);
    }
  }
  return { calls, values };
}

function setCalls(calls) {
  return calls.filter((c) => c.args[0] === 'variable' || c.args[0] === 'secret');
}

function runCli(name, args) {
  const script = fileURLToPath(new URL('./' + name + '.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('github:configure: no arguments selects default repository resolution', () => {
  assert.deepEqual(parseConfigureGitHubArgs([]), { repository: null });
});

test('github:configure: one valid OWNER/REPO is accepted', () => {
  assert.deepEqual(parseConfigureGitHubArgs(['fragtrack/db']), { repository: 'fragtrack/db' });
});

test('github:configure: -h and --help return help', () => {
  assert.deepEqual(parseConfigureGitHubArgs(['-h']), { help: true });
  assert.deepEqual(parseConfigureGitHubArgs(['--help']), { help: true });
});

test('github:configure: rejects malformed positional arguments', () => {
  const bad = [
    ['owner'],
    ['/repo'],
    ['owner/'],
    ['owner//repo'],
    ['owner/repo/extra'],
    ['owner/re po'],
    ['ow ner/repo'],
    ['owner/repo '],
    ['--flag'],
    ['--'],
    ['-x'],
    ['owner/repo', 'other/repo'],
    [''],
  ];
  for (const argv of bad) {
    assert.throws(() => parseConfigureGitHubArgs(argv), /github:configure/, JSON.stringify(argv));
  }
});

test('github:configure: help returns without loading config or invoking gh', async () => {
  const { deps, calls } = makeDeps({
    loadConfig: () => {
      throw new Error('must not load config for help');
    },
  });
  const { logger } = capturingLogger();
  const result = await runConfigureGitHub({ argv: ['--help'], logger, deps });
  assert.deepEqual(result, { help: true });
  assert.equal(calls.length, 0);
  const resultShort = await runConfigureGitHub({ argv: ['-h'], logger, deps });
  assert.deepEqual(resultShort, { help: true });
  assert.equal(calls.length, 0);
});

test('github:configure: maps both environments to exactly the approved allowlists', () => {
  const root = tmpdir('cfg-gh-map-');
  writeEnvFiles(root);
  try {
    const configs = loadGitHubEnvironmentConfigs({ root, loadConfig: loadBackupConfig });
    for (const environment of ['development', 'production']) {
      assert.deepEqual(Object.keys(configs[environment].secrets).sort(), [
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'SUPABASE_DB_URL',
      ]);
      assert.deepEqual(Object.keys(configs[environment].variables).sort(), [
        'CLOUDFLARE_ACCOUNT_ID',
        'ENCRYPT_KEY',
        'R2_BUCKET',
        'SUPABASE_PROJECT_REF',
      ]);
      const flat = {
        ...configs[environment].secrets,
        ...configs[environment].variables,
      };
      assert.ok(!('DECRYPT_KEY' in flat), 'DECRYPT_KEY must not sync');
      assert.ok(!('BACKUP_ENVIRONMENT' in flat), 'BACKUP_ENVIRONMENT must not sync');
      assert.ok(!('PROJECT_WORKDIR' in flat), 'PROJECT_WORKDIR must not sync');
      assert.ok(!('SOME_UNKNOWN_KEY' in flat), 'unknown dotenv keys must not sync');
      assert.equal(configs[environment].secrets.SUPABASE_DB_URL, dbUrl(environment));
      assert.equal(configs[environment].secrets.R2_ACCESS_KEY_ID, ACCESS_KEY);
      assert.equal(configs[environment].secrets.R2_SECRET_ACCESS_KEY, SECRET_KEY);
      assert.equal(
        configs[environment].variables.SUPABASE_PROJECT_REF,
        environment === 'development' ? REF_DEV : REF_PROD,
      );
      assert.equal(configs[environment].variables.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID);
      assert.equal(configs[environment].variables.R2_BUCKET, environment);
      assert.equal(configs[environment].variables.ENCRYPT_KEY, AGE_RECIPIENT);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('github:configure: file values win over ambient process values', async () => {
  const root = tmpdir('cfg-gh-ambient-');
  writeEnvFiles(root);
  const ambientUrl = `postgresql://postgres.${REF_DEV}:ambient-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`;
  const previousUrl = process.env.SUPABASE_DB_URL;
  const previousKey = process.env.R2_SECRET_ACCESS_KEY;
  process.env.SUPABASE_DB_URL = ambientUrl;
  process.env.R2_SECRET_ACCESS_KEY = 'ambient-key-override-1234567890';
  try {
    const configs = loadGitHubEnvironmentConfigs({ root, loadConfig: loadBackupConfig });
    assert.equal(configs.development.secrets.SUPABASE_DB_URL, dbUrl('development'));
    assert.equal(configs.development.secrets.R2_SECRET_ACCESS_KEY, SECRET_KEY);
  } finally {
    if (previousUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = previousUrl;
    if (previousKey === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('github:configure: invalid local configuration rejects before any gh call', async () => {
  const cases = [
    { name: 'missing production file', development: {}, production: undefined },
    { name: 'missing approved field', development: { SUPABASE_DB_URL: undefined } },
    { name: 'wrong BACKUP_ENVIRONMENT', production: { BACKUP_ENVIRONMENT: 'development' } },
    { name: 'invalid bucket', development: { R2_BUCKET: 'staging' } },
    { name: 'project-ref/URL mismatch', development: { SUPABASE_PROJECT_REF: 'z'.repeat(20) } },
  ];
  for (const { name, development, production } of cases) {
    const root = tmpdir('cfg-gh-invalid-');
    if (production === undefined) {
      writeEnvFile(root, 'development', development ?? {});
    } else {
      writeEnvFile(root, 'development', development ?? {});
      writeEnvFile(root, 'production', production ?? {});
    }
    const { deps, calls } = makeDeps();
    try {
      await assert.rejects(
        () => runConfigureGitHub({ argv: [], root, deps }),
        (err) => {
          assert.equal(calls.length, 0, `${name}: no gh call before validation`);
          if (name === 'wrong BACKUP_ENVIRONMENT') assert.match(err.message, /BACKUP_ENVIRONMENT/);
          if (name === 'invalid bucket') assert.match(err.message, /R2_BUCKET/);
          if (name === 'project-ref/URL mismatch') assert.match(err.message, /SUPABASE_DB_URL/);
          for (const value of sentinelValues('development')) {
            assert.ok(!err.message.includes(value), `${name}: diagnostics never echo values`);
          }
          return true;
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('github:configure: default resolution runs gh repo view from REPOSITORY_ROOT without positional', async () => {
  const { deps, calls, logger } = makeDeps({ loadConfig: stubLoadConfig });
  await runConfigureGitHub({ argv: [], logger, deps });
  assert.deepEqual(calls[0].args, ['repo', 'view', '--json', 'nameWithOwner,isPrivate']);
  assert.equal(calls[0].cwd, REPOSITORY_ROOT);
});

test('github:configure: override is passed only to repo view; canonical name is used afterwards', async () => {
  const { deps, calls, logger } = makeDeps({ loadConfig: stubLoadConfig });
  await runConfigureGitHub({ argv: ['untrusted/override'], logger, deps });
  assert.deepEqual(calls[0].args, [
    'repo',
    'view',
    'untrusted/override',
    '--json',
    'nameWithOwner,isPrivate',
  ]);
  for (const call of calls.slice(1)) {
    assert.ok(!call.args.includes('untrusted/override'), 'override must never appear again');
    const flat = call.args.join(' ');
    assert.ok(!flat.includes('repos/untrusted/'), 'API paths use the canonical name only');
    assert.ok(flat.includes(CANONICAL), `canonical name used in: ${JSON.stringify(call.args)}`);
  }
});

test('github:configure: rejects malformed or non-private repository preflight responses', async () => {
  const badViews = [
    { stdout: 'not json', label: 'malformed JSON' },
    { stdout: JSON.stringify({ isPrivate: true }), label: 'missing canonical name' },
    {
      stdout: JSON.stringify({ nameWithOwner: '', isPrivate: true }),
      label: 'empty canonical name',
    },
    {
      stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: false }),
      label: 'non-private',
    },
  ];
  for (const { stdout, label } of badViews) {
    const { deps, calls } = makeDeps({ loadConfig: stubLoadConfig, view: stdout });
    await assert.rejects(
      () => runConfigureGitHub({ argv: [], deps }),
      /repository preflight failed/,
    );
    assert.equal(calls.length, 1, `${label}: stops before mutation`);
    const flat = calls[0].args.join(' ');
    assert.ok(
      !flat.includes('PUT') && !flat.includes('secret set') && !flat.includes('variable set'),
    );
  }
});

test('github:configure: rejects a missing gh executable before any command', async () => {
  const { logger } = capturingLogger();
  const gh = makeGh();
  const deps = {
    loadConfig: stubLoadConfig,
    lookup: () => null,
    run: gh.run,
  };
  await assert.rejects(() => runConfigureGitHub({ argv: [], logger, deps }), /gh/);
  assert.equal(gh.calls.length, 0);
});

test('github:configure: repository inspection failure stops before mutation', async () => {
  const { deps, calls } = makeDeps({ loadConfig: stubLoadConfig, failAt: 0 });
  await assert.rejects(() => runConfigureGitHub({ argv: [], deps }));
  assert.equal(calls.length, 1);
  assert.equal(setCalls(calls).length, 0);
});

test('github:configure: environment listing failure stops before mutation', async () => {
  const { deps, calls } = makeDeps({ loadConfig: stubLoadConfig, failAt: 1 });
  await assert.rejects(() => runConfigureGitHub({ argv: [], deps }));
  assert.equal(calls.length, 2);
  assert.equal(setCalls(calls).length, 0);
});

test('github:configure: environment list is paginated with per_page=100', async () => {
  const { deps, calls, logger } = makeDeps({
    loadConfig: stubLoadConfig,
    environments: 'development\n',
  });
  await runConfigureGitHub({ argv: [], logger, deps });
  const listCall = calls[1];
  assert.ok(listCall.args.includes('--paginate'));
  assert.ok(listCall.args.includes('--method'));
  assert.ok(listCall.args.includes('GET'));
  assert.ok(listCall.args.some((a) => a === `repos/${CANONICAL}/environments?per_page=100`));
  assert.ok(listCall.args.includes('--jq'));
  assert.ok(listCall.args.includes('.environments[].name'));
});

test('github:configure: creates both missing environments with PUT {} before any set', async () => {
  const { deps, calls, logger } = makeDeps({ loadConfig: stubLoadConfig, environments: '' });
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  assert.deepEqual(result.createdEnvironments, ['development', 'production']);
  const putCalls = calls.filter((c) => c.args.includes('PUT'));
  assert.equal(putCalls.length, 2);
  assert.deepEqual(putCalls[0].args, [
    'api',
    '--method',
    'PUT',
    `repos/${CANONICAL}/environments/development`,
    '--input',
    '-',
  ]);
  assert.deepEqual(putCalls[1].args, [
    'api',
    '--method',
    'PUT',
    `repos/${CANONICAL}/environments/production`,
    '--input',
    '-',
  ]);
  assert.equal(putCalls[0].input, '{}');
  assert.equal(putCalls[1].input, '{}');
  const setCalls_ = setCalls(calls);
  assert.equal(setCalls_.length, 14);
  assert.ok(calls.indexOf(putCalls[0]) < calls.indexOf(setCalls_[0]), 'PUTs happen before sets');
});

test('github:configure: existing environments are never sent to the create endpoint', async () => {
  const { deps, calls, logger } = makeDeps({
    loadConfig: stubLoadConfig,
    environments: 'development\nproduction\n',
  });
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  assert.deepEqual(result.createdEnvironments, []);
  assert.ok(!calls.some((c) => c.args.includes('PUT')), 'no create/update call for existing envs');
  assert.equal(setCalls(calls).length, 14);
});

test('github:configure: only the missing environment is created', async () => {
  const { deps, calls, logger } = makeDeps({
    loadConfig: stubLoadConfig,
    environments: 'production\n',
  });
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  assert.deepEqual(result.createdEnvironments, ['development']);
  const putCalls = calls.filter((c) => c.args.includes('PUT'));
  assert.equal(putCalls.length, 1);
  assert.ok(putCalls[0].args.some((a) => a.endsWith('/environments/development')));
  assert.ok(!putCalls[0].args.some((a) => a.endsWith('/environments/production')));
});

test('github:configure: fourteen upserts in deterministic environment/field order', async () => {
  const root = tmpdir('cfg-gh-order-');
  writeEnvFiles(root);
  const configs = loadGitHubEnvironmentConfigs({ root, loadConfig: loadBackupConfig });
  const { calls: expected, values } = expectedSetCalls(configs);
  const { deps, calls, logger } = makeDeps({ loadConfig: loadBackupConfig, root });
  await runConfigureGitHub({ argv: [], root, logger, deps });
  const setCalls_ = setCalls(calls);
  assert.equal(setCalls_.length, 14);
  for (let i = 0; i < 14; i += 1) {
    assert.deepEqual(setCalls_[i].args, expected[i], `call ${i}`);
    assert.equal(setCalls_[i].input, values[i], `stdin value ${i}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('github:configure: values travel only via stdin, never in arguments', async () => {
  const root = tmpdir('cfg-gh-stdin-');
  writeEnvFiles(root);
  const { deps, calls, logger } = makeDeps({ loadConfig: loadBackupConfig, root });
  await runConfigureGitHub({ argv: [], root, logger, deps });
  const setCalls_ = setCalls(calls);
  for (const call of setCalls_) {
    for (const value of sentinelValues(call.args[3])) {
      assert.ok(!call.args.includes(value), `${value} must not appear in args`);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('github:configure: uses secret/variable set, never --body or --env-file', async () => {
  const { deps, calls, logger } = makeDeps({ loadConfig: stubLoadConfig });
  await runConfigureGitHub({ argv: [], logger, deps });
  const setCalls_ = setCalls(calls);
  assert.ok(setCalls_.every((c) => c.args[0] === 'secret' || c.args[0] === 'variable'));
  assert.ok(setCalls_.every((c) => c.args[1] === 'set'));
  for (const call of setCalls_) {
    assert.ok(!call.args.includes('--body'), '--body would leak the value into argv');
    assert.ok(!call.args.includes('--env-file'), '--env-file is forbidden');
  }
});

test('github:configure: no invocation contains a delete operation', async () => {
  const { deps, calls, logger } = makeDeps({ loadConfig: stubLoadConfig });
  await runConfigureGitHub({ argv: [], logger, deps });
  for (const call of calls) {
    const flat = call.args.join(' ').toLowerCase();
    assert.ok(!flat.includes('delete'), `delete in ${JSON.stringify(call.args)}`);
    assert.ok(!flat.includes('DELETE'), `DELETE in ${JSON.stringify(call.args)}`);
  }
});

test('github:configure: write failure stops later writes, hides values, and rerun is safe', async () => {
  const root = tmpdir('cfg-gh-fail-');
  writeEnvFiles(root);
  const configs = loadGitHubEnvironmentConfigs({ root, loadConfig: loadBackupConfig });
  const { logger } = capturingLogger();
  // call 0: repo view, 1: env list, 2-3: PUTs, 4-7: dev variables, 8: first dev secret.
  const failing = makeDeps({ loadConfig: loadBackupConfig, root, environments: '', failAt: 8 });
  await assert.rejects(
    () => runConfigureGitHub({ argv: [], root, logger, deps: failing.deps }),
    (err) => {
      assert.equal(failing.calls.length, 9, 'no call after the failed write');
      const setCalls_ = setCalls(failing.calls);
      assert.equal(setCalls_.length, 5, 'only the four variables plus the failed secret ran');
      for (const value of [...sentinelValues('development'), ...sentinelValues('production')]) {
        assert.ok(!err.message.includes(value), `error must not contain ${value}`);
      }
      return true;
    },
  );
  const second = makeDeps({ loadConfig: loadBackupConfig, root, environments: '' });
  const result = await runConfigureGitHub({ argv: [], root, logger, deps: second.deps });
  assert.equal(second.calls.length, 18);
  assert.deepEqual(result.createdEnvironments, ['development', 'production']);
  assert.deepEqual(result.upserts, {
    development: { variables: 4, secrets: 3 },
    production: { variables: 4, secrets: 3 },
  });
  assert.deepEqual(configs.development.secrets.SUPABASE_DB_URL, dbUrl('development'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('github:configure: gh binary resolution covers Windows wrappers', () => {
  const lookup = (name) => (name === 'gh.cmd' ? '/c/gh.cmd' : null);
  assert.equal(resolveGhBin({ lookup, platform: 'win32' }), '/c/gh.cmd');
  assert.equal(resolveGhBin({ lookup, platform: 'linux' }), null);
  assert.equal(resolveGhBin({ lookup: () => '/usr/bin/gh', platform: 'linux' }), '/usr/bin/gh');
  const exe = (name) => (name === 'gh.exe' ? '/c/gh.exe' : null);
  assert.equal(resolveGhBin({ lookup: exe, platform: 'win32' }), '/c/gh.exe');
});

test('github:configure: Windows cmd wrapper is used end to end', async () => {
  const commands = [];
  const run = async (opts) => {
    commands.push(opts.command);
    if (opts.args.some((a) => a.includes('/environments?'))) {
      return { stdout: 'development\nproduction\n', stderr: '' };
    }
    return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
  };
  const { logger } = capturingLogger();
  await runConfigureGitHub({
    argv: [],
    logger,
    platform: 'win32',
    deps: {
      loadConfig: stubLoadConfig,
      lookup: (name) => ({ 'gh.cmd': '/c/gh.cmd' })[name] ?? null,
      run,
    },
  });
  assert.ok(commands.length > 0, 'gh must be invoked');
  assert.ok(
    commands.every((c) => c === '/c/gh.cmd'),
    `expected gh.cmd, got ${commands[0]}`,
  );
});

test('github:configure: a truncated environment listing fails closed', async () => {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts.args);
    if (opts.args.some((a) => a.includes('/environments?'))) {
      // stdout capture exceeded its bound; the tail marker carried over.
      return { stdout: '[stdout truncated] production', stderr: '' };
    }
    if (opts.args[1] === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(
    () =>
      runConfigureGitHub({
        argv: [],
        logger: silentLogger(),
        deps: { loadConfig: stubLoadConfig, lookup: () => '/gh', run },
      }),
    /capture limit/i,
  );
  const flat = calls.flat().join(' ');
  assert.ok(!flat.includes('PUT'), 'no environment create/update may run on a truncated listing');
  assert.ok(!flat.includes('secret set') && !flat.includes('variable set'));
});

test('github:configure: a stalled gh call is bounded by the timeout', async () => {
  const run = async (opts) => {
    if (opts.signal) {
      await new Promise((resolve) =>
        opts.signal.addEventListener('abort', resolve, { once: true }),
      );
    }
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(
    () =>
      runConfigureGitHub({
        argv: [],
        logger: silentLogger(),
        timeoutMs: 20,
        deps: { loadConfig: stubLoadConfig, lookup: () => '/gh', run },
      }),
    /timed out/i,
  );
});

test('github:configure: write failures never retain unredacted credentials in the error chain', async () => {
  const root = tmpdir('cfg-gh-chain-');
  writeEnvFiles(root);
  const run = async (opts) => {
    if (opts.args[1] === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
    }
    if (opts.args.some((a) => a.includes('/environments?'))) return { stdout: '', stderr: '' };
    if (opts.args.includes('PUT')) return { stdout: '', stderr: '' };
    if (opts.args[0] === 'variable' || opts.args[0] === 'secret') {
      throw new ProcessError({
        command: 'gh',
        exitCode: 1,
        redactedArgs: [],
        stderrTail: `gh failed for ${dbUrl('development')} (password env-password)`, // secret echoed
      });
    }
    return { stdout: '', stderr: '' };
  };
  const { logger } = capturingLogger();
  await assert.rejects(
    () =>
      runConfigureGitHub({
        argv: [],
        root,
        logger,
        deps: { loadConfig: loadBackupConfig, lookup: () => '/gh', run },
      }),
    (err) => {
      assert.ok(!err.message.includes(dbUrl('development')), 'message must not carry the URL');
      assert.ok(!err.message.includes('env-password'), 'message must not carry the password');
      const chain = [];
      for (let node = err; node; node = node.cause) {
        if (node && typeof node === 'object') {
          for (const key of ['message', 'stderrTail', 'command']) {
            if (typeof node[key] === 'string') chain.push(node[key]);
          }
        }
      }
      const serialized = JSON.stringify(chain);
      assert.ok(!serialized.includes(dbUrl('development')), 'cause chain must not carry the URL');
      assert.ok(!serialized.includes('env-password'), 'cause chain must not carry the password');
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('github:configure: result and status output contain no fixture values', async () => {
  const root = tmpdir('cfg-gh-output-');
  writeEnvFiles(root);
  const { logger, output } = capturingLogger();
  const { deps } = makeDeps({ loadConfig: loadBackupConfig, root });
  const result = await runConfigureGitHub({ argv: [], root, logger, deps });
  const text = output();
  assert.ok(text.includes(CANONICAL));
  assert.ok(text.includes('development'));
  assert.ok(text.includes('production'));
  assert.ok(text.includes('SUPABASE_DB_URL'));
  assert.ok(text.includes('R2_SECRET_ACCESS_KEY'));
  assert.ok(text.includes('ENCRYPT_KEY'));
  for (const value of [...sentinelValues('development'), ...sentinelValues('production')]) {
    assert.ok(!text.includes(value), `status must not contain ${value}`);
  }
  assert.deepEqual(result.upserts, {
    development: { variables: 4, secrets: 3 },
    production: { variables: 4, secrets: 3 },
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('github:configure: CLI entry point responds to --help', () => {
  const res = runCli('configure-github', ['--help']);
  assert.equal(res.status, 0, res.stderr.slice(0, 500));
  assert.ok(res.stdout.includes('usage: vp run github:configure'), res.stdout);
  assert.ok(/development and production/.test(res.stdout), res.stdout);
  assert.equal(res.stderr, '');
});
