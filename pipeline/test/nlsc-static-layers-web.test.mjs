import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

import { buildSignedLayer } from '../lib/layer-publisher.mjs';
import { buildSignedAddressPackArtifact, buildSignedAddressPackCatalog } from '../lib/address-packs.mjs';
import { generateEd25519KeyPair, exportPublicKeyPem } from '../lib/crypto.mjs';

const script = await readFile(new URL('../../flutter/web/nlsc_static_layers.js', import.meta.url), 'utf8');

function testLayerBundle() {
  const keys = generateEd25519KeyPair();
  const now = new Date('2026-10-04T00:00:00.000Z');
  const feature = {
    schema_version: 'feature-v0',
    namespace: 'official.tw',
    dataset_id: 'resilientgeo-taiwan',
    layer_id: 'taiwan-shelter',
    feature_id: 'shelter:sample',
    feature_type: 'SHELTER',
    geometry: { type: 'Point', coordinates: [121.5, 25.0] },
    properties: { name: '測試避難所', address: '臺北市測試路 1 號' },
    source: 'taiwan-shelter',
    source_version: now.toISOString(),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
    signature_algorithm: 'Ed25519',
    provenance: {
      original_source: 'https://example.gov.tw/shelters',
      received_at: now.toISOString(),
      transport_source: { kind: 'server', node_id: 'test' },
    },
  };
  const bundle = buildSignedLayer([feature], {
    layerId: 'taiwan-shelter',
    privateKey: keys.privateKey,
    signingKeyId: 'test-static-key',
    sourceVersion: now.toISOString(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    URL,
    Date,
    Uint8Array,
    Array,
    Object,
    JSON,
    Math,
    Error,
    TypeError,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    globalThis: undefined,
    location: { origin: 'https://example.test' },
    isSecureContext: true,
    navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({ 'test-static-key': publicKey }) }),
  });
  vm.runInContext('globalThis = globalThis ?? this', context);
  vm.runInContext(script, context);
  return {
    bundle,
    verify: context.ResilientGeoNLSCStatic.verifyLayerBundle,
    linkDirectoryPoints: context.ResilientGeoNLSCStatic.linkDirectoryPoints,
    mapFeature: context.ResilientGeoNLSCStatic.mapFeature,
  };
}

test('WebCrypto verifies the signed layer, every chunk and every feature', async () => {
  const { bundle, verify } = testLayerBundle();
  const result = await verify(bundle, 'taiwan-shelter');
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.name, '測試避難所');
});

test('the browser verifier rejects a changed feature payload', async () => {
  const { bundle, verify } = testLayerBundle();
  bundle.chunks[0].features[0].properties.name = '被竄改的名稱';
  await assert.rejects(() => verify(bundle, 'taiwan-shelter'), /雜湊|簽章/u);
});

test('the browser verifier accepts only the geometry-less medical search directory contract', async () => {
  const keys = generateEd25519KeyPair();
  const now = new Date('2026-10-04T00:00:00.000Z');
  const feature = {
    schema_version: 'feature-v0',
    namespace: 'official.medical',
    dataset_id: 'resilientgeo-taiwan-medical-directory',
    layer_id: 'taiwan-medical-directory',
    feature_id: 'medical-directory:h001',
    feature_type: 'MEDICAL_DIRECTORY_ENTRY',
    geometry: null,
    properties: {
      name: '未定位診所', address: '花蓮縣花蓮市測試路1號',
      geometry_status: 'unresolved', point_feature_id: null,
    },
    source: 'mohw-medical-master',
    source_version: now.toISOString(),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
    signature_algorithm: 'Ed25519',
    provenance: {
      original_source: 'https://data.gov.tw/dataset/15393',
      received_at: now.toISOString(),
      transport_source: { kind: 'server', node_id: 'test' },
    },
  };
  const bundle = buildSignedLayer([feature], {
    layerId: 'taiwan-medical-directory',
    privateKey: keys.privateKey,
    signingKeyId: 'test-static-key',
    sourceVersion: now.toISOString(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, URL, Date, Uint8Array, Array, Object, JSON,
    Math, Error, TypeError,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    globalThis: undefined, location: { origin: 'https://example.test' },
    isSecureContext: true, navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({ 'test-static-key': publicKey }) }),
  });
  vm.runInContext('globalThis = globalThis ?? this', context);
  vm.runInContext(script, context);
  const result = await context.ResilientGeoNLSCStatic.verifyLayerBundle(
    { manifest: bundle.manifest, chunks: bundle.chunks },
    'taiwan-medical-directory',
  );
  assert.equal(result.features[0].geometry, null);
});

test('links a medical directory entry only to its referenced verified point', () => {
  const { linkDirectoryPoints } = testLayerBundle();
  assert.equal(typeof linkDirectoryPoints, 'function');
  const point = {
    id: 'medical:h001',
    kind: 'medical',
    geometry: { type: 'Point', coordinates: [121.52, 25.04] },
  };
  const located = {
    id: 'medical-directory:h001',
    kind: 'medical-directory',
    geometry: null,
    properties: { geometry_status: 'located', point_feature_id: 'medical:h001' },
  };
  const unresolved = {
    id: 'medical-directory:h002',
    kind: 'medical-directory',
    geometry: null,
    properties: { geometry_status: 'unresolved', point_feature_id: null },
  };

  linkDirectoryPoints([point, located, unresolved]);

  assert.deepEqual(located.geometry, point.geometry);
  assert.equal(unresolved.geometry, null);
});

test('maps the published MEDICAL_FACILITY type to the medical point layer', () => {
  const { mapFeature, linkDirectoryPoints } = testLayerBundle();
  const point = mapFeature({
    feature_id: 'medical:h001',
    feature_type: 'MEDICAL_FACILITY',
    geometry: { type: 'Point', coordinates: [121.52, 25.04] },
    properties: { name: '臺北醫院' },
  });
  const directory = mapFeature({
    feature_id: 'medical-directory:h001',
    feature_type: 'MEDICAL_DIRECTORY_ENTRY',
    geometry: null,
    properties: {
      name: '臺北醫院',
      geometry_status: 'located',
      point_feature_id: 'medical:h001',
    },
  });

  linkDirectoryPoints([point, directory]);

  assert.equal(point.kind, 'medical');
  assert.deepEqual(directory.geometry, point.geometry);
});

test('WebCrypto verifies the signed address catalog and county manifest pin', async () => {
  const keys = generateEd25519KeyPair();
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const pack = {
    schema_version: 'address-pack-v1', county_code: '63000', county_name: '臺北市',
    source_version: '2026-10-02', coordinate_system: 'EPSG:3826',
    coordinate_order: 'longitude,latitude', records: [],
    summary: { source_count: 1, located_count: 0, unlocated_count: 1, excluded_count: 0, coverage_status: 'partial' },
  };
  const artifact = await buildSignedAddressPackArtifact(pack, {
    privateKey: keys.privateKey, signingKeyId: 'test-static-key',
    sourceUrl: 'https://data.gov.tw/dataset/155472',
  });
  const counties = Array.from({ length: 22 }, (_, index) => ({
    county_code: String(10000 + index).padStart(5, '0'), county_name: `縣市${index}`,
    coverage_status: 'unavailable', manifest_url: null, manifest_sha256: null,
  }));
  counties[0] = {
    county_code: '63000', county_name: '臺北市', coverage_status: 'partial',
    source_count: 1, located_count: 0, unlocated_count: 1, excluded_count: 0,
    manifest_url: `/address-packs/${artifact.manifestFile}`,
    manifest_sha256: artifact.manifestSha256,
  };
  const catalog = buildSignedAddressPackCatalog(counties, {
    privateKey: keys.privateKey, signingKeyId: 'test-static-key',
    createdAt: '2026-10-04T00:00:00.000Z',
  });
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, URL, Date, Uint8Array, Array, Object, JSON,
    Math, Error, TypeError,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    globalThis: undefined, location: { origin: 'https://example.test' },
    isSecureContext: true, navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({ 'test-static-key': publicKey }) }),
  });
  vm.runInContext('globalThis = globalThis ?? this', context);
  vm.runInContext(script, context);

  const api = context.ResilientGeoNLSCStatic;
  await api.verifyAddressCatalog(catalog);
  await api.verifyAddressManifest(
    artifact.manifest,
    catalog.counties.find((county) => county.county_code === '63000'),
    artifact.manifestSha256,
  );
  const changed = { ...catalog, attribution: 'tampered' };
  await assert.rejects(() => api.verifyAddressCatalog(changed), /簽章/u);
});
