import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runConfigureGitHub,
  parseConfigureGitHubArgs,
  buildGitHubEnvironmentConfigs,
  resolveGhBin,
  GITHUB_SECRETS,
  GITHUB_VARIABLES,
} from './configure-github.js';
import { LEGACY_DB_URL_VARIABLE, REPOSITORY_ROOT } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { ProcessError } from '../src/process.js';
import { tmpdir, writePrivateFile, AGE_RECIPIENT_1, AGE_IDENTITY_1 } from '../src/test-fixtures.js';

const REF_DEV = 'a1b2c3d4e5f6a7b8c9d0';
const REF_PROD = 'f0e9d8c7b6a5f4e3d2c1';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ACCESS_KEY = 'abcd1234abcd1234abcd1234abcd1234';
const SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const AGE_RECIPIENT = AGE_RECIPIENT_1;
const AGE_IDENTITY = AGE_IDENTITY_1;
const CONFIG_PATH = '/tmp/main-project/supabase/config.toml';
const UNKNOWN_SENTINEL = 'unknown-sentinel-value-never-uploaded';
const CANONICAL = 'owner/canonical-repo';

function dbUrl(environment) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  return `postgresql://postgres.${ref}:env-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`;
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
    CONFIG_PATH,
  ];
}

/** Full validated doctor config shape for one environment. */
function stubConfig(environment) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  return {
    environment,
    projectRef: ref,
    sharedPoolerUrl: dbUrl(environment),
    accountId: ACCOUNT_ID,
    bucket: environment,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ageRecipient: AGE_RECIPIENT,
    ageIdentity: AGE_IDENTITY,
    backupsEnabled: 'true',
    supabaseConfigPath: CONFIG_PATH,
  };
}

function defaultDoctorConfigs() {
  return {
    development: stubConfig('development'),
    production: stubConfig('production'),
  };
}

/** Successful doctor result matching what the real runDoctor returns. */
function stubDoctorResult({
  configs = defaultDoctorConfigs(),
  environments = ['development', 'production'],
} = {}) {
  return { environments, configs, localEnvironment: 'development' };
}

/** Stub doctor recording every invocation; `overrides.fail` rejects. */
function stubDoctor(overrides = {}) {
  const calls = [];
  const doctor = async (opts) => {
    calls.push(opts);
    if (overrides.fail) throw new Error(overrides.failMessage ?? 'doctor failed (stub)');
    return stubDoctorResult(overrides);
  };
  return { doctor, calls };
}

/** Write dotenv fixtures ONLY when a test simulates the doctor reading them. */
function writeEnvFile(root, environment, overrides = {}) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  const values = {
    BACKUPS_ENABLED: 'true',
    BACKUP_ENVIRONMENT: environment,
    SUPABASE_PROJECT_REF: ref,
    SUPABASE_SHARED_POOLER_URL: dbUrl(environment),
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    R2_BUCKET: environment,
    R2_ACCESS_KEY_ID: ACCESS_KEY,
    R2_SECRET_ACCESS_KEY: SECRET_KEY,
    ENCRYPT_KEY: AGE_RECIPIENT,
    DECRYPT_KEY: AGE_IDENTITY,
    SUPABASE_CONFIG_PATH: CONFIG_PATH,
    SOME_UNKNOWN_KEY: UNKNOWN_SENTINEL,
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete values[name];
  }
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

/**
 * Fake gh runner recording every invocation. `script` returns the fake
 * `{ stdout, stderr }` runCommand result; `failAt` makes call N reject;
 * `secretInventory` maps environment -> secret name list for `secret list`.
 */
function makeGh({ view, environments = '', failAt, secretInventory = {} } = {}) {
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
    if (group === 'secret' && verb === 'list') {
      const env = opts.args[opts.args.indexOf('--env') + 1];
      const names = secretInventory[env] ?? [];
      return { stdout: JSON.stringify(names.map((name) => ({ name }))), stderr: '' };
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

/** Dependency builder: successful doctor by default, no filesystem reads. */
function makeDeps(overrides = {}) {
  const gh = makeGh(overrides);
  return {
    deps: {
      doctor: overrides.doctor ?? stubDoctor().doctor,
      buildConfigs: overrides.buildConfigs ?? buildGitHubEnvironmentConfigs,
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
  // The repository-level opt-in is upserted last, after both environments.
  calls.push(['variable', 'set', 'BACKUPS_ENABLED', '--repo', CANONICAL]);
  values.push('true');
  return { calls, values };
}

function setCalls(calls) {
  return calls.filter(
    (c) => c.args[0] === 'variable' || (c.args[0] === 'secret' && c.args[1] === 'set'),
  );
}

function runCli(name, args) {
  const script = fileURLToPath(new URL('./' + name + '.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('github:configure: no arguments selects default repository resolution', () => {
  assert.deepEqual(parseConfigureGitHubArgs([]), { repository: null });
});

test('github:configure: one valid OWNER/REPO is accepted', () => {
  assert.deepEqual(parseConfigureGitHubArgs(['acme/db']), { repository: 'acme/db' });
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

test('github:configure: help bypasses doctor and gh', async () => {
  const { deps, calls } = makeDeps({
    doctor: async () => {
      throw new Error('doctor must not run for help');
    },
  });
  const result = await runConfigureGitHub({ argv: ['--help'], logger: silentLogger(), deps });
  assert.deepEqual(result, { help: true });
  assert.equal(calls.length, 0);
  const resultShort = await runConfigureGitHub({ argv: ['-h'], logger: silentLogger(), deps });
  assert.deepEqual(resultShort, { help: true });
  assert.equal(calls.length, 0);
});

test('github:configure: buildGitHubEnvironmentConfigs maps exactly the approved allowlists', () => {
  const registered = [];
  const logger = {
    ...silentLogger(),
    addSecret(value) {
      registered.push(value);
    },
  };
  const { configs } = buildGitHubEnvironmentConfigs({
    validatedConfigs: defaultDoctorConfigs(),
    environments: ['development', 'production'],
    logger,
  });
  for (const environment of ['development', 'production']) {
    assert.deepEqual(Object.keys(configs[environment].secrets).sort(), [
      ...Object.keys(GITHUB_SECRETS).sort(),
    ]);
    assert.deepEqual(Object.keys(configs[environment].variables).sort(), [
      ...Object.keys(GITHUB_VARIABLES).sort(),
    ]);
    const flat = {
      ...configs[environment].secrets,
      ...configs[environment].variables,
    };
    assert.ok(!('DECRYPT_KEY' in flat), 'DECRYPT_KEY must not sync');
    assert.ok(!('BACKUP_ENVIRONMENT' in flat), 'BACKUP_ENVIRONMENT must not sync');
    assert.ok(!('BACKUPS_ENABLED' in flat), 'the environment opt-in must not sync');
    assert.ok(!('SUPABASE_CONFIG_PATH' in flat), 'SUPABASE_CONFIG_PATH must not sync');
    assert.ok(!('SOME_UNKNOWN_KEY' in flat), 'unknown dotenv keys must not sync');
    assert.ok(
      !('SUPABASE_DB_URL' in flat),
      'the legacy secret must never be upserted from the allowlist',
    );
    assert.equal(configs[environment].secrets.SUPABASE_SHARED_POOLER_URL, dbUrl(environment));
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
  // Uploaded secrets are registered BEFORE any gh call can fail.
  assert.ok(registered.includes(dbUrl('development')));
  assert.ok(registered.includes(dbUrl('production')));
  assert.ok(registered.includes(ACCESS_KEY));
  assert.ok(registered.includes(SECRET_KEY));
});

test('github:configure: the builder only maps environments the doctor checked', () => {
  const { environments, configs } = buildGitHubEnvironmentConfigs({
    validatedConfigs: defaultDoctorConfigs(),
    environments: ['production'],
  });
  assert.deepEqual(environments, ['production']);
  assert.ok(!('development' in configs));
  assert.equal(configs.production.variables.SUPABASE_PROJECT_REF, REF_PROD);
});

test('github:configure: doctor failure produces zero gh calls and zero mutations', async () => {
  const { deps, calls } = makeDeps({
    doctor: stubDoctor({ fail: true, failMessage: 'static doctor failure' }).doctor,
  });
  await assert.rejects(
    () => runConfigureGitHub({ argv: [], deps, logger: silentLogger() }),
    /static doctor failure/,
  );
  assert.equal(calls.length, 0);
});

test('github:configure: doctor runs exactly once before any gh call, with argv: []', async () => {
  const order = [];
  const gh = makeGh();
  const doctor = async (opts) => {
    order.push(['doctor', opts.argv]);
    return stubDoctorResult();
  };
  const run = async (opts) => {
    order.push(['gh', opts.args[0], opts.args[1]]);
    return gh.run(opts);
  };
  await runConfigureGitHub({
    argv: ['untrusted/override'],
    logger: silentLogger(),
    deps: {
      doctor,
      buildConfigs: buildGitHubEnvironmentConfigs,
      lookup: () => '/gh',
      run,
    },
  });
  assert.equal(order[0][0], 'doctor', 'doctor must precede the first gh call');
  assert.deepEqual(order[0][1], [], 'configure OWNER/REPO must never reach the doctor');
  assert.equal(order.filter(([kind]) => kind === 'doctor').length, 1);
  assert.ok(
    order.slice(1).every(([kind]) => kind === 'gh'),
    'no mutation before doctor',
  );
  assert.ok(
    order.slice(1).some(([, , verb]) => verb === 'view'),
    'the read-only repository preflight is the first gh call',
  );
});

test('github:configure: a warning-only doctor success proceeds to all uploads', async () => {
  const { deps, calls, logger } = makeDeps();
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  assert.equal(setCalls(calls).length, 15);
  assert.equal(result.backupsEnabled, true);
});

test('github:configure: uploads exactly the doctor-validated values even if dotenv files disappear afterward', async () => {
  const root = tmpdir('cfg-gh-noread-');
  writeEnvFiles(root);
  const validated = defaultDoctorConfigs();
  const doctor = async () => {
    // The doctor read the files once and returned validated in-memory
    // objects; the files then vanish. Configure must not reread them.
    fs.rmSync(root, { recursive: true, force: true });
    return stubDoctorResult({ configs: validated });
  };
  const { deps, calls } = makeDeps({ doctor });
  const result = await runConfigureGitHub({ argv: [], root, deps, logger: silentLogger() });
  assert.deepEqual(result.upserts, {
    development: { variables: 4, secrets: 3 },
    production: { variables: 4, secrets: 3 },
  });
  assert.equal(setCalls(calls).length, 15);
  const values = setCalls(calls).map((c) => c.input);
  assert.ok(values.includes(dbUrl('development')), 'development URL uploaded from memory');
  assert.ok(values.includes(dbUrl('production')), 'production URL uploaded from memory');
  assert.ok(values.includes(ACCESS_KEY));
  assert.ok(values.includes(SECRET_KEY));
  assert.ok(values.includes(AGE_RECIPIENT));
  assert.ok(values.includes(REF_DEV));
  assert.ok(values.includes(REF_PROD));
  assert.ok(!values.includes(AGE_IDENTITY), 'the private identity is never uploaded');
  assert.ok(!values.includes(CONFIG_PATH), 'the config path is never uploaded');
  assert.ok(!values.includes(UNKNOWN_SENTINEL), 'unknown fields are never uploaded');
});

test('github:configure: an empty doctor environment list fails before any gh call', async () => {
  const { deps, calls } = makeDeps({
    doctor: stubDoctor({ environments: [], configs: {} }).doctor,
  });
  await assert.rejects(
    () => runConfigureGitHub({ argv: [], deps, logger: silentLogger() }),
    /no \.env/,
  );
  assert.equal(calls.length, 0);
});

test('github:configure: default resolution runs gh repo view from REPOSITORY_ROOT without positional', async () => {
  const { deps, calls, logger } = makeDeps();
  await runConfigureGitHub({ argv: [], logger, deps });
  assert.deepEqual(calls[0].args, ['repo', 'view', '--json', 'nameWithOwner,isPrivate']);
  assert.equal(calls[0].cwd, REPOSITORY_ROOT);
});

test('github:configure: override is passed only to repo view; canonical name is used afterwards', async () => {
  const { deps, calls, logger } = makeDeps();
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
    const { deps, calls } = makeDeps({ view: stdout });
    await assert.rejects(
      () => runConfigureGitHub({ argv: [], deps, logger: silentLogger() }),
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
  const gh = makeGh();
  const deps = {
    doctor: stubDoctor().doctor,
    buildConfigs: buildGitHubEnvironmentConfigs,
    lookup: () => null,
    run: gh.run,
  };
  await assert.rejects(() => runConfigureGitHub({ argv: [], logger: silentLogger(), deps }), /gh/);
  assert.equal(gh.calls.length, 0);
});

test('github:configure: repository inspection failure stops before mutation', async () => {
  const { deps, calls } = makeDeps({ failAt: 0 });
  await assert.rejects(() => runConfigureGitHub({ argv: [], deps, logger: silentLogger() }));
  assert.equal(calls.length, 1);
  assert.equal(setCalls(calls).length, 0);
});

test('github:configure: environment listing failure stops before mutation', async () => {
  const { deps, calls } = makeDeps({ failAt: 1 });
  await assert.rejects(() => runConfigureGitHub({ argv: [], deps, logger: silentLogger() }));
  assert.equal(calls.length, 2);
  assert.equal(setCalls(calls).length, 0);
});

test('github:configure: environment list is paginated with per_page=100', async () => {
  const { deps, calls, logger } = makeDeps({ environments: 'development\n' });
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
  const { deps, calls, logger } = makeDeps({ environments: '' });
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
  assert.equal(setCalls_.length, 15);
  assert.ok(calls.indexOf(putCalls[0]) < calls.indexOf(setCalls_[0]), 'PUTs happen before sets');
});

test('github:configure: existing environments are never sent to the create endpoint', async () => {
  const { deps, calls, logger } = makeDeps({ environments: 'development\nproduction\n' });
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  assert.deepEqual(result.createdEnvironments, []);
  assert.ok(!calls.some((c) => c.args.includes('PUT')), 'no create/update call for existing envs');
  assert.equal(setCalls(calls).length, 15);
});

test('github:configure: only the missing environment is created', async () => {
  const { deps, calls, logger } = makeDeps({ environments: 'production\n' });
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  assert.deepEqual(result.createdEnvironments, ['development']);
  const putCalls = calls.filter((c) => c.args.includes('PUT'));
  assert.equal(putCalls.length, 1);
  assert.ok(putCalls[0].args.some((a) => a.endsWith('/environments/development')));
  assert.ok(!putCalls[0].args.some((a) => a.endsWith('/environments/production')));
});

test('github:configure: fifteen upserts in deterministic environment/field order', async () => {
  const { deps, calls, logger } = makeDeps();
  const { configs } = buildGitHubEnvironmentConfigs({
    validatedConfigs: defaultDoctorConfigs(),
    environments: ['development', 'production'],
  });
  const { calls: expected, values } = expectedSetCalls(configs);
  await runConfigureGitHub({ argv: [], logger, deps });
  const setCalls_ = setCalls(calls);
  assert.equal(setCalls_.length, 15);
  for (let i = 0; i < 15; i += 1) {
    assert.deepEqual(setCalls_[i].args, expected[i], `call ${i}`);
    assert.equal(setCalls_[i].input, values[i], `stdin value ${i}`);
  }
});

test('github:configure: values travel only via stdin, never in arguments', async () => {
  const { deps, calls, logger } = makeDeps();
  await runConfigureGitHub({ argv: [], logger, deps });
  const setCalls_ = setCalls(calls);
  for (const call of setCalls_) {
    for (const value of sentinelValues(call.args[3])) {
      assert.ok(!call.args.includes(value), `${value} must not appear in args`);
    }
  }
});

test('github:configure: uses secret/variable set, never --body or --env-file', async () => {
  const { deps, calls, logger } = makeDeps();
  await runConfigureGitHub({ argv: [], logger, deps });
  const setCalls_ = setCalls(calls);
  assert.ok(setCalls_.every((c) => c.args[0] === 'secret' || c.args[0] === 'variable'));
  assert.ok(setCalls_.every((c) => c.args[1] === 'set'));
  for (const call of setCalls_) {
    assert.ok(!call.args.includes('--body'), '--body would leak the value into argv');
    assert.ok(!call.args.includes('--env-file'), '--env-file is forbidden');
  }
});

test('github:configure: no delete call when no legacy secret is inventoried', async () => {
  const { deps, calls } = makeDeps({ environments: 'development\nproduction\n' });
  await runConfigureGitHub({ argv: [], logger: silentLogger(), deps });
  const deleteCalls = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'delete');
  assert.equal(deleteCalls.length, 0, 'absent legacy secrets must not be deleted');
});

test('github:configure: only the fixed legacy secret is ever deleted, at Environment scope, after every env upsert', async () => {
  const { deps, calls } = makeDeps({
    environments: 'development\nproduction\n',
    secretInventory: {
      development: ['SUPABASE_DB_URL'],
      production: ['SUPABASE_DB_URL', 'R2_ACCESS_KEY_ID'],
    },
  });
  const result = await runConfigureGitHub({ argv: [], logger: silentLogger(), deps });
  const deleteCalls = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'delete');
  assert.equal(deleteCalls.length, 2);
  for (const call of deleteCalls) {
    assert.equal(
      call.args[2],
      LEGACY_DB_URL_VARIABLE,
      'deletion must target exactly the config legacy variable constant',
    );
    assert.ok(call.args.includes('--env'), 'deletion must be Environment-scoped');
    assert.ok(call.args.includes('--repo'));
    assert.ok(call.args.includes(CANONICAL));
  }
  assert.equal(deleteCalls[0].args[4], 'development');
  assert.equal(deleteCalls[1].args[4], 'production');
  const setCalls_ = setCalls(calls);
  assert.equal(setCalls_.length, 15);
  const lastEnvUpsert = setCalls_[setCalls_.length - 2];
  for (const dc of deleteCalls) {
    assert.ok(
      calls.indexOf(dc) > calls.indexOf(lastEnvUpsert),
      'every deletion must come after all fourteen environment upserts',
    );
  }
  assert.ok(
    calls.indexOf(setCalls_[setCalls_.length - 1]) > calls.indexOf(deleteCalls[1]),
    'the BACKUPS_ENABLED opt-in must come after every deletion',
  );
  assert.deepEqual(result.legacySecretDeletions, { development: true, production: true });
  assert.equal(result.backupsEnabled, true);
});

test('github:configure: sets the repository-level BACKUPS_ENABLED opt-in last', async () => {
  const { deps, calls, logger } = makeDeps({
    environments: 'development\nproduction\n',
    secretInventory: { development: ['SUPABASE_DB_URL'], production: ['SUPABASE_DB_URL'] },
  });
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  const optIns = calls.filter((c) => c.args[2] === 'BACKUPS_ENABLED');
  assert.equal(optIns.length, 1);
  assert.deepEqual(
    optIns[0].args,
    ['variable', 'set', 'BACKUPS_ENABLED', '--repo', CANONICAL],
    'repository scope: no --env flag',
  );
  assert.equal(optIns[0].input, 'true');
  const deletions = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'delete');
  assert.equal(deletions.length, 2);
  assert.ok(
    calls.indexOf(optIns[0]) > calls.indexOf(deletions[deletions.length - 1]),
    'the opt-in is set after every legacy-secret deletion',
  );
  assert.ok(
    calls.indexOf(optIns[0]) > calls.indexOf(setCalls(calls)[setCalls(calls).length - 2]),
    'the opt-in is set after every environment upsert',
  );
  assert.equal(result.backupsEnabled, true);
});

test('github:configure: secret inventory uses --env, --repo, and --json name with the canonical repository', async () => {
  const { deps, calls } = makeDeps({ environments: 'development\nproduction\n' });
  await runConfigureGitHub({ argv: [], logger: silentLogger(), deps });
  const listCalls = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'list');
  assert.equal(listCalls.length, 2);
  assert.deepEqual(listCalls[0].args, [
    'secret',
    'list',
    '--env',
    'development',
    '--repo',
    CANONICAL,
    '--json',
    'name',
  ]);
  assert.deepEqual(listCalls[1].args, [
    'secret',
    'list',
    '--env',
    'production',
    '--repo',
    CANONICAL,
    '--json',
    'name',
  ]);
});

test('github:configure: inventory completes for every existing environment before any mutation', async () => {
  const order = [];
  const run = async (opts) => {
    const [group] = opts.args;
    if (group === 'repo') order.push('view');
    else if (group === 'secret' && opts.args[1] === 'list') {
      order.push(`list:${opts.args[opts.args.indexOf('--env') + 1]}`);
    } else if (group === 'secret' && opts.args[1] === 'delete') order.push('delete');
    else if (group === 'secret' || group === 'variable') order.push('set');
    else if (opts.args.includes('PUT')) order.push('PUT');
    else order.push('envlist');
    if (group === 'repo') {
      return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
    }
    if (opts.args.some((a) => a.includes('/environments?'))) {
      return { stdout: 'development\nproduction\n', stderr: '' };
    }
    if (group === 'secret' && opts.args[1] === 'list') {
      return { stdout: JSON.stringify([{ name: 'SUPABASE_DB_URL' }]), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const result = await runConfigureGitHub({
    argv: [],
    logger: silentLogger(),
    deps: {
      doctor: stubDoctor().doctor,
      buildConfigs: buildGitHubEnvironmentConfigs,
      lookup: () => '/gh',
      run,
    },
  });
  const listIndexes = order.map((o, i) => (o.startsWith('list:') ? i : -1)).filter((i) => i !== -1);
  assert.deepEqual(listIndexes, [2, 3], `inventory must precede mutation: ${order.join(', ')}`);
  const firstMutation = order.findIndex((o) => o === 'PUT' || o === 'set' || o === 'delete');
  assert.ok(
    listIndexes.every((i) => i < firstMutation),
    'all inventory must complete before any mutation',
  );
  const firstDelete = order.indexOf('delete');
  const lastEnvSet = order.lastIndexOf('set', firstDelete);
  assert.ok(firstDelete > lastEnvSet, 'deletion must follow every environment upsert');
  assert.equal(order[order.length - 1], 'set', 'the repository opt-in is set last');
  assert.deepEqual(result.legacySecretDeletions, { development: true, production: true });
});

test('github:configure: inventory failure causes zero mutation', async () => {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts.args);
    if (opts.args[0] === 'repo' && opts.args[1] === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
    }
    if (opts.args.some((a) => a.includes('/environments?'))) {
      return { stdout: 'development\n', stderr: '' };
    }
    if (opts.args[0] === 'secret' && opts.args[1] === 'list') {
      throw new Error('gh secret list failed');
    }
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(
    () =>
      runConfigureGitHub({
        argv: [],
        logger: silentLogger(),
        deps: {
          doctor: stubDoctor().doctor,
          buildConfigs: buildGitHubEnvironmentConfigs,
          lookup: () => '/gh',
          run,
        },
      }),
    /gh secret list failed/,
  );
  const flat = calls.flat().join(' ');
  assert.ok(!flat.includes('PUT'), 'no environment creation may run');
  assert.ok(!flat.includes('secret set') && !flat.includes('variable set'), 'no upserts may run');
  assert.ok(!flat.includes('secret delete'), 'no deletion may run');
});

test('github:configure: malformed or truncated secret inventory fails closed before mutation', async () => {
  for (const bad of ['not json', '[stdout truncated] development', '{"name":"x"}']) {
    const calls = [];
    const run = async (opts) => {
      calls.push(opts.args);
      if (opts.args[0] === 'repo' && opts.args[1] === 'view') {
        return {
          stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }),
          stderr: '',
        };
      }
      if (opts.args.some((a) => a.includes('/environments?'))) {
        return { stdout: 'development\n', stderr: '' };
      }
      if (opts.args[0] === 'secret' && opts.args[1] === 'list') {
        return { stdout: bad, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    await assert.rejects(
      () =>
        runConfigureGitHub({
          argv: [],
          logger: silentLogger(),
          deps: {
            doctor: stubDoctor().doctor,
            buildConfigs: buildGitHubEnvironmentConfigs,
            lookup: () => '/gh',
            run,
          },
        }),
      /github configuration failed/,
      bad,
    );
    const flat = calls.flat().join(' ');
    assert.ok(
      !flat.includes('PUT') && !flat.includes('secret set') && !flat.includes('secret delete'),
      bad,
    );
  }
});

test('github:configure: one upsert failure leaves every legacy secret untouched', async () => {
  const { deps, calls } = makeDeps({
    environments: 'development\nproduction\n',
    secretInventory: { development: ['SUPABASE_DB_URL'], production: ['SUPABASE_DB_URL'] },
    failAt: 6, // a variable upsert (after view, env list, and the two inventories)
  });
  await assert.rejects(() => runConfigureGitHub({ argv: [], logger: silentLogger(), deps }));
  const deleteCalls = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'delete');
  assert.equal(deleteCalls.length, 0, 'no deletion may run after a failed upsert');
  assert.ok(
    !calls.flat().join(' ').includes('BACKUPS_ENABLED'),
    'a failed upsert must never enable backups',
  );
});

test('github:configure: newly created environments are never probed or deleted as if they had a legacy secret', async () => {
  const { deps, calls } = makeDeps({
    environments: 'production\n', // only production exists
    secretInventory: { production: ['SUPABASE_DB_URL'] },
  });
  const result = await runConfigureGitHub({ argv: [], logger: silentLogger(), deps });
  assert.deepEqual(result.createdEnvironments, ['development']);
  const listCalls = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'list');
  assert.equal(listCalls.length, 1, 'only the pre-existing environment is inventoried');
  assert.ok(listCalls[0].args.includes('production'), 'the created environment is not probed');
  const deleteCalls = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'delete');
  assert.equal(deleteCalls.length, 1, 'only production had an inventoried legacy secret');
  assert.ok(deleteCalls[0].args.includes('production'));
  assert.deepEqual(result.legacySecretDeletions, { development: false, production: true });
});

test('github:configure: rerun after a failed partial deletion deletes only the remaining secret', async () => {
  const legacy = 'SUPABASE_DB_URL';
  const state = {
    development: new Set([legacy]),
    production: new Set([legacy]),
  };
  let firstRun = true;
  const run = async (opts) => {
    const [group, verb] = opts.args;
    const env = opts.args[opts.args.indexOf('--env') + 1];
    if (group === 'repo' && verb === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
    }
    if (opts.args.some((a) => a.includes('/environments?'))) {
      return { stdout: 'development\nproduction\n', stderr: '' };
    }
    if (group === 'secret' && verb === 'list') {
      return { stdout: JSON.stringify([...state[env]].map((name) => ({ name }))), stderr: '' };
    }
    if (group === 'secret' && verb === 'delete') {
      // First run: development deletion succeeds, production fails, so the
      // production secret survives the run.
      if (firstRun && env === 'production') {
        throw new Error('fake deletion failure');
      }
      if (state[env].has(legacy)) {
        state[env].delete(legacy);
      }
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const deps = {
    doctor: stubDoctor().doctor,
    buildConfigs: buildGitHubEnvironmentConfigs,
    lookup: () => '/gh',
    run,
  };
  await assert.rejects(() => runConfigureGitHub({ argv: [], logger: silentLogger(), deps }));
  assert.ok(state.development.size === 0, 'development legacy secret deleted by the first run');
  assert.ok(state.production.size === 1, 'production legacy secret survives the first run');
  // Rerun: fresh inventory shows only production still has the legacy secret.
  firstRun = false;
  const second = await runConfigureGitHub({ argv: [], logger: silentLogger(), deps });
  assert.deepEqual(second.legacySecretDeletions, { development: false, production: true });
  assert.ok(state.production.size === 0, 'rerun deletes the remaining legacy secret');
});

test('github:configure: a deletion failure is redacted and stops later deletions', async () => {
  let deleteCalls = 0;
  const run = async (opts) => {
    if (opts.args[1] === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
    }
    if (opts.args.some((a) => a.includes('/environments?'))) {
      return { stdout: 'development\nproduction\n', stderr: '' };
    }
    if (opts.args[0] === 'secret' && opts.args[1] === 'list') {
      return { stdout: JSON.stringify([{ name: 'SUPABASE_DB_URL' }]), stderr: '' };
    }
    if (opts.args[0] === 'secret' && opts.args[1] === 'delete') {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        throw new ProcessError({
          command: 'gh',
          exitCode: 1,
          redactedArgs: [],
          stderrTail: `delete failed for ${dbUrl('development')} (password env-password)`,
        });
      }
    }
    return { stdout: '', stderr: '' };
  };
  const { logger } = capturingLogger();
  await assert.rejects(
    () =>
      runConfigureGitHub({
        argv: [],
        logger,
        deps: {
          doctor: stubDoctor().doctor,
          buildConfigs: buildGitHubEnvironmentConfigs,
          lookup: () => '/gh',
          run,
        },
      }),
    (err) => {
      assert.ok(!err.message.includes(dbUrl('development')), 'message must not carry the URL');
      assert.ok(!err.message.includes('env-password'), 'message must not carry the password');
      assert.match(err.message, /SUPABASE_DB_URL delete on development/);
      return true;
    },
  );
  assert.equal(deleteCalls, 1, 'a failed deletion stops later deletions');
});

test('github:configure: write failure stops later writes, hides values, and rerun is safe', async () => {
  const { logger } = capturingLogger();
  // call 0: repo view, 1: env list, 2-3: PUTs, 4-7: dev variables, 8: first dev secret.
  const failing = makeDeps({ environments: '', failAt: 8 });
  await assert.rejects(
    () => runConfigureGitHub({ argv: [], logger, deps: failing.deps }),
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
  const second = makeDeps({ environments: '' });
  const result = await runConfigureGitHub({ argv: [], logger, deps: second.deps });
  assert.equal(second.calls.length, 19);
  assert.deepEqual(result.createdEnvironments, ['development', 'production']);
  assert.deepEqual(result.upserts, {
    development: { variables: 4, secrets: 3 },
    production: { variables: 4, secrets: 3 },
  });
  assert.equal(result.backupsEnabled, true);
  assert.deepEqual(defaultDoctorConfigs().development.sharedPoolerUrl, dbUrl('development'));
});

test('github:configure: gh binary resolution covers Windows wrappers', () => {
  const lookup = (name) => (name === 'gh.cmd' ? '/c/gh.cmd' : null);
  assert.equal(resolveGhBin({ lookup, platform: 'win32' }), '/c/gh.cmd');
  assert.equal(resolveGhBin({ lookup, platform: 'linux' }), null);
  assert.equal(resolveGhBin({ lookup: () => '/usr/bin/gh', platform: 'linux' }), '/usr/bin/gh');
  const exe = (name) => (name === 'gh.exe' ? '/c/gh.exe' : null);
  assert.equal(resolveGhBin({ lookup: exe, platform: 'win32' }), '/c/gh.exe');
});

test('github:configure: Windows cmd wrapper is used end to end for list, set, and delete', async () => {
  const commands = [];
  const run = async (opts) => {
    commands.push(opts.command);
    if (opts.args.some((a) => a.includes('/environments?'))) {
      return { stdout: 'development\nproduction\n', stderr: '' };
    }
    if (opts.args[0] === 'secret' && opts.args[1] === 'list') {
      return { stdout: JSON.stringify([{ name: 'SUPABASE_DB_URL' }]), stderr: '' };
    }
    return { stdout: JSON.stringify({ nameWithOwner: CANONICAL, isPrivate: true }), stderr: '' };
  };
  const { logger } = capturingLogger();
  const result = await runConfigureGitHub({
    argv: [],
    logger,
    platform: 'win32',
    deps: {
      doctor: stubDoctor().doctor,
      buildConfigs: buildGitHubEnvironmentConfigs,
      lookup: (name) => ({ 'gh.cmd': '/c/gh.cmd' })[name] ?? null,
      run,
    },
  });
  assert.ok(commands.length > 0, 'gh must be invoked');
  assert.ok(
    commands.every((c) => c === '/c/gh.cmd'),
    `expected gh.cmd, got ${commands[0]}`,
  );
  assert.deepEqual(result.legacySecretDeletions, { development: true, production: true });
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
        deps: {
          doctor: stubDoctor().doctor,
          buildConfigs: buildGitHubEnvironmentConfigs,
          lookup: () => '/gh',
          run,
        },
      }),
    /capture limit/i,
  );
  const flat = calls.flat().join(' ');
  assert.ok(!flat.includes('PUT'), 'no environment create/update may run on a truncated listing');
  assert.ok(!flat.includes('secret set') && !flat.includes('variable set'));
});

test('github:configure: requests a static-only doctor run bounded by the overall deadline', async () => {
  const opts = [];
  const gh = makeGh();
  const doctor = async (o) => {
    opts.push(o);
    return stubDoctorResult();
  };
  await runConfigureGitHub({
    argv: [],
    logger: silentLogger(),
    timeoutMs: 60000,
    deps: {
      doctor,
      buildConfigs: buildGitHubEnvironmentConfigs,
      lookup: () => '/gh',
      run: gh.run,
    },
  });
  assert.equal(opts.length, 1);
  assert.equal(opts[0].live, false, 'configure must never require Docker/network probes');
  assert.deepEqual(opts[0].argv, [], 'configure OWNER/REPO must never reach the doctor');
  assert.ok(
    opts[0].timeoutMs > 0 && opts[0].timeoutMs <= 60000,
    'the doctor must be bounded by the configure deadline',
  );
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
        deps: {
          doctor: stubDoctor().doctor,
          buildConfigs: buildGitHubEnvironmentConfigs,
          lookup: () => '/gh',
          run,
        },
      }),
    /timed out/i,
  );
});

test('github:configure: write failures never retain unredacted credentials in the error chain', async () => {
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
        logger,
        deps: {
          doctor: stubDoctor().doctor,
          buildConfigs: buildGitHubEnvironmentConfigs,
          lookup: () => '/gh',
          run,
        },
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
});

test('github:configure: result and status output contain no fixture values', async () => {
  const { logger, output } = capturingLogger();
  const { deps } = makeDeps();
  const result = await runConfigureGitHub({ argv: [], logger, deps });
  const text = output();
  assert.ok(text.includes(CANONICAL));
  assert.ok(text.includes('development'));
  assert.ok(text.includes('production'));
  assert.ok(text.includes('SUPABASE_SHARED_POOLER_URL'));
  assert.ok(text.includes('R2_SECRET_ACCESS_KEY'));
  assert.ok(text.includes('ENCRYPT_KEY'));
  for (const value of [...sentinelValues('development'), ...sentinelValues('production')]) {
    assert.ok(!text.includes(value), `status must not contain ${value}`);
  }
  assert.deepEqual(result.upserts, {
    development: { variables: 4, secrets: 3 },
    production: { variables: 4, secrets: 3 },
  });
  assert.equal(result.backupsEnabled, true);
  assert.deepEqual(result.legacySecretDeletions, { development: false, production: false });
});

test('github:configure: CLI entry point responds to --help', () => {
  const res = runCli('configure-github', ['--help']);
  assert.equal(res.status, 0, res.stderr.slice(0, 500));
  assert.ok(res.stdout.includes('usage: vp run github:configure'), res.stdout);
  assert.ok(/development and production/.test(res.stdout), res.stdout);
  assert.equal(res.stderr, '');
});
