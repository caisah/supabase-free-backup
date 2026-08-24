/**
 * Shared writable-stream mechanics demonstrated in multiple modules:
 * backpressure-safe single writes and deterministic stream ending.
 *
 * Every helper attaches only temporary one-shot listeners and removes them
 * after settlement; stream errors reject rather than being swallowed. A stream
 * can fail asynchronously AFTER a chunk was accepted into its buffer, so
 * writeWithBackpressure keeps ONE lifetime error observer per stream that
 * records such late errors; endWritable then surfaces the recorded error
 * instead of letting it become an uncaught exception.
 */

import { createHash } from 'node:crypto';

/** Late-error bookkeeping keyed by WRITABLE, never attached to the streams. */
const pendingErrors = new WeakMap();
const errorObservers = new WeakMap();

/** SHA-256 of a readable stream; rejects on stream errors. */
export function sha256Readable(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Record the first late error on the stream and keep observing until the
 * stream finishes/closes. Attaches at most one listener per stream lifetime.
 */
function ensureLateErrorObserver(writable) {
  if (errorObservers.get(writable)) return;
  errorObservers.set(writable, true);
  const onError = (err) => {
    if (!pendingErrors.has(writable)) pendingErrors.set(writable, err);
  };
  const onDone = () => {
    writable.removeListener('error', onError);
    writable.removeListener('finish', onDone);
    writable.removeListener('close', onDone);
    errorObservers.set(writable, false);
  };
  writable.on('error', onError);
  writable.once('finish', onDone);
  writable.once('close', onDone);
}

/**
 * Write one chunk, waiting for `drain` when the writable signals
 * backpressure. Resolves once the chunk is accepted into the buffer; rejects
 * if the stream errors (or `write` throws) before settlement. Late errors
 * after acceptance are recorded and surfaced by a later `endWritable` call.
 */
export function writeWithBackpressure(writable, chunk) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.removeListener('drain', onDrain);
      writable.removeListener('error', onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    ensureLateErrorObserver(writable);
    writable.once('error', onError);
    let accepted;
    try {
      accepted = writable.write(chunk);
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }
    if (accepted) {
      cleanup();
      resolve();
    } else {
      writable.once('drain', onDrain);
    }
  });
}

/**
 * End a writable and resolve once it has actually finished or closed;
 * reject if it errors while ending (including a late error recorded by
 * `writeWithBackpressure`). Already-finished or destroyed streams resolve
 * (or reject with the recorded error) immediately so failure paths can never
 * hang on a stream whose error was already surfaced. Listens for BOTH
 * `finish` and `close` because not every writable emits `close`
 * (`emitClose: false`).
 */
export function endWritable(writable) {
  const pending = pendingErrors.get(writable);
  if (pending !== undefined) return Promise.reject(pending);
  if (writable.writableFinished || writable.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.removeListener('finish', onSettled);
      writable.removeListener('close', onSettled);
      writable.removeListener('error', onError);
    };
    const onSettled = () => {
      cleanup();
      const recorded = pendingErrors.get(writable);
      if (recorded !== undefined) reject(recorded);
      else resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    writable.once('finish', onSettled);
    writable.once('close', onSettled);
    writable.once('error', onError);
    try {
      writable.end();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
