import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'backup.yml',
);

const yaml = fs.readFileSync(WORKFLOW, 'utf8');

test('workflow: backup steps expose every required configuration variable', () => {
  // Config validation (src/config.js) unconditionally requires
  // BACKUP_ENVIRONMENT to match --environment, so both backup steps must map
  // it from the matrix or the CI job can never pass validation.
  const matches = yaml.match(/BACKUP_ENVIRONMENT: \${{ matrix\.environment }}/g) ?? [];
  assert.equal(matches.length, 2, 'both backup steps must map BACKUP_ENVIRONMENT');
  for (const required of [
    'REPOSITORY_PRIVATE',
    'SUPABASE_DB_URL',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'SUPABASE_PROJECT_REF',
    'CLOUDFLARE_ACCOUNT_ID',
    'R2_BUCKET',
    'ENCRYPT_KEY',
  ]) {
    assert.ok(yaml.includes(`${required}:`), `workflow must map ${required}`);
  }
});

test('workflow: every backup job requires explicit opt-in in a private repository', () => {
  const jobConditions = yaml.match(/^ {4}if: .*BACKUPS_ENABLED.*$/gm) ?? [];
  assert.equal(jobConditions.length, 2, 'backup and weekly-commit must both be gated');
  for (const condition of jobConditions) {
    assert.ok(
      condition.includes('github.event.repository.private == true'),
      'each job gate must require a private repository',
    );
    assert.ok(
      condition.includes("vars.BACKUPS_ENABLED == 'true'"),
      'each job gate must require the exact repository opt-in value',
    );
  }
});

test('workflow: backup matrix jobs do not share a serialized concurrency group', () => {
  assert.match(
    yaml,
    /group: backup-\${{ github\.ref }}-\${{ matrix\.environment }}/,
    'development and production must be able to run in parallel',
  );
});
