import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createLogger } from './logger.js';

function capture(writeTo = new PassThrough()) {
  let out = '';
  writeTo.on('data', (c) => {
    out += c.toString();
  });
  return { stream: writeTo, get: () => out };
}

test('logger: redacts a registered secret value', () => {
  const { stream, get } = capture();
  const logger = createLogger({ stream, secrets: ['hunter2secret'] });
  logger.status('connecting with hunter2secret now');
  assert.ok(!get().includes('hunter2secret'));
  assert.ok(get().includes('[REDACTED]'));
});

test('logger: redacts a database URL password', () => {
  const { stream, get } = capture();
  const logger = createLogger({
    stream,
    secrets: ['postgresql://user:supersecret@db.example.supabase.co:5432/postgres'],
  });
  logger.warn('failed to reach supersecret pooler');
  assert.ok(!get().includes('supersecret'));
});

test('logger: status/warning/error are distinct and plain', () => {
  const { stream, get } = capture();
  const logger = createLogger({ stream });
  logger.status('plain status; no color or animation');
  logger.warn('a warning');
  logger.error('an error');
  assert.ok(get().includes('plain status'));
  assert.ok(get().includes('a warning'));
  assert.ok(get().includes('an error'));
  assert.ok(
    ![...get()].some((ch) => ch.charCodeAt(0) < 32 && ch !== '\n'),
    'no ANSI escapes in output',
  );
});

test('logger: emits GitHub annotations when enabled', () => {
  const { stream, get } = capture();
  const logger = createLogger({ stream, isGitHubActions: true });
  logger.warn('something degraded');
  logger.error('something failed');
  const out = get();
  assert.ok(out.includes('::warning::something degraded'), out);
  assert.ok(out.includes('::error::something failed'), out);
});

test('logger: no annotations when not running in GitHub Actions', () => {
  const { stream, get } = capture();
  const logger = createLogger({ stream, isGitHubActions: false });
  logger.error('nope');
  assert.ok(!get().includes('::error::'));
});

test('logger: addSecret registers later values', () => {
  const { stream, get } = capture();
  const logger = createLogger({ stream });
  logger.addSecret('later-secret');
  logger.status('value later-secret leaked?');
  assert.ok(!get().includes('later-secret'));
});

test('logger: never serializes the process environment', () => {
  // Creating a logger with a hostile env present must not dump environment values.
  const { stream, get } = capture();
  const logger = createLogger({ stream, secrets: [] });
  logger.status('started');
  const out = get();
  assert.ok(!out.includes('process.env'));
  assert.ok(!out.includes('='));
});
