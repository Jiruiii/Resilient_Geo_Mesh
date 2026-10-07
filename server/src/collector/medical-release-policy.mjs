import { TAIWAN_COUNTIES } from '../../../pipeline/sources/taiwan-counties.mjs';
import {
  isVerifiedMedicalCoordinateMatchMethod,
  normalizedMedicalInstitutionCode,
} from '../../../pipeline/sources/medical.mjs';

const PUBLISHABLE_STATUSES = new Set(['ok', 'not_modified']);
const MEDICAL_PUBLISHABLE_STATUSES = new Set(['ok', 'not_modified', 'partial']);
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
function institutionCode(feature) {
  return normalizedMedicalInstitutionCode(feature);
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
    && isVerifiedMedicalCoordinateMatchMethod(properties.coordinate_match_method)
    && consistentCounty(feature);
}

function validMedicalCountyCoverage(coverage, report) {
  if (!coverage || !['complete', 'partial'].includes(coverage.status)
    || coverage.county_count !== TAIWAN_COUNTIES.length
    || !Array.isArray(coverage.counties) || coverage.counties.length !== TAIWAN_COUNTIES.length
    || coverage.source_count !== report.source_count || coverage.located_count !== report.matched_count
    || !['unlocated_count', 'excluded_count', 'unassigned_count']
      .every((field) => Number.isSafeInteger(coverage[field]) && coverage[field] >= 0)) return false;

  const counties = new Map();
  let masterCount = 0;
  let locatedCount = 0;
  let unlocatedCount = 0;
  let excludedCount = 0;
  for (const row of coverage.counties) {
    const expectedRowStatus = row?.unlocated_count === 0 && row?.excluded_count === 0 ? 'complete' : 'partial';
    if (!COUNTY_BY_CODE.has(String(row?.county_code ?? '')) || counties.has(row.county_code)
      || row.status !== expectedRowStatus
      || !['master_count', 'located_count', 'unlocated_count', 'excluded_count']
        .every((field) => Number.isSafeInteger(row[field]) && row[field] >= 0)
      || row.master_count !== row.located_count + row.unlocated_count + row.excluded_count
      || (row.status === 'complete' && (row.unlocated_count !== 0 || row.excluded_count !== 0))) return false;
    counties.set(row.county_code, row);
    masterCount += row.master_count;
    locatedCount += row.located_count;
    unlocatedCount += row.unlocated_count;
    excludedCount += row.excluded_count;
  }
  const allCountiesComplete = [...counties.values()].every((row) => row.status === 'complete');
  const expectedCoverageStatus = allCountiesComplete && coverage.unassigned_count === 0 ? 'complete' : 'partial';
  return counties.size === TAIWAN_COUNTIES.length
    && masterCount + coverage.unassigned_count === report.source_count
    && locatedCount === report.matched_count
    && unlocatedCount + excludedCount + coverage.unassigned_count
      === report.unresolved_count + report.excluded_count
    && coverage.status === expectedCoverageStatus;
}

function validMedicalResult(result) {
  if (!result || result.kind !== 'static' || !MEDICAL_PUBLISHABLE_STATUSES.has(result.status)
    || result.publishable !== true || !Array.isArray(result.features) || result.features.length === 0) return false;

  const normalized = result.normalized;
  const rawReport = normalized?.coordinate_report ?? result.coordinateReport;
  const directory = normalized?.medical_directory_features;
  const unresolved = normalized?.unresolved_medical;
  const excluded = normalized?.excluded_medical;
  const legacyCompleteReport = result.status !== 'partial'
    && Array.isArray(result.features) && Array.isArray(directory)
    && Array.isArray(unresolved) && unresolved.length === 0
    && Array.isArray(excluded) && excluded.length === 0
    && rawReport?.source_count === result.features.length
    && rawReport?.matched_count === result.features.length
    && rawReport?.unresolved_count === 0
    && directory.length === result.features.length;
  const report = legacyCompleteReport ? {
    ...rawReport,
    roster_complete: rawReport.roster_complete ?? true,
    layer_source_version: rawReport.layer_source_version ?? result.features[0]?.source_version,
    excluded_count: rawReport.excluded_count ?? 0,
    identity_conflict_count: rawReport.identity_conflict_count ?? 0,
    duplicate_institution_code_group_count: rawReport.duplicate_institution_code_group_count ?? 0,
    duplicate_institution_code_affected_row_count: rawReport.duplicate_institution_code_affected_row_count ?? 0,
    duplicate_institution_code_extra_row_count: rawReport.duplicate_institution_code_extra_row_count ?? 0,
    duplicate_point_id_group_count: rawReport.duplicate_point_id_group_count ?? 0,
    duplicate_point_id_affected_row_count: rawReport.duplicate_point_id_affected_row_count ?? 0,
    duplicate_point_id_extra_row_count: rawReport.duplicate_point_id_extra_row_count ?? 0,
    query_count: rawReport.query_count ?? 0,
    successful_query_count: rawReport.successful_query_count ?? 0,
    failed_query_count: rawReport.failed_query_count ?? 0,
    failed_fallback_source_count: rawReport.failed_fallback_source_count ?? 0,
    candidate_count: rawReport.candidate_count ?? 0,
    rejected_coordinate_count: rawReport.rejected_coordinate_count ?? 0,
    unresolved_reason_counts: rawReport.unresolved_reason_counts ?? {
      no_coordinate_candidate: 0,
      name_address_mismatch: 0,
      multiple_candidates: 0,
      source_missing: 0,
      duplicate_institution_code: 0,
      duplicate_point_id: 0,
      missing_institution_code: 0,
      unverified_coordinate_match: 0,
    },
    excluded_reason_counts: rawReport.excluded_reason_counts ?? {},
  } : rawReport;
  if (!report || !Array.isArray(directory)
    || !Array.isArray(unresolved) || !Array.isArray(excluded)
    || report.roster_complete !== true
    || typeof report.layer_source_version !== 'string' || report.layer_source_version.trim() === ''
    || !Number.isSafeInteger(report.source_count) || report.source_count <= 0
    || !Number.isSafeInteger(report.matched_count) || report.matched_count !== result.features.length
    || !Number.isSafeInteger(report.unresolved_count) || report.unresolved_count !== unresolved.length
    || !Number.isSafeInteger(report.excluded_count) || report.excluded_count !== excluded.length
    || report.source_count !== report.matched_count + report.unresolved_count + report.excluded_count
    || (normalized.unresolved_medical_count ?? result.unresolved_count ?? -1) !== report.unresolved_count
    || directory.length !== report.source_count) return false;
  if (result.features[0]?.source_version !== report.layer_source_version
    || directory.some((entry) => entry?.source_version !== report.layer_source_version)) return false;

  const collectionCountFields = [
    'query_count', 'successful_query_count', 'failed_query_count', 'failed_fallback_source_count',
    'candidate_count', 'rejected_coordinate_count',
  ];
  if (!collectionCountFields.every((field) => Number.isSafeInteger(report[field]) && report[field] >= 0)) return false;
  if ((report.unresolved_count > 0 || report.excluded_count > 0
    || report.failed_query_count > 0 || report.failed_fallback_source_count > 0)
    && result.status !== 'partial') return false;

  const coverage = report.county_coverage;
  if (!validMedicalCountyCoverage(coverage, report)) return false;

  const nonNegativeReportFields = [
    'identity_conflict_count',
    'duplicate_institution_code_group_count',
    'duplicate_institution_code_affected_row_count',
    'duplicate_institution_code_extra_row_count',
    'duplicate_point_id_group_count',
    'duplicate_point_id_affected_row_count',
    'duplicate_point_id_extra_row_count',
  ];
  if (!nonNegativeReportFields.every((field) => Number.isSafeInteger(report[field]) && report[field] >= 0)
    || report.identity_conflict_count > report.unresolved_count
    || report.duplicate_institution_code_affected_row_count > report.source_count
    || report.duplicate_point_id_affected_row_count > report.source_count
    || report.duplicate_institution_code_extra_row_count < report.duplicate_institution_code_group_count
    || report.duplicate_point_id_extra_row_count < report.duplicate_point_id_group_count
    || report.duplicate_institution_code_affected_row_count !== report.duplicate_institution_code_group_count
      + report.duplicate_institution_code_extra_row_count
    || report.duplicate_point_id_affected_row_count !== report.duplicate_point_id_group_count
      + report.duplicate_point_id_extra_row_count
    || report.identity_conflict_count < Math.max(
      report.duplicate_institution_code_affected_row_count,
      report.duplicate_point_id_affected_row_count,
    )) return false;

  const reasonCounts = report.unresolved_reason_counts;
  const requiredReasons = [
    'no_coordinate_candidate', 'name_address_mismatch', 'multiple_candidates', 'source_missing',
    'duplicate_institution_code', 'duplicate_point_id', 'missing_institution_code', 'unverified_coordinate_match',
  ];
  if (!reasonCounts || !requiredReasons.every((reason) =>
    Number.isSafeInteger(reasonCounts[reason]) && reasonCounts[reason] >= 0)
  ) return false;
  const reasonTotal = requiredReasons.reduce((total, reason) => total + reasonCounts[reason], 0);
  if (reasonTotal !== report.unresolved_count) return false;
  const excludedReasonCounts = report.excluded_reason_counts;
  if (!excludedReasonCounts || Object.values(excludedReasonCounts).some((count) =>
    !Number.isSafeInteger(count) || count < 0)
  ) return false;
  const excludedReasonTotal = Object.values(excludedReasonCounts).reduce((total, count) => total + count, 0);
  if (excludedReasonTotal !== report.excluded_count) return false;

  const codes = new Set();
  const featureIds = new Set();
  const pointsById = new Map();
  for (const feature of result.features) {
    const code = institutionCode(feature);
    if (!code || codes.has(code) || typeof feature.feature_id !== 'string' || !feature.feature_id
      || featureIds.has(feature.feature_id) || !validPoint(feature)) return false;
    codes.add(code);
    featureIds.add(feature.feature_id);
    pointsById.set(feature.feature_id, feature);
  }

  const directoryIds = new Set();
  const linkedPointIds = new Set();
  let directoryMatched = 0;
  let directoryUnresolved = 0;
  let directoryExcluded = 0;
  for (const entry of directory) {
    const properties = entry?.properties ?? {};
    const pointId = properties.point_feature_id;
    const point = pointsById.get(pointId);
    const status = properties.geometry_status;
    if (entry?.geometry !== null
      || typeof entry.feature_id !== 'string' || directoryIds.has(entry.feature_id)
      || !['located', 'unresolved', 'excluded'].includes(status)) return false;
    directoryIds.add(entry.feature_id);
    if (status === 'located') {
      if (!point || linkedPointIds.has(pointId)
        || String(properties.county_code ?? '') !== String(point.properties.county_code)) return false;
      directoryMatched += 1;
      linkedPointIds.add(pointId);
    } else {
      if (pointId !== null) return false;
      if (status === 'unresolved') directoryUnresolved += 1;
      else directoryExcluded += 1;
    }
  }
  return linkedPointIds.size === pointsById.size
    && directoryMatched === report.matched_count
    && directoryUnresolved === report.unresolved_count
    && directoryExcluded === report.excluded_count;
}

export function isPublishableResult(result) {
  const sourceId = result?.sourceId ?? result?.id;
  if (sourceId === 'taiwan-medical') return validMedicalResult(result);
  if (PUBLISHABLE_STATUSES.has(result?.status)) return true;
  return result?.kind === 'static'
    && result?.publishable === true
    && Array.isArray(result?.features)
    && result.features.length > 0;
}
