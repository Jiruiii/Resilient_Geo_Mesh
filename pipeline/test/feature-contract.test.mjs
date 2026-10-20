import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  signFeature,
  verifyFeature,
} from '../lib/feature-contract.mjs';
import {
  buildFeatureBundle,
  verifyFeatureBundle,
} from '../lib/feature-bundle.mjs';
import { generateEd25519KeyPair } from '../lib/crypto.mjs';
import { canonicalize } from '../lib/canonical.mjs';

const { privateKey, publicKey } = generateEd25519KeyPair();
const KEY_ID = 'feature-test-2026';
const NOW = '2026-09-04T04:00:00Z';

function feature(overrides = {}) {
  return {
    schema_version: 'feature-v0',
    namespace: 'official.taipei',
    dataset_id: 'resilientgeo-neihu',
    layer_id: 'shelter',
    feature_id: 'shelter:001',
    feature_type: 'SHELTER',
    geometry: { type: 'Point', coordinates: [121.58, 25.08] },
    properties: { name: '內湖避難所', capacity: 300 },
    source: 'taipei-shelter',
    source_version: 'snapshot-2026-09-04',
    issued_at: '2026-09-04T00:00:00Z',
    expires_at: '2026-09-11T00:00:00Z',
    signature_algorithm: 'Ed25519',
    signing_key_id: KEY_ID,
    provenance: {
      original_source: 'https://example.gov.tw/shelters.csv',
      received_at: '2026-09-04T00:00:00Z',
      transport_source: { kind: 'server', node_id: 'feature-test' },
    },
    ...overrides,
  };
}

test('signs and verifies an independent Feature v0 payload', () => {
  const signed = signFeature(feature(), privateKey);
  assert.match(signed.payload_hash, /^sha256:[0-9a-f]{64}$/u);
  const result = verifyFeature(signed, publicKey, { trustedKeyIds: [KEY_ID], now: NOW });
  assert.equal(result.valid, true);
  assert.equal(result.current, true);
});

test('rejects a tampered feature and invalid feature identity', () => {
  const signed = signFeature(feature(), privateKey);
  const tampered = structuredClone(signed);
  tampered.properties.capacity = 999;
  assert.equal(verifyFeature(tampered, publicKey, { trustedKeyIds: [KEY_ID], now: NOW }).valid, false);

  const invalid = feature({ feature_id: '', geometry: { type: 'Point', coordinates: [121.58, 250] } });
  assert.throws(() => signFeature(invalid, privateKey), /feature_id|geometry/u);
});

test('builds and verifies a separate static layer bundle', () => {
  const signedFeatures = [
    signFeature(feature(), privateKey),
    signFeature(feature({ feature_id: 'shelter:002', geometry: { type: 'Point', coordinates: [121.59, 25.08] } }), privateKey),
  ];
  const bundle = buildFeatureBundle(signedFeatures, {
    datasetId: 'resilientgeo-neihu',
    layerId: 'shelter',
    namespace: 'official.taipei',
    datasetVersion: 1,
    source: 'taipei-shelter',
    sourceVersion: 'snapshot-2026-09-04',
    createdAt: '2026-09-04T00:00:00Z',
    expiresAt: '2026-09-11T00:00:00Z',
    signingKeyId: KEY_ID,
    privateKey,
    targetSizeBytes: 4096,
  });

  assert.equal(bundle.manifest.schema_version, 'layer-manifest-v0');
  assert.equal(bundle.chunks[0].schema_version, 'layer-chunk-v0');
  assert.equal(bundle.manifest.total_feature_count, 2);
  assert.equal(verifyFeatureBundle(bundle, publicKey, { trustedKeyIds: [KEY_ID], now: NOW }).valid, true);
});

test('fixed-size feature chunks preserve UTF-8 byte boundaries', () => {
  const signedFeatures = Array.from({ length: 24 }, (_, index) => signFeature(feature({
    feature_id: `shelter:${String(index).padStart(3, '0')}`,
    properties: {
      name: `內湖避難所-${index}`,
      notes: '防災資訊'.repeat(index % 4 + 1),
    },
  }), privateKey));
  const options = {
    datasetId: 'resilientgeo-neihu',
    layerId: 'shelter',
    namespace: 'official.taipei',
    datasetVersion: 1,
    source: 'taipei-shelter',
    sourceVersion: 'snapshot-2026-09-04',
    createdAt: '2026-09-04T00:00:00Z',
    expiresAt: '2026-09-11T00:00:00Z',
    signingKeyId: KEY_ID,
    privateKey,
    targetSizeBytes: 1800,
  };
  const bundle = buildFeatureBundle(signedFeatures, options);
  const expectedGroups = [];
  let current = [];
  for (const signedFeature of signedFeatures) {
    const candidate = [...current, signedFeature];
    const content = {
      dataset_id: options.datasetId,
      layer_id: options.layerId,
      namespace: options.namespace,
      dataset_version: options.datasetVersion,
      sequence: expectedGroups.length,
      priority: 'NORMAL',
      created_at: options.createdAt,
      content_type: 'application/json',
      content_encoding: 'identity',
      features: candidate,
    };
    if (current.length > 0
      && Buffer.byteLength(canonicalize(content), 'utf8') > options.targetSizeBytes) {
      expectedGroups.push(current);
      current = [signedFeature];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) expectedGroups.push(current);

  assert.deepEqual(
    bundle.chunks.map((chunk) => chunk.features.map((value) => value.feature_id)),
    expectedGroups.map((group) => group.map((value) => value.feature_id)),
  );
  for (const chunk of bundle.chunks) {
    const content = {
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
    assert.equal(chunk.byte_length, Buffer.byteLength(canonicalize(content), 'utf8'));
    assert.ok(chunk.byte_length <= options.targetSizeBytes);
  }
});

test('allows geometry-less medical directory records without weakening point layers', () => {
  const directoryFeature = feature({
    namespace: 'official.medical',
    dataset_id: 'resilientgeo-taiwan-medical-directory',
    layer_id: 'taiwan-medical-directory',
    feature_id: 'medical-directory:h002',
    feature_type: 'MEDICAL_DIRECTORY_ENTRY',
    geometry: null,
    properties: {
      name: '待定位診所', address: '臺北市大安區仁愛路1號',
      geometry_status: 'unresolved', point_feature_id: null,
    },
  });
  const signed = signFeature(directoryFeature, privateKey);
  assert.equal(verifyFeature(signed, publicKey, { trustedKeyIds: [KEY_ID], now: NOW }).valid, true);
  assert.throws(() => signFeature(feature({ geometry: null }), privateKey), /geometry/u);

  const bundle = buildFeatureBundle([signed], {
    datasetId: directoryFeature.dataset_id,
    layerId: directoryFeature.layer_id,
    namespace: directoryFeature.namespace,
    datasetVersion: 1,
    source: 'mohw-medical-master',
    sourceVersion: 'snapshot-2026-09',
    createdAt: '2026-09-04T00:00:00Z',
    expiresAt: '2026-10-04T00:00:00Z',
    signingKeyId: KEY_ID,
    privateKey,
  });
  assert.deepEqual(bundle.manifest.bbox, [118, 21.8, 122.2, 26.5]);
  assert.equal(verifyFeatureBundle(bundle, publicKey, { trustedKeyIds: [KEY_ID], now: NOW }).valid, true);
});
