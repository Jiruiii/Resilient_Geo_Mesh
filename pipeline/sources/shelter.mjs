import {
  assertRawFeatureSnapshot,
  featureBase,
  fetchStaticText,
  fieldText,
  firstValue,
  isInsideBoundary,
  normalizeId,
  pointFromFields,
  recordsFromPayload,
  staticTimes,
} from '../lib/feature-source.mjs';
import { areaMetadataForRecord } from '../lib/coverage.mjs';
import { normalizeCoordinate } from '../lib/geo.mjs';
import { TAIWAN_COUNTIES } from './taiwan-counties.mjs';

export const DEFAULT_SHELTER_ENDPOINT = 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/ED6CF735-6C03-4573-A882-72C1BEC799CB/resource/54550E2F-4567-4C8F-BD2E-E54E9D0386B8/download';

export class ShelterSourceError extends Error {
  constructor(message, { code = 'SHELTER_SOURCE_ERROR', status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ShelterSourceError';
    this.code = code;
    this.status = status;
  }
}

function sourceVersion(rawSnapshot, record, id) {
  return String(firstValue(
    fieldText(record, '資料更新時間', '更新時間', 'UpdateTime', 'updated_at'),
    rawSnapshot.response?.headers?.etag,
    rawSnapshot.response?.headers?.last_modified,
    rawSnapshot.retrieved_at,
    id,
  ));
}

function administrativeArea(record) {
  const direct = fieldText(
    record,
    '縣市及鄉鎮市區',
    '縣市鄉鎮市區',
    '行政區',
    '行政區域',
    'area',
    'district',
  );
  if (direct) return direct;
  return [fieldText(record, '縣市', 'county', 'County'), fieldText(record, '鄉鎮市區', 'town', 'Town')]
    .filter(Boolean)
    .join('') || undefined;
}

function isNeihuRecord(record) {
  const area = administrativeArea(record);
  const address = fieldText(record, '避難收容處所地址', '地址', 'address');
  return /(?:臺北|台北)市?\s*內湖區/u.test(`${area ?? ''} ${address ?? ''}`)
    || /內湖區/u.test(area ?? '')
    || /內湖區/u.test(address ?? '');
}

function disasterTypes(record) {
  const value = fieldText(record, '適用災害類別', '災害類別', 'disaster_type', 'disaster_types', 'disastertype');
  if (value === undefined) return [];
  return value.split(/[;,、，|/]+/u).map((item) => item.trim()).filter(Boolean);
}

function normalizeAreaText(value) {
  return String(value ?? '').replaceAll('台', '臺').replace(/[\s,，]/gu, '');
}

function textNamesTown(value, area) {
  return Boolean(area?.town_name && normalizeAreaText(value).includes(normalizeAreaText(area.town_name)));
}

function shelterLocationIssue(record, geometry, options) {
  const areaResolver = options.areaResolver;
  const sourceArea = areaResolver(record, undefined);
  const coordinateArea = areaResolver({}, geometry);
  if (!sourceArea || !coordinateArea) return 'administrative_area_unresolved';

  if (sourceArea.county_code && coordinateArea.county_code
      && sourceArea.county_code !== coordinateArea.county_code) {
    return 'coordinate_admin_area_mismatch';
  }
  const sourceAreaText = administrativeArea(record);
  if (textNamesTown(sourceAreaText, sourceArea)
      && sourceArea.town_code && coordinateArea.town_code
      && sourceArea.town_code !== coordinateArea.town_code) {
    return 'coordinate_admin_area_mismatch';
  }

  const address = fieldText(record, '避難收容處所地址', '地址', 'address');
  if (!address) return undefined;
  const addressArea = areaResolver({ '縣市及鄉鎮市區': address }, undefined);
  if (!addressArea) return undefined;

  const addressText = normalizeAreaText(address);
  const addressHasCounty = addressArea.county_name
    && addressText.includes(normalizeAreaText(addressArea.county_name));
  if (!addressHasCounty) return undefined;
  if (sourceArea.county_code && addressArea.county_code
      && sourceArea.county_code !== addressArea.county_code) {
    return 'address_area_mismatch';
  }
  if (coordinateArea.county_code && addressArea.county_code
      && coordinateArea.county_code !== addressArea.county_code) {
    return 'address_area_mismatch';
  }
  if (textNamesTown(address, addressArea)
      && addressArea.town_code && coordinateArea.town_code
      && addressArea.town_code !== coordinateArea.town_code) {
    return 'address_area_mismatch';
  }
  return undefined;
}

function incrementCountyMetric(metrics, countyCode, field) {
  const county = metrics.countyCounts.get(countyCode) ?? metrics.unassignedCounty;
  county[field] += 1;
}

function shelterId(record, index) {
  const value = firstValue(
    fieldText(record, '序號', '編號', '避難收容處所編號', '收容所編號', 'shelterCode', 'sheltercode', 'shelterId', 'shelterid', 'id', 'ID'),
    `${fieldText(record, '避難收容處所名稱', '收容所名稱', '名稱', 'name') ?? ''}:${fieldText(record, '避難收容處所地址', '地址', 'address') ?? ''}`,
  );
  if (!value) throw new ShelterSourceError(`shelter record ${index} has no stable identity`, { code: 'SHELTER_FEATURE_ID_MISSING' });
  return normalizeId(value, 'shelter identity', ShelterSourceError);
}

function twd97Tm2ToWgs84(x, y, centralMeridian = 121) {
  const a = 6378137;
  const eccentricitySquared = 0.00669438002290;
  const scale = 0.9999;
  const falseEasting = 250000;
  const falseNorthing = 0;
  const eccentricityPrimeSquared = eccentricitySquared / (1 - eccentricitySquared);
  const meridionalArc = (y - falseNorthing) / scale;
  const mu = meridionalArc / (a * (1 - eccentricitySquared / 4 - 3 * eccentricitySquared ** 2 / 64 - 5 * eccentricitySquared ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - eccentricitySquared)) / (1 + Math.sqrt(1 - eccentricitySquared));
  const footpointLatitude = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sine = Math.sin(footpointLatitude);
  const cosine = Math.cos(footpointLatitude);
  const tangent = Math.tan(footpointLatitude);
  const radiusPrime = a / Math.sqrt(1 - eccentricitySquared * sine ** 2);
  const radiusMeridian = a * (1 - eccentricitySquared) / (1 - eccentricitySquared * sine ** 2) ** 1.5;
  const distance = (x - falseEasting) / scale;
  const t = tangent ** 2;
  const c = eccentricityPrimeSquared * cosine ** 2;
  const d = distance / radiusPrime;
  const latitude = footpointLatitude - (radiusPrime * tangent / radiusMeridian) * (
    d ** 2 / 2
    - (5 + 3 * t + 10 * c - 4 * c ** 2 - 9 * eccentricityPrimeSquared) * d ** 4 / 24
    + (61 + 90 * t + 298 * c + 45 * t ** 2 - 252 * eccentricityPrimeSquared - 3 * c ** 2) * d ** 6 / 720
  );
  const longitude = (centralMeridian * Math.PI) / 180 + (
    d
    - (1 + 2 * t + c) * d ** 3 / 6
    + (5 - 2 * c + 28 * t - 3 * c ** 2 + 8 * eccentricityPrimeSquared + 24 * t ** 2) * d ** 5 / 120
  ) / cosine;
  return [longitude * 180 / Math.PI, latitude * 180 / Math.PI];
}

function shelterGeometry(record, index) {
  const latitude = Number(fieldText(record, '緯度', '緯度(WGS84)', 'Latitude', 'latitude', 'lat'));
  const longitude = Number(fieldText(record, '經度', '經度(WGS84)', 'Longitude', 'longitude', 'lon', 'lng'));
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { type: 'Point', coordinates: normalizeCoordinate([longitude, latitude]) };
    }
    // Some shelter rows publish longitude in lat and latitude in lon.
    if (Math.abs(latitude) <= 180 && Math.abs(longitude) <= 90) {
      return { type: 'Point', coordinates: normalizeCoordinate([latitude, longitude]) };
    }
    // A small subset uses TWD97 / TM2 coordinates in the lat/lon fields.
    if (longitude >= 150000 && longitude <= 400000 && latitude >= 2400000 && latitude <= 2900000) {
      const areaText = `${fieldText(record, '縣市', 'county', 'County') ?? ''}${fieldText(record, '鄉鎮市區', 'town', 'Town') ?? ''}`;
      const centralMeridian = /金門|連江/u.test(areaText) ? 119 : 121;
      return { type: 'Point', coordinates: normalizeCoordinate(twd97Tm2ToWgs84(longitude, latitude, centralMeridian)) };
    }
  }
  const geometry = pointFromFields(
    record,
    ShelterSourceError,
    ['緯度', '緯度(WGS84)', 'Latitude', 'latitude', 'lat'],
    ['經度', '經度(WGS84)', 'Longitude', 'longitude', 'lon', 'lng'],
  );
  if (!geometry) throw new ShelterSourceError(`shelter record ${index} has no coordinate`, { code: 'SHELTER_GEOMETRY_MISSING' });
  return geometry;
}

function normalizeShelterRecord(record, index, rawSnapshot, options, metrics) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ShelterSourceError(`shelter record ${index} must be an object`, { code: 'SHELTER_RECORD_INVALID' });
  }
  if (options.scope !== 'taiwan' && !isNeihuRecord(record)) {
    metrics.excluded_count += 1;
    metrics.excluded_reason_counts.outside_source_scope = (metrics.excluded_reason_counts.outside_source_scope ?? 0) + 1;
    return undefined;
  }
  const sourceArea = options.scope === 'taiwan'
    ? options.areaResolver(record, undefined)
    : undefined;
  if (options.scope === 'taiwan') incrementCountyMetric(metrics, sourceArea?.county_code, 'source_count');
  const id = shelterId(record, index);
  const geometry = shelterGeometry(record, index);
  if (!isInsideBoundary(geometry, options.boundary, ShelterSourceError)) {
    metrics.excluded_count += 1;
    metrics.excluded_reason_counts.outside_boundary = (metrics.excluded_reason_counts.outside_boundary ?? 0) + 1;
    if (options.scope === 'taiwan') incrementCountyMetric(metrics, sourceArea?.county_code, 'excluded_count');
    return undefined;
  }
  if (options.scope === 'taiwan') {
    const issue = shelterLocationIssue(record, geometry, options);
    if (issue) {
      metrics.unlocated_count += 1;
      metrics.location_issue_counts[issue] = (metrics.location_issue_counts[issue] ?? 0) + 1;
      incrementCountyMetric(metrics, sourceArea?.county_code, 'unlocated_count');
      return undefined;
    }
  }
  const name = fieldText(record, '避難收容處所名稱', '收容所名稱', '名稱', 'name');
  const address = fieldText(record, '避難收容處所地址', '地址', 'address');
  const area = areaMetadataForRecord(options, record, geometry);
  const capacity = Number(firstValue(fieldText(record, '預計收容人數', '收容人數', 'capacity', 'peopleno'), ''));
  const properties = {
    name: name ?? null,
    address: address ?? null,
    capacity: Number.isFinite(capacity) ? capacity : null,
    disaster_types: disasterTypes(record),
    administrative_area: administrativeArea(record) ?? null,
    ...area,
    ...(options.coverage ? { coverage: options.coverage } : {}),
    source_record: record,
  };
  const sourceVersionValue = sourceVersion(rawSnapshot, record, id);
  const feature = featureBase({
    datasetId: options.datasetId,
    layerId: 'shelter',
    featureId: `shelter:${id}`,
    featureType: 'SHELTER',
    geometry,
    properties,
    source: options.sourceId ?? rawSnapshot.source_id,
    sourceVersion: sourceVersionValue,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    options,
    originalSource: rawSnapshot.request.url,
  });
  metrics.located_count += 1;
  if (options.scope === 'taiwan') incrementCountyMetric(metrics, sourceArea?.county_code, 'located_count');
  return feature;
}

export function normalizeShelters(rawSnapshot, options = {}) {
  if (!options.boundary) throw new ShelterSourceError('Shelter scope boundary is required for curation', { code: 'SHELTER_BOUNDARY_MISSING' });
  const sourceId = options.sourceId ?? rawSnapshot.source_id;
  if (!['taipei-shelter', 'taiwan-shelter'].includes(sourceId)) {
    throw new ShelterSourceError(`shelter normalizer requires source_id=taipei-shelter or taiwan-shelter`, { code: 'STATIC_SOURCE_ID_INVALID' });
  }
  if (options.scope === 'taiwan' && typeof options.areaResolver !== 'function') {
    throw new ShelterSourceError('Taiwan shelter normalization requires county and town area resolution', {
      code: 'SHELTER_AREA_RESOLVER_REQUIRED',
    });
  }
  assertRawFeatureSnapshot(rawSnapshot, sourceId, ShelterSourceError);
  const times = staticTimes(rawSnapshot, options, ShelterSourceError);
  const normalizedOptions = { ...options, ...times };
  const records = recordsFromPayload(rawSnapshot.payload);
  const countyCounts = new Map(TAIWAN_COUNTIES.map(({ code, name }) => [code, {
    county_code: code,
    county_name: name,
    source_count: 0,
    located_count: 0,
    unlocated_count: 0,
    excluded_count: 0,
  }]));
  const metrics = {
    located_count: 0,
    unlocated_count: 0,
    excluded_count: 0,
    excluded_reason_counts: {},
    location_issue_counts: {},
    countyCounts,
    unassignedCounty: {
      county_code: null,
      county_name: '未辨識縣市',
      source_count: 0,
      located_count: 0,
      unlocated_count: 0,
      excluded_count: 0,
    },
  };
  const features = records
    .map((record, index) => normalizeShelterRecord(record, index, rawSnapshot, normalizedOptions, metrics))
    .filter(Boolean)
    .sort((left, right) => left.feature_id.localeCompare(right.feature_id));
  const { countyCounts: _countyCounts, unassignedCounty, ...summary } = metrics;
  return {
    features,
    source_count: records.length,
    ...summary,
    ...(options.scope === 'taiwan'
      ? { county_coverage: [...countyCounts.values(), unassignedCounty] }
      : {}),
  };
}

export function fetchShelters({
  endpoint = process.env.SHELTER_DATA_ENDPOINT ?? DEFAULT_SHELTER_ENDPOINT,
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
} = {}) {
  return fetchStaticText({
    sourceId: 'taipei-shelter',
    endpoint,
    fetchImpl,
    retrievedAt,
    ErrorClass: ShelterSourceError,
  });
}

export function fetchTaiwanShelters({
  endpoint = process.env.SHELTER_DATA_ENDPOINT ?? DEFAULT_SHELTER_ENDPOINT,
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
} = {}) {
  return fetchStaticText({
    sourceId: 'taiwan-shelter',
    endpoint,
    fetchImpl,
    retrievedAt,
    ErrorClass: ShelterSourceError,
  });
}
