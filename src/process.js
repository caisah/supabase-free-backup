/**
 * One safe child-process adapter for every external command.
 *
 * - argument arrays only; `shell: false` always
 * - inherited, captured, or file-streamed stdout
 * - captured stderr bounded to a maximum tail size
 * - nonzero exit codes propagate as errors
 * - AbortSignal cancellation
 * - arguments can be marked secret; errors never reproduce them
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeWithBackpressure, endWritable } from './stream.js';

export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export class ProcessError extends Error {
  constructor({
    command,
    exitCode = null,
    signal = null,
    stderrTail = '',
    redactedArgs = [],
    cause,
  } = {}) {
    const detail = signal ? `killed by signal ${signal}` : `exited with code ${exitCode}`;
    super(`${command} ${detail}${stderrTail ? `. stderr tail: ${stderrTail}` : ''}`);
    this.name = 'ProcessError';
    this.command = command;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderrTail = stderrTail;
    this.redactedArgs = redactedArgs;
    this.cause = cause;
  }
}

export class ProcessAbortedError extends Error {
  constructor(command) {
    super(`${command} aborted by caller`);
    this.name = 'ProcessAbortedError';
    this.command = command;
  }
}

/**
 * Parse captured `psql -t -A` stdout into trimmed, non-empty lines. Shared
 * by the local-stack (`docker exec`) and hosted (`docker run` hardened)
 * psql runners so their captured-output semantics can never drift.
 */
export function psqlOutputLines(stdout) {
  return (stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Byte-accurate bounded tail: keeps the last `maxBytes` BYTES of pushed
 * chunks (multi-byte UTF-8 sequences are counted as bytes, never chars).
 */
export class BoundedTail {
  constructor(maxBytes) {
    this.maxBytes = Math.max(0, maxBytes);
    this.bytes = Buffer.alloc(0);
    this.truncated = false;
  }

  get buffer() {
    return this.bytes.toString('utf8');
  }

  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([this.bytes, next]);
    if (combined.length > this.maxBytes) {
      this.bytes = combined.subarray(combined.length - this.maxBytes);
      this.truncated = true;
    } else {
      this.bytes = combined;
    }
  }
}

const TRUNCATED_MARKER = { stdout: '[stdout truncated] ', stderr: '[stderr truncated] ' };

/** Tail a buffer and keep the truncation marker inside `maxBytes`. */
function markerTail(marker, buffer, maxBytes) {
  if (maxBytes <= 0) return '';
  const markerBytes = Buffer.from(marker);
  if (markerBytes.length >= maxBytes) return markerBytes.subarray(0, maxBytes).toString('utf8');
  return `${marker}${utf8SafeTail(buffer, maxBytes - markerBytes.length)}`;
}

/** Redact every nonempty marked secret, including substrings in stderr/causes. */
function redactSecrets(value, secretArgs) {
  let text = String(value ?? '');
  const secrets = [
    ...new Set(secretArgs.filter((s) => typeof s === 'string' && s.length > 0)),
  ].sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('***');
  return text;
}

function buildRedactedArgs(args, secretArgs) {
  return args.map((arg) => redactSecrets(arg, secretArgs));
}

function redactCause(cause, secretArgs) {
  if (!cause) return undefined;
  const safe = new Error(redactSecrets(cause.message ?? cause, secretArgs));
  safe.name = cause.name ?? 'Error';
  if (cause.code !== undefined) safe.code = cause.code;
  return safe;
}

/** Create capture/file-stream state and track stream errors from creation onward. */
function createOutputState(stdout, stderr, maxStderrBytes) {
  const state = {
    captureStdout: stdout === 'collect' ? new BoundedTail(maxStderrBytes) : null,
    captureStderr: stderr === 'collect' ? new BoundedTail(maxStderrBytes) : null,
    outFileStream: null,
    errFileStream: null,
    fileErrors: [],
    errorListeners: [],
  };
  const track = (stream) => {
    const onError = (err) => state.fileErrors.push(err);
    stream.on('error', onError);
    state.errorListeners.push([stream, onError]);
    return stream;
  };
  if (stdout && typeof stdout === 'object') {
    state.outFileStream = track(fs.createWriteStream(stdout.file, { mode: 0o600 }));
  }
  if (stderr && typeof stderr === 'object') {
    state.errFileStream = track(fs.createWriteStream(stderr.file, { mode: 0o600 }));
  }
  return state;
}

/** Observe child errors and caller aborts only until the child closes. */
function observeChild(child, signal) {
  const observed = { childError: null, childAbort: false, closed: false, dispose: () => {} };
  const onError = (err) => {
    observed.childError = err;
  };
  const onAbort = () => {
    if (!observed.closed) observed.childAbort = true;
  };
  const onClose = () => {
    observed.closed = true;
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  child.once('error', onError);
  child.once('close', onClose);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  observed.dispose = () => {
    child.removeListener('error', onError);
    child.removeListener('close', onClose);
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  return observed;
}

function awaitClose(child) {
  return new Promise((resolve) => {
    child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  });
}

/** Record sink/read failures but keep draining so the child cannot deadlock. */
async function pump(readable, writable, bounded, fileErrors) {
  let failure = null;
  try {
    for await (const chunk of readable) {
      if (bounded) bounded.push(chunk);
      if (!writable || failure || fileErrors.length > 0) continue;
      try {
        await writeWithBackpressure(writable, chunk);
      } catch (err) {
        failure = failure ?? err;
      }
    }
  } catch (err) {
    failure = failure ?? err;
  }
  return { failure };
}

function startPumps(child, state) {
  const settled = { failure: null };
  return Promise.all([
    child.stdout
      ? pump(child.stdout, state.outFileStream, state.captureStdout, state.fileErrors)
      : Promise.resolve(settled),
    child.stderr
      ? pump(child.stderr, state.errFileStream, state.captureStderr, state.fileErrors)
      : Promise.resolve(settled),
  ]);
}

/** Close both output streams even when either close fails. */
async function closeOutputState(state) {
  const streams = [state.outFileStream, state.errFileStream].filter(Boolean);
  const results = await Promise.allSettled(streams.map((stream) => endWritable(stream)));
  for (const [stream, listener] of state.errorListeners) {
    stream.removeListener('error', listener);
  }
  return results.filter((result) => result.status === 'rejected').map((result) => result.reason);
}

function safeCapturedStderr(state, secretArgs, maxStderrBytes) {
  if (maxStderrBytes <= 0) return '';
  const redacted = redactSecrets(state.captureStderr?.buffer ?? '', secretArgs);
  return utf8SafeTail(redacted, maxStderrBytes);
}

function formatCapturedOutput(capture, marker, maxBytes, secretArgs) {
  if (!capture) return null;
  const redacted = redactSecrets(capture.buffer, secretArgs);
  return capture.truncated ? markerTail(marker, redacted, maxBytes) : redacted;
}

/** Tail a string by BYTES without splitting a multi-byte UTF-8 sequence. */
function utf8SafeTail(text, maxBytes) {
  const buf = Buffer.from(String(text));
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let decoded = buf.subarray(buf.length - maxBytes).toString('utf8');
  // The slice boundary can fall inside a multi-byte sequence; drop the
  // replacement characters it produces on either side so error tails render
  // cleanly. The bounded tail never contains legitimate U+FFFD.
  while (decoded.startsWith('\uFFFD')) decoded = decoded.slice(1);
  while (decoded.endsWith('\uFFFD')) decoded = decoded.slice(0, -1);
  return decoded;
}

/** Classify a settled process only after pipes and output files are closed. */
function assertSuccessfulExit({
  exit,
  observed,
  state,
  ioFailure,
  command,
  redactedArgs,
  secretArgs,
  maxStderrBytes,
  signal,
}) {
  const stderrTail = safeCapturedStderr(state, secretArgs, maxStderrBytes);
  if (observed.childAbort || signal?.aborted) throw new ProcessAbortedError(basename(command));
  if (observed.childError) {
    throw new ProcessError({
      command: basename(command),
      redactedArgs,
      stderrTail,
      cause: redactCause(observed.childError, secretArgs),
    });
  }
  if (ioFailure) {
    throw new ProcessError({
      command: basename(command),
      redactedArgs,
      stderrTail,
      cause: redactCause(ioFailure, secretArgs),
    });
  }
  if (exit.exitCode !== 0 || exit.exitSignal !== null) {
    throw new ProcessError({
      command: basename(command),
      exitCode: exit.exitCode,
      signal: exit.exitSignal,
      redactedArgs,
      stderrTail,
    });
  }
  return {
    stdout: formatCapturedOutput(
      state.captureStdout,
      TRUNCATED_MARKER.stdout,
      maxStderrBytes,
      secretArgs,
    ),
    stderr: formatCapturedOutput(
      state.captureStderr,
      TRUNCATED_MARKER.stderr,
      maxStderrBytes,
      secretArgs,
    ),
  };
}

export { assertSuccessfulExit };

/**
 * Run one command.
 *
 * @param {object} opts
 * @param {string} opts.command executable path
 * @param {string[]} [opts.args=[]] literal arguments
 * @param {string[]} [opts.secretArgs=[]] values that must never appear in errors
 * @param {'inherit'|'collect'|{file:string}} [opts.stdout='inherit']
 * @param {'inherit'|'collect'|{file:string}} [opts.stderr='collect']
 * @param {string|Buffer|import('node:stream').Readable} [opts.input] stdin payload (streams are piped, never buffered)
 * @param {number} [opts.maxStderrBytes] bound for collected output
 * @returns {Promise<{stdout:string|null, stderr:string|null}>}
 */
export async function runCommand({
  command,
  args = [],
  secretArgs = [],
  stdout = 'inherit',
  stderr = 'collect',
  input,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  cwd,
  env,
  signal,
}) {
  const redactedArgs = buildRedactedArgs(args, secretArgs);
  if (signal?.aborted) throw new ProcessAbortedError(basename(command));

  const state = createOutputState(stdout, stderr, maxStderrBytes);
  const stdio = [
    'pipe',
    stdout === 'inherit' ? 'inherit' : 'pipe',
    stderr === 'inherit' ? 'inherit' : 'pipe',
  ];
  let child;
  try {
    child = spawn(command, args, { shell: false, stdio, cwd, env, signal });
  } catch (err) {
    await closeOutputState(state);
    throw new ProcessError({
      command: basename(command),
      redactedArgs,
      cause: redactCause(err, secretArgs),
    });
  }

  const observed = observeChild(child, signal);
  const closePromise = awaitClose(child);
  const settled = { childClosed: false };
  closePromise.then(() => {
    settled.childClosed = true;
  });
  const pumpsPromise = startPumps(child, state);
  const inputPromise = pumpInput(child, input, settled);

  try {
    const exit = await closePromise;
    const pumps = await pumpsPromise;
    const inputResult = await inputPromise;
    const closeFailures = await closeOutputState(state);
    const ioFailure =
      state.fileErrors[0] ??
      inputResult.failure ??
      pumps.find((result) => result.failure)?.failure ??
      closeFailures[0] ??
      null;
    return assertSuccessfulExit({
      exit,
      observed,
      state,
      ioFailure,
      command,
      redactedArgs,
      secretArgs,
      maxStderrBytes,
      signal,
    });
  } finally {
    observed.dispose();
  }
}

function basename(command) {
  return path.basename(String(command));
}

/**
 * Deliver stdin with backpressure, never buffering the input. Complete
 * successful input delivery is part of command success:
 *
 * - a SOURCE read failure records a command failure, destroys the child's
 *   stdin, and terminates a live child. A child that treats the closed pipe
 *   as EOF must never be allowed to commit a partial input (e.g. `psql
 *   --single-transaction -f -`) and exit zero; the recorded failure makes
 *   `runCommand` reject regardless of the child's exit.
 * - a WRITE failure caused by the child dying (EPIPE on a closed pipe) is
 *   benign: the child's own exit status is authoritative for commands that
 *   exit without consuming stdin.
 */
async function pumpInput(child, input, settled) {
  if (!child.stdin) return { failure: null };
  // Permanent guards so a destroyed pipe/source can never surface an
  // unhandled 'error' after the pump detached.
  child.stdin.on('error', () => {});
  if (input === undefined || input === null) {
    child.stdin.end();
    return { failure: null };
  }
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    child.stdin.end(input);
    return { failure: null };
  }
  input.on('error', () => {});
  const fail = (err) => {
    settled.failure = settled.failure ?? err;
    if (!child.stdin.destroyed) child.stdin.destroy();
    if (!settled.childClosed) child.kill('SIGKILL');
  };
  try {
    for await (const chunk of input) {
      if (settled.childClosed) break;
      try {
        await writeWithBackpressure(child.stdin, chunk);
      } catch (err) {
        const benign =
          err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED' || settled.childClosed;
        if (!benign) fail(err);
        break;
      }
    }
    if (!settled.failure && !settled.childClosed && !child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        // the child may have exited between the loop and the end call; its
        // exit status is authoritative then
      }
    }
  } catch (err) {
    fail(err);
  }
  return { failure: settled.failure ?? null };
}

/** Resolve an executable by name from PATH. */
export function lookupExecutable(name) {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here; keep scanning
    }
  }
  return null;
}
