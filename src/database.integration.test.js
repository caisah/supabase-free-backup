/**
 * Integration test for the Supabase dump adapter.
 *
 * Starts a DISPOSABLE generic Supabase stack (Postgres 17) in an isolated
 * fixture workdir, seeds a small public schema, rows, migration history, Auth
 * users, and the fixture's `auth.users` triggers, then dumps through the
 * adapter, packages through the snapshot module, and verifies the packaged
 * output contains no plaintext row data.
 *
 * Never connects to hosted development or production. Requires Docker and the
 * pinned Supabase CLI; skipped otherwise. Every lifecycle command runs with
 * collected output so generated local keys never reach the test log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupExecutable } from './process.js';
import { dumpDatabase } from './database.js';
import { readLocalDatabaseState } from './local-backup.js';
import {
  packageSnapshot,
  unpackAndVerify,
  validatePackagedDirectory,
  PLAINTEXT_ARTIFACTS,
} from './snapshot.js';
import { AGE_RECIPIENT_1, AGE_IDENTITY_1, writePrivateFile } from './test-fixtures.js';
import {
  createSupabaseIntegrationFixture,
  FIXTURE_TABLE,
  FIXTURE_AUTH_EMAIL,
  FIXTURE_MIGRATION_VERSION,
  FIXTURE_TRIGGER_NAMES,
} from './supabase.integration-fixture.js';

const dockerAvailable = lookupExecutable('docker') !== null;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliAvailable = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'supabase'));

// pg_dump renders the fixture table with quoted identifiers ("public"."records");
// derive that rendering from the exported vocabulary constant.
const QUOTED_FIXTURE_TABLE = `"${FIXTURE_TABLE.split('.').join('"."')}"`;

test(
  'integration: dump adapter produces the six logical outputs from a generic disposable Supabase database',
  { skip: !dockerAvailable || !cliAvailable, timeout: 900000 },
  async () => {
    const fixture = createSupabaseIntegrationFixture({
      repoRoot,
      projectId: 'database-dump-integration',
      ports: { api: 56321, db: 56322, shadow: 56320, pooler: 56329, studio: 56323 },
    });
    const outDir = path.join(fixture.workdir, 'out');
    fs.mkdirSync(outDir, { mode: 0o700 });

    try {
      // 1. Start the disposable stack.
      await fixture.start();

      // The disposable fixture needs Auth's bootstrap migrations, but its
      // background maintenance would be a real concurrent writer. Stop only
      // that fixture service so the dump-stability assertion is deterministic.
      await fixture.stop();

      // 2. Seed public rows, Auth users, migration history, custom triggers.
      const stateProbe = {
        dockerPath: fixture.dockerPath,
        dbContainer: fixture.dbContainer,
        run: fixture.run,
      };
      const beforeSeedState = await readLocalDatabaseState(stateProbe);
      await fixture.seed();
      const afterSeedState = await readLocalDatabaseState(stateProbe);
      assert.notEqual(afterSeedState, beforeSeedState, 'committed writes must change the token');

      // 3. Run the adapter and prove its six read-only commands leave the
      // conservative source-state token unchanged.
      const beforeDumpState = await readLocalDatabaseState(stateProbe);
      const result = await dumpDatabase({
        dbUrl: fixture.dbUrl,
        cwd: repoRoot,
        outDir,
        supabasePath: fixture.supabaseBin,
        dockerPath: fixture.dockerPath,
        run: fixture.run,
      });
      const afterDumpState = await readLocalDatabaseState(stateProbe);
      assert.equal(afterDumpState, beforeDumpState, 'read-only dumps must not mutate the source');
      assert.equal(result.cliVersion, '2.114.0');
      assert.equal(result.postgresMajorVersion, 17);

      // 4. Verify roles/application schema/migration history/data outputs.
      const read = (key) => fs.readFileSync(result.files[key], 'utf8');
      assert.ok(read('roles').includes('ALTER ROLE'), 'roles dump captures role settings');
      assert.ok(read('roles').includes('anon'), 'anon role present');
      assert.ok(read('schema').includes(QUOTED_FIXTURE_TABLE), 'application schema captured');
      assert.ok(read('migrationHistorySchema').includes('schema_migrations'));
      assert.ok(read('migrationHistoryData').includes(FIXTURE_MIGRATION_VERSION));
      const data = read('databaseData');
      assert.ok(data.includes(QUOTED_FIXTURE_TABLE), 'public rows captured');
      assert.ok(data.includes('COPY "auth"."users"'), 'Auth rows captured');
      assert.ok(data.includes(FIXTURE_AUTH_EMAIL), 'Auth user row present');
      assert.ok(!data.includes('buckets_vectors'), 'vector tables excluded');

      // 5. The managed auth/storage delta captures BOTH fixture triggers.
      const managed = read('managed');
      for (const trigger of FIXTURE_TRIGGER_NAMES) {
        assert.ok(managed.includes(trigger), `trigger ${trigger} in managed delta`);
      }

      // 6. Package through the snapshot module and verify row data is only
      // encrypted.
      const snapshotId = '2026-08-24T03-17-09Z';
      const pkgDir = path.join(fixture.workdir, 'pkg');
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
        assert.ok(!content.includes(FIXTURE_AUTH_EMAIL), `${name} must not carry row data`);
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
      const pkgDir2 = path.join(fixture.workdir, 'pkg2');
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
        path.join(fixture.workdir, 'identity.txt'),
        `${AGE_IDENTITY_1}\n`,
      );
      const preparedDir = path.join(fixture.workdir, 'prepared');
      const prepared = await unpackAndVerify({
        sourceDir: pkgDir,
        destDir: preparedDir,
        identityFile,
        expectedEnvironment: 'development',
      });
      const plaintext = fs.readFileSync(prepared.dataPath, 'utf8');
      assert.ok(plaintext.includes('COPY "auth"."users"'), 'auth rows restored');
      assert.ok(plaintext.includes(FIXTURE_AUTH_EMAIL), 'auth user value restored');
      assert.ok(plaintext.includes(QUOTED_FIXTURE_TABLE), 'public rows restored');
      assert.ok(plaintext.includes(FIXTURE_MIGRATION_VERSION), 'migration history restored');
    } finally {
      // 8. Clean the disposable stack and fixtures (never anything else).
      await fixture.remove();
    }
  },
);
