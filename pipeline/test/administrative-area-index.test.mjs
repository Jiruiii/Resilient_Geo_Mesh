import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'pipeline', 'cli.mjs');

function unpackGeometry(spatialIndex, area) {
  const coordinates = spatialIndex.coordinates;
  const ringOffsets = area.ring_offsets;
  const polygonOffsets = area.polygon_offsets;
  const rings = ringOffsets.slice(0, -1).map((offset, ringIndex) => {
    const end = ringOffsets[ringIndex + 1];
    const points = [];
    for (let pairIndex = offset; pairIndex < end; pairIndex += 1) {
      const coordinateIndex = (area.coordinate_offset + pairIndex) * 2;
      points.push([coordinates[coordinateIndex], coordinates[coordinateIndex + 1]]);
    }
    return points;
  });
  const polygons = polygonOffsets.slice(0, -1).map((start, polygonIndex) =>
    rings.slice(start, polygonOffsets[polygonIndex + 1]));
  return area.geometry_type === 'Polygon'
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

test('area-index CLI emits canonical directory and full-precision offline polygons', () => {
  const sourceDirectory = path.join(ROOT, 'data', 'boundaries', 'geojson');
  const countyPath = path.join(sourceDirectory, 'county.geojson');
  const townPath = path.join(sourceDirectory, 'town.geojson');
  const countyBytes = readFileSync(countyPath);
  const townBytes = readFileSync(townPath);
  const countyInput = JSON.parse(countyBytes.toString('utf8'));
  const townInput = JSON.parse(townBytes.toString('utf8'));
  const sourceHash = createHash('sha256')
    .update(countyBytes)
    .update('\0')
    .update(townBytes)
    .digest('hex');
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'resilientgeo-area-index-'));
  try {
    const serverDirectoryPath = path.join(tempDir, 'server-area-directory.json');
    const flutterDirectoryPath = path.join(tempDir, 'flutter-area-directory.json');
    const spatialIndexPath = path.join(tempDir, 'spatial-index.json');
    const androidAreaIdsPath = path.join(tempDir, 'GovernmentAreaIds.kt');
    const result = spawnSync(process.execPath, [
      CLI,
      'area-index',
      '--county', countyPath,
      '--town', townPath,
      '--directory-out', serverDirectoryPath,
      '--flutter-directory-out', flutterDirectoryPath,
      '--spatial-out', spatialIndexPath,
      '--android-area-ids-out', androidAreaIdsPath,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const directory = JSON.parse(readFileSync(serverDirectoryPath, 'utf8'));
    const flutterDirectory = JSON.parse(readFileSync(flutterDirectoryPath, 'utf8'));
    const spatialIndex = JSON.parse(readFileSync(spatialIndexPath, 'utf8'));
    const androidAreaIds = readFileSync(androidAreaIdsPath, 'utf8');

    assert.deepEqual(flutterDirectory, directory);
    assert.ok(androidAreaIds.includes(`SOURCE_VERSION = "${directory.source_version}"`));
    assert.deepEqual(
      [...androidAreaIds.matchAll(/^\s+"(tw\.[^"]+)",?$/gm)].map((match) => match[1]),
      directory.areas.map((area) => area.area_id),
    );
    assert.equal(directory.schema_version, 'taiwan-area-directory-v1');
    assert.equal(directory.source_version, `sha256:${sourceHash}`);
    assert.equal(directory.areas.filter((area) => area.level === 'county').length, 22);
    assert.equal(directory.areas.filter((area) => area.level === 'town').length, 368);
    assert.equal(directory.areas.length, 390);
    assert.equal(spatialIndex.schema_version, 'taiwan-area-index-v1');
    assert.equal(spatialIndex.source_version, directory.source_version);
    assert.equal(spatialIndex.area_count, 368);
    assert.deepEqual(
      spatialIndex.areas.map((area) => area.area_id),
      directory.areas.filter((area) => area.level === 'town').map((area) => area.area_id),
    );
    assert.ok(Array.isArray(spatialIndex.coordinates));
    const townAreaId = `tw.${townInput.features[0].properties.TOWNCODE}`;
    const townArea = spatialIndex.areas.find((area) => area.area_id === townAreaId);
    assert.deepEqual(unpackGeometry(spatialIndex, townArea), townInput.features[0].geometry);
    assert.deepEqual(
      {
        area_id: townArea.area_id,
        level: townArea.level,
        parent_area_id: townArea.parent_area_id,
        county_name: townArea.county_name,
        town_name: townArea.town_name,
      },
      directory.areas.find((area) => area.area_id === townAreaId),
    );
    assert.equal(
      townArea.parent_area_id,
      `tw.${townInput.features[0].properties.COUNTYCODE}`,
    );
    assert.equal(
      gzipSync(readFileSync(spatialIndexPath), { level: 9 }).length <= 14_700_000,
      true,
      'compressed town spatial index must fit within 14.7 MB',
    );
    assert.equal('source_record' in townArea, false);
    assert.equal('geometry' in townArea, false);
    assert.equal(townArea.bbox.length, 4);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
