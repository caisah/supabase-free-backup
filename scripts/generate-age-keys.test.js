import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runGenerateAgeKeys } from './generate-age-keys.js';
import { tmpdir, writePrivateFile } from '../src/test-fixtures.js';

const AGE_RECIPIENT = 'age1rz8dtx9s7r2fyjejpq9wmewumm23ukwfdfqy0zjq0063ua6twfuqh0vyk9';
const AGE_IDENTITY = 'AGE-SECRET-KEY-19QAFE2ZTQCL043CWG3PKCDFESVCTYY3PXXTKUSZLKSH8Y49CDMXS3JLNMM';

function silentLogger() {
  return {
    status() {},
    warn() {},
    error() {},
    redact: (text) => text,
  };
}

function makeFakeAgeKeygen(publicKey = AGE_RECIPIENT, secretKey = AGE_IDENTITY) {
  return async () => ({
    stdout: `# created: 2024-01-01T00:00:00Z\n# public key: ${publicKey}\n${secretKey}`,
    stderr: '',
  });
}

function makeFakeAgeKeygenMalformed() {
  return async () => ({
    stdout: 'unexpected output',
    stderr: '',
  });
}

function writeEnvFile(root, environment, content) {
  const filePath = path.join(root, `.env.${environment}.local`);
  writePrivateFile(filePath, content);
  return filePath;
}

test('generate-age-keys: -h and --help return help', async () => {
  const logger = silentLogger();
  const deps = {
    lookup: () => null,
    run: makeFakeAgeKeygen(),
  };
  const result = await runGenerateAgeKeys({ argv: ['--help'], logger, deps });
  assert.deepEqual(result, { help: true });
  const resultShort = await runGenerateAgeKeys({ argv: ['-h'], logger, deps });
  assert.deepEqual(resultShort, { help: true });
});

test('generate-age-keys: rejects extra arguments', async () => {
  const logger = silentLogger();
  const deps = {
    lookup: () => '/usr/local/bin/age-keygen',
    run: makeFakeAgeKeygen(),
  };
  await assert.rejects(
    () => runGenerateAgeKeys({ argv: ['extra'], logger, deps }),
    /does not accept arguments/,
  );
});

test('generate-age-keys: fails when age-keygen is not found', async () => {
  const logger = silentLogger();
  const deps = {
    lookup: () => null,
    run: makeFakeAgeKeygen(),
  };
  await assert.rejects(
    () => runGenerateAgeKeys({ argv: [], logger, deps }),
    /age-keygen not found/,
  );
});

test('generate-age-keys: generates key pair and updates existing env files', async () => {
  const root = tmpdir('age-keys-');
  const devContent = `BACKUP_ENVIRONMENT=development
SUPABASE_PROJECT_REF=a1b2c3d4e5f6a7b8c9d0
`;
  const prodContent = `BACKUP_ENVIRONMENT=production
SUPABASE_PROJECT_REF=f0e9d8c7b6a5f4e3d2c1
`;
  writeEnvFile(root, 'development', devContent);
  writeEnvFile(root, 'production', prodContent);

  const logger = silentLogger();
  const deps = {
    lookup: () => '/usr/local/bin/age-keygen',
    run: makeFakeAgeKeygen(),
  };
  const result = await runGenerateAgeKeys({ argv: [], root, logger, deps });

  assert.equal(result.publicKey, AGE_RECIPIENT);
  assert.equal(result.secretKey, AGE_IDENTITY);
  assert.equal(result.updatedFiles.length, 2);

  const devFile = fs.readFileSync(path.join(root, '.env.development.local'), 'utf8');
  assert.ok(devFile.includes(`ENCRYPT_KEY=${AGE_RECIPIENT}`), 'dev file contains ENCRYPT_KEY');
  assert.ok(devFile.includes(`DECRYPT_KEY=${AGE_IDENTITY}`), 'dev file contains DECRYPT_KEY');

  const prodFile = fs.readFileSync(path.join(root, '.env.production.local'), 'utf8');
  assert.ok(prodFile.includes(`ENCRYPT_KEY=${AGE_RECIPIENT}`), 'prod file contains ENCRYPT_KEY');
  assert.ok(prodFile.includes(`DECRYPT_KEY=${AGE_IDENTITY}`), 'prod file contains DECRYPT_KEY');

  fs.rmSync(root, { recursive: true, force: true });
});

test('generate-age-keys: skips files that do not exist', async () => {
  const root = tmpdir('age-keys-missing-');
  writeEnvFile(root, 'development', 'BACKUP_ENVIRONMENT=development\n');

  const logger = silentLogger();
  const deps = {
    lookup: () => '/usr/local/bin/age-keygen',
    run: makeFakeAgeKeygen(),
  };
  const result = await runGenerateAgeKeys({ argv: [], root, logger, deps });

  assert.equal(result.updatedFiles.length, 1);
  assert.equal(result.updatedFiles[0], path.join(root, '.env.development.local'));
  assert.equal(result.skippedFiles.length, 1);
  assert.ok(result.skippedFiles[0].includes('.env.production.local'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('generate-age-keys: skips files that already contain ENCRYPT_KEY or DECRYPT_KEY', async () => {
  const root = tmpdir('age-keys-existing-');
  const content = `BACKUP_ENVIRONMENT=development
ENCRYPT_KEY=age1existingkey1234567890123456789012345678901234
`;
  writeEnvFile(root, 'development', content);
  writeEnvFile(root, 'production', 'BACKUP_ENVIRONMENT=production\n');

  const logger = silentLogger();
  const deps = {
    lookup: () => '/usr/local/bin/age-keygen',
    run: makeFakeAgeKeygen(),
  };
  const result = await runGenerateAgeKeys({ argv: [], root, logger, deps });

  assert.equal(result.updatedFiles.length, 1, 'only production file should be updated');
  assert.equal(result.skippedFiles.length, 1, 'development file should be skipped');
  assert.ok(result.skippedFiles[0].includes('.env.development.local'));

  const file = fs.readFileSync(path.join(root, '.env.development.local'), 'utf8');
  assert.ok(file.includes('ENCRYPT_KEY=age1existingkey1234567890123456789012345678901234'));
  assert.ok(!file.includes(AGE_RECIPIENT));

  fs.rmSync(root, { recursive: true, force: true });
});

test('generate-age-keys: preserves existing content when appending keys', async () => {
  const root = tmpdir('age-keys-content-');
  const content = `BACKUP_ENVIRONMENT=development
SUPABASE_PROJECT_REF=a1b2c3d4e5f6a7b8c9d0
SUPABASE_SHARED_POOLER_URL=postgresql://example.com
`;
  writeEnvFile(root, 'development', content);

  const logger = silentLogger();
  const deps = {
    lookup: () => '/usr/local/bin/age-keygen',
    run: makeFakeAgeKeygen(),
  };
  await runGenerateAgeKeys({ argv: [], root, logger, deps });

  const file = fs.readFileSync(path.join(root, '.env.development.local'), 'utf8');
  assert.ok(file.startsWith(content), 'original content preserved');
  assert.ok(file.includes(`ENCRYPT_KEY=${AGE_RECIPIENT}`));
  assert.ok(file.includes(`DECRYPT_KEY=${AGE_IDENTITY}`));

  fs.rmSync(root, { recursive: true, force: true });
});

test('generate-age-keys: fails when age-keygen returns malformed output', async () => {
  const root = tmpdir('age-keys-malformed-');
  writeEnvFile(root, 'development', 'BACKUP_ENVIRONMENT=development\n');

  const logger = silentLogger();
  const deps = {
    lookup: () => '/usr/local/bin/age-keygen',
    run: makeFakeAgeKeygenMalformed(),
  };
  await assert.rejects(
    () => runGenerateAgeKeys({ argv: [], root, logger, deps }),
    /failed to parse age-keygen output/,
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('generate-age-keys: works when no env files exist', async () => {
  const root = tmpdir('age-keys-empty-');

  const logger = silentLogger();
  const deps = {
    lookup: () => '/usr/local/bin/age-keygen',
    run: makeFakeAgeKeygen(),
  };
  const result = await runGenerateAgeKeys({ argv: [], root, logger, deps });

  assert.equal(result.publicKey, AGE_RECIPIENT);
  assert.equal(result.secretKey, AGE_IDENTITY);
  assert.equal(result.updatedFiles.length, 0);
  assert.equal(result.skippedFiles.length, 2);

  fs.rmSync(root, { recursive: true, force: true });
});
