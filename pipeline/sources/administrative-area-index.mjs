import { createHash } from 'node:crypto';

import { normalizeAreaCatalog } from './areas.mjs';

function featuresFrom(input, label) {
  if (input?.type !== 'FeatureCollection' || !Array.isArray(input.features)) {
    throw new TypeError(`${label} boundary must be a GeoJSON FeatureCollection`);
  }
  return input.features;
}

function boundsFor(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coordinates) => {
    if (typeof coordinates?.[0] === 'number' && typeof coordinates?.[1] === 'number') {
      bounds[0] = Math.min(bounds[0], coordinates[0]);
      bounds[1] = Math.min(bounds[1], coordinates[1]);
      bounds[2] = Math.max(bounds[2], coordinates[0]);
      bounds[3] = Math.max(bounds[3], coordinates[1]);
      return;
    }
    if (Array.isArray(coordinates)) coordinates.forEach(visit);
  };
  visit(geometry?.coordinates);
  if (bounds.some((value) => !Number.isFinite(value))) {
    throw new TypeError('administrative boundary geometry has no coordinates');
  }
  return bounds;
}

function packTownGeometry(geometry, globalCoordinates) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const coordinateOffset = globalCoordinates.length / 2;
  const ringOffsets = [0];
  const polygonOffsets = [0];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const position of ring) {
        if (!Array.isArray(position) || position.length !== 2) {
          throw new TypeError('administrative boundary coordinates must be EPSG:4326 longitude/latitude pairs');
        }
        globalCoordinates.push(position[0], position[1]);
      }
      ringOffsets.push(globalCoordinates.length / 2 - coordinateOffset);
    }
    polygonOffsets.push(ringOffsets.length - 1);
  }
  return {
    geometry_type: geometry.type,
    coordinate_offset: coordinateOffset,
    ring_offsets: ringOffsets,
    polygon_offsets: polygonOffsets,
  };
}

function canonicalDirectoryAreas(catalog, countyIds) {
  return catalog.areas.map((area) => {
    if (!['county', 'town'].includes(area.level)) {
      throw new TypeError(`unsupported administrative area level: ${area.level}`);
    }
    const isCounty = area.level === 'county';
    const parentAreaId = isCounty ? null : `tw.${area.county_code}`;
    if (!isCounty && !countyIds.has(parentAreaId)) {
      throw new TypeError(`town area ${area.area_id} has unknown county ${parentAreaId}`);
    }
    if (isCounty && !area.county_name) {
      throw new TypeError(`county area ${area.area_id} has no county name`);
    }
    if (!isCounty && (!area.county_name || !area.town_name)) {
      throw new TypeError(`town area ${area.area_id} must have county and town names`);
    }
    return {
      area_id: area.area_id,
      level: area.level,
      parent_area_id: parentAreaId,
      county_name: area.county_name,
      town_name: isCounty ? null : area.town_name,
    };
  });
}

/**
 * Build the metadata-only administrative area directory and the full precision
 * offline polygon index from the official county and town GeoJSON sources.
 */
export function generateAdministrativeAreaAssets({ counties, towns, sourceVersion }) {
  const countyFeatures = featuresFrom(counties, 'county');
  const townFeatures = featuresFrom(towns, 'town');
  const normalized = normalizeAreaCatalog([...countyFeatures, ...townFeatures], {
    source: 'NLSC',
    sourceVersion,
  });
  const countyAreas = normalized.areas.filter((area) => area.level === 'county');
  const townAreas = normalized.areas.filter((area) => area.level === 'town');
  if (countyAreas.length !== countyFeatures.length || townAreas.length !== townFeatures.length) {
    throw new TypeError('county and town GeoJSON features must contain only their matching administrative level');
  }
  const countyIds = new Set(countyAreas.map((area) => area.area_id));
  const directoryAreas = canonicalDirectoryAreas(normalized, countyIds);
  const directoryAreaById = new Map(directoryAreas.map((area) => [area.area_id, area]));
  // Point resolution targets townships; county polygons overlap all of their
  // towns and would duplicate boundary bytes without adding a lookup result.
  // County metadata and parent links remain available in the shared directory.
  const coordinates = [];
  const spatialAreas = townAreas.map((area) => ({
    ...directoryAreaById.get(area.area_id),
    ...packTownGeometry(area.geometry, coordinates),
    bbox: boundsFor(area.geometry),
  }));
  const common = {
    coverage: 'TW',
    target_coordinate_system: 'EPSG:4326',
    source_version: String(sourceVersion),
  };
  return {
    directory: {
      schema_version: 'taiwan-area-directory-v1',
      ...common,
      area_count: directoryAreas.length,
      areas: directoryAreas,
    },
    spatialIndex: {
      schema_version: 'taiwan-area-index-v1',
      ...common,
      area_count: spatialAreas.length,
      coordinate_encoding: 'flat-pairs-v1',
      areas: spatialAreas,
      coordinates,
    },
  };
}

export function administrativeAreaSourceVersion(countyBytes, townBytes) {
  const digest = createHash('sha256')
    .update(countyBytes)
    .update('\0')
    .update(townBytes)
    .digest('hex');
  return `sha256:${digest}`;
}

/**
 * Render the canonical IDs as a small Android source catalog so signed
 * offline warnings can be checked against the same official directory.
 */
export function renderAndroidGovernmentAreaIds(directory) {
  if (directory?.schema_version !== 'taiwan-area-directory-v1' ||
      !Array.isArray(directory.areas) || typeof directory.source_version !== 'string') {
    throw new TypeError('invalid administrative area directory');
  }
  const ids = directory.areas.map((area) => area?.area_id);
  if (ids.some((id) => typeof id !== 'string' || !/^tw\.\d{5}(?:\d{3})?$/.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new TypeError('administrative area directory contains invalid IDs');
  }
  const entries = ids.map((id) => `        ${JSON.stringify(id)},`).join('\n');
  return `package com.resilientgeo.mesh.report

/** Generated from the canonical NLSC administrative area directory. */
internal object GovernmentAreaIds {
    const val SOURCE_VERSION = ${JSON.stringify(directory.source_version)}
    val canonicalIds: Set<String> = setOf(
${entries}
    )
}
`;
}
