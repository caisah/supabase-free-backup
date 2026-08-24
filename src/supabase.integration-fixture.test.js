import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupabaseIntegrationFixture } from './supabase.integration-fixture.js';
import { POSTGRES_MAJOR_VERSION } from './snapshot.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = { api: 56331, db: 56332, shadow: 56330, pooler: 56339, studio: 56333 };

/**
 * Unit tests for the shared fixture mechanics. These NEVER touch Docker or
 * the Supabase CLI: `createSupabaseIntegrationFixture` only creates the
 * workdir at construction, and every command goes through the injectable
 * `run` option.
 */

test('fixture: remove() surfaces a failing stack stop after deleting the workdir', async () => {
  const fixture = createSupabaseIntegrationFixture({
    repoRoot,
    projectId: 'unit-test-project',
    ports: PORTS,
    run: async () => {
      throw new Error('simulated teardown stop failure');
    },
  });
  const workdir = fixture.workdir;
  assert.ok(fs.existsSync(workdir), 'fixture workdir must exist before remove()');
  await assert.rejects(
    () => fixture.remove(),
    /simulated teardown stop failure/,
    'a failed stack stop must fail the teardown so leaking containers are visible',
  );
  assert.ok(
    !fs.existsSync(workdir),
    'the fixture workdir must be removed even when the stack stop failed',
  );
});

test('fixture: remove() stops the stack and deletes the workdir', async () => {
  const calls = [];
  const fixture = createSupabaseIntegrationFixture({
    repoRoot,
    projectId: 'unit-test-project',
    ports: PORTS,
    run: async (opts) => {
      calls.push(opts.args);
      return { stdout: '' };
    },
  });
  const workdir = fixture.workdir;
  await fixture.remove();
  assert.ok(
    calls.some(
      (args) =>
        args.includes('stop') &&
        args.includes('--workdir') &&
        args.includes('--no-backup') &&
        args.includes(workdir),
    ),
    'remove() must stop the stack with the fixture workdir',
  );
  assert.ok(!fs.existsSync(workdir), 'the fixture workdir must be removed');
});

test('fixture: config.toml pins the shared Postgres major version', () => {
  const fixture = createSupabaseIntegrationFixture({
    repoRoot,
    projectId: 'unit-test-project',
    ports: PORTS,
    run: async () => ({ stdout: '' }),
  });
  try {
    const toml = fs.readFileSync(path.join(fixture.workdir, 'supabase', 'config.toml'), 'utf8');
    assert.ok(
      toml.includes(`major_version = ${POSTGRES_MAJOR_VERSION}`),
      'the fixture config must consume the shared production pin, not a copy',
    );
    assert.ok(toml.includes(`project_id = "unit-test-project"`));
  } finally {
    fs.rmSync(fixture.workdir, { recursive: true, force: true });
  }
});
