import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportMapData } from '../lib/map-export.mjs';

const ISSUED_AT = '2026-09-25T00:00:00Z';
const EXPIRES_AT = '2026-10-25T00:00:00Z';

function feature({ layerId, featureId, featureType, geometry, properties, source }) {
  return {
    schema_version: 'feature-v0',
    namespace: 'official.test',
    dataset_id: 'resilientgeo-taiwan',
    layer_id: layerId,
    feature_id: featureId,
    feature_type: featureType,
    geometry,
    properties,
    source,
    source_version: 'test-1',
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
  };
}

test('exports nationwide feature-v0 records to the Flutter map shape without Raw payloads', () => {
  const output = exportMapData([
    feature({
      layerId: 'shelter',
      featureId: 'shelter:hl-1',
      featureType: 'SHELTER',
      source: 'taiwan-shelter',
      geometry: { type: 'Point', coordinates: [121.61, 24.02] },
      properties: {
        name: '花蓮避難所', address: '花蓮路1號', capacity: 200,
        area_id: 'tw.10015010', coverage: 'TW', source_record: { secret: 'must-drop' },
      },
    }),
    feature({
      layerId: 'taiwan-medical',
      featureId: 'medical:hl-0',
      featureType: 'MEDICAL_FACILITY',
      source: 'taiwan-medical',
      geometry: { type: 'Point', coordinates: [121.63, 24.04] },
      properties: { name: '花蓮一般醫療院所', address: '花蓮路3號', area_id: 'tw.10015010' },
    }),
    feature({
      layerId: 'medical',
      featureId: 'medical:hl-1',
      featureType: 'HOSPITAL',
      source: 'taiwan-medical',
      geometry: { type: 'Point', coordinates: [121.62, 24.03] },
      properties: { name: '花蓮醫院', address: '花蓮路2號', area_id: 'tw.10015010' },
    }),
  ]);

  assert.equal(output.schema_version, 'offline-map-display-v1');
  assert.equal(output.dataset_id, 'resilientgeo-taiwan');
  assert.deepEqual(output.bounds, [121.61, 24.02, 121.63, 24.04]);
  assert.deepEqual(output.features.map((item) => item.kind), ['medical', 'medical', 'shelter']);
  assert.equal(output.features[2].area_id, 'tw.10015010');
  assert.equal(output.features[2].properties, undefined);
  assert.equal(JSON.stringify(output).includes('must-drop'), false);
  assert.deepEqual(output.sources.map((source) => source.source_id), ['taiwan-medical', 'taiwan-shelter']);
});
