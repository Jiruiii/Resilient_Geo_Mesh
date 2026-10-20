import {
  canonicalize,
  chunkPayloadBytes,
  chunkSignatureInput,
  manifestHashInput,
  manifestSignatureInput,
  sha256Canonical,
  sha256Bytes,
} from './canonical.mjs';
import { signCanonical } from './crypto.mjs';
import { bboxOfEvents } from './geo.mjs';

const PRIORITY_RANK = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 };

function priorityFor(events) {
  return events.reduce(
    (highest, event) => (PRIORITY_RANK[event.severity] > PRIORITY_RANK[highest] ? event.severity : highest),
    'LOW',
  );
}

function areaTheme(event) {
  const areaId = event?.attributes?.area_id;
  const theme = event?.attributes?.theme;
  const categoryCode = event?.source?.toUpperCase() === 'NCDR'
    ? event?.attributes?.ncdr_category_code ?? 'other'
    : null;
  if (typeof areaId !== 'string' || areaId.length === 0 || typeof theme !== 'string' || theme.length === 0) {
    throw new TypeError(`event ${event?.event_id ?? '<unknown>'} is missing attributes.area_id / attributes.theme`);
  }
  if (categoryCode !== null && !/^[a-z][a-z0-9_]{0,63}$/u.test(categoryCode)) {
    throw new TypeError(`event ${event?.event_id ?? '<unknown>'} has an invalid NCDR category code`);
  }
  return { areaId, theme, categoryCode };
}

/**
 * Two-phase grouping. First bucket events by (area_id, theme, category_code)
 * so a chunk maps to one geographic + topical slice; then, within a bucket,
 * fall back to the existing byte-size accumulation split. The category is
 * manifest routing metadata and does not change the chunk-v0 content hash.
 */
function groupEvents(events, targetSizeBytes, datasetId, namespace, datasetVersion) {
  const buckets = new Map();
  for (const event of events) {
    const { areaId, theme, categoryCode } = areaTheme(event);
    const key = `${areaId}\u0000${theme}\u0000${categoryCode ?? ''}`;
    if (!buckets.has(key)) buckets.set(key, { areaId, theme, categoryCode, events: [] });
    buckets.get(key).events.push(event);
  }

  const orderedKeys = [...buckets.keys()].sort((left, right) =>
    Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
  );

  const groups = [];
  for (const key of orderedKeys) {
    const { areaId, theme, categoryCode, events: bucketEvents } = buckets.get(key);
    let current = [];
    for (const event of bucketEvents) {
      const candidate = [...current, event];
      const candidateContent = {
        dataset_id: datasetId,
        namespace,
        dataset_version: datasetVersion,
        sequence: groups.length,
        priority: priorityFor(candidate),
        area_id: areaId,
        theme,
        bbox: bboxOfEvents(candidate),
        content_type: 'application/json',
        content_encoding: 'identity',
        events: candidate,
      };
      if (current.length > 0 && Buffer.byteLength(canonicalize(candidateContent), 'utf8') > targetSizeBytes) {
        groups.push({ areaId, theme, categoryCode, events: current, seq: 0 });
        current = [event];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) groups.push({ areaId, theme, categoryCode, events: current, seq: 0 });
  }

  const seqByBucket = new Map();
  for (const group of groups) {
    const bucketKey = `${group.areaId}\u0000${group.theme}\u0000${group.categoryCode ?? ''}`;
    const seq = seqByBucket.get(bucketKey) ?? 0;
    group.seq = seq;
    seqByBucket.set(bucketKey, seq + 1);
  }
  return groups;
}

function areaShort(areaId) {
  return areaId.split('.').pop();
}

export function buildBundle(events, options) {
  const {
    datasetId,
    namespace,
    datasetVersion,
    source,
    sourceVersion,
    createdAt,
    expiresAt,
    signingKeyId,
    privateKey,
    previousManifestHash,
    // Backfilled 2026-09-05 (was picked with no justification — see
    // docs/adr/ADR-001-transport-layer.md's "targetSizeBytes 回填" section
    // for the full derivation and the real BLE GATT throughput numbers this
    // is based on): at the measured 3.8-4.4 KB/s single-contact throughput,
    // a 4096-byte chunk transfers in ~1-1.5s — small enough that even a
    // short (10s) opportunistic contact window can move several chunks with
    // room for an interruption/resume, while staying well under
    // BleGattTransport's WRITE_TIMEOUT_MS (10s) and ACK_TIMEOUT_MS (30s) per
    // chunk. Kept at 4096 rather than changed: it already lines up with the
    // real Neihu scale dataset's average chunk size (6.5 KB across 183
    // chunks), so the number turned out to be reasonable in hindsight.
    targetSizeBytes = 4096,
    manifestId = `${datasetId}:manifest:${datasetVersion}`,
  } = options;
  if (!Array.isArray(events) || events.length === 0) throw new TypeError('buildBundle requires events');
  if (!privateKey) throw new TypeError('buildBundle requires a private key');

  const groups = groupEvents(events, targetSizeBytes, datasetId, namespace, datasetVersion);
  const unsignedChunks = groups.map((group, sequence) => {
    const { areaId, theme, categoryCode, events: groupEventsList, seq } = group;
    const categoryToken = categoryCode === null ? '' : `:${categoryCode}`;
    const chunkId = `${datasetId}:chunk:${datasetVersion}:${areaShort(areaId)}:${theme}${categoryToken}:${String(seq).padStart(3, '0')}`;
    const base = {
      schema_version: 'chunk-v0',
      chunk_id: chunkId,
      manifest_id: manifestId,
      dataset_id: datasetId,
      namespace,
      dataset_version: datasetVersion,
      sequence,
      priority: priorityFor(groupEventsList),
      area_id: areaId,
      theme,
      bbox: bboxOfEvents(groupEventsList),
      created_at: createdAt,
      content_type: 'application/json',
      content_encoding: 'identity',
      event_count: groupEventsList.length,
      events: groupEventsList,
      signature_algorithm: 'Ed25519',
      signing_key_id: signingKeyId,
    };
    const payloadBytes = chunkPayloadBytes(base);
    return {
      ...base,
      byte_length: payloadBytes.length,
      chunk_hash: sha256Bytes(payloadBytes),
    };
  });

  const manifestBase = {
    schema_version: 'manifest-v0',
    manifest_id: manifestId,
    dataset_id: datasetId,
    namespace,
    source,
    source_version: String(sourceVersion),
    dataset_version: datasetVersion,
    created_at: createdAt,
    expires_at: expiresAt,
    chunking: {
      algorithm: 'fixed-size',
      target_size_bytes: targetSizeBytes,
      hash_algorithm: 'SHA-256',
    },
    total_event_count: events.length,
    total_size_bytes: unsignedChunks.reduce((total, chunk) => total + chunk.byte_length, 0),
    chunks: unsignedChunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      sequence: chunk.sequence,
      chunk_hash: chunk.chunk_hash,
      size_bytes: chunk.byte_length,
      event_count: chunk.event_count,
      priority: chunk.priority,
      area_id: chunk.area_id,
      theme: chunk.theme,
      ...(groups[chunk.sequence].categoryCode !== null
        ? { category_code: groups[chunk.sequence].categoryCode }
        : {}),
      bbox: chunk.bbox,
      event_ids: chunk.events.map((event) => event.event_id),
    })),
    ...(previousManifestHash ? { previous_manifest_hash: previousManifestHash } : {}),
    signature_algorithm: 'Ed25519',
    signing_key_id: signingKeyId,
  };
  const manifestHash = sha256Canonical(manifestHashInput(manifestBase));
  const manifest = {
    ...manifestBase,
    manifest_hash: manifestHash,
  };
  const signedManifest = {
    ...manifest,
    signature: signCanonical(manifestSignatureInput({ ...manifest, signature: '' }), privateKey),
  };

  const chunks = unsignedChunks.map((chunk) => {
    const signedChunk = {
      ...chunk,
      manifest_hash: manifestHash,
      signature: '',
    };
    return {
      ...signedChunk,
      signature: signCanonical(chunkSignatureInput(signedChunk), privateKey),
    };
  });
  return { manifest: signedManifest, chunks };
}
