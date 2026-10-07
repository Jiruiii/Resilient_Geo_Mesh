import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Bytes } from '../../../pipeline/lib/canonical.mjs';
import { signCanonical, verifyCanonical } from '../../../pipeline/lib/crypto.mjs';
import { SOURCE_REGISTRY } from '../source-registry.mjs';
import { createReleaseStore } from '../storage/release-store.mjs';
import { verifyReleaseRoot } from './backup-restore.mjs';

const GOVERNMENT_CHUNK_RE = /^releases\/[1-9]\d*\/[a-z][a-z0-9-]+\/\d+\.json$/u;
const V2_CHUNK_RE = /^v2\/chunks\/[0-9a-f]{64}\.json$/u;
const PRIVATE_KEY_RE = /(?:private[-_ ]?key|signing[-_ ]?private|secret[-_ ]?key)/iu;

function absoluteRoot(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  const root = path.normalize(value);
  if (root === path.parse(root).root) throw new TypeError(`${name} cannot be a filesystem root`);
  return root;
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exists(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoPrivateKeyFiles(root) {
  const info = await exists(root);
  if (!info) return;
  if (!info.isDirectory()) throw new Error(`${root} must be a directory`);
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const childPath = path.join(directory, name);
      const child = await lstat(childPath);
      if (PRIVATE_KEY_RE.test(name)) throw new Error(`private key found in data root: ${childPath}`);
      if (child.isSymbolicLink()) throw new Error(`symbolic link found in migration data root: ${childPath}`);
      if (child.isDirectory()) await walk(childPath);
    }
  }
  await walk(root);
}

async function ensureEmptyDirectory(root, label) {
  const info = await exists(root);
  if (!info) {
    await mkdir(root, { recursive: true });
    return;
  }
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  if ((await readdir(root)).length > 0) {
    const error = new Error(`${label} must be empty`);
    error.code = 'SNAPSHOT_TARGET_NOT_EMPTY';
    throw error;
  }
}

async function copyFile(source, destination) {
  const info = await lstat(source);
  if (!info.isFile()) throw new Error(`migration input is not a regular file: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false, dereference: false });
}

async function writeJson(root, relativePath, value) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), `${JSON.stringify(value)}\n`, 'utf8', { flag: 'wx' });
}

async function copyPrivateInputs({ sourcePrivateRoot, destinationPrivateRoot, areaCatalogPath,
  emergencyMedicalRosterPath, emergencyMedicalCrosswalkPath }) {
  const sourceIds = SOURCE_REGISTRY.filter((source) => source.enabledByDefault).map((source) => source.sourceId);
  for (const sourceId of sourceIds) {
    for (const name of ['raw.json', 'normalized.json', 'state.json']) {
      const source = path.join(sourcePrivateRoot, 'source-cache', sourceId, name);
      if (await exists(source)) {
        await copyFile(source, path.join(destinationPrivateRoot, 'source-cache', sourceId, name));
      }
    }
  }
  await copyFile(areaCatalogPath, path.join(destinationPrivateRoot, 'area-catalog.json'));
  const hasEmergencyRoster = Boolean(emergencyMedicalRosterPath);
  const hasEmergencyCrosswalk = Boolean(emergencyMedicalCrosswalkPath);
  if (hasEmergencyRoster !== hasEmergencyCrosswalk) {
    throw new TypeError('emergency medical roster and crosswalk paths must be provided together');
  }
  if (hasEmergencyRoster) {
    await copyFile(emergencyMedicalRosterPath, path.join(destinationPrivateRoot, 'config', 'emergency-medical-roster.json'));
    await copyFile(emergencyMedicalCrosswalkPath, path.join(destinationPrivateRoot, 'config', 'emergency-medical-crosswalk.json'));
  }
}

async function copyCurrentPublicRelease({ sourceStore, destinationRoot }) {
  const feed = await sourceStore.readFeed();
  const pointer = await sourceStore.readCurrentPointer();
  const layerVersions = {};
  const nextPointer = {
    schema_version: 'release-pointer-v1',
    revision: feed.revision,
    feed_path: `releases/${feed.revision}/feed.json`,
    v2_manifest_path: null,
    layers: {},
  };
  const feedPath = nextPointer.feed_path;
  await writeJson(destinationRoot, feedPath, feed);
  await writeJson(destinationRoot, 'current/feed.json', feed);
  for (const dataset of feed.datasets) {
    for (const chunkPath of dataset.chunk_paths ?? []) {
      if (!GOVERNMENT_CHUNK_RE.test(chunkPath)) throw new Error('current feed contains an unsafe chunk path');
      const [release, revision, sourceId, chunkName] = chunkPath.split('/');
      const chunk = await sourceStore.readGovernmentChunk(revision, sourceId, chunkName);
      await writeJson(destinationRoot, `${release}/${revision}/${sourceId}/${chunkName}`, chunk);
    }
  }
  let sourceStatuses = [];
  try {
    sourceStatuses = await sourceStore.readSourceStatus();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (sourceStatuses.length > 0) await writeJson(destinationRoot, 'current/source-status.json', sourceStatuses);

  for (const definition of SOURCE_REGISTRY.filter((source) => source.kind === 'static')) {
    try {
      const bundle = await sourceStore.readLayerBundle(definition.output.layerId);
      const layerId = definition.output.layerId;
      const version = bundle.manifest.dataset_version;
      const base = `releases/layers/${layerId}/${version}`;
      await writeJson(destinationRoot, `${base}/manifest.json`, bundle.manifest);
      for (const chunk of bundle.chunks) {
        await writeJson(destinationRoot, `${base}/chunks/${chunk.sequence}.json`, chunk);
      }
      layerVersions[layerId] = version;
      nextPointer.layers[layerId] = version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  try {
    const manifest = await sourceStore.readV2Feed();
    if (manifest.revision !== feed.revision) throw new Error('current v2 manifest does not match the v1 feed revision');
    const manifestName = `${manifest.manifest_hash.slice('sha256:'.length)}.json`;
    const manifestPath = `v2/manifests/${manifestName}`;
    await writeJson(destinationRoot, manifestPath, manifest);
    await writeJson(destinationRoot, 'current/v2/feed.json', manifest);
    for (const entry of manifest.chunks) {
      if (!V2_CHUNK_RE.test(entry.path)) throw new Error('current v2 manifest contains an unsafe chunk path');
      const hash = entry.sha256.slice('sha256:'.length);
      const chunk = await sourceStore.readV2Chunk(hash);
      await writeJson(destinationRoot, entry.path, chunk);
    }
    nextPointer.v2_manifest_path = manifestPath;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeJson(destinationRoot, 'current/release-pointer.json', {
    ...nextPointer,
    layers: { ...layerVersions },
  });
  return { feed, pointer: nextPointer };
}

async function snapshotFileRecords(snapshotRoot) {
  const files = [];
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`snapshot contains a symbolic link: ${absolute}`);
      if (info.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const relative = path.relative(snapshotRoot, absolute).split(path.sep).join('/');
      if (relative === 'snapshot-manifest.json') continue;
      files.push({ path: relative, sha256: sha256Bytes(await readFile(absolute)) });
    }
  }
  await walk(snapshotRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createMigrationSnapshot({ privateDataRoot, publicReleaseRoot, destination,
  areaCatalogPath, emergencyMedicalRosterPath, emergencyMedicalCrosswalkPath,
  publicKey, privateKey, signingKeyId, releasePointerStore, now = new Date() } = {}) {
  const privateRoot = absoluteRoot(privateDataRoot, 'privateDataRoot');
  const publicRoot = absoluteRoot(publicReleaseRoot, 'publicReleaseRoot');
  const destinationRoot = absoluteRoot(destination, 'destination');
  const catalogPath = absoluteRoot(areaCatalogPath, 'areaCatalogPath');
  const currentTime = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(currentTime.getTime())) throw new TypeError('now must be a valid date');
  if (!publicKey || !privateKey) throw new TypeError('publicKey and privateKey are required');
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) {
    throw new TypeError('signingKeyId is invalid');
  }
  if (privateRoot === publicRoot || within(privateRoot, destinationRoot) || within(publicRoot, destinationRoot)) {
    throw new Error('snapshot destination must be outside the source data roots');
  }
  await assertNoPrivateKeyFiles(privateRoot);
  await assertNoPrivateKeyFiles(publicRoot);
  await ensureEmptyDirectory(destinationRoot, 'snapshot destination');
  const privateSnapshot = path.join(destinationRoot, 'private_data');
  const publicSnapshot = path.join(destinationRoot, 'public_release');
  await mkdir(privateSnapshot, { recursive: true });
  await mkdir(publicSnapshot, { recursive: true });
  await copyPrivateInputs({
    sourcePrivateRoot: privateRoot,
    destinationPrivateRoot: privateSnapshot,
    areaCatalogPath: catalogPath,
    emergencyMedicalRosterPath: emergencyMedicalRosterPath
      ? absoluteRoot(emergencyMedicalRosterPath, 'emergencyMedicalRosterPath')
      : null,
    emergencyMedicalCrosswalkPath: emergencyMedicalCrosswalkPath
      ? absoluteRoot(emergencyMedicalCrosswalkPath, 'emergencyMedicalCrosswalkPath')
      : null,
  });
  const sourceStore = createReleaseStore({ releaseRoot: publicRoot, releasePointerStore });
  const release = await copyCurrentPublicRelease({ sourceStore, destinationRoot: publicSnapshot });
  const verified = await verifyReleaseRoot(publicSnapshot, publicKey, signingKeyId, currentTime);
  if (!verified.v2_feed_verified) throw new Error('migration snapshot requires a verified current v2 feed');
  const unsigned = {
    schema_version: 'migration-snapshot-v1',
    created_at: currentTime.toISOString(),
    signing_key_id: signingKeyId,
    signature_algorithm: 'Ed25519',
    feed_revision: release.feed.revision,
    layers: release.pointer.layers,
    v2_manifest_path: release.pointer.v2_manifest_path,
    files: await snapshotFileRecords(destinationRoot),
  };
  await writeJson(destinationRoot, 'snapshot-manifest.json', {
    ...unsigned,
    signature: signCanonical(unsigned, privateKey),
  });
  return {
    valid: true,
    feed_revision: release.feed.revision,
    layer_count: Object.keys(release.pointer.layers).length,
    v2_feed_verified: true,
    file_count: unsigned.files.length,
  };
}

export async function verifyMigrationSnapshot({ snapshotRoot, publicKey, signingKeyId, now = new Date() } = {}) {
  const root = absoluteRoot(snapshotRoot, 'snapshotRoot');
  if (!publicKey) throw new TypeError('publicKey is required');
  const manifest = JSON.parse(await readFile(path.join(root, 'snapshot-manifest.json'), 'utf8'));
  const { signature, ...unsigned } = manifest;
  if (manifest.schema_version !== 'migration-snapshot-v1'
    || manifest.signing_key_id !== signingKeyId
    || manifest.signature_algorithm !== 'Ed25519'
    || !verifyCanonical(unsigned, signature, publicKey)) {
    throw new Error('migration snapshot signature is invalid');
  }
  await assertNoPrivateKeyFiles(root);
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || path.isAbsolute(entry.path)
      || entry.path.split('/').some((part) => part === '..' || part === '')) {
      throw new Error('migration snapshot contains an unsafe file path');
    }
    const filePath = path.resolve(root, ...entry.path.split('/'));
    if (!within(root, filePath)) throw new Error('migration snapshot file path escapes its root');
    if (sha256Bytes(await readFile(filePath)) !== entry.sha256) {
      throw new Error(`migration snapshot file hash mismatch: ${entry.path}`);
    }
  }
  const release = await verifyReleaseRoot(path.join(root, 'public_release'), publicKey, signingKeyId, now);
  if (!release.v2_feed_verified || release.feed_revision !== manifest.feed_revision) {
    throw new Error('migration snapshot release pointer does not match its signed inventory');
  }
  return {
    valid: true,
    feed_revision: release.feed_revision,
    file_count: manifest.files.length,
    layers: release.layers,
    v2_chunk_count: release.v2_chunk_count,
  };
}

async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    await cp(path.join(source, name), path.join(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
  }
}

export async function restoreMigrationSnapshot({ snapshotRoot, privateDataRoot, publicReleaseRoot,
  publicKey, signingKeyId, releasePointerStore, now = new Date() } = {}) {
  const sourceRoot = absoluteRoot(snapshotRoot, 'snapshotRoot');
  const privateRoot = absoluteRoot(privateDataRoot, 'privateDataRoot');
  const publicRoot = absoluteRoot(publicReleaseRoot, 'publicReleaseRoot');
  if (privateRoot === publicRoot || within(sourceRoot, privateRoot) || within(sourceRoot, publicRoot)) {
    throw new Error('restore targets must be outside the migration snapshot');
  }
  const verified = await verifyMigrationSnapshot({ snapshotRoot: sourceRoot, publicKey, signingKeyId, now });
  await ensureEmptyDirectory(privateRoot, 'private restore target');
  await ensureEmptyDirectory(publicRoot, 'public restore target');
  await copyDirectoryContents(path.join(sourceRoot, 'private_data'), privateRoot);
  await copyDirectoryContents(path.join(sourceRoot, 'public_release'), publicRoot);
  const restored = await verifyReleaseRoot(publicRoot, publicKey, signingKeyId, now);
  if (releasePointerStore && typeof releasePointerStore.commit === 'function') {
    const pointer = await createReleaseStore({ releaseRoot: publicRoot }).readCurrentPointer();
    await releasePointerStore.commit(pointer);
  }
  return { ...restored, snapshot_feed_revision: verified.feed_revision };
}
