/**
 * Shared disposable Supabase integration fixture.
 *
 * Owns ONLY the repeated fixture mechanics used by both Docker integration
 * tests: the config.toml builder, one generic seed (public rows, Auth user,
 * migration history, trigger function + triggers), the disposable workdir,
 * and a quiet command runner that keeps generated local keys and psql output
 * out of test logs. Dump/package/restore assertions stay in the two
 * integration tests.
 *
 * Importing this module is side-effect free: workdir creation, CLI/Docker
 * resolution, and every command happen only inside the fixture factory,
 * which the tests call after their skip evaluation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCommand, lookupExecutable } from './process.js';
import { tmpdir } from './test-fixtures.js';
import { POSTGRES_MAJOR_VERSION } from './snapshot.js';

/** Application table seeded by every fixture. */
export const FIXTURE_TABLE = 'public.records';
/** Deterministic row values shared by both integration tests. */
export const FIXTURE_ROW_VALUES = Object.freeze(['alpha', 'beta', 'gamma']);
/** Auth email sentinel; never a real address. */
export const FIXTURE_AUTH_EMAIL = 'fixture-user@example.test';
/** Synthetic migration version recorded in the seed. */
export const FIXTURE_MIGRATION_VERSION = '20260824000000';
/** Trigger names created by the seed; assertions must consume these. */
export const FIXTURE_TRIGGER_NAMES = Object.freeze([
  'test_auth_user_inserted',
  'test_auth_user_deleted',
]);

const START_TIMEOUT_MS = 400000;

/** Pure TOML builder preserving the settings both integration tests use. */
function buildSupabaseConfigToml({ projectId, ports }) {
  return [
    `project_id = "${projectId}"`,
    '',
    '[api]',
    'enabled = false',
    `port = ${ports.api}`,
    'schemas = ["public", "graphql_public"]',
    'extra_search_path = ["public", "extensions"]',
    'max_rows = 1000',
    '',
    '[db]',
    `port = ${ports.db}`,
    `shadow_port = ${ports.shadow}`,
    'health_timeout = "2m"',
    `major_version = ${POSTGRES_MAJOR_VERSION}`,
    '',
    '[db.pooler]',
    'enabled = false',
    `port = ${ports.pooler}`,
    'pool_mode = "transaction"',
    'default_pool_size = 20',
    'max_client_conn = 100',
    '',
    '[db.migrations]',
    'enabled = true',
    'schema_paths = []',
    '',
    '[db.seed]',
    'enabled = false',
    'sql_paths = []',
    '',
    '[realtime]',
    'enabled = false',
    '',
    '[studio]',
    'enabled = false',
    `port = ${ports.studio}`,
    '',
    '[storage]',
    'enabled = false',
    'file_size_limit = "50MiB"',
    '',
    '[auth]',
    'enabled = true',
    'site_url = "http://localhost"',
    'jwt_expiry = 3600',
    'enable_refresh_token_rotation = true',
    'enable_signup = true',
    '',
    '[local_smtp]',
    'enabled = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[storage.analytics]',
    'enabled = false',
    '',
    '[storage.vector]',
    'enabled = false',
    '',
  ].join('\n');
}

/** One static seed: rows, auth user, migration history, and both triggers. */
const SEED_SQL = `
CREATE TABLE ${FIXTURE_TABLE}(id serial PRIMARY KEY, value text NOT NULL);
INSERT INTO ${FIXTURE_TABLE}(value) VALUES ${FIXTURE_ROW_VALUES.map((v) => `('${v}')`).join(', ')};
INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', '${FIXTURE_AUTH_EMAIL}', 'crypt', now(), '{}', '{}', now(), now());
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY, statements text[] DEFAULT '{}'::text[] NOT NULL, name text);
INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('${FIXTURE_MIGRATION_VERSION}', 'integration fixture');
CREATE FUNCTION public.pass_through_auth_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ${FIXTURE_TRIGGER_NAMES[0]} AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.pass_through_auth_user();
CREATE TRIGGER ${FIXTURE_TRIGGER_NAMES[1]} AFTER DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.pass_through_auth_user();
`;

/**
 * Quiet runner: preserves file-stream and collected outputs, but replaces a
 * missing or inherited stdout with captured output. Keeps generated local
 * keys and psql output out of the test log without changing production
 * logging inside the modules under test.
 */
async function quietRun(options) {
  const stdout =
    options.stdout === undefined || options.stdout === 'inherit' ? 'collect' : options.stdout;
  return runCommand({ ...options, stdout });
}

/**
 * Create one disposable generic Supabase fixture. Call only after the
 * Docker/CLI availability skip; every returned helper uses argument arrays
 * through the shared safe runner. `run` is injectable for unit tests that
 * must never touch Docker.
 */
export function createSupabaseIntegrationFixture({ repoRoot, projectId, ports, run = quietRun }) {
  const workdir = tmpdir('supabase-integration-');
  fs.mkdirSync(path.join(workdir, 'supabase'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(workdir, 'supabase', 'config.toml'),
    buildSupabaseConfigToml({ projectId, ports }),
  );
  const supabaseBin = path.join(repoRoot, 'node_modules', '.bin', 'supabase');
  const dockerPath = lookupExecutable('docker');
  const dbContainer = `supabase_db_${projectId}`;
  const authContainer = `supabase_auth_${projectId}`;
  const dbUrl = `postgresql://postgres:postgres@127.0.0.1:${ports.db}/postgres`;

  /** Start the full disposable stack; generated keys are collected, never printed. */
  async function start() {
    await run({
      command: supabaseBin,
      args: ['start', '--workdir', workdir],
      stderr: 'collect',
      timeoutMs: START_TIMEOUT_MS,
    });
  }

  /** Stop the fixture-derived Auth container (deterministic single-writer mode). */
  async function stop() {
    await run({
      command: dockerPath,
      args: ['stop', authContainer],
      stderr: 'collect',
    });
  }

  /** Apply the generic seed over psql stdin inside the DB container. */
  async function executeSql(sql) {
    await run({
      command: dockerPath,
      args: [
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
      input: sql,
      stderr: 'collect',
    });
  }

  /** Seed the fixture database. */
  async function seed() {
    await executeSql(SEED_SQL);
  }

  /** Run one read-only query; returns trimmed `-t -A` output. */
  async function query(sql) {
    const res = await run({
      command: dockerPath,
      args: [
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
      ],
      stderr: 'collect',
    });
    return (res.stdout ?? '').trim();
  }

  /**
   * Teardown: stop the stack, remove only this fixture workdir, then surface
   * any stop failure. A failed stop must fail the test: silently swallowing
   * it would let a passing test leak running containers/volumes that poison
   * later runs. The pinned CLI exits 0 when the stack is already stopped, so
   * every nonzero exit here is a real failure.
   */
  async function remove() {
    let stopError = null;
    try {
      await run({
        command: supabaseBin,
        args: ['stop', '--workdir', workdir, '--no-backup'],
        stderr: 'collect',
      });
    } catch (err) {
      stopError = err;
    }
    fs.rmSync(workdir, { recursive: true, force: true });
    if (stopError) throw stopError;
  }

  return {
    workdir,
    supabaseBin,
    dockerPath,
    dbUrl,
    dbContainer,
    authContainer,
    dbPort: ports.db,
    run,
    start,
    stop,
    seed,
    executeSql,
    query,
    remove,
  };
}
