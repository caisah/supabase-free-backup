/**
 * Integration test for the local database restore flow.
 *
 * Uses a DISPOSABLE generic fixture workdir (never a real developer
 * project): start a local Supabase stack, seed public rows, Auth users,
 * migration history, and the fixture's auth triggers; dump + package +
 * verify the snapshot through the prior modules; destroy the fixture DB
 * volume; restore through the local flow; restart full services; verify
 * data, history, and triggers survived; clean every fixture artifact.
 * Every lifecycle command runs with collected output so generated local
 * keys never reach the test log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, lookupExecutable } from './process.js';
import { dumpDatabase } from './database.js';
import { packageSnapshot, unpackAndVerify } from './snapshot.js';
import { restoreLocalStack } from './local-restore.js';
import { generateCleanupSql } from './hosted-restore.js';
import { AGE_RECIPIENT_1, AGE_IDENTITY_1, writePrivateFile } from './test-fixtures.js';
import {
  createSupabaseIntegrationFixture,
  FIXTURE_ROW_VALUES,
  FIXTURE_AUTH_EMAIL,
  FIXTURE_MIGRATION_VERSION,
  FIXTURE_TRIGGER_NAMES,
} from './supabase.integration-fixture.js';

const dockerAvailable = lookupExecutable('docker') !== null;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliAvailable = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'supabase'));

test(
  'integration: local restore reproduces data, history, and triggers in a generic fixture stack',
  { skip: !dockerAvailable || !cliAvailable, timeout: 1200000 },
  async () => {
    const fixture = createSupabaseIntegrationFixture({
      repoRoot,
      projectId: 'database-restore-integration',
      ports: { api: 57321, db: 57322, shadow: 57320, pooler: 57329, studio: 57323 },
    });

    try {
      // 1. Start and seed the disposable stack.
      await fixture.start();
      await fixture.seed();

      // 2. Dump + package + verify-decrypt through the prior modules.
      const dumpDir = path.join(fixture.workdir, 'dumps');
      fs.mkdirSync(dumpDir, { mode: 0o700 });
      const dump = await dumpDatabase({
        dbUrl: fixture.dbUrl,
        cwd: repoRoot,
        outDir: dumpDir,
        supabasePath: fixture.supabaseBin,
        dockerPath: fixture.dockerPath,
        run: fixture.run,
      });
      const pkgDir = path.join(fixture.workdir, 'pkg');
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
        path.join(fixture.workdir, 'identity.txt'),
        `${AGE_IDENTITY_1}\n`,
      );
      const prepared = await unpackAndVerify({
        sourceDir: pkgDir,
        destDir: path.join(fixture.workdir, 'prepared'),
        identityFile,
        expectedEnvironment: 'development',
      });
      // 3. Destroy the fixture DB volume and restore through the local flow.
      //    The prepared roles are commented against the fresh baseline inside
      //    restoreLocalStack; only the cleanup list is pre-generated here.
      const cleanupFile = path.join(fixture.workdir, 'cleanup.sql');
      fs.writeFileSync(
        cleanupFile,
        generateCleanupSql({ dataSql: fs.readFileSync(prepared.dataPath, 'utf8') }),
        { mode: 0o600 },
      );
      await restoreLocalStack({
        supabasePath: fixture.supabaseBin,
        workdir: fixture.workdir,
        prepared,
        cleanupFile,
        dockerPath: fixture.dockerPath,
        dbContainer: fixture.dbContainer,
        dbPort: fixture.dbPort,
        run: fixture.run,
        logger: { status() {}, warn() {}, error() {}, addSecret() {}, redact: (t) => t },
      });

      // 4. Verify the restored stack contents.
      const publicRows = await fixture.query('SELECT value FROM public.records ORDER BY value');
      for (const value of FIXTURE_ROW_VALUES) {
        assert.ok(publicRows.includes(value), `public rows lost: ${publicRows}`);
      }
      const authRows = await fixture.query('SELECT email FROM auth.users');
      assert.ok(authRows.includes(FIXTURE_AUTH_EMAIL), `auth rows lost: ${authRows}`);
      const history = await fixture.query(
        'SELECT version FROM supabase_migrations.schema_migrations',
      );
      assert.ok(history.includes(FIXTURE_MIGRATION_VERSION), `migration history lost: ${history}`);
      // DATA-SURVIVAL assertion only: runtime restore verification is generic
      // (structural checks plus snapshot-derived schema/row presence) and no
      // longer names custom objects; this test proves arbitrary managed-schema
      // triggers still round-trip through the dump/package/restore pipeline.
      const triggerQuery = `SELECT tgname FROM pg_trigger WHERE tgname IN (${FIXTURE_TRIGGER_NAMES.map((t) => `'${t}'`).join(', ')}) ORDER BY tgname`;
      const triggers = await fixture.query(triggerQuery);
      for (const name of FIXTURE_TRIGGER_NAMES) {
        assert.ok(triggers.includes(name), triggers);
      }

      // 5. Full services restart health: the stack was started by the flow.
      const containers = await runCommand({
        command: fixture.dockerPath,
        args: ['ps', '--format', '{{.Names}}'],
        stdout: 'collect',
        stderr: 'collect',
      });
      assert.ok(
        (containers.stdout ?? '').includes(fixture.dbContainer),
        'database container must run after restore',
      );
    } finally {
      // 6. Clean the disposable stack and fixtures (never anything else).
      await fixture.remove();
    }
  },
);
