import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createReleaseStore } from '../storage/release-store.mjs';

const REVISION_RE = /^[1-9]\d*$/u;

function absoluteRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('releaseRoot must be an absolute path');
  const normalized = path.normalize(value);
  if (normalized === path.parse(normalized).root) throw new TypeError('releaseRoot cannot be a filesystem root');
  return normalized;
}

function dateValue(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError('now must be a valid date');
  return result;
}

function positiveInteger(value, name, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`);
  return result;
}

async function jsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function directoryEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function entryTime(directory, metadata) {
  const parsed = Date.parse(String(metadata?.created_at ?? ''));
  if (Number.isFinite(parsed)) return parsed;
  return (await stat(directory)).mtimeMs;
}

function retention(entries, cutoff, keepCount) {
  const sorted = entries.slice().sort((left, right) => right.time - left.time || right.name.localeCompare(left.name));
  const keep = new Set(sorted.slice(0, keepCount).map((entry) => entry.name));
  for (const entry of entries) if (entry.time >= cutoff) keep.add(entry.name);
  return keep;
}

async function currentState(root, releasePointerStore) {
  const store = createReleaseStore({ releaseRoot: root, releasePointerStore });
  let feed = null;
  let pointer = null;
  try {
    [feed, pointer] = await Promise.all([store.readFeed(), store.readCurrentPointer()]);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    pointer = await store.readCurrentPointer();
    if (pointer?.revision !== null && pointer?.revision !== undefined) {
      throw new Error('current release pointer references a missing feed');
    }
  }
  return { feed, pointer };
}

function referencedRevisions(feed) {
  const references = new Set();
  if (Number.isSafeInteger(feed?.revision) && feed.revision > 0) references.add(String(feed.revision));
  for (const dataset of feed?.datasets ?? []) {
    for (const chunkPath of dataset.chunk_paths ?? []) {
      const match = /^releases\/(\d+)\//u.exec(String(chunkPath));
      if (match) references.add(match[1]);
    }
  }
  return references;
}

async function governmentCandidates(root) {
  const releaseRoot = path.join(root, 'releases');
  const entries = [];
  for (const entry of await directoryEntries(releaseRoot)) {
    if (!entry.isDirectory() || !REVISION_RE.test(entry.name)) continue;
    const directory = path.join(releaseRoot, entry.name);
    entries.push({
      name: entry.name,
      path: directory,
      time: await entryTime(directory, await jsonOrNull(path.join(directory, 'feed.json'))),
    });
  }
  return entries;
}

async function layerCandidates(root) {
  const layerRoot = path.join(root, 'releases', 'layers');
  const output = [];
  for (const layer of await directoryEntries(layerRoot)) {
    if (!layer.isDirectory()) continue;
    const layerPath = path.join(layerRoot, layer.name);
    for (const version of await directoryEntries(layerPath)) {
      if (!version.isDirectory() || !REVISION_RE.test(version.name)) continue;
      const versionPath = path.join(layerPath, version.name);
      output.push({
        layerId: layer.name,
        name: version.name,
        path: versionPath,
        time: await entryTime(versionPath, await jsonOrNull(path.join(versionPath, 'manifest.json'))),
      });
    }
  }
  return output;
}

async function currentLayerTargets(root, pointer) {
  const output = new Set();
  if (pointer) {
    for (const [layerId, version] of Object.entries(pointer.layers)) output.add(`${layerId}/${version}`);
    return output;
  }
  const currentRoot = path.join(root, 'current', 'layers');
  for (const entry of await directoryEntries(currentRoot)) {
    try {
      const target = await realpath(path.join(currentRoot, entry.name));
      const relative = path.relative(path.join(root, 'releases', 'layers'), target);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) output.add(relative.split(path.sep).join('/'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return output;
}

async function v2Candidates(root) {
  const directory = path.join(root, 'v2', 'manifests');
  const output = [];
  for (const entry of await directoryEntries(directory)) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const manifest = await jsonOrNull(filePath);
    output.push({
      name: entry.name,
      path: filePath,
      relativePath: `v2/manifests/${entry.name}`,
      manifest,
      time: await entryTime(filePath, manifest),
    });
  }
  return output;
}

export async function cleanupReleases({
  releaseRoot,
  now = new Date(),
  keepRevisions = 10,
  keepDays = 30,
  dryRun = true,
  releasePointerStore,
  assertLockHeld,
} = {}) {
  const root = absoluteRoot(releaseRoot);
  const currentTime = dateValue(now);
  const revisionCount = positiveInteger(keepRevisions, 'keepRevisions', 10);
  const dayCount = positiveInteger(keepDays, 'keepDays', 30);
  if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be boolean');
  const cutoff = currentTime.getTime() - dayCount * 24 * 60 * 60 * 1000;
  const { feed, pointer } = await currentState(root, releasePointerStore);
  const referenced = referencedRevisions(feed);
  if (Number.isSafeInteger(pointer?.revision) && pointer.revision > 0) referenced.add(String(pointer.revision));
  const government = await governmentCandidates(root);
  const keepGovernment = retention(government, cutoff, revisionCount);
  for (const revision of referenced) keepGovernment.add(revision);

  const currentTargets = await currentLayerTargets(root, pointer);
  const layers = await layerCandidates(root);
  const keepLayers = new Set();
  const byLayer = new Map();
  for (const candidate of layers) {
    if (!byLayer.has(candidate.layerId)) byLayer.set(candidate.layerId, []);
    byLayer.get(candidate.layerId).push(candidate);
  }
  for (const candidates of byLayer.values()) {
    const active = currentTargets.has(`${candidates[0].layerId}/${pointer?.layers?.[candidates[0].layerId]}`)
      ? pointer.layers[candidates[0].layerId]
      : null;
    const sorted = candidates.slice().sort((left, right) => Number(right.name) - Number(left.name));
    if (active !== null && !sorted.some((candidate) => candidate.name === String(active))) {
      throw new Error(`current layer pointer references a missing layer: ${candidates[0].layerId}`);
    }
    const keep = active === null ? retention(candidates, cutoff, revisionCount) : new Set([String(active)]);
    const currentIndex = active === null ? -1 : sorted.findIndex((candidate) => candidate.name === String(active));
    if (active !== null && currentIndex >= 0 && sorted[currentIndex + 1]) keep.add(sorted[currentIndex + 1].name);
    if (active === null) {
      for (const candidate of candidates) {
        if (currentTargets.has(`${candidate.layerId}/${candidate.name}`)) keep.add(candidate.name);
      }
    }
    for (const name of keep) keepLayers.add(`${candidates[0].layerId}/${name}`);
  }

  const v2Manifests = await v2Candidates(root);
  if (pointer?.v2_manifest_path
    && !v2Manifests.some((candidate) => candidate.name === path.basename(pointer.v2_manifest_path))) {
    throw new Error('current release pointer references a missing v2 manifest');
  }
  const keepV2 = retention(v2Manifests, cutoff, revisionCount);
  if (pointer?.v2_manifest_path) keepV2.add(path.basename(pointer.v2_manifest_path));
  const referencedV2Chunks = new Set();
  for (const candidate of v2Manifests) {
    if (!keepV2.has(candidate.name)) continue;
    for (const chunk of candidate.manifest?.chunks ?? []) {
      const match = /^v2\/chunks\/([0-9a-f]{64})\.json$/u.exec(String(chunk.path));
      if (match) referencedV2Chunks.add(`${match[1]}.json`);
    }
  }
  const v2ChunkRoot = path.join(root, 'v2', 'chunks');
  const v2Chunks = (await directoryEntries(v2ChunkRoot))
    .filter((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/u.test(entry.name))
    .map((entry) => path.join(v2ChunkRoot, entry.name));

  const candidatesToDelete = [
    ...government.filter((candidate) => !keepGovernment.has(candidate.name)).map((candidate) => candidate.path),
    ...layers.filter((candidate) => !keepLayers.has(`${candidate.layerId}/${candidate.name}`)).map((candidate) => candidate.path),
    ...v2Manifests.filter((candidate) => !keepV2.has(candidate.name)).map((candidate) => candidate.path),
    ...v2Chunks.filter((filePath) => !referencedV2Chunks.has(path.basename(filePath))),
  ];
  const deleted = [];
  if (!dryRun) {
    for (const target of candidatesToDelete) {
      await assertLockHeld?.();
      await rm(target, { recursive: true, force: true });
      deleted.push(target);
    }
  }
  return {
    dry_run: dryRun,
    current_revision: feed?.revision ?? null,
    current_layer_versions: pointer?.layers ?? {},
    kept_government_revisions: [...keepGovernment].sort((left, right) => Number(left) - Number(right)),
    kept_v2_manifests: [...keepV2].sort(),
    would_delete: candidatesToDelete,
    deleted,
  };
}
