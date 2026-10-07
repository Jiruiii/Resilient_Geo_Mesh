import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createReleaseStore,
  readCurrentLayer,
} from '../src/storage/release-store.mjs';

async function temporaryRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'resilientgeo-store-'));
}

test('release store only allows registered layers and safe immutable paths', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    const store = createReleaseStore({
      releaseRoot,
      layerIds: ['taiwan-shelter'],
    });
    await assert.rejects(store.readLayerManifest('unknown-layer'), /Unknown layer/u);
    await assert.rejects(store.readGovernmentChunk('abc', 'tdx-road', '0.json'), /Invalid revision/u);
    await assert.rejects(store.readGovernmentChunk('1', 'tdx-road', '../0.json'), /Unsafe chunk/u);
    await assert.rejects(store.readLayerChunk('taiwan-shelter', '0/secret.json'), /Unsafe chunk/u);
    await assert.rejects(readCurrentLayer(releaseRoot, 'unknown-layer'), /Unknown layer/u);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('release store rejects oversized public files before parsing them', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await mkdir(path.join(releaseRoot, 'current'), { recursive: true });
    await writeFile(path.join(releaseRoot, 'current', 'feed.json'), '{"payload":"' + 'x'.repeat(1024) + '"}');
    const store = createReleaseStore({ releaseRoot, maxBytes: 512 });
    await assert.rejects(store.readFeed(), /exceeds maximum size/u);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('release store refuses a symlinked public path that escapes the release root', async () => {
  const releaseRoot = await temporaryRoot();
  const outsideRoot = await temporaryRoot();
  try {
    await mkdir(path.join(outsideRoot, 'layers', 'taiwan-shelter'), { recursive: true });
    await writeFile(path.join(outsideRoot, 'layers', 'taiwan-shelter', 'manifest.json'), '{}');
    await mkdir(path.join(releaseRoot, 'current'), { recursive: true });
    await symlink(path.join(outsideRoot, 'layers'), path.join(releaseRoot, 'current', 'layers'));
    const store = createReleaseStore({ releaseRoot, layerIds: ['taiwan-shelter'] });
    await assert.rejects(store.readLayerManifest('taiwan-shelter'), /Unsafe release path/u);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('release store follows one immutable pointer for feed, v2, and layer files without symlinks', async () => {
  const releaseRoot = await temporaryRoot();
  const pointer = {
    schema_version: 'release-pointer-v1',
    revision: 7,
    feed_path: 'releases/7/feed.json',
    v2_manifest_path: `v2/manifests/${'b'.repeat(64)}.json`,
    layers: { 'taiwan-shelter': 3 },
  };
  try {
    await mkdir(path.join(releaseRoot, 'releases', '7'), { recursive: true });
    await mkdir(path.join(releaseRoot, 'v2', 'manifests'), { recursive: true });
    await mkdir(path.join(releaseRoot, 'v2', 'chunks'), { recursive: true });
    await mkdir(path.join(releaseRoot, 'releases', 'layers', 'taiwan-shelter', '3', 'chunks'), { recursive: true });
    await mkdir(path.join(releaseRoot, 'current'), { recursive: true });
    await writeFile(path.join(releaseRoot, 'current', 'release-pointer.json'), JSON.stringify(pointer));
    await writeFile(path.join(releaseRoot, 'releases', '7', 'feed.json'), JSON.stringify({ revision: 7 }));
    await writeFile(path.join(releaseRoot, ...pointer.v2_manifest_path.split('/')), JSON.stringify({ schema_version: 'government-feed-v2' }));
    await writeFile(path.join(releaseRoot, 'v2', 'chunks', `${'a'.repeat(64)}.json`), JSON.stringify({ chunk_id: 'immutable' }));
    await writeFile(path.join(releaseRoot, 'releases', 'layers', 'taiwan-shelter', '3', 'manifest.json'), JSON.stringify({ dataset_version: 3 }));
    await writeFile(path.join(releaseRoot, 'releases', 'layers', 'taiwan-shelter', '3', 'chunks', '0.json'), JSON.stringify({ sequence: 0 }));

    const store = createReleaseStore({ releaseRoot, layerIds: ['taiwan-shelter'] });
    assert.deepEqual(await store.readFeed(), { revision: 7 });
    assert.deepEqual(await store.readV2Feed(), { schema_version: 'government-feed-v2' });
    assert.deepEqual(await store.readV2Chunk('a'.repeat(64)), { chunk_id: 'immutable' });
    assert.deepEqual(await store.readLayerManifest('taiwan-shelter'), { dataset_version: 3 });
    assert.deepEqual(await store.readLayerChunk('taiwan-shelter', '0.json'), { sequence: 0 });
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('an external pointer store is authoritative while the first release is being staged', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await mkdir(path.join(releaseRoot, 'current'), { recursive: true });
    await writeFile(path.join(releaseRoot, 'current', 'feed.json'), JSON.stringify({ revision: 1 }));
    const store = createReleaseStore({
      releaseRoot,
      releasePointerStore: { async read() { return null; } },
    });
    await assert.rejects(store.readFeed(), { code: 'ENOENT' });
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});
