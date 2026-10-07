import { isGeometryInBoundary } from '../lib/geo.mjs';

const COUNTY_CODE_FIELDS = ['COUNTYCODE', 'COUNTY_CODE', 'county_code', '縣市代碼', 'COUNTYID'];
const TOWN_CODE_FIELDS = ['TOWNCODE', 'TOWN_CODE', 'town_code', '鄉鎮市區代碼', 'TOWNID'];
const VILLAGE_CODE_FIELDS = ['VILLAGECODE', 'VILLAGE_CODE', 'village_code', '村里代碼'];

const AREA_NAME_FIELDS = [
  'COUNTYNAME', 'COUNTY_NAME', 'county_name', '縣市名稱', '縣市', 'CountyName', 'County', 'county', 'City', 'city',
  'TOWNNAME', 'TOWN_NAME', 'town_name', '鄉鎮市區名稱', '鄉鎮市區', 'TownName', 'Town', 'town',
  'VILLAGENAME', 'VILLAGE_NAME', 'village_name', '村里名稱', '村里', 'VillageName', 'Village', 'village',
  '縣市及鄉鎮市區', '縣市鄉鎮市區', '縣市區名', '行政區', '行政區域', 'AreaDesc', 'area_desc', 'Location', 'location',
];

export class AreaCatalogError extends Error {
  constructor(message, { code = 'AREA_CATALOG_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AreaCatalogError';
    this.code = code;
  }
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function propertyValue(properties, ...names) {
  return firstValue(...names.map((name) => properties?.[name]));
}

function text(value) {
  return value === undefined || value === null ? null : String(value).trim() || null;
}

function normalizeCode(value) {
  const normalized = text(value);
  return normalized ? normalized.replace(/\s+/gu, '') : null;
}

function normalizeName(value) {
  const normalized = text(value);
  return normalized
    ? normalized.replace(/\s+/gu, '').replaceAll('台', '臺')
    : null;
}

function areaLevel(properties, codes) {
  const explicit = normalizeName(propertyValue(properties, 'LEVEL', 'level', '行政區層級', 'area_level'));
  if (explicit) {
    if (/(?:village|村里)/iu.test(explicit)) return 'village';
    if (/(?:town|鄉|鎮|市|區)/iu.test(explicit)) return 'town';
    if (/(?:county|縣|直轄市)/iu.test(explicit)) return 'county';
    return explicit.toLowerCase();
  }
  if (codes.villageCode) return 'village';
  if (codes.townCode) return 'town';
  if (codes.countyCode) return 'county';
  return 'area';
}

function areaId(codes, names) {
  const code = codes.villageCode ?? codes.townCode ?? codes.countyCode;
  if (code) return `tw.${code}`;
  const fallback = [names.countyName, names.townName, names.villageName]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!fallback) throw new AreaCatalogError('administrative area needs a stable code or name', { code: 'AREA_ID_MISSING' });
  return `tw.${fallback}`;
}

function featureList(input) {
  if (Array.isArray(input)) return input;
  if (input?.type === 'FeatureCollection' && Array.isArray(input.features)) return input.features;
  if (input?.type === 'Feature') return [input];
  if (Array.isArray(input?.features)) return input.features;
  throw new AreaCatalogError('administrative boundary input must be a GeoJSON FeatureCollection, Feature, or feature array', {
    code: 'AREA_INPUT_INVALID',
  });
}

function normalizeFeature(feature, index, source) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry) {
    throw new AreaCatalogError(`administrative area ${index} must be a GeoJSON Feature with geometry`, {
      code: 'AREA_FEATURE_INVALID',
    });
  }
  try {
    // The boundary itself is used as the test geometry so the shared GeoJSON
    // validator checks coordinate shape without introducing another validator.
    isGeometryInBoundary(feature.geometry, feature.geometry);
  } catch (error) {
    throw new AreaCatalogError(`administrative area ${index} has invalid geometry: ${error.message}`, {
      code: 'AREA_GEOMETRY_INVALID',
      cause: error,
    });
  }
  if (!['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
    throw new AreaCatalogError(`administrative area ${index} must be a Polygon or MultiPolygon`, {
      code: 'AREA_GEOMETRY_INVALID',
    });
  }
  const properties = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const codes = {
    countyCode: normalizeCode(propertyValue(properties, 'COUNTYCODE', 'COUNTY_CODE', 'county_code', '縣市代碼', 'COUNTYID')),
    townCode: normalizeCode(propertyValue(properties, 'TOWNCODE', 'TOWN_CODE', 'town_code', '鄉鎮市區代碼', 'TOWNID')),
    villageCode: normalizeCode(propertyValue(properties, 'VILLAGECODE', 'VILLAGE_CODE', 'village_code', '村里代碼')),
  };
  const names = {
    countyName: text(propertyValue(properties, 'COUNTYNAME', 'COUNTY_NAME', 'county_name', '縣市名稱', '縣市')),
    townName: text(propertyValue(properties, 'TOWNNAME', 'TOWN_NAME', 'town_name', '鄉鎮市區名稱', '鄉鎮市區')),
    villageName: text(propertyValue(properties, 'VILLAGENAME', 'VILLAGE_NAME', 'village_name', '村里名稱', '村里')),
  };
  return {
    area_id: areaId(codes, names),
    level: areaLevel(properties, codes),
    county_code: codes.countyCode,
    county_name: names.countyName,
    town_code: codes.townCode,
    town_name: names.townName,
    village_code: codes.villageCode,
    village_name: names.villageName,
    geometry: feature.geometry,
    source_record: properties,
    source,
  };
}

export function normalizeAreaCatalog(input, {
  retrievedAt = new Date().toISOString(),
  source = 'NLSC',
  sourceVersion = retrievedAt,
} = {}) {
  const areas = featureList(input)
    .map((feature, index) => normalizeFeature(feature, index, source))
    .sort((left, right) => left.area_id.localeCompare(right.area_id));
  if (areas.length === 0) throw new AreaCatalogError('administrative boundary input contains no features', { code: 'AREA_INPUT_EMPTY' });
  const ids = new Set();
  for (const area of areas) {
    if (ids.has(area.area_id)) throw new AreaCatalogError(`duplicate administrative area id: ${area.area_id}`, { code: 'AREA_ID_DUPLICATE' });
    ids.add(area.area_id);
  }
  return {
    schema_version: 'area-catalog-v0',
    coverage: 'TW',
    target_coordinate_system: 'EPSG:4326',
    source,
    source_version: String(sourceVersion),
    retrieved_at: retrievedAt,
    area_count: areas.length,
    areas,
  };
}

export function areaBoundary(catalog) {
  if (catalog?.schema_version !== 'area-catalog-v0' || !Array.isArray(catalog.areas)) {
    throw new AreaCatalogError('areaBoundary requires an area-catalog-v0 value', { code: 'AREA_CATALOG_INVALID' });
  }
  return {
    type: 'FeatureCollection',
    features: catalog.areas.map((area) => ({
      type: 'Feature',
      properties: {
        area_id: area.area_id,
        level: area.level,
        county_code: area.county_code,
        county_name: area.county_name,
        town_code: area.town_code,
        town_name: area.town_name,
        village_code: area.village_code,
        village_name: area.village_name,
      },
      geometry: area.geometry,
    })),
  };
}

function recordText(record) {
  return AREA_NAME_FIELDS
    .map((field) => record?.[field])
    .filter((value) => value !== undefined && value !== null)
    .map(normalizeName)
    .filter(Boolean)
    .join('|');
}

function levelRank(level) {
  return { area: 0, county: 1, town: 2, village: 3 }[level] ?? 0;
}

function namesForArea(area) {
  return [area.county_name, area.town_name, area.village_name]
    .map(normalizeName)
    .filter(Boolean);
}

function chooseMostSpecific(areas) {
  return [...areas].sort((left, right) => (
    levelRank(right.level) - levelRank(left.level)
    || left.area_id.localeCompare(right.area_id)
  ))[0];
}

function matchArea(catalog, record, geometry) {
  const textValue = recordText(record);
  const codes = {
    county: normalizeCode(propertyValue(record, ...COUNTY_CODE_FIELDS)),
    town: normalizeCode(propertyValue(record, ...TOWN_CODE_FIELDS)),
    village: normalizeCode(propertyValue(record, ...VILLAGE_CODE_FIELDS)),
  };
  for (const [recordLevel, areaField] of [
    ['village', 'village_code'],
    ['town', 'town_code'],
  ]) {
    const code = codes[recordLevel];
    if (!code) continue;
    const codeMatches = catalog.areas.filter((area) => area[areaField] === code);
    if (codeMatches.length > 0) return chooseMostSpecific(codeMatches);
  }

  // A point is the strongest area signal. This also handles CWA/TDX records
  // that carry a city name but have a precise WGS84 point. A polygon fallback
  // is deliberately evaluated after names because a county warning polygon
  // can intersect many town/village boundaries.
  if (geometry?.type === 'Point') {
    const geometryMatches = catalog.areas.filter((area) => (
      (!codes.county || !area.county_code || area.county_code === codes.county)
      && isGeometryInBoundary(geometry, area.geometry)
    ));
    if (geometryMatches.length > 0) return chooseMostSpecific(geometryMatches);
  }

  const nameMatches = catalog.areas
    .map((area) => {
      const matchedNames = namesForArea(area).filter((name) => textValue.includes(name));
      return { area, matchedNames };
    })
    .filter(({ area, matchedNames }) => (
      matchedNames.length > 0 && (!codes.county || !area.county_code || area.county_code === codes.county)
    ))
    .sort((left, right) => (
      right.matchedNames.length - left.matchedNames.length
      || levelRank(right.area.level) - levelRank(left.area.level)
      || left.area.area_id.localeCompare(right.area.area_id)
  ));
  if (nameMatches.length > 0) return nameMatches[0].area;
  if (codes.county) {
    const countyMatches = catalog.areas.filter((area) => (
      area.level === 'county' && area.county_code === codes.county
    ));
    if (countyMatches.length > 0) return chooseMostSpecific(countyMatches);
    const sameCountyAreas = catalog.areas.filter((area) => area.county_code === codes.county);
    if (sameCountyAreas.length === 1) return sameCountyAreas[0];
    return undefined;
  }
  if (!geometry) return undefined;
  return chooseMostSpecific(catalog.areas.filter((area) => isGeometryInBoundary(geometry, area.geometry)));
}

export function createAreaResolvers(catalog) {
  if (catalog?.schema_version !== 'area-catalog-v0' || !Array.isArray(catalog.areas)) {
    throw new AreaCatalogError('createAreaResolvers requires an area-catalog-v0 value', { code: 'AREA_CATALOG_INVALID' });
  }
  return {
    areaResolver(record, geometry) {
      return matchArea(catalog, record, geometry);
    },
    areaIdResolver(record, geometry) {
      return matchArea(catalog, record, geometry)?.area_id;
    },
    boundaryResolver(record, geometry) {
      const area = matchArea(catalog, record, geometry);
      return area
        ? { type: 'Feature', properties: { area_id: area.area_id }, geometry: area.geometry }
        : undefined;
    },
  };
}

/** Return canonical town names keyed by their area-catalog town code. */
export function townNameMapFromAreaCatalog(catalog) {
  if (catalog?.schema_version !== 'area-catalog-v0' || !Array.isArray(catalog.areas)) {
    throw new AreaCatalogError('townNameMapFromAreaCatalog requires an area-catalog-v0 value', {
      code: 'AREA_CATALOG_INVALID',
    });
  }
  return Object.fromEntries(catalog.areas
    .filter((area) => area.level === 'town' && area.town_code && area.town_name)
    .map((area) => [area.town_code, area.town_name]));
}

/**
 * Resolve legacy source town codes from an already-verified official point.
 * A code is restored only when that point falls inside exactly one catalog town.
 */
export function createTownCodeResolver(catalog) {
  if (catalog?.schema_version !== 'area-catalog-v0' || !Array.isArray(catalog.areas)) {
    throw new AreaCatalogError('createTownCodeResolver requires an area-catalog-v0 value', {
      code: 'AREA_CATALOG_INVALID',
    });
  }
  const towns = catalog.areas.filter((area) => area.level === 'town' && area.town_code);
  const canonicalTownCodes = new Set(towns.map((area) => area.town_code));
  const resolvedBySourcePoint = new Map();
  return (sourceTownCode, coordinate, countyCode = null) => {
    const normalizedSourceCode = normalizeCode(sourceTownCode);
    if (normalizedSourceCode && canonicalTownCodes.has(normalizedSourceCode)) {
      const canonical = towns.find((area) => area.town_code === normalizedSourceCode);
      if (!countyCode || canonical?.county_code === countyCode) return normalizedSourceCode;
    }
    if (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isFinite)) return null;
    const cacheKey = normalizedSourceCode
      ? `${countyCode ?? ''}\u0000${normalizedSourceCode}\u0000${coordinate[0]}\u0000${coordinate[1]}`
      : null;
    if (cacheKey && resolvedBySourcePoint.has(cacheKey)) return resolvedBySourcePoint.get(cacheKey);
    const point = { type: 'Point', coordinates: coordinate };
    const matches = new Set(towns
      .filter((area) => !countyCode || area.county_code === countyCode)
      .filter((area) => isGeometryInBoundary(point, area.geometry))
      .map((area) => area.town_code));
    if (matches.size !== 1) return null;
    const [townCode] = matches;
    if (cacheKey) resolvedBySourcePoint.set(cacheKey, townCode);
    return townCode;
  };
}
