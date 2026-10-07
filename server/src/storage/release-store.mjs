import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AUXILIARY_LAYER_IDS, SOURCE_REGISTRY } from '../source-registry.mjs';

const REVISION_RE = /^[1-9]\d*$/u;
const SOURCE_RE = /^[a-z][a-z0-9-]+$/u;
const CHUNK_RE = /^\d+\.json$/u;
const V2_CHUNK_RE = /^[0-9a-f]{64}$/u;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_LAYER_IDS = SOURCE_REGISTRY
  .filter((source) => source.kind === 'static')
  .map((source) => source.output.layerId)
  .concat(AUXILIARY_LAYER_IDS);

function absoluteRoot(releaseRoot) {
  if (typeof releaseRoot !== 'string' || !path.isAbsolute(releaseRoot)) {
    throw new TypeError('releaseRoot must be an absolute path');
  }
  return path.normalize(releaseRoot);
}

function safePath(root, ...segments) {
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Unsafe release path');
  }
  return resolved;
}

function assertRevision(revision) {
  const value = String(revision);
  if (!REVISION_RE.test(value)) throw new Error('Invalid revision');
  return value;
}

function assertSource(source) {
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) throw new Error('Invalid source');
  return source;
}

function assertChunk(chunkName) {
  if (typeof chunkName !== 'string' || !CHUNK_RE.test(chunkName)) throw new Error('Unsafe chunk path');
  return chunkName;
}

function assertLayer(layerIds, layerId) {
  if (typeof layerId !== 'string' || !layerIds.has(layerId)) {
    throw new Error(`Unknown layer: ${layerId}`);
  }
  return layerId;
}

function validPointer(pointer, layerIds) {
  if (!pointer || pointer.schema_version !== 'release-pointer-v1'
    || !(pointer.revision === null || (Number.isSafeInteger(pointer.revision) && pointer.revision > 0))
    || (pointer.revision === null
      ? pointer.feed_path !== null || pointer.v2_manifest_path !== null
      : pointer.feed_path !== `releases/${pointer.revision}/feed.json`)
    || (pointer.v2_manifest_path !== null
      && !/^v2\/manifests\/[0-9a-f]{64}\.json$/u.test(pointer.v2_manifest_path))
    || !pointer.layers || typeof pointer.layers !== 'object' || Array.isArray(pointer.layers)) {
    throw new Error('Invalid current release pointer');
  }
  for (const [layerId, version] of Object.entries(pointer.layers)) {
    if (!layerIds.has(layerId) || !Number.isSafeInteger(version) || version < 1) {
      throw new Error('Invalid current release pointer layer');
    }
  }
  return pointer;
}

async function readJsonLimited(filePath, root, maxBytes) {
  const resolved = await realpath(filePath);
  const canonicalRoot = await realpath(root);
  if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('Unsafe release path');
  }
  const file = await stat(resolved);
  if (file.size > maxBytes) throw new RangeError('public file exceeds maximum size');
  return JSON.parse(await readFile(resolved, 'utf8'));
}

export function createReleaseStore({ releaseRoot, layerIds = DEFAULT_LAYER_IDS, maxBytes = DEFAULT_MAX_BYTES,
  releasePointerStore } = {}) {
  const root = absoluteRoot(releaseRoot);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be positive');
  const allowedLayers = new Set(layerIds);

  async function readPointer() {
    if (releasePointerStore && typeof releasePointerStore.read === 'function') {
      const pointer = await releasePointerStore.read();
      return pointer ? validPointer(pointer, allowedLayers) : null;
    }
    try {
      const pointer = await readJsonLimited(safePath(root, 'current', 'release-pointer.json'), root, maxBytes);
      return validPointer(pointer, allowedLayers);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function readLayerDirectory(layerId) {
    const pointer = await readPointer();
    if (releasePointerStore && !pointer) {
      const error = new Error('current release pointer has not been published');
      error.code = 'ENOENT';
      throw error;
    }
    const version = pointer?.layers[layerId];
    if (releasePointerStore && version === undefined) {
      const error = new Error('current layer is not in the release pointer');
      error.code = 'ENOENT';
      throw error;
    }
    return version === undefined
      ? safePath(root, 'current', 'layers', layerId)
      : safePath(root, 'releases', 'layers', layerId, String(version));
  }

  return Object.freeze({
    async readFeed() {
      const pointer = await readPointer();
      if (releasePointerStore && !pointer) {
        const error = new Error('current release pointer has not been published');
        error.code = 'ENOENT';
        throw error;
      }
      if (pointer && pointer.feed_path === null) {
        const error = new Error('current feed has not been published');
        error.code = 'ENOENT';
        throw error;
      }
      const feedPath = pointer
        ? safePath(root, ...pointer.feed_path.split('/'))
        : safePath(root, 'current', 'feed.json');
      return readJsonLimited(feedPath, root, maxBytes);
    },
    async readSourceStatus() {
      return readJsonLimited(safePath(root, 'current', 'source-status.json'), root, maxBytes);
    },
    async readGovernmentChunk(revision, source, chunkName) {
      const safeRevision = assertRevision(revision);
      const safeSource = assertSource(source);
      const safeChunk = assertChunk(chunkName);
      return readJsonLimited(safePath(root, 'releases', safeRevision, safeSource, safeChunk), root, maxBytes);
    },
    async readLayerManifest(layerId) {
      const safeLayer = assertLayer(allowedLayers, layerId);
      const directory = await readLayerDirectory(safeLayer);
      return readJsonLimited(safePath(directory, 'manifest.json'), root, maxBytes);
    },
    async readLayerChunk(layerId, chunkName) {
      const safeLayer = assertLayer(allowedLayers, layerId);
      const safeChunk = assertChunk(chunkName);
      const directory = await readLayerDirectory(safeLayer);
      return readJsonLimited(safePath(directory, 'chunks', safeChunk), root, maxBytes);
    },
    async readLayerBundle(layerId) {
      const manifest = await this.readLayerManifest(layerId);
      const chunks = await Promise.all((manifest.chunks ?? [])
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map((chunk) => this.readLayerChunk(layerId, `${chunk.sequence}.json`)));
      return { manifest, chunks };
    },
    async readV2Feed() {
      const pointer = await readPointer();
      if (releasePointerStore && !pointer) {
        const error = new Error('current release pointer has not been published');
        error.code = 'ENOENT';
        throw error;
      }
      if (pointer && pointer.v2_manifest_path === null) {
        const error = new Error('current v2 feed has not been published');
        error.code = 'ENOENT';
        throw error;
      }
      const filePath = pointer?.v2_manifest_path
        ? safePath(root, ...pointer.v2_manifest_path.split('/'))
        : safePath(root, 'current', 'v2', 'feed.json');
      return readJsonLimited(filePath, root, maxBytes);
    },
    async readV2Chunk(hash) {
      if (typeof hash !== 'string' || !V2_CHUNK_RE.test(hash)) throw new Error('Invalid v2 chunk hash');
      return readJsonLimited(safePath(root, 'v2', 'chunks', `${hash}.json`), root, maxBytes);
    },
    async readCurrentPointer() {
      return readPointer();
    },
  });
}

export async function readCurrentFeed(releaseRoot) {
  return createReleaseStore({ releaseRoot }).readFeed();
}

export async function readCurrentLayer(releaseRoot, layerId) {
  return createReleaseStore({ releaseRoot }).readLayerBundle(layerId);
}

export {
  DEFAULT_MAX_BYTES,
  assertChunk,
  assertRevision,
  assertSource,
  validPointer,
};
