import { createHash } from 'node:crypto';

import { TAIWAN_COUNTIES } from '../sources/taiwan-counties.mjs';

const CODE_FIELDS = [
  '機構代碼', '醫療機構代碼', '院所代碼', '醫事機構代碼', 'facility_code', 'institution_code', 'medical_id', 'id', 'ID',
];
const NAME_FIELDS = ['機構名稱', '醫療機構名稱', '院所名稱', '醫事機構名稱', '名稱', 'name'];
const ADDRESS_FIELDS = ['地址', '機構地址', '醫事機構地址', 'address'];
const AREA_FIELDS = ['縣市鄉鎮', '縣市及鄉鎮市區', '行政區', '行政區域', '縣市區名', 'administrative_area'];

function firstValue(record, fields) {
  for (const field of fields) {
    const value = record?.[field];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

function identifier(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, '-').slice(0, 220);
  if (normalized && /[a-z0-9]/u.test(normalized)) return normalized;
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
}

function recordCode(record) {
  return firstValue(record, CODE_FIELDS);
}

function countyMetadata(record, properties = {}) {
  const explicitCode = String(properties.county_code ?? firstValue(record, ['縣市代碼', '省市縣市代碼', 'county_code']) ?? '');
  const text = [
    properties.administrative_area,
    ...AREA_FIELDS.map((field) => record?.[field]),
    ...ADDRESS_FIELDS.map((field) => record?.[field]),
  ].filter(Boolean).join(' ').replaceAll('台', '臺');
  const county = TAIWAN_COUNTIES.find((entry) => entry.code === explicitCode)
    ?? [...TAIWAN_COUNTIES].sort((left, right) => right.name.length - left.name.length)
      .find((entry) => text.includes(entry.name));
  const townCode = properties.town_code
    ?? firstValue(record, ['鄉鎮市區代碼', '區代碼', 'areacode', 'town_code']);
  return {
    county_code: county?.code ?? null,
    town_code: townCode === null ? null : String(townCode),
  };
}

/** Convert MOHW rows into safe search-only features; never puts a location in geometry. */
export function buildMedicalDirectoryFeatures({
  locatedFeatures = [], unresolved = [], excluded = [], sourceVersion,
  sourceUrl = 'https://data.gov.tw/dataset/15393', issuedAt, expiresAt,
} = {}) {
  for (const [name, value] of Object.entries({ sourceVersion, issuedAt, expiresAt })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  }
  const rows = [
    ...locatedFeatures.map((feature) => ({ state: 'located', value: feature })),
    ...unresolved.map((record) => ({ state: 'unresolved', value: record })),
    ...excluded.map((record) => ({ state: 'excluded', value: record })),
  ];
  const identityOccurrences = new Map();
  const features = rows.map(({ state, value }) => {
    const sourceRecord = value?.source_record ?? value ?? {};
    const properties = value?.properties ?? {};
    const name = firstValue(properties, ['name']) ?? firstValue(sourceRecord, NAME_FIELDS);
    const address = firstValue(properties, ['address']) ?? firstValue(sourceRecord, ADDRESS_FIELDS);
    const administrativeArea = firstValue(properties, ['administrative_area'])
      ?? firstValue(sourceRecord, AREA_FIELDS);
    const identity = state === 'located'
      ? String(value.feature_id ?? '').replace(/^medical:/u, '')
      : value.medical_id ?? recordCode(sourceRecord) ?? `${name ?? ''}:${address ?? ''}`;
    if (!identity) throw new TypeError('medical directory record has no stable identity');
    const baseFeatureId = `medical-directory:${identifier(identity)}`;
    const occurrence = (identityOccurrences.get(baseFeatureId) ?? 0) + 1;
    identityOccurrences.set(baseFeatureId, occurrence);
    const county = countyMetadata(sourceRecord, properties);
    const featureProperties = {
      name,
      address,
      administrative_area: administrativeArea,
      county_code: properties.county_code ?? county.county_code,
      town_code: properties.town_code ?? county.town_code,
      facility_type: firstValue(properties, ['facility_type', 'departments'])
        ?? firstValue(sourceRecord, ['分類', '機構類別', '醫療類別', '醫事機構種類', '科別', 'category', 'type']),
      geometry_status: state,
      point_feature_id: state === 'located' ? value.feature_id : null,
      coordinate_failure_reason: state === 'unresolved'
        ? value.coordinate_failure_reason ?? 'no_coordinate_candidate'
        : state === 'excluded' ? 'outside_taiwan_boundary' : null,
    };
    return {
      schema_version: 'feature-v0',
      namespace: 'official.medical',
      dataset_id: 'resilientgeo-taiwan-medical-directory',
      layer_id: 'taiwan-medical-directory',
      feature_id: occurrence === 1 ? baseFeatureId : `${baseFeatureId}:${occurrence}`,
      feature_type: 'MEDICAL_DIRECTORY_ENTRY',
      geometry: null,
      properties: featureProperties,
      source: 'mohw-medical-master',
      source_version: sourceVersion,
      issued_at: issuedAt,
      expires_at: expiresAt,
      signature_algorithm: 'Ed25519',
      signing_key_id: 'server-medical-source',
      provenance: {
        original_source: sourceUrl,
        received_at: issuedAt,
        transport_source: { kind: 'server', node_id: 'medical-directory-collector' },
      },
    };
  });
  features.sort((left, right) => left.feature_id.localeCompare(right.feature_id));
  const ids = new Set();
  for (const feature of features) {
    if (ids.has(feature.feature_id)) throw new TypeError(`duplicate medical directory identity: ${feature.feature_id}`);
    ids.add(feature.feature_id);
  }
  return features;
}
