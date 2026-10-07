import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { publishGovernmentRelease, publishStaticLayer } from '../src/publisher/release-publisher.mjs';
import { createBackup, restoreBackup, verifyBackup } from '../src/ops/backup-restore.mjs';
import { createMigrationSnapshot, restoreMigrationSnapshot, verifyMigrationSnapshot } from '../src/ops/migration-snapshot.mjs';
import { writeSourceResult } from '../src/storage/source-cache.mjs';

const keys = generateEd25519KeyPair();
const signingKey = { privateKey: keys.privateKey, publicKey: keys.publicKey, keyId: 'backup-test-key' };
const NOW = new Date('2026-10-02T12:00:00Z');
const fixtureEvent = JSON.parse(readFileSync(new URL('../../fixtures/events-batch-1.json', import.meta.url))).events[0];
const event = {
  ...fixtureEvent,
  event_id: 'ncdr:backup-test',
  expires_at: '2026-10-03T12:00:00Z',
  attributes: { area_id: 'tw.63000100', theme: 'flood' },
};
const feature = {
  schema_version: 'feature-v0',
  namespace: 'official.shelter',
  dataset_id: 'resilientgeo-taiwan',
  layer_id: 'taiwan-shelter',
  feature_id: 'shelter:backup-test',
  feature_type: 'SHELTER',
  geometry: { type: 'Point', coordinates: [121.58, 25.08] },
  properties: { name: 'Backup shelter' },
  source: 'taiwan-shelter',
  source_version: 'backup-test',
  issued_at: NOW.toISOString(),
  expires_at: '2026-10-03T12:00:00Z',
  signature_algorithm: 'Ed25519',
  signing_key_id: signingKey.keyId,
  provenance: {
    original_source: 'taiwan-shelter',
    received_at: NOW.toISOString(),
    transport_source: { kind: 'server' },
  },
};

test('backup and restore copy private/public data without private keys and verify signed outputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-backup-test-'));
  const privateRoot = path.join(root, 'private');
  const publicRoot = path.join(root, 'public');
  const backupRoot = path.join(root, 'backup');
  const restoredPrivateRoot = path.join(root, 'restored-private');
  const restoredPublicRoot = path.join(root, 'restored-public');
  try {
    await mkdir(privateRoot, { recursive: true });
    await publishGovernmentRelease({
      releaseRoot: publicRoot,
      previousRoot: publicRoot,
      results: [{ id: 'ncdr', status: 'ok', events: [event] }],
      signingKey,
      now: NOW,
    });
    await publishStaticLayer({
      releaseRoot: publicRoot,
      layerId: 'taiwan-shelter',
      features: [feature],
      signingKey,
      now: NOW,
    });
    await writeFile(path.join(root, 'private-marker'), 'not part of backup');
    await writeFile(path.join(privateRoot, 'source-cache-marker'), 'cache');

    const created = await createBackup({
      privateDataRoot: privateRoot,
      publicReleaseRoot: publicRoot,
      destination: backupRoot,
      publicKey: keys.publicKey,
      signingKeyId: signingKey.keyId,
      now: NOW,
    });
    assert.equal(created.feed_revision, 1);
    assert.equal(created.v2_feed_verified, true);
    assert.ok(created.v2_chunk_count > 0);
    assert.equal(await verifyBackup({
      backupRoot,
      publicKey: keys.publicKey,
      signingKeyId: signingKey.keyId,
      now: NOW,
    }).then((report) => report.valid), true);
    assert.equal(await readFile(path.join(backupRoot, 'private_data', 'source-cache-marker'), 'utf8'), 'cache');
    assert.equal(await readFile(path.join(backupRoot, 'backup-manifest.json'), 'utf8').then((value) => value.includes('private-key.pem')), false);

    const restored = await restoreBackup({
      backupRoot,
      privateDataRoot: restoredPrivateRoot,
      publicReleaseRoot: restoredPublicRoot,
      publicKey: keys.publicKey,
      signingKeyId: signingKey.keyId,
      now: NOW,
    });
    assert.equal(restored.feed_revision, 1);
    assert.equal(restored.v2_feed_verified, true);
    assert.equal(restored.valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backup rejects a signing key found inside the data roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-backup-key-test-'));
  try {
    const privateRoot = path.join(root, 'private');
    const publicRoot = path.join(root, 'public');
    await mkdir(privateRoot, { recursive: true });
    await writeFile(path.join(privateRoot, 'signing-private-key.pem'), 'do not copy');
    await assert.rejects(createBackup({
      privateDataRoot: privateRoot,
      publicReleaseRoot: publicRoot,
      destination: path.join(root, 'backup'),
      publicKey: keys.publicKey,
      signingKeyId: signingKey.keyId,
      now: NOW,
    }), /private key/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration snapshot copies only current release files and required private state, then verifies and restores', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-migration-snapshot-'));
  const privateRoot = path.join(root, 'private');
  const publicRoot = path.join(root, 'public');
  const catalogPath = path.join(root, 'area-catalog.json');
  const snapshotRoot = path.join(root, 'snapshot');
  const restoredPrivate = path.join(root, 'restored-private');
  const restoredPublic = path.join(root, 'restored-public');
  const remotePointers = [];
  try {
    await mkdir(privateRoot, { recursive: true });
    await writeFile(catalogPath, JSON.stringify({ schema_version: 'area-catalog-fixture' }));
    await writeFile(path.join(privateRoot, 'unused-large-input.bin'), 'not required for the Azure runtime');
    await writeSourceResult(privateRoot, 'cwa-earthquake', {
      snapshot: {
        schema_version: 'raw-snapshot-v0',
        source_id: 'cwa-earthquake',
        request: { method: 'GET', url: 'https://upstream.test/cwa', query: {} },
        response: { status: 200, headers: {} },
        retrieved_at: NOW.toISOString(),
        payload: { records: [] },
      },
      normalized: { schema_version: 'normalized-fixture-v1', events: [] },
      state: {
        schema_version: 'source-state-v1',
        source_id: 'cwa-earthquake',
        status: 'ok',
        checked_at: NOW.toISOString(),
        retrieved_at: NOW.toISOString(),
        last_success_at: NOW.toISOString(),
        error_code: null,
      },
    });
    await publishGovernmentRelease({
      releaseRoot: publicRoot,
      results: [{ id: 'ncdr', status: 'ok', events: [event] }],
      signingKey,
      now: NOW,
    });
    await publishStaticLayer({
      releaseRoot: publicRoot,
      layerId: 'taiwan-shelter',
      features: [feature],
      signingKey,
      now: NOW,
    });

    const created = await createMigrationSnapshot({
      privateDataRoot: privateRoot,
      publicReleaseRoot: publicRoot,
      destination: snapshotRoot,
      areaCatalogPath: catalogPath,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      signingKeyId: signingKey.keyId,
      now: NOW,
    });
    assert.equal(created.valid, true);
    assert.equal(created.feed_revision, 1);
    assert.equal(created.v2_feed_verified, true);
    assert.equal(await readFile(path.join(snapshotRoot, 'private_data', 'area-catalog.json'), 'utf8'), await readFile(catalogPath, 'utf8'));
    assert.equal(await readFile(path.join(snapshotRoot, 'private_data', 'source-cache', 'cwa-earthquake', 'raw.json'), 'utf8').then(Boolean), true);
    await assert.rejects(readFile(path.join(snapshotRoot, 'private_data', 'unused-large-input.bin')));

    const verification = await verifyMigrationSnapshot({
      snapshotRoot,
      publicKey: keys.publicKey,
      signingKeyId: signingKey.keyId,
      now: NOW,
    });
    assert.equal(verification.valid, true);
    const restored = await restoreMigrationSnapshot({
      snapshotRoot,
      privateDataRoot: restoredPrivate,
      publicReleaseRoot: restoredPublic,
      publicKey: keys.publicKey,
      signingKeyId: signingKey.keyId,
      releasePointerStore: {
        async commit(pointer) { remotePointers.push(pointer); },
      },
      now: NOW,
    });
    assert.equal(restored.feed_revision, 1);
    assert.equal(remotePointers.length, 1);
    assert.equal(remotePointers[0].revision, 1);

    const manifest = JSON.parse(await readFile(path.join(snapshotRoot, 'public_release', 'current', 'v2', 'feed.json'), 'utf8'));
    const chunkHash = manifest.chunks[0].sha256.slice('sha256:'.length);
    const actualV2Chunk = path.join(snapshotRoot, 'public_release', 'v2', 'chunks', `${chunkHash}.json`);
    await writeFile(actualV2Chunk, '{}');
    await assert.rejects(verifyMigrationSnapshot({
      snapshotRoot,
      publicKey: keys.publicKey,
      signingKeyId: signingKey.keyId,
      now: NOW,
    }), /file hash mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
