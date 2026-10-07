import {
  canonicalize,
  sha256Canonical,
  sha256Bytes,
} from './canonical.mjs';
import { signCanonical, verifyCanonical } from './crypto.mjs';
import { bboxOfGeometry } from './geo.mjs';
import {
  featurePayload,
  validateFeatureShape,
  verifyFeature,
} from './feature-contract.mjs';

const PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

function featureBBox(features) {
  const geometries = features.filter((feature) => feature.geometry !== null).map((feature) => feature.geometry);
  if (geometries.length === 0 && features.every((feature) => feature.layer_id === 'taiwan-medical-directory')) {
    // Search-only medical records have no point geometry by design. This is
    // the coverage extent of the directory, not a coordinate for any record.
    return [118, 21.8, 122.2, 26.5];
  }
  if (geometries.length !== features.length) throw new TypeError('feature bundle cannot mix geolocated and search-only records');
  const boxes = geometries.map((geometry) => bboxOfGeometry(geometry));
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ].map((value) => Number(value.toFixed(6)));
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertBuildOptions(options) {
  for (const field of ['datasetId', 'layerId', 'namespace', 'source', 'sourceVersion', 'createdAt', 'expiresAt', 'signingKeyId']) {
    if (typeof options[field] !== 'string' || options[field].length === 0) {
      throw new TypeError(`buildFeatureBundle requires ${field}`);
    }
  }
  if (!Number.isInteger(options.datasetVersion) || options.datasetVersion < 1) {
    throw new TypeError('buildFeatureBundle requires a positive datasetVersion');
  }
  if (!options.privateKey) throw new TypeError('buildFeatureBundle requires a private key');
  if (options.targetSizeBytes !== undefined
    && (!Number.isInteger(options.targetSizeBytes) || options.targetSizeBytes < 256)) {
    throw new TypeError('targetSizeBytes must be at least 256');
  }
}

function assertFeatures(features, options) {
  if (!Array.isArray(features) || features.length === 0) throw new TypeError('buildFeatureBundle requires features');
  for (const feature of features) {
    const errors = validateFeatureShape(feature);
    if (errors.length > 0) throw new TypeError(`invalid feature ${feature?.feature_id ?? '<unknown>'}: ${errors.join('; ')}`);
    if (feature.dataset_id !== options.datasetId) throw new TypeError(`feature ${feature.feature_id} has a different dataset_id`);
    if (feature.layer_id !== options.layerId) throw new TypeError(`feature ${feature.feature_id} has a different layer_id`);
    if (feature.namespace !== options.namespace) throw new TypeError(`feature ${feature.feature_id} has a different namespace`);
  }
}

function chunkContent(chunk) {
  return {
    dataset_id: chunk.dataset_id,
    layer_id: chunk.layer_id,
    namespace: chunk.namespace,
    dataset_version: chunk.dataset_version,
    sequence: chunk.sequence,
    priority: chunk.priority,
    created_at: chunk.created_at,
    content_type: chunk.content_type,
    content_encoding: chunk.content_encoding,
    features: chunk.features,
  };
}

function chunkHash(chunk) {
  return sha256Bytes(Buffer.from(canonicalize(chunkContent(chunk)), 'utf8'));
}

function splitFeatures(features, options) {
  const targetSizeBytes = options.targetSizeBytes ?? 4096;
  const groups = [];
  let current = [];
  for (const feature of features) {
    const candidate = [...current, feature];
    const candidateContent = {
      dataset_id: options.datasetId,
      layer_id: options.layerId,
      namespace: options.namespace,
      dataset_version: options.datasetVersion,
      sequence: groups.length,
      priority: options.priority,
      created_at: options.createdAt,
      content_type: 'application/json',
      content_encoding: 'identity',
      features: candidate,
    };
    if (current.length > 0 && Buffer.byteLength(canonicalize(candidateContent), 'utf8') > targetSizeBytes) {
      groups.push(current);
      current = [feature];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function manifestHashInput(manifest) {
  const { manifest_hash: _manifestHash, signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

function signatureInput(value) {
  const { signature: _signature, ...signedContent } = value;
  return signedContent;
}

export function buildFeatureBundle(features, options) {
  const normalizedOptions = {
    ...options,
    priority: options.priority ?? 'NORMAL',
  };
  assertBuildOptions(normalizedOptions);
  if (!PRIORITIES.has(normalizedOptions.priority)) throw new TypeError('priority is invalid');
  assertFeatures(features, normalizedOptions);

  const groups = splitFeatures(features, normalizedOptions);
  const manifestId = normalizedOptions.manifestId
    ?? `${normalizedOptions.datasetId}:${normalizedOptions.layerId}:manifest:${normalizedOptions.datasetVersion}`;
  const unsignedChunks = groups.map((group, sequence) => {
    const base = {
      schema_version: 'layer-chunk-v0',
      chunk_id: `${normalizedOptions.datasetId}:${normalizedOptions.layerId}:chunk:${normalizedOptions.datasetVersion}:${String(sequence).padStart(3, '0')}`,
      manifest_id: manifestId,
      dataset_id: normalizedOptions.datasetId,
      layer_id: normalizedOptions.layerId,
      namespace: normalizedOptions.namespace,
      dataset_version: normalizedOptions.datasetVersion,
      sequence,
      priority: normalizedOptions.priority,
      created_at: normalizedOptions.createdAt,
      content_type: 'application/json',
      content_encoding: 'identity',
      feature_count: group.length,
      features: group,
      signature_algorithm: 'Ed25519',
      signing_key_id: normalizedOptions.signingKeyId,
    };
    const contentHash = chunkHash(base);
    return {
      ...base,
      byte_length: Buffer.byteLength(canonicalize(chunkContent(base)), 'utf8'),
      chunk_hash: contentHash,
    };
  });

  const manifestBase = {
    schema_version: 'layer-manifest-v0',
    manifest_id: manifestId,
    dataset_id: normalizedOptions.datasetId,
    layer_id: normalizedOptions.layerId,
    namespace: normalizedOptions.namespace,
    source: normalizedOptions.source,
    source_version: normalizedOptions.sourceVersion,
    dataset_version: normalizedOptions.datasetVersion,
    created_at: normalizedOptions.createdAt,
    expires_at: normalizedOptions.expiresAt,
    chunking: {
      algorithm: 'fixed-size',
      target_size_bytes: normalizedOptions.targetSizeBytes ?? 4096,
      hash_algorithm: 'SHA-256',
    },
    total_feature_count: features.length,
    total_size_bytes: unsignedChunks.reduce((total, chunk) => total + chunk.byte_length, 0),
    bbox: featureBBox(features),
    content_hash: sha256Canonical(features.map((feature) => featurePayload(feature))),
    chunks: unsignedChunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      sequence: chunk.sequence,
      chunk_hash: chunk.chunk_hash,
      size_bytes: chunk.byte_length,
      feature_count: chunk.feature_count,
      priority: chunk.priority,
      feature_ids: chunk.features.map((feature) => feature.feature_id),
    })),
    signature_algorithm: 'Ed25519',
    signing_key_id: normalizedOptions.signingKeyId,
  };
  const manifest = {
    ...manifestBase,
    manifest_hash: sha256Canonical(manifestHashInput(manifestBase)),
  };
  const signedManifest = {
    ...manifest,
    signature: signCanonical(manifest, normalizedOptions.privateKey),
  };
  const chunks = unsignedChunks.map((chunk) => {
    const signedContent = {
      ...chunk,
      manifest_hash: signedManifest.manifest_hash,
      signature: '',
    };
    return {
      ...signedContent,
      signature: signCanonical(signatureInput(signedContent), normalizedOptions.privateKey),
    };
  });
  return { manifest: signedManifest, chunks };
}

function verifyManifest(manifest, publicKey, options) {
  const errors = [];
  for (const field of [
    'schema_version', 'manifest_id', 'dataset_id', 'layer_id', 'namespace', 'source',
    'source_version', 'dataset_version', 'created_at', 'expires_at', 'bbox', 'content_hash', 'chunks',
    'manifest_hash', 'signature', 'signature_algorithm', 'signing_key_id',
  ]) {
    if (!(field in (manifest ?? {}))) errors.push(`missing manifest field: ${field}`);
  }
  if (manifest?.schema_version !== 'layer-manifest-v0') errors.push('manifest schema_version is invalid');
  if (!Array.isArray(manifest?.chunks) || manifest.chunks.length === 0) errors.push('manifest chunks are required');
  if (!Array.isArray(manifest?.bbox) || manifest.bbox.length !== 4 || !manifest.bbox.every(Number.isFinite)) errors.push('manifest bbox is invalid');
  if (typeof manifest?.content_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/iu.test(manifest.content_hash)) errors.push('manifest content_hash is invalid');
  if (manifest?.signature_algorithm !== 'Ed25519') errors.push('manifest signature_algorithm is invalid');
  if (manifest && sha256Canonical(manifestHashInput(manifest)) !== manifest.manifest_hash) errors.push('manifest_hash_mismatch');
  if (manifest && (!publicKey || !verifyCanonical(signatureInput(manifest), manifest.signature, publicKey))) errors.push('manifest_signature_invalid');
  if (options.trustedKeyIds?.length > 0 && !options.trustedKeyIds.includes(manifest?.signing_key_id)) errors.push('manifest_signing_key_untrusted');
  return errors;
}

export function verifyFeatureBundle(bundle, publicKey, options = {}) {
  const manifestErrors = verifyManifest(bundle?.manifest, publicKey, options);
  if (manifestErrors.length > 0) return { valid: false, stage: 'manifest', errors: manifestErrors };
  const manifest = bundle.manifest;
  const chunks = Array.isArray(bundle.chunks) ? bundle.chunks : [];
  const chunkResults = [];
  const featureResults = [];
  const errors = [];
  if (chunks.length !== manifest.chunks.length) errors.push('chunk_count_mismatch');
  const allFeatures = [];
  const featureIds = new Set();
  const orderedChunks = [...chunks].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  for (const chunk of orderedChunks) {
    const expected = manifest.chunks.find((entry) => entry.chunk_id === chunk.chunk_id);
    if (!expected) {
      errors.push(`chunk_not_in_manifest:${chunk.chunk_id}`);
      continue;
    }
    if (chunk.manifest_id !== manifest.manifest_id || chunk.manifest_hash !== manifest.manifest_hash) errors.push(`chunk_binding_invalid:${chunk.chunk_id}`);
    const chunkErrors = [];
    if (chunk.feature_count !== chunk.features?.length || chunk.feature_count !== expected.feature_count) chunkErrors.push(`feature_count_mismatch:${chunk.chunk_id}`);
    if (chunk.chunk_hash !== chunkHash(chunk)) chunkErrors.push(`chunk_hash_mismatch:${chunk.chunk_id}`);
    if (chunk.byte_length !== Buffer.byteLength(canonicalize(chunkContent(chunk)), 'utf8')) chunkErrors.push(`chunk_size_mismatch:${chunk.chunk_id}`);
    if (!verifyCanonical(signatureInput(chunk), chunk.signature, publicKey)) chunkErrors.push(`chunk_signature_invalid:${chunk.chunk_id}`);
    const expectedFeatureIds = expected.feature_ids ?? [];
    const actualFeatureIds = (chunk.features ?? []).map((feature) => feature.feature_id);
    if (!sameArray(expectedFeatureIds, actualFeatureIds)) chunkErrors.push(`feature_ids_mismatch:${chunk.chunk_id}`);
    chunkResults.push({ chunk_id: chunk.chunk_id, valid: chunkErrors.length === 0, errors: chunkErrors });
    errors.push(...chunkErrors);
    for (const feature of chunk.features ?? []) {
      allFeatures.push(feature);
      if (featureIds.has(feature.feature_id)) errors.push(`duplicate_feature_id:${feature.feature_id}`);
      featureIds.add(feature.feature_id);
      const result = verifyFeature(feature, publicKey, options);
      featureResults.push({ feature_id: feature.feature_id, ...result });
      if (!result.valid) errors.push(`feature_invalid:${feature.feature_id}`);
    }
  }
  if (allFeatures.length !== manifest.total_feature_count) errors.push('total_feature_count_mismatch');
  if (allFeatures.length > 0) {
    try {
      if (!sameArray(manifest.bbox, featureBBox(allFeatures))) errors.push('manifest_bbox_mismatch');
      if (manifest.content_hash !== sha256Canonical(allFeatures.map((feature) => featurePayload(feature)))) {
        errors.push('manifest_content_hash_mismatch');
      }
    } catch (error) {
      errors.push(`manifest_feature_summary_invalid:${error.message}`);
    }
  }
  return {
    valid: errors.length === 0,
    stage: errors.length === 0 ? 'complete' : 'chunk',
    errors,
    chunks: chunkResults,
    features: featureResults,
    expired: options.now ? new Date(options.now) >= new Date(manifest.expires_at) : false,
  };
}
