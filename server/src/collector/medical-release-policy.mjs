import { TAIWAN_COUNTIES } from '../../../pipeline/sources/taiwan-counties.mjs';

const PUBLISHABLE_STATUSES = new Set(['ok', 'not_modified']);
const INSTITUTION_CODE_FIELDS = [
  '機構代碼', '醫療機構代碼', '院所代碼', '醫事機構代碼',
  'facility_code', 'institution_code', 'medical_id', 'id', 'ID',
];
const AREA_TEXT_FIELDS = [
  '縣市', '縣市名稱', '縣市鄉鎮', '縣市及鄉鎮市區', '行政區', '行政區域',
  '縣市區名', '地址', '機構地址', '醫事機構地址', 'address',
];
const COUNTY_BY_CODE = new Map(TAIWAN_COUNTIES.map((county) => [county.code, county]));
const VERIFIED_COORDINATE_SOURCES = new Set([
  'mohw-medical-master',
  'nlsc-medical-coordinates',
  'official-medical-coordinate',
]);
const VERIFIED_MATCH_METHODS = new Set([
  'exact_address_doorplate',
  'institution_code',
  'name_address',
  'source_coordinates',
]);

function normalizedInstitutionCode(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, '-').slice(0, 240);
}

function institutionCode(feature) {
  const sourceRecord = feature?.properties?.source_record ?? {};
  const properties = feature?.properties ?? {};
  for (const key of INSTITUTION_CODE_FIELDS) {
    const value = sourceRecord[key] ?? properties[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return normalizedInstitutionCode(value);
    }
  }
  return '';
}

function consistentCounty(feature) {
  const properties = feature?.properties ?? {};
  const code = String(properties.county_code ?? '');
  const county = COUNTY_BY_CODE.get(code);
  if (!county) return false;
  const areaText = [properties.administrative_area, ...AREA_TEXT_FIELDS
    .map((field) => properties.source_record?.[field])]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .replaceAll('台', '臺');
  const namedCounties = TAIWAN_COUNTIES.filter((entry) => areaText.includes(entry.name));
  return namedCounties.every((entry) => entry.code === county.code);
}

function validPoint(feature) {
  const properties = feature?.properties ?? {};
  const coordinates = feature?.geometry?.coordinates;
  const coordinateSource = properties.coordinate_source;
  return feature?.geometry?.type === 'Point'
    && Array.isArray(coordinates)
    && coordinates.length === 2
    && Number.isFinite(coordinates[0])
    && Number.isFinite(coordinates[1])
    && coordinates[0] >= 118 && coordinates[0] <= 122.2
    && coordinates[1] >= 21.8 && coordinates[1] <= 26.5
    && typeof coordinateSource === 'string'
    && (VERIFIED_COORDINATE_SOURCES.has(coordinateSource)
      || /^official-doorplate:\d{5}$/u.test(coordinateSource))
    && !/\bosm\b/iu.test(properties.coordinate_source)
    && typeof properties.coordinate_source_version === 'string'
    && properties.coordinate_source_version.trim() !== ''
    && VERIFIED_MATCH_METHODS.has(properties.coordinate_match_method)
    && consistentCounty(feature);
}

function completeCountyCoverage(coverage, sourceCount) {
  if (!coverage || coverage.status !== 'complete' || coverage.county_count !== TAIWAN_COUNTIES.length
    || !Array.isArray(coverage.counties) || coverage.counties.length !== TAIWAN_COUNTIES.length
    || coverage.source_count !== sourceCount || coverage.located_count !== sourceCount
    || coverage.unlocated_count !== 0 || coverage.excluded_count !== 0 || coverage.unassigned_count !== 0) return false;

  const counties = new Map();
  for (const row of coverage.counties) {
    if (!COUNTY_BY_CODE.has(String(row?.county_code ?? '')) || counties.has(row.county_code)
      || row.status !== 'complete'
      || !['master_count', 'located_count', 'unlocated_count', 'excluded_count']
        .every((field) => Number.isSafeInteger(row[field]) && row[field] >= 0)
      || row.master_count !== row.located_count
      || row.unlocated_count !== 0 || row.excluded_count !== 0) return false;
    counties.set(row.county_code, row);
  }
  return counties.size === TAIWAN_COUNTIES.length
    && [...counties.values()].reduce((total, row) => total + row.master_count, 0) === sourceCount
    && [...counties.values()].reduce((total, row) => total + row.located_count, 0) === sourceCount;
}

function completeMedicalResult(result) {
  if (!result || result.kind !== 'static' || !PUBLISHABLE_STATUSES.has(result.status)
    || result.publishable !== true || !Array.isArray(result.features) || result.features.length === 0) return false;

  const normalized = result.normalized;
  const report = normalized?.coordinate_report ?? result.coordinateReport;
  const directory = normalized?.medical_directory_features;
  if (!report || !Array.isArray(directory)
    || !Number.isSafeInteger(report.source_count) || report.source_count <= 0
    || report.source_count !== result.features.length
    || report.matched_count !== report.source_count
    || report.unresolved_count !== 0
    || (normalized.unresolved_medical_count ?? result.unresolved_count ?? 0) !== 0
    || (Array.isArray(normalized.unresolved_medical) && normalized.unresolved_medical.length !== 0)
    || (Array.isArray(normalized.excluded_medical) && normalized.excluded_medical.length !== 0)
    || directory.length !== report.source_count) return false;

  const coverage = report.county_coverage;
  if (!completeCountyCoverage(coverage, report.source_count)) return false;

  const codes = new Set();
  const featureIds = new Set();
  const pointsById = new Map();
  for (const feature of result.features) {
    const code = institutionCode(feature);
    if (!code || codes.has(code) || feature.feature_id !== `medical:${code}`
      || featureIds.has(feature.feature_id) || !validPoint(feature)) return false;
    codes.add(code);
    featureIds.add(feature.feature_id);
    pointsById.set(feature.feature_id, feature);
  }

  const directoryIds = new Set();
  const linkedPointIds = new Set();
  for (const entry of directory) {
    const properties = entry?.properties ?? {};
    const pointId = properties.point_feature_id;
    const point = pointsById.get(pointId);
    if (entry?.geometry !== null || properties.geometry_status !== 'located'
      || typeof entry.feature_id !== 'string' || directoryIds.has(entry.feature_id)
      || !point || linkedPointIds.has(pointId)
      || String(properties.county_code ?? '') !== String(point.properties.county_code)) return false;
    directoryIds.add(entry.feature_id);
    linkedPointIds.add(pointId);
  }
  return linkedPointIds.size === pointsById.size;
}

export function isPublishableResult(result) {
  const sourceId = result?.sourceId ?? result?.id;
  if (sourceId === 'taiwan-medical') return completeMedicalResult(result);
  if (PUBLISHABLE_STATUSES.has(result?.status)) return true;
  return result?.kind === 'static'
    && result?.publishable === true
    && Array.isArray(result?.features)
    && result.features.length > 0;
}
