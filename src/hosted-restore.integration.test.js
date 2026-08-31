/**
 * Non-destructive integration regression: the pinned Supabase Postgres image
 * supplies psql major 17 through Docker, with NO host psql involved. Never
 * connects to a hosted target, reads env files, inspects the sibling
 * project, or reuses a running container; `--rm` leaves nothing behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, lookupExecutable } from './process.js';
import { preflightDockerPsql, parsePsqlMajorVersion } from './hosted-restore.js';
import { PINNED_SUPABASE_POSTGRES_IMAGE } from './database.js';
import { POSTGRES_MAJOR_VERSION } from './snapshot.js';

const dockerAvailable = lookupExecutable('docker') !== null;

test(
  'integration: pinned Supabase Postgres image supplies psql major 17 without host psql',
  { skip: !dockerAvailable, timeout: 900000 },
  async () => {
    // A first run may have to pull the exact pinned tag; the generous
    // timeout above covers that. The preflight is the same read-only call
    // the hosted commands use: docker run --rm ... --entrypoint=psql --version.
    const version = await preflightDockerPsql({
      dockerPath: lookupExecutable('docker'),
      postgresImage: PINNED_SUPABASE_POSTGRES_IMAGE,
      run: runCommand,
    });
    const major = parsePsqlMajorVersion(version);
    assert.ok(major !== null, `version text must be canonical psql output, got: ${version}`);
    assert.equal(major, POSTGRES_MAJOR_VERSION);
  },
);
