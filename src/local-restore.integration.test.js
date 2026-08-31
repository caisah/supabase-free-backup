/**
 * Integration test for the local Fragtrack restore flow (sub-plan 08).
 *
 * Uses a DISPOSABLE fixture workdir (never the developer's real ../fragtrack):
 * start a local Supabase stack, seed public rows, Auth users, migration
 * history, and the custom Fragtrack auth triggers; dump + package + verify the
 * snapshot through the prior modules; destroy the fixture DB volume; restore
 * through the local flow; restart full services; verify data, history, and
 * triggers survived; clean every fixture artifact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand, lookupExecutable } from './process.js';
import { dumpDatabase } from './database.js';
import { packageSnapshot, unpackAndVerify } from './snapshot.js';
import { restoreLocalStack } from './local-restore.js';
import { generateCleanupSql } from './hosted-restore.js';
import { AGE_RECIPIENT_1, AGE_IDENTITY_1, writePrivateFile, tmpdir } from './test-fixtures.js';

const FIXTURE_CONFIG = `
project_id = "fragtrack-backup-local-test"

[api]
enabled = false
port = 57321
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 57322
shadow_port = 57320
health_timeout = "2m"
major_version = 17

[db.pooler]
enabled = false
port = 57329
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
port = 57323

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
  VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'local-restore-fixture@example.com', 'crypt', now(), '{}', '{}', now(), now());
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY, statements text[] DEFAULT '{}'::text[] NOT NULL, name text);
INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('20260824000000', 'local integration fixture');
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER create_account_for_new_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER cleanup_deleted_user_vouches AFTER DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
`;

const dockerAvailable = lookupExecutable('docker') !== null;
const repoRoot = process.cwd();
const cliAvailable = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'supabase'));

async function psqlExec(dbContainer, sql) {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    'docker',
    [
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
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let err = '';
  child.stderr.on('data', (c) => {
    err += c;
  });
  child.stdin.end(sql);
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`psql failed (${code}): ${err.slice(-1500)}`);
}

test(
  'integration: local restore reproduces data, history, and auth triggers in a fixture stack',
  { skip: !dockerAvailable || !cliAvailable, timeout: 1200000 },
  async () => {
    const fixtureDir = tmpdir('bp-local-fx-');
    fs.mkdirSync(path.join(fixtureDir, 'supabase'), { mode: 0o700 });
    fs.writeFileSync(path.join(fixtureDir, 'supabase', 'config.toml'), FIXTURE_CONFIG);
    const supabaseBin = path.join(repoRoot, 'node_modules', '.bin', 'supabase');
    const dockerPath = lookupExecutable('docker');
    const dbUrl = 'postgresql://postgres:postgres@127.0.0.1:57322/postgres';
    const dbContainer = 'supabase_db_fragtrack-backup-local-test';

    try {
      // 1. Start the disposable stack.
      await runCommand({
        command: supabaseBin,
        args: ['start', '--workdir', fixtureDir],
        stdout: 'inherit',
        stderr: 'collect',
      });
      await psqlExec(dbContainer, SEED_SQL);

      // 2. Dump + package + verify-decrypt through the prior modules.
      const dumpDir = path.join(fixtureDir, 'dumps');
      fs.mkdirSync(dumpDir, { mode: 0o700 });
      const dump = await dumpDatabase({
        dbUrl,
        cwd: repoRoot,
        outDir: dumpDir,
        supabasePath: supabaseBin,
        dockerPath,
        run: runCommand,
      });
      const pkgDir = path.join(fixtureDir, 'pkg');
      await packageSnapshot({
        sourceDir: dumpDir,
        destDir: pkgDir,
        snapshotId: '2026-08-24T03-17-09Z',
        environment: 'development',
        sourceProjectRef: 'a1b2c3d4e5f6a7b8c9d0',
        supabaseCliVersion: dump.cliVersion,
        ageRecipient: AGE_RECIPIENT_1,
      });
      const identityFile = writePrivateFile(
        path.join(fixtureDir, 'identity.txt'),
        `${AGE_IDENTITY_1}\n`,
      );
      const prepared = await unpackAndVerify({
        sourceDir: pkgDir,
        destDir: path.join(fixtureDir, 'prepared'),
        identityFile,
        expectedEnvironment: 'development',
      });
      // 3. Destroy the fixture DB volume and restore through the local flow.
      //    The prepared roles are commented against the fresh baseline inside
      //    restoreLocalStack; only the cleanup list is pre-generated here.
      const cleanupFile = path.join(fixtureDir, 'cleanup.sql');
      fs.writeFileSync(
        cleanupFile,
        generateCleanupSql({ dataSql: fs.readFileSync(prepared.dataPath, 'utf8') }),
        { mode: 0o600 },
      );
      await restoreLocalStack({
        supabasePath: supabaseBin,
        workdir: fixtureDir,
        prepared,
        cleanupFile,
        dockerPath,
        dbContainer,
        dbPort: 57322,
        run: runCommand,
        logger: { status() {}, warn() {}, error() {}, addSecret() {}, redact: (t) => t },
      });

      // 4. Verify the restored stack contents.
      const { spawn } = await import('node:child_process');
      const query = (sql) =>
        new Promise((resolve, reject) => {
          const child = spawn('docker', [
            'exec',
            dbContainer,
            'psql',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-t',
            '-A',
            '-c',
            sql,
          ]);
          let out = '';
          let err = '';
          child.stdout.on('data', (c) => {
            out += c;
          });
          child.stderr.on('data', (c) => {
            err += c;
          });
          child.on('close', (code) =>
            code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-800))),
          );
        });
      const publicRows = await query('SELECT name FROM public.perfumes ORDER BY name');
      assert.ok(
        publicRows.includes('Rose') && publicRows.includes('Oud') && publicRows.includes('Amber'),
        `public rows lost: ${publicRows}`,
      );
      const authRows = await query('SELECT email FROM auth.users');
      assert.ok(
        authRows.includes('local-restore-fixture@example.com'),
        `auth rows lost: ${authRows}`,
      );
      const history = await query('SELECT version FROM supabase_migrations.schema_migrations');
      assert.ok(history.includes('20260824000000'), `migration history lost: ${history}`);
      const triggers = await query(
        "SELECT tgname FROM pg_trigger WHERE tgname LIKE 'create_account%' OR tgname LIKE 'cleanup_deleted%' ORDER BY tgname",
      );
      assert.ok(triggers.includes('create_account_for_new_user'), triggers);
      assert.ok(triggers.includes('cleanup_deleted_user_vouches'), triggers);

      // 5. Full services restart health: the stack was started by the flow.
      const { exec } = await import('node:child_process');
      const containers = await new Promise((resolve) => {
        exec('docker ps --format {{.Names}}', (_e, stdout) => resolve(stdout ?? ''));
      });
      assert.ok(containers.includes(dbContainer), 'database container must run after restore');
    } finally {
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
