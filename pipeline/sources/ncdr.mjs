import {
  isGeometryInBoundary,
  normalizeCoordinate,
} from '../lib/geo.mjs';
import { areaMetadataForRecord, boundaryForRecord } from '../lib/coverage.mjs';
import {
  makeRawSnapshot,
  requestJson,
  validateRawSnapshot,
} from '../lib/source.mjs';
import { sha256Canonical } from '../lib/canonical.mjs';

// NCDR's authenticated alert datastore path is configurable because the
// concrete dataset route is assigned during API onboarding.
export const DEFAULT_NCDR_ENDPOINT = 'https://alerts.ncdr.nat.gov.tw/api/datastore';
export const DEFAULT_NCDR_DETAIL_ENDPOINT = 'https://alerts.ncdr.nat.gov.tw/api/dump/datastore';

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export class NcdrCredentialError extends Error {
  constructor(message = 'NCDR API key is required: set NCDR_ALERT_API_KEY (or legacy NCDR_API_KEY)') {
    super(message);
    this.name = 'NcdrCredentialError';
    this.code = 'NCDR_CREDENTIALS_MISSING';
  }
}

export class NcdrSourceError extends Error {
  constructor(message, { code = 'NCDR_SOURCE_ERROR', status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NcdrSourceError';
    this.code = code;
    this.status = status;
  }
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function normalizeId(value, fieldName) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, '-');
  if (!normalized) throw new NcdrSourceError(`${fieldName} is required`, { code: 'NCDR_EVENT_ID_MISSING' });
  return normalized.slice(0, 240);
}

function normalizeTime(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NcdrSourceError(`${fieldName} is required`, { code: 'NCDR_TIME_MISSING' });
  }
  const trimmed = value.trim();
  const withTimezone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}+08:00`
    : trimmed;
  if (!RFC3339_RE.test(withTimezone)) {
    throw new NcdrSourceError(`${fieldName} must be an RFC 3339 date-time`, { code: 'NCDR_TIME_INVALID' });
  }
  const parsed = Date.parse(withTimezone);
  if (Number.isNaN(parsed)) {
    throw new NcdrSourceError(`${fieldName} must be an RFC 3339 date-time`, { code: 'NCDR_TIME_INVALID' });
  }
  return new Date(parsed).toISOString();
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function capInfoValues(record) {
  const info = parseJsonValue(record?.info ?? record?.Info);
  if (Array.isArray(info)) return info.filter((value) => value && typeof value === 'object');
  return info && typeof info === 'object' ? [info] : [];
}

function capAreaValues(info) {
  const area = parseJsonValue(info?.area ?? info?.Area);
  if (Array.isArray(area)) return area.filter((value) => value && typeof value === 'object');
  return area && typeof area === 'object' ? [area] : [];
}

function capInfoForRecord(record, infos) {
  return infos.find((info) => /^(?:zh|zh-TW|zh-Hant)/iu.test(String(info.language ?? info.Language ?? '')))
    ?? infos.find((info) => capAreaValues(info).length > 0)
    ?? infos[0];
}

function capRecordToFlatRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const identifier = firstValue(record.identifier, record.Identifier, record.CAPID, record.capid);
  const infos = capInfoValues(record);
  if (!identifier || infos.length === 0) return record;

  const info = capInfoForRecord(record, infos) ?? {};
  const areas = capAreaValues(info);
  const areaWithPolygon = areas.find((area) => firstValue(area.polygon, area.Polygon));
  const areaWithCircle = areas.find((area) => firstValue(area.circle, area.Circle));
  const areaDescription = areas
    .map((area) => firstValue(area.areaDesc, area.AreaDesc, area.area_desc))
    .filter(Boolean)
    .join('；');
  const polygon = firstValue(
    areaWithPolygon?.polygon,
    areaWithPolygon?.Polygon,
    ...areas.flatMap((area) => [area.polygon, area.Polygon]),
  );

  return {
    ...record,
    CAPID: identifier,
    event: firstValue(info.event, info.Event, info.phenomenon, info.Phenomenon),
    sent: firstValue(record.sent, record.Sent),
    effective: firstValue(info.effective, info.Effective, record.effective, record.Effective),
    expires: firstValue(info.expires, info.Expires, record.expires, record.Expires),
    severity: firstValue(info.severity, info.Severity),
    urgency: firstValue(info.urgency, info.Urgency),
    description: firstValue(info.description, info.Description, info.headline, info.Headline),
    areaDesc: firstValue(areaDescription, record.areaDesc, record.AreaDesc),
    polygon: firstValue(polygon, record.polygon, record.Polygon),
    circle: firstValue(areaWithCircle?.circle, areaWithCircle?.Circle, record.circle, record.Circle),
    source_record: record,
  };
}

function detailEntryToRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const payload = entry.payload ?? entry.detail ?? entry.record ?? entry;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const indexRecord = entry.index_record && typeof entry.index_record === 'object' ? entry.index_record : {};
  const merged = {
    ...indexRecord,
    ...payload,
    capid: firstValue(payload.capid, payload.CAPID, payload.identifier, payload.Identifier, indexRecord.capid, indexRecord.CAPID),
    effective: firstValue(payload.effective, payload.Effective, indexRecord.effective, indexRecord.Effective),
    expires: firstValue(payload.expires, payload.Expires, indexRecord.expires, indexRecord.Expires),
  };
  return capRecordToFlatRecord(merged);
}

function recordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.details)) return payload.details.map(detailEntryToRecord).filter(Boolean);
    const records = payload.data
      ?? payload.records
      ?? payload.items
      ?? payload.alerts
      ?? payload.result
      ?? payload.result?.records
      ?? payload.result?.data
      ?? payload.result?.items;
    if (Array.isArray(records)) return records.map(capRecordToFlatRecord);
    if (firstValue(payload.identifier, payload.Identifier, payload.CAPID, payload.capid, payload.id)) {
      return [capRecordToFlatRecord(payload)];
    }
  }
  throw new NcdrSourceError('NCDR response must contain an alert record array', { code: 'NCDR_RECORDS_MISSING' });
}

function datastoreIndexRecords(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  if (Array.isArray(payload.result)) return payload.result;
  return undefined;
}

function capidFromIndexRecord(record) {
  return firstValue(record?.capid, record?.CAPID, record?.identifier, record?.Identifier, record?.id);
}

function detailEndpointFor(endpoint, detailEndpoint) {
  if (detailEndpoint) return detailEndpoint;
  const parsed = new URL(endpoint);
  if (!/\/api\/datastore\/?$/u.test(parsed.pathname)) {
    throw new NcdrSourceError(
      'NCDR detail endpoint is required when NCDR_ALERT_ENDPOINT does not end with /api/datastore',
      { code: 'NCDR_DETAIL_ENDPOINT_MISSING' },
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/api\/datastore\/?$/u, '/api/dump/datastore');
  parsed.search = '';
  return parsed.toString();
}

function validateDetailConcurrency(value) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new NcdrSourceError('NCDR detail concurrency must be an integer from 1 to 32', {
      code: 'NCDR_DETAIL_CONCURRENCY_INVALID',
    });
  }
  return concurrency;
}

function detailFailure(error, capid) {
  return {
    capid: capid ?? null,
    error_code: error?.code ?? 'NCDR_DETAIL_REQUEST_ERROR',
    status: Number.isInteger(error?.status) ? error.status : null,
  };
}

function assertRawSnapshot(rawSnapshot) {
  const errors = validateRawSnapshot(rawSnapshot);
  if (errors.length > 0) {
    throw new NcdrSourceError(`invalid NCDR Raw snapshot: ${errors.join('; ')}`, { code: 'NCDR_RAW_INVALID' });
  }
  if (rawSnapshot.source_id !== 'ncdr-hazard-events') {
    throw new NcdrSourceError('NCDR normalizer requires source_id=ncdr-hazard-events', {
      code: 'NCDR_SOURCE_ID_INVALID',
    });
  }
}

function boundaryGeometry(boundary) {
  if (boundary?.type === 'Feature') return boundary.geometry;
  if (boundary?.type === 'FeatureCollection') return boundary.features?.[0]?.geometry;
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

function pointFromFields(record) {
  const latitude = numberField(
    record,
    'latitude', 'Latitude', 'lat', 'Lat', 'y', 'Y',
    'center_latitude', 'CenterLatitude',
  );
  const longitude = numberField(
    record,
    'longitude', 'Longitude', 'lon', 'Lon', 'lng', 'Lng', 'x', 'X',
    'center_longitude', 'CenterLongitude',
  );
  if (latitude === undefined && longitude === undefined) return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new NcdrSourceError('NCDR coordinate is invalid', { code: 'NCDR_GEOMETRY_INVALID' });
  }
  try {
    return { type: 'Point', coordinates: normalizeCoordinate([longitude, latitude]) };
  } catch (error) {
    throw new NcdrSourceError(`NCDR coordinate is invalid: ${error.message}`, {
      code: 'NCDR_GEOMETRY_INVALID',
      cause: error,
    });
  }
}

function capPolygon(value) {
  if (typeof value !== 'string') return undefined;
  const pairs = value
    .trim()
    .split(/[;\s]+/u)
    .filter(Boolean)
    .map((pair) => pair.split(',').map((item) => Number(item.trim())));
  if (pairs.length === 0 || pairs.some((pair) => pair.length !== 2 || pair.some((item) => !Number.isFinite(item)))) {
    throw new NcdrSourceError('NCDR CAP polygon is invalid', { code: 'NCDR_GEOMETRY_INVALID' });
  }
  const coordinates = pairs.map(([latitude, longitude]) => {
    try {
      return normalizeCoordinate([longitude, latitude]);
    } catch (error) {
      throw new NcdrSourceError(`NCDR CAP polygon coordinate is invalid: ${error.message}`, {
        code: 'NCDR_GEOMETRY_INVALID',
        cause: error,
      });
    }
  });
  if (coordinates.length < 3) {
    throw new NcdrSourceError('NCDR CAP polygon needs at least three positions', { code: 'NCDR_GEOMETRY_INVALID' });
  }
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
  return { type: 'Polygon', coordinates: [coordinates] };
}

function capCircle(value) {
  if (typeof value !== 'string') {
    throw new NcdrSourceError('NCDR CAP circle is invalid', { code: 'NCDR_GEOMETRY_INVALID' });
  }
  const [center, radiusText] = value.trim().split(/\s+/u);
  const [latitude, longitude] = String(center ?? '').split(',').map((item) => Number(item.trim()));
  const radius = Number(radiusText);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius) || radius < 0) {
    throw new NcdrSourceError('NCDR CAP circle is invalid', { code: 'NCDR_GEOMETRY_INVALID' });
  }
  try {
    return { type: 'Point', coordinates: normalizeCoordinate([longitude, latitude]) };
  } catch (error) {
    throw new NcdrSourceError(`NCDR CAP circle coordinate is invalid: ${error.message}`, {
      code: 'NCDR_GEOMETRY_INVALID',
      cause: error,
    });
  }
}

function geometryFromValue(value) {
  const parsed = parseJsonValue(value);
  if (parsed?.type === 'Feature') return parsed.geometry;
  if (parsed?.type === 'FeatureCollection') return parsed.features?.[0]?.geometry;
  if (parsed?.type && (parsed.coordinates || parsed.geometries)) return parsed;
  return undefined;
}

function geometryFromRecord(record) {
  const direct = [
    record?.geometry,
    record?.Geometry,
    record?.geojson,
    record?.GeoJSON,
    record?.shape,
    record?.Shape,
  ].map(geometryFromValue).find(Boolean);
  if (direct) return direct;
  const polygon = firstValue(record?.polygon, record?.Polygon, record?.cap_polygon, record?.CAPPolygon);
  if (polygon) return capPolygon(polygon);
  const circle = firstValue(record?.circle, record?.Circle, record?.cap_circle, record?.CAPCircle);
  if (circle) return capCircle(circle);
  return pointFromFields(record);
}

function isTaipeiScope(record) {
  const text = [
    fieldText(record, 'areaDesc', 'AreaDesc', 'area_desc', 'county', 'County', 'county_name', 'CountyName', 'city', 'City'),
    fieldText(record, 'geocode', 'GeoCode', 'location', 'Location', 'affected_area', 'AffectedArea'),
  ].filter(Boolean).join(' ');
  return /(?:臺北|台北)市/u.test(text);
}

function normalizeEventType(value) {
  const raw = String(value ?? '').trim();
  if (/火災|fire/u.test(raw)) return 'FIRE_WARNING';
  if (/水庫放流|水庫洩洪|reservoir|dam release/u.test(raw)) return 'RESERVOIR_RELEASE_WARNING';
  if (/急門診|醫療|health|medical/u.test(raw)) return 'HEALTH_ALERT';
  if (/高溫|heat/u.test(raw)) return 'HEAT_WARNING';
  if (/停水|供水|water supply/u.test(raw)) return 'WATER_SUPPLY_ALERT';
  if (/海洋污染|marine pollution/u.test(raw)) return 'MARINE_POLLUTION_ALERT';
  if (/消防安全檢查|重大不合格|safety inspection/u.test(raw)) return 'SAFETY_ALERT';
  if (/國家森林遊樂|forest recreation/u.test(raw)) return 'FOREST_ALERT';
  if (/淹水|積水|洪水|flood/u.test(raw)) return 'FLOOD_WARNING';
  if (/土石流|debris/u.test(raw)) return 'DEBRIS_FLOW_WARNING';
  if (/崩塌|山崩|landslide/u.test(raw)) return 'LANDSLIDE_WARNING';
  if (/雨量|大雨|豪雨|rain/u.test(raw)) return 'RAINFALL_WARNING';
  if (/地震|earthquake/u.test(raw)) return 'EARTHQUAKE_WARNING';
  return 'NCDR_HAZARD';
}

function themeForEventType(eventType) {
  if (eventType.startsWith('FIRE')) return 'fire';
  if (eventType.startsWith('RESERVOIR')) return 'reservoir';
  if (eventType.startsWith('HEALTH')) return 'health';
  if (eventType.startsWith('HEAT')) return 'heat';
  if (eventType.startsWith('WATER_SUPPLY')) return 'water_supply';
  if (eventType.startsWith('MARINE')) return 'marine_pollution';
  if (eventType.startsWith('SAFETY')) return 'safety';
  if (eventType.startsWith('FOREST')) return 'forest';
  if (eventType.startsWith('FLOOD')) return 'flood';
  if (eventType.startsWith('DEBRIS')) return 'debris_flow';
  if (eventType.startsWith('LANDSLIDE')) return 'landslide';
  if (eventType.startsWith('RAINFALL')) return 'rainfall';
  if (eventType.startsWith('EARTHQUAKE')) return 'earthquake';
  return 'hazard';
}

function normalizeSeverity(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (/EXTREME|極端|重大/u.test(raw)) return 'CRITICAL';
  if (/SEVERE|嚴重|高/u.test(raw)) return 'HIGH';
  if (/MODERATE|中/u.test(raw)) return 'MEDIUM';
  if (/MINOR|輕微|低/u.test(raw)) return 'LOW';
  return 'UNKNOWN';
}

const NCDR_ROUTE_CHANGE_RE = /道路封閉|封閉道路|交通中斷|路段封閉|聯外道路|改道|休園|禁止通行|道路施工|坍方|落石/u;
const NCDR_EVACUATION_RE = /疏散|避難|撤離|警戒區|禁止進入|勿進入|堰塞湖|土石流|崩塌|山崩|洪水|淹水|地震|海嘯|颱風|火災|爆炸|洩洪|放流/u;
const NCDR_INSPECTION_RE = /消防安全設備|消防安全檢查|消防檢查|檢修申報|不合格|安檢/u;
const NCDR_EVACUATION_TYPES = new Set([
  'FIRE_WARNING',
  'FLOOD_WARNING',
  'DEBRIS_FLOW_WARNING',
  'LANDSLIDE_WARNING',
  'RAINFALL_WARNING',
  'EARTHQUAKE_WARNING',
]);

/**
 * Classify NCDR alerts by the action a person may need to take.
 *
 * Source severity is intentionally not used as the sole decision because
 * administrative inspection alerts can be HIGH without requiring evacuation.
 */
export function classifyNcdrOperationalRelevance({
  eventType,
  description,
  affectedArea,
} = {}) {
  const normalizedType = String(eventType ?? '').trim().toUpperCase();
  const text = [normalizedType, description, affectedArea]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(' ');

  if (NCDR_ROUTE_CHANGE_RE.test(text)) return 'ROUTE_CHANGE';
  if (normalizedType === 'RESERVOIR_RELEASE_WARNING') return 'HIGH_IMPACT';
  if (NCDR_EVACUATION_RE.test(text)) return 'EVACUATION';
  if (normalizedType === 'SAFETY_ALERT' && NCDR_INSPECTION_RE.test(text)) {
    return 'BACKGROUND';
  }
  if (NCDR_EVACUATION_TYPES.has(normalizedType)) return 'EVACUATION';
  if (normalizedType === 'NCDR_HAZARD') {
    return 'HIGH_IMPACT';
  }
  return 'BACKGROUND';
}

function eventVersion(record) {
  const value = Number(firstValue(record.event_version, record.EventVersion, record.version, record.Version, 1));
  if (!Number.isInteger(value) || value < 1) {
    throw new NcdrSourceError('NCDR event version is invalid', { code: 'NCDR_EVENT_VERSION_INVALID' });
  }
  return value;
}

function sourceVersion(rawSnapshot, record, id) {
  return String(firstValue(
    record.source_version,
    record.SourceVersion,
    record.sent,
    record.Sent,
    record.updated_at,
    record.UpdateTime,
    id,
    rawSnapshot.response?.headers?.etag,
    rawSnapshot.retrieved_at,
  ));
}

function curatedGeometry(record, geometry, options) {
  const boundary = boundaryForRecord(options, record, geometry);
  if (geometry) {
    try {
      if (boundary && isGeometryInBoundary(geometry, boundary)) {
        return {
          geometry,
          coverageLevel: options.scope === 'taiwan' ? 'area' : 'district',
        };
      }
    } catch (error) {
      throw new NcdrSourceError(`NCDR geometry is invalid: ${error.message}`, {
        code: 'NCDR_GEOMETRY_INVALID',
        cause: error,
      });
    }
  }
  if (boundary && (options.scope === 'taiwan' || isTaipeiScope(record))) {
    const fallback = boundaryGeometry(boundary);
    if (!fallback) throw new NcdrSourceError('NCDR boundary geometry is required', { code: 'NCDR_BOUNDARY_INVALID' });
    return { geometry: fallback, coverageLevel: options.scope === 'taiwan' ? 'area' : 'city' };
  }
  if (!geometry) throw new NcdrSourceError('NCDR hazard geometry is required', { code: 'NCDR_GEOMETRY_MISSING' });
  return undefined;
}

function normalizeRecord(record, index, rawSnapshot, options) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new NcdrSourceError(`NCDR hazard record ${index} must be an object`, { code: 'NCDR_RECORD_INVALID' });
  }
  const id = normalizeId(
    firstValue(record.CAPID, record.capid, record.identifier, record.Identifier, record.event_id, record.EventID, record.alert_id, record.id),
    'NCDR CAPID or alert identifier',
  );
  const geometry = geometryFromRecord(record);
  const curated = curatedGeometry(record, geometry, options);
  if (!curated) return undefined;

  const eventType = normalizeEventType(firstValue(
    record.event, record.Event, record.event_type, record.EventType, record.hazard_type,
    record.category, record.Category,
  ));
  const issuedAt = normalizeTime(
    firstValue(record.sent, record.Sent, record.effective, record.Effective, record.issue_time, record.IssueTime, record.issued_at),
    `NCDR hazard ${id} issued_at`,
  );
  const expiresAt = normalizeTime(
    firstValue(record.expires, record.Expires, record.expire_time, record.ExpireTime, record.end_time, record.EndTime, record.expires_at),
    `NCDR hazard ${id} expires_at`,
  );
  if (Date.parse(expiresAt) < Date.parse(issuedAt)) {
    throw new NcdrSourceError(`NCDR event ${id} expires before it is issued`, { code: 'NCDR_TIME_INVALID' });
  }

  const theme = themeForEventType(eventType);
  const sourceDescription = firstValue(record.description, record.Description, record.source_description, record.SourceDescription);
  const affectedArea = firstValue(record.areaDesc, record.AreaDesc, record.affected_area, record.AffectedArea);
  const operationalRelevance = classifyNcdrOperationalRelevance({
    eventType,
    description: sourceDescription,
    affectedArea,
  });
  // Resolve administrative metadata from the source geometry. When an
  // nationwide alert has no geometry, curatedGeometry deliberately falls
  // back to the nationwide boundary; resolving that huge fallback polygon
  // against every catalog area would repeat a very expensive scan.
  const area = areaMetadataForRecord(options, record, geometry);
  return {
    schema_version: 'event-v0',
    namespace: options.namespace ?? 'official.ncdr',
    event_id: `ncdr:${id}`,
    event_type: eventType,
    geometry: curated.geometry,
    severity: normalizeSeverity(firstValue(record.severity, record.Severity, record.urgency, record.Urgency)),
    source: 'NCDR',
    source_version: sourceVersion(rawSnapshot, record, id),
    event_version: eventVersion(record),
    issued_at: issuedAt,
    expires_at: expiresAt,
    attributes: {
      ...area,
      theme,
      coverage_level: curated.coverageLevel,
      ...(options.coverage ? { coverage: options.coverage } : {}),
      alert_id: firstValue(record.CAPID, record.capid, record.identifier, record.Identifier, record.alert_id) ?? id,
      affected_area: affectedArea,
      source_description: sourceDescription,
      operational_relevance: operationalRelevance,
      map_visible: operationalRelevance !== 'BACKGROUND',
      original_unit: firstValue(record.unit, record.Unit, record.units, record.Units),
      source_record: record.source_record ?? record,
    },
    signature_algorithm: 'Ed25519',
    signing_key_id: options.signingKeyId ?? 'ncdr-source-2026',
    provenance: {
      original_source: options.originalSource ?? rawSnapshot.request.url,
      received_at: options.receivedAt ?? rawSnapshot.retrieved_at,
      transport_source: options.transportSource ?? { kind: 'server', node_id: 'ncdr-collector' },
    },
  };
}

export function normalizeNcdrHazards(rawSnapshot, options = {}) {
  if (!options.boundary) throw new NcdrSourceError('NCDR scope boundary is required for curation', { code: 'NCDR_BOUNDARY_MISSING' });
  if (options.receivedAt !== undefined) normalizeTime(options.receivedAt, 'receivedAt');
  assertRawSnapshot(rawSnapshot);
  return recordsFromPayload(rawSnapshot.payload)
    .map((record, index) => normalizeRecord(record, index, rawSnapshot, options))
    .filter(Boolean);
}

/** CAP references, rather than a missing list item, authorize withdrawal. */
export function normalizeNcdrFeed(rawSnapshot, options = {}) {
  assertRawSnapshot(rawSnapshot);
  const records = recordsFromPayload(rawSnapshot.payload);
  const cancelledEventIds = records.flatMap(record => {
    const type = String(record.msgType ?? record.MsgType ?? '').toLowerCase();
    if (!['cancel', 'update'].includes(type)) return [];
    return String(record.references ?? record.References ?? '').split(/\s+/u).filter(Boolean)
      .map(reference => reference.split(',')[1]).filter(Boolean)
      .map(identifier => `ncdr:${normalizeId(identifier, 'CAP reference')}`);
  });
  const active = records.filter(record => String(record.msgType ?? record.MsgType ?? '').toLowerCase() !== 'cancel');
  const events = normalizeNcdrHazards({ ...rawSnapshot, payload: { records: active } }, options);
  return { events, cancelledEventIds: [...new Set(cancelledEventIds)] };
}

function credentialValue(credentials) {
  if (typeof credentials === 'string') return credentials;
  return firstValue(
    credentials?.apiKey,
    credentials?.token,
    credentials?.NCDR_ALERT_API_KEY,
    credentials?.NCDR_API_KEY,
    process.env.NCDR_ALERT_API_KEY,
    process.env.NCDR_API_KEY,
  );
}

export async function fetchNcdrHazards({
  credentials = { apiKey: process.env.NCDR_ALERT_API_KEY ?? process.env.NCDR_API_KEY },
  endpoint = process.env.NCDR_ALERT_ENDPOINT ?? process.env.NCDR_API_ENDPOINT ?? DEFAULT_NCDR_ENDPOINT,
  detailEndpoint = process.env.NCDR_ALERT_DETAIL_ENDPOINT,
  authMode = process.env.NCDR_AUTH_MODE ?? (/\/webapi(?:\/|$)/u.test(endpoint) ? 'query' : 'header'),
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
  timeoutMs = 30000,
  query = { format: 'JSON' },
  detailConcurrency = process.env.NCDR_DETAIL_CONCURRENCY ?? 4,
  previousSnapshot,
} = {}) {
  const token = credentialValue(credentials);
  if (typeof token !== 'string' || token.trim() === '') throw new NcdrCredentialError();
  if (!['header', 'query'].includes(authMode)) {
    throw new NcdrSourceError(`unsupported NCDR auth mode: ${authMode}`, { code: 'NCDR_AUTH_MODE_INVALID' });
  }
  const concurrency = validateDetailConcurrency(detailConcurrency);
  const requestQuery = authMode === 'query' ? { ...query, apikey: token } : query;
  try {
    const listResult = await requestJson(endpoint, {
      fetchImpl,
      timeoutMs,
      headers: { Accept: 'application/json', ...(authMode === 'header' ? { Token: token } : {}) },
      allowedSensitiveQueryNames: authMode === 'query' ? ['apikey'] : [],
      query: requestQuery,
    });

    const indexRecords = datastoreIndexRecords(listResult.payload);
    if (!indexRecords) {
      return makeRawSnapshot({
        sourceId: 'ncdr-hazard-events',
        request: { method: 'GET', url: endpoint, query: requestQuery },
        responseStatus: listResult.status,
        responseHeaders: listResult.headers,
        retrievedAt,
        payload: listResult.payload,
      });
    }

    const resolvedDetailEndpoint = detailEndpointFor(endpoint, detailEndpoint);
    const previousDetails = new Map((previousSnapshot?.payload?.details ?? [])
      .filter((detail) => detail?.capid && detail?.index_record)
      .map((detail) => [String(detail.capid), detail]));
    const detailResults = new Array(indexRecords.length);
    let nextIndex = 0;
    async function fetchDetailWorker() {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= indexRecords.length) return;
        const indexRecord = indexRecords[index];
        const capid = capidFromIndexRecord(indexRecord);
        if (!capid) {
          detailResults[index] = { failure: detailFailure({ code: 'NCDR_CAPID_MISSING' }, null) };
          continue;
        }
        const previousDetail = previousDetails.get(String(capid));
        if (previousDetail && sha256Canonical(previousDetail.index_record) === sha256Canonical(indexRecord)) {
          detailResults[index] = { detail: previousDetail };
          continue;
        }
        try {
          const detailResult = await requestJson(resolvedDetailEndpoint, {
            fetchImpl,
            timeoutMs,
            headers: { Accept: 'application/json', ...(authMode === 'header' ? { Token: token } : {}) },
            allowedSensitiveQueryNames: authMode === 'query' ? ['apikey'] : [],
            query: authMode === 'query'
              ? { ...query, capid, apikey: token }
              : { ...query, capid },
          });
          detailResults[index] = {
            detail: {
              capid: String(capid),
              index_record: indexRecord,
              response: { status: detailResult.status, headers: detailResult.headers },
              payload: detailResult.payload,
            },
          };
        } catch (error) {
          detailResults[index] = { failure: detailFailure(error, capid) };
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, Math.max(indexRecords.length, 1)) }, () => fetchDetailWorker());
    await Promise.all(workers);
    const details = detailResults.filter((result) => result?.detail).map((result) => result.detail);
    const failures = detailResults.filter((result) => result?.failure).map((result) => result.failure);
    if (indexRecords.length > 0 && details.length === 0) {
      const authFailure = failures.find((failure) => failure.status === 401 || failure.status === 403);
      throw new NcdrSourceError('NCDR detail requests returned no usable CAP data', {
        code: authFailure ? 'NCDR_HTTP_ERROR' : 'NCDR_DETAILS_EMPTY',
        status: authFailure?.status ?? null,
      });
    }

    return makeRawSnapshot({
      sourceId: 'ncdr-hazard-events',
      request: { method: 'GET', url: endpoint, query: requestQuery },
      responseStatus: listResult.status,
      responseHeaders: listResult.headers,
      retrievedAt,
      payload: {
        index: listResult.payload,
        details,
        partial: failures.length > 0,
        ...(failures.length > 0 ? { detail_failures: failures } : {}),
      },
    });
  } catch (error) {
    if (error instanceof NcdrSourceError) throw error;
    throw new NcdrSourceError(`NCDR request failed: ${error.message}`, {
      code: error.code === 'HTTP_ERROR' ? 'NCDR_HTTP_ERROR' : 'NCDR_REQUEST_ERROR',
      status: error.status ?? null,
      cause: error,
    });
  }
}
