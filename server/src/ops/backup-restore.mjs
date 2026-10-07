import { cp, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { verifyFeatureBundle } from '../../../pipeline/lib/feature-bundle.mjs';
import { verifyBundle } from '../../../pipeline/lib/contract.mjs';
import { verifyFeed } from '../../../pipeline/lib/government-feed.mjs';
import { verifyGovernmentFeedV2 } from '../../../pipeline/lib/government-feed-v2.mjs';
import { SOURCE_REGISTRY } from '../source-registry.mjs';
import { createReleaseStore } from '../storage/release-store.mjs';

const PRIVATE_KEY_RE = /(?:private[-_ ]?key|signing[-_ ]?private|secret[-_ ]?key)/iu;
const GOVERNMENT_CHUNK_RE = /^releases\/[1-9]\d*\/[a-z][a-z0-9-]+\/\d+\.json$/u;

function absoluteRoot(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return path.normalize(value);
}

function dateValue(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError('now must be a valid date');
  return result;
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoPrivateKeyFiles(root) {
  if (!(await exists(root))) return;
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error(`${root} must be a directory`);
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const target = path.join(directory, name);
      const entry = await lstat(target);
      if (PRIVATE_KEY_RE.test(name)) throw new Error(`private key found in data root: ${target}`);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(target);
    }
  }
  await walk(root);
}

async function ensureEmptyDirectory(target, name) {
  if (!(await exists(target))) {
    await mkdir(target, { recursive: true });
    return;
  }
  const info = await lstat(target);
  if (!info.isDirectory()) throw new Error(`${name} must be a directory`);
  if ((await readdir(target)).length > 0) {
    const error = new Error(`${name} must be empty`);
    error.code = 'BACKUP_TARGET_NOT_EMPTY';
    throw error;
  }
}

async function copyDirectoryContents(source, destination) {
  if (!(await exists(source))) {
    await mkdir(destination, { recursive: true });
    return;
  }
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    await cp(path.join(source, name), path.join(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
}

async function verifyGovernment(feed, store, publicKey, signingKeyId) {
  for (const dataset of feed.datasets) {
    const chunks = [];
    for (const chunkPath of dataset.chunk_paths ?? []) {
      if (!GOVERNMENT_CHUNK_RE.test(chunkPath)) throw new Error('backup contains an unsafe government chunk path');
      const match = /^releases\/(\d+)\/([a-z][a-z0-9-]+)\/(\d+\.json)$/u.exec(chunkPath);
      chunks.push(await store.readGovernmentChunk(match[1], match[2], match[3]));
    }
    const result = verifyBundle({ manifest: dataset.manifest, chunks }, publicKey, {
      trustedKeyIds: [signingKeyId],
    });
    if (!result.valid) throw new Error(`backup government bundle verification failed: ${dataset.source_id}`);
  }
}

async function verifyLayers(store, publicKey, signingKeyId, now) {
  const layers = [];
  for (const definition of SOURCE_REGISTRY.filter((source) => source.kind === 'static')) {
    try {
      const bundle = await store.readLayerBundle(definition.output.layerId);
      const result = verifyFeatureBundle(bundle, publicKey, {
        trustedKeyIds: [signingKeyId],
        now,
      });
      if (!result.valid) throw new Error(`backup static layer verification failed: ${definition.output.layerId}`);
      layers.push(definition.output.layerId);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return layers;
}

async function verifyV2Feed(store, publicKey, signingKeyId, now) {
  let manifest;
  try {
    manifest = await store.readV2Feed();
  } catch (error) {
    if (error.code === 'ENOENT') return { valid: false, chunk_count: 0, unavailable: true };
    throw error;
  }
  if (manifest.signing_key_id !== signingKeyId) throw new Error('backup v2 feed signing key is not trusted');
  const chunks = await Promise.all(manifest.chunks.map((entry) => {
    const match = /^v2\/chunks\/([0-9a-f]{64})\.json$/u.exec(String(entry.path));
    if (!match) throw new Error('backup contains an unsafe v2 chunk path');
    return store.readV2Chunk(match[1]);
  }));
  const result = verifyGovernmentFeedV2(manifest, chunks, publicKey, {
    trustedKeyIds: [signingKeyId],
    now,
  });
  if (!result.valid) throw new Error(`backup v2 feed verification failed: ${result.reason}`);
  return { valid: true, chunk_count: chunks.length, revision: manifest.revision };
}

export async function verifyReleaseRoot(publicRoot, publicKey, signingKeyId, now, releasePointerStore) {
  const store = createReleaseStore({ releaseRoot: publicRoot, releasePointerStore });
  const feed = await store.readFeed();
  verifyFeed(feed, publicKey, { signingKeyId });
  await verifyGovernment(feed, store, publicKey, signingKeyId);
  const layers = await verifyLayers(store, publicKey, signingKeyId, now);
  const v2 = await verifyV2Feed(store, publicKey, signingKeyId, now);
  return {
    valid: true,
    feed_revision: feed.revision,
    dataset_count: feed.datasets.length,
    layers,
    v2_feed_verified: v2.valid,
    v2_chunk_count: v2.chunk_count,
  };
}

export async function verifyBackup({ backupRoot, publicKey, signingKeyId, now = new Date() } = {}) {
  const root = absoluteRoot(backupRoot, 'backupRoot');
  const currentTime = dateValue(now);
  if (!publicKey) throw new TypeError('publicKey is required');
  return verifyReleaseRoot(path.join(root, 'public_release'), publicKey, signingKeyId, currentTime);
}

export async function createBackup({
  privateDataRoot,
  publicReleaseRoot,
  destination,
  publicKey,
  signingKeyId,
  releasePointerStore,
  now = new Date(),
} = {}) {
  const privateRoot = absoluteRoot(privateDataRoot, 'privateDataRoot');
  const publicRoot = absoluteRoot(publicReleaseRoot, 'publicReleaseRoot');
  const destinationRoot = absoluteRoot(destination, 'destination');
  if (privateRoot === publicRoot || within(privateRoot, destinationRoot) || within(publicRoot, destinationRoot)) {
    throw new Error('backup destination must be outside the source data roots');
  }
  const currentTime = dateValue(now);
  await assertNoPrivateKeyFiles(privateRoot);
  await assertNoPrivateKeyFiles(publicRoot);
  await ensureEmptyDirectory(destinationRoot, 'backup destination');
  await copyDirectoryContents(privateRoot, path.join(destinationRoot, 'private_data'));
  await copyDirectoryContents(publicRoot, path.join(destinationRoot, 'public_release'));
  if (releasePointerStore && typeof releasePointerStore.read === 'function') {
    const pointer = await releasePointerStore.read();
    if (pointer) {
      await writeFile(path.join(destinationRoot, 'public_release', 'current', 'release-pointer.json'),
        `${JSON.stringify(pointer)}\n`, 'utf8');
    }
  }
  const report = await verifyBackup({
    backupRoot: destinationRoot,
    publicKey,
    signingKeyId,
    now: currentTime,
  });
  await writeFile(path.join(destinationRoot, 'backup-manifest.json'), `${JSON.stringify({
    schema_version: 'backup-manifest-v1',
    created_at: currentTime.toISOString(),
    feed_revision: report.feed_revision,
    dataset_count: report.dataset_count,
    layers: report.layers,
    v2_feed_verified: report.v2_feed_verified,
    v2_chunk_count: report.v2_chunk_count,
    includes: ['private_data', 'public_release'],
    excludes: ['signing private keys', 'upstream credentials'],
  }, null, 2)}\n`, 'utf8');
  return report;
}

export async function restoreBackup({
  backupRoot,
  privateDataRoot,
  publicReleaseRoot,
  publicKey,
  signingKeyId,
  releasePointerStore,
  now = new Date(),
} = {}) {
  const sourceRoot = absoluteRoot(backupRoot, 'backupRoot');
  const privateRoot = absoluteRoot(privateDataRoot, 'privateDataRoot');
  const publicRoot = absoluteRoot(publicReleaseRoot, 'publicReleaseRoot');
  if (privateRoot === publicRoot || within(sourceRoot, privateRoot) || within(sourceRoot, publicRoot)) {
    throw new Error('restore targets must be outside the backup root');
  }
  const currentTime = dateValue(now);
  const report = await verifyBackup({ backupRoot: sourceRoot, publicKey, signingKeyId, now: currentTime });
  await ensureEmptyDirectory(privateRoot, 'private restore target');
  await ensureEmptyDirectory(publicRoot, 'public restore target');
  await copyDirectoryContents(path.join(sourceRoot, 'private_data'), privateRoot);
  await copyDirectoryContents(path.join(sourceRoot, 'public_release'), publicRoot);
  const restored = await verifyReleaseRoot(publicRoot, publicKey, signingKeyId, currentTime);
  if (releasePointerStore && typeof releasePointerStore.commit === 'function') {
    const pointer = await createReleaseStore({ releaseRoot: publicRoot }).readCurrentPointer();
    if (pointer) await releasePointerStore.commit(pointer);
  }
  return { ...restored, source_feed_revision: report.feed_revision };
}
