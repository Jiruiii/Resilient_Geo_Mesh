import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeRawSnapshot, validateRawSnapshot } from '../../../pipeline/lib/source.mjs';
import { atomicWriteJson } from './atomic-file.mjs';

const SOURCE_ID_RE = /^[a-z][a-z0-9-]+$/u;

function sourceDirectory(dataRoot, sourceId) {
  if (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId)) {
    throw new TypeError('source ID must contain only lowercase letters, digits, and hyphens');
  }
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('dataRoot must be an absolute path');
  }
  return path.join(dataRoot, 'source-cache', sourceId);
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readSourceState(dataRoot, sourceId) {
  return readJsonOrNull(path.join(sourceDirectory(dataRoot, sourceId), 'state.json'));
}

export async function readSourceSnapshot(dataRoot, sourceId) {
  return readJsonOrNull(path.join(sourceDirectory(dataRoot, sourceId), 'raw.json'));
}

export async function readSourceNormalized(dataRoot, sourceId) {
  return readJsonOrNull(path.join(sourceDirectory(dataRoot, sourceId), 'normalized.json'));
}

export async function writeSourceResult(dataRoot, sourceId, { snapshot, normalized, state } = {}) {
  const directory = sourceDirectory(dataRoot, sourceId);
  const snapshotErrors = validateRawSnapshot(snapshot);
  if (snapshotErrors.length > 0) throw new TypeError(`invalid raw snapshot: ${snapshotErrors.join('; ')}`);
  if (normalized === null || typeof normalized !== 'object') {
    throw new TypeError('normalized snapshot must be an object or array');
  }
  if (!state || typeof state !== 'object' || state.schema_version !== 'source-state-v1' || state.source_id !== sourceId) {
    throw new TypeError('state must be a source-state-v1 for the source ID');
  }

  await atomicWriteJson(path.join(directory, 'raw.json'), snapshot);
  await atomicWriteJson(path.join(directory, 'normalized.json'), normalized);
  await atomicWriteJson(path.join(directory, 'state.json'), state);
}

export { makeRawSnapshot };
