import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBundle } from '../lib/bundle.mjs';
import { generateEd25519KeyPair } from '../lib/crypto.mjs';
import { signEvent, verifyBundle, verifyChunk } from '../lib/contract.mjs';
import { normalizeSource } from '../lib/normalize.mjs';
import { bboxOfEvents, bboxContains } from '../lib/geo.mjs';

const { privateKey, publicKey } = generateEd25519KeyPair();
const KEY_ID = 'test-area-2026';
const NOW = new Date('2026-09-01T08:00:00Z');

function record(overrides) {
  return {
    event_type: 'ROAD_STATUS',
    event_version: 1,
    area_id: 'neihu.xihu',
    theme: 'road',
    geometry: { type: 'Point', coordinates: [121.567, 25.082] },
    severity: 'HIGH',
    issued_at: '2026-09-01T07:00:00Z',
    expires_at: '2026-09-01T11:00:00Z',
    ...overrides,
  };
}

function signedEvents(records, source = 'TDX') {
  const raw = {
    source,
    source_version: '136',
    retrieved_at: '2026-09-01T07:05:00Z',
    records,
  };
  return normalizeSource(raw, { namespace: 'official.tdx', signingKeyId: KEY_ID })
    .map((event) => signEvent(event, privateKey));
}

function bundleOf(events, targetSizeBytes = 4096) {
  return buildBundle(events, {
    datasetId: 'resilientgeo-demo',
    namespace: 'official',
    datasetVersion: 136,
    source: 'TDX',
    sourceVersion: '136',
    createdAt: '2026-09-01T07:10:05Z',
    expiresAt: '2026-09-01T09:10:00Z',
    signingKeyId: KEY_ID,
    privateKey,
    targetSizeBytes,
  });
}

test('events sharing (area_id, theme) land in one chunk under the size limit', () => {
  const events = signedEvents([
    record({ id: 'a', area_id: 'neihu.xihu', theme: 'road' }),
    record({ id: 'b', area_id: 'neihu.xihu', theme: 'road', geometry: { type: 'Point', coordinates: [121.57, 25.083] } }),
    record({ id: 'c', area_id: 'neihu.donghu', theme: 'shelter', event_type: 'SHELTER_STATUS', geometry: { type: 'Point', coordinates: [121.616, 25.069] } }),
  ]);
  const bundle = bundleOf(events);
  const xihuRoad = bundle.chunks.filter((chunk) => chunk.area_id === 'neihu.xihu' && chunk.theme === 'road');
  assert.equal(xihuRoad.length, 1);
  assert.equal(xihuRoad[0].event_count, 2);
  assert.equal(bundle.chunks.length, 2);
  assert.match(xihuRoad[0].chunk_id, /:xihu:road:000$/);
});

test('a multi-area dataset produces more than one chunk', () => {
  const events = signedEvents(
    ['xihu', 'tech-park', 'wende', 'donghu', 'dahu'].flatMap((area, index) => [
      record({ id: `${area}-r`, area_id: `neihu.${area}`, theme: 'road', geometry: { type: 'Point', coordinates: [121.56 + index * 0.01, 25.07 + index * 0.005] } }),
      record({ id: `${area}-s`, area_id: `neihu.${area}`, theme: 'shelter', event_type: 'SHELTER_STATUS', geometry: { type: 'Point', coordinates: [121.561 + index * 0.01, 25.071 + index * 0.005] } }),
    ]),
  );
  const bundle = bundleOf(events);
  assert.ok(bundle.chunks.length > 1, `expected multiple chunks, got ${bundle.chunks.length}`);
  const verification = verifyBundle(bundle, publicKey, { trustedKeyIds: [KEY_ID], now: NOW });
  assert.equal(verification.valid, true);
});

test('every chunk bbox covers all of its event geometry', () => {
  const events = signedEvents([
    record({ id: 'a', geometry: { type: 'Point', coordinates: [121.560, 25.080] } }),
    record({ id: 'b', geometry: { type: 'LineString', coordinates: [[121.565, 25.082], [121.572, 25.086]] } }),
    record({ id: 'c', geometry: { type: 'Point', coordinates: [121.558, 25.079] } }),
  ]);
  const bundle = bundleOf(events);
  for (const chunk of bundle.chunks) {
    assert.deepEqual(chunk.bbox, bboxOfEvents(chunk.events));
    for (const event of chunk.events) {
      assert.ok(bboxContains(chunk.bbox, bboxOfEvents([event])));
    }
  }
});

test('tampering a chunk area_id is caught against the signed manifest', () => {
  const bundle = bundleOf(signedEvents([record({ id: 'a' }), record({ id: 'b' })]));
  const tampered = structuredClone(bundle.chunks[0]);
  tampered.area_id = 'neihu.donghu';
  const result = verifyChunk(tampered, bundle.manifest, publicKey, { trustedKeyIds: [KEY_ID], now: NOW });
  // The manifest entry pins area_id, so the change is rejected before hashing.
  assert.equal(result.valid, false);
  assert.equal(result.stage, 'manifest');
  assert.deepEqual(result.errors, ['chunk_metadata_mismatch']);
});

test('tampering a chunk bbox is caught as a bbox mismatch', () => {
  const bundle = bundleOf(signedEvents([record({ id: 'a' }), record({ id: 'b' })]));
  const tampered = structuredClone(bundle.chunks[0]);
  tampered.bbox = [0, 0, 1, 1];
  const result = verifyChunk(tampered, bundle.manifest, publicKey, { trustedKeyIds: [KEY_ID], now: NOW });
  assert.equal(result.valid, false);
  assert.equal(result.stage, 'integrity');
  assert.deepEqual(result.errors, ['chunk_bbox_mismatch']);
});

test('normalizeSource derives an event_id prefix per theme across sources', () => {
  const [road] = signedEvents([record({ id: '7', theme: 'road', event_type: 'ROAD_STATUS' })], 'TDX');
  const [shelter] = signedEvents(
    [record({ id: '7', theme: 'shelter', event_type: 'SHELTER_STATUS' })],
    'FIRE_AGENCY',
  );
  const [flood] = signedEvents(
    [record({ id: '7', theme: 'flood', event_type: 'FLOOD_WARNING' })],
    'CWA',
  );
  assert.equal(road.event_id, 'road:7');
  assert.equal(shelter.event_id, 'shelter:7');
  assert.equal(flood.event_id, 'flood:7');
  assert.equal(shelter.source, 'FIRE_AGENCY');
  assert.equal(flood.source, 'CWA');
});
