import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPeerSummary } from '../../simulator/lib/engine.mjs';
import { buildScenario } from '../../simulator/lib/scenario.mjs';
import { createNode } from '../../simulator/lib/world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

const schemas = new Map([
  ['event-v0.schema.json', readJson('schemas/event-v0.schema.json')],
  ['feature-v0.schema.json', readJson('schemas/feature-v0.schema.json')],
  ['layer-manifest-v0.schema.json', readJson('schemas/layer-manifest-v0.schema.json')],
  ['layer-chunk-v0.schema.json', readJson('schemas/layer-chunk-v0.schema.json')],
  ['peer-summary-v0.schema.json', readJson('schemas/peer-summary-v0.schema.json')],
]);
const catalog = readJson('pipeline/sources/catalog.json');

function valueAtPointer(value, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((current, part) => current?.[part], value);
}

function resolveReference(reference, rootSchema) {
  const [fileName, fragment = ''] = reference.split('#');
  const referenceRoot = fileName ? schemas.get(fileName) : rootSchema;
  if (!referenceRoot) throw new Error(`unknown schema reference: ${reference}`);
  return {
    schema: fragment ? valueAtPointer(referenceRoot, fragment) : referenceRoot,
    rootSchema: referenceRoot,
  };
}

function isType(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return false;
}

function validate(value, schema, rootSchema = schema, location = '$') {
  if (schema.$ref) {
    const resolved = resolveReference(schema.$ref, rootSchema);
    return validate(value, resolved.schema, resolved.rootSchema, location);
  }

  const errors = [];
  for (const subschema of schema.allOf ?? []) {
    errors.push(...validate(value, subschema, rootSchema, location));
  }
  if (schema.if) {
    const branch = validate(value, schema.if, rootSchema, location).length === 0 ? schema.then : schema.else;
    if (branch) errors.push(...validate(value, branch, rootSchema, location));
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validate(value, candidate, rootSchema, location).length === 0);
    if (matches.length !== 1) errors.push(`${location} must match exactly one schema`);
    return errors;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${location} must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location} is not in enum`);
  if (schema.type && !isType(value, schema.type)) {
    errors.push(`${location} must be ${schema.type}`);
    return errors;
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${location} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${location} has invalid format`);
    if (schema.format === 'date-time') {
      const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
      if (!rfc3339.test(value) || Number.isNaN(Date.parse(value))) errors.push(`${location} must be RFC 3339 date-time`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${location} is above maximum`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${location} has too many items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${location} must contain unique items`);
    }
    value.forEach((item, index) => {
      const itemSchema = schema.prefixItems?.[index] ?? schema.items;
      if (itemSchema === false) errors.push(`${location}[${index}] is not allowed`);
      else if (itemSchema) errors.push(...validate(item, itemSchema, rootSchema, `${location}[${index}]`));
    });
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of schema.required ?? []) {
      if (!(field in value)) errors.push(`${location} is missing ${field}`);
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!(field in (schema.properties ?? {}))) errors.push(`${location}.${field} is not allowed`);
      }
    }
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      if (field in value) errors.push(...validate(value[field], fieldSchema, rootSchema, `${location}.${field}`));
    }
  }
  return errors;
}

const HASH = `sha256:${'0'.repeat(64)}`;
const SIGNATURE = 'dGVzdA==';
const PROVENANCE = {
  original_source: 'https://example.gov.tw/shelters.csv',
  received_at: '2026-09-04T00:05:00Z',
  transport_source: { kind: 'server', node_id: 'source-collector' },
};
const FEATURE = {
  schema_version: 'feature-v0',
  namespace: 'official.taipei',
  dataset_id: 'resilientgeo-neihu',
  layer_id: 'shelter',
  feature_id: 'shelter:neihu:001',
  feature_type: 'SHELTER',
  geometry: { type: 'Point', coordinates: [121.58, 25.08] },
  properties: { name: 'demo shelter', capacity: 300 },
  source: 'taipei-shelter',
  source_version: 'snapshot-2026-09-04',
  issued_at: '2026-09-04T00:00:00Z',
  expires_at: '2026-09-11T00:00:00Z',
  payload_hash: HASH,
  signature: SIGNATURE,
  signature_algorithm: 'Ed25519',
  signing_key_id: 'fixture-stage2-2026',
  provenance: PROVENANCE,
};

test('accepts a complete Feature v0 record', () => {
  assert.deepEqual(validate(FEATURE, schemas.get('feature-v0.schema.json')), []);
});

test('rejects Feature v0 records without logical identity', () => {
  const invalid = structuredClone(FEATURE);
  delete invalid.feature_id;
  assert.ok(validate(invalid, schemas.get('feature-v0.schema.json')).some((error) => error.includes('feature_id')));
});

test('rejects Feature v0 records with invalid GeoJSON coordinates', () => {
  const invalid = structuredClone(FEATURE);
  invalid.geometry.coordinates = [121.58, 250.08];
  assert.notDeepEqual(validate(invalid, schemas.get('feature-v0.schema.json')), []);
});

test('rejects Feature v0 records with invalid timestamps', () => {
  const invalid = structuredClone(FEATURE);
  invalid.issued_at = '2026/09/04';
  assert.ok(validate(invalid, schemas.get('feature-v0.schema.json')).some((error) => error.includes('issued_at')));
});

test('rejects Feature v0 records without provenance', () => {
  const invalid = structuredClone(FEATURE);
  delete invalid.provenance;
  assert.ok(validate(invalid, schemas.get('feature-v0.schema.json')).some((error) => error.includes('provenance')));
});

test('accepts static layer manifest and chunk records containing features', () => {
  const manifest = {
    schema_version: 'layer-manifest-v0',
    manifest_id: 'resilientgeo-neihu:shelter:manifest:1',
    dataset_id: 'resilientgeo-neihu',
    layer_id: 'shelter',
    namespace: 'official.taipei',
    source: 'taipei-shelter',
    source_version: 'snapshot-2026-09-04',
    dataset_version: 1,
    created_at: '2026-09-04T00:10:00Z',
    expires_at: '2026-09-11T00:00:00Z',
    chunking: { algorithm: 'fixed-size', target_size_bytes: 4096, hash_algorithm: 'SHA-256' },
    total_feature_count: 1,
    total_size_bytes: 1024,
    bbox: [121.58, 25.08, 121.58, 25.08],
    content_hash: HASH,
    chunks: [{
      chunk_id: 'resilientgeo-neihu:shelter:chunk:1:000',
      sequence: 0,
      chunk_hash: HASH,
      size_bytes: 1024,
      feature_count: 1,
      priority: 'HIGH',
      feature_ids: ['shelter:neihu:001'],
    }],
    manifest_hash: HASH,
    signature: SIGNATURE,
    signature_algorithm: 'Ed25519',
    signing_key_id: 'fixture-stage2-2026',
  };
  const chunk = {
    schema_version: 'layer-chunk-v0',
    chunk_id: 'resilientgeo-neihu:shelter:chunk:1:000',
    manifest_id: manifest.manifest_id,
    manifest_hash: HASH,
    dataset_id: 'resilientgeo-neihu',
    layer_id: 'shelter',
    namespace: 'official.taipei',
    dataset_version: 1,
    sequence: 0,
    priority: 'HIGH',
    created_at: '2026-09-04T00:10:00Z',
    content_type: 'application/json',
    content_encoding: 'identity',
    feature_count: 1,
    byte_length: 1024,
    chunk_hash: HASH,
    features: [FEATURE],
    signature: SIGNATURE,
    signature_algorithm: 'Ed25519',
    signing_key_id: 'fixture-stage2-2026',
  };

  assert.deepEqual(validate(manifest, schemas.get('layer-manifest-v0.schema.json')), []);
  assert.deepEqual(validate(chunk, schemas.get('layer-chunk-v0.schema.json')), []);
});

test('catalog registers every data category and keeps GNSS device-local', () => {
  const expectedCategories = new Set([
    'GNSS / GPS',
    'OpenStreetMap',
    'TDX',
    'CWA',
    'NCDR',
    '消防署避難所',
    '醫療資料',
    'DEM / DSM',
    '網路資料',
    'SAR / 光學影像',
  ]);
  assert.deepEqual(new Set(catalog.entries.map((entry) => entry.category)), expectedCategories);

  const gnssEntries = catalog.entries.filter((entry) => entry.source_id === 'gnss-gps');
  assert.equal(gnssEntries.length, 1);
  assert.equal(gnssEntries[0].access_mode, 'device_local');
  assert.equal(gnssEntries[0].endpoint_or_url, null);

  const externalCollectorIds = catalog.entries
    .filter((entry) => entry.access_mode !== 'device_local')
    .map((entry) => entry.source_id);
  assert.ok(!externalCollectorIds.includes('gnss-gps'));
});

// The peer summary is the only schema describing something that actually goes
// over the air between two phones, and it was the one nothing validated. The
// Android side had drifted to sending three of the six required top-level
// fields, and no test noticed, because the parser only reads two of them.
const peerSummarySchema = schemas.get('peer-summary-v0.schema.json');

test('simulated HELLOs conform to the same peer-summary-v0 contract as phones', () => {
  const scenario = buildScenario();
  const node = createNode(0, 'neihu.dahu', null, new Set(['neihu.dahu']), false);
  const options = { generatedAt: '2026-09-01T08:02:00Z', maxPeerCount: 4 };

  const empty = buildPeerSummary(node, scenario, options);
  assert.deepEqual(validate(empty, peerSummarySchema), []);
  assert.equal(empty.generated_at, options.generatedAt);
  assert.equal(empty.capabilities.supports_resume, false);

  node.heldChunks.add(scenario.manifest.chunks[0].chunk_id);
  const held = buildPeerSummary(node, scenario, options);
  assert.deepEqual(validate(held, peerSummarySchema), []);
  assert.equal(held.datasets[0].chunks.length, 1);
  assert.ok(held.capabilities.max_chunk_bytes >= held.datasets[0].chunks[0].size_bytes);
  assert.deepEqual(held.capabilities.transfer_transports, ['BLE_GATT']);
});

for (const name of ['peer-a-summary-v0.json', 'peer-b-summary-v0.json']) {
  test(`${name} conforms to peer-summary-v0`, () => {
    assert.deepEqual(validate(readJson(`fixtures/${name}`), peerSummarySchema), []);
  });

  test(`${name} is byte-identical to the copy the Android tests read`, () => {
    // Two copies of the same fixture exist so the JVM tests can read one from
    // resources. They have to stay in step or the Kotlin and Node ports of
    // computeDiff are silently being tested against different inputs.
    assert.equal(
      readFileSync(path.join(ROOT, 'fixtures', name), 'utf8'),
      readFileSync(
        path.join(ROOT, 'android/app/src/test/resources/fixtures/peer-sync', name),
        'utf8',
      ),
    );
  });
}

test('a peer summary missing a required top-level field is rejected', () => {
  // Guards the exact shape the Android side used to send.
  const { protocol_version: _p, generated_at: _g, capabilities: _c, ...short } =
    readJson('fixtures/peer-a-summary-v0.json');
  assert.notDeepEqual(validate(short, peerSummarySchema), []);
});

test('advertised transports name only what ADR-001 actually adopted', () => {
  // The fixtures used to advertise NEARBY_CONNECTIONS and WIFI_DIRECT as
  // transfer transports. Both were rejected after real-device testing and
  // their implementations have been deleted, so advertising them is a claim
  // a peer could act on and be wrong about.
  for (const name of ['peer-a-summary-v0.json', 'peer-b-summary-v0.json']) {
    const { capabilities } = readJson(`fixtures/${name}`);
    assert.deepEqual(capabilities.discovery_transports, ['BLE']);
    assert.deepEqual(capabilities.transfer_transports, ['BLE_GATT']);
  }
});

// Device-signed crowd reports (docs/data-contract-v0.md「群眾回報簽章」).
const eventSchema = schemas.get('event-v0.schema.json');
const crowdFixture = readJson('fixtures/crowd-reports-v0.json');
const crowdCase = (name) => crowdFixture.event_cases.find((entry) => entry.name === name).event;

test('a device-signed crowd report conforms to event-v0', () => {
  assert.deepEqual(validate(crowdCase('valid_report'), eventSchema), []);
});

test('event-v0 requires signer_public_key when the signing key is a device key', () => {
  assert.ok(validate(crowdCase('missing_signer_public_key'), eventSchema)
    .some((error) => error.includes('signer_public_key')));
});

test('event-v0 forbids device keys outside crowd.* namespaces', () => {
  assert.ok(validate(crowdCase('device_key_official_namespace'), eventSchema)
    .some((error) => error.includes('namespace')));
});

test('official attestations conform to event-v0', () => {
  for (const attestation of crowdFixture.attestations) {
    assert.deepEqual(validate(attestation, eventSchema), []);
  }
});

test('crowd-reports-v0.json is byte-identical to the copy the Android tests read', () => {
  assert.equal(
    readFileSync(path.join(ROOT, 'fixtures/crowd-reports-v0.json'), 'utf8'),
    readFileSync(path.join(ROOT, 'android/app/src/test/resources/fixtures/crowd-reports-v0.json'), 'utf8'),
  );
});
