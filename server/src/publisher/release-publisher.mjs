import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sha256Canonical } from '../../../pipeline/lib/canonical.mjs';
import { buildGovernmentFeedV2, verifyGovernmentFeedV2 } from '../../../pipeline/lib/government-feed-v2.mjs';
import { verifyFeatureBundle } from '../../../pipeline/lib/feature-bundle.mjs';
import { verifyBundle } from '../../../pipeline/lib/contract.mjs';
import { buildGovernmentFeed, readPreviousEvents, verifyFeed } from '../../../pipeline/lib/government-feed.mjs';
import { buildSignedLayer } from '../../../pipeline/lib/layer-publisher.mjs';
import { atomicWriteJson } from '../storage/atomic-file.mjs';
import {
  createReleaseStore,
} from '../storage/release-store.mjs';
import { AUXILIARY_LAYER_IDS, SOURCE_REGISTRY } from '../source-registry.mjs';
import { isPublishableResult } from '../collector/medical-release-policy.mjs';

const MAX_PUBLIC_FILE_BYTES = 8 * 1024 * 1024;
const MEDICAL_LAYER_IDS = new Set(['taiwan-medical', 'taiwan-medical-directory']);
const MAX_MEDICAL_LAYER_CHUNKS = 512;
const MAX_MEDICAL_CHUNK_TARGET_BYTES = 2 * 1024 * 1024;
export const FEED_REFRESH_BEFORE_EXPIRY_MS = 60 * 60 * 1000;
const STATIC_REFRESH_BEFORE_EXPIRY_MS = 60 * 60 * 1000;
const DYNAMIC_SOURCE_RE = /^[a-z][a-z0-9-]+$/u;
const GOVERNMENT_CHUNK_RE = /^releases\/([1-9]\d*)\/([a-z][a-z0-9-]+)\/(\d+\.json)$/u;
function absoluteRoot(root, field) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError(`${field} must be an absolute path`);
  return path.normalize(root);
}

function keyParts(signingKey) {
  const privateKey = signingKey?.privateKey;
  const publicKey = signingKey?.publicKey;
  const signingKeyId = signingKey?.keyId ?? signingKey?.signingKeyId;
  if (!privateKey || !publicKey) throw new TypeError('signingKey requires privateKey and publicKey');
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) {
    throw new TypeError('signingKey requires a valid keyId');
  }
  return { privateKey, publicKey, signingKeyId };
}

function dateValue(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) throw new TypeError('now must be a valid date');
  return value;
}

function withoutProcessingMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutProcessingMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => ![
      'source_record', 'source_version', 'issued_at', 'expires_at', 'created_at', 'checked_at',
      'retrieved_at', 'generated_at', 'coordinate_source_version', 'payload_hash', 'signature',
      'signature_algorithm', 'signing_key_id', 'provenance',
    ].includes(key))
    .map(([key, child]) => [key, withoutProcessingMetadata(child)]));
}

function stripSourceRecords(value) {
  if (Array.isArray(value)) return value.map(stripSourceRecords);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'source_record')
    .map(([key, child]) => [key, stripSourceRecords(child)]));
}

function semanticFeaturesHash(features) {
  return sha256Canonical(features
    .map(withoutProcessingMetadata)
    .sort((left, right) => String(left.feature_id).localeCompare(String(right.feature_id))));
}

function sameGovernmentData(previousFeed, nextFeed) {
  if (!previousFeed) return false;
  const summarize = (feed) => feed.datasets.map(({ source_id, manifest, chunk_paths }) => ({
    source_id,
    manifest_hash: manifest?.manifest_hash,
    chunk_paths,
  }));
  return sha256Canonical(summarize(previousFeed)) === sha256Canonical(summarize(nextFeed))
    && sha256Canonical(previousFeed.event_versions ?? {}) === sha256Canonical(nextFeed.event_versions ?? {});
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function governmentChunkPath(root, relativePath) {
  const match = GOVERNMENT_CHUNK_RE.exec(relativePath);
  if (!match) throw new Error('Unsafe prior government chunk path');
  return path.join(root, 'releases', match[1], match[2], match[3]);
}

async function readPriorGovernmentChunk(root, relativePath) {
  return JSON.parse(await readFile(governmentChunkPath(root, relativePath), 'utf8'));
}

async function loadPreviousRelease(previousRoot, publicKey, releasePointerStore) {
  if (!previousRoot) return { feed: undefined, events: {} };
  try {
    const feed = await createReleaseStore({ releaseRoot: previousRoot, releasePointerStore }).readFeed();
    const events = await readPreviousEvents(feed, (name) => readPriorGovernmentChunk(previousRoot, name), publicKey);
    return { feed, events };
  } catch (error) {
    if (error.code === 'ENOENT') return { feed: undefined, events: {} };
    throw error;
  }
}

async function loadPreviousSourceStatuses(previousRoot) {
  try {
    const value = JSON.parse(await readFile(path.join(previousRoot, 'current', 'source-status.json'), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function dynamicResults(results) {
  if (!Array.isArray(results)) throw new TypeError('results must be an array');
  return results.flatMap((result) => {
    if (result?.kind === 'static') return [];
    const sourceDefinition = result?.sourceId
      ? SOURCE_REGISTRY.find((source) => source.sourceId === result.sourceId)
      : undefined;
    if (sourceDefinition?.kind === 'static') return [];
    const id = result?.id ?? result?.feedId ?? sourceDefinition?.feedId;
    if (typeof id !== 'string' || !DYNAMIC_SOURCE_RE.test(id)) {
      throw new Error('Invalid source id');
    }
    return [{
      ...result,
      id,
      ...(Array.isArray(result.events) ? { events: result.events.map(stripSourceRecords) } : {}),
      unresolvedCount: result.unresolvedCount ?? result.unresolved_count,
    }];
  });
}

function medicalCoverage(result, previous) {
  const sourceId = result?.sourceId ?? result?.source_id ?? previous?.source_id;
  if (sourceId !== 'taiwan-medical') return {};
  let report;
  if (result?.coordinateReport && typeof result.coordinateReport === 'object') {
    report = result.coordinateReport;
  } else if (!result) {
    report = previous?.coordinate_report;
  } else if (['ok', 'not_modified', 'partial'].includes(result.status)) {
    report = result.normalized?.coordinate_report ?? previous?.coordinate_report;
  }
  if (!report || typeof report !== 'object') return {};
  const integerFields = [
    'source_count',
    'query_count',
    'successful_query_count',
    'failed_query_count',
    'failed_fallback_source_count',
    'candidate_count',
    'matched_count',
    'unresolved_count',
    'excluded_count',
    'identity_conflict_count',
    'duplicate_institution_code_group_count',
    'duplicate_institution_code_affected_row_count',
    'duplicate_institution_code_extra_row_count',
    'duplicate_point_id_group_count',
    'duplicate_point_id_affected_row_count',
    'duplicate_point_id_extra_row_count',
    'rejected_coordinate_count',
  ];
  const output = {};
  for (const field of integerFields) {
    if (Number.isSafeInteger(report[field]) && report[field] >= 0) output[field] = report[field];
  }
  const layerSourceVersion = report.layer_source_version
    ?? result?.features?.[0]?.source_version
    ?? previous?.layer_source_version;
  if (typeof report.roster_complete === 'boolean') output.roster_complete = report.roster_complete;
  if (typeof layerSourceVersion === 'string' && layerSourceVersion.length > 0) {
    output.layer_source_version = layerSourceVersion;
  }
  if (report.unresolved_reason_counts && typeof report.unresolved_reason_counts === 'object') {
    output.unresolved_reason_counts = Object.fromEntries(
      [
        'no_coordinate_candidate', 'name_address_mismatch', 'multiple_candidates', 'source_missing',
        'duplicate_institution_code', 'duplicate_point_id', 'missing_institution_code', 'unverified_coordinate_match',
      ]
        .map((reason) => [reason, report.unresolved_reason_counts[reason]])
        .filter(([, count]) => Number.isSafeInteger(count) && count >= 0),
    );
  }
  if (report.excluded_reason_counts && typeof report.excluded_reason_counts === 'object') {
    output.excluded_reason_counts = Object.fromEntries(
      Object.entries(report.excluded_reason_counts)
        .filter(([reason, count]) => /^[a-z][a-z0-9_]*$/u.test(reason)
          && Number.isSafeInteger(count) && count >= 0),
    );
  }
  const countyCoverage = report.county_coverage;
  if (countyCoverage && ['partial', 'complete'].includes(countyCoverage.status)
    && countyCoverage.county_count === 22 && Array.isArray(countyCoverage.counties)
    && countyCoverage.counties.length === 22) {
    const countyRows = countyCoverage.counties.filter((row) =>
      typeof row?.county_code === 'string' && typeof row?.county_name === 'string'
      && ['partial', 'complete'].includes(row.status)
      && ['master_count', 'located_count', 'unlocated_count', 'excluded_count']
        .every((field) => Number.isSafeInteger(row[field]) && row[field] >= 0),
    );
    if (countyRows.length === 22) {
      output.county_coverage = {
        status: countyCoverage.status,
        county_count: 22,
        source_count: countyCoverage.source_count,
        located_count: countyCoverage.located_count,
        unlocated_count: countyCoverage.unlocated_count,
        excluded_count: countyCoverage.excluded_count,
        unassigned_count: countyCoverage.unassigned_count,
        counties: countyRows.map((row) => ({
          county_code: row.county_code,
          county_name: row.county_name,
          master_count: row.master_count,
          located_count: row.located_count,
          unlocated_count: row.unlocated_count,
          excluded_count: row.excluded_count,
          status: row.status,
        })),
      };
    }
  }
  for (const field of ['emergency_hospital_count', 'emergency_located_count', 'emergency_unresolved_count']) {
    if (Number.isSafeInteger(report[field]) && report[field] >= 0) output[field] = report[field];
  }
  if (typeof report.emergency_medical_source_version === 'string') {
    output.emergency_medical_source_version = report.emergency_medical_source_version;
  }
  if (typeof report.emergency_medical_coverage === 'string'
    && ['partial', 'complete', 'unavailable'].includes(report.emergency_medical_coverage)) {
    output.emergency_medical_coverage = report.emergency_medical_coverage;
  }
  if (report.emergency_unresolved_reason_counts && typeof report.emergency_unresolved_reason_counts === 'object') {
    output.emergency_unresolved_reason_counts = Object.fromEntries(
      ['no_coordinate_candidate', 'name_address_mismatch', 'multiple_candidates', 'source_missing']
        .map((reason) => [reason, report.emergency_unresolved_reason_counts[reason]])
        .filter(([, count]) => Number.isSafeInteger(count) && count >= 0),
    );
  }
  if (Array.isArray(report.source_ids)) {
    output.coordinate_source_ids = report.source_ids
      .filter((sourceId) => typeof sourceId === 'string'
        && (/^[a-z][a-z0-9-]+$/u.test(sourceId) || /^official-doorplate:\d{5}$/u.test(sourceId)));
  }
  return output;
}

async function writeCheckedJson(filePath, value, maxBytes = MAX_PUBLIC_FILE_BYTES) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError('public release file exceeds maximum size');
  }
  await atomicWriteJson(filePath, value);
}

async function readReleasePointer(root, releasePointerStore) {
  return createReleaseStore({ releaseRoot: root, releasePointerStore }).readCurrentPointer();
}

async function nextUnusedLayerVersion(root, layerId, currentVersion) {
  const versionsRoot = path.join(root, 'releases', 'layers', layerId);
  let entries;
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return currentVersion + 1;
    throw error;
  }
  const highestExistingVersion = entries
    .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/u.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter(Number.isSafeInteger)
    .reduce((highest, version) => Math.max(highest, version), currentVersion);
  return highestExistingVersion + 1;
}

export async function commitReleasePointer({ releaseRoot, revision, v2ManifestPath,
  layerVersions = {}, releasePointerStore } = {}) {
  const root = absoluteRoot(releaseRoot, 'releaseRoot');
  const previous = await readReleasePointer(root, releasePointerStore);
  const nextRevision = Number.isSafeInteger(revision) && revision > 0
    ? revision
    : previous?.revision ?? null;
  const sameRevision = nextRevision === previous?.revision;
  const pointer = {
    schema_version: 'release-pointer-v1',
    revision: nextRevision,
    feed_path: nextRevision === null ? null : `releases/${nextRevision}/feed.json`,
    v2_manifest_path: v2ManifestPath
      ?? (sameRevision ? previous?.v2_manifest_path ?? null : null),
    layers: { ...(previous?.layers ?? {}), ...layerVersions },
  };
  if (sha256Canonical(pointer) === sha256Canonical(previous ?? {})) return pointer;
  if (releasePointerStore && typeof releasePointerStore.commit === 'function') {
    await releasePointerStore.commit(pointer);
  }
  await writeCheckedJson(path.join(root, 'current', 'release-pointer.json'), pointer);
  return pointer;
}

async function readCurrentV2({ root, releasePointerStore, publicKey, signingKeyId, now }) {
  const pointer = await readReleasePointer(root, releasePointerStore);
  if (releasePointerStore && !pointer) return null;
  const manifestPath = pointer?.v2_manifest_path
    ? path.join(root, ...pointer.v2_manifest_path.split('/'))
    : pointer ? null : path.join(root, 'current', 'v2', 'feed.json');
  if (!manifestPath) return null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.signing_key_id !== signingKeyId || pointer?.revision !== manifest.revision) return null;
    const chunks = await Promise.all(manifest.chunks.map(async (entry) => {
      if (typeof entry.path !== 'string' || !/^v2\/chunks\/[0-9a-f]{64}\.json$/u.test(entry.path)) {
        throw new Error('Unsafe v2 chunk path');
      }
      return JSON.parse(await readFile(path.join(root, ...entry.path.split('/')), 'utf8'));
    }));
    const result = verifyGovernmentFeedV2(manifest, chunks, publicKey, {
      trustedKeyIds: [signingKeyId],
      now,
    });
    return result.valid ? { manifest, chunks, pointer } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function eventsFromGovernmentOutput(feed, files, root) {
  const output = [];
  for (const dataset of feed.datasets) {
    for (const relativePath of dataset.chunk_paths) {
      const chunk = files.get(relativePath)
        ?? JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
      output.push(...(chunk.events ?? []));
    }
  }
  return output;
}

async function publishV2Files({ root, output, publicKey, signingKeyId, now }) {
  const chunks = [...output.files]
    .filter(([relativePath]) => relativePath.startsWith('v2/chunks/'))
    .map(([, chunk]) => chunk);
  const verification = verifyGovernmentFeedV2(output.manifest, chunks, publicKey, {
    trustedKeyIds: [signingKeyId],
    now,
  });
  if (!verification.valid) throw new Error(`v2 feed verification failed: ${verification.reason}`);
  const stagingRoot = path.join(root, '.staging', `v2-${output.manifest.revision}-${randomUUID()}`);
  try {
    const pending = [];
    for (const [relativePath, value] of output.files) {
      if (!/^v2\/(?:chunks\/[0-9a-f]{64}|manifests\/[0-9a-f]{64})\.json$/u.test(relativePath)) {
        throw new Error('Unsafe v2 release path');
      }
      const immutablePath = path.join(root, ...relativePath.split('/'));
      if (await fileExists(immutablePath)) {
        const existing = JSON.parse(await readFile(immutablePath, 'utf8'));
        if (sha256Canonical(existing) !== sha256Canonical(value)) {
          throw new Error(`Immutable v2 path has conflicting content: ${relativePath}`);
        }
        continue;
      }
      pending.push([relativePath, value]);
    }
    await Promise.all(pending.map(([relativePath, value]) =>
      writeCheckedJson(path.join(stagingRoot, relativePath), value)));
    for (const [relativePath, value] of output.files) {
      const immutablePath = path.join(root, ...relativePath.split('/'));
      if (await fileExists(immutablePath)) continue;
      await mkdir(path.dirname(immutablePath), { recursive: true });
      await rename(path.join(stagingRoot, relativePath), immutablePath);
    }
    await writeCheckedJson(path.join(root, 'current', 'v2', 'feed.json'), output.manifest);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function buildPublicSourceStatuses(results, previousStatuses, feed, now) {
  const previousById = new Map(previousStatuses.map((status) => [status.source_id, status]));
  const updated = results.map((result) => {
    const sourceId = result.sourceId ?? result.id;
    const definition = SOURCE_REGISTRY.find((source) => source.sourceId === sourceId);
    const previous = previousById.get(sourceId);
    const status = result.status ?? 'unavailable';
    const hasSuccess = ['ok', 'not_modified', 'partial', 'stale'].includes(status);
    return {
      source_id: sourceId,
      status,
      checked_at: now.toISOString(),
      retrieved_at: result.retrievedAt ?? previous?.retrieved_at ?? null,
      last_success_at: hasSuccess
        ? result.retrievedAt ?? previous?.last_success_at ?? null
        : previous?.last_success_at ?? null,
      coverage: definition?.coverage ?? 'TW',
      revision: feed.revision,
      error_code: result.errorCode ?? null,
      ...medicalCoverage(result, previous),
    };
  });
  const updatedIds = new Set(updated.map((status) => status.source_id));
  const registeredIds = new Set(SOURCE_REGISTRY.map((source) => source.sourceId));
  const disabled = SOURCE_REGISTRY
    .filter((source) => !source.enabledByDefault
      && !updatedIds.has(source.sourceId)
      && previousById.has(source.sourceId))
    .map((source) => {
      const previous = previousById.get(source.sourceId);
      return {
        source_id: source.sourceId,
        status: 'disabled',
        checked_at: now.toISOString(),
        retrieved_at: previous?.retrieved_at ?? null,
        last_success_at: previous?.last_success_at ?? null,
        coverage: source.coverage,
        revision: feed.revision,
        error_code: null,
        ...medicalCoverage(undefined, previous),
      };
    });
  const disabledIds = new Set(disabled.map((status) => status.source_id));
  return [
    ...previousStatuses.filter((status) => registeredIds.has(status.source_id)
      && !updatedIds.has(status.source_id)
      && !disabledIds.has(status.source_id)),
    ...disabled,
    ...updated,
  ];
}

async function verifyGovernmentOutput(feed, files, publicKey, signingKeyId, root) {
  verifyFeed(feed, publicKey, { signingKeyId });
  for (const dataset of feed.datasets) {
    const chunks = await Promise.all(dataset.chunk_paths.map(async (name) => {
      const chunk = files.get(name);
      if (chunk) return chunk;
      return JSON.parse(await readFile(path.join(root, name), 'utf8'));
    }));
    const result = verifyBundle({ manifest: dataset.manifest, chunks }, publicKey, {
      trustedKeyIds: [signingKeyId],
    });
    if (!result.valid) throw new Error(`government bundle verification failed: ${dataset.source_id}`);
  }
}

async function publishGovernmentFiles({ root, feed, files, sourceStatuses, publicKey, signingKeyId }) {
  const stagingRoot = path.join(root, '.staging', `government-${feed.revision}-${randomUUID()}`);
  try {
    await Promise.all([...files.entries()].map(([relativePath, value]) => {
      if (!GOVERNMENT_CHUNK_RE.test(relativePath)) throw new Error('Unsafe government release path');
      return writeCheckedJson(path.join(stagingRoot, relativePath), value);
    }));
    await writeCheckedJson(path.join(stagingRoot, 'releases', String(feed.revision), 'feed.json'), feed);
    await writeCheckedJson(path.join(stagingRoot, 'current', 'feed.json'), feed);
    if (sourceStatuses) await writeCheckedJson(path.join(stagingRoot, 'current', 'source-status.json'), sourceStatuses);
    await verifyGovernmentOutput(feed, files, publicKey, signingKeyId, stagingRoot);

    const immutableRoot = path.join(root, 'releases', String(feed.revision));
    const stagedImmutableRoot = path.join(stagingRoot, 'releases', String(feed.revision));
    if (await fileExists(stagedImmutableRoot)) {
      if (await fileExists(immutableRoot)) throw new Error(`Release revision already exists: ${feed.revision}`);
      await mkdir(path.join(root, 'releases'), { recursive: true });
      await rename(stagedImmutableRoot, immutableRoot);
    }
    await writeCheckedJson(path.join(root, 'current', 'feed.json'), feed);
    if (sourceStatuses) await writeCheckedJson(path.join(root, 'current', 'source-status.json'), sourceStatuses);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function staticLayerDefinition(layerId) {
  const definition = SOURCE_REGISTRY.find((source) => source.kind === 'static' && source.output.layerId === layerId);
  if (!definition && !AUXILIARY_LAYER_IDS.includes(layerId)) throw new Error(`Unknown layer: ${layerId}`);
  return definition;
}

async function verifyStaticOutput(bundle, publicKey, signingKeyId, now) {
  const result = verifyFeatureBundle(bundle, publicKey, { trustedKeyIds: [signingKeyId], now });
  if (!result.valid) throw new Error('static layer verification failed');
}

async function publishStaticFiles({ root, layerId, bundle, publicKey, signingKeyId, now }) {
  const version = bundle.manifest.dataset_version;
  const stagingRoot = path.join(root, '.staging', `layer-${layerId}-${version}-${randomUUID()}`);
  try {
    const manifestPath = path.join(stagingRoot, 'releases', 'layers', layerId, String(version), 'manifest.json');
    await writeCheckedJson(manifestPath, bundle.manifest);
    await Promise.all(bundle.chunks.map((chunk) => writeCheckedJson(
      path.join(stagingRoot, 'releases', 'layers', layerId, String(version), 'chunks', `${chunk.sequence}.json`),
      chunk,
    )));
    await verifyStaticOutput(bundle, publicKey, signingKeyId, now);

    const immutableRoot = path.join(root, 'releases', 'layers', layerId, String(version));
    if (await fileExists(immutableRoot)) throw new Error(`Layer version already exists: ${layerId}/${version}`);
    await mkdir(path.dirname(immutableRoot), { recursive: true });
    await rename(path.join(stagingRoot, 'releases', 'layers', layerId, String(version)), immutableRoot);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function publishGovernmentRelease({ releaseRoot, previousRoot = releaseRoot, results,
  signingKey, now = new Date(), releasePointerStore, deferPointer = false, deferSourceStatus = false } = {}) {
  const root = absoluteRoot(releaseRoot, 'releaseRoot');
  const previousBase = absoluteRoot(previousRoot, 'previousRoot');
  const { privateKey, publicKey, signingKeyId } = keyParts(signingKey);
  const failed = (results ?? []).filter((result) => !isPublishableResult(result));
  if (failed.length > 0) {
    const error = new Error('source failure prevents government feed publication');
    error.code = 'SOURCE_FAILURE';
    error.sources = failed.map(({ sourceId, id, status, errorCode }) => ({
      source_id: sourceId ?? id,
      status,
      error_code: errorCode ?? null,
    }));
    throw error;
  }
  const currentTime = dateValue(now);
  const previous = await loadPreviousRelease(previousBase, publicKey, releasePointerStore);
  const previousStatuses = await loadPreviousSourceStatuses(previousBase);
  const previousPointer = await readReleasePointer(root, releasePointerStore);
  const sourceResults = dynamicResults(results);
  if (sourceResults.length === 0) {
    const error = new Error('government feed publication requires at least one successful source check');
    error.code = 'NO_SOURCE_RESULTS';
    throw error;
  }
  const output = buildGovernmentFeed({
    previous: previous.feed,
    previousEvents: previous.events,
    results: sourceResults,
    privateKey,
    publicKey,
    signingKeyId,
    now: currentTime,
  });
  const unchanged = sameGovernmentData(previous.feed, output.feed)
    && Date.parse(previous.feed.expires_at) - currentTime.getTime() > FEED_REFRESH_BEFORE_EXPIRY_MS;
  const previousV2 = await readCurrentV2({
    root,
    releasePointerStore,
    publicKey,
    signingKeyId,
    now: currentTime,
  });
  const currentV2 = unchanged ? previousV2 : null;
  let v2ManifestPath = currentV2?.pointer?.v2_manifest_path ?? null;
  if (!currentV2) {
    const v2 = buildGovernmentFeedV2({
      events: await eventsFromGovernmentOutput(output.feed, output.files, root),
      revision: output.feed.revision,
      createdAt: output.feed.created_at,
      expiresAt: output.feed.expires_at,
      signingKeyId,
      privateKey,
      previousChunks: previousV2?.chunks ?? [],
    });
    await publishV2Files({ root, output: v2, publicKey, signingKeyId, now: currentTime });
    v2ManifestPath = v2.manifestPath;
  }
  if (unchanged) {
    if (!deferSourceStatus) {
      const sourceStatuses = buildPublicSourceStatuses(results, previousStatuses, previous.feed, currentTime);
      await writeCheckedJson(path.join(root, 'current', 'source-status.json'), sourceStatuses);
    }
    if (!deferPointer) {
      await commitReleasePointer({
        releaseRoot: root,
        revision: previous.feed.revision,
        v2ManifestPath,
        releasePointerStore,
      });
    }
    return {
      revision: previous.feed.revision,
      feed: previous.feed,
      v2ManifestPath,
      unchanged: true,
      publishedAt: currentTime.toISOString(),
      path: 'current/feed.json',
    };
  }
  await publishGovernmentFiles({
    root,
    feed: output.feed,
    files: output.files,
    sourceStatuses: deferSourceStatus
      ? null
      : buildPublicSourceStatuses(results, previousStatuses, output.feed, currentTime),
    publicKey,
    signingKeyId,
  });
  if (!deferPointer) {
    await commitReleasePointer({
      releaseRoot: root,
      revision: output.feed.revision,
      v2ManifestPath,
      releasePointerStore,
    });
  }
  return {
    revision: output.feed.revision,
    feed: output.feed,
    v2ManifestPath,
    unchanged: false,
    publishedAt: currentTime.toISOString(),
    path: 'current/feed.json',
  };
}

export async function publishSourceStatus({ releaseRoot, results, now = new Date(), releasePointerStore } = {}) {
  const root = absoluteRoot(releaseRoot, 'releaseRoot');
  const currentTime = dateValue(now);
  let feed = null;
  try {
    feed = await readCurrentFeed(root, releasePointerStore);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const previousStatuses = await loadPreviousSourceStatuses(root);
  const sourceStatuses = buildPublicSourceStatuses(
    results ?? [],
    previousStatuses,
    feed ?? { revision: null },
    currentTime,
  );
  await writeCheckedJson(path.join(root, 'current', 'source-status.json'), sourceStatuses);
  return {
    revision: feed?.revision ?? null,
    source_statuses: sourceStatuses,
    path: 'current/source-status.json',
  };
}

export async function publishStaticLayer({ layerId, features, releaseRoot, signingKey, now = new Date(),
  datasetId, namespace, source, sourceVersion, expiresAt, priority, targetSizeBytes,
  releasePointerStore, deferPointer = false } = {}) {
  staticLayerDefinition(layerId);
  const root = absoluteRoot(releaseRoot, 'releaseRoot');
  const { privateKey, publicKey, signingKeyId } = keyParts(signingKey);
  const currentTime = dateValue(now);
  let previous;
  try {
    previous = await createReleaseStore({ releaseRoot: root, releasePointerStore }).readLayerBundle(layerId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const safeFeatures = features.map(stripSourceRecords);
  const medicalLayer = MEDICAL_LAYER_IDS.has(layerId);
  const previousWithinClientLimit = !medicalLayer
    || (Array.isArray(previous?.manifest?.chunks)
      && previous.manifest.chunks.length <= MAX_MEDICAL_LAYER_CHUNKS);
  if (previous
    && previousWithinClientLimit
    && semanticFeaturesHash(previous.chunks.flatMap((chunk) => chunk.features ?? []))
      === semanticFeaturesHash(safeFeatures)
    && Date.parse(previous.manifest.expires_at) - currentTime.getTime() > STATIC_REFRESH_BEFORE_EXPIRY_MS) {
    if (!deferPointer) {
      await commitReleasePointer({
        releaseRoot: root,
        layerVersions: { [layerId]: previous.manifest.dataset_version },
        releasePointerStore,
      });
    }
    return {
      layerId,
      datasetVersion: previous.manifest.dataset_version,
      manifest: previous.manifest,
      chunks: previous.chunks,
      unchanged: true,
    };
  }
  const datasetVersion = await nextUnusedLayerVersion(
    root,
    layerId,
    previous?.manifest?.dataset_version ?? 0,
  );
  let chunkTargetBytes = targetSizeBytes ?? 256 * 1024;
  let bundle;
  while (true) {
    bundle = buildSignedLayer(safeFeatures, {
      layerId,
      privateKey,
      signingKeyId,
      datasetId,
      namespace,
      source,
      sourceVersion,
      datasetVersion,
      expiresAt,
      now: currentTime,
      priority,
      // Start with 256 KiB; only increase medical chunk size if needed to
      // remain below the fixed 512-chunk limit enforced by Web and Android.
      targetSizeBytes: chunkTargetBytes,
    });
    if (!medicalLayer || bundle.chunks.length <= MAX_MEDICAL_LAYER_CHUNKS) break;
    if (chunkTargetBytes >= MAX_MEDICAL_CHUNK_TARGET_BYTES) {
      const error = new Error(`medical layer exceeds the ${MAX_MEDICAL_LAYER_CHUNKS}-chunk client limit`);
      error.code = 'MEDICAL_LAYER_CHUNK_LIMIT';
      throw error;
    }
    chunkTargetBytes = Math.min(chunkTargetBytes * 2, MAX_MEDICAL_CHUNK_TARGET_BYTES);
  }
  await publishStaticFiles({
    root,
    layerId,
    bundle,
    publicKey,
    signingKeyId,
    now: currentTime,
  });
  if (!deferPointer) {
    await commitReleasePointer({
      releaseRoot: root,
      layerVersions: { [layerId]: datasetVersion },
      releasePointerStore,
    });
  }
  return {
    layerId,
    datasetVersion,
    manifest: bundle.manifest,
    chunks: bundle.chunks,
    unchanged: false,
    publishedAt: currentTime.toISOString(),
  };
}

export async function readCurrentFeed(releaseRoot, releasePointerStore) {
  return createReleaseStore({ releaseRoot, releasePointerStore }).readFeed();
}

export async function readCurrentLayer(releaseRoot, layerId, releasePointerStore) {
  return createReleaseStore({ releaseRoot, releasePointerStore }).readLayerBundle(layerId);
}
