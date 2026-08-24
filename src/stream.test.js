import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { writeWithBackpressure, endWritable } from './stream.js';

/** A Writable whose first _write callback we hold to simulate backpressure. */
function heldWritable({ highWaterMark = 16 } = {}) {
  const chunks = [];
  const held = [];
  const w = new Writable({
    highWaterMark,
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      if (held.length === 0) held.push(cb);
      else cb();
    },
  });
  return { w, chunks, held };
}

test('stream: writeWithBackpressure writes the chunk and resolves when accepted', async () => {
  const { w, chunks } = heldWritable();
  await writeWithBackpressure(w, Buffer.from('one'));
  assert.deepEqual(
    chunks.map((c) => c.toString()),
    ['one'],
  );
});

test('stream: writeWithBackpressure waits for drain under backpressure', async () => {
  const { w, held } = heldWritable();
  const first = writeWithBackpressure(w, Buffer.alloc(64));
  const second = writeWithBackpressure(w, Buffer.alloc(64));
  let settled = false;
  const secondSettled = second.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(settled, false, 'second write must wait for the held callback (drain)');
  held[0]();
  await Promise.all([first, secondSettled]);
  assert.equal(settled, true);
});

test('stream: write errors reject and temporary listeners are removed', async () => {
  const w = new Writable({
    highWaterMark: 16,
    write(_c, _e, cb) {
      setImmediate(() => cb(new Error('boom-write')));
    },
  });
  w.on('error', () => {});
  await new Promise((r) => setTimeout(r, 25));
  await assert.rejects(() => writeWithBackpressure(w, Buffer.alloc(64)), /boom-write/);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(w.listenerCount('drain'), 0);
  // only the permanent no-op handler remains; the temporary listener was removed
  assert.equal(w.listenerCount('error'), 1);
});

test('stream: endWritable resolves when the stream closes and removes listeners', async () => {
  const w = new Writable({
    write(c, _e, cb) {
      cb();
    },
  });
  await endWritable(w);
  assert.equal(w.writableEnded, true);
  assert.equal(w.listenerCount('close'), 0);
  assert.equal(w.listenerCount('error'), 0);
});

test('stream: endWritable rejects on a finalizer error and removes listeners', async () => {
  const w = new Writable({
    write(c, _e, cb) {
      cb();
    },
    final(cb) {
      setImmediate(() => cb(new Error('boom-end')));
    },
  });
  w.on('error', () => {});
  await assert.rejects(() => endWritable(w), /boom-end/);
  assert.equal(w.listenerCount('close'), 0);
});

test('stream: endWritable is safe on an already-finished stream', async () => {
  const w = new Writable({
    write(c, _e, cb) {
      cb();
    },
  });
  w.end();
  await new Promise((r) => setTimeout(r, 25));
  await endWritable(w);
});

test('stream: endWritable resolves on finish for streams that never emit close', async () => {
  const w = new Writable({
    write(c, _e, cb) {
      cb();
    },
    emitClose: false,
  });
  // `emitClose: false` streams never emit 'close'; ending must still settle
  // on 'finish' instead of hanging forever.
  const settled = await Promise.race([
    endWritable(w).then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 500)),
  ]);
  assert.equal(settled, 'settled', 'endWritable must not hang without a close event');
  assert.equal(w.writableFinished, true);
  assert.equal(w.listenerCount('error'), 0);
  assert.equal(w.listenerCount('finish'), 0);
});

test('stream: endWritable waits for flush when end() was already called', async () => {
  let flushed = false;
  const w = new Writable({
    highWaterMark: 16,
    write(c, _e, cb) {
      setTimeout(() => {
        flushed = true;
        cb();
      }, 60);
    },
  });
  w.write(Buffer.alloc(64)); // exceeds highWaterMark: callback held for 60ms
  w.end();
  // writableEnded is already true; endWritable must still wait for the
  // buffered data to flush instead of resolving on "end requested".
  const settlement = endWritable(w).then(() => 'settled');
  const early = await Promise.race([
    settlement,
    new Promise((r) => setTimeout(() => r('early'), 30)),
  ]);
  assert.equal(early, 'early', 'endWritable must not resolve before the data flushed');
  assert.equal(await settlement, 'settled');
  assert.equal(flushed, true);
});

test('stream: a late error after write acceptance is surfaced by endWritable, never uncaught', async () => {
  const w = new Writable({
    highWaterMark: 16,
    write(c, _e, cb) {
      cb();
    },
  });
  await writeWithBackpressure(w, Buffer.from('x'));
  await new Promise((r) => setImmediate(r));
  // The write settled; only the lifetime late-error observer may remain.
  // Emitting an error here must never become an uncaught exception and must
  // surface when the stream is ended.
  w.emit('error', new Error('late-flush-failure'));
  await assert.rejects(() => endWritable(w), /late-flush-failure/);
});

test('stream: writeWithBackpressure after settlement leaves a single lifetime error observer', async () => {
  const w = new Writable({
    write(c, _e, cb) {
      cb();
    },
  });
  await writeWithBackpressure(w, Buffer.from('x'));
  assert.equal(w.listenerCount('drain'), 0);
  // One late-error observer remains until the stream finishes/closes so an
  // async flush failure can never become an uncaught exception.
  assert.equal(w.listenerCount('error'), 1);
  await endWritable(w);
  assert.equal(w.listenerCount('error'), 0, 'observer must be removed when the stream ends');
  await endWritable(w);
});
