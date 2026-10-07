import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSourceIds, getSourceDefinition, SOURCE_REGISTRY } from '../src/source-registry.mjs';

test('maps internal source IDs to the existing government feed IDs', () => {
  const byId = new Map(SOURCE_REGISTRY.map((source) => [source.sourceId, source]));
  assert.equal(byId.get('tdx-road-events').feedId, 'tdx-road');
  assert.equal(byId.get('cwa-weather-warning').feedId, 'cwa-warning');
  assert.equal(byId.get('ncdr-hazard-events').feedId, 'ncdr');
});

test('classifies static sources as layers instead of government feed datasets', () => {
  for (const sourceId of ['taiwan-shelter', 'taiwan-medical', 'osm-taiwan']) {
    const source = getSourceDefinition(sourceId);
    assert.equal(source.kind, 'static');
    assert.equal(source.output.type, 'layer');
    assert.equal(source.feedId, null);
    assert.equal(source.output.layerId, sourceId);
  }
});

test('dynamic sources have the required feed output and schedule metadata', () => {
  for (const source of SOURCE_REGISTRY.filter(({ kind }) => kind === 'dynamic')) {
    assert.match(source.sourceId, /^[a-z][a-z0-9-]+$/u);
    assert.equal(typeof source.feedId, 'string');
    assert.equal(source.output.type, 'government-feed');
    assert.equal(Number.isSafeInteger(source.scheduleMs), true);
    assert.equal(source.scheduleMs > 0, true);
    assert.equal(typeof source.enabledByDefault, 'boolean');
  }
});

test('default server collection keeps disaster sources and response resources only', () => {
  assert.deepEqual(defaultSourceIds(), [
    'cwa-earthquake',
    'cwa-weather-warning',
    'cwa-typhoon-warning',
    'ncdr-hazard-events',
    'taiwan-shelter',
    'taiwan-medical',
  ]);
  assert.equal(getSourceDefinition('tdx-road-events').enabledByDefault, false);
  assert.equal(getSourceDefinition('osm-taiwan').enabledByDefault, false);
});

test('unknown sources are rejected by the registry', () => {
  assert.throws(() => getSourceDefinition('not-a-source'), /Unknown source/u);
});
