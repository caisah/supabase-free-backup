/**
 * Integration test for the Supabase dump adapter (sub-plan 03).
 *
 * Starts a DISPOSABLE local Supabase stack (Postgres 17) in an isolated
 * fixture workdir, seeds a small public schema, rows, migration history, Auth
 * users, and the custom Fragtrack `auth.users` triggers, then dumps through
 * the adapter, packages through sub-plan 02, and verifies the packaged output
 * contains no plaintext row data.
 *
 * Never connects to hosted development or production. Requires Docker and the
 * pinned Supabase CLI; skipped otherwise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand, lookupExecutable } from './process.js';
import { dumpDatabase } from './database.js';
import { readLocalDatabaseState } from './local-backup.js';
import {
  packageSnapshot,
  unpackAndVerify,
  validatePackagedDirectory,
  PLAINTEXT_ARTIFACTS,
} from './snapshot.js';
import { AGE_RECIPIENT_1, AGE_IDENTITY_1, writePrivateFile, tmpdir } from './test-fixtures.js';

const FIXTURE_CONFIG = `
project_id = "fragtrack-backup-test"

[api]
enabled = false
port = 56321
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 56322
shadow_port = 56320
health_timeout = "2m"
major_version = 17

[db.pooler]
enabled = false
port = 56329
pool_mode = "transaction"
default_pool_size = 20
max_client_conn = 100

[db.migrations]
enabled = true
schema_paths = []

[db.seed]
enabled = false
sql_paths = []

[realtime]
enabled = false

[studio]
enabled = false
port = 56323

[storage]
enabled = false
file_size_limit = "50MiB"

[auth]
enabled = true
site_url = "http://localhost"
jwt_expiry = 3600
enable_refresh_token_rotation = true
enable_signup = true

[local_smtp]
enabled = false

[analytics]
enabled = false

[storage.analytics]
enabled = false

[storage.vector]
enabled = false
`;

const SEED_SQL = `
CREATE TABLE public.perfumes(id serial PRIMARY KEY, name text NOT NULL);
INSERT INTO public.perfumes(name) VALUES ('Rose'),('Oud'),('Amber');
INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'secret-fixture-user@example.com', 'crypt', now(), '{}', '{}', now(), now());
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY, statements text[] DEFAULT '{}'::text[] NOT NULL, name text);
INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('20260824000000', 'integration fixture');
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER create_account_for_new_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER cleanup_deleted_user_vouches AFTER DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
`;

const dockerAvailable = lookupExecutable('docker') !== null;
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cliAvailable = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'supabase'));

async function psql(fixtureDir, sql) {
  // Feed SQL through psql inside the fixture database container.
  const dbContainer = 'supabase_db_fragtrack-backup-test';
  const { spawn } = await import('node:child_process');
  const args = [
    'exec',
    '-i',
    dbContainer,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
  ];
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => {
    out += c;
  });
  child.stderr.on('data', (c) => {
    err += c;
  });
  // Feed SQL first, then wait for psql to finish (EOF on stdin commits).
  child.stdin.end(sql);
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`psql failed (${code}): ${err.slice(-2000)}`);
  }
  return out;
}

test(
  'integration: supabase dump adapter produces all six logical outputs with managed triggers',
  { skip: !dockerAvailable || !cliAvailable, timeout: 900000 },
  async () => {
    const fixtureDir = tmpdir('bp-fx-');
    fs.mkdirSync(path.join(fixtureDir, 'supabase'), { mode: 0o700 });
    fs.writeFileSync(path.join(fixtureDir, 'supabase', 'config.toml'), FIXTURE_CONFIG);
    const supabaseBin = path.join(repoRoot, 'node_modules', '.bin', 'supabase');
    const dbUrl = 'postgresql://postgres:postgres@127.0.0.1:56322/postgres';
    const outDir = path.join(fixtureDir, 'out');
    fs.mkdirSync(outDir, { mode: 0o700 });

    try {
      // 1. Start the disposable stack.
      await runCommand({
        command: supabaseBin,
        args: ['start', '--workdir', fixtureDir],
        stdout: 'inherit',
        stderr: 'collect',
        timeoutMs: 400000,
      });

      const dockerPath = lookupExecutable('docker');
      const stateProbe = {
        dockerPath,
        dbContainer: 'supabase_db_fragtrack-backup-test',
        run: runCommand,
      };
      // The disposable fixture needs Auth's bootstrap migrations, but its
      // background maintenance would be a real concurrent writer. Stop only
      // that fixture service so the dump-stability assertion is deterministic.
      await runCommand({
        command: dockerPath,
        args: ['stop', 'supabase_auth_fragtrack-backup-test'],
        stdout: 'collect',
        stderr: 'collect',
      });

      // 2. Seed public rows, Auth users, migration history, custom triggers.
      const beforeSeedState = await readLocalDatabaseState(stateProbe);
      await psql(fixtureDir, SEED_SQL);
      const afterSeedState = await readLocalDatabaseState(stateProbe);
      assert.notEqual(afterSeedState, beforeSeedState, 'committed writes must change the token');

      // 3. Run the adapter and prove its six read-only commands leave the
      // conservative source-state token unchanged.
      const beforeDumpState = await readLocalDatabaseState(stateProbe);
      const result = await dumpDatabase({
        dbUrl,
        cwd: repoRoot,
        outDir,
        supabasePath: supabaseBin,
        dockerPath,
        run: runCommand,
      });
      const afterDumpState = await readLocalDatabaseState(stateProbe);
      assert.equal(afterDumpState, beforeDumpState, 'read-only dumps must not mutate the source');
      assert.equal(result.cliVersion, '2.114.0');
      assert.equal(result.postgresMajorVersion, 17);

      // 4. Verify roles/application schema/migration history/data outputs.
      const read = (key) => fs.readFileSync(result.files[key], 'utf8');
      assert.ok(read('roles').includes('ALTER ROLE'), 'roles dump captures role settings');
      assert.ok(read('roles').includes('anon'), 'anon role present');
      assert.ok(read('schema').includes('perfumes'), 'application schema captured');
      assert.ok(read('migrationHistorySchema').includes('schema_migrations'));
      assert.ok(read('migrationHistoryData').includes('20260824000000'));
      const data = read('databaseData');
      assert.ok(data.includes('COPY "public"."perfumes"'), 'public rows captured');
      assert.ok(data.includes('COPY "auth"."users"'), 'Auth rows captured');
      assert.ok(data.includes('secret-fixture-user@example.com'), 'Auth user row present');
      assert.ok(!data.includes('buckets_vectors'), 'vector tables excluded');

      // 5. The managed auth/storage delta captures BOTH Fragtrack triggers.
      const managed = read('managed');
      assert.ok(managed.includes('create_account_for_new_user'), 'trigger 1 in managed delta');
      assert.ok(managed.includes('cleanup_deleted_user_vouches'), 'trigger 2 in managed delta');

      // 6. Package through sub-plan 02 and verify row data is only encrypted.
      const snapshotId = '2026-08-24T03-17-09Z';
      const pkgDir = path.join(fixtureDir, 'pkg');
      await packageSnapshot({
        sourceDir: outDir,
        destDir: pkgDir,
        snapshotId,
        environment: 'development',
        sourceProjectRef: 'a1b2c3d4e5f6a7b8c9d0',
        supabaseCliVersion: result.cliVersion,
        ageRecipient: AGE_RECIPIENT_1,
      });
      const { manifest } = await validatePackagedDirectory(pkgDir);
      assert.equal(manifest.snapshotId, snapshotId);
      for (const name of PLAINTEXT_ARTIFACTS) {
        const content = fs.readFileSync(path.join(pkgDir, name), 'utf8');
        assert.ok(
          !content.includes('secret-fixture-user@example.com'),
          `${name} must not carry row data`,
        );
        assert.ok(!content.includes('COPY '), `${name} must not carry row data`);
      }
      const leftovers = fs.readdirSync(pkgDir);
      for (const forbidden of [
        'data.sql',
        'data.sql.gz',
        'data.sql.gz.age',
        'migration-history-data.sql',
        'database-data.sql',
      ]) {
        assert.ok(!leftovers.includes(forbidden), `${forbidden} must not be packaged`);
      }

      // Deterministic fingerprint: identical logical state packages to the
      // same contentSha256 even though ciphertext is randomized.
      const pkgDir2 = path.join(fixtureDir, 'pkg2');
      await packageSnapshot({
        sourceDir: outDir,
        destDir: pkgDir2,
        snapshotId,
        environment: 'development',
        sourceProjectRef: 'a1b2c3d4e5f6a7b8c9d0',
        supabaseCliVersion: result.cliVersion,
        ageRecipient: AGE_RECIPIENT_1,
      });
      const { manifest: manifest2 } = await validatePackagedDirectory(pkgDir2);
      assert.equal(manifest.contentSha256, manifest2.contentSha256);

      // 7. Full verification/decryption round trip reproduces the seeded state.
      const identityFile = writePrivateFile(
        path.join(fixtureDir, 'identity.txt'),
        `${AGE_IDENTITY_1}\n`,
      );
      const preparedDir = path.join(fixtureDir, 'prepared');
      const prepared = await unpackAndVerify({
        sourceDir: pkgDir,
        destDir: preparedDir,
        identityFile,
        expectedEnvironment: 'development',
      });
      const plaintext = fs.readFileSync(prepared.dataPath, 'utf8');
      assert.ok(plaintext.includes('COPY "auth"."users"'), 'auth rows restored');
      assert.ok(plaintext.includes('secret-fixture-user@example.com'), 'auth user value restored');
      assert.ok(plaintext.includes('COPY "public"."perfumes"'), 'public rows restored');
      assert.ok(plaintext.includes('20260824000000'), 'migration history restored');
    } finally {
      // 8. Clean the disposable stack and fixtures (never anything else).
      try {
        await runCommand({
          command: supabaseBin,
          args: ['stop', '--workdir', fixtureDir, '--no-backup'],
          stdout: 'inherit',
          stderr: 'collect',
        });
      } catch {
        // best-effort cleanup
      }
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);
