import {
  DEFAULT_CWA_EARTHQUAKE_ENDPOINT,
  DEFAULT_CWA_WARNING_ENDPOINT,
  DEFAULT_CWA_TYPHOON_ENDPOINT,
  fetchCwaEarthquakes,
  fetchCwaWarnings,
  fetchCwaTyphoonWarnings,
  normalizeCwaEarthquakes,
  normalizeCwaWarnings,
  normalizeCwaTyphoonWarnings,
} from '../sources/cwa.mjs';
import {
  DEFAULT_NCDR_ENDPOINT,
  fetchNcdrHazards,
  normalizeNcdrHazards,
} from '../sources/ncdr.mjs';
import {
  DEFAULT_TDX_ENDPOINT,
  DEFAULT_TDX_NATIONWIDE_ENDPOINTS,
  collectTdxRoadEvents,
} from '../sources/tdx.mjs';
import {
  DEFAULT_MEDICAL_ENDPOINT,
  fetchMedicalFacilities,
  mergeMedicalCoordinates,
  normalizeMedicalFacilitiesReport,
  partitionMedicalIdentityConflicts,
  reconcileEmergencyMedicalFacilities,
} from '../sources/medical.mjs';
import {
  DEFAULT_MEDICAL_COORDINATE_ENDPOINT,
  fetchOfficialMedicalCoordinates,
} from '../sources/medical-coordinates.mjs';
import { medicalCoordinateAddressTexts } from '../sources/medical-address-corrections.mjs';
import {
  DEFAULT_OSM_ENDPOINT,
  fetchOsmTaiwan,
  normalizeOsmFeatures,
} from '../sources/osm.mjs';
import {
  DEFAULT_SHELTER_ENDPOINT,
  fetchTaiwanShelters,
  normalizeShelters,
} from '../sources/shelter.mjs';
import { getSourceDefinition, SOURCE_REGISTRY } from '../../server/src/source-registry.mjs';
import { buildMedicalCountyCoverage } from './medical-coverage.mjs';
import { buildMedicalDirectoryFeatures } from './medical-directory.mjs';
import { readSignedAddressPackFeatures } from './address-pack-reader.mjs';

function envOf(config = {}) {
  return config.env ?? process.env;
}

function splitEndpoints(value) {
  return typeof value === 'string'
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : undefined;
}

function jsonOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    const wrapped = new Error('collector JSON option is invalid', { cause: error });
    wrapped.code = 'COLLECTOR_OPTION_INVALID';
    throw wrapped;
  }
}

function scopeOptions(scope = {}) {
  return {
    scope: scope.scope ?? 'taiwan',
    coverage: scope.coverage ?? 'TW',
    boundary: scope.boundary,
    areaResolver: scope.areaResolver,
    areaIdResolver: scope.areaIdResolver,
    boundaryResolver: scope.boundaryResolver,
    areaCatalogPath: scope.areaCatalogPath,
    townNamesByCode: scope.townNamesByCode,
    townCodeResolver: scope.townCodeResolver,
    counties: scope.counties,
  };
}

function dynamicNormalized(sourceId, retrievedAt, events, extra = {}) {
  return {
    schema_version: 'event-batch-v0',
    source_id: sourceId,
    retrieved_at: retrievedAt,
    event_count: events.length,
    ...extra,
    events,
  };
}

function staticNormalized(sourceId, rawSnapshot, value) {
  return {
    schema_version: 'static-normalized-v0',
    source_id: sourceId,
    retrieved_at: rawSnapshot.retrieved_at,
    feature_count: value.features?.length ?? 0,
    status_event_count: value.status_events?.length ?? 0,
    ...value,
  };
}

function sourceStatus(rawSnapshot, result) {
  if (result.status) return result.status;
  if (result.unresolved?.length || rawSnapshot?.payload?.partial === true) return 'partial';
  if (rawSnapshot?.payload?.stale === true) return 'stale';
  return 'ok';
}

function errorStatus(error) {
  return error?.code?.includes('CREDENTIAL') || error?.status === 401 || error?.status === 403
    ? 'blocked_by_auth'
    : 'unavailable';
}

function sourceState({ definition, status, now, rawSnapshot, previousState, error }) {
  const retrievedAt = rawSnapshot?.retrieved_at ?? previousState?.retrieved_at ?? null;
  return {
    schema_version: 'source-state-v1',
    source_id: definition.sourceId,
    status,
    checked_at: now.toISOString(),
    retrieved_at: retrievedAt,
    last_success_at: status === 'ok' || status === 'partial' || status === 'stale'
      ? retrievedAt
      : previousState?.last_success_at ?? null,
    etag: rawSnapshot?.response?.headers?.etag ?? previousState?.etag ?? null,
    last_modified: rawSnapshot?.response?.headers?.last_modified ?? previousState?.last_modified ?? null,
    content_sha256: previousState?.content_sha256 ?? null,
    partial: status === 'partial',
    error_code: error?.code ?? null,
  };
}

function previousOutput(normalized) {
  return {
    events: normalized?.events ?? [],
    features: normalized?.features ?? [],
    status_events: normalized?.status_events ?? [],
  };
}

async function defaultAdapter({ definition, scope, config, now, previousSnapshot }) {
  const env = envOf(config);
  const receivedAt = now.toISOString();
  const common = { retrievedAt: receivedAt };
  const normalizedOptions = {
    ...scopeOptions(scope),
    namespace: config.namespace,
    signingKeyId: config.signingKeyId,
    receivedAt,
  };

  if (definition.sourceId === 'tdx-road-events') {
    const collected = await collectTdxRoadEvents({
      clientId: env.TDX_CLIENT_ID,
      clientSecret: env.TDX_CLIENT_SECRET,
      endpoint: env.TDX_API_ENDPOINT ?? DEFAULT_TDX_ENDPOINT,
      endpoints: scope.scope === 'taiwan'
        ? (splitEndpoints(env.TDX_API_ENDPOINTS) ?? DEFAULT_TDX_NATIONWIDE_ENDPOINTS)
        : undefined,
      tokenEndpoint: env.TDX_TOKEN_ENDPOINT,
      freshnessSeconds: env.TDX_EVENT_FRESHNESS_SECONDS,
      ...common,
      ...scopeOptions(scope),
    });
    return {
      mode: 'live',
      rawSnapshot: collected.rawSnapshot,
      normalized: dynamicNormalized(definition.sourceId, collected.rawSnapshot.retrieved_at, collected.events),
      events: collected.events,
      unresolved: collected.unresolved,
    };
  }

  if (definition.sourceId === 'cwa-earthquake') {
    const rawSnapshot = await fetchCwaEarthquakes({
      ...common,
      apiKey: env.CWA_API_KEY,
      endpoint: env.CWA_EARTHQUAKE_ENDPOINT ?? DEFAULT_CWA_EARTHQUAKE_ENDPOINT,
    });
    const events = normalizeCwaEarthquakes(rawSnapshot, normalizedOptions);
    return { mode: 'live', rawSnapshot, normalized: dynamicNormalized(definition.sourceId, rawSnapshot.retrieved_at, events), events };
  }

  if (definition.sourceId === 'cwa-weather-warning' || definition.sourceId === 'cwa-typhoon-warning') {
    const typhoon = definition.sourceId === 'cwa-typhoon-warning';
    const rawSnapshot = await (typhoon ? fetchCwaTyphoonWarnings : fetchCwaWarnings)({
      ...common,
      apiKey: env.CWA_API_KEY,
      endpoint: env[typhoon ? 'CWA_TYPHOON_ENDPOINT' : 'CWA_WARNING_ENDPOINT']
        ?? (typhoon ? DEFAULT_CWA_TYPHOON_ENDPOINT : DEFAULT_CWA_WARNING_ENDPOINT),
    });
    const events = (typhoon ? normalizeCwaTyphoonWarnings : normalizeCwaWarnings)(rawSnapshot, normalizedOptions);
    return { mode: 'live', rawSnapshot, normalized: dynamicNormalized(definition.sourceId, rawSnapshot.retrieved_at, events), events };
  }

  if (definition.sourceId === 'ncdr-hazard-events') {
    const rawSnapshot = await fetchNcdrHazards({
      ...common,
      credentials: { apiKey: env.NCDR_ALERT_API_KEY ?? env.NCDR_API_KEY },
      endpoint: env.NCDR_ALERT_ENDPOINT ?? env.NCDR_API_ENDPOINT ?? DEFAULT_NCDR_ENDPOINT,
      detailEndpoint: env.NCDR_ALERT_DETAIL_ENDPOINT,
      authMode: env.NCDR_AUTH_MODE,
      detailConcurrency: env.NCDR_DETAIL_CONCURRENCY,
      previousSnapshot,
    });
    const normalized = normalizeNcdrHazards(rawSnapshot, normalizedOptions);
    return {
      mode: 'live',
      rawSnapshot,
      normalized: dynamicNormalized(definition.sourceId, rawSnapshot.retrieved_at, normalized),
      events: normalized,
    };
  }

  if (definition.sourceId === 'taiwan-shelter') {
    const rawSnapshot = await fetchTaiwanShelters({
      endpoint: env.SHELTER_DATA_ENDPOINT ?? DEFAULT_SHELTER_ENDPOINT,
      retrievedAt: receivedAt,
    });
    const normalized = normalizeShelters(rawSnapshot, { ...scopeOptions(scope), sourceId: definition.sourceId, receivedAt });
    const output = staticNormalized(definition.sourceId, rawSnapshot, {
      features: normalized.features,
      source_count: normalized.source_count,
      located_count: normalized.located_count,
      unlocated_count: normalized.unlocated_count,
      excluded_count: normalized.excluded_count,
      excluded_reason_counts: normalized.excluded_reason_counts,
      location_issue_counts: normalized.location_issue_counts,
      county_coverage: normalized.county_coverage,
    });
    return {
      mode: 'live',
      rawSnapshot,
      normalized: output,
      features: output.features,
      ...(normalized.unlocated_count > 0 || normalized.excluded_count > 0 ? { status: 'partial' } : {}),
    };
  }

  if (definition.sourceId === 'osm-taiwan') {
    const rawSnapshot = await fetchOsmTaiwan({
      endpoint: env.OSM_API_ENDPOINT ?? DEFAULT_OSM_ENDPOINT,
      retrievedAt: receivedAt,
    });
    const features = normalizeOsmFeatures(rawSnapshot, { ...scopeOptions(scope), sourceId: definition.sourceId, receivedAt });
    const output = staticNormalized(definition.sourceId, rawSnapshot, { features, status_events: [] });
    return { mode: 'live', rawSnapshot, normalized: output, features };
  }

  if (definition.sourceId === 'taiwan-medical') {
    const rawSnapshot = await fetchMedicalFacilities({
      sourceId: definition.sourceId,
      endpoint: env.MEDICAL_DATA_ENDPOINT ?? DEFAULT_MEDICAL_ENDPOINT,
      format: env.MEDICAL_DATA_FORMAT,
      fetchImpl: config.fetchImpl,
      retrievedAt: receivedAt,
    });
    const report = normalizeMedicalFacilitiesReport(rawSnapshot, { ...scopeOptions(scope), sourceId: definition.sourceId, receivedAt });
    const suppliedCoordinateFeatures = Array.isArray(config.medicalCoordinateFeatures)
      ? config.medicalCoordinateFeatures
      : Array.isArray(config.coordinateFeatures) ? config.coordinateFeatures : undefined;
    const coordinateResult = suppliedCoordinateFeatures
      ? {
        features: suppliedCoordinateFeatures,
        source_ids: [...new Set(suppliedCoordinateFeatures.map((feature) => feature?.properties?.coordinate_source).filter(Boolean))],
        rejected_coordinate_count: 0,
        query_count: 0,
        successful_query_count: 0,
        failed_query_count: 0,
        failed_query_error_counts: {},
        failed_fallback_source_count: 0,
      }
      : await fetchOfficialMedicalCoordinates({
        endpoint: env.MEDICAL_COORDINATE_ENDPOINT ?? config.medicalCoordinateEndpoint ?? DEFAULT_MEDICAL_COORDINATE_ENDPOINT,
        fallbackEndpoints: splitEndpoints(env.MEDICAL_COORDINATE_FALLBACK_ENDPOINTS)
          ?? config.medicalCoordinateFallbackEndpoints
          ?? [],
        queryPoints: jsonOption(env.MEDICAL_COORDINATE_QUERY_POINTS, undefined),
        radiusMeters: env.MEDICAL_COORDINATE_RADIUS_METERS ?? config.medicalCoordinateRadiusMeters,
        spacingMeters: env.MEDICAL_COORDINATE_SPACING_METERS ?? config.medicalCoordinateSpacingMeters,
        maxQueries: env.MEDICAL_COORDINATE_MAX_QUERIES ?? config.medicalCoordinateMaxQueries,
        concurrency: env.MEDICAL_COORDINATE_CONCURRENCY ?? config.medicalCoordinateConcurrency,
        boundary: scope.boundary,
        fetchImpl: config.fetchImpl,
        retrievedAt: receivedAt,
        timeoutMs: env.MEDICAL_COORDINATE_TIMEOUT_MS
          ? Number(env.MEDICAL_COORDINATE_TIMEOUT_MS)
          : config.medicalCoordinateTimeoutMs ?? 120000,
      });
    const addressCoordinateFeatures = config.medicalAddressPacksDirectory && report.unresolved.length > 0
      ? await readSignedAddressPackFeatures({
        directory: config.medicalAddressPacksDirectory,
        publicKey: config.addressPackPublicKey,
        addresses: medicalCoordinateAddressTexts(report.unresolved),
        townNamesByCode: scope.townNamesByCode,
        townCodeResolver: scope.townCodeResolver,
      })
      : [];
    const coordinateSourceIds = [
      ...coordinateResult.source_ids,
      ...new Set(addressCoordinateFeatures
        .map((feature) => feature?.properties?.coordinate_source)
        .filter(Boolean)),
    ];
    const enriched = mergeMedicalCoordinates(report, coordinateResult.features, {
      ...scopeOptions(scope),
      sourceId: definition.sourceId,
      rawSnapshot,
      addressCoordinateFeatures,
    });
    const partitioned = partitionMedicalIdentityConflicts({
      features: enriched.features,
      unresolved: enriched.unresolved,
      excluded: report.excluded,
    });
    const emergencyMedical = config.emergencyMedicalRoster && config.emergencyMedicalCrosswalk
      ? reconcileEmergencyMedicalFacilities({
        roster: config.emergencyMedicalRoster,
        crosswalk: config.emergencyMedicalCrosswalk,
        medicalFeatures: partitioned.features,
        unresolvedMedical: partitioned.unresolved,
        now,
      })
      : {
        features: [],
        report: {
          source_version: null,
          hospital_count: null,
          located_count: null,
          unresolved_count: null,
          unresolved_reason_counts: null,
          coverage: 'unavailable',
        },
      };
    const coordinateReport = {
      source_count: report.source_count,
      roster_complete: rawSnapshot.payload?.partial !== true,
      layer_source_version: partitioned.features[0]?.source_version
        ?? rawSnapshot.response?.headers?.etag
        ?? rawSnapshot.retrieved_at,
      source_ids: [...new Set(coordinateSourceIds)],
      query_count: coordinateResult.query_count,
      successful_query_count: coordinateResult.successful_query_count ?? coordinateResult.query_count,
      failed_query_count: coordinateResult.failed_query_count ?? 0,
      failed_query_error_counts: coordinateResult.failed_query_error_counts ?? {},
      failed_fallback_source_count: coordinateResult.failed_fallback_source_count ?? 0,
      candidate_count: coordinateResult.features.length + addressCoordinateFeatures.length,
      matched_count: partitioned.features.length,
      unresolved_count: partitioned.unresolved.length,
      excluded_count: partitioned.excluded.length,
      identity_conflict_count: partitioned.identity_conflict_count,
      duplicate_institution_code_group_count: partitioned.duplicate_institution_code_group_count,
      duplicate_institution_code_affected_row_count: partitioned.duplicate_institution_code_affected_row_count,
      duplicate_institution_code_extra_row_count: partitioned.duplicate_institution_code_extra_row_count,
      duplicate_point_id_group_count: partitioned.duplicate_point_id_group_count,
      duplicate_point_id_affected_row_count: partitioned.duplicate_point_id_affected_row_count,
      duplicate_point_id_extra_row_count: partitioned.duplicate_point_id_extra_row_count,
      rejected_coordinate_count: coordinateResult.rejected_coordinate_count,
      unresolved_reason_counts: partitioned.unresolved_reason_counts,
      excluded_reason_counts: partitioned.excluded.length > 0
        ? { outside_taiwan_boundary: partitioned.excluded.length }
        : {},
      county_coverage: buildMedicalCountyCoverage({
        features: partitioned.features,
        unresolved: partitioned.unresolved,
        excluded: partitioned.excluded,
        options: scopeOptions(scope),
      }),
      emergency_hospital_count: emergencyMedical.report.hospital_count,
      emergency_located_count: emergencyMedical.report.located_count,
      emergency_unresolved_count: emergencyMedical.report.unresolved_count,
      emergency_medical_source_version: emergencyMedical.report.source_version,
      emergency_medical_coverage: emergencyMedical.report.coverage,
      emergency_unresolved_reason_counts: emergencyMedical.report.unresolved_reason_counts,
    };
    if (partitioned.features.length === 0) {
      const error = new Error('official medical coordinates produced an empty layer');
      error.code = 'MEDICAL_LAYER_EMPTY';
      error.coordinateReport = coordinateReport;
      throw error;
    }
    const output = staticNormalized(definition.sourceId, rawSnapshot, {
      features: partitioned.features,
      status_events: [],
      unresolved_medical: partitioned.unresolved,
      unresolved_medical_count: partitioned.unresolved.length,
      excluded_medical: partitioned.excluded,
      medical_directory_features: buildMedicalDirectoryFeatures({
        locatedFeatures: partitioned.features,
        unresolved: partitioned.unresolved,
        excluded: partitioned.excluded,
        sourceVersion: coordinateReport.layer_source_version,
        sourceUrl: 'https://data.gov.tw/dataset/15393',
        issuedAt: rawSnapshot.retrieved_at,
        expiresAt: new Date(Date.parse(rawSnapshot.retrieved_at) + 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      coordinate_report: coordinateReport,
      emergency_medical_features: emergencyMedical.features,
      emergency_medical_report: emergencyMedical.report,
    });
    return {
      mode: 'live',
      rawSnapshot,
      normalized: output,
      features: output.features,
      unresolved: partitioned.unresolved,
      excluded: partitioned.excluded,
      coordinateReport,
      emergencyMedicalFeatures: emergencyMedical.features,
      emergencyMedicalReport: emergencyMedical.report,
      publishable: true,
      ...(partitioned.unresolved.length > 0 || partitioned.excluded.length > 0
        || coordinateReport.failed_query_count > 0 || coordinateReport.failed_fallback_source_count > 0
        ? { status: 'partial' }
        : {}),
    };
  }

  throw new Error(`No collector adapter for ${definition.sourceId}`);
}

function defaultCacheStore(dataRoot, cacheStore) {
  if (cacheStore) return cacheStore;
  if (!dataRoot) throw new TypeError('cacheStore or config.privateDataRoot is required');
  throw new TypeError('source collector requires an injected cacheStore');
}

export function createMemoryCacheStore() {
  const records = new Map();
  return {
    async readState(sourceId) { return records.get(sourceId)?.state ?? null; },
    async readSnapshot(sourceId) { return records.get(sourceId)?.snapshot ?? null; },
    async readNormalized(sourceId) { return records.get(sourceId)?.normalized ?? null; },
    async writeResult(sourceId, result) { records.set(sourceId, result); },
  };
}

export async function collectSource({
  definition,
  scope,
  config = {},
  cacheStore,
  now = new Date(),
  adapters = {},
} = {}) {
  if (!definition?.sourceId) throw new TypeError('definition with sourceId is required');
  const cache = defaultCacheStore(config.privateDataRoot, cacheStore);
  const previousState = await cache.readState(definition.sourceId);
  const previousSnapshot = await cache.readSnapshot(definition.sourceId);
  const previousNormalized = await cache.readNormalized(definition.sourceId);
  const adapter = adapters[definition.sourceId] ?? defaultAdapter;
  try {
    const collected = await adapter({
      definition,
      scope,
      config,
      now,
      mode: 'live',
      previousState,
      previousSnapshot,
      previousNormalized,
    });
    if (collected.mode !== 'live') {
      const error = new Error('fixture/replay data cannot be published as live data');
      error.code = 'FIXTURE_NOT_ALLOWED';
      throw error;
    }
    if (collected.notModified) {
      if (!previousSnapshot || !previousNormalized) throw new Error('not-modified source has no previous snapshot');
      const state = sourceState({ definition, status: 'not_modified', now, previousState });
      await cache.writeResult(definition.sourceId, {
        snapshot: previousSnapshot,
        normalized: previousNormalized,
        state,
      });
      return {
        sourceId: definition.sourceId,
        feedId: definition.feedId,
        kind: definition.kind,
        status: 'not_modified',
        rawSnapshot: previousSnapshot,
        normalized: previousNormalized,
        ...previousOutput(previousNormalized),
        coordinateReport: previousNormalized.coordinate_report,
        emergencyMedicalFeatures: previousNormalized.emergency_medical_features ?? [],
        emergencyMedicalReport: previousNormalized.emergency_medical_report,
      };
    }
    const status = sourceStatus(collected.rawSnapshot, collected);
    const normalized = collected.normalized ?? (definition.kind === 'dynamic'
      ? dynamicNormalized(definition.sourceId, collected.rawSnapshot.retrieved_at, collected.events ?? [])
      : staticNormalized(definition.sourceId, collected.rawSnapshot, {
        features: collected.features ?? [],
        status_events: collected.status_events ?? [],
      }));
    const state = sourceState({ definition, status, now, rawSnapshot: collected.rawSnapshot, previousState });
    await cache.writeResult(definition.sourceId, {
      snapshot: collected.rawSnapshot,
      normalized,
      state,
    });
    return {
      sourceId: definition.sourceId,
      feedId: definition.feedId,
      kind: definition.kind,
      status,
      retrievedAt: collected.rawSnapshot.retrieved_at,
      rawSnapshot: collected.rawSnapshot,
      normalized,
      events: collected.events ?? normalized.events ?? [],
      features: collected.features ?? normalized.features ?? [],
      status_events: collected.status_events ?? normalized.status_events ?? [],
      coordinateReport: collected.coordinateReport ?? normalized.coordinate_report,
      emergencyMedicalFeatures: collected.emergencyMedicalFeatures ?? normalized.emergency_medical_features ?? [],
      emergencyMedicalReport: collected.emergencyMedicalReport ?? normalized.emergency_medical_report,
      unresolved_count: collected.unresolved?.length ?? normalized.unresolved_medical_count ?? 0,
      publishable: collected.publishable ?? true,
    };
  } catch (error) {
    if (error.code === 'FIXTURE_NOT_ALLOWED') throw error;
    const fallback = previousOutput(previousNormalized);
    return {
      sourceId: definition.sourceId,
      feedId: definition.feedId,
      kind: definition.kind,
      status: errorStatus(error),
      errorCode: error.code ?? 'SOURCE_ERROR',
      usedLastKnownGood: Boolean(previousSnapshot && previousNormalized),
      rawSnapshot: previousSnapshot,
      normalized: previousNormalized,
      ...fallback,
      ...(definition.sourceId === 'taiwan-medical' && error.coordinateReport
        ? { coordinateReport: error.coordinateReport }
        : {}),
      publishable: false,
    };
  }
}

export async function collectSources({ sourceIds, scope, config = {}, cacheStore, now = new Date(), adapters } = {}) {
  const definitions = (sourceIds ?? SOURCE_REGISTRY.map(({ sourceId }) => sourceId)).map(getSourceDefinition);
  return Promise.all(definitions.map((definition) => collectSource({
    definition, scope, config, cacheStore, now, adapters,
  })));
}
