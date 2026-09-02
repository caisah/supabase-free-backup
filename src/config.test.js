import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBackupConfig,
  loadHostedRestoreConfig,
  loadLocalBackupConfig,
  loadLocalRestoreConfig,
  classifySharedPoolerUrl,
  ConfigError,
  CONFLICT_PREFIX,
  urlPassword,
  REPOSITORY_ROOT,
} from './config.js';

const REF_DEV = 'a1b2c3d4e5f6a7b8c9d0';
const REF_PROD = 'f0e9d8c7b6a5f4e3d2c1';
const PASSWORD = 'the-ultimate-secret-password';
const POOLER_HOST = 'aws-0-us-east-1.pooler.supabase.com';

function sharedPoolerUrl(projectRef, overrides = {}) {
  const {
    user = `postgres.${projectRef}`,
    host = POOLER_HOST,
    port = '5432',
    sslmode = 'require',
  } = overrides;
  return `postgresql://${user}:${PASSWORD}@${host}:${port}/postgres?sslmode=${sslmode}`;
}

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
    SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(REF_DEV),
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'development',
    R2_ACCESS_KEY_ID: 'dev-access-key-12345',
    R2_SECRET_ACCESS_KEY: 'dev-secret-key-abcdefghijklmnop',
    ENCRYPT_KEY: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    DECRYPT_KEY: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
    PROJECT_WORKDIR: '../project',
    ...overrides,
  });
}

/** Assert an error message is static: names only, no URL fragments/passwords/refs. */
function assertNoLeak(error, password = PASSWORD, ref = REF_DEV) {
  const msg = error.message;
  assert.ok(!msg.includes(password), 'password leaked');
  assert.ok(!msg.includes(ref), 'project ref leaked');
  assert.ok(!msg.includes('pooler.supabase.com'), 'host leaked');
  assert.ok(!msg.includes('supabase.co'), 'direct host leaked');
  assert.ok(!msg.includes('postgresql://'), 'URL leaked');
  assert.ok(!msg.includes('@'), 'URL userinfo leaked');
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
      assert.ok(msg.includes('SUPABASE_SHARED_POOLER_URL'), msg);
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
          SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(overriddenRef, {
            host: 'aws-0-eu-west-1.pooler.supabase.com',
            port: '5432',
          }),
        },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes(`${CONFLICT_PREFIX} SUPABASE_PROJECT_REF`), err.message);
      assert.ok(err.message.includes(`${CONFLICT_PREFIX} SUPABASE_SHARED_POOLER_URL`), err.message);
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
      SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(REF_DEV),
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
  devFile(root, { SUPABASE_SHARED_POOLER_URL: undefined });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('SUPABASE_SHARED_POOLER_URL'));
      assert.ok(!err.message.includes('postgres'));
      assert.ok(!err.message.includes(PASSWORD));
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
  const prod = makeRoot();
  writeEnv(prod, 'production', {
    BACKUP_ENVIRONMENT: 'production',
    SUPABASE_PROJECT_REF: REF_PROD,
    SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(REF_PROD),
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

test('config: mismatched project ref / shared pooler URL fails', () => {
  const root = makeRoot();
  devFile(root, {
    SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(REF_PROD),
  });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('SUPABASE_SHARED_POOLER_URL'), err.message);
      assert.ok(!err.message.includes(REF_PROD));
      assert.ok(!err.message.includes(PASSWORD));
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: urlPassword extracts the embedded password and never throws', () => {
  const dbUrl = sharedPoolerUrl(REF_DEV);
  assert.equal(urlPassword(dbUrl), PASSWORD);
  assert.equal(urlPassword('not a url at all'), null);
  // A URL without a password yields an empty string (falsy, filtered by callers).
  assert.equal(urlPassword(`postgresql://postgres.${REF_DEV}@db.example.com:5432/postgres`), '');
});

test('config: classifySharedPoolerUrl accepts the canonical Session forms', () => {
  // Explicit port 5432.
  let res = classifySharedPoolerUrl(
    `postgresql://postgres.${REF_DEV}:${PASSWORD}@aws-1-eu-west-3.pooler.supabase.com:5432/postgres?sslmode=require`,
    REF_DEV,
  );
  assert.deepEqual(res, { ok: true });
  // Omitted port resolves to the effective PostgreSQL port 5432.
  res = classifySharedPoolerUrl(
    `postgres://postgres.${REF_DEV}:${PASSWORD}@aws-1-eu-central-1.pooler.supabase.com/postgres?sslmode=verify-ca`,
    REF_DEV,
  );
  assert.deepEqual(res, { ok: true });
  // Every secure sslmode is accepted.
  for (const sslmode of ['require', 'verify-ca', 'verify-full']) {
    res = classifySharedPoolerUrl(sharedPoolerUrl(REF_DEV, { sslmode }), REF_DEV);
    assert.equal(res.ok, true, sslmode);
  }
  // Host case normalization: uppercase host still classifies.
  res = classifySharedPoolerUrl(
    `postgresql://postgres.${REF_DEV}:${PASSWORD}@AWS-1-EU-WEST-3.POOLER.SUPABASE.COM:5432/postgres?sslmode=require`,
    REF_DEV,
  );
  assert.equal(res.ok, true);
  // Exact project-ref match in the username is required.
  res = classifySharedPoolerUrl(sharedPoolerUrl(REF_DEV, { user: `postgres.${REF_DEV}` }), REF_DEV);
  assert.equal(res.ok, true);
});

test('config: classifySharedPoolerUrl reports every failure code without echoing the URL', () => {
  const mk = (user, host, port, ssl = '?sslmode=require') =>
    `postgresql://${user}:${PASSWORD}@${host}:${port}/postgres${ssl}`;
  const cases = [
    ['unparsable', 'not a url at all::'],
    [
      'scheme',
      `https://postgres.${REF_DEV}:${PASSWORD}@pooler.supabase.com:5432/postgres?sslmode=require`,
    ],
    ['ssl', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '')],
    ['ssl', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=disable')],
    ['ssl', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=allow')],
    ['ssl', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=prefer')],
    ['ssl', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=unknown')],
    ['username', `postgresql://:${PASSWORD}@${POOLER_HOST}:5432/postgres?sslmode=require`],
    ['password', `postgresql://postgres.${REF_DEV}@${POOLER_HOST}:5432/postgres?sslmode=require`],
    ['host', mk('postgres', 'my-own-db.example.com', 5432)],
    // Direct supabase.co hosts (5432 direct and 6543 legacy pooler form).
    ['host', mk('postgres', `db.${REF_DEV}.supabase.co`, 5432)],
    ['host', mk(`postgres.${REF_DEV}`, `db.${REF_DEV}.supabase.co`, 6543)],
    // A transaction user on the transaction port reports the user form first.
    ['transaction-pooler', mk(`postgres.${REF_DEV}.transaction`, POOLER_HOST, 6543)],
    ['pooler-port', mk(`postgres.${REF_DEV}`, POOLER_HOST, 6543)],
    ['transaction-pooler', mk(`postgres.${REF_DEV}.transaction`, POOLER_HOST, 5432)],
    // libpq parses query options and lets later values override earlier
    // connection settings, so anything beyond exactly one sslmode is unsafe.
    [
      'params',
      mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=require&host=evil.example.com'),
    ],
    ['params', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=require&port=6543')],
    ['params', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=require&sslmode=disable')],
    [
      'params',
      mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=require&dbname=other_database'),
    ],
    ['params', mk(`postgres.${REF_DEV}`, POOLER_HOST, 5432, '?sslmode=require&foo=1')],
    [
      'params',
      `postgresql://postgres.${REF_DEV}:${PASSWORD}@${POOLER_HOST}:5432/postgres?host=evil.example.com`,
    ],
    // A comma-separated authority is a libpq multi-host list, not one host.
    [
      'multihost',
      mk(`postgres.${REF_DEV}`, 'evil.example.com,aws-0-us-east-1.pooler.supabase.com', 5432),
    ],
    // Only the canonical /postgres database is accepted.
    [
      'dbname',
      `postgresql://postgres.${REF_DEV}:${PASSWORD}@${POOLER_HOST}:5432/other_database?sslmode=require`,
    ],
    ['dbname', `postgresql://postgres.${REF_DEV}:${PASSWORD}@${POOLER_HOST}:5432?sslmode=require`],
    ['dbname', `postgresql://postgres.${REF_DEV}:${PASSWORD}@${POOLER_HOST}:5432/?sslmode=require`],
    ['pooler-user', mk('postgres', POOLER_HOST, 5432)],
    ['pooler-user', mk(`postgres.${REF_PROD}`, POOLER_HOST, 5432)],
    ['pooler-user', mk(`postgres.${REF_DEV}.session`, POOLER_HOST, 5432)],
    ['pooler-user', mk('someone-else', POOLER_HOST, 5432)],
  ];
  for (const [code, input] of cases) {
    assert.deepEqual(classifySharedPoolerUrl(input, REF_DEV), { ok: false, code }, code);
  }
});

test('config: every rejected hosted URL fails configuration without leaking', () => {
  const root = makeRoot();
  // One representative case per failure class; the exhaustive matrix lives at
  // the classifier layer. Effective-target invariants (multi-host, query
  // overrides, wrong database) are covered here because they are the
  // user-facing gate.
  const cases = [
    {
      name: 'transaction pooler',
      url: sharedPoolerUrl(REF_DEV, { user: `postgres.${REF_DEV}.transaction` }),
    },
    { name: 'plain postgres user', url: sharedPoolerUrl(REF_DEV, { user: 'postgres' }) },
    { name: 'transaction port 6543', url: sharedPoolerUrl(REF_DEV, { port: '6543' }) },
    {
      name: 'direct 5432',
      url: `postgres://postgres:${PASSWORD}@db.${REF_DEV}.supabase.co:5432/postgres?sslmode=require`,
    },
    { name: 'foreign host', url: sharedPoolerUrl(REF_DEV, { host: 'my-own-db.example.com' }) },
    { name: 'ssl disable', url: sharedPoolerUrl(REF_DEV, { sslmode: 'disable' }) },
    {
      name: 'query override',
      url: sharedPoolerUrl(REF_DEV, { sslmode: 'require&host=evil.example.com' }),
    },
    {
      name: 'multi-host authority',
      url: `postgresql://postgres.${REF_DEV}:${PASSWORD}@evil.example.com,${POOLER_HOST}:5432/postgres?sslmode=require`,
    },
    {
      name: 'wrong database path',
      url: `postgresql://postgres.${REF_DEV}:${PASSWORD}@${POOLER_HOST}:5432/other_database?sslmode=require`,
    },
    { name: 'unparsable', url: 'not a url at all::' },
    {
      name: 'missing password',
      url: `postgresql://postgres.${REF_DEV}@${POOLER_HOST}:5432/postgres?sslmode=require`,
    },
  ];
  for (const { name, url } of cases) {
    devFile(root, { SUPABASE_SHARED_POOLER_URL: url });
    assert.throws(
      () => loadBackupConfig({ environment: 'development', root, vars: {} }),
      (err) => {
        assert.ok(err instanceof ConfigError, name);
        assert.ok(err.message.includes('SUPABASE_SHARED_POOLER_URL'), name);
        assertNoLeak(err, PASSWORD, REF_DEV);
        return true;
      },
      name,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: the legacy SUPABASE_DB_URL variable is rejected by every hosted consumer', () => {
  const legacy = `postgresql://postgres.${REF_DEV}:${PASSWORD}@${POOLER_HOST}:6543/postgres?sslmode=require`;
  const root = makeRoot();
  // Backup (file source).
  devFile(root, { SUPABASE_DB_URL: legacy });
  assert.throws(
    () => loadBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.message.includes('UNSUPPORTED SUPABASE_DB_URL (rename to SUPABASE_SHARED_POOLER_URL)'),
        err.message,
      );
      assertNoLeak(err);
      return true;
    },
  );
  // Hosted restore sources (r2/repo/local).
  for (const source of ['r2', 'repo', 'local']) {
    assert.throws(
      () => loadHostedRestoreConfig({ environment: 'development', source, root, vars: {} }),
      (err) => {
        assert.ok(err instanceof ConfigError, source);
        assert.ok(err.message.includes('UNSUPPORTED SUPABASE_DB_URL'), source);
        return true;
      },
      source,
    );
  }
  // Process source for a hosted consumer, with the new variable also present:
  // stale configuration must still fail (the check is not scoped to absence).
  devFile(root, {
    SUPABASE_DB_URL: undefined,
    SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(REF_DEV),
  });
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: {
          SUPABASE_DB_URL: legacy,
          SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(REF_DEV),
        },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.message.includes('UNSUPPORTED SUPABASE_DB_URL (rename to SUPABASE_SHARED_POOLER_URL)'),
        err.message,
      );
      assertNoLeak(err);
      return true;
    },
  );
  // The old variable alone, new field absent entirely.
  assert.throws(
    () =>
      loadBackupConfig({
        environment: 'development',
        root,
        vars: {
          SUPABASE_PROJECT_REF: REF_DEV,
          SUPABASE_DB_URL: legacy,
        },
      }),
    (err) => err instanceof ConfigError && err.message.includes('UNSUPPORTED SUPABASE_DB_URL'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: loadLocalBackupConfig ignores hosted URL fields entirely', () => {
  const root = makeRoot();
  devFile(root, {
    SUPABASE_DB_URL: `postgresql://postgres.${REF_DEV}:${PASSWORD}@${POOLER_HOST}:6543/postgres?sslmode=require`,
    SUPABASE_SHARED_POOLER_URL: 'not-a-valid-pooler-url',
  });
  const cfg = loadLocalBackupConfig({
    environment: 'development',
    root,
    vars: {
      SUPABASE_DB_URL: 'another-stale-value',
      SUPABASE_SHARED_POOLER_URL: 'also-not-valid',
    },
  });
  assert.equal(cfg.environment, 'development');
  assert.equal(cfg.projectRef, REF_DEV);
  assert.ok(!Object.hasOwn(cfg, 'sharedPoolerUrl'), 'hosted URL must not be exposed');
  assert.ok(!Object.hasOwn(cfg, 'dbUrl'), 'legacy key must not be exposed');
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

test('config: local backup succeeds with only its own requirements', () => {
  const root = makeRoot();
  devFile(root);
  const cfg = loadLocalBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(cfg.environment, 'development');
  assert.equal(cfg.projectRef, REF_DEV);
  assert.equal(cfg.ageRecipient, undefined, 'ENCRYPT_KEY is not consumed by local backup');
  assert.equal(cfg.projectWorkdir, path.join(root, '..', 'project'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup returns only consumed fields', () => {
  const root = makeRoot();
  devFile(root, {
    SUPABASE_SHARED_POOLER_URL: 'not-a-url',
    SUPABASE_DB_URL: 'legacy-not-a-url',
    CLOUDFLARE_ACCOUNT_ID: 'not-an-account-id',
    R2_ACCESS_KEY_ID: 'x',
    R2_SECRET_ACCESS_KEY: 'y',
    R2_BUCKET: 'production',
    ENCRYPT_KEY: 'not-an-age-key',
    DECRYPT_KEY: 'not-an-age-identity',
  });

  const cfg = loadLocalBackupConfig({
    environment: 'development',
    root,
    vars: {
      SUPABASE_SHARED_POOLER_URL: 'also-not-a-url',
      SUPABASE_DB_URL: 'also-legacy',
      R2_ACCESS_KEY_ID: 'z',
      R2_SECRET_ACCESS_KEY: 'q',
      R2_BUCKET: 'not-development',
      ENCRYPT_KEY: 'also-not-an-age-key',
      DECRYPT_KEY: 'also-not-an-age-identity',
    },
  });

  assert.deepEqual(cfg, {
    environment: 'development',
    projectRef: REF_DEV,
    projectWorkdir: path.resolve(root, '../project'),
  });
  for (const name of [
    'sharedPoolerUrl',
    'dbUrl',
    'accountId',
    'bucket',
    'accessKeyId',
    'secretAccessKey',
    'ageRecipient',
    'ageIdentity',
    'r2Endpoint',
  ]) {
    assert.ok(!Object.hasOwn(cfg, name), `local backup config exposed ${name}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup resolves an explicit workdir and requires PROJECT_WORKDIR', () => {
  const root = makeRoot();
  devFile(root, { PROJECT_WORKDIR: '../project-proj' });
  const cfg = loadLocalBackupConfig({ environment: 'development', root, vars: {} });
  assert.equal(path.resolve(root, '../project-proj'), cfg.projectWorkdir);

  devFile(root, { PROJECT_WORKDIR: undefined });
  assert.throws(
    () => loadLocalBackupConfig({ environment: 'development', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('MISSING PROJECT_WORKDIR'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local backup fails on missing/invalid ref or environment without leaks', () => {
  const root = makeRoot();
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
        vars: { PROJECT_WORKDIR: '../other' },
      }),
    (err) =>
      err instanceof ConfigError && err.message.includes(`${CONFLICT_PREFIX} PROJECT_WORKDIR`),
  );
  // ENCRYPT_KEY is no longer consumed: a differing process export neither
  // conflicts nor blocks the run (names-only scoping covers this).
  const cfg = loadLocalBackupConfig({
    environment: 'development',
    root,
    vars: { ENCRYPT_KEY: `age0${'z'.repeat(40)}` },
  });
  assert.equal(cfg.environment, 'development');
  assert.equal(cfg.projectRef, REF_DEV);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: hosted local source never consumes DECRYPT_KEY (legacy encrypted-local path removed)', () => {
  const root = makeRoot();
  devFile(root); // the default file carries a valid DECRYPT_KEY in the dotenv
  const cfg = loadHostedRestoreConfig({
    environment: 'development',
    source: 'local',
    root,
    vars: {},
  });
  assert.equal(
    cfg.ageIdentity,
    undefined,
    'the legacy encrypted-local compatibility path is removed; local snapshots are plaintext',
  );
  assert.ok(!Object.hasOwn(cfg, 'ageIdentity'), 'age identity is never exposed for local');
  // DECRYPT_KEY is not consumed, so a conflicting process export is NOT a
  // conflict for the local source (the variable is out of scope).
  const cfg2 = loadHostedRestoreConfig({
    environment: 'development',
    source: 'local',
    root,
    vars: { DECRYPT_KEY: 'AGE-SECRET-KEY-1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' },
  });
  assert.equal(cfg2.ageIdentity, undefined);
  assert.equal(cfg2.projectRef, REF_DEV);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local restore consumes workdir + source credentials, never the hosted URL', () => {
  const root = makeRoot();
  devFile(root, {
    SUPABASE_SHARED_POOLER_URL: 'not-a-valid-pooler-url',
    SUPABASE_PROJECT_REF: REF_DEV,
    R2_ACCESS_KEY_ID: 'dev-access-key-12345',
    R2_SECRET_ACCESS_KEY: 'dev-secret-key-abcdefghijklmnop',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'development',
  });
  const r2Cfg = loadLocalRestoreConfig({
    environment: 'development',
    source: 'r2',
    root,
    vars: {},
  });
  assert.equal(r2Cfg.environment, 'development');
  assert.equal(r2Cfg.bucket, 'development');
  assert.equal(r2Cfg.accessKeyId, 'dev-access-key-12345');
  assert.equal(r2Cfg.projectWorkdir, path.resolve(root, '..', 'project'));
  assert.equal(r2Cfg.ageIdentity, 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
  for (const name of ['projectRef', 'sharedPoolerUrl']) {
    assert.ok(!Object.hasOwn(r2Cfg, name), `r2 local restore exposed ${name}`);
  }
  const repoCfg = loadLocalRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: {},
  });
  assert.equal(repoCfg.projectWorkdir, r2Cfg.projectWorkdir);
  for (const name of ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey', 'projectRef']) {
    assert.ok(!Object.hasOwn(repoCfg, name), `repo local restore exposed ${name}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local restore requires the age identity and workdir; r2 also needs credentials', () => {
  const root = makeRoot();
  devFile(root, { DECRYPT_KEY: undefined });
  assert.throws(
    () => loadLocalRestoreConfig({ environment: 'development', source: 'repo', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('DECRYPT_KEY'),
  );
  devFile(root, { PROJECT_WORKDIR: undefined });
  assert.throws(
    () => loadLocalRestoreConfig({ environment: 'development', source: 'repo', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('PROJECT_WORKDIR'),
  );
  devFile(root, {
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
    R2_BUCKET: undefined,
  });
  const repoCfg = loadLocalRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: {},
  });
  assert.equal(repoCfg.accessKeyId, undefined);
  assert.throws(
    () => loadLocalRestoreConfig({ environment: 'development', source: 'r2', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('R2_ACCESS_KEY_ID'),
  );
  assert.throws(
    () => loadLocalRestoreConfig({ environment: 'development', source: 'local', root, vars: {} }),
    (err) => err instanceof ConfigError && /r2, repo/.test(err.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local restore workdir comes from the fixed local-stack environment, never the snapshot environment', () => {
  const root = makeRoot();
  // The local stack lives in the development file; the production file has
  // its own (different) workdir plus the production source credentials.
  devFile(root, { PROJECT_WORKDIR: '../dev-project' });
  writeEnv(root, 'production', {
    BACKUP_ENVIRONMENT: 'production',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'production',
    R2_ACCESS_KEY_ID: 'prod-access-key-12345',
    R2_SECRET_ACCESS_KEY: 'prod-secret-key-abcdefghijklmnop',
    DECRYPT_KEY: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
    PROJECT_WORKDIR: '../prod-project',
  });
  const cfg = loadLocalRestoreConfig({
    environment: 'production',
    source: 'r2',
    root,
    vars: {},
  });
  // Source side: the production snapshot credentials.
  assert.equal(cfg.environment, 'production');
  assert.equal(cfg.bucket, 'production');
  assert.equal(cfg.accessKeyId, 'prod-access-key-12345');
  // Target side: the destructive target is ALWAYS the local-stack workdir.
  assert.equal(cfg.projectWorkdir, path.resolve(root, '..', 'dev-project'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: local restore never requires or exposes the encryption recipient', () => {
  const root = makeRoot();
  devFile(root, { ENCRYPT_KEY: undefined });
  const cfg = loadLocalRestoreConfig({
    environment: 'development',
    source: 'repo',
    root,
    vars: {},
  });
  assert.equal(cfg.ageRecipient, undefined, 'restore only decrypts');
  assert.ok(!Object.hasOwn(cfg, 'ageRecipient'), 'recipient never exposed');
  assert.equal(cfg.ageIdentity, 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: hosted local-source restore consumes only ref, URL, and environment', () => {
  const root = makeRoot();
  devFile(root, { DECRYPT_KEY: undefined });
  const cfg = loadHostedRestoreConfig({
    environment: 'development',
    source: 'local',
    root,
    vars: {},
  });
  assert.equal(cfg.environment, 'development');
  assert.equal(cfg.projectRef, REF_DEV);
  assert.equal(cfg.sharedPoolerUrl, sharedPoolerUrl(REF_DEV));
  assert.equal(cfg.projectWorkdir, undefined);
  for (const name of [
    'accountId',
    'bucket',
    'accessKeyId',
    'secretAccessKey',
    'ageRecipient',
    'ageIdentity',
    'r2Endpoint',
  ]) {
    assert.ok(!Object.hasOwn(cfg, name), `local-source restore config exposed ${name}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: hosted local source requires shared pooler URL and ref, and ignores R2 disagreements', () => {
  const root = makeRoot();
  devFile(root, { SUPABASE_SHARED_POOLER_URL: undefined });
  assert.throws(
    () => loadHostedRestoreConfig({ environment: 'development', source: 'local', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('SUPABASE_SHARED_POOLER_URL'),
  );
  devFile(root, { SUPABASE_PROJECT_REF: undefined });
  assert.throws(
    () => loadHostedRestoreConfig({ environment: 'development', source: 'local', root, vars: {} }),
    (err) => err instanceof ConfigError && err.message.includes('SUPABASE_PROJECT_REF'),
  );
  // R2 credentials are not consumed: a differing process export is not a conflict.
  devFile(root);
  const cfg = loadHostedRestoreConfig({
    environment: 'development',
    source: 'local',
    root,
    vars: {
      R2_ACCESS_KEY_ID: 'different-access-key-98765',
      R2_SECRET_ACCESS_KEY: 'different-secret-key-9876543210',
      R2_BUCKET: 'production',
    },
  });
  assert.equal(cfg.environment, 'development');
  assert.equal(cfg.projectRef, REF_DEV);
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

test('config: process-only hosted configuration works without any dotenv file', () => {
  const root = makeRoot();
  const cfg = loadBackupConfig({
    environment: 'development',
    root,
    vars: {
      BACKUP_ENVIRONMENT: 'development',
      SUPABASE_PROJECT_REF: REF_DEV,
      SUPABASE_SHARED_POOLER_URL: sharedPoolerUrl(REF_DEV),
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      R2_BUCKET: 'development',
      R2_ACCESS_KEY_ID: 'dev-access-key-12345',
      R2_SECRET_ACCESS_KEY: 'dev-secret-key-abcdefghijklmnop',
      ENCRYPT_KEY: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
  });
  assert.equal(cfg.sharedPoolerUrl, sharedPoolerUrl(REF_DEV));
  assert.equal(cfg.environment, 'development');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: REPOSITORY_ROOT resolves to the repository (contains package.json)', () => {
  assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, 'package.json')));
});
