import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRawSnapshot, requestJsonConditional } from '../../pipeline/lib/source.mjs';
import {
  readSourceSnapshot,
  readSourceState,
  writeSourceResult,
} from '../src/storage/source-cache.mjs';

function response({ status = 200, payload = { records: [] }, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    async json() { return payload; },
  };
}

async function createRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-source-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function snapshot(retrievedAt = '2026-10-02T00:00:00Z') {
  return makeRawSnapshot({
    sourceId: 'test-source',
    request: {
      method: 'GET',
      url: 'https://example.gov.tw/data?api_key=secret',
      query: { api_key: 'secret', format: 'json' },
    },
    responseStatus: 200,
    responseHeaders: {
      ETag: '"snapshot-1"',
      'Last-Modified': 'Wed, 02 Oct 2026 00:00:00 GMT',
      'Content-Type': 'application/json',
    },
    retrievedAt,
    payload: { records: [{ id: 'one' }] },
  });
}

test('writes and reads a secret-free source snapshot and state', async (t) => {
  const root = await createRoot(t);
  await writeSourceResult(root, 'test-source', {
    snapshot: snapshot(),
    normalized: { schema_version: 'event-batch-v0', events: [] },
    state: {
      schema_version: 'source-state-v1',
      source_id: 'test-source',
      status: 'ok',
      checked_at: '2026-10-02T00:00:00Z',
      retrieved_at: '2026-10-02T00:00:00Z',
      last_success_at: '2026-10-02T00:00:00Z',
      etag: '"snapshot-1"',
      last_modified: 'Wed, 02 Oct 2026 00:00:00 GMT',
      content_sha256: 'hash-one',
      partial: false,
      error_code: null,
    },
  });

  const storedSnapshot = await readSourceSnapshot(root, 'test-source');
  const storedState = await readSourceState(root, 'test-source');
  assert.deepEqual(storedSnapshot.payload.records, [{ id: 'one' }]);
  assert.equal(storedState.etag, '"snapshot-1"');
  assert.equal(JSON.stringify(storedSnapshot).includes('secret'), false);
  assert.equal(JSON.stringify(storedState).includes('secret'), false);
});

test('uses stored validators and leaves the payload unchanged on 304', async (t) => {
  const root = await createRoot(t);
  const firstSnapshot = snapshot();
  const firstState = {
    schema_version: 'source-state-v1',
    source_id: 'test-source',
    status: 'ok',
    checked_at: '2026-10-02T00:00:00Z',
    retrieved_at: '2026-10-02T00:00:00Z',
    last_success_at: '2026-10-02T00:00:00Z',
    etag: '"snapshot-1"',
    last_modified: 'Wed, 02 Oct 2026 00:00:00 GMT',
    content_sha256: 'hash-one',
    partial: false,
    error_code: null,
  };
  await writeSourceResult(root, 'test-source', {
    snapshot: firstSnapshot,
    normalized: { schema_version: 'event-batch-v0', events: [{ event_id: 'one' }] },
    state: firstState,
  });
  const before = await readFile(path.join(root, 'source-cache/test-source/raw.json'), 'utf8');
  const state = await readSourceState(root, 'test-source');
  const requests = [];
  const result = await requestJsonConditional('https://example.gov.tw/data', {
    validators: { etag: state.etag, lastModified: state.last_modified },
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return response({ status: 304, headers: { ETag: state.etag, 'Last-Modified': state.last_modified } });
    },
    maxAttempts: 1,
  });
  assert.equal(result.notModified, true);
  assert.equal(requests[0].headers['If-None-Match'], state.etag);
  assert.equal(requests[0].headers['If-Modified-Since'], state.last_modified);

  await writeSourceResult(root, 'test-source', {
    snapshot: firstSnapshot,
    normalized: { schema_version: 'event-batch-v0', events: [{ event_id: 'one' }] },
    state: { ...state, status: 'not_modified', checked_at: '2026-10-02T00:10:00Z' },
  });
  const after = await readFile(path.join(root, 'source-cache/test-source/raw.json'), 'utf8');
  assert.equal(after, before);
  assert.equal((await readSourceState(root, 'test-source')).status, 'not_modified');
});

test('rejects unsafe source IDs and preserves the previous readable state', async (t) => {
  const root = await createRoot(t);
  const state = {
    schema_version: 'source-state-v1',
    source_id: 'test-source',
    status: 'ok',
    checked_at: '2026-10-02T00:00:00Z',
    retrieved_at: '2026-10-02T00:00:00Z',
    last_success_at: '2026-10-02T00:00:00Z',
    etag: null,
    last_modified: null,
    content_sha256: 'hash-one',
    partial: false,
    error_code: null,
  };
  await writeSourceResult(root, 'test-source', { snapshot: snapshot(), normalized: {}, state });
  await assert.rejects(
    writeSourceResult(root, '../other', { snapshot: snapshot(), normalized: {}, state }),
    /source ID/u,
  );
  assert.equal((await readSourceState(root, 'test-source')).status, 'ok');
});
