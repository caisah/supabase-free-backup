import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBackupConfig,
  loadHostedRestoreConfig,
  loadLocalRestoreConfig,
  loadLocalBackupConfig,
  classifyDbUrl,
  ConfigError,
  CONFLICT_PREFIX,
  urlPassword,
  REPOSITORY_ROOT,
} from './config.js';

const REF_DEV = 'a1b2c3d4e5f6a7b8c9d0';
const REF_PROD = 'f0e9d8c7b6a5f4e3d2c1';
const PASSWORD = 'the-ultimate-secret-password';
const EXAMPLE_PROJECT_WORKDIR = '../example-project';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-config-'));
}

function writeEnv(root, name, entries) {
  const body = Object.entries(entries)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n');
  fs.writeFileSync(path.join(root, `.env.${name}.local`), `${body}\n`);
}

function devFile(root, overrides = {}) {
  writeEnv(root, 'development', {
    BACKUP_ENVIRONMENT: 'development',
    SUPABASE_PROJECT_REF: REF_DEV,
    SUPABASE_DB_URL: `postgresql://postgres.${REF_DEV}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'development',
    R2_ACCESS_KEY_ID: 'dev-access-key-12345',
    R2_SECRET_ACCESS_KEY: 'dev-secret-key-abcdefghijklmnop',
    ENCRYPT_KEY: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    DECRYPT_KEY: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
    PROJECT_WORKDIR: EXAMPLE_PROJECT_WORKDIR,
    ...overrides,
  });
}

test('config: dotenv values load for the selected environment only', () => {
  const root = makeRoot();
  devFile(root);
  const cfg = loadBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(cfg.environment, 'development');
  assert.equal(cfg.projectRef, REF_DEV);
  assert.equal(cfg.bucket, 'development');

  // The production file does not exist: missing names are reported, and none of
  // the development values leak into the production resolution.
  assert.throws(
    () => loadBackupConfig({ environment: 'production', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      const msg = err.message;
      assert.ok(msg.includes('SUPABASE_PROJECT_REF'), msg);
      assert.ok(msg.includes('SUPABASE_DB_URL'), msg);
      assert.ok(!msg.includes(REF_DEV), 'project ref leaked');
      assert.ok(!msg.includes(PASSWORD), 'password leaked');
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: differing process and dotenv values are rejected as CONFLICT (names only)', () => {
  const root = makeRoot();
  devFile(root);
  const overriddenRef = 'fedcba9876543210fedc';
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: {
          SUPABASE_PROJECT_REF: overriddenRef,
          SUPABASE_DB_URL: `postgresql://postgres.${overriddenRef}:override-password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require`,
        },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes(`${CONFLICT_PREFIX} SUPABASE_PROJECT_REF`), err.message);
      assert.ok(err.message.includes(`${CONFLICT_PREFIX} SUPABASE_DB_URL`), err.message);
      assert.ok(!err.message.includes(overriddenRef), 'process value leaked');
      assert.ok(!err.message.includes('override-password'), 'process password leaked');
      assert.ok(!err.message.includes(PASSWORD), 'file value leaked');
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: process values fill variables absent from the dotenv file', () => {
  const root = makeRoot();
  devFile(root, { ENCRYPT_KEY: undefined });
  const recipient = `age1${'y'.repeat(38)}`;
  const cfg = loadBackupConfig({
    environment: 'development',
    root,
    vars: { ENCRYPT_KEY: recipient },
  });
  assert.equal(cfg.ageRecipient, recipient);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: identical process and dotenv values do not conflict', () => {
  const root = makeRoot();
  devFile(root);
  const cfg = loadBackupConfig({
    environment: 'development',
    root,
    vars: {
      R2_BUCKET: 'development',
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
  });
  assert.equal(cfg.bucket, 'development');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: CLOUDFLARE_ACCOUNT_ID resolves from the dotenv file over a differing export', () => {
  const root = makeRoot();
  devFile(root); // file account: 0123456789abcdef0123456789abcdef
  const cfg = loadBackupConfig({
    environment: 'development',
    root,
    vars: { CLOUDFLARE_ACCOUNT_ID: 'ffffffffffffffffffffffffffffffff' },
  });
  assert.equal(cfg.accountId, '0123456789abcdef0123456789abcdef');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: other variables still conflict while CLOUDFLARE_ACCOUNT_ID stays file-first', () => {
  const root = makeRoot();
  devFile(root);
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: {
          CLOUDFLARE_ACCOUNT_ID: 'ffffffffffffffffffffffffffffffff',
          SUPABASE_PROJECT_REF: 'fedcba9876543210fedc',
        },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes(`${CONFLICT_PREFIX} SUPABASE_PROJECT_REF`), err.message);
      assert.ok(!err.message.includes('CLOUDFLARE_ACCOUNT_ID'), err.message);
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: variables the operation does not consume never conflict', () => {
  const root = makeRoot();
  devFile(root);
  // Backup does not consume the private age identity: a differing DECRYPT_KEY
  // shell export must not block the run.
  const identity = 'AGE-SECRET-KEY-1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
  const backupCfg = loadBackupConfig({
    environment: 'development',
    root,
    vars: { DECRYPT_KEY: identity },
  });
  assert.equal(backupCfg.ageIdentity, identity);
  // Repo restore never touches R2: differing R2 exports must not block an
  // emergency repository restore (resolution still prefers the process
  // export; only the CONFLICT gate is scoped to consumed variables).
  const repoCfg = loadHostedRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: {
      R2_ACCESS_KEY_ID: 'different-access-key-98765',
      R2_SECRET_ACCESS_KEY: 'different-secret-key-9876543210',
      R2_BUCKET: 'production',
    },
  });
  assert.equal(repoCfg.bucket, 'production');
  const localCfg = loadLocalRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: { CLOUDFLARE_ACCOUNT_ID: 'ffffffffffffffffffffffffffffffff' },
  });
  assert.equal(localCfg.accountId, '0123456789abcdef0123456789abcdef', 'file value wins');
  // Consumed variables still conflict exactly as before.
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: { SUPABASE_PROJECT_REF: 'fedcba9876543210fedc' },
      }),
    (err) =>
      err instanceof ConfigError && err.message.includes(`${CONFLICT_PREFIX} SUPABASE_PROJECT_REF`),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: a present dotenv file that omits CLOUDFLARE_ACCOUNT_ID fails closed', () => {
  const root = makeRoot();
  devFile(root, { CLOUDFLARE_ACCOUNT_ID: undefined });
  // The file is the authoritative source for the account ID; a shell export
  // must NOT select the R2 endpoint when the present file omits it.
  const accountId = '0123456789abcdef0123456789abcdef';
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: { CLOUDFLARE_ACCOUNT_ID: accountId },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('CLOUDFLARE_ACCOUNT_ID'), err.message);
      assert.ok(!err.message.includes(accountId), 'value leaked');
      return true;
    },
  );
  // With NO dotenv file (CI), the process export still configures the run.
  const bare = makeRoot();
  const cfg = loadBackupConfig({
    environment: 'development',
    root: bare,
    vars: {
      BACKUP_ENVIRONMENT: 'development',
      SUPABASE_PROJECT_REF: REF_DEV,
      SUPABASE_DB_URL: `postgresql://postgres.${REF_DEV}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      R2_BUCKET: 'development',
      R2_ACCESS_KEY_ID: 'dev-access-key-12345',
      R2_SECRET_ACCESS_KEY: 'dev-secret-key-abcdefghijklmnop',
      ENCRYPT_KEY: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
  });
  assert.equal(cfg.accountId, accountId);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});

test('config: whitespace around dotenv values is normalized before compare and resolve', () => {
  const root = makeRoot();
  // R2_BUCKET="development " — the trailing space inside the quotes survives
  // dotenv.parse and must be normalized before conflict comparison/resolution.
  devFile(root, { R2_BUCKET: 'development ' });
  const cfg = loadBackupConfig({
    environment: 'development',
    root,
    vars: { R2_BUCKET: 'development' },
  });
  assert.equal(cfg.bucket, 'development');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: conflict message names the actual dotenv file for explicit dotenvPath', () => {
  const root = makeRoot();
  const customPath = path.join(root, 'custom.env');
  fs.writeFileSync(
    customPath,
    `BACKUP_ENVIRONMENT="development"\nSUPABASE_PROJECT_REF="${REF_DEV}"\n`,
  );
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: { SUPABASE_PROJECT_REF: 'fedcba9876543210fedc' },
        dotenvPath: customPath,
      }),
    (err) => err instanceof ConfigError && err.message.includes(path.basename(customPath)),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: CLOUDFLARE_ACCOUNT_ID falls back to the process export only when NO dotenv file exists', () => {
  // A present file that omits the variable is now a hard error (fail closed);
  // a file ABSENT entirely (CI) still allows process-only configuration.
  const root = makeRoot();
  devFile(root, { CLOUDFLARE_ACCOUNT_ID: undefined });
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' },
      }),
    (err) => err instanceof ConfigError && err.message.includes('CLOUDFLARE_ACCOUNT_ID'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: missing variables identify names, not values', () => {
  const root = makeRoot();
  devFile(root, { SUPABASE_DB_URL: undefined });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('SUPABASE_DB_URL'));
      assert.ok(!err.message.includes('postgres'));
      assert.ok(!err.message.includes(PASSWORD));
      return true;
    },
  );
  // Missing PROJECT_WORKDIR names only the variable, never the ambient path.
  devFile(root, { SUPABASE_DB_URL: undefined, PROJECT_WORKDIR: undefined });
  assert.throws(
    () =>
      loadLocalRestoreConfig({
        environment: 'development',
        source: 'repo',
        root,
        vars: {},
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(
        err.message,
        'Backup configuration error:\n  - MISSING PROJECT_WORKDIR',
        'only the variable name may appear — never a path value',
      );
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: mismatched bucket/environment fails', () => {
  const root = makeRoot();
  devFile(root, { R2_BUCKET: 'production' });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('R2_BUCKET'), err.message);
      assert.ok(!err.message.includes('production'));
      return true;
    },
  );
  // The fixed mapping also rejects the complementary mismatch.
  devFile(root, { R2_BUCKET: 'development', BACKUP_ENVIRONMENT: 'development' });
  const prod = makeRoot();
  writeEnv(prod, 'production', {
    BACKUP_ENVIRONMENT: 'production',
    SUPABASE_PROJECT_REF: REF_PROD,
    SUPABASE_DB_URL: `postgresql://postgres.${REF_PROD}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'development',
    R2_ACCESS_KEY_ID: 'prod-access-key-12345',
    R2_SECRET_ACCESS_KEY: 'prod-secret-key-abcdefghijklmnop',
    ENCRYPT_KEY: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  });
  assert.throws(
    () => loadBackupConfig({ environment: 'production', root: prod, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('R2_BUCKET'),
  );
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(prod, { recursive: true, force: true });
});

test('config: mismatched project ref / DB URL fails', () => {
  const root = makeRoot();
  devFile(root, {
    SUPABASE_DB_URL: `postgresql://postgres.${REF_PROD}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
  });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('SUPABASE_DB_URL'), err.message);
      assert.ok(!err.message.includes(REF_PROD));
      assert.ok(!err.message.includes(PASSWORD));
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: urlPassword extracts the embedded password and never throws', () => {
  const dbUrl = `postgresql://postgres.${REF_DEV}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`;
  assert.equal(urlPassword(dbUrl), PASSWORD);
  assert.equal(urlPassword('not a url at all'), null);
  // A URL without a password yields an empty string (falsy, filtered by callers).
  assert.equal(urlPassword(`postgresql://postgres.${REF_DEV}@db.example.com:5432/postgres`), '');
});

test('config: direct and pooler URLs validate correctly', () => {
  const direct = `postgres://postgres:${PASSWORD}@db.${REF_DEV}.supabase.co:5432/postgres?sslmode=require`;
  const pooler = `postgresql://postgres.${REF_DEV}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`;
  const legacyPooler = `postgresql://postgres.${REF_DEV}:${PASSWORD}@db.${REF_DEV}.supabase.co:6543/postgres?sslmode=require`;
  const root = makeRoot();
  for (const dbUrl of [direct, pooler, legacyPooler]) {
    devFile(root, { SUPABASE_DB_URL: dbUrl });
    const cfg = loadBackupConfig({ environment: 'development', root, vars: {} });
    assert.equal(cfg.dbUrl, dbUrl);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: classifyDbUrl reports every failure code without echoing the URL', () => {
  const mk = (user, host, port, ssl = '?sslmode=require') =>
    `postgresql://${user}:${PASSWORD}@${host}:${port}/postgres${ssl}`;
  const cases = [
    ['unparsable', 'not a url at all::'],
    [
      'scheme',
      `https://postgres.${REF_DEV}:${PASSWORD}@pooler.supabase.com:6543/postgres?sslmode=require`,
    ],
    ['ssl', mk('postgres', `db.${REF_DEV}.supabase.co`, 5432, '')],
    [
      'username',
      `postgresql://:${PASSWORD}@db.${REF_DEV}.supabase.co:5432/postgres?sslmode=require`,
    ],
    ['password', `postgresql://postgres@db.${REF_DEV}.supabase.co:5432/postgres?sslmode=require`],
    ['host', mk('postgres', 'my-own-db.example.com', 5432)],
    ['pooler-port', mk(`postgres.${REF_DEV}`, 'aws-0-us-east-1.pooler.supabase.com', 5432)],
    [
      'transaction-pooler',
      mk(`postgres.${REF_DEV}.transaction`, 'aws-0-us-east-1.pooler.supabase.com', 6543),
    ],
    ['pooler-user', mk('someone-else', 'aws-0-us-east-1.pooler.supabase.com', 6543)],
  ];
  for (const [code, input] of cases) {
    assert.deepEqual(classifyDbUrl(input, REF_DEV), { ok: false, code }, code);
  }
});

test('config: classifyDbUrl recognizes direct and pooler kinds', () => {
  const PW = PASSWORD;
  assert.equal(
    classifyDbUrl(
      `postgres://postgres:${PW}@db.${REF_DEV}.supabase.co:5432/postgres?sslmode=require`,
      REF_DEV,
    ).kind,
    'direct',
  );
  assert.equal(
    classifyDbUrl(
      `postgresql://postgres.${REF_DEV}.session:${PW}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      REF_DEV,
    ).kind,
    'pooler',
  );
  assert.equal(
    classifyDbUrl(
      `postgresql://postgres.${REF_DEV}:${PW}@db.${REF_DEV}.supabase.co:6543/postgres?sslmode=require`,
      REF_DEV,
    ).kind,
    'pooler',
  );
  // Mismatched project ref in the username is still a valid pooler shape for
  // the supplied ref only when the ref matches the username.
  assert.equal(
    classifyDbUrl(
      `postgresql://postgres.${REF_DEV}:${PW}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      REF_DEV,
    ).ok,
    true,
  );
});

test('config: transaction pooler, non-SSL, and foreign hosts are rejected', () => {
  const txPooler = `postgresql://postgres.${REF_DEV}.transaction:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`;
  const noSsl = `postgresql://postgres.${REF_DEV}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
  const sslDisabled = `postgresql://postgres.${REF_DEV}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=disable`;
  const foreign = `postgresql://postgres.${REF_DEV}:${PASSWORD}@my-own-db.example.com:5432/postgres?sslmode=require`;
  const httpScheme = `https://postgres.${REF_DEV}:${PASSWORD}@pooler.supabase.com:6543/postgres?sslmode=require`;
  const unparsable = `not a url at all::`;
  const root = makeRoot();
  for (const dbUrl of [txPooler, noSsl, sslDisabled, foreign, httpScheme, unparsable]) {
    devFile(root, { SUPABASE_DB_URL: dbUrl });
    assert.throws(
      () => loadBackupConfig({ environment: 'development', root, vars: {} }),
      (err) => {
        assert.ok(err instanceof ConfigError, dbUrl);
        assert.ok(err.message.includes('SUPABASE_DB_URL'), dbUrl);
        if (dbUrl.includes('@')) {
          assert.ok(!err.message.includes(dbUrl.split('@')[1]), 'url leaked');
        }
        assert.ok(!err.message.includes(PASSWORD), 'password leaked');
        return true;
      },
      dbUrl,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: BACKUP_ENVIRONMENT must match the selected environment', () => {
  const root = makeRoot();
  devFile(root, { BACKUP_ENVIRONMENT: 'production' });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('BACKUP_ENVIRONMENT'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: backup never requires the private age identity', () => {
  const root = makeRoot();
  devFile(root, { DECRYPT_KEY: undefined });
  const cfg = loadBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(cfg.ageIdentity, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: restore loaders require the age identity', () => {
  const root = makeRoot();
  devFile(root, { DECRYPT_KEY: undefined });
  assert.throws(
    () => loadHostedRestoreConfig({ environment: 'development', source: 'repo', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('DECRYPT_KEY'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: repo restore does not require R2 credentials; r2 restore does', () => {
  const root = makeRoot();
  devFile(root, {
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
    R2_BUCKET: undefined,
  });
  const repoCfg = loadHostedRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: {},
  });
  assert.equal(repoCfg.accessKeyId, undefined);
  assert.throws(
    () => loadHostedRestoreConfig({ environment: 'development', source: 'r2', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('R2_ACCESS_KEY_ID'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: age recipient and identity shape are validated without echoing values', () => {
  const root = makeRoot();
  devFile(root, { ENCRYPT_KEY: 'not-an-age-key' });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('ENCRYPT_KEY'));
      assert.ok(!err.message.includes('not-an-age-key'));
      return true;
    },
  );
  devFile(root, {
    ENCRYPT_KEY: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    DECRYPT_KEY: 'garbage-identity',
  });
  assert.throws(
    () => loadHostedRestoreConfig({ environment: 'development', source: 'repo', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('DECRYPT_KEY'));
      assert.ok(!err.message.includes('garbage-identity'));
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: PROJECT_WORKDIR resolves relative to the repository root and keeps absolute paths', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: EXAMPLE_PROJECT_WORKDIR });
  const cfg = loadLocalRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: {},
  });
  assert.equal(path.relative(root, cfg.projectWorkdir), EXAMPLE_PROJECT_WORKDIR);
  assert.equal(path.resolve(root, EXAMPLE_PROJECT_WORKDIR), cfg.projectWorkdir);

  // An absolute value is preserved unchanged, never re-anchored.
  const absolute = path.join(root, 'elsewhere', 'example-project');
  devFile(root, { PROJECT_WORKDIR: absolute });
  const absCfg = loadLocalRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: {},
  });
  assert.equal(absCfg.projectWorkdir, absolute);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local restore requires PROJECT_WORKDIR for repo sources', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: undefined });
  assert.throws(
    () =>
      loadLocalRestoreConfig({
        environment: 'development',
        source: 'repo',
        root,
        vars: {},
      }),
    (err) => err instanceof ConfigError && err.message.includes('MISSING PROJECT_WORKDIR'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local restore requires PROJECT_WORKDIR for r2 sources with otherwise valid R2 credentials', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: undefined });
  assert.throws(
    () =>
      loadLocalRestoreConfig({
        environment: 'development',
        source: 'r2',
        root,
        vars: {},
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('MISSING PROJECT_WORKDIR'), err.message);
      assert.ok(!err.message.includes('CLOUDFLARE_ACCOUNT_ID'), err.message);
      assert.ok(!err.message.includes('R2_'), err.message);
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup requires PROJECT_WORKDIR', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: undefined });
  assert.throws(
    () => loadLocalBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('MISSING PROJECT_WORKDIR'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: hosted loaders stay valid without PROJECT_WORKDIR', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: undefined });
  const backupCfg = loadBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(backupCfg.projectWorkdir, undefined);
  const restoreCfg = loadHostedRestoreConfig({
    environment: 'development',
    source: 'r2',
    root,
    vars: {},
  });
  assert.equal(restoreCfg.projectWorkdir, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup succeeds with only its own requirements', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: EXAMPLE_PROJECT_WORKDIR });
  const cfg = loadLocalBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(cfg.environment, 'development');
  assert.equal(cfg.projectRef, REF_DEV);
  assert.equal(cfg.ageRecipient, 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(cfg.projectWorkdir, path.resolve(root, EXAMPLE_PROJECT_WORKDIR));
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup never resolves, validates, or returns hosted/R2/private fields', () => {
  const root = makeRoot();
  devFile(root, {
    SUPABASE_DB_URL: 'not-a-url',
    CLOUDFLARE_ACCOUNT_ID: 'not-an-account-id',
    R2_ACCESS_KEY_ID: 'x',
    R2_SECRET_ACCESS_KEY: 'y',
    R2_BUCKET: 'production',
    DECRYPT_KEY: 'not-an-age-identity',
    PROJECT_WORKDIR: EXAMPLE_PROJECT_WORKDIR,
  });

  const cfg = loadLocalBackupConfig({
    environment: 'development',
    root,
    vars: {
      SUPABASE_DB_URL: 'also-not-a-url',
      R2_ACCESS_KEY_ID: 'z',
      R2_SECRET_ACCESS_KEY: 'q',
      R2_BUCKET: 'not-development',
      DECRYPT_KEY: 'also-not-an-age-identity',
    },
  });

  assert.deepEqual(cfg, {
    environment: 'development',
    projectRef: REF_DEV,
    ageRecipient: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    projectWorkdir: path.resolve(root, EXAMPLE_PROJECT_WORKDIR),
  });
  for (const name of [
    'dbUrl',
    'accountId',
    'bucket',
    'accessKeyId',
    'secretAccessKey',
    'ageIdentity',
    'r2Endpoint',
  ]) {
    assert.ok(!Object.hasOwn(cfg, name), `local backup config exposed ${name}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup resolves relative and absolute workdirs', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: EXAMPLE_PROJECT_WORKDIR });
  const cfg = loadLocalBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(path.resolve(root, EXAMPLE_PROJECT_WORKDIR), cfg.projectWorkdir);

  const absolute = path.join(root, 'elsewhere', 'example-project');
  devFile(root, { PROJECT_WORKDIR: absolute });
  const absCfg = loadLocalBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(absCfg.projectWorkdir, absolute);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup fails on missing/invalid ref, recipient, or environment without leaks', () => {
  const root = makeRoot();
  const badRecipient = 'not-an-age-key';
  devFile(root, { ENCRYPT_KEY: badRecipient });
  assert.throws(
    () => loadLocalBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('ENCRYPT_KEY'), err.message);
      assert.ok(!err.message.includes(badRecipient), 'recipient leaked');
      return true;
    },
  );
  devFile(root, { SUPABASE_PROJECT_REF: 'not-a-ref' });
  assert.throws(
    () => loadLocalBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('SUPABASE_PROJECT_REF'), err.message);
      assert.ok(!err.message.includes('not-a-ref'), 'ref leaked');
      return true;
    },
  );
  devFile(root, { SUPABASE_PROJECT_REF: undefined });
  assert.throws(
    () => loadLocalBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('SUPABASE_PROJECT_REF'),
  );
  devFile(root, { BACKUP_ENVIRONMENT: 'production' });
  assert.throws(
    () => loadLocalBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('BACKUP_ENVIRONMENT'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup consumed disagreements conflict; unused ones never do', () => {
  const root = makeRoot();
  devFile(root);
  // Consumed variables disagree -> CONFLICT (names only).
  assert.throws(
    () =>
      loadLocalBackupConfig({
        environment: 'development',
        root,
        vars: { SUPABASE_PROJECT_REF: 'fedcba9876543210fedc' },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes(`${CONFLICT_PREFIX} SUPABASE_PROJECT_REF`), err.message);
      assert.ok(!err.message.includes('fedcba9876543210fedc'), 'value leaked');
      return true;
    },
  );
  assert.throws(
    () =>
      loadLocalBackupConfig({
        environment: 'development',
        root,
        vars: { ENCRYPT_KEY: `age0${'z'.repeat(40)}` },
      }),
    (err) => err instanceof ConfigError && err.message.includes(`${CONFLICT_PREFIX} ENCRYPT_KEY`),
  );
  assert.throws(
    () =>
      loadLocalBackupConfig({
        environment: 'development',
        root,
        vars: { PROJECT_WORKDIR: '../other' },
      }),
    (err) =>
      err instanceof ConfigError && err.message.includes(`${CONFLICT_PREFIX} PROJECT_WORKDIR`),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: unknown environment values are rejected', () => {
  const root = makeRoot();
  devFile(root);
  assert.throws(
    () => loadBackupConfig({ environment: 'staging', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('environment'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: REPOSITORY_ROOT resolves to the repository (contains package.json)', () => {
  assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, 'package.json')));
});
