import {
  assertRawFeatureSnapshot,
  featureBase,
  fetchStaticBinary,
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
import { normalizeAddressBuildingKeys, normalizeAddressText } from '../lib/address-packs.mjs';
import { findReviewedMedicalAddressCorrection } from './medical-address-corrections.mjs';
import { TAIWAN_COUNTIES } from './taiwan-counties.mjs';

// data.gov.tw dataset 15393 currently links to this MOHW ODS resource. The
// annual file URL can change; override MEDICAL_DATA_ENDPOINT after the source
// page publishes a new resource. JSON/CSV mirrors remain supported.
export const DEFAULT_MEDICAL_ENDPOINT = 'https://www.mohw.gov.tw/dl-96581-66dbb751-f83a-416a-a998-893222e20fef.html';
export const DEFAULT_MEDICAL_FORMAT = 'ods';
const MAX_NEARBY_DOORPLATE_ALTERNATIVE_DISTANCE_METERS = 100;

function coordinateDistanceMeters(left, right) {
  if (![left, right].every((coordinates) => Array.isArray(coordinates)
    && coordinates.length === 2
    && coordinates.every((coordinate) => Number.isFinite(Number(coordinate))))) return Infinity;
  const radians = Math.PI / 180;
  const [leftLongitude, leftLatitude] = left.map((coordinate) => Number(coordinate) * radians);
  const [rightLongitude, rightLatitude] = right.map((coordinate) => Number(coordinate) * radians);
  const latitudeDelta = rightLatitude - leftLatitude;
  const longitudeDelta = rightLongitude - leftLongitude;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export class MedicalSourceError extends Error {
  constructor(message, { code = 'MEDICAL_SOURCE_ERROR', status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MedicalSourceError';
    this.code = code;
    this.status = status;
  }
}

function administrativeArea(record) {
  return fieldText(record, '行政區', '行政區域', '縣市鄉鎮', '縣市區名', '區', 'district', 'District');
}

function medicalId(record, index) {
  const value = firstValue(
    fieldText(record, '機構代碼', '醫療機構代碼', '院所代碼', '醫事機構代碼', '代碼', '_id', 'id', 'ID'),
    `${fieldText(record, '機構名稱', '醫療機構名稱', '院所名稱', '醫事機構名稱', '名稱', 'name') ?? ''}:${fieldText(record, '地址', '機構地址', '醫事機構地址', 'address') ?? ''}`,
  );
  if (!value) throw new MedicalSourceError(`medical record ${index} has no stable identity`, { code: 'MEDICAL_FEATURE_ID_MISSING' });
  return normalizeId(value, 'medical identity', MedicalSourceError);
}

function medicalGeometry(record, index) {
  const geometry = pointFromFields(
    record,
    MedicalSourceError,
    ['緯度', 'Latitude', 'latitude', 'lat', '緯度(WGS84)'],
    ['經度', 'Longitude', 'longitude', 'lon', 'lng', '經度(WGS84)'],
  );
  return geometry;
}

function isNeihuRecord(record) {
  const area = administrativeArea(record);
  const address = fieldText(record, '地址', '機構地址', 'address');
  return /內湖區/u.test(`${area ?? ''} ${address ?? ''}`);
}

function medicalFeatureType(category) {
  if (/(?:醫院|hospital)/iu.test(category ?? '')) return 'HOSPITAL';
  if (/(?:診所|clinic)/iu.test(category ?? '')) return 'CLINIC';
  return 'MEDICAL_FACILITY';
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

function normalizeMedicalRecord(record, index, rawSnapshot, options) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new MedicalSourceError(`medical record ${index} must be an object`, { code: 'MEDICAL_RECORD_INVALID' });
  }
  if (options.scope !== 'taiwan' && !isNeihuRecord(record)) return undefined;
  const id = medicalId(record, index);
  const geometry = medicalGeometry(record, index);
  const name = fieldText(record, '機構名稱', '醫療機構名稱', '院所名稱', '醫事機構名稱', '名稱', 'name');
  const address = fieldText(record, '地址', '機構地址', '醫事機構地址', 'address');
  const phone = fieldText(record, '電話', '聯絡電話', '機構電話', '電話號碼', 'phone', 'telephone');
  const category = fieldText(record, '分類', '機構類別', '醫療類別', '醫事機構種類', '科別', 'department', 'departments', 'category', 'type');
  const recordSourceVersion = sourceVersion(rawSnapshot, record, id);
  if (!geometry) {
    if (options.allowUnresolved) {
      return {
        unresolved: {
          medical_id: id,
          name: name ?? null,
          address: address ?? null,
          geometry_status: 'unresolved',
          source_record: record,
        },
      };
    }
    throw new MedicalSourceError(`medical record ${index} has no coordinate`, { code: 'MEDICAL_GEOMETRY_MISSING' });
  }
  if (!isInsideBoundary(geometry, options.boundary, MedicalSourceError)) return undefined;
  const area = areaMetadataForRecord(options, record, geometry);
  return featureBase({
    datasetId: options.datasetId,
    layerId: 'medical',
    featureId: `medical:${id}`,
    featureType: medicalFeatureType(category),
    geometry,
    properties: {
      name: name ?? null,
      address: address ?? null,
      phone: phone ?? null,
      departments: category ?? null,
      administrative_area: administrativeArea(record) ?? null,
      facility_type: category ?? null,
      ...area,
      ...(options.coverage ? { coverage: options.coverage } : {}),
      coordinate_source: 'mohw-medical-master',
      coordinate_source_version: recordSourceVersion,
      coordinate_match_method: 'source_coordinates',
      source_record: record,
    },
    source: options.sourceId ?? rawSnapshot.source_id,
    sourceVersion: recordSourceVersion,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    options,
    originalSource: rawSnapshot.request.url,
  });
}

export function normalizeMedicalFacilities(rawSnapshot, options = {}) {
  return normalizeMedicalFacilitiesReport(rawSnapshot, {
    ...options,
    allowUnresolved: false,
  }).features;
}

export function normalizeMedicalFacilitiesReport(rawSnapshot, options = {}) {
  if (!options.boundary) throw new MedicalSourceError('Medical scope boundary is required for curation', { code: 'MEDICAL_BOUNDARY_MISSING' });
  const sourceId = options.sourceId ?? rawSnapshot.source_id;
  if (!['taipei-medical', 'taiwan-medical'].includes(sourceId)) {
    throw new MedicalSourceError('medical normalizer requires source_id=taipei-medical or taiwan-medical', { code: 'STATIC_SOURCE_ID_INVALID' });
  }
  assertRawFeatureSnapshot(rawSnapshot, sourceId, MedicalSourceError);
  const times = staticTimes(rawSnapshot, options, MedicalSourceError);
  const normalizedOptions = {
    ...options,
    ...times,
    allowUnresolved: options.allowUnresolved ?? true,
  };
  const sourceRecords = recordsFromPayload(rawSnapshot.payload);
  const normalized = sourceRecords
    .map((record, index) => normalizeMedicalRecord(record, index, rawSnapshot, normalizedOptions));
  const results = normalized.filter(Boolean);
  return {
    source_count: sourceRecords.length,
    features: results
      .filter((result) => !result.unresolved)
      .sort((left, right) => left.feature_id.localeCompare(right.feature_id)),
    unresolved: results
      .filter((result) => result.unresolved)
      .map((result) => result.unresolved),
    excluded: normalized
      .map((result, index) => result === undefined ? sourceRecords[index] : undefined)
      .filter(Boolean),
  };
}

function comparableText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replaceAll('台', '臺');
}

function coordinateFeatureText(feature) {
  const properties = feature?.properties ?? {};
  const tags = properties.tags ?? {};
  return {
    name: comparableText(firstValue(properties.name, tags.name)),
    address: comparableText(firstValue(properties.address, tags['addr:full'], tags['addr:street'])),
  };
}

const MEDICAL_CODE_FIELDS = [
  '機構代碼', '醫療機構代碼', '院所代碼', '醫事機構代碼', '代碼',
  'facility_code', 'institution_code', 'medical_id', 'id', 'ID',
];
const INSTITUTION_CODE_FIELDS = [
  '機構代碼', '醫療機構代碼', '院所代碼', '醫事機構代碼', '代碼',
  'facility_code', 'institution_code', 'medical_id',
];
const VERIFIED_MEDICAL_MATCH_METHODS = new Set([
  'exact_address_doorplate',
  'institution_code',
  'name_address',
  'reviewed_address_correction',
  'source_coordinates',
]);

export function normalizedMedicalInstitutionCode(value) {
  const properties = value?.properties ?? {};
  const sourceRecord = value?.source_record ?? properties.source_record ?? value ?? {};
  return comparableText(firstValue(...INSTITUTION_CODE_FIELDS.map((field) =>
    sourceRecord?.[field] ?? properties?.[field])));
}

export function isVerifiedMedicalCoordinateMatchMethod(value) {
  return VERIFIED_MEDICAL_MATCH_METHODS.has(value);
}

function medicalRecordCode(record) {
  return comparableText(firstValue(...MEDICAL_CODE_FIELDS.map((field) => record?.[field])));
}

function coordinateFeatureCode(feature) {
  const properties = feature?.properties ?? {};
  return medicalRecordCode({ ...properties.source_record, ...properties });
}

function unresolvedCode(unresolved) {
  const sourceRecordCode = medicalRecordCode(unresolved?.source_record);
  if (sourceRecordCode) return sourceRecordCode;
  const candidate = comparableText(unresolved?.medical_id);
  return candidate && !candidate.includes(':') ? candidate : '';
}

function reviewedEmergencyMapping(mapping) {
  if (!mapping || typeof mapping !== 'object'
    || typeof mapping.roster_id !== 'string' || !mapping.roster_id
    || typeof mapping.institution_code !== 'string' || !/^\d{10}$/u.test(mapping.institution_code)
    || typeof mapping.evidence_version !== 'string' || !mapping.evidence_version
    || typeof mapping.reviewer !== 'string' || !mapping.reviewer
    || typeof mapping.reviewed_at !== 'string' || Number.isNaN(Date.parse(mapping.reviewed_at))) return false;
  try {
    return new URL(mapping.evidence_url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function reconcileEmergencyMedicalFacilities({
  roster,
  crosswalk,
  medicalFeatures = [],
  unresolvedMedical = [],
  now = new Date(),
  expiresAt,
} = {}) {
  if (roster?.schema_version !== 'emergency-medical-roster-v1'
    || typeof roster.source_version !== 'string' || !roster.source_version
    || !Array.isArray(roster.facilities)) {
    throw new MedicalSourceError('emergency medical roster is invalid', { code: 'EMERGENCY_MEDICAL_ROSTER_INVALID' });
  }
  if (typeof roster.source_url !== 'string' || new URL(roster.source_url).protocol !== 'https:') {
    throw new MedicalSourceError('emergency medical roster source URL is invalid', { code: 'EMERGENCY_MEDICAL_SOURCE_INVALID' });
  }
  if (crosswalk?.schema_version !== 'emergency-medical-crosswalk-v1'
    || !Array.isArray(crosswalk.mappings)
    || typeof crosswalk.version !== 'string' || !crosswalk.version) {
    throw new MedicalSourceError('emergency medical crosswalk is invalid', { code: 'EMERGENCY_MEDICAL_CROSSWALK_INVALID' });
  }
  const currentTime = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(currentTime.getTime())) throw new TypeError('now must be a valid date');
  const ids = new Set();
  for (const facility of roster.facilities) {
    if (!facility || typeof facility.roster_id !== 'string' || !facility.roster_id
      || typeof facility.name !== 'string' || !facility.name
      || typeof facility.county !== 'string' || !facility.county
      || typeof facility.emergency_level !== 'string' || !facility.emergency_level
      || ids.has(facility.roster_id)) {
      throw new MedicalSourceError('emergency medical facility row is invalid or duplicated', { code: 'EMERGENCY_MEDICAL_ROW_INVALID' });
    }
    ids.add(facility.roster_id);
  }

  const mappingsByRoster = new Map();
  const validMappings = crosswalk.mappings.filter(reviewedEmergencyMapping);
  const targetCounts = new Map();
  for (const mapping of validMappings) {
    const rows = mappingsByRoster.get(mapping.roster_id) ?? [];
    rows.push(mapping);
    mappingsByRoster.set(mapping.roster_id, rows);
    targetCounts.set(mapping.institution_code, (targetCounts.get(mapping.institution_code) ?? 0) + 1);
  }
  const featuresByCode = new Map();
  for (const feature of medicalFeatures) {
    const code = medicalRecordCode({ ...feature?.properties?.source_record, ...feature?.properties });
    if (!code) continue;
    const matches = featuresByCode.get(code) ?? [];
    matches.push(feature);
    featuresByCode.set(code, matches);
  }
  const unresolvedByCode = new Map();
  for (const row of unresolvedMedical) {
    const code = unresolvedCode(row);
    if (code) unresolvedByCode.set(code, row);
  }
  const counts = {
    no_coordinate_candidate: 0,
    name_address_mismatch: 0,
    multiple_candidates: 0,
    source_missing: 0,
  };
  const features = [];
  for (const facility of roster.facilities) {
    const mappings = mappingsByRoster.get(facility.roster_id) ?? [];
    if (mappings.length !== 1 || targetCounts.get(mappings[0]?.institution_code) !== 1) {
      counts[mappings.length > 1 || mappings.length === 1 ? 'multiple_candidates' : 'source_missing'] += 1;
      continue;
    }
    const { institution_code: code } = mappings[0];
    const candidates = featuresByCode.get(code) ?? [];
    if (candidates.length > 1) {
      counts.multiple_candidates += 1;
      continue;
    }
    const candidate = candidates[0];
    const coordinateSource = candidate?.properties?.coordinate_source;
    if (!candidate) {
      const unresolved = unresolvedByCode.get(code);
      const reason = unresolved?.coordinate_failure_reason;
      counts[['no_coordinate_candidate', 'name_address_mismatch', 'multiple_candidates', 'source_missing'].includes(reason)
        ? reason
        : 'no_coordinate_candidate'] += 1;
      continue;
    }
    if (candidate.geometry?.type !== 'Point' || typeof coordinateSource !== 'string'
      || !coordinateSource || /\bosm\b/iu.test(coordinateSource)) {
      counts.no_coordinate_candidate += 1;
      continue;
    }
    const sourceProperties = candidate.properties ?? {};
    const allowedProperties = Object.fromEntries([
      'name', 'address', 'administrative_area', 'county_code', 'town_code', 'area_id', 'coverage',
    ].filter((key) => sourceProperties[key] !== undefined).map((key) => [key, sourceProperties[key]]));
    features.push({
      schema_version: 'feature-v0',
      namespace: 'official.emergency-medical',
      dataset_id: 'resilientgeo-emergency-medical',
      layer_id: 'taiwan-emergency-medical',
      feature_id: `emergency-medical:${facility.roster_id}`,
      feature_type: 'HOSPITAL',
      geometry: structuredClone(candidate.geometry),
      properties: {
        ...allowedProperties,
        institution_code: code,
        emergency_level: facility.emergency_level,
        emergency_medical_roster_id: facility.roster_id,
        coordinate_source: coordinateSource,
        coordinate_match_method: sourceProperties.coordinate_match_method ?? null,
      },
      source: 'mohw-emergency-medical-roster',
      source_version: roster.source_version,
      issued_at: currentTime.toISOString(),
      expires_at: expiresAt ?? new Date(currentTime.getTime() + 24 * 60 * 60_000).toISOString(),
      signature_algorithm: 'Ed25519',
      signing_key_id: 'server-medical-source',
      provenance: {
        original_source: roster.source_url,
        received_at: roster.retrieved_at ?? roster.updated_at ?? currentTime.toISOString(),
        transport_source: { kind: 'server', node_id: 'medical-emergency-collector' },
      },
    });
  }
  features.sort((left, right) => left.feature_id.localeCompare(right.feature_id));
  const unresolvedCount = roster.facilities.length - features.length;
  return {
    features,
    report: {
      source_version: roster.source_version,
      crosswalk_version: crosswalk.version,
      hospital_count: roster.facilities.length,
      located_count: features.length,
      unresolved_count: unresolvedCount,
      unresolved_reason_counts: counts,
      coverage: roster.facilities.length > 0 && unresolvedCount === 0 ? 'complete' : 'partial',
    },
  };
}

function medicalMatchScore(unresolved, candidate) {
  const left = {
    name: comparableText(unresolved.name),
    address: unresolved.address,
  };
  const right = coordinateFeatureText(candidate);
  if (!left.name || !right.name || left.name !== right.name) return 0;
  return sameBuildingDoorplate(left.address, right.address) ? 2 : 0;
}

function sameBuildingDoorplate(leftAddress, rightAddress) {
  const leftKeys = new Set(normalizeAddressBuildingKeys(leftAddress));
  if (leftKeys.size === 0) return false;
  return normalizeAddressBuildingKeys(rightAddress).some((key) => leftKeys.has(key));
}

function countyFromMedicalText(value) {
  const text = comparableText(value);
  return text.match(/(?:臺北市|新北市|桃園市|臺中市|臺南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|澎湖縣|金門縣|連江縣)/u)?.[0] ?? null;
}

function countyCodeFromMedicalText(value) {
  const name = countyFromMedicalText(value);
  return TAIWAN_COUNTIES.find((county) => county.name === name)?.code ?? null;
}

function medicalCandidateMatchesAddress(unresolved, candidate, options) {
  const left = {
    name: comparableText(unresolved.name),
    address: unresolved.address,
  };
  const candidateText = coordinateFeatureText(candidate);
  if (!left.name || left.name !== candidateText.name
    || !sameBuildingDoorplate(left.address, candidateText.address)) {
    return false;
  }
  const leftCounty = countyFromMedicalText([
    administrativeArea(unresolved.source_record), unresolved.address,
  ].filter(Boolean).join(' '));
  const rightCounty = countyFromMedicalText([
    candidate?.properties?.administrative_area,
    candidateText.address,
  ].filter(Boolean).join(' '));
  if (leftCounty && rightCounty && leftCounty !== rightCounty) return false;
  const leftCountyCode = countyCodeFromMedicalText([
    administrativeArea(unresolved.source_record), unresolved.address,
  ].filter(Boolean).join(' '));
  const rightCountyCode = String(candidate?.properties?.county_code ?? '');
  if (leftCountyCode && rightCountyCode && leftCountyCode !== rightCountyCode) return false;

  const leftArea = options.areaResolver?.(unresolved.source_record, undefined);
  const rightArea = options.areaResolver?.(candidate?.properties?.source_record ?? candidate?.properties, candidate?.geometry);
  return !(leftArea?.county_code && rightArea?.county_code && leftArea.county_code !== rightArea.county_code);
}

export function mergeMedicalCoordinates(report, coordinateFeatures, options = {}) {
  if (!report || !Array.isArray(report.features) || !Array.isArray(report.unresolved)) {
    throw new MedicalSourceError('medical coordinate supplement requires a medical normalization report', { code: 'MEDICAL_REPORT_INVALID' });
  }
  if (!Array.isArray(coordinateFeatures)) {
    throw new MedicalSourceError('medical coordinate supplement requires a feature array', { code: 'MEDICAL_COORDINATE_INPUT_INVALID' });
  }
  if (!options.rawSnapshot) {
    throw new MedicalSourceError('medical coordinate supplement requires the original Raw snapshot', { code: 'MEDICAL_RAW_REQUIRED' });
  }
  const times = staticTimes(options.rawSnapshot, options, MedicalSourceError);
  const normalizedOptions = {
    ...options,
    ...times,
    allowUnresolved: false,
  };
  const coordinateFeaturesByCode = new Map();
  const coordinateFeaturesByName = new Map();
  for (const feature of coordinateFeatures) {
    const code = coordinateFeatureCode(feature);
    if (code) {
      const matches = coordinateFeaturesByCode.get(code) ?? [];
      matches.push(feature);
      coordinateFeaturesByCode.set(code, matches);
    }
    const name = coordinateFeatureText(feature).name;
    if (name) {
      const matches = coordinateFeaturesByName.get(name) ?? [];
      matches.push(feature);
      coordinateFeaturesByName.set(name, matches);
    }
  }
  const addressCoordinateFeatures = Array.isArray(options.addressCoordinateFeatures)
    ? options.addressCoordinateFeatures
    : [];
  const addressCoordinateFeaturesByKey = new Map();
  for (const feature of addressCoordinateFeatures) {
    if (feature?.geometry?.type !== 'Point') continue;
    const properties = feature.properties ?? {};
    const keys = new Set([
      properties.address,
      ...(Array.isArray(properties.aliases) ? properties.aliases : []),
      ...(Array.isArray(properties.matched_address_keys) ? properties.matched_address_keys : []),
    ].flatMap(normalizeAddressBuildingKeys).filter(Boolean));
    for (const key of keys) {
      const matches = addressCoordinateFeaturesByKey.get(key) ?? [];
      matches.push(feature);
      addressCoordinateFeaturesByKey.set(key, matches);
    }
  }
  const supplemented = [];
  const remaining = [];
  const unresolvedReasonCounts = {
    no_coordinate_candidate: 0,
    name_address_mismatch: 0,
    multiple_candidates: 0,
    source_missing: 0,
  };
  for (const unresolved of report.unresolved) {
    const code = unresolvedCode(unresolved);
    const codeCandidates = code ? coordinateFeaturesByCode.get(code) ?? [] : [];
    let candidates = codeCandidates.length > 0
      ? codeCandidates
        .filter((feature) => medicalCandidateMatchesAddress(unresolved, feature, options))
        .map((feature) => ({ feature, score: 3, method: 'institution_code' }))
      : [];
    if (candidates.length === 0) candidates = (coordinateFeaturesByName.get(comparableText(unresolved.name)) ?? [])
      .filter((feature) => feature?.geometry?.type === 'Point')
      .filter((feature) => medicalCandidateMatchesAddress(unresolved, feature, options))
      .map((feature) => ({ feature, score: medicalMatchScore(unresolved, feature) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    const addressCorrection = findReviewedMedicalAddressCorrection(unresolved);
    const unresolvedAddresses = new Set(normalizeAddressBuildingKeys(
      addressCorrection?.correctedAddress ?? unresolved.address,
    ));
    const unresolvedCounty = countyFromMedicalText([
      administrativeArea(unresolved.source_record), unresolved.address,
    ].filter(Boolean).join(' '));
    if (unresolvedAddresses.size > 0 && unresolvedCounty) {
      const unresolvedCountyCode = countyCodeFromMedicalText([
        administrativeArea(unresolved.source_record), unresolved.address,
      ].filter(Boolean).join(' '));
      const candidatesByDoorplate = new Map();
      for (const key of unresolvedAddresses) {
        const uniqueByCoordinate = new Map();
        for (const feature of addressCoordinateFeaturesByKey.get(key) ?? []) {
          if (countyFromMedicalText(feature?.properties?.administrative_area) !== unresolvedCounty) continue;
          if (unresolvedCountyCode && feature?.properties?.county_code
            && String(feature.properties.county_code) !== unresolvedCountyCode) continue;
          const coordinates = feature.geometry.coordinates;
          const coordinateKey = Array.isArray(coordinates) && coordinates.length === 2
            ? `${Number(coordinates[0])},${Number(coordinates[1])}`
            : `invalid:${uniqueByCoordinate.size}`;
          if (!uniqueByCoordinate.has(coordinateKey)) {
            uniqueByCoordinate.set(coordinateKey, {
              feature,
              score: 4,
              method: addressCorrection ? 'reviewed_address_correction' : 'exact_address_doorplate',
            });
          }
        }
        if (uniqueByCoordinate.size > 0) candidatesByDoorplate.set(key, uniqueByCoordinate);
      }
      const exactAddressCandidates = [...candidatesByDoorplate.values()]
        .flatMap((candidatesForDoorplate) => [...candidatesForDoorplate.values()]);
      if (exactAddressCandidates.length > 0) {
        const uniqueByCoordinate = new Map();
        for (const candidate of exactAddressCandidates) {
          const coordinates = candidate.feature.geometry.coordinates;
          const coordinateKey = Array.isArray(coordinates) && coordinates.length === 2
            ? `${Number(coordinates[0])},${Number(coordinates[1])}`
            : null;
          const identity = coordinateKey ?? `invalid:${uniqueByCoordinate.size}`;
          if (!uniqueByCoordinate.has(identity)) uniqueByCoordinate.set(identity, candidate);
        }
        candidates = [...uniqueByCoordinate.values()];
        const candidateCoordinates = candidates.map((candidate) => candidate.feature.geometry.coordinates);
        let maximumDistanceMeters = 0;
        for (let left = 0; left < candidateCoordinates.length; left += 1) {
          for (let right = left + 1; right < candidateCoordinates.length; right += 1) {
            maximumDistanceMeters = Math.max(
              maximumDistanceMeters,
              coordinateDistanceMeters(candidateCoordinates[left], candidateCoordinates[right]),
            );
          }
        }
        if ((unresolvedAddresses.size > 1 || candidates.length > 1)
          && maximumDistanceMeters <= MAX_NEARBY_DOORPLATE_ALTERNATIVE_DISTANCE_METERS) {
          const firstListedCandidate = [...candidatesByDoorplate.values()]
            .map((candidatesForDoorplate) => candidatesForDoorplate.values().next().value)
            .find(Boolean);
          candidates = [{
            ...firstListedCandidate,
            method: unresolvedAddresses.size > 1
              ? 'nearby_address_doorplate_alternative'
              : 'nearby_address_candidate',
          }];
        }
      }
    }
    const topScore = candidates[0]?.score ?? 0;
    const topCount = candidates.filter((entry) => entry.score === topScore).length;
    if (topScore === 0 || topCount !== 1) {
      const reason = options.coordinateSourceMissing === true
        ? 'source_missing'
        : topScore > 0 && topCount > 1 || codeCandidates.length > 1
          ? 'multiple_candidates'
          : coordinateFeatures.length === 0
            ? 'no_coordinate_candidate'
            : 'name_address_mismatch';
      unresolvedReasonCounts[reason] += 1;
      remaining.push({ ...unresolved, coordinate_failure_reason: reason });
      continue;
    }
    const geometry = candidates[0].feature.geometry;
    const [longitude, latitude] = geometry.coordinates;
    const record = {
      ...unresolved.source_record,
      經度: String(longitude),
      緯度: String(latitude),
    };
    const feature = normalizeMedicalRecord(record, -1, options.rawSnapshot, normalizedOptions);
    if (!feature || feature.unresolved) {
      unresolvedReasonCounts.name_address_mismatch += 1;
      remaining.push({ ...unresolved, coordinate_failure_reason: 'name_address_mismatch' });
      continue;
    }
    const candidateProperties = candidates[0].feature.properties ?? {};
    if (addressCorrection) {
      feature.properties.address = addressCorrection.correctedAddress;
      feature.properties.coordinate_match_correction_id = addressCorrection.id;
    }
    feature.properties.coordinate_source = options.coordinateSource
      ?? candidateProperties.coordinate_source
      ?? 'official-medical-coordinate';
    feature.properties.coordinate_source_version = options.coordinateSourceVersion
      ?? candidateProperties.coordinate_source_version
      ?? options.rawSnapshot.retrieved_at;
    feature.properties.coordinate_match_method = candidates[0].method ?? 'name_address';
    supplemented.push(feature);
  }
  return {
    features: [...report.features, ...supplemented].sort((left, right) => left.feature_id.localeCompare(right.feature_id)),
    unresolved: remaining,
    unresolved_reason_counts: unresolvedReasonCounts,
    supplemented_count: supplemented.length,
  };
}

function sourceRecordForMedicalRow(row) {
  if (row.kind === 'point') return row.value?.properties?.source_record ?? {};
  if (row.kind === 'unresolved') return row.value?.source_record ?? {};
  return row.value ?? {};
}

function directoryOnlyMedicalRow(row, reason) {
  if (row.kind === 'unresolved') {
    return { ...row.value, coordinate_failure_reason: reason };
  }
  const sourceRecord = sourceRecordForMedicalRow(row);
  const properties = row.kind === 'point' ? row.value?.properties ?? {} : {};
  const code = normalizedMedicalInstitutionCode(sourceRecord);
  return {
    medical_id: code || row.value?.feature_id || null,
    name: properties.name ?? fieldText(sourceRecord, '機構名稱', '醫療機構名稱', '院所名稱', '醫事機構名稱', '名稱', 'name') ?? null,
    address: properties.address ?? fieldText(sourceRecord, '地址', '機構地址', '醫事機構地址', 'address') ?? null,
    geometry_status: 'unresolved',
    coordinate_failure_reason: reason,
    source_record: sourceRecord,
  };
}

/** Keep only points with an institution code and a unique code/feature identity. */
export function partitionMedicalIdentityConflicts({ features = [], unresolved = [], excluded = [] } = {}) {
  if (![features, unresolved, excluded].every(Array.isArray)) {
    throw new MedicalSourceError('medical identity partition requires arrays', { code: 'MEDICAL_IDENTITY_INPUT_INVALID' });
  }
  const rows = [
    ...features.map((value) => ({ kind: 'point', value })),
    ...unresolved.map((value) => ({ kind: 'unresolved', value })),
    ...excluded.map((value) => ({ kind: 'excluded', value })),
  ];
  const codeGroups = new Map();
  for (const row of rows) {
    const code = normalizedMedicalInstitutionCode(sourceRecordForMedicalRow(row));
    if (!code) continue;
    const group = codeGroups.get(code) ?? [];
    group.push(row);
    codeGroups.set(code, group);
  }
  const duplicateCodeRows = new Set();
  let duplicateInstitutionCodeGroupCount = 0;
  let duplicateInstitutionCodeAffectedRowCount = 0;
  let duplicateInstitutionCodeExtraRowCount = 0;
  for (const group of codeGroups.values()) {
    if (group.length < 2) continue;
    duplicateInstitutionCodeGroupCount += 1;
    duplicateInstitutionCodeAffectedRowCount += group.length;
    duplicateInstitutionCodeExtraRowCount += group.length - 1;
    group.forEach((row) => duplicateCodeRows.add(row));
  }

  const featureIdGroups = new Map();
  for (const row of rows.filter((entry) => entry.kind === 'point')) {
    const featureId = row.value?.feature_id;
    if (typeof featureId !== 'string' || featureId.length === 0) continue;
    const group = featureIdGroups.get(featureId) ?? [];
    group.push(row);
    featureIdGroups.set(featureId, group);
  }
  const duplicatePointIdRows = new Set();
  let duplicatePointIdGroupCount = 0;
  let duplicatePointIdAffectedRowCount = 0;
  let duplicatePointIdExtraRowCount = 0;
  for (const group of featureIdGroups.values()) {
    if (group.length < 2) continue;
    duplicatePointIdGroupCount += 1;
    duplicatePointIdAffectedRowCount += group.length;
    duplicatePointIdExtraRowCount += group.length - 1;
    group.forEach((row) => duplicatePointIdRows.add(row));
  }

  const safeFeatures = [];
  const safeUnresolved = [];
  const safeExcluded = [];
  let identityConflictCount = 0;
  for (const row of rows) {
    const sourceRecord = sourceRecordForMedicalRow(row);
    const code = normalizedMedicalInstitutionCode(sourceRecord);
    let identityReason = null;
    if (duplicateCodeRows.has(row)) identityReason = 'duplicate_institution_code';
    else if (duplicatePointIdRows.has(row)) identityReason = 'duplicate_point_id';
    else if (row.kind === 'point' && !code) identityReason = 'missing_institution_code';

    if (identityReason) {
      identityConflictCount += 1;
      safeUnresolved.push(directoryOnlyMedicalRow(row, identityReason));
    } else if (row.kind === 'point' && !isVerifiedMedicalCoordinateMatchMethod(
      row.value?.properties?.coordinate_match_method,
    )) {
      safeUnresolved.push(directoryOnlyMedicalRow(row, 'unverified_coordinate_match'));
    } else if (row.kind === 'point') safeFeatures.push(row.value);
    else if (row.kind === 'unresolved') safeUnresolved.push(row.value);
    else safeExcluded.push(row.value);
  }

  const unresolvedReasonCounts = {
    no_coordinate_candidate: 0,
    name_address_mismatch: 0,
    multiple_candidates: 0,
    source_missing: 0,
    duplicate_institution_code: 0,
    duplicate_point_id: 0,
    missing_institution_code: 0,
    unverified_coordinate_match: 0,
  };
  for (const row of safeUnresolved) {
    const reason = row.coordinate_failure_reason;
    if (Object.hasOwn(unresolvedReasonCounts, reason)) unresolvedReasonCounts[reason] += 1;
    else unresolvedReasonCounts.no_coordinate_candidate += 1;
  }

  return {
    features: safeFeatures.sort((left, right) => left.feature_id.localeCompare(right.feature_id)),
    unresolved: safeUnresolved,
    excluded: safeExcluded,
    identity_conflict_count: identityConflictCount,
    duplicate_institution_code_group_count: duplicateInstitutionCodeGroupCount,
    duplicate_institution_code_affected_row_count: duplicateInstitutionCodeAffectedRowCount,
    duplicate_institution_code_extra_row_count: duplicateInstitutionCodeExtraRowCount,
    duplicate_point_id_group_count: duplicatePointIdGroupCount,
    duplicate_point_id_affected_row_count: duplicatePointIdAffectedRowCount,
    duplicate_point_id_extra_row_count: duplicatePointIdExtraRowCount,
    unresolved_reason_counts: unresolvedReasonCounts,
  };
}

export function fetchMedicalFacilities({
  sourceId = process.env.MEDICAL_SOURCE_ID ?? 'taiwan-medical',
  endpoint = process.env.MEDICAL_DATA_ENDPOINT ?? DEFAULT_MEDICAL_ENDPOINT,
  format = process.env.MEDICAL_DATA_FORMAT ?? (endpoint === DEFAULT_MEDICAL_ENDPOINT ? DEFAULT_MEDICAL_FORMAT : 'json'),
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString(),
  limit = 1000,
  offset = 0,
} = {}) {
  if (format.toLowerCase() === 'ods') {
    return fetchStaticBinary({
      sourceId,
      endpoint,
      fetchImpl,
      retrievedAt,
      ErrorClass: MedicalSourceError,
      format: 'ods',
    });
  }
  return fetchStaticText({
    sourceId,
    endpoint,
    query: { limit, offset },
    fetchImpl,
    retrievedAt,
    ErrorClass: MedicalSourceError,
  });
}
