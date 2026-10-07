import { SOURCE_REGISTRY } from '../source-registry.mjs';
import { sendPublicJson } from './response.mjs';

const SOURCE_BY_ID = new Map(SOURCE_REGISTRY.map((source) => [source.sourceId, source]));

function publicState(state) {
  const definition = SOURCE_BY_ID.get(state?.source_id);
  if (!definition) return null;
  const output = {
    source_id: definition.sourceId,
    status: state.status ?? 'unavailable',
    checked_at: state.checked_at ?? null,
    retrieved_at: state.retrieved_at ?? null,
    last_success_at: state.last_success_at ?? null,
    coverage: definition.coverage,
    revision: Number.isSafeInteger(state.revision) ? state.revision : null,
    error_code: typeof state.error_code === 'string' ? state.error_code : null,
  };
  for (const field of [
    'source_count', 'query_count', 'successful_query_count', 'failed_query_count', 'failed_fallback_source_count',
    'candidate_count', 'matched_count', 'unresolved_count', 'excluded_count', 'identity_conflict_count',
    'duplicate_institution_code_group_count', 'duplicate_institution_code_affected_row_count',
    'duplicate_institution_code_extra_row_count', 'duplicate_point_id_group_count',
    'duplicate_point_id_affected_row_count', 'duplicate_point_id_extra_row_count', 'rejected_coordinate_count',
    'emergency_hospital_count', 'emergency_located_count', 'emergency_unresolved_count',
  ]) {
    if (Number.isSafeInteger(state[field]) && state[field] >= 0) output[field] = state[field];
  }
  if (typeof state.layer_source_version === 'string' && state.layer_source_version.length > 0) {
    output.layer_source_version = state.layer_source_version;
  }
  if (typeof state.roster_complete === 'boolean') output.roster_complete = state.roster_complete;
  const countyCoverage = state.county_coverage;
  if (countyCoverage && ['partial', 'complete'].includes(countyCoverage.status)
    && countyCoverage.county_count === 22 && Array.isArray(countyCoverage.counties)
    && countyCoverage.counties.length === 22) {
    const counties = countyCoverage.counties.filter((row) =>
      typeof row?.county_code === 'string' && typeof row?.county_name === 'string'
      && ['partial', 'complete'].includes(row.status)
      && ['master_count', 'located_count', 'unlocated_count', 'excluded_count']
        .every((field) => Number.isSafeInteger(row[field]) && row[field] >= 0),
    );
    if (counties.length === 22) {
      output.county_coverage = {
        status: countyCoverage.status,
        county_count: 22,
        source_count: countyCoverage.source_count,
        located_count: countyCoverage.located_count,
        unlocated_count: countyCoverage.unlocated_count,
        excluded_count: countyCoverage.excluded_count,
        unassigned_count: countyCoverage.unassigned_count,
        counties: counties.map((row) => ({
          county_code: row.county_code,
          county_name: row.county_name,
          master_count: row.master_count,
          located_count: row.located_count,
          unlocated_count: row.unlocated_count,
          excluded_count: row.excluded_count,
          status: row.status,
        })),
      };
    }
  }
  if (typeof state.emergency_medical_source_version === 'string') {
    output.emergency_medical_source_version = state.emergency_medical_source_version;
  }
  if (typeof state.emergency_medical_coverage === 'string'
    && ['partial', 'complete', 'unavailable'].includes(state.emergency_medical_coverage)) {
    output.emergency_medical_coverage = state.emergency_medical_coverage;
  }
  if (state.emergency_unresolved_reason_counts && typeof state.emergency_unresolved_reason_counts === 'object') {
    const reasons = {};
    for (const name of ['no_coordinate_candidate', 'name_address_mismatch', 'multiple_candidates', 'source_missing']) {
      const value = state.emergency_unresolved_reason_counts[name];
      if (Number.isSafeInteger(value) && value >= 0) reasons[name] = value;
    }
    output.emergency_unresolved_reason_counts = reasons;
  }
  if (state.unresolved_reason_counts && typeof state.unresolved_reason_counts === 'object') {
    const reasons = {};
    for (const name of [
      'no_coordinate_candidate', 'name_address_mismatch', 'multiple_candidates', 'source_missing',
      'duplicate_institution_code', 'duplicate_point_id', 'missing_institution_code', 'unverified_coordinate_match',
    ]) {
      const value = state.unresolved_reason_counts[name];
      if (Number.isSafeInteger(value) && value >= 0) reasons[name] = value;
    }
    output.unresolved_reason_counts = reasons;
  }
  if (state.excluded_reason_counts && typeof state.excluded_reason_counts === 'object') {
    output.excluded_reason_counts = Object.fromEntries(
      Object.entries(state.excluded_reason_counts)
        .filter(([reason, value]) => /^[a-z][a-z0-9_]*$/u.test(reason)
          && Number.isSafeInteger(value) && value >= 0),
    );
  }
  if (Array.isArray(state.coordinate_source_ids)) {
    output.coordinate_source_ids = state.coordinate_source_ids
      .filter((sourceId) => typeof sourceId === 'string'
        && (/^[a-z][a-z0-9-]+$/u.test(sourceId) || /^official-doorplate:\d{5}$/u.test(sourceId)));
  }
  return output;
}

export function registerSourceStatusRoutes(app, { sourceStateStore }) {
  app.get('/v1/source-status', async (request, reply) => {
    const states = typeof sourceStateStore?.list === 'function'
      ? await sourceStateStore.list()
      : [];
    const sources = states.map(publicState).filter(Boolean);
    return sendPublicJson(request, reply, { sources }, { maxAge: 10 });
  });
}

export { publicState };
