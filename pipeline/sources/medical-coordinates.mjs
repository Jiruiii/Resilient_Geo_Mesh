import { requestJson } from '../lib/source.mjs';
import { isInsideBoundary, fieldText, firstValue, recordsFromPayload } from '../lib/feature-source.mjs';
import { normalizeCoordinate } from '../lib/geo.mjs';

export const DEFAULT_MEDICAL_COORDINATE_ENDPOINT = 'https://api.nlsc.gov.tw/other/MarkBufferAnlys/med';
export const DEFAULT_MEDICAL_COORDINATE_RADIUS_METERS = 25000;
export const DEFAULT_MEDICAL_COORDINATE_SPACING_METERS = 30000;
export const DEFAULT_MEDICAL_COORDINATE_MAX_QUERIES = 500;
export const DEFAULT_MEDICAL_COORDINATE_CONCURRENCY = 4;

export class MedicalCoordinateSourceError extends Error {
  constructor(message, { code = 'MEDICAL_COORDINATE_SOURCE_ERROR', status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MedicalCoordinateSourceError';
    this.code = code;
    this.status = status;
  }
}

function number(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new MedicalCoordinateSourceError(`${name} must be finite`, { code: 'MEDICAL_COORDINATE_VALUE_INVALID' });
  return result;
}

function positiveNumber(value, name, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isFinite(result) || result <= 0) {
    throw new MedicalCoordinateSourceError(`${name} must be positive`, { code: 'MEDICAL_COORDINATE_QUERY_INVALID' });
  }
  return result;
}

function positiveInteger(value, name, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new MedicalCoordinateSourceError(`${name} must be a positive integer`, { code: 'MEDICAL_COORDINATE_QUERY_INVALID' });
  }
  return result;
}

function visitCoordinatePairs(value, visit) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    visit(value[0], value[1]);
    return;
  }
  for (const child of value) visitCoordinatePairs(child, visit);
}

function coordinateSummary(value) {
  let count = 0;
  let minLongitude = Infinity;
  let maxLongitude = -Infinity;
  let minLatitude = Infinity;
  let maxLatitude = -Infinity;
  let longitudeSum = 0;
  let latitudeSum = 0;
  let first;
  visitCoordinatePairs(value, (longitude, latitude) => {
    count += 1;
    minLongitude = Math.min(minLongitude, longitude);
    maxLongitude = Math.max(maxLongitude, longitude);
    minLatitude = Math.min(minLatitude, latitude);
    maxLatitude = Math.max(maxLatitude, latitude);
    longitudeSum += longitude;
    latitudeSum += latitude;
    first ??= [longitude, latitude];
  });
  return count === 0
    ? null
    : {
      count,
      minLongitude,
      maxLongitude,
      minLatitude,
      maxLatitude,
      meanLongitude: longitudeSum / count,
      meanLatitude: latitudeSum / count,
      first,
    };
}

function boundaryBbox(boundary) {
  let summary;
  function merge(next) {
    if (!next) return;
    if (!summary) {
      summary = { ...next };
      return;
    }
    summary.count += next.count;
    summary.minLongitude = Math.min(summary.minLongitude, next.minLongitude);
    summary.maxLongitude = Math.max(summary.maxLongitude, next.maxLongitude);
    summary.minLatitude = Math.min(summary.minLatitude, next.minLatitude);
    summary.maxLatitude = Math.max(summary.maxLatitude, next.maxLatitude);
  }
  if (boundary?.type === 'FeatureCollection') {
    for (const feature of boundary.features ?? []) merge(coordinateSummary(feature.geometry?.coordinates));
  } else if (boundary?.type === 'Feature') {
    merge(coordinateSummary(boundary.geometry?.coordinates));
  } else {
    merge(coordinateSummary(boundary?.coordinates));
  }
  if (!summary) {
    throw new MedicalCoordinateSourceError('medical coordinate query boundary has no coordinates', {
      code: 'MEDICAL_COORDINATE_BOUNDARY_INVALID',
    });
  }
  return summary;
}

function representativeTownPoint(feature) {
  const summary = coordinateSummary(feature.geometry?.coordinates);
  if (!summary) {
    throw new MedicalCoordinateSourceError('medical town boundary has no coordinates', {
      code: 'MEDICAL_COORDINATE_BOUNDARY_INVALID',
    });
  }
  const candidates = [
    [
      (summary.minLongitude + summary.maxLongitude) / 2,
      (summary.minLatitude + summary.maxLatitude) / 2,
    ],
    [summary.meanLongitude, summary.meanLatitude],
    summary.first,
  ];
  for (const coordinates of candidates) {
    const longitude = coordinates[0];
    const latitude = coordinates[1];
    if (isInsideBoundary({ type: 'Point', coordinates: [longitude, latitude] }, feature, MedicalCoordinateSourceError)) {
      return { longitude, latitude };
    }
  }
  throw new MedicalCoordinateSourceError('medical town boundary has no representative point', {
    code: 'MEDICAL_COORDINATE_BOUNDARY_INVALID',
  });
}

function roundCoordinate(value) {
  return Number(value.toFixed(6));
}

function queryPoint(value) {
  const longitude = number(value?.longitude ?? value?.lon ?? value?.lng ?? value?.x, 'longitude');
  const latitude = number(value?.latitude ?? value?.lat ?? value?.y, 'latitude');
  try {
    const [normalizedLongitude, normalizedLatitude] = normalizeCoordinate([longitude, latitude]);
    return { longitude: normalizedLongitude, latitude: normalizedLatitude };
  } catch (error) {
    throw new MedicalCoordinateSourceError(`medical coordinate query point is invalid: ${error.message}`, {
      code: 'MEDICAL_COORDINATE_QUERY_INVALID',
      cause: error,
    });
  }
}

export function buildMedicalCoordinateQueryPlan(boundary, {
  queryPoints,
  radiusMeters = DEFAULT_MEDICAL_COORDINATE_RADIUS_METERS,
  spacingMeters = DEFAULT_MEDICAL_COORDINATE_SPACING_METERS,
  maxQueries = DEFAULT_MEDICAL_COORDINATE_MAX_QUERIES,
} = {}) {
  const radius = positiveNumber(radiusMeters, 'radiusMeters', DEFAULT_MEDICAL_COORDINATE_RADIUS_METERS);
  const spacing = positiveNumber(spacingMeters, 'spacingMeters', DEFAULT_MEDICAL_COORDINATE_SPACING_METERS);
  const maximum = positiveInteger(maxQueries, 'maxQueries', DEFAULT_MEDICAL_COORDINATE_MAX_QUERIES);
  if (Array.isArray(queryPoints) && queryPoints.length > 0) {
    const points = queryPoints.map(queryPoint);
    if (points.length > maximum) throw new MedicalCoordinateSourceError('medical coordinate query plan exceeds maxQueries', { code: 'MEDICAL_COORDINATE_QUERY_TOO_LARGE' });
    return points;
  }

  const townFeatures = boundary?.type === 'FeatureCollection'
    ? (boundary.features ?? []).filter((feature) => feature.properties?.level === 'town')
    : [];
  if (townFeatures.length > 0) {
    const unique = new Map();
    for (const feature of townFeatures) {
      const point = representativeTownPoint(feature);
      unique.set(`${point.longitude},${point.latitude}`, point);
    }
    const points = [...unique.values()].sort((left, right) => (
      left.latitude - right.latitude || left.longitude - right.longitude
    ));
    if (points.length > maximum) {
      throw new MedicalCoordinateSourceError('medical coordinate query plan exceeds maxQueries', {
        code: 'MEDICAL_COORDINATE_QUERY_TOO_LARGE',
      });
    }
    return points;
  }

  const bbox = boundaryBbox(boundary);
  const midLatitude = (bbox.minLatitude + bbox.maxLatitude) / 2;
  const latitudeStep = spacing / 111_320;
  const longitudeStep = spacing / (111_320 * Math.max(0.1, Math.cos(midLatitude * Math.PI / 180)));
  const points = [];
  for (let latitude = bbox.minLatitude; latitude <= bbox.maxLatitude + latitudeStep / 2; latitude += latitudeStep) {
    for (let longitude = bbox.minLongitude; longitude <= bbox.maxLongitude + longitudeStep / 2; longitude += longitudeStep) {
      points.push({ longitude: roundCoordinate(longitude), latitude: roundCoordinate(latitude) });
      if (points.length > maximum) {
        throw new MedicalCoordinateSourceError('medical coordinate query plan exceeds maxQueries', {
          code: 'MEDICAL_COORDINATE_QUERY_TOO_LARGE',
        });
      }
    }
  }
  return points;
}

function recordList(payload) {
  if (payload?.type === 'FeatureCollection' && Array.isArray(payload.features)) return payload.features;
  if (payload?.type === 'Feature') return [payload];
  if (Array.isArray(payload)) return payload;
  return recordsFromPayload(payload, ['records', 'results', 'data', 'items', 'features', 'result', 'resource']);
}

function recordGeometry(record) {
  if (record?.type === 'Feature' && record.geometry?.type === 'Point') return normalizePointGeometry(record.geometry);
  if (record?.geometry?.type === 'Point') return normalizePointGeometry(record.geometry);
  if (record?.type === 'Point' && Array.isArray(record.coordinates)) return normalizePointGeometry(record);
  const source = record?.properties && typeof record.properties === 'object' ? record.properties : record;
  const longitude = firstValue(
    source?.經度, source?.Longitude, source?.longitude, source?.lon, source?.lng,
    source?.X, source?.x, source?.['X坐標'], source?.['X座標'], source?.['經度(WGS84)'],
  );
  const latitude = firstValue(
    source?.緯度, source?.Latitude, source?.latitude, source?.lat,
    source?.Y, source?.y, source?.['Y坐標'], source?.['Y座標'], source?.['緯度(WGS84)'],
  );
  if (longitude === undefined || latitude === undefined) return undefined;
  try {
    return { type: 'Point', coordinates: normalizeCoordinate([Number(longitude), Number(latitude)]) };
  } catch (error) {
    throw new MedicalCoordinateSourceError('official medical coordinate is invalid', {
      code: 'MEDICAL_COORDINATE_VALUE_INVALID',
      cause: error,
    });
  }
}

function normalizePointGeometry(geometry) {
  try {
    return { type: 'Point', coordinates: normalizeCoordinate(geometry.coordinates) };
  } catch (error) {
    throw new MedicalCoordinateSourceError('official medical coordinate is invalid', {
      code: 'MEDICAL_COORDINATE_VALUE_INVALID',
      cause: error,
    });
  }
}

function recordProperties(record) {
  return record?.type === 'Feature' && record.properties && typeof record.properties === 'object'
    ? record.properties
    : record;
}

function coordinateRecordValue(record, names) {
  const properties = recordProperties(record);
  return firstValue(...names.map((name) => properties?.[name]));
}

function sourceVersionFor(responseHeaders, fallback) {
  return String(firstValue(responseHeaders?.etag, responseHeaders?.last_modified, fallback));
}

export function normalizeMedicalCoordinateFeatures(payload, {
  boundary,
  sourceId = 'official-medical-coordinate',
  sourceVersion = new Date().toISOString(),
} = {}) {
  if (!boundary) throw new MedicalCoordinateSourceError('medical coordinate boundary is required', { code: 'MEDICAL_COORDINATE_BOUNDARY_MISSING' });
  const features = [];
  let rejectedCoordinateCount = 0;
  for (const [index, record] of recordList(payload).entries()) {
    const geometry = recordGeometry(record);
    if (!geometry) continue;
    if (!isInsideBoundary(geometry, boundary, MedicalCoordinateSourceError)) {
      rejectedCoordinateCount += 1;
      continue;
    }
    const properties = recordProperties(record) ?? {};
    const institutionCode = coordinateRecordValue(record, [
      '機構代碼', '醫療機構代碼', '院所代碼', '醫事機構代碼', 'facility_code', 'institution_code', 'medical_id', 'id', 'ID',
    ]);
    const name = coordinateRecordValue(record, [
      '設施名稱', '醫療設施名稱', '機構名稱', '醫療機構名稱', '院所名稱', '醫事機構名稱', '名稱', 'facility_name', 'name',
    ]);
    const address = coordinateRecordValue(record, [
      '門牌', '門牌地址', '地址', '機構地址', '醫療機構地址', 'facility_address', 'address', 'addr', 'Address',
    ]);
    const rawIdentity = `${institutionCode ?? `${name ?? ''}:${address ?? ''}`}:${geometry.coordinates.join(',')}`;
    features.push({
      type: 'Feature',
      geometry,
      properties: {
        institution_code: institutionCode === undefined ? null : String(institutionCode).trim(),
        name: name === undefined ? null : String(name).trim(),
        address: address === undefined ? null : String(address).trim(),
        coordinate_source: sourceId,
        coordinate_source_version: String(sourceVersion),
        source_record: record,
      },
      feature_id: `medical-coordinate:${String(rawIdentity).trim().toLowerCase()}:${index}`,
    });
  }
  return {
    features: deduplicateCoordinateFeatures(features),
    rejected_coordinate_count: rejectedCoordinateCount,
  };
}

function comparable(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/gu, '').replaceAll('台', '臺');
}

function coordinateIdentity(feature) {
  const properties = feature.properties ?? {};
  const [longitude, latitude] = feature.geometry?.coordinates ?? [];
  return [
    comparable(properties.institution_code),
    comparable(properties.name),
    comparable(properties.address),
    Number(longitude).toFixed(6),
    Number(latitude).toFixed(6),
  ].join('|');
}

function deduplicateCoordinateFeatures(features) {
  const unique = new Map();
  for (const feature of features) unique.set(coordinateIdentity(feature), feature);
  return [...unique.values()].sort((left, right) => left.feature_id.localeCompare(right.feature_id));
}

function endpointForPoint(endpoint, point, radiusMeters) {
  const base = String(endpoint).replace(/\/+$/u, '');
  return `${base}/${point.longitude}/${point.latitude}/${radiusMeters}`;
}

async function fetchOneNlscQuery({ endpoint, point, radiusMeters, boundary, fetchImpl, retrievedAt, timeoutMs }) {
  const response = await requestJson(endpointForPoint(endpoint, point, radiusMeters), {
    fetchImpl,
    timeoutMs,
    maxAttempts: 2,
  });
  const normalized = normalizeMedicalCoordinateFeatures(response.payload, {
    boundary,
    sourceId: 'nlsc-medical-coordinates',
    sourceVersion: sourceVersionFor(response.headers, retrievedAt),
  });
  return { ...normalized, response };
}

function safeQueryErrorCode(error) {
  const code = String(error?.code ?? 'MEDICAL_COORDINATE_QUERY_FAILED');
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'MEDICAL_COORDINATE_QUERY_FAILED';
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

async function fetchFallbackEndpoint({ endpoint, boundary, fetchImpl, retrievedAt, timeoutMs, sourceId }) {
  const response = await requestJson(endpoint, { fetchImpl, timeoutMs, maxAttempts: 2 });
  const normalized = normalizeMedicalCoordinateFeatures(response.payload, {
    boundary,
    sourceId,
    sourceVersion: sourceVersionFor(response.headers, retrievedAt),
  });
  return { ...normalized, response };
}

export async function fetchOfficialMedicalCoordinates({
  endpoint = DEFAULT_MEDICAL_COORDINATE_ENDPOINT,
  fallbackEndpoints = [],
  queryPoints,
  radiusMeters = DEFAULT_MEDICAL_COORDINATE_RADIUS_METERS,
  spacingMeters = DEFAULT_MEDICAL_COORDINATE_SPACING_METERS,
  maxQueries = DEFAULT_MEDICAL_COORDINATE_MAX_QUERIES,
  concurrency = DEFAULT_MEDICAL_COORDINATE_CONCURRENCY,
  boundary,
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const plan = buildMedicalCoordinateQueryPlan(boundary, {
    queryPoints,
    radiusMeters,
    spacingMeters,
    maxQueries,
  });
  const workerCount = positiveInteger(concurrency, 'concurrency', DEFAULT_MEDICAL_COORDINATE_CONCURRENCY);
  const primaryResults = await mapWithConcurrency(plan, workerCount, async (point) => {
    try {
      return {
        ok: true,
        result: await fetchOneNlscQuery({
          endpoint,
          point,
          radiusMeters,
          boundary,
          fetchImpl,
          retrievedAt,
          timeoutMs,
        }),
      };
    } catch (error) {
      return { ok: false, errorCode: safeQueryErrorCode(error) };
    }
  });
  const primary = primaryResults.filter((result) => result.ok).map((result) => result.result);
  const failedQueryErrorCounts = {};
  for (const result of primaryResults.filter((item) => !item.ok)) {
    failedQueryErrorCounts[result.errorCode] = (failedQueryErrorCounts[result.errorCode] ?? 0) + 1;
  }
  const sourceResults = [{
    sourceId: 'nlsc-medical-coordinates',
    features: primary.flatMap((result) => result.features),
    rejectedCoordinateCount: primary.reduce((sum, result) => sum + result.rejected_coordinate_count, 0),
  }];
  let failedFallbackSourceCount = 0;
  for (const [index, fallbackEndpoint] of (fallbackEndpoints ?? []).filter(Boolean).entries()) {
    const sourceId = `official-medical-fallback-${index + 1}`;
    let fallback;
    try {
      fallback = await fetchFallbackEndpoint({
        endpoint: fallbackEndpoint,
        boundary,
        fetchImpl,
        retrievedAt,
        timeoutMs,
        sourceId,
      });
    } catch {
      failedFallbackSourceCount += 1;
      continue;
    }
    sourceResults.push({
      sourceId,
      features: fallback.features,
      rejectedCoordinateCount: fallback.rejected_coordinate_count,
    });
  }
  const features = deduplicateCoordinateFeatures(sourceResults.flatMap((result) => result.features));
  return {
    features,
    source_ids: sourceResults.map((result) => result.sourceId),
    query_count: plan.length,
    successful_query_count: primary.length,
    failed_query_count: plan.length - primary.length,
    failed_query_error_counts: failedQueryErrorCounts,
    failed_fallback_source_count: failedFallbackSourceCount,
    rejected_coordinate_count: sourceResults.reduce((sum, result) => sum + result.rejectedCoordinateCount, 0),
  };
}
