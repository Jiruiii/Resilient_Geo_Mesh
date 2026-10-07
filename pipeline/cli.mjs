#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  exportPrivateKeyPem,
  exportPublicKeyPem,
  generateEd25519KeyPair,
  readPrivateKey,
  readPublicKey,
} from './lib/crypto.mjs';
import {
  buildBundle,
} from './lib/bundle.mjs';
import { rawRecordCount } from './lib/collection.mjs';
import { attestationEventId, buildAttestation, reportsFromInput } from './lib/attest.mjs';
import {
  signEvent,
  verifyBundle,
} from './lib/contract.mjs';
import { buildFeatureBundle, verifyFeatureBundle } from './lib/feature-bundle.mjs';
import { signFeature } from './lib/feature-contract.mjs';
import { exportMapData } from './lib/map-export.mjs';
import { normalizeSource } from './lib/normalize.mjs';
import {
  collectSource as collectServerSource,
  createMemoryCacheStore,
} from './lib/source-collector.mjs';
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
} from './sources/cwa.mjs';
import {
  DEFAULT_NCDR_ENDPOINT,
  fetchNcdrHazards,
  normalizeNcdrHazards,
} from './sources/ncdr.mjs';
import {
  DEFAULT_TDX_ENDPOINT,
  DEFAULT_TDX_NATIONWIDE_ENDPOINTS,
  collectTdxRoadEvents,
  normalizeTdxRoadEvents,
} from './sources/tdx.mjs';
import {
  DEFAULT_MEDICAL_ENDPOINT,
  fetchMedicalFacilities,
  mergeMedicalCoordinates,
  normalizeMedicalFacilitiesReport,
  normalizeMedicalFacilities,
} from './sources/medical.mjs';
import {
  DEFAULT_OSM_ENDPOINT,
  fetchOsmNeihu,
  fetchOsmTaiwan,
  normalizeOsmFeatures,
} from './sources/osm.mjs';
import {
  DEFAULT_SHELTER_ENDPOINT,
  fetchShelters,
  fetchTaiwanShelters,
  normalizeShelters,
} from './sources/shelter.mjs';
import {
  areaBoundary,
  createAreaResolvers,
  normalizeAreaCatalog,
} from './sources/areas.mjs';
import { TAIWAN_COUNTIES } from './sources/taiwan-counties.mjs';
import { getSourceDefinition } from '../server/src/source-registry.mjs';

const NEIHU_BOUNDARY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sources',
  'boundaries',
  'taipei-neihu.geojson',
);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2).replaceAll('-', '_');
    if (key === 'force') {
      options[key] = true;
    } else {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for --${key.replaceAll('_', '-')}`);
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`missing --${name.replaceAll('_', '-')}`);
  return options[name];
}

function requirePrivateKeyPath(options) {
  const value = options.private_key ?? process.env.PIPELINE_SIGNING_PRIVATE_KEY;
  if (!value) throw new Error('missing --private-key or PIPELINE_SIGNING_PRIVATE_KEY');
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readNeihuBoundary() {
  return readJson(NEIHU_BOUNDARY_PATH);
}

async function readScope(options = {}) {
  const scope = options.scope ?? process.env.DATA_SCOPE ?? 'neihu';
  if (scope !== 'taiwan') {
    return {
      scope: 'neihu',
      boundary: await readNeihuBoundary(),
    };
  }
  const boundaryPath = options.boundary
    ?? process.env.TAIWAN_BOUNDARY_PATH
    ?? process.env.AREA_CATALOG_PATH;
  if (!boundaryPath) {
    throw new Error('Taiwan scope requires --boundary <area-catalog.json|boundary.geojson> or TAIWAN_BOUNDARY_PATH');
  }
  const input = await readJson(boundaryPath);
  if (input?.schema_version === 'area-catalog-v0') {
    const resolvers = createAreaResolvers(input);
    return {
      scope: 'taiwan',
      coverage: 'TW',
      boundary: areaBoundary(input),
      areaResolver: resolvers.areaResolver,
      areaIdResolver: resolvers.areaIdResolver,
      boundaryResolver: resolvers.boundaryResolver,
      counties: TAIWAN_COUNTIES,
      areaCatalogPath: boundaryPath,
    };
  }
  return {
    scope: 'taiwan',
    coverage: 'TW',
    boundary: input,
    counties: TAIWAN_COUNTIES,
    areaCatalogPath: boundaryPath,
  };
}

function isTdxRawSnapshot(raw) {
  return raw?.schema_version === 'raw-snapshot-v0' && raw?.source_id === 'tdx-road-events';
}

const STATIC_SOURCES = new Set([
  'osm-neihu',
  'osm-taiwan',
  'taipei-shelter',
  'taiwan-shelter',
  'taipei-medical',
  'taiwan-medical',
]);

function isStaticSource(source) {
  return STATIC_SOURCES.has(source);
}

async function readCoordinateFeatures(options) {
  if (!options.coordinate_input) return undefined;
  return staticFeaturesFromInput(await readJson(options.coordinate_input));
}

function tdxSourceVersion(raw) {
  return raw.source_version
    ?? raw.payload?.UpdateTime
    ?? raw.payload?.update_time
    ?? raw.response?.headers?.etag
    ?? raw.retrieved_at;
}

async function keygen(options) {
  const outDir = requireOption(options, 'out_dir');
  const keyId = options.key_id ?? 'stage2-ed25519-2026';
  await mkdir(outDir, { recursive: true });
  const privatePath = path.join(outDir, 'private-key.pem');
  const publicPath = path.join(outDir, 'public-key.pem');
  if (!options.force) {
    for (const filePath of [privatePath, publicPath]) {
      try {
        await readFile(filePath);
        throw new Error(`${filePath} already exists; use --force only when intentionally replacing it`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const { privateKey, publicKey } = generateEd25519KeyPair();
  await writeFile(privatePath, exportPrivateKeyPem(privateKey), 'utf8');
  await writeFile(publicPath, exportPublicKeyPem(publicKey), 'utf8');
  const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  await writeJson(path.join(outDir, 'key-metadata.json'), {
    key_id: keyId,
    algorithm: 'Ed25519',
    public_key_file: 'public-key.pem',
    public_key_spki_base64: publicKeySpkiBase64,
    private_key_file: 'private-key.pem',
    warning: 'Keep private-key.pem on the server. Never ship it in the Android app or fixtures.',
  });
  console.log(JSON.stringify({ key_id: keyId, public_key: publicPath, private_key: privatePath }, null, 2));
}

async function areaCatalogCommand(options) {
  const inputPath = requireOption(options, 'input');
  const outPath = requireOption(options, 'out');
  const inputPaths = inputPath.split(',').map((value) => value.trim()).filter(Boolean);
  const inputs = await Promise.all(inputPaths.map((filePath) => readJson(filePath)));
  const input = inputs.length === 1
    ? inputs[0]
    : inputs.flatMap((value) => {
      if (value?.type === 'FeatureCollection') return value.features ?? [];
      if (value?.type === 'Feature') return [value];
      if (Array.isArray(value)) return value;
      throw new Error('area-catalog inputs must be GeoJSON features or feature collections');
    });
  const retrievedAt = options.retrieved_at ?? new Date().toISOString();
  const catalog = normalizeAreaCatalog(input, {
    retrievedAt,
    source: options.source ?? 'NLSC',
    sourceVersion: options.source_version ?? retrievedAt,
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeJson(outPath, catalog);
  console.log(JSON.stringify({ out: outPath, area_count: catalog.area_count, coverage: catalog.coverage }, null, 2));
}

async function exportMapCommand(options) {
  const inputValue = requireOption(options, 'input');
  const outPath = requireOption(options, 'out');
  const inputPaths = inputValue.split(',').map((value) => value.trim()).filter(Boolean);
  const inputs = await Promise.all(inputPaths.map((inputPath) => readJson(inputPath)));
  const features = inputs.flatMap((input) => staticFeaturesFromInput(input));
  const output = exportMapData(features, {
    datasetId: options.dataset_id,
    coverage: options.coverage,
    snapshotAt: options.snapshot_at,
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeJson(outPath, output);
  console.log(JSON.stringify({ out: outPath, feature_count: output.features.length, bounds: output.bounds }, null, 2));
}

async function build(options) {
  const inputPath = requireOption(options, 'input');
  const outDir = requireOption(options, 'out_dir');
  const privateKeyPath = requirePrivateKeyPath(options);
  const raw = await readJson(inputPath);
  const privateKey = readPrivateKey(await readFile(privateKeyPath));
  const keyId = options.key_id ?? 'stage2-ed25519-2026';
  const normalized = await normalizeBuildInput(raw, {
    keyId,
    namespace: options.namespace,
    scopeOptions: isEventBatch(raw) ? undefined : await readScope(options),
  });
  const events = normalized.map((event) => signEvent({ ...event, signing_key_id: keyId }, privateKey));
  const datasetVersion = Number(options.dataset_version ?? raw.dataset_version ?? 1);
  if (!Number.isInteger(datasetVersion) || datasetVersion < 1) throw new Error('dataset version must be a positive integer');
  const inferredSource = [...new Set(events.map((event) => event.source))].join('+');
  const bundle = buildBundle(events, {
    datasetId: options.dataset_id ?? raw.dataset_id ?? raw.source_id ?? 'tdx-road-events',
    namespace: options.manifest_namespace ?? 'official',
    datasetVersion,
    source: options.source ?? raw.source ?? (inferredSource || (isTdxRawSnapshot(raw) ? 'TDX' : 'MIXED')),
    sourceVersion: options.source_version
      ?? raw.source_version
      ?? events[0]?.source_version
      ?? (isTdxRawSnapshot(raw) ? tdxSourceVersion(raw) : String(datasetVersion)),
    createdAt: options.created_at ?? raw.retrieved_at ?? events[0]?.provenance?.received_at,
    expiresAt: options.expires_at
      ?? raw.expires_at
      ?? eventExpiresAt(events),
    signingKeyId: keyId,
    privateKey,
    targetSizeBytes: Number(options.target_size_bytes ?? 4096),
  });
  const chunksDir = path.join(outDir, 'chunks');
  await mkdir(chunksDir, { recursive: true });
  await writeJson(path.join(outDir, 'events.json'), { schema_version: 'event-batch-v0', events });
  await writeJson(path.join(outDir, 'manifest.json'), bundle.manifest);
  await Promise.all(bundle.chunks.map((chunk) => writeJson(
    path.join(chunksDir, `${chunk.chunk_id.replaceAll(':', '_')}.json`),
    chunk,
  )));
  await writeJson(path.join(outDir, 'bundle-metadata.json'), {
    dataset_id: bundle.manifest.dataset_id,
    dataset_version: bundle.manifest.dataset_version,
    manifest_id: bundle.manifest.manifest_id,
    manifest_hash: bundle.manifest.manifest_hash,
    event_count: events.length,
    chunk_count: bundle.chunks.length,
    signing_key_id: keyId,
  });
  console.log(JSON.stringify({ out_dir: outDir, manifest: bundle.manifest.manifest_id, chunks: bundle.chunks.length }, null, 2));
}

async function attestCommand(options) {
  const reports = reportsFromInput(await readJson(requireOption(options, 'report')));
  const selected = options.event_id
    ? reports.filter((report) => report.event_id === options.event_id)
    : reports;
  if (selected.length !== 1) {
    throw new Error(`--report must resolve to exactly one report, found ${selected.length}; pass --event-id to choose`);
  }
  const [report] = selected;
  let previous;
  if (options.previous) {
    previous = reportsFromInput(await readJson(options.previous))
      .find((event) => event.event_id === attestationEventId(report.event_id));
    if (!previous) throw new Error('--previous does not contain an attestation for this report');
  }
  const privateKey = readPrivateKey(await readFile(requirePrivateKeyPath(options)));
  const attestation = buildAttestation({
    report,
    verdict: requireOption(options, 'verdict').toUpperCase(),
    privateKey,
    keyId: requireOption(options, 'key_id'),
    issuedAt: options.issued_at ? new Date(options.issued_at) : new Date(),
    previous,
    note: options.note,
  });
  const batch = {
    schema_version: 'event-batch-v0',
    dataset_id: options.dataset_id ?? 'official-verified',
    events: [attestation],
  };
  if (options.out) {
    await writeJson(options.out, batch);
    console.log(JSON.stringify({ out: options.out, event_id: attestation.event_id, event_version: attestation.event_version }, null, 2));
  } else {
    console.log(JSON.stringify(batch, null, 2));
  }
}

function isEventBatch(raw) {
  return raw?.schema_version === 'event-batch-v0' && Array.isArray(raw.events);
}

function eventExpiresAt(events) {
  return events
    .map((event) => event.expires_at)
    .filter(Boolean)
    .sort()
    .at(-1);
}

async function normalizeBuildInput(raw, { keyId, namespace, scopeOptions }) {
  if (isEventBatch(raw)) return raw.events;
  const resolvedScope = scopeOptions ?? await readScope({});
  const options = {
    namespace,
    signingKeyId: keyId,
    ...resolvedScope,
    receivedAt: raw.retrieved_at,
  };
  if (isTdxRawSnapshot(raw)) return normalizeTdxRoadEvents(raw, options);
  if (raw.source_id === 'cwa-earthquake') return normalizeCwaEarthquakes(raw, options);
  if (raw.source_id === 'cwa-weather-warning') return normalizeCwaWarnings(raw, options);
  if (raw.source_id === 'cwa-typhoon-warning') return normalizeCwaTyphoonWarnings(raw, options);
  if (raw.source_id === 'ncdr-hazard-events') return normalizeNcdrHazards(raw, options);
  return normalizeSource(raw, options);
}

async function collect(options) {
  const source = requireOption(options, 'source');
  if (source === 'tdx-road-events') return collectTdx(options);
  if (isStaticSource(source)) return collectStaticSource(source, options);
  if (!['cwa-earthquake', 'cwa-weather-warning', 'cwa-typhoon-warning', 'ncdr-hazard-events'].includes(source)) {
    throw new Error(`unsupported source: ${source}`);
  }
  const outDir = requireOption(options, 'out_dir');
  await mkdir(outDir, { recursive: true });
  try {
    const result = await collectDynamicSource(source, options);
    const rawFile = path.join(outDir, `${source}.raw.json`);
    const eventsFile = path.join(outDir, `${source}.events.json`);
    await writeJson(rawFile, result.rawSnapshot);
    await writeJson(eventsFile, {
      schema_version: 'event-batch-v0',
      source_id: source,
      event_count: result.events.length,
      events: result.events,
    });
    await writeJson(path.join(outDir, 'collection-metadata.json'), {
      schema_version: 'collection-metadata-v0',
      source_id: source,
      mode: 'live',
      source_status: sourceStatusForSnapshot(result.rawSnapshot),
      retrieved_at: result.rawSnapshot.retrieved_at,
      raw_file: path.basename(rawFile),
      events_file: path.basename(eventsFile),
      raw_record_count: rawRecordCount(result.rawSnapshot.payload),
      curated_event_count: result.events.length,
    });
    console.log(JSON.stringify({ out_dir: outDir, raw: rawFile, events: eventsFile, event_count: result.events.length }, null, 2));
  } catch (error) {
    await writeJson(path.join(outDir, 'collection-metadata.json'), {
      schema_version: 'collection-metadata-v0',
      source_id: source,
      mode: 'live',
      source_status: sourceStatusForError(error),
      retrieved_at: options.retrieved_at ?? new Date().toISOString(),
      error_code: error.code ?? 'SOURCE_ERROR',
      error_message: error.message,
    });
    throw error;
  }
}

async function collectStaticSource(source, options) {
  const outDir = requireOption(options, 'out_dir');
  await mkdir(outDir, { recursive: true });
  try {
    const scopeOptions = await readScope(options);
    const result = await collectServerSource({
      definition: getSourceDefinition(source),
      scope: scopeOptions,
      config: {
        env: process.env,
        signingKeyId: options.key_id,
        coordinateFeatures: source === 'taiwan-medical' ? await readCoordinateFeatures(options) : undefined,
      },
      cacheStore: createMemoryCacheStore(),
      now: new Date(options.retrieved_at ?? Date.now()),
    });
    if (!result.rawSnapshot || ['unavailable', 'blocked_by_auth'].includes(result.status)) {
      const error = new Error(`source collection failed: ${result.status}`);
      error.code = result.errorCode ?? 'SOURCE_ERROR';
      if (result.coordinateReport) error.coordinateReport = result.coordinateReport;
      throw error;
    }
    const rawSnapshot = result.rawSnapshot;
    const normalized = result.normalized;
    const rawFile = path.join(outDir, `${source}.raw.json`);
    const featuresFile = path.join(outDir, `${source}.features.json`);
    await writeJson(rawFile, rawSnapshot);
    await writeJson(featuresFile, normalized);
    await writeJson(path.join(outDir, 'collection-metadata.json'), {
      schema_version: 'collection-metadata-v0',
      source_id: source,
      mode: 'live',
      source_status: result.status ?? sourceStatusForSnapshot(rawSnapshot),
      retrieved_at: rawSnapshot.retrieved_at,
      raw_file: path.basename(rawFile),
      features_file: path.basename(featuresFile),
      raw_record_count: rawRecordCount(rawSnapshot.payload),
      curated_feature_count: normalized.feature_count,
      curated_status_event_count: normalized.status_event_count,
      unresolved_status_count: normalized.unresolved_status_count ?? 0,
      unresolved_medical_count: normalized.unresolved_medical_count ?? 0,
      ...(normalized.coordinate_report ? { coordinate_report: normalized.coordinate_report } : {}),
    });
    console.log(JSON.stringify({
      out_dir: outDir,
      raw: rawFile,
      features: featuresFile,
      feature_count: normalized.feature_count,
      status_event_count: normalized.status_event_count,
      ...(normalized.coordinate_report ? { coordinate_report: normalized.coordinate_report } : {}),
    }, null, 2));
  } catch (error) {
    await writeJson(path.join(outDir, 'collection-metadata.json'), {
      schema_version: 'collection-metadata-v0',
      source_id: source,
      mode: 'live',
      source_status: sourceStatusForError(error),
      retrieved_at: options.retrieved_at ?? new Date().toISOString(),
      error_code: error.code ?? 'SOURCE_ERROR',
      error_message: error.message,
      ...(error.coordinateReport ? { coordinate_report: error.coordinateReport } : {}),
    });
    throw error;
  }
}

async function normalizeCommand(options) {
  const source = requireOption(options, 'source');
  const scopeOptions = await readScope(options);
  if (isStaticSource(source)) {
    const inputPath = requireOption(options, 'input');
    const outPath = requireOption(options, 'out');
    const raw = await readJson(inputPath);
    const coordinateFeatures = source === 'taiwan-medical' ? await readCoordinateFeatures(options) : undefined;
    const normalized = normalizeStaticSource(source, raw, {
      ...scopeOptions,
      coordinateFeatures,
      namespace: options.namespace,
      signingKeyId: options.key_id,
      datasetId: options.dataset_id,
      issuedAt: options.issued_at,
      expiresAt: options.expires_at,
      receivedAt: options.received_at ?? raw.retrieved_at,
    });
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeJson(outPath, normalized);
    console.log(JSON.stringify({
      out: outPath,
      feature_count: normalized.feature_count,
      status_event_count: normalized.status_event_count,
    }, null, 2));
    return;
  }
  if (!['tdx-road-events', 'cwa-earthquake', 'cwa-weather-warning', 'cwa-typhoon-warning', 'ncdr-hazard-events'].includes(source)) {
    throw new Error(`unsupported source: ${source}`);
  }
  const inputPath = requireOption(options, 'input');
  const outPath = requireOption(options, 'out');
  const raw = await readJson(inputPath);
  const events = normalizeSourceSpecific(source, raw, {
    namespace: options.namespace,
    signingKeyId: options.key_id,
    ...scopeOptions,
    receivedAt: options.received_at ?? raw.retrieved_at,
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeJson(outPath, {
    schema_version: 'event-batch-v0',
    source_id: source,
    retrieved_at: raw.retrieved_at,
    source_version: events[0]?.source_version,
    event_count: events.length,
    events,
  });
  console.log(JSON.stringify({ out: outPath, event_count: events.length }, null, 2));
}

async function fetchStaticSource(source, options) {
  const retrievedAt = options.retrieved_at;
  if (source === 'osm-neihu') {
    return fetchOsmNeihu({
      endpoint: process.env.OSM_API_ENDPOINT ?? DEFAULT_OSM_ENDPOINT,
      timeoutMs: Number(process.env.OSM_TIMEOUT_MS ?? 120000),
      retrievedAt,
    });
  }
  if (source === 'osm-taiwan') {
    return fetchOsmTaiwan({
      endpoint: process.env.OSM_API_ENDPOINT ?? DEFAULT_OSM_ENDPOINT,
      timeoutMs: Number(process.env.OSM_TIMEOUT_MS ?? 120000),
      retrievedAt,
    });
  }
  if (source === 'taipei-shelter') {
    return fetchShelters({
      endpoint: process.env.SHELTER_DATA_ENDPOINT ?? DEFAULT_SHELTER_ENDPOINT,
      retrievedAt,
    });
  }
  if (source === 'taiwan-shelter') {
    return fetchTaiwanShelters({
      endpoint: process.env.SHELTER_DATA_ENDPOINT ?? DEFAULT_SHELTER_ENDPOINT,
      retrievedAt,
    });
  }
  if (source === 'taipei-medical' || source === 'taiwan-medical') {
    return fetchMedicalFacilities({
      sourceId: source,
      endpoint: process.env.MEDICAL_DATA_ENDPOINT ?? DEFAULT_MEDICAL_ENDPOINT,
      format: process.env.MEDICAL_DATA_FORMAT,
      retrievedAt,
    });
  }
  return fetchMedicalFacilities({
    endpoint: process.env.MEDICAL_DATA_ENDPOINT ?? DEFAULT_MEDICAL_ENDPOINT,
    retrievedAt,
  });
}

function normalizeStaticSource(source, raw, options) {
  if (source === 'osm-neihu' || source === 'osm-taiwan') {
    const features = normalizeOsmFeatures(raw, { ...options, sourceId: source });
    return {
      schema_version: 'static-normalized-v0',
      source_id: source,
      retrieved_at: raw.retrieved_at,
      feature_count: features.length,
      status_event_count: 0,
      features,
      status_events: [],
    };
  }
  if (source === 'taipei-shelter' || source === 'taiwan-shelter') {
    const normalized = normalizeShelters(raw, { ...options, sourceId: source });
    return {
      schema_version: 'static-normalized-v0',
      source_id: source,
      retrieved_at: raw.retrieved_at,
      feature_count: normalized.features.length,
      status_event_count: 0,
      source_count: normalized.source_count,
      located_count: normalized.located_count,
      unlocated_count: normalized.unlocated_count,
      excluded_count: normalized.excluded_count,
      excluded_reason_counts: normalized.excluded_reason_counts,
      location_issue_counts: normalized.location_issue_counts,
      county_coverage: normalized.county_coverage,
      features: normalized.features,
      status_events: [],
    };
  }
  if (source === 'taiwan-medical') {
    const report = normalizeMedicalFacilitiesReport(raw, { ...options, sourceId: source });
    const enriched = options.coordinateFeatures
      ? mergeMedicalCoordinates(report, options.coordinateFeatures, { ...options, rawSnapshot: raw })
      : report;
    return {
      schema_version: 'static-normalized-v0',
      source_id: source,
      retrieved_at: raw.retrieved_at,
      feature_count: enriched.features.length,
      status_event_count: 0,
      unresolved_medical_count: enriched.unresolved.length,
      unresolved_medical: enriched.unresolved,
      features: enriched.features,
      status_events: [],
    };
  }
  if (source !== 'taipei-medical') {
    throw new Error(`unsupported static source: ${source}`);
  }
  const features = normalizeMedicalFacilities(raw, { ...options, sourceId: source });
  return {
    schema_version: 'static-normalized-v0',
    source_id: source,
    retrieved_at: raw.retrieved_at,
    feature_count: features.length,
    status_event_count: 0,
    features,
    status_events: [],
  };
}

async function collectTdx(options) {
  const outDir = requireOption(options, 'out_dir');
  const result = await collectServerSource({
    definition: getSourceDefinition('tdx-road-events'),
    scope: await readScope(options),
    config: { env: process.env, signingKeyId: options.key_id },
    cacheStore: createMemoryCacheStore(),
    now: new Date(options.retrieved_at ?? Date.now()),
  });
  if (!result.rawSnapshot || ['unavailable', 'blocked_by_auth'].includes(result.status)) {
    const error = new Error(`source collection failed: ${result.status}`);
    error.code = result.errorCode ?? 'SOURCE_ERROR';
    throw error;
  }
  const rawSnapshot = result.rawSnapshot;
  const rawFile = path.join(outDir, 'tdx-road-events.raw.json');
  const eventsFile = path.join(outDir, 'tdx-road-events.events.json');
  await mkdir(outDir, { recursive: true });
  await writeJson(rawFile, result.rawSnapshot);
  await writeJson(eventsFile, {
    schema_version: 'event-batch-v0',
    source_id: 'tdx-road-events',
    event_count: result.events.length,
    events: result.events,
  });
  await writeJson(path.join(outDir, 'collection-metadata.json'), {
    schema_version: 'collection-metadata-v0',
    source_id: 'tdx-road-events',
    mode: 'live',
    source_status: result.status,
    retrieved_at: result.rawSnapshot.retrieved_at,
    raw_file: path.basename(rawFile),
    events_file: path.basename(eventsFile),
    raw_record_count: rawRecordCount(result.rawSnapshot.payload),
    curated_event_count: result.events.length,
    unresolved_event_count: result.unresolved_count ?? 0,
  });
  console.log(JSON.stringify({ out_dir: outDir, raw: rawFile, events: eventsFile, event_count: result.events.length }, null, 2));
}

function sourceStatusForError(error) {
  if (error?.code?.includes('CREDENTIAL') || error?.status === 401 || error?.status === 403) {
    return 'blocked_by_auth';
  }
  return 'unavailable';
}

function sourceStatusForSnapshot(rawSnapshot) {
  if (rawSnapshot?.payload?.stale === true) return 'stale';
  if (rawSnapshot?.payload?.partial === true) return 'partial';
  return 'ok';
}

async function collectDynamicSource(source, options) {
  const result = await collectServerSource({
    definition: getSourceDefinition(source),
    scope: await readScope(options),
    config: { env: process.env, signingKeyId: options.key_id },
    cacheStore: createMemoryCacheStore(),
    now: new Date(options.retrieved_at ?? Date.now()),
  });
  if (!result.rawSnapshot || ['unavailable', 'blocked_by_auth'].includes(result.status)) {
    const error = new Error(`source collection failed: ${result.status}`);
    error.code = result.errorCode ?? 'SOURCE_ERROR';
    throw error;
  }
  return result;
}

function normalizeSourceSpecific(source, raw, options) {
  if (source === 'tdx-road-events') return normalizeTdxRoadEvents(raw, options);
  if (source === 'cwa-earthquake') return normalizeCwaEarthquakes(raw, options);
  if (source === 'cwa-weather-warning') return normalizeCwaWarnings(raw, options);
  if (source === 'cwa-typhoon-warning') return normalizeCwaTyphoonWarnings(raw, options);
  return normalizeNcdrHazards(raw, options);
}

function staticFeaturesFromInput(input) {
  const features = ['static-normalized-v0', 'feature-batch-v0', 'layer-chunk-v0'].includes(input?.schema_version)
    ? input.features
    : input;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('static build input must contain a non-empty features array');
  }
  return features;
}

function minTimestamp(values, field) {
  const timestamps = values.map((value) => value[field]).filter(Boolean);
  if (timestamps.length === 0) throw new Error(`static features require ${field}`);
  return timestamps.sort()[0];
}

function maxTimestamp(values, field) {
  const timestamps = values.map((value) => value[field]).filter(Boolean);
  if (timestamps.length === 0) throw new Error(`static features require ${field}`);
  return timestamps.sort().at(-1);
}

async function buildLayer(options) {
  const inputPath = requireOption(options, 'input');
  const outDir = requireOption(options, 'out_dir');
  const privateKeyPath = requirePrivateKeyPath(options);
  const input = await readJson(inputPath);
  const inputFeatures = staticFeaturesFromInput(input);
  const unsignedFeatures = options.layer_id
    ? inputFeatures.filter((feature) => feature.layer_id === options.layer_id)
    : inputFeatures;
  if (unsignedFeatures.length === 0) throw new Error(`no static features found for layer_id=${options.layer_id}`);
  const keyId = options.key_id ?? 'stage2-ed25519-2026';
  const privateKey = readPrivateKey(await readFile(privateKeyPath));
  const features = unsignedFeatures.map((feature) => {
    const unsigned = { ...feature, signing_key_id: keyId };
    delete unsigned.payload_hash;
    delete unsigned.signature;
    return signFeature(unsigned, privateKey);
  });
  const layerIds = [...new Set(features.map((feature) => feature.layer_id))];
  const namespaces = [...new Set(features.map((feature) => feature.namespace))];
  if (layerIds.length !== 1) throw new Error('build-layer accepts one layer_id per input');
  if (namespaces.length !== 1) throw new Error('build-layer accepts one namespace per input');
  const datasetId = options.dataset_id ?? features[0].dataset_id;
  const layerId = options.layer_id ?? layerIds[0];
  const namespace = options.manifest_namespace ?? namespaces[0];
  const datasetVersion = Number(options.dataset_version ?? 1);
  if (!Number.isInteger(datasetVersion) || datasetVersion < 1) throw new Error('dataset version must be a positive integer');
  const source = options.source ?? [...new Set(features.map((feature) => feature.source))].join('+');
  const sourceVersion = options.source_version ?? [...new Set(features.map((feature) => feature.source_version))].join('+');
  const bundle = buildFeatureBundle(features, {
    datasetId,
    layerId,
    namespace,
    source,
    sourceVersion,
    datasetVersion,
    createdAt: options.created_at ?? minTimestamp(features, 'issued_at'),
    expiresAt: options.expires_at ?? maxTimestamp(features, 'expires_at'),
    signingKeyId: keyId,
    privateKey,
    priority: options.priority,
    targetSizeBytes: Number(options.target_size_bytes ?? 4096),
  });
  const chunksDir = path.join(outDir, 'chunks');
  await mkdir(chunksDir, { recursive: true });
  await writeJson(path.join(outDir, 'features.json'), { schema_version: 'feature-batch-v0', features });
  await writeJson(path.join(outDir, 'manifest.json'), bundle.manifest);
  await Promise.all(bundle.chunks.map((chunk) => writeJson(
    path.join(chunksDir, `${chunk.chunk_id.replaceAll(':', '_')}.json`),
    chunk,
  )));
  await writeJson(path.join(outDir, 'bundle-metadata.json'), {
    bundle_type: 'static-layer',
    dataset_id: bundle.manifest.dataset_id,
    layer_id: bundle.manifest.layer_id,
    dataset_version: bundle.manifest.dataset_version,
    manifest_id: bundle.manifest.manifest_id,
    manifest_hash: bundle.manifest.manifest_hash,
    feature_count: features.length,
    chunk_count: bundle.chunks.length,
    signing_key_id: keyId,
  });
  console.log(JSON.stringify({ out_dir: outDir, manifest: bundle.manifest.manifest_id, chunks: bundle.chunks.length, feature_count: features.length }, null, 2));
}

async function verifyBundleCommand(options) {
  const manifestPath = requireOption(options, 'manifest');
  const chunksDir = requireOption(options, 'chunks_dir');
  const publicKeyPath = requireOption(options, 'public_key');
  const manifest = await readJson(manifestPath);
  const fileNames = (await readdir(chunksDir)).filter((name) => name.endsWith('.json')).sort();
  const chunks = await Promise.all(fileNames.map((name) => readJson(path.join(chunksDir, name))));
  const publicKey = readPublicKey(await readFile(publicKeyPath));
  const result = verifyBundle(
    { manifest, chunks },
    publicKey,
    {
      trustedKeyIds: [manifest.signing_key_id],
      now: options.now ?? new Date().toISOString(),
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

async function verifyLayerCommand(options) {
  const manifestPath = requireOption(options, 'manifest');
  const chunksDir = requireOption(options, 'chunks_dir');
  const publicKeyPath = requireOption(options, 'public_key');
  const manifest = await readJson(manifestPath);
  const fileNames = (await readdir(chunksDir)).filter((name) => name.endsWith('.json')).sort();
  const chunks = await Promise.all(fileNames.map((name) => readJson(path.join(chunksDir, name))));
  const publicKey = readPublicKey(await readFile(publicKeyPath));
  const result = verifyFeatureBundle(
    { manifest, chunks },
    publicKey,
    {
      trustedKeyIds: [manifest.signing_key_id],
      now: options.now ?? new Date().toISOString(),
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

function printHelp() {
  console.log(`Usage:
  node pipeline/cli.mjs keygen --out-dir <dir> [--key-id <id>]
  node pipeline/cli.mjs area-catalog --input <county.geojson,town.geojson> --out <area-catalog.json>
  node pipeline/cli.mjs export-map --input <features.json[,more.json]> --out <static-features.json>
  node pipeline/cli.mjs collect --source tdx-road-events --out-dir <dir>
  node pipeline/cli.mjs collect --source cwa-earthquake|cwa-weather-warning|cwa-typhoon-warning|ncdr-hazard-events --out-dir <dir>
  node pipeline/cli.mjs collect --source osm-neihu|osm-taiwan|taipei-shelter|taiwan-shelter|taipei-medical|taiwan-medical --out-dir <dir>
  node pipeline/cli.mjs normalize --source <source> --input <raw.json> --out <events-or-features.json>
  node pipeline/cli.mjs build --input <tdx.json> --out-dir <dir> --private-key <pem> [options]
  node pipeline/cli.mjs verify --manifest <manifest.json> --chunks-dir <dir> --public-key <pem> [--now <time>]
  node pipeline/cli.mjs build-layer --input <features.json> --out-dir <dir> --private-key <pem> [options]
  node pipeline/cli.mjs verify-layer --manifest <manifest.json> --chunks-dir <dir> --public-key <pem> [--now <time>]
  node pipeline/cli.mjs attest --report <reports.json> [--event-id <id>] --verdict CONFIRMED|REFUTED
                               --private-key <pem> --key-id <official id> [--previous <attestation.json>]
                               [--note <text>] [--out <attestation.json>]

attest writes an event-batch-v0 holding one official.verified event; package it
for the phones with: build --input <attestation.json> --key-id <same id> ...

Taiwan-scoped commands require --scope taiwan and either --boundary pointing to
an AreaCatalog or TAIWAN_BOUNDARY_PATH / AREA_CATALOG_PATH. Create an AreaCatalog
from the official boundary GeoJSON export with the area-catalog command first.

Live TDX collection reads TDX_CLIENT_ID, TDX_CLIENT_SECRET, and optional
TDX_API_ENDPOINT / TDX_API_ENDPOINTS / TDX_TOKEN_ENDPOINT from the process environment.
Taiwan scope requests TDX_API_ENDPOINTS, or the built-in Taiwan city/county list;
the built-in list remains subject to the endpoint and quota permissions of the TDX account.

Live CWA collection reads CWA_API_KEY and optional CWA_EARTHQUAKE_ENDPOINT /
CWA_WARNING_ENDPOINT / CWA_TYPHOON_ENDPOINT. Live NCDR collection reads
NCDR_ALERT_API_KEY (legacy NCDR_API_KEY is accepted), then calls the configured
NCDR_ALERT_ENDPOINT list route and NCDR_ALERT_DETAIL_ENDPOINT CAP detail route
(the `/api/datastore` to `/api/dump/datastore` route is derived automatically).
Missing or unauthorized access writes collection metadata with
source_status=blocked_by_auth and exits non-zero.

Static source collection reads optional OSM_API_ENDPOINT, SHELTER_DATA_ENDPOINT,
and MEDICAL_DATA_ENDPOINT. Static features are signed only by build-layer; the
phone receives the resulting manifest and chunks, never the private key.

Build options:
  --private-key (or PIPELINE_SIGNING_PRIVATE_KEY),
  --key-id, --namespace, --manifest-namespace, --dataset-id,
  --dataset-version, --created-at, --expires-at, --target-size-bytes
`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'keygen') return keygen(options);
  if (command === 'area-catalog') return areaCatalogCommand(options);
  if (command === 'export-map') return exportMapCommand(options);
  if (command === 'collect') return collect(options);
  if (command === 'normalize') return normalizeCommand(options);
  if (command === 'build') return build(options);
  if (command === 'verify') return verifyBundleCommand(options);
  if (command === 'build-layer') return buildLayer(options);
  if (command === 'verify-layer') return verifyLayerCommand(options);
  if (command === 'attest') return attestCommand(options);
  printHelp();
  if (command) throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 2;
});
