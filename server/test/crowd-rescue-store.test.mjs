import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createAzureRescueStore, createFileRescueStore, rescueBlobName } from '../src/storage/crowd-rescue-store.mjs';

const record = (version, hash = `sha256:${String(version).repeat(64).slice(0, 64)}`) => ({
  event: { event_id: 'rescue:abc:1', event_version: version, payload_hash: hash },
  stored_at: '2026-10-12T03:00:00Z',
});

test('blob names hide the event id', () => {
  assert.match(rescueBlobName('rescue:abc:1'), /^rescue\/[0-9a-f]{64}\.json$/);
});

test('file store enforces conditional writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rescue-store-'));
  try {
    const store = createFileRescueStore({ root });
    assert.equal(await store.get('rescue:abc:1'), null);
    const etag = await store.put(record(1), { ifNoneMatch: '*' });
    await assert.rejects(store.put(record(1), { ifNoneMatch: '*' }), (error) => error.status === 412);
    await assert.rejects(store.put(record(2), { ifMatch: 'stale' }), (error) => error.status === 412);
    await store.put(record(2), { ifMatch: etag });
    assert.equal((await store.get('rescue:abc:1')).record.event.event_version, 2);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('azure store maps to blob client calls', async () => {
  const blobs = new Map();
  const blobClient = {
    async getJson(container, name) {
      const entry = blobs.get(`${container}/${name}`);
      return entry ? { value: structuredClone(entry.value), etag: entry.etag } : null;
    },
    async putJson(container, name, value, conditions = {}) {
      const key = `${container}/${name}`;
      const current = blobs.get(key);
      if ((conditions.ifNoneMatch === '*' && current) || (conditions.ifMatch && current?.etag !== conditions.ifMatch)) {
        throw Object.assign(new Error('precondition'), { status: 412 });
      }
      const etag = `"${blobs.size}-${value.event.event_version}"`;
      blobs.set(key, { value: structuredClone(value), etag });
      return etag;
    },
    async listBlobNames(container, prefix) {
      return [...blobs.keys()].filter((key) => key.startsWith(`${container}/${prefix}`)).map((key) => key.slice(container.length + 1));
    },
  };
  const store = createAzureRescueStore({ blobClient, container: 'resilientgeo-crowd' });
  const etag = await store.put(record(1), { ifNoneMatch: '*' });
  assert.equal((await store.get('rescue:abc:1')).etag, etag);
  assert.deepEqual((await store.list()).map((entry) => entry.event.event_version), [1]);
});
