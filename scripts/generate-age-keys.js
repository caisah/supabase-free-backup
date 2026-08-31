#!/usr/bin/env node
/**
 * Generate an age X25519 key pair and write the public recipient and
 * private identity into existing .env.*.local files.
 *
 *   npm run generate-age-keys
 *
 * Skips files that do not exist. When ENCRYPT_KEY or DECRYPT_KEY already
 * exist in a file, the script refuses to overwrite and prints the existing
 * values so the user can decide.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../src/runtime.js';
import { createLogger } from '../src/logger.js';
import { runCommand, lookupExecutable } from '../src/process.js';
import { ENVIRONMENTS, REPOSITORY_ROOT } from '../src/config.js';

const ENCRYPT_KEY_NAME = 'ENCRYPT_KEY';
const DECRYPT_KEY_NAME = 'DECRYPT_KEY';

/**
 * Resolve the `age-keygen` executable across the platform's usual wrappers.
 * Windows package managers (npm/scoop/chocolatey) expose `age-keygen.exe`/`age-keygen.cmd`,
 * not just `age-keygen`.
 *
 * @param {object} opts
 * @param {function(string): string|null} opts.lookup - Executable lookup function
 * @param {string} [opts.platform=process.platform] - Current platform identifier
 * @returns {string|null} Absolute path to the executable, or null if not found
 */
function resolveAgeKeygen({ lookup, platform = process.platform }) {
  const names = platform === 'win32' ? ['age-keygen.exe', 'age-keygen.cmd', 'age-keygen'] : ['age-keygen'];
  for (const name of names) {
    const found = lookup(name);
    if (found) return found;
  }
  return null;
}

/**
 * Parse the stdout output of `age-keygen` to extract the public recipient
 * and private identity.
 *
 * Expected output format:
 * ```
 * # created: 2024-01-01T00:00:00Z
 * # public key: age1...
 * AGE-SECRET-KEY-...
 * ```
 *
 * @param {string} stdout - Raw stdout from age-keygen
 * @throws {Error} If the output cannot be parsed
 * @returns {{ publicKey: string, secretKey: string }} The parsed key pair
 */
function parseAgeKeygenOutput(stdout) {
  const lines = stdout.split('\n');
  let publicKey = null;
  let secretKey = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# public key:')) {
      publicKey = trimmed.replace('# public key:', '').trim();
    } else if (trimmed.startsWith('AGE-SECRET-KEY-')) {
      secretKey = trimmed;
    }
  }

  if (!publicKey || !secretKey) {
    throw new Error('failed to parse age-keygen output');
  }

  return { publicKey, secretKey };
}

/**
 * Read a dotenv file from disk. Returns empty content and `exists: false`
 * when the file does not exist; other filesystem errors propagate.
 *
 * @param {string} filePath - Absolute path to the dotenv file
 * @returns {{ content: string, exists: boolean }} File contents and existence flag
 */
function readEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, exists: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { content: '', exists: false };
    throw err;
  }
}

/**
 * Scan file content for existing ENCRYPT_KEY or DECRYPT_KEY entries.
 * Matches both active assignments (`KEY=value`) and commented-out entries
 * (`# KEY=value`) to prevent duplicate keys.
 *
 * @param {string} content - Raw dotenv file content
 * @param {string} publicKey - Unused (kept for signature consistency)
 * @param {string} secretKey - Unused (kept for signature consistency)
 * @returns {{ encryptKeyFound: boolean, decryptKeyFound: boolean, content: string }}
 */
function updateEnvContent(content, publicKey, secretKey) {
  const lines = content.split('\n');
  let encryptKeyFound = false;
  let decryptKeyFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith(`${ENCRYPT_KEY_NAME}=`) || trimmed.startsWith(`# ${ENCRYPT_KEY_NAME}=`)) {
      encryptKeyFound = true;
    }
    if (trimmed.startsWith(`${DECRYPT_KEY_NAME}=`) || trimmed.startsWith(`# ${DECRYPT_KEY_NAME}=`)) {
      decryptKeyFound = true;
    }
  }

  return {
    encryptKeyFound,
    decryptKeyFound,
    content: lines.join('\n'),
  };
}

/**
 * Append age key pair entries to dotenv file content. Strips trailing
 * blank lines before appending, then adds the public recipient and
 * private identity with descriptive comments.
 *
 * @param {string} content - Existing dotenv file content
 * @param {string} publicKey - Age X25519 public recipient (`age1...`)
 * @param {string} secretKey - Age X25519 secret identity (`AGE-SECRET-KEY-...`)
 * @returns {string} Updated file content with keys appended
 */
function appendKeys(content, publicKey, secretKey) {
  const lines = content.split('\n');
  // Remove trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  lines.push('');
  lines.push(`# Public age X25519 recipient for this environment`);
  lines.push(`${ENCRYPT_KEY_NAME}=${publicKey}`);
  lines.push('');
  lines.push(`# Private age X25519 identity (keep this secret)`);
  lines.push(`${DECRYPT_KEY_NAME}=${secretKey}`);
  return lines.join('\n') + '\n';
}

/**
 * Run the age key generation and update flow.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv=process.argv.slice(2)] - CLI arguments
 * @param {string} [opts.root=REPOSITORY_ROOT] - Repository root path
 * @param {object} [opts.logger] - Logger instance (status/error output)
 * @param {object} [opts.deps] - Injected dependencies for testing
 * @param {function(string): string|null} [opts.deps.lookup] - Executable lookup
 * @param {function(object): Promise<{stdout:string}>} [opts.deps.run] - Command runner
 * @param {string} [opts.platform=process.platform] - Platform identifier
 * @returns {Promise<{help?: boolean, publicKey: string, secretKey: string, updatedFiles: string[], skippedFiles: string[]}>}
 */
export async function runGenerateAgeKeys({
  argv = process.argv.slice(2),
  root = REPOSITORY_ROOT,
  logger = createLogger({ stream: process.stderr }),
  deps = {},
  platform = process.platform,
} = {}) {
  const { lookup = lookupExecutable, run = runCommand } = deps;

  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  if (argv.length > 0) {
    throw new Error('generate-age-keys does not accept arguments');
  }

  const ageKeygen = resolveAgeKeygen({ lookup, platform });
  if (!ageKeygen) {
    throw new Error('age-keygen not found on PATH; install age (brew install age) and retry');
  }

  // Generate a new key pair
  const result = await run({
    command: ageKeygen,
    args: [],
    stdout: 'collect',
    stderr: 'collect',
  });

  const { publicKey, secretKey } = parseAgeKeygenOutput(result.stdout);

  logger.status(`generated age key pair`);
  logger.status(`public key: ${publicKey}`);

  const updatedFiles = [];
  const skippedFiles = [];

  for (const environment of ENVIRONMENTS) {
    const filePath = path.join(root, `.env.${environment}.local`);
    const { content, exists } = readEnvFile(filePath);

    if (!exists) {
      skippedFiles.push(filePath);
      continue;
    }

    const { encryptKeyFound, decryptKeyFound } = updateEnvContent(content, publicKey, secretKey);

    if (encryptKeyFound || decryptKeyFound) {
      skippedFiles.push(filePath);
      logger.status(`${filePath}: already contains ${ENCRYPT_KEY_NAME} or ${DECRYPT_KEY_NAME} — skipping`);
      continue;
    }

    const updatedContent = appendKeys(content, publicKey, secretKey);
    fs.writeFileSync(filePath, updatedContent, 'utf8');
    updatedFiles.push(filePath);
    logger.status(`${filePath}: written ${ENCRYPT_KEY_NAME} and ${DECRYPT_KEY_NAME}`);
  }

  return {
    publicKey,
    secretKey,
    updatedFiles,
    skippedFiles,
  };
}

/**
 * CLI entry point. Validates the Node.js version, runs key generation,
 * and prints results to stdout.
 *
 * @returns {Promise<number>} Exit code (0 on success, 1 on error)
 */
export async function main() {
  assertNodeVersion();
  const logger = createLogger({ stream: process.stderr });
  try {
    const result = await runGenerateAgeKeys({ logger });
    if (result?.help) {
      process.stdout.write('usage: vp run generate-age-keys\n');
      process.stdout.write(
        'Generates an age X25519 key pair and writes it to existing .env.*.local files.\n',
      );
    } else {
      process.stdout.write(`public key: ${result.publicKey}\n`);
      process.stdout.write(`secret key: ${result.secretKey}\n`);
    }
    return 0;
  } catch (err) {
    logger.error(`key generation failed: ${logger.redact(err.message ?? String(err))}`);
    process.exitCode = 1;
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
