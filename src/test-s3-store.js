/**
 * Shared in-memory object store implementing the S3 adapter contract used by
 * unit tests (r2, restore, backup orchestrator). Not a test file.
 */

import assert from 'node:assert/strict';
import { R2Error } from './r2.js';

export function memoryStore() {
  const objects = new Map(); // key -> { body: Buffer, size, metadata }
  const calls = [];
  const adapter = {
    callLog: calls,
    async headBucket({ bucket: _bucket } = {}) {
      calls.push('headBucket');
    },
    async listObjects({ bucket: _bucket, prefix = '', continuationToken } = {}) {
      calls.push(['listObjects', prefix]);
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const pageSize = 1000;
      const start = continuationToken ? Number(continuationToken) : 0;
      const page = keys.slice(start, start + pageSize);
      return {
        keys: page.map((key) => ({ key, size: objects.get(key).size })),
        isTruncated: start + pageSize < keys.length,
        nextToken: start + pageSize < keys.length ? String(start + pageSize) : undefined,
      };
    },
    async headObject({ bucket: _bucket, key }) {
      calls.push(['headObject', key]);
      const o = objects.get(key);
      if (!o) throw new R2Error(`object not found: ${key}`);
      return { size: o.size, metadata: o.metadata };
    },
    async getObject({ bucket: _bucket, key }) {
      calls.push(['getObject', key]);
      const o = objects.get(key);
      if (!o) throw new R2Error(`object not found: ${key}`);
      const { Readable } = await import('node:stream');
      return { size: o.size, metadata: o.metadata, body: Readable.from([o.body]) };
    },
    async putObject({ bucket: _bucket, key, body, contentLength, contentType, metadata }) {
      calls.push(['putObject', key]);
      let buffer;
      if (Buffer.isBuffer(body)) {
        buffer = body;
      } else {
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk);
        buffer = Buffer.concat(chunks);
      }
      assert.equal(buffer.length, contentLength, `contentLength mismatch for ${key}`);
      objects.set(key, {
        body: buffer,
        size: buffer.length,
        metadata: { ...metadata, contentType },
      });
    },
    async deleteObjects({ bucket: _bucket, keys }) {
      assert.ok(keys.length <= 1000, 'fake API limit: DeleteObjects accepts at most 1,000 keys');
      calls.push(['deleteObjects', keys.length]);
      for (const key of keys) objects.delete(key);
    },
    _objects: objects,
  };
  return { adapter, objects, calls };
}
