import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAzureBlobLeaseProvider } from '../src/storage/azure-blob-lease.mjs';
import { createAzureBlobReleasePointerStore } from '../src/storage/azure-release-pointer.mjs';
import {
  createAzureBlobClient,
  createManagedIdentityTokenProvider,
} from '../src/storage/azure-blob-rest.mjs';

test('managed identity token provider uses ACA identity headers and caches a storage token', async () => {
  const calls = [];
  const tokenProvider = createManagedIdentityTokenProvider({
    env: {
      IDENTITY_ENDPOINT: 'http://identity.test/token',
      IDENTITY_HEADER: 'identity-secret',
      AZURE_CLIENT_ID: 'client-id',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ access_token: 'short-lived-token', expires_in: 3600 }), { status: 200 });
    },
  });

  assert.equal(await tokenProvider(), 'short-lived-token');
  assert.equal(await tokenProvider(), 'short-lived-token');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /resource=https%3A%2F%2Fstorage\.azure\.com%2F/u);
  assert.match(calls[0].url, /client_id=client-id/u);
  assert.equal(calls[0].options.headers['X-IDENTITY-HEADER'], 'identity-secret');
});

test('Azure Blob REST client applies ETag conditions and parses conflict responses', async () => {
  const calls = [];
  const client = createAzureBlobClient({
    endpoint: 'https://account.blob.core.windows.net',
    tokenProvider: async () => 'blob-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response('', { status: 412, headers: { 'x-ms-error-code': 'ConditionNotMet' } });
    },
  });

  await assert.rejects(client.putJson('control', 'current/release-pointer.json', { revision: 2 }, {
    ifMatch: '"etag-1"',
  }), (error) => error.status === 412 && error.code === 'ConditionNotMet');
  assert.equal(calls[0].options.headers['If-Match'], '"etag-1"');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer blob-token');
  assert.equal(calls[0].options.headers['x-ms-blob-type'], 'BlockBlob');
});

test('release pointer commits use If-Match and fail on concurrent changes', async () => {
  const calls = [];
  let current = null;
  let etag = '"one"';
  let raceNextCommit = false;
  const blobClient = {
    async getJson() {
      return current ? { value: current, etag } : null;
    },
    async putJson(_container, _name, value, conditions) {
      calls.push(conditions);
      if (raceNextCommit) {
        raceNextCommit = false;
        etag = '"other-writer"';
      }
      if (conditions.ifMatch && conditions.ifMatch !== etag) {
        const error = new Error('pointer changed');
        error.status = 412;
        throw error;
      }
      current = value;
      etag = '"two"';
    },
  };
  const store = createAzureBlobReleasePointerStore({ blobClient, container: 'control' });
  const pointer = { schema_version: 'release-pointer-v1', revision: 2 };

  assert.equal(await store.read(), null);
  await store.commit(pointer);
  assert.deepEqual(calls[0], { ifNoneMatch: '*' });
  assert.deepEqual(await store.read(), pointer);
  raceNextCommit = true;
  await assert.rejects(store.commit({ ...pointer, revision: 3 }), { code: 'RELEASE_POINTER_CONFLICT' });
  assert.deepEqual(calls[1], { ifMatch: '"two"' });
});

test('Blob lease provider renews its lease and stops publication after lease loss', async () => {
  const calls = [];
  let renew;
  let shouldFailRenew = false;
  const blobClient = {
    async ensureBlob() { calls.push('ensure'); },
    async acquireLease() { calls.push('acquire'); return 'lease-id'; },
    async renewLease(_container, _name, leaseId) {
      calls.push(['renew', leaseId]);
      if (shouldFailRenew) throw new Error('renew failed');
    },
    async releaseLease(_container, _name, leaseId) { calls.push(['release', leaseId]); },
  };
  const provider = createAzureBlobLeaseProvider({
    blobClient,
    container: 'control',
    renewEveryMs: 100,
    setIntervalImpl(callback) { renew = callback; return 1; },
    clearIntervalImpl() {},
  });
  const lease = await provider.acquire();
  await lease.assertHeld();
  await renew();
  assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === 'renew'), true);
  shouldFailRenew = true;
  await renew();
  await assert.rejects(lease.assertHeld(), { code: 'COLLECTOR_LEASE_LOST' });
  await lease.release();
  assert.equal(calls.at(-1)[0], 'release');
});
