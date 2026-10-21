import {
  isGeometryInBoundary,
  normalizeCoordinate,
  representativePointInBoundary,
} from '../lib/geo.mjs';
import { areaMetadataForRecord, boundaryForRecord } from '../lib/coverage.mjs';
import {
  makeRawSnapshot,
  requestJson,
  validateRawSnapshot,
} from '../lib/source.mjs';

export const DEFAULT_CWA_EARTHQUAKE_ENDPOINT = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001';
export const DEFAULT_CWA_WARNING_ENDPOINT = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0033-001';
export const DEFAULT_CWA_TYPHOON_ENDPOINT = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-001';

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export class CwaCredentialError extends Error {
  constructor(message = 'CWA API key is required: set CWA_API_KEY') {
    super(message);
    this.name = 'CwaCredentialError';
    this.code = 'CWA_CREDENTIALS_MISSING';
  }
}

export class CwaSourceError extends Error {
  constructor(message, { code = 'CWA_SOURCE_ERROR', status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CwaSourceError';
    this.code = code;
    this.status = status;
  }
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function textValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    const values = value.map(textValue).filter(Boolean);
    return values.length > 0 ? values.join(' ') : undefined;
  }
  if (typeof value !== 'object') return undefined;
  for (const key of ['value', 'text', 'title', 'headline', 'description', 'section', 'areaDesc']) {
    const normalized = textValue(value[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeId(value, fieldName) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, '-');
  if (!normalized) throw new CwaSourceError(`${fieldName} is required`, { code: 'CWA_EVENT_ID_MISSING' });
  return normalized.slice(0, 240);
}

function normalizeTime(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CwaSourceError(`${fieldName} is required`, { code: 'CWA_TIME_MISSING' });
  }
  const trimmed = value.trim();
  const withTimezone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}+08:00`
    : trimmed;
  if (!RFC3339_RE.test(withTimezone) && !withTimezone.endsWith('+08:00')) {
    throw new CwaSourceError(`${fieldName} must be an RFC 3339 date-time`, { code: 'CWA_TIME_INVALID' });
  }
  const parsed = Date.parse(withTimezone);
  if (Number.isNaN(parsed)) throw new CwaSourceError(`${fieldName} must be an RFC 3339 date-time`, { code: 'CWA_TIME_INVALID' });
  return new Date(parsed).toISOString();
}

function recordsFromPayload(payload, groupedRecordKey) {
  if (Array.isArray(payload)) return payload;
  const records = payload?.result?.records
    ?? payload?.result?.data
    ?? payload?.records
    ?? payload?.data;
  if (Array.isArray(records)) return records;
  const groupedRecords = groupedRecordKey === undefined
    ? undefined
    : payload?.records?.[groupedRecordKey];
  if (Array.isArray(groupedRecords)) return groupedRecords;
  throw new CwaSourceError(
    `CWA response must contain a record array (expected result.records or records.${groupedRecordKey ?? '<dataset>'})`,
    { code: 'CWA_RECORDS_MISSING' },
  );
}

function warningRecordsFromPayload(payload) {
  const records = recordsFromPayload(payload, 'location');
  return records.flatMap((record) => {
    const hazards = record?.hazardConditions?.hazards;
    if (!Array.isArray(hazards)) return [record];

    return hazards.map((hazard, index) => {
      const info = hazard?.info ?? {};
      const validTime = hazard?.validTime ?? {};
      const resourceId = firstValue(payload?.result?.resource_id, 'cwa-weather-warning');
      const locationKey = firstValue(record?.geocode, record?.locationName, 'location');
      const identifier = firstValue(
        hazard?.identifier,
        hazard?.Identifier,
        hazard?.id,
        `${resourceId}:${locationKey}:${firstValue(validTime.startTime, 'unknown')}:${index}`,
      );

      return {
        ...record,
        identifier,
        IssueTime: firstValue(hazard?.IssueTime, hazard?.issueTime, validTime.startTime),
        EndTime: firstValue(hazard?.EndTime, hazard?.endTime, validTime.endTime),
        CountyName: firstValue(record?.CountyName, record?.county_name, record?.locationName),
        AreaDesc: firstValue(record?.AreaDesc, record?.area_desc, record?.locationName),
        WarningType: firstValue(record?.WarningType, record?.warning_type, info.phenomena),
        Severity: firstValue(record?.Severity, record?.severity, info.significance),
        Description: firstValue(record?.Description, record?.description, info.phenomena),
        source_record: { location: record, hazard },
      };
    });
  });
}

function typhoonRecordsFromPayload(payload) {
  const infos = payload?.records?.info;
  if (!Array.isArray(infos)) {
    return warningRecordsFromPayload(payload).map((record) => ({
      ...record,
      warning_kind: 'typhoon',
      coverage_level: 'nationwide',
    }));
  }

  const resourceId = firstValue(payload?.result?.resource_id, 'W-C0034-001');
  return infos.map((info, index) => {
    const areas = Array.isArray(info?.area)
      ? info.area
      : (info?.area ? [info.area] : []);
    const areaDescription = areas
      .map((area) => textValue(area?.areaDesc ?? area?.area_desc))
      .filter(Boolean)
      .join('、');
    const eventCode = textValue(info?.eventCode);
    const eventName = textValue(info?.event);
    const effective = textValue(info?.effective);
    return {
      identifier: firstValue(
        textValue(info?.identifier),
        `${resourceId}:${eventCode ?? eventName ?? 'typhoon'}:${effective ?? 'unknown'}:${index}`,
      ),
      Effective: effective,
      Expires: textValue(info?.expires),
      Severity: textValue(info?.severity),
      Urgency: textValue(info?.urgency),
      WarningType: eventName,
      Description: firstValue(textValue(info?.headline), eventName, textValue(info?.description)),
      AreaDesc: firstValue(areaDescription, '臺灣'),
      warning_kind: 'typhoon',
      coverage_level: 'nationwide',
      source_record: { info },
    };
  });
}

function assertRawSnapshot(rawSnapshot, sourceId) {
  const errors = validateRawSnapshot(rawSnapshot);
  if (errors.length > 0) throw new CwaSourceError(`invalid CWA Raw snapshot: ${errors.join('; ')}`, { code: 'CWA_RAW_INVALID' });
  const sourceIds = Array.isArray(sourceId) ? sourceId : [sourceId];
  if (!sourceIds.includes(rawSnapshot.source_id)) {
    throw new CwaSourceError(`CWA normalizer requires source_id=${sourceIds.join(' or ')}`, { code: 'CWA_SOURCE_ID_INVALID' });
  }
}

function boundaryGeometry(boundary) {
  if (boundary?.type === 'Feature') return boundary.geometry;
  if (boundary?.type === 'FeatureCollection') {
    const features = Array.isArray(boundary.features) ? boundary.features : [];
    const countyFeatures = features.filter((feature) => {
      const level = firstValue(
        feature?.properties?.level,
        feature?.properties?.LEVEL,
        feature?.properties?.area_level,
        feature?.properties?.行政區層級,
      );
      return /county|縣|直轄市/iu.test(String(level ?? ''));
    });
    const geometries = (countyFeatures.length > 0 ? countyFeatures : features)
      .map((feature) => feature?.geometry)
      .filter(Boolean);
    if (geometries.length === 0) return undefined;
    if (geometries.length === 1) return geometries[0];
    if (geometries.every((geometry) => ['Polygon', 'MultiPolygon'].includes(geometry.type))) {
      return {
        type: 'MultiPolygon',
        coordinates: geometries.flatMap((geometry) => (
          geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
        )),
      };
    }
    return { type: 'GeometryCollection', geometries };
  }
  return boundary;
}

function fieldText(record, ...names) {
  for (const name of names) {
    const value = record?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return undefined;
}

function numberField(record, ...names) {
  const value = fieldText(record, ...names);
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function pointFromFields(record, latitudeNames, longitudeNames) {
  const latitude = numberField(record, ...latitudeNames);
  const longitude = numberField(record, ...longitudeNames);
  if (latitude === undefined && longitude === undefined) return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new CwaSourceError('CWA coordinate is invalid', { code: 'CWA_GEOMETRY_INVALID' });
  }
  try {
    return { type: 'Point', coordinates: normalizeCoordinate([longitude, latitude]) };
  } catch (error) {
    throw new CwaSourceError(`CWA coordinate is invalid: ${error.message}`, {
      code: 'CWA_GEOMETRY_INVALID',
      cause: error,
    });
  }
}

function geometryFromRecord(record, { earthquake = false } = {}) {
  const direct = record?.geometry ?? record?.Geometry ?? record?.geojson ?? record?.GeoJSON;
  if (direct && typeof direct === 'object') return direct.type === 'Feature' ? direct.geometry : direct;
  if (earthquake) {
    return pointFromFields(
      record,
      ['StationLatitude', 'station_latitude', 'StationLat', 'stationLat'],
      ['StationLongitude', 'station_longitude', 'StationLon', 'stationLon'],
    ) ?? pointFromFields(
      record,
      ['EpicenterLatitude', 'epicenter_latitude', 'EpicenterLat', 'epicenterLat'],
      ['EpicenterLongitude', 'epicenter_longitude', 'EpicenterLon', 'epicenterLon'],
    ) ?? pointFromFields(
      record?.EarthquakeInfo?.Epicenter ?? record?.earthquake_info?.epicenter,
      ['EpicenterLatitude', 'epicenter_latitude', 'latitude', 'Latitude'],
      ['EpicenterLongitude', 'epicenter_longitude', 'longitude', 'Longitude'],
    );
  }
  return pointFromFields(
    record,
    ['Latitude', 'latitude', 'Lat', 'lat'],
    ['Longitude', 'longitude', 'Lon', 'lon'],
  );
}

function isTaipeiScope(record) {
  const text = [
    fieldText(record, 'CountyName', 'county_name', 'County', 'county', 'City', 'city'),
    fieldText(record, 'AreaDesc', 'area_desc', 'Location', 'location'),
  ].filter(Boolean).join(' ');
  return /(?:臺北|台北)市/u.test(text);
}

function normalizeSeverity(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (/EXTREME|極端|重大/u.test(raw)) return 'CRITICAL';
  if (/SEVERE|嚴重|高/u.test(raw)) return 'HIGH';
  if (/MODERATE|中/u.test(raw)) return 'MEDIUM';
  if (/MINOR|輕微|低/u.test(raw)) return 'LOW';
  return 'UNKNOWN';
}

function eventVersion(record) {
  const value = Number(firstValue(record.EventVersion, record.event_version, record.Version, record.version, 1));
  if (!Number.isInteger(value) || value < 1) {
    throw new CwaSourceError('CWA event version is invalid', { code: 'CWA_EVENT_VERSION_INVALID' });
  }
  return value;
}

function sourceVersion(rawSnapshot, record, id) {
  return String(firstValue(
    record.source_version,
    record.SourceVersion,
    record.IssueTime,
    record.sent,
    id,
    rawSnapshot.response?.headers?.etag,
    rawSnapshot.retrieved_at,
  ));
}

function curateGeometry(record, geometry, options) {
  const isNationwide = record?.coverage_level === 'nationwide';
  const boundary = isNationwide ? options.boundary : boundaryForRecord(options, record, geometry);
  if (geometry) {
    try {
      if (boundary && isGeometryInBoundary(geometry, boundary)) {
        return {
          geometry,
          coverageLevel: record?.coverage_level ?? (options.scope === 'taiwan' ? 'area' : 'district'),
        };
      }
    } catch (error) {
      throw new CwaSourceError(`CWA geometry is invalid: ${error.message}`, {
        code: 'CWA_GEOMETRY_INVALID',
        cause: error,
      });
    }
  }
  if (boundary && (isNationwide || options.scope === 'taiwan' || isTaipeiScope(record))) {
    const fallback = boundaryGeometry(boundary);
    if (!fallback) throw new CwaSourceError('CWA boundary geometry is required', { code: 'CWA_BOUNDARY_INVALID' });
    return {
      geometry: fallback,
      coverageLevel: record?.coverage_level ?? (options.scope === 'taiwan' ? 'area' : 'city'),
    };
  }
  return undefined;
}

function eventAttributes(record, theme, coverageLevel, geometry, options, areaMetadata, mapLocationKind) {
  const area = record?.coverage_level === 'nationwide'
    ? {
      area_id: options.scope === 'taiwan' ? 'tw' : (options.areaId ?? 'tw'),
      ...(options.scope === 'taiwan'
        ? { county_code: null, town_code: null, village_code: null }
        : {}),
    }
    : (areaMetadata ?? areaMetadataForRecord(options, record, geometry));
  return {
    ...area,
    theme,
    coverage_level: coverageLevel,
    ...(mapLocationKind ? { map_location_kind: mapLocationKind } : {}),
    ...(options.coverage ? { coverage: options.coverage } : {}),
    alert_id: firstValue(
      record.EarthquakeNo,
      record.earthquake_no,
      record.identifier,
      record.Identifier,
      record.WarningID,
      record.warning_id,
    ),
    affected_area: firstValue(
      record.AreaDesc,
      record.area_desc,
      record.CountyName,
      record.county_name,
      record.Location,
      record.location,
    ),
    source_description: firstValue(
      record.Description,
      record.description,
      record.WarningType,
      record.warning_type,
      record.AreaDesc,
      record.area_desc,
    ),
    original_unit: firstValue(record.unit, record.Unit, record.units, record.Units),
    source_record: record.source_record ?? record,
  };
}

function makeEvent({ rawSnapshot, record, id, eventType, geometry, coverageLevel, theme, issuedAt, expiresAt, options, severity = 'UNKNOWN', areaMetadata, mapLocationKind }) {
  if (Date.parse(expiresAt) < Date.parse(issuedAt)) {
    throw new CwaSourceError(`CWA event ${id} expires before it is issued`, { code: 'CWA_TIME_INVALID' });
  }
  return {
    schema_version: 'event-v0',
    namespace: options.namespace ?? 'official.cwa',
    event_id: `cwa:${eventType === 'EARTHQUAKE_INTENSITY' ? 'earthquake' : 'warning'}:${normalizeId(id, 'CWA event id')}`,
    event_type: eventType,
    geometry,
    severity,
    source: 'CWA',
    source_version: sourceVersion(rawSnapshot, record, id),
    event_version: eventVersion(record),
    issued_at: issuedAt,
    expires_at: expiresAt,
    attributes: eventAttributes(record, theme, coverageLevel, geometry, options, areaMetadata, mapLocationKind),
    signature_algorithm: 'Ed25519',
    signing_key_id: options.signingKeyId ?? 'cwa-source-2026',
    provenance: {
      original_source: options.originalSource ?? rawSnapshot.request.url,
      received_at: options.receivedAt ?? rawSnapshot.retrieved_at,
      transport_source: options.transportSource ?? { kind: 'server', node_id: 'cwa-collector' },
    },
  };
}

function normalizeEarthquakeRecord(record, index, rawSnapshot, options) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new CwaSourceError(`CWA earthquake record ${index} must be an object`, { code: 'CWA_RECORD_INVALID' });
  }
  const earthquakeNo = firstValue(record.EarthquakeNo, record.earthquake_no, record.EarthquakeID, record.id);
  const id = normalizeId(earthquakeNo, 'CWA EarthquakeNo');
  const geometry = geometryFromRecord(record, { earthquake: true });
  // The official earthquake feed includes offshore epicentres. Replacing an
  // offshore point with all Taiwan's town polygons loses the location and
  // multiplies tens of MB per report. Keep the source's precise epicentre in
  // nationwide mode; an epicentre is not an intensity/closure polygon.
  const curated = options.scope === 'taiwan' && geometry?.type === 'Point'
    ? { geometry, coverageLevel: 'epicentre' }
    : curateGeometry(record, geometry, options);
  if (!curated) return undefined;
  const issuedAt = normalizeTime(
    firstValue(
      record.OriginTime,
      record.origin_time,
      record.EarthquakeInfo?.OriginTime,
      record.earthquake_info?.origin_time,
      record.IssueTime,
      record.issue_time,
    ),
    `CWA earthquake ${id} issued_at`,
  );
  const expiresAt = normalizeTime(
    firstValue(
      record.EndTime,
      record.end_time,
      record.Expires,
      record.expires,
      record.ValidTime?.EndTime,
      record.valid_time?.end_time,
      rawSnapshot.expires_at,
    ),
    `CWA earthquake ${id} expires_at`,
  );
  const stationId = firstValue(record.StationID, record.station_id, record.StationName, record.station_name);
  const eventId = `${id}:${normalizeId(stationId ?? fieldText(record, 'CountyName', 'county_name') ?? 'report', 'CWA station id')}`;
  return makeEvent({
    rawSnapshot,
    record,
    id: eventId,
    eventType: 'EARTHQUAKE_INTENSITY',
    geometry: curated.geometry,
    coverageLevel: curated.coverageLevel,
    theme: 'earthquake',
    issuedAt,
    expiresAt,
    options,
  });
}

function normalizeWarningRecord(record, index, rawSnapshot, options) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new CwaSourceError(`CWA warning record ${index} must be an object`, { code: 'CWA_RECORD_INVALID' });
  }
  const sourceId = firstValue(record.identifier, record.Identifier, record.WarningID, record.warning_id, record.id);
  const id = normalizeId(sourceId, 'CWA warning identifier');
  const geometry = geometryFromRecord(record);
  const curated = curateGeometry(record, geometry, options);
  if (!curated) return undefined;
  const resolvedArea = options.areaResolver?.(record, geometry);
  const areaMetadata = areaMetadataForRecord(options, record, geometry);
  const countyReference = options.scope === 'taiwan' && !geometry
    && resolvedArea?.level === 'county' && record.warning_kind !== 'typhoon';
  const displayGeometry = countyReference
    ? representativePointInBoundary(resolvedArea.geometry)
    : curated.geometry;
  const issuedAt = normalizeTime(
    firstValue(record.Effective, record.effective, record.Sent, record.sent, record.IssueTime, record.issue_time),
    `CWA warning ${id} issued_at`,
  );
  const expiresAt = normalizeTime(
    firstValue(record.Expires, record.expires, record.EndTime, record.end_time, rawSnapshot.expires_at),
    `CWA warning ${id} expires_at`,
  );
  return makeEvent({
    rawSnapshot,
    record,
    id,
    eventType: record.warning_kind === 'typhoon' ? 'TYPHOON_WARNING' : 'WEATHER_WARNING',
    geometry: displayGeometry,
    coverageLevel: countyReference ? 'county' : curated.coverageLevel,
    theme: record.warning_kind === 'typhoon' ? 'typhoon' : 'weather',
    issuedAt,
    expiresAt,
    options,
    areaMetadata,
    mapLocationKind: countyReference ? 'area_reference' : undefined,
    severity: normalizeSeverity(firstValue(record.Severity, record.severity, record.Urgency, record.urgency)),
  });
}

function normalizeOptions(options = {}) {
  if (!options.boundary) throw new CwaSourceError('CWA scope boundary is required for curation', { code: 'CWA_BOUNDARY_MISSING' });
  const receivedAt = options.receivedAt;
  if (receivedAt !== undefined) normalizeTime(receivedAt, 'receivedAt');
  return options;
}

export function normalizeCwaEarthquakes(rawSnapshot, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  assertRawSnapshot(rawSnapshot, 'cwa-earthquake');
  return recordsFromPayload(rawSnapshot.payload, 'Earthquake')
    .map((record, index) => normalizeEarthquakeRecord(record, index, rawSnapshot, normalizedOptions))
    .filter(Boolean);
}

export function normalizeCwaWarnings(rawSnapshot, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  assertRawSnapshot(rawSnapshot, 'cwa-weather-warning');
  return warningRecordsFromPayload(rawSnapshot.payload)
    .map((record, index) => normalizeWarningRecord(record, index, rawSnapshot, normalizedOptions))
    .filter(Boolean);
}

export function normalizeCwaTyphoonWarnings(rawSnapshot, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  assertRawSnapshot(rawSnapshot, 'cwa-typhoon-warning');
  return typhoonRecordsFromPayload(rawSnapshot.payload)
    .map((record, index) => normalizeWarningRecord(record, index, rawSnapshot, normalizedOptions))
    .filter(Boolean);
}

async function fetchCwaDataset({ apiKey, endpoint, sourceId, fetchImpl, retrievedAt, timeoutMs }) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new CwaCredentialError();
  try {
    const result = await requestJson(endpoint, {
      fetchImpl,
      timeoutMs,
      allowedSensitiveQueryNames: ['Authorization'],
      query: { Authorization: apiKey, format: 'JSON' },
      headers: { Accept: 'application/json' },
    });
    return makeRawSnapshot({
      sourceId,
      request: {
        method: 'GET',
        url: endpoint,
        query: { Authorization: apiKey, format: 'JSON' },
      },
      responseStatus: result.status,
      responseHeaders: result.headers,
      retrievedAt,
      payload: result.payload,
    });
  } catch (error) {
    if (error instanceof CwaSourceError) throw error;
    throw new CwaSourceError(`CWA request failed: ${error.message}`, {
      code: error.code === 'HTTP_ERROR' ? 'CWA_HTTP_ERROR' : 'CWA_REQUEST_ERROR',
      status: error.status ?? null,
      cause: error,
    });
  }
}

export function fetchCwaEarthquakes({
  apiKey = process.env.CWA_API_KEY,
  endpoint = process.env.CWA_EARTHQUAKE_ENDPOINT ?? DEFAULT_CWA_EARTHQUAKE_ENDPOINT,
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
  timeoutMs = 30000,
} = {}) {
  return fetchCwaDataset({
    apiKey,
    endpoint,
    sourceId: 'cwa-earthquake',
    fetchImpl,
    retrievedAt,
    timeoutMs,
  });
}

export function fetchCwaWarnings({
  apiKey = process.env.CWA_API_KEY,
  endpoint = process.env.CWA_WARNING_ENDPOINT ?? DEFAULT_CWA_WARNING_ENDPOINT,
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
  timeoutMs = 30000,
} = {}) {
  return fetchCwaDataset({
    apiKey,
    endpoint,
    sourceId: 'cwa-weather-warning',
    fetchImpl,
    retrievedAt,
    timeoutMs,
  });
}

export function fetchCwaTyphoonWarnings({
  apiKey = process.env.CWA_API_KEY,
  endpoint = process.env.CWA_TYPHOON_ENDPOINT ?? DEFAULT_CWA_TYPHOON_ENDPOINT,
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
  timeoutMs = 30000,
} = {}) {
  return fetchCwaDataset({
    apiKey,
    endpoint,
    sourceId: 'cwa-typhoon-warning',
    fetchImpl,
    retrievedAt,
    timeoutMs,
  });
}
