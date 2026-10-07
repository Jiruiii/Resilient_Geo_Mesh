import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'pipeline', 'cli.mjs');
function rawCwaEarthquake() {
  return {
    schema_version: 'raw-snapshot-v0',
    source_id: 'cwa-earthquake',
    request: {
      method: 'GET',
      url: 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001?format=JSON',
      query: { format: 'JSON' },
    },
    response: { status: 200, headers: { etag: '"fixture-cwa-1"' } },
    retrieved_at: '2026-09-04T04:00:00Z',
    payload: {
      result: {
        records: [{
          EarthquakeNo: '115001',
          OriginTime: '2026-09-04T12:01:00+08:00',
          EndTime: '2026-09-05T12:05:00+08:00',
          StationID: 'NEIHU-001',
          StationLatitude: '25.0800',
          StationLongitude: '121.5800',
          CountyName: '臺北市',
        }],
      },
    },
  };
}

test('CLI normalizes a CWA Raw snapshot without live credentials', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-cli-'));
  try {
    const input = path.join(tempDir, 'cwa.raw.json');
    const output = path.join(tempDir, 'cwa.events.json');
    writeFileSync(input, `${JSON.stringify(rawCwaEarthquake())}\n`, 'utf8');
    const result = spawnSync(process.execPath, [
      CLI,
      'normalize',
      '--source', 'cwa-earthquake',
      '--input', input,
      '--out', output,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const eventBatch = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(eventBatch.source_id, 'cwa-earthquake');
    assert.equal(eventBatch.event_count, 1);
    assert.equal(eventBatch.events[0].attributes.area_id, 'neihu');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI normalizes a Taiwan-scoped Raw snapshot with an AreaCatalog boundary', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-cli-'));
  try {
    const input = path.join(tempDir, 'cwa.raw.json');
    const boundary = path.join(tempDir, 'taiwan-area-catalog.json');
    const output = path.join(tempDir, 'cwa.events.json');
    writeFileSync(input, `${JSON.stringify({
      ...rawCwaEarthquake(),
      payload: {
        result: {
          records: [{
            EarthquakeNo: '115002',
            OriginTime: '2026-09-04T13:01:00+08:00',
            EndTime: '2026-09-05T13:05:00+08:00',
            StationID: 'HUALIEN-001',
            StationLatitude: '24.02',
            StationLongitude: '121.61',
            CountyName: '花蓮縣',
          }],
        },
      },
    })}\n`, 'utf8');
    writeFileSync(boundary, `${JSON.stringify({
      schema_version: 'area-catalog-v0',
      coverage: 'TW',
      areas: [{
        area_id: 'tw.10015010',
        level: 'town',
        county_code: '10015',
        county_name: '花蓮縣',
        town_code: '10015010',
        town_name: '花蓮市',
        geometry: {
          type: 'Polygon',
          coordinates: [[[121.55, 23.90], [121.70, 23.90], [121.70, 24.10], [121.55, 24.10], [121.55, 23.90]]],
        },
      }],
    })}\n`, 'utf8');
    const result = spawnSync(process.execPath, [
      CLI,
      'normalize',
      '--scope', 'taiwan',
      '--boundary', boundary,
      '--source', 'cwa-earthquake',
      '--input', input,
      '--out', output,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const eventBatch = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(eventBatch.event_count, 1);
    assert.equal(eventBatch.events[0].attributes.area_id, 'tw.10015010');
    assert.equal(eventBatch.events[0].attributes.county_code, '10015');
    assert.equal(eventBatch.events[0].attributes.town_code, '10015010');
    assert.equal(eventBatch.events[0].attributes.coverage, 'TW');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI creates an AreaCatalog from official-boundary-shaped GeoJSON', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-cli-'));
  try {
    const input = path.join(tempDir, 'towns.geojson');
    const output = path.join(tempDir, 'area-catalog.json');
    writeFileSync(input, `${JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { COUNTYCODE: '63000', COUNTYNAME: '臺北市', TOWNCODE: '63000010', TOWNNAME: '內湖區' },
        geometry: { type: 'Polygon', coordinates: [[[121.50, 25.00], [121.65, 25.00], [121.65, 25.15], [121.50, 25.15], [121.50, 25.00]]] },
      }],
    })}\n`, 'utf8');
    const result = spawnSync(process.execPath, [
      CLI, 'area-catalog', '--input', input, '--out', output,
      '--source', 'NLSC', '--source-version', 'test-1', '--retrieved-at', '2026-09-25T00:00:00Z',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(catalog.schema_version, 'area-catalog-v0');
    assert.equal(catalog.areas[0].area_id, 'tw.63000010');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI exports normalized nationwide features for the Flutter map', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-cli-'));
  try {
    const input = path.join(tempDir, 'features.json');
    const output = path.join(tempDir, 'static-features.json');
    writeFileSync(input, `${JSON.stringify({
      schema_version: 'static-normalized-v0',
      features: [{
        schema_version: 'feature-v0', namespace: 'official.test', dataset_id: 'resilientgeo-taiwan',
        layer_id: 'shelter', feature_id: 'shelter:hl-1', feature_type: 'SHELTER',
        geometry: { type: 'Point', coordinates: [121.61, 24.02] },
        properties: { name: '花蓮避難所', area_id: 'tw.10015010', source_record: { secret: 'drop' } },
        source: 'taiwan-shelter', source_version: 'test-1',
        issued_at: '2026-09-25T00:00:00Z', expires_at: '2026-10-25T00:00:00Z',
      }],
    })}\n`, 'utf8');
    const result = spawnSync(process.execPath, [
      CLI, 'export-map', '--input', input, '--out', output,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const mapData = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(mapData.coverage, 'TW');
    assert.equal(mapData.features[0].kind, 'shelter');
    assert.equal('source_record' in mapData.features[0], false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI records a blocked source status when CWA credentials are missing', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-cli-'));
  try {
    const env = { ...process.env };
    delete env.CWA_API_KEY;
    const result = spawnSync(process.execPath, [
      CLI,
      'collect',
      '--source', 'cwa-earthquake',
      '--out-dir', tempDir,
    ], { cwd: ROOT, env, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    const metadata = JSON.parse(readFileSync(path.join(tempDir, 'collection-metadata.json'), 'utf8'));
    assert.equal(metadata.source_id, 'cwa-earthquake');
    assert.equal(metadata.source_status, 'blocked_by_auth');
    assert.equal(metadata.error_code, 'CWA_CREDENTIALS_MISSING');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI builds and verifies a signed bundle from a CWA Raw snapshot', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-cli-'));
  try {
    const input = path.join(tempDir, 'cwa.raw.json');
    const keysDir = path.join(tempDir, 'keys');
    const bundleDir = path.join(tempDir, 'bundle');
    writeFileSync(input, `${JSON.stringify(rawCwaEarthquake())}\n`, 'utf8');

    const keygen = spawnSync(process.execPath, [
      CLI,
      'keygen',
      '--out-dir', keysDir,
      '--key-id', 'cli-cwa-2026',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(keygen.status, 0, keygen.stderr);
    const keyMetadata = JSON.parse(readFileSync(path.join(keysDir, 'key-metadata.json'), 'utf8'));
    assert.match(keyMetadata.public_key_spki_base64, /^[A-Za-z0-9+/]+={0,2}$/u);

    const build = spawnSync(process.execPath, [
      CLI,
      'build',
      '--input', input,
      '--out-dir', bundleDir,
      '--private-key', path.join(keysDir, 'private-key.pem'),
      '--key-id', 'cli-cwa-2026',
      '--dataset-id', 'neihu-cwa-demo',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);

    const verify = spawnSync(process.execPath, [
      CLI,
      'verify',
      '--manifest', path.join(bundleDir, 'manifest.json'),
      '--chunks-dir', path.join(bundleDir, 'chunks'),
      '--public-key', path.join(keysDir, 'public-key.pem'),
      '--now', '2026-09-04T04:02:00Z',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).valid, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI normalizes and builds a signed static shelter layer', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-cli-'));
  try {
    const input = path.join(tempDir, 'shelter.raw.json');
    const normalized = path.join(tempDir, 'shelter.features.json');
    const keysDir = path.join(tempDir, 'keys');
    const bundleDir = path.join(tempDir, 'bundle');
    writeFileSync(input, `${JSON.stringify({
      schema_version: 'raw-snapshot-v0',
      source_id: 'taipei-shelter',
      request: { method: 'GET', url: 'https://example.gov.tw/shelters.csv', query: {} },
      response: { status: 200, headers: { etag: '"fixture-shelter-1"' } },
      retrieved_at: '2026-09-04T04:00:00Z',
      payload: {
        records: [{
          序號: 'S001',
          縣市及鄉鎮市區: '臺北市內湖區',
          避難收容處所地址: '內湖路一段1號',
          經度: '121.58',
          緯度: '25.08',
          避難收容處所名稱: '內湖國小',
          預計收容人數: '300',
          適用災害類別: '地震',
          開設狀態: 'OPEN',
        }],
      },
    })}\n`, 'utf8');

    const normalize = spawnSync(process.execPath, [
      CLI, 'normalize', '--source', 'taipei-shelter', '--input', input, '--out', normalized,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(normalize.status, 0, normalize.stderr);
    const normalizedBatch = JSON.parse(readFileSync(normalized, 'utf8'));
    assert.equal(normalizedBatch.schema_version, 'static-normalized-v0');
    assert.equal(normalizedBatch.feature_count, 1);
    assert.equal(normalizedBatch.status_event_count, 0);

    const keygen = spawnSync(process.execPath, [
      CLI, 'keygen', '--out-dir', keysDir, '--key-id', 'cli-static-2026',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(keygen.status, 0, keygen.stderr);

    const build = spawnSync(process.execPath, [
      CLI, 'build-layer', '--input', normalized, '--out-dir', bundleDir,
      '--private-key', path.join(keysDir, 'private-key.pem'), '--key-id', 'cli-static-2026',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);

    const verify = spawnSync(process.execPath, [
      CLI, 'verify-layer', '--manifest', path.join(bundleDir, 'manifest.json'),
      '--chunks-dir', path.join(bundleDir, 'chunks'),
      '--public-key', path.join(keysDir, 'public-key.pem'), '--now', '2026-09-04T04:02:00Z',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).valid, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
