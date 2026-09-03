import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DoctorError, runDoctor, DEFAULT_DOCTOR_TIMEOUT_MS } from './doctor.js';
import { createLogger } from '../src/logger.js';
import { runCommand } from '../src/process.js';
import { tmpdir, writePrivateFile, AGE_RECIPIENT_1, AGE_IDENTITY_1 } from '../src/test-fixtures.js';
import { validateWorkdir } from '../src/local-stack.js';
import { PINNED_SUPABASE_POSTGRES_IMAGE } from '../src/database.js';

const REF_DEV = 'a1b2c3d4e5f6a7b8c9d0';
const REF_PROD = 'f0e9d8c7b6a5f4e3d2c1';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ACCESS_KEY = 'abcd1234abcd1234abcd1234abcd1234';
const SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DB_PASSWORD = 'doctor-test-password';
const AGE_RECIPIENT = AGE_RECIPIENT_1;
const AGE_IDENTITY = AGE_IDENTITY_1;
const DEV_CONFIG_PATH = '../dev-project/supabase/config.toml';
const PROD_CONFIG_PATH = '../prod-project/supabase/config.toml';

function dbUrl(environment) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  return `postgresql://postgres.${ref}:${DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`;
}

/** Every fixture value that must never surface outside the validated run. */
function sentinelValues(environment) {
  return [
    dbUrl(environment),
    DB_PASSWORD,
    ACCESS_KEY,
    SECRET_KEY,
    AGE_RECIPIENT,
    AGE_IDENTITY,
    environment === 'development' ? REF_DEV : REF_PROD,
    ACCOUNT_ID,
    'dev-project',
    'prod-project',
    'unknown-sentinel-value',
    'legacy-secret-value',
  ];
}

function envFileValues(environment, overrides = {}) {
  const ref = environment === 'development' ? REF_DEV : REF_PROD;
  const configPath = environment === 'development' ? DEV_CONFIG_PATH : PROD_CONFIG_PATH;
  return {
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
    SUPABASE_CONFIG_PATH: configPath,
    ...overrides,
  };
}

function writeEnvFile(root, environment, contentOverrides = {}, extraLines = '') {
  const values = envFileValues(environment, contentOverrides);
  const body = Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  writePrivateFile(path.join(root, `.env.${environment}.local`), `${body}\n${extraLines}`);
  return path.join(root, `.env.${environment}.local`);
}

function writeEnvFiles(root, { development = {}, production = {} } = {}) {
  writeEnvFile(root, 'development', development);
  writeEnvFile(root, 'production', production);
}

/** Logger capturing every line; redact is configurable (identity by default). */
function captureLogger({ redact = (t) => t } = {}) {
  const lines = [];
  const logger = {
    addSecret() {
      return this;
    },
    status(m) {
      lines.push(`status: ${m}`);
    },
    warn(m) {
      lines.push(`warn: ${m}`);
    },
    error(m) {
      lines.push(`error: ${m}`);
    },
    redact,
  };
  return { logger, text: () => lines.join('\n') };
}

function fakeRun(overrides = {}) {
  const calls = [];
  const run = async (opts) => {
    calls.push({ command: opts.command, args: opts.args, input: opts.input, signal: opts.signal });
    if (overrides.failWith) throw new Error(overrides.failWith);
    if (overrides.hang) {
      await new Promise((_, reject) =>
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
      return { stdout: '', stderr: '' };
    }
    if (opts.args.includes('--version')) return { stdout: 'psql (PostgreSQL) 17.6', stderr: '' };
    if (opts.args.includes('inspect')) return { stdout: 'true', stderr: '' };
    if (opts.args.includes('SELECT 1')) return { stdout: '1', stderr: '' };
    if (opts.args.includes('SHOW server_version_num')) return { stdout: '170006', stderr: '' };
    if (opts.args.includes('-y'))
      return { stdout: overrides.ageStdout ?? `${AGE_RECIPIENT}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

/** Adapter fake recording HeadBucket calls; options configure failure/hang. */
function fakeAdapter(overrides = {}) {
  const headBucketCalls = [];
  const state = { created: [] };
  const adapter = {
    async headBucket({ bucket, signal }) {
      headBucketCalls.push({ bucket, signal });
      if (overrides.fail) throw new Error(`headBucket failed with ${ACCESS_KEY} ${SECRET_KEY}`);
      if (overrides.hang) {
        await new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      }
    },
  };
  const createAdapter = (opts) => {
    state.created.push(opts);
    return adapter;
  };
  return { adapter, createAdapter, headBucketCalls, created: state.created };
}

/** Workdir validator fake: result container encodes dev- vs prod-project. */
function fakeWorkdirValidator(calls) {
  return (opts) => {
    calls.validateWorkdir.push(opts.supabaseConfigPath);
    const name = opts.supabaseConfigPath.includes('dev-project') ? 'dev-project' : 'prod-project';
    return {
      workdir: `/abs/projects/${name}`,
      projectId: name.replace('-', ''),
      dbPort: 54322,
      dbContainer: `supabase_db_${name}`,
    };
  };
}

function makeDeps(overrides = {}) {
  const calls = { run: [], validateWorkdir: [] };
  const runFake = fakeRun(overrides.run ?? {});
  // `runImpl` replaces the fake runner entirely (e.g. the REAL runCommand,
  // to exercise redaction); `overrides.run` options only configure the fake.
  const run = overrides.runImpl ?? runFake.run;
  const runCalls = overrides.runImpl ? [] : runFake.calls;
  calls.run = runCalls;
  const adapterFake = fakeAdapter(overrides.adapter ?? {});
  const defaultLookup = (name) =>
    ({ docker: '/usr/bin/docker', 'age-keygen': '/usr/bin/age-keygen' })[name] ?? null;
  const deps = {
    lookup: overrides.lookup ?? defaultLookup,
    run,
    createAdapter: overrides.createAdapter ?? adapterFake.createAdapter,
    doValidateWorkdir: overrides.doValidateWorkdir ?? fakeWorkdirValidator(calls),
    resolveAge: overrides.resolveAge ?? (({ lookup: lk }) => lk('age-keygen')),
  };
  return {
    deps,
    calls,
    adapter: adapterFake.adapter,
    headBucketCalls: adapterFake.headBucketCalls,
    created: adapterFake.created,
  };
}

/** Run the doctor CLI in a child process. */
function runCli(args) {
  const script = fileURLToPath(new URL('./doctor.js', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('doctor: help and invalid arguments have zero filesystem/tool/service calls', async () => {
  const root = tmpdir('doctor-help-');
  const exploding = {
    lookup: () => {
      throw new Error('lookup must not run for help');
    },
    run: async () => {
      throw new Error('run must not run for help');
    },
  };
  try {
    const { logger } = captureLogger();
    assert.deepEqual(await runDoctor({ argv: ['--help'], root, deps: exploding, logger }), {
      help: true,
    });
    assert.deepEqual(await runDoctor({ argv: ['-h'], root, deps: exploding, logger }), {
      help: true,
    });
    await assert.rejects(
      () => runDoctor({ argv: ['extra'], root, deps: exploding, logger }),
      (err) =>
        err instanceof DoctorError &&
        err.problems.length === 1 &&
        /does not accept/.test(err.message),
    );
    await assert.rejects(
      () => runDoctor({ argv: ['--'], root, deps: exploding, logger }),
      (err) => err instanceof DoctorError,
    );
    assert.equal(fs.readdirSync(root).length, 0, 'no files may be created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: missing production fails statically with zero live activity', async () => {
  const root = tmpdir('doctor-no-prod-');
  writeEnvFile(root, 'development', {}, 'SOME_UNKNOWN_KEY=unknown-sentinel-value\n');
  const { deps, calls, created, headBucketCalls } = makeDeps({
    lookup: () => {
      throw new Error('lookup must not run after a static failure');
    },
  });
  const { logger, text } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((problem) => problem.includes('MISSING .env.production.local')),
          err.message,
        );
        assert.equal(calls.run.length, 0, 'no subprocess may start after a static failure');
        assert.equal(created.length, 0, 'no adapter may be built');
        assert.equal(headBucketCalls.length, 0);
        return true;
      },
    );
    // The unknown-variable warning still emitted before the static failure.
    assert.ok(text().includes('UNKNOWN SOME_UNKNOWN_KEY'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: missing development succeeds and production supplies the local-stack probe', async () => {
  const root = tmpdir('doctor-no-dev-');
  writeEnvFile(root, 'production');
  const { deps, calls } = makeDeps();
  const { logger } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    assert.deepEqual(result.environments, ['production']);
    assert.deepEqual(Object.keys(result.configs), ['production']);
    assert.equal(result.localEnvironment, 'production');
    assert.equal(result.configs.production.projectRef, REF_PROD);
    const inspectCalls = calls.run.filter((c) => c.args.includes('inspect'));
    assert.equal(inspectCalls.length, 1, 'exactly one local-stack probe');
    assert.ok(
      inspectCalls[0].args.includes('supabase_db_prod-project'),
      'production config path selects the local stack',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: development wins local-stack selection when both files exist', async () => {
  const root = tmpdir('doctor-both-');
  writeEnvFiles(root);
  const { deps, calls } = makeDeps();
  const { logger } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    assert.deepEqual(result.environments, ['development', 'production']);
    assert.equal(result.localEnvironment, 'development');
    const inspectCalls = calls.run.filter((c) => c.args.includes('inspect'));
    assert.equal(inspectCalls.length, 1, 'only the development-derived stack is probed');
    assert.ok(inspectCalls[0].args.includes('supabase_db_dev-project'));
    assert.ok(
      calls.run
        .filter((c) => c.args.includes('exec'))
        .every((c) => c.args[1] === 'supabase_db_dev-project'),
      'psql probes target only the development stack',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: both complete files load with vars: {} and live probes receive the exact validated mappings', async () => {
  const root = tmpdir('doctor-valid-');
  writeEnvFiles(root);
  const { deps, calls, created, headBucketCalls } = makeDeps();
  const { logger } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    assert.deepEqual(result.environments, ['development', 'production']);
    assert.equal(result.localEnvironment, 'development');
    assert.deepEqual(result.configs.development.projectRef, REF_DEV);
    assert.deepEqual(result.configs.production.projectRef, REF_PROD);

    // Hosted probes: one Dockerized psql SELECT 1 per environment, in order,
    // with the password stripped from the argv URL (PGPASSWORD channel).
    const selects = calls.run.filter((c) => c.args[0] === 'run' && c.args.includes('SELECT 1'));
    assert.equal(selects.length, 2);
    assert.ok(
      selects[0].args.includes(dbUrl('development').replace(`:${DB_PASSWORD}@`, '@')),
      'development URL first',
    );
    assert.ok(selects[1].args.includes(dbUrl('production').replace(`:${DB_PASSWORD}@`, '@')));
    assert.ok(
      !JSON.stringify(selects.map((c) => c.args)).includes(DB_PASSWORD),
      'the pooler password must never appear in the docker argv',
    );

    // R2: exactly the validated credential mapping, HeadBucket only.
    assert.deepEqual(created, [
      { accountId: ACCOUNT_ID, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      { accountId: ACCOUNT_ID, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    ]);
    assert.deepEqual(
      headBucketCalls.map((c) => c.bucket),
      ['development', 'production'],
    );

    // Age: identity over stdin, argv exactly ['-y'], one matching line.
    const ageCalls = calls.run.filter((c) => c.args.includes('-y'));
    assert.equal(ageCalls.length, 2);
    for (const ageCall of ageCalls) {
      assert.deepEqual(ageCall.args, ['-y']);
      assert.equal(ageCall.input, `${AGE_IDENTITY}\n`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: legacy, unknown, and duplicate assignments warn only and are never config fields', async () => {
  const root = tmpdir('doctor-warn-');
  const extra = [
    'SUPABASE_DB_URL=postgresql://postgres.ref:legacy-secret-value@legacy.pooler.supabase.com:6543/postgres?sslmode=require',
    'PROJECT_WORKDIR=../legacy-project',
    'SOME_UNKNOWN_KEY=unknown-sentinel-value',
    'R2_BUCKET="development"',
    '',
  ].join('\n');
  writeEnvFile(root, 'development', {}, extra);
  writeEnvFile(root, 'production');
  const { deps } = makeDeps();
  const { logger, text } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    const output = text();
    assert.ok(
      output.includes(
        'development: UNSUPPORTED SUPABASE_DB_URL (rename to SUPABASE_SHARED_POOLER_URL)',
      ),
    );
    assert.ok(
      output.includes('development: UNSUPPORTED PROJECT_WORKDIR (rename to SUPABASE_CONFIG_PATH)'),
    );
    assert.ok(output.includes('development: UNKNOWN SOME_UNKNOWN_KEY'));
    assert.ok(output.includes('development: DUPLICATE R2_BUCKET (2 assignments)'));
    assert.ok(!output.includes('unknown-sentinel-value'));
    assert.ok(!output.includes('legacy-secret-value'));
    for (const name of ['SUPABASE_DB_URL', 'PROJECT_WORKDIR', 'SOME_UNKNOWN_KEY']) {
      assert.ok(!Object.hasOwn(result.configs.development, name), `legacy/unknown leaked ${name}`);
    }
    assert.deepEqual(
      result.configs.development.bucket,
      'development',
      'dotenv last-wins effective value',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: duplicate effective values follow dotenv.parse; an invalid effective value still fails', async () => {
  const root = tmpdir('doctor-dup-');
  const { deps, calls, created } = makeDeps();
  const { logger, text } = captureLogger();
  try {
    // Last assignment wins (invalid), so the file must fail statically.
    writeEnvFile(root, 'development', {
      SUPABASE_PROJECT_REF: `${REF_DEV}\nSUPABASE_PROJECT_REF=not-a-ref`,
    });
    writeEnvFile(root, 'production');
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((problem) =>
            problem.includes('development: INVALID SUPABASE_PROJECT_REF'),
          ),
          err.message,
        );
        assert.ok(text().includes('development: DUPLICATE SUPABASE_PROJECT_REF (2 assignments)'));
        assert.equal(calls.run.length, 0);
        assert.equal(created.length, 0);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: static failures from both files aggregate with zero external calls', async () => {
  const root = tmpdir('doctor-static-');
  writeEnvFile(root, 'development', { ENCRYPT_KEY: undefined });
  writeEnvFile(root, 'production', { R2_ACCESS_KEY_ID: undefined });
  const { deps, calls, created, headBucketCalls } = makeDeps();
  const { logger } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((problem) => problem.includes('development: MISSING ENCRYPT_KEY')),
          err.message,
        );
        assert.ok(
          err.problems.some((problem) => problem.includes('production: MISSING R2_ACCESS_KEY_ID')),
          err.message,
        );
        assert.equal(calls.run.length, 0, 'no subprocess may start');
        assert.equal(created.length, 0, 'no adapter may be built');
        assert.equal(headBucketCalls.length, 0);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: validateWorkdir runs for both paths even when another static field fails', async () => {
  const root = tmpdir('doctor-workdir-');
  writeEnvFile(root, 'development', { SUPABASE_PROJECT_REF: 'not-a-ref' });
  writeEnvFile(root, 'production');
  const { deps, calls } = makeDeps();
  const { logger } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((problem) =>
            problem.includes('development: INVALID SUPABASE_PROJECT_REF'),
          ),
          err.message,
        );
        assert.equal(calls.validateWorkdir.length, 2, 'both config paths validated');
        for (const resolved of calls.validateWorkdir) {
          assert.ok(resolved.endsWith('/supabase/config.toml'), resolved);
        }
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: hosted probes use Dockerized psql and SELECT 1; R2 uses only HeadBucket; local probes are read-only', async () => {
  const root = tmpdir('doctor-readonly-');
  writeEnvFiles(root);
  const { deps, calls, headBucketCalls } = makeDeps();
  const { logger } = captureLogger();
  try {
    await runDoctor({ argv: [], root, deps, logger });
    const dockerCalls = calls.run.filter((c) => c.command === '/usr/bin/docker');
    for (const call of dockerCalls) {
      const verb = call.args[0];
      assert.ok(['run', 'exec', 'inspect'].includes(verb), `unexpected docker verb ${verb}`);
    }
    const psqlRuns = dockerCalls.filter((c) => c.args[0] === 'run');
    assert.equal(psqlRuns.length, 4, 'two environments x (psql --version + SELECT 1)');
    assert.ok(psqlRuns.every((c) => c.args.includes(PINNED_SUPABASE_POSTGRES_IMAGE)));
    assert.ok(psqlRuns.every((c) => c.args.some((a) => a.includes('psql'))));
    assert.ok(
      dockerCalls
        .filter((c) => c.args[0] === 'exec')
        .every((c) => c.args.includes('SELECT 1') || c.args.includes('SHOW server_version_num')),
      'local probes are SELECT 1/version only',
    );
    assert.equal(headBucketCalls.length, 2, 'HeadBucket is the only R2 operation');
    assert.equal(
      dockerCalls.filter((c) => c.args[0] === 'inspect').length,
      1,
      'one local-stack inspect',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: age identity travels via stdin only and one exact matching recipient passes', async () => {
  const root = tmpdir('doctor-age-ok-');
  writeEnvFiles(root);
  const { deps, calls } = makeDeps();
  const { logger } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    assert.ok(result.configs.development.ageIdentity);
    const flatArgs = JSON.stringify(calls.run.map((c) => c.args));
    assert.ok(!flatArgs.includes(AGE_IDENTITY), 'identity must never appear in argv');
    assert.ok(!flatArgs.includes(AGE_RECIPIENT), 'recipient must never appear in argv');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: malformed, multiple, mismatched, and failing age outputs fail', async () => {
  const root = tmpdir('doctor-age-bad-');
  const cases = [
    { ageStdout: 'unexpected output\n', label: 'malformed' },
    { ageStdout: `${AGE_RECIPIENT}\nextra-recipient-line\n`, label: 'multiple lines' },
    { ageStdout: `${'age1' + 'x'.repeat(58)}\n`, label: 'mismatched recipient' },
  ];
  try {
    for (const { ageStdout, label } of cases) {
      writeEnvFiles(root);
      const { deps } = makeDeps({ run: { ageStdout } });
      await assert.rejects(
        () => runDoctor({ argv: [], root, deps, logger: captureLogger().logger }),
        (err) => {
          assert.ok(err instanceof DoctorError, label);
          assert.ok(
            err.problems.some((problem) =>
              problem.includes('development: age key-pair validation failed'),
            ),
            label,
          );
          assert.ok(
            err.problems.some((problem) =>
              problem.includes('production: age key-pair validation failed'),
            ),
            label,
          );
          return true;
        },
        label,
      );
    }
    // The age-keygen subprocess itself fails.
    writeEnvFiles(root);
    const failing = makeDeps({
      resolveAge: () => '/usr/bin/age-keygen',
      run: { failWith: `age-keygen exploded ${AGE_IDENTITY}` },
    });
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps: failing.deps, logger: captureLogger().logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((problem) =>
            problem.includes('development: age key-pair validation failed'),
          ),
        );
        assert.ok(!err.message.includes(AGE_IDENTITY), 'raw failure must be discarded');
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: missing Docker and age-keygen aggregate while R2 checks still execute', async () => {
  const root = tmpdir('doctor-missing-tools-');
  writeEnvFiles(root);
  const { deps, calls, headBucketCalls, created } = makeDeps({ lookup: () => null });
  const { logger } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((problem) =>
            problem.includes(
              'docker executable not found (hosted Supabase and local database checks skipped)',
            ),
          ),
        );
        assert.ok(
          err.problems.some((problem) =>
            problem.includes('age-keygen executable not found (age key-pair checks skipped)'),
          ),
        );
        assert.equal(calls.run.length, 0, 'no subprocess may run without tools');
        assert.equal(created.length, 2, 'R2 checks run without Docker/age-keygen');
        assert.equal(headBucketCalls.length, 2);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: one failure in each live category/environment aggregates without suppressing later checks', async () => {
  const root = tmpdir('doctor-live-fail-');
  writeEnvFiles(root);
  const { deps, headBucketCalls } = makeDeps({
    run: { failWith: `probe failure ${dbUrl('development')} ${AGE_IDENTITY}` },
    adapter: { fail: true },
  });
  const { logger } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        for (const environment of ['development', 'production']) {
          assert.ok(
            err.problems.some((problem) =>
              problem.includes(`${environment}: SUPABASE connection failed`),
            ),
            err.message,
          );
          assert.ok(
            err.problems.some((problem) =>
              problem.includes(`${environment}: R2 bucket access failed`),
            ),
            err.message,
          );
          assert.ok(
            err.problems.some((problem) =>
              problem.includes(`${environment}: age key-pair validation failed`),
            ),
            err.message,
          );
        }
        assert.ok(
          err.problems.some((problem) => problem.includes('local database connection failed')),
          err.message,
        );
        assert.equal(headBucketCalls.length, 2, 'R2 probes still ran after hosted failures');
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: an in-flight subprocess is abortable and no later probes start', async () => {
  const root = tmpdir('doctor-timeout-run-');
  writeEnvFiles(root);
  const { deps, headBucketCalls, created } = makeDeps({ run: { hang: true } });
  const { logger } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger, timeoutMs: 20 }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((p) => p === 'doctor timed out after 20ms'),
          err.message,
        );
        assert.equal(headBucketCalls.length, 0, 'no R2 probe may start after the deadline');
        assert.equal(created.length, 0, 'no adapter may be built after the deadline');
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: an in-flight R2 request is abortable and later probes never start', async () => {
  const root = tmpdir('doctor-timeout-r2-');
  writeEnvFiles(root);
  const { deps, calls } = makeDeps({ adapter: { hang: true } });
  const { logger } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger, timeoutMs: 20 }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((p) => p === 'doctor timed out after 20ms'),
          err.message,
        );
        assert.equal(
          calls.run.filter((c) => c.args.includes('-y')).length,
          0,
          'no age probe may start after the deadline',
        );
        assert.equal(
          calls.run.filter((c) => c.args.includes('inspect')).length,
          0,
          'no local-stack probe may start after the deadline',
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: injected errors containing every fixture secret surface nowhere', async () => {
  const root = tmpdir('doctor-leak-');
  writeEnvFile(root, 'development', {}, 'SOME_UNKNOWN_KEY=unknown-sentinel-value\n');
  writeEnvFile(root, 'production');
  const secrets = [...sentinelValues('development'), ...sentinelValues('production')];
  const { deps, created } = makeDeps({
    run: { failWith: `boom ${secrets.join(' ')}` },
    adapter: { fail: true },
    doValidateWorkdir: () => {
      throw new Error(`workdir validation exploded ${secrets.join(' ')}`);
    },
  });
  const chunks = [];
  const logger = createLogger({
    stream: { write: (c) => chunks.push(String(c)) },
    isGitHubActions: false,
  });
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError, 'raw errors must be wrapped once, statically');
        assert.ok(err.cause === undefined, 'raw errors must never become the cause');
        for (const secret of secrets) {
          assert.ok(
            !err.message.includes(secret),
            `DoctorError.message leaked ${secret.slice(0, 8)}`,
          );
        }
        for (const problem of err.problems) {
          for (const secret of secrets) {
            assert.ok(!problem.includes(secret), `problem leaked ${secret.slice(0, 8)}`);
          }
        }
        const chain = [];
        for (let node = err; node; node = node.cause) {
          if (node && typeof node === 'object') {
            for (const key of ['message', 'stderrTail', 'command']) {
              if (typeof node[key] === 'string') chain.push(node[key]);
            }
          }
        }
        const serialized = JSON.stringify(chain);
        for (const secret of secrets) {
          assert.ok(!serialized.includes(secret), `serialized chain leaked ${secret.slice(0, 8)}`);
        }
        return true;
      },
    );
    const output = chunks.join('');
    for (const secret of secrets) {
      assert.ok(!output.includes(secret), `CLI output leaked ${secret.slice(0, 8)}`);
    }
    assert.ok(created.length === 0 || created.length === 2, 'adapters built before the failure');
    // The workdir validation error also produced a static problem, never the message.
    const { logger: silent } = captureLogger(); // redact is identity: proves discard-not-redact
    await assert.rejects(
      () =>
        runDoctor({
          argv: [],
          root,
          deps: makeDeps({
            run: { failWith: `boom ${secrets.join(' ')}` },
            adapter: { fail: true },
            doValidateWorkdir: () => {
              throw new Error(`workdir validation exploded ${secrets.join(' ')}`);
            },
          }).deps,
          logger: silent,
        }),
      (err) => {
        for (const problem of err.problems) {
          for (const secret of secrets) {
            assert.ok(!problem.includes(secret), `problem leaked with no-op redaction`);
          }
        }
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: a missing DECRYPT_KEY warns but never fails (backup-only setups)', async () => {
  const root = tmpdir('doctor-no-identity-');
  writeEnvFile(root, 'development', { DECRYPT_KEY: undefined });
  writeEnvFile(root, 'production', { DECRYPT_KEY: undefined });
  const { deps, calls } = makeDeps();
  const { logger, text } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    assert.deepEqual(result.environments, ['development', 'production']);
    assert.equal(result.configs.development.ageIdentity, undefined);
    assert.ok(
      text().includes('development: MISSING DECRYPT_KEY (r2/repo restores only)'),
      'the missing restore-only identity warns',
    );
    assert.equal(
      calls.run.filter((c) => c.args.includes('-y')).length,
      0,
      'no age key-pair probe without an identity',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: insecure dotenv file permissions and symlinks fail statically', async () => {
  const root = tmpdir('doctor-perms-');
  writeEnvFiles(root);
  const prodPath = path.join(root, '.env.production.local');
  const { deps, calls } = makeDeps();
  const { logger } = captureLogger();
  try {
    // Group/world-readable credentials file: static barrier failure.
    fs.chmodSync(prodPath, 0o644);
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((p) => p.includes('INSECURE .env.production.local')),
          err.message,
        );
        assert.equal(calls.run.length, 0, 'a permission failure is a static barrier failure');
        return true;
      },
    );
    // Symlinked file is rejected even when the target is private.
    fs.chmodSync(prodPath, 0o600);
    const target = path.join(root, 'actual-production.env');
    fs.renameSync(prodPath, target);
    fs.symlinkSync(target, prodPath);
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((p) => p.includes('INSECURE .env.production.local')),
          err.message,
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: Windows skips the permission gate (stat modes are not meaningful)', async () => {
  const root = tmpdir('doctor-perms-win-');
  writeEnvFiles(root);
  fs.chmodSync(path.join(root, '.env.development.local'), 0o644);
  const { deps, calls } = makeDeps({ lookup: () => '/usr/bin/docker' });
  const { logger } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger, platform: 'win32' });
    assert.equal(result.environments.length, 2);
    assert.equal(
      calls.run.length,
      9,
      'live probes still run on win32 (4 psql, 2 age, 3 local stack)',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: only real credentials are registered for redaction; environment labels stay readable', async () => {
  const root = tmpdir('doctor-labels-');
  writeEnvFiles(root);
  const chunks = [];
  const logger = createLogger({
    stream: { write: (c) => chunks.push(String(c)) },
    isGitHubActions: false,
  });
  const { deps } = makeDeps();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    assert.equal(result.environments.length, 2);
    const output = chunks.join('');
    assert.ok(
      output.includes('doctor development: configuration contract valid'),
      'the environment label must not be treated as a secret',
    );
    assert.ok(output.includes('doctor production: configuration contract valid'));
    assert.ok(!output.includes(DB_PASSWORD), 'the pooler password must still be redacted');
    assert.ok(!output.includes(AGE_IDENTITY), 'the age identity must still be redacted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: warnings cover every dotenv-accepted key name, duplicates included', async () => {
  const root = tmpdir('doctor-scan-');
  const extra = ['FOO.BAR=1', 'FOO.BAR=2', '1DIGIT_KEY=1', 'EXPORTED=1'].join('\n');
  writeEnvFile(root, 'development', {}, `${extra}\n`);
  writeEnvFile(root, 'production');
  const { deps } = makeDeps();
  const { logger, text } = captureLogger();
  try {
    await runDoctor({ argv: [], root, deps, logger });
    const output = text();
    assert.ok(output.includes('development: UNKNOWN FOO.BAR'), output);
    assert.ok(output.includes('development: UNKNOWN 1DIGIT_KEY'), output);
    assert.ok(output.includes('development: UNKNOWN EXPORTED'), output);
    assert.ok(output.includes('development: DUPLICATE FOO.BAR (2 assignments)'), output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: adapter construction failure is reported distinctly from bucket access', async () => {
  const root = tmpdir('doctor-adapter-');
  writeEnvFiles(root);
  const { deps } = makeDeps({
    createAdapter: () => {
      throw new Error('S3Client exploded');
    },
  });
  const { logger } = captureLogger();
  try {
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((p) => p === 'development: R2 client initialization failed'),
          err.message,
        );
        assert.ok(err.problems.some((p) => p === 'production: R2 client initialization failed'));
        assert.ok(!err.problems.some((p) => p.includes('R2 bucket access failed')));
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: live: false runs only the static phase with zero external calls', async () => {
  const root = tmpdir('doctor-static-mode-');
  writeEnvFiles(root);
  const { deps, calls, created, headBucketCalls } = makeDeps();
  const { logger } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger, live: false });
    assert.deepEqual(result.environments, ['development', 'production']);
    assert.equal(result.configs.production.projectRef, REF_PROD);
    assert.equal(result.configs.development.ageIdentity, AGE_IDENTITY);
    assert.equal(calls.run.length, 0, 'no subprocess may run in static-only mode');
    assert.equal(created.length, 0, 'no adapter may be built in static-only mode');
    assert.equal(headBucketCalls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: the age probe survives the real runCommand redactor (recipient is public)', async () => {
  const root = tmpdir('doctor-real-redact-');
  writeEnvFiles(root);
  // Stub executables exercised through the REAL runCommand: captured stdout
  // is redacted with secretArgs there, which is exactly where the recipient
  // used to be swallowed ("***") and broke the key-pair comparison.
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { mode: 0o700 });
  const ageKeygenPath = path.join(binDir, 'age-keygen');
  fs.writeFileSync(
    ageKeygenPath,
    `#!/usr/bin/env node\n` +
      `const fs = require('fs');\n` +
      `const map = { ${JSON.stringify(AGE_IDENTITY_1)}: ${JSON.stringify(AGE_RECIPIENT_1)} };\n` +
      `process.stdout.write((map[fs.readFileSync(0, 'utf8').trim()] ?? '') + '\\n');\n`,
  );
  fs.chmodSync(ageKeygenPath, 0o700);
  const dockerPath = path.join(binDir, 'docker');
  fs.writeFileSync(
    dockerPath,
    `#!/bin/sh\n` +
      `case "$*" in\n` +
      `  *--version*) printf 'psql (PostgreSQL) 17.6\\n';;\n` +
      `  *'SELECT 1'*) printf '1\\n';;\n` +
      `  *'SHOW server_version_num'*) printf '170006\\n';;\n` +
      `  *inspect*) printf 'true\\n';;\n` +
      `esac\n`,
  );
  fs.chmodSync(dockerPath, 0o700);
  const { deps } = makeDeps({
    lookup: (name) => path.join(binDir, name),
    runImpl: runCommand,
  });
  const { logger } = captureLogger();
  try {
    const result = await runDoctor({ argv: [], root, deps, logger });
    assert.deepEqual(result.environments, ['development', 'production']);
    assert.ok(result.configs.development.ageIdentity);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: DEFAULT_DOCTOR_TIMEOUT_MS follows the ten-minute operational convention', () => {
  assert.equal(DEFAULT_DOCTOR_TIMEOUT_MS, 10 * 60 * 1000);
});

test('doctor: CLI help and usage errors map to deterministic exit codes', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0, help.stderr.slice(0, 500));
  assert.ok(help.stdout.includes('usage: npm run doctor'), help.stdout);
  assert.ok(/read-only/.test(help.stdout), help.stdout);
  assert.equal(help.stderr, '');
  const usage = runCli(['unexpected']);
  assert.equal(usage.status, 1, usage.stderr.slice(0, 500));
  assert.ok(/does not accept/.test(usage.stderr), usage.stderr);
  assert.equal(usage.stdout, '');
});

test('doctor: a real validateWorkdir failure maps to a static problem', async () => {
  const root = tmpdir('doctor-real-workdir-');
  // A path that exists but is not a config.toml: real validator rejects it.
  writeEnvFile(root, 'development', { SUPABASE_CONFIG_PATH: '../dev-project' });
  writeEnvFile(root, 'production');
  const { deps } = makeDeps({ doValidateWorkdir: validateWorkdir });
  const { logger } = captureLogger();
  try {
    fs.mkdirSync(path.resolve(root, '../dev-project'), { recursive: true });
    await assert.rejects(
      () => runDoctor({ argv: [], root, deps, logger }),
      (err) => {
        assert.ok(err instanceof DoctorError);
        assert.ok(
          err.problems.some((problem) =>
            problem.includes('development: INVALID SUPABASE_CONFIG_PATH'),
          ),
          err.message,
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
