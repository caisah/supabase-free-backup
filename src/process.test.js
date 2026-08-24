import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCommand,
  ProcessError,
  ProcessAbortedError,
  lookupExecutable,
  assertSuccessfulExit,
} from './process.js';
import { fileURLToPath } from 'node:url';

const node = process.execPath;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-proc-'));
}

test('process runner: captures stdout for simple commands', async () => {
  const res = await runCommand({
    command: node,
    args: ['-e', 'process.stdout.write("hello")'],
    stdout: 'collect',
  });
  assert.equal(res.stdout, 'hello');
});

test('process runner: never enables a shell; args are passed literally', async () => {
  // If a shell were used, $SHELLISH and $(echo) would be expanded/executed.
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const res = await runCommand({
    command: node,
    args: ['-e', script, '$(echo PWNED)', '$NOT_SET', 'a value with spaces'],
    stdout: 'collect',
  });
  assert.equal(res.stdout, JSON.stringify(['$(echo PWNED)', '$NOT_SET', 'a value with spaces']));
});

test('process runner: accepts a readable stream as stdin input', async () => {
  const { Readable } = await import('node:stream');
  const res = await runCommand({
    command: node,
    args: [
      '-e',
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d))',
    ],
    stdout: 'collect',
    input: Readable.from([Buffer.from('streamed '), Buffer.from('input')]),
  });
  assert.equal(res.stdout, 'streamed input');
});

test('process runner: stream stdin input does not hang when the child exits early', async () => {
  const { Readable } = await import('node:stream');
  const res = await runCommand({
    command: node,
    args: ['-e', 'process.exit(0)'],
    stdout: 'collect',
    input: Readable.from([Buffer.from('ignored')]),
  });
  assert.equal(res.stdout, '');
});

test('process runner: propagates nonzero exit codes with code', async () => {
  await assert.rejects(
    () => runCommand({ command: node, args: ['-e', 'process.exit(3)'] }),
    (err) => err instanceof ProcessError && err.exitCode === 3,
  );
});

test('process runner: propagates a failure killed by signal', async () => {
  await assert.rejects(
    () => runCommand({ command: node, args: ['-e', "process.kill(process.pid, 'SIGTERM')"] }),
    (err) => err instanceof ProcessError && err.signal === 'SIGTERM',
  );
});

test('process runner: error omits secret arguments', async () => {
  const secret = 'very-secret-token-987654321';
  await assert.rejects(
    () =>
      runCommand({
        command: node,
        args: ['-e', 'process.stderr.write(process.argv[1]); process.exit(1)', secret],
        secretArgs: [secret],
      }),
    (err) => {
      assert.ok(err instanceof ProcessError);
      assert.ok(!err.message.includes(secret), 'secret leaked into error message');
      assert.ok(!err.stderrTail.includes(secret), 'secret leaked into stderr tail');
      assert.ok(!JSON.stringify(err.redactedArgs).includes(secret), 'secret leaked into args');
      assert.ok(!String(err.cause?.message ?? '').includes(secret), 'secret leaked into cause');
      return true;
    },
  );
});

test('process runner: bounds captured stderr size', async () => {
  const res = await runCommand({
    command: node,
    args: ['-e', 'for (let i = 0; i < 200000; i++) process.stderr.write("garbage-line\\n")'],
    maxStderrBytes: 4096,
  });
  assert.ok(res.stderr.length <= 4096, `stderr length ${res.stderr.length}`);
});

test('process runner: streams stdout to a file when requested', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'stdout.bin');
  const res = await runCommand({
    command: node,
    args: ['-e', 'process.stdout.write("streamed-content-123")'],
    stdout: { file: out },
  });
  assert.equal(res.stdout, null);
  assert.equal(fs.readFileSync(out, 'utf8'), 'streamed-content-123');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('process runner: supports cwd', async () => {
  const dir = tmpdir();
  const res = await runCommand({
    command: node,
    args: ['-e', 'process.stdout.write(process.cwd())'],
    cwd: dir,
    stdout: 'collect',
  });
  assert.equal(fs.realpathSync(res.stdout), fs.realpathSync(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('process runner: supports abort/cancellation', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(
    () =>
      runCommand({
        command: node,
        args: ['-e', 'setTimeout(()=>{}, 60000)'],
        signal: controller.signal,
      }),
    (err) => err instanceof ProcessAbortedError,
  );
});

test('process runner: nonexistent command produces a ProcessError, not a shell error', async () => {
  await assert.rejects(
    () => runCommand({ command: '/nonexistent/definitely-missing-bin', args: [] }),
    (err) => err instanceof ProcessError,
  );
});

test('process runner: inherit forwards child stdout to the parent process', async () => {
  const dir = tmpdir();
  const outFile = path.join(dir, 'inherited.out');
  const procjs = fileURLToPath(new URL('./process.js', import.meta.url));
  const script = [
    `const { runCommand } = await import(${JSON.stringify(procjs)});`,
    'await runCommand({ command: process.execPath, args: ["-e", ' +
      '"process.stdout.write(\\"INHERIT-MARKER-42\\")"], stdout: "inherit" });',
  ].join('\n');
  const { spawnSync } = await import('node:child_process');
  const fd = fs.openSync(outFile, 'w');
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', fd, 'inherit'],
  });
  fs.closeSync(fd);
  assert.equal(res.status, 0, String(res.stderr));
  assert.equal(
    fs.readFileSync(outFile, 'utf8'),
    'INHERIT-MARKER-42',
    'child stdout must not be silently discarded under inherit',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('process runner: child discovery of source via file URL', () => {
  assert.ok(fileURLToPath(new URL('./process.js', import.meta.url)).endsWith('process.js'));
});

test('process runner: stream write failures reject instead of crashing', async () => {
  const dir = tmpdir();
  const asDir = path.join(dir, 'stdout-target');
  fs.mkdirSync(asDir, { mode: 0o755 });
  await assert.rejects(
    () =>
      runCommand({
        command: node,
        args: ['-e', 'process.stdout.write("x".repeat(20000))'],
        stdout: { file: asDir }, // writing to a directory always errors
      }),
    (err) => err instanceof ProcessError,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('process runner: marks truncated collected stdout', async () => {
  const res = await runCommand({
    command: node,
    args: ['-e', 'process.stdout.write("A".repeat(5000))'],
    stdout: 'collect',
    maxStderrBytes: 256,
  });
  assert.ok(res.stdout.startsWith('[stdout truncated] '), 'stdout must be flagged as truncated');
  assert.ok(res.stdout.length <= 256);
});

test('lookupExecutable: finds node on PATH and misses a garbage name', () => {
  assert.ok(lookupExecutable(process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.equal(lookupExecutable('definitely-not-a-real-binary-xyz'), null);
});

test('process runner: an aborted signal classifies as ProcessAbortedError even when the abort event lost the close race', () => {
  const state = { captureStdout: null, captureStderr: null };
  // Child was killed by SIGTERM; the abort listener never ran (child closed
  // first), but the caller's signal is already aborted: callers handle
  // cancellation, so this must be ProcessAbortedError, never ProcessError.
  assert.throws(
    () =>
      assertSuccessfulExit({
        exit: { exitCode: null, exitSignal: 'SIGTERM' },
        observed: { childAbort: false },
        state,
        ioFailure: null,
        command: 'psql',
        redactedArgs: [],
        secretArgs: [],
        maxStderrBytes: 1024,
        signal: { aborted: true },
      }),
    (err) => err instanceof ProcessAbortedError,
  );
  // Without an aborted signal the same exit stays a plain signal-kill error.
  assert.throws(
    () =>
      assertSuccessfulExit({
        exit: { exitCode: null, exitSignal: 'SIGTERM' },
        observed: { childAbort: false },
        state,
        ioFailure: null,
        command: 'psql',
        redactedArgs: [],
        secretArgs: [],
        maxStderrBytes: 1024,
        signal: undefined,
      }),
    (err) => err instanceof ProcessError && err.signal === 'SIGTERM',
  );
});

test('process runner: collected stdout and stderr are redacted on success', async () => {
  const secret = 'supersecret-password';
  const res = await runCommand({
    command: node,
    args: [
      '-e',
      `process.stdout.write('db url carries ${secret}'); process.stderr.write('tool echoed ${secret}')`,
    ],
    stdout: 'collect',
    stderr: 'collect',
    secretArgs: [secret],
  });
  assert.ok(!res.stdout.includes(secret), 'stdout must never carry the secret');
  assert.ok(!res.stderr.includes(secret), 'stderr must never carry the secret');
  assert.ok(res.stdout.includes('***'));
  assert.ok(res.stderr.includes('***'));
});

test('process runner: bounded stderr tail never splits a multi-byte character', async () => {
  const euro = '\u20AC'; // 3-byte UTF-8 sequence
  await assert.rejects(
    () =>
      runCommand({
        command: node,
        args: ['-e', `process.stderr.write('${euro}'.repeat(1000)); process.exit(1)`],
        stderr: 'collect',
        maxStderrBytes: 101,
      }),
    (err) =>
      err instanceof ProcessError &&
      err.stderrTail.length > 0 &&
      !err.stderrTail.includes('\uFFFD'),
  );
});

test('process runner: an already-aborted signal never spawns', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runCommand({
        command: '/nonexistent/never-spawned',
        args: [],
        signal: controller.signal,
      }),
    (err) => err.name === 'ProcessAbortedError',
  );
});

test('process runner: file-stream outputs are closed and flushed on child failure', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'out.bin');
  await assert.rejects(
    () =>
      runCommand({
        command: node,
        args: ['-e', 'process.stdout.write("partial"); process.exit(1)'],
        stdout: { file: out },
      }),
    (err) => err instanceof ProcessError && err.exitCode === 1,
  );
  // The pump settled and the file stream was ended/flushed before the error
  // was classified, so the partial output must be readable on disk.
  assert.equal(fs.readFileSync(out, 'utf8'), 'partial');
  fs.rmSync(dir, { recursive: true, force: true });
});
