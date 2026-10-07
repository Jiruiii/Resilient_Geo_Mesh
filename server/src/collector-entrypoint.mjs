import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  areaBoundary,
  createAreaResolvers,
  createTownCodeResolver,
  townNameMapFromAreaCatalog,
} from '../../pipeline/sources/areas.mjs';
import { TAIWAN_COUNTIES } from '../../pipeline/sources/taiwan-counties.mjs';
import { readPrivateKey, readPublicKey } from '../../pipeline/lib/crypto.mjs';
import { collectSources as defaultCollectSources } from '../../pipeline/lib/source-collector.mjs';
import {
  readSourceNormalized,
  readSourceSnapshot,
  readSourceState,
  writeSourceResult,
} from './storage/source-cache.mjs';
import { loadServerConfig } from './config.mjs';
import { defaultSourceIds, SOURCE_REGISTRY } from './source-registry.mjs';
import { createScheduler } from './collector/scheduler.mjs';
import { runScheduledCollection } from './collector/collector-runner.mjs';
import {
  commitReleasePointer,
  publishGovernmentRelease,
  publishSourceStatus,
  publishStaticLayer,
} from './publisher/release-publisher.mjs';
import { createAzureRuntimeStorage } from './storage/azure-runtime.mjs';

export function createFileCacheStore(dataRoot) {
  return {
    readState: (sourceId) => readSourceState(dataRoot, sourceId),
    readSnapshot: (sourceId) => readSourceSnapshot(dataRoot, sourceId),
    readNormalized: (sourceId) => readSourceNormalized(dataRoot, sourceId),
    writeResult: (sourceId, result) => writeSourceResult(dataRoot, sourceId, result),
  };
}

function publishedFeatures(result, features = result.features ?? [], layerId = result.sourceId) {
  return features.map((feature) => ({
    ...feature,
    layer_id: layerId,
  }));
}

function resultFromCache(definition, state, normalized) {
  const events = normalized.events ?? normalized.status_events ?? [];
  return {
    sourceId: definition.sourceId,
    feedId: definition.feedId,
    kind: definition.kind,
    status: state.status === 'ok' ? 'not_modified' : state.status,
    errorCode: state.error_code ?? null,
    retrievedAt: normalized.retrieved_at ?? state.retrieved_at ?? null,
    normalized,
    events,
    features: normalized.features ?? [],
    status_events: normalized.status_events ?? [],
    coordinateReport: normalized.coordinate_report,
    emergencyMedicalFeatures: normalized.emergency_medical_features ?? [],
    emergencyMedicalReport: normalized.emergency_medical_report,
    unresolved_count: normalized.unresolved_medical_count ?? 0,
    publishable: definition.kind === 'static' && (normalized.features ?? []).length > 0,
  };
}

function createPublisher({ config, signingKey, getNow }) {
  const releasePointerStore = config.releasePointerStore;
  return async (results, { assertLockHeld } = {}) => {
    const now = getNow();
    const government = await publishGovernmentRelease({
      releaseRoot: config.publicReleaseRoot,
      previousRoot: config.publicReleaseRoot,
      results,
      signingKey,
      now,
      releasePointerStore,
      deferPointer: true,
    });
    const layerVersions = {};
    for (const result of results) {
      if (result.kind !== 'static') continue;
      if ((result.features ?? []).length > 0) {
        const layer = await publishStaticLayer({
          layerId: result.sourceId,
          features: publishedFeatures(result),
          releaseRoot: config.publicReleaseRoot,
          signingKey,
          now,
          releasePointerStore,
          deferPointer: true,
        });
        layerVersions[result.sourceId] = layer.datasetVersion;
      }
      if (result.sourceId === 'taiwan-medical' && (result.emergencyMedicalFeatures ?? []).length > 0) {
        const layer = await publishStaticLayer({
          layerId: 'taiwan-emergency-medical',
          features: publishedFeatures(result, result.emergencyMedicalFeatures, 'taiwan-emergency-medical'),
          releaseRoot: config.publicReleaseRoot,
          signingKey,
          now,
          releasePointerStore,
          deferPointer: true,
        });
        layerVersions['taiwan-emergency-medical'] = layer.datasetVersion;
      }
      const directoryFeatures = result.normalized?.medical_directory_features ?? [];
      if (result.sourceId === 'taiwan-medical' && directoryFeatures.length > 0) {
        const layer = await publishStaticLayer({
          layerId: 'taiwan-medical-directory',
          features: publishedFeatures(result, directoryFeatures, 'taiwan-medical-directory'),
          releaseRoot: config.publicReleaseRoot,
          signingKey,
          now,
          releasePointerStore,
          deferPointer: true,
        });
        layerVersions['taiwan-medical-directory'] = layer.datasetVersion;
      }
    }
    await assertLockHeld?.();
    await commitReleasePointer({
      releaseRoot: config.publicReleaseRoot,
      revision: government.revision,
      v2ManifestPath: government.v2ManifestPath,
      layerVersions,
      releasePointerStore,
    });
    return government;
  };
}

function createFailurePublisher({ config, getNow }) {
  if (!config.publicReleaseRoot) return undefined;
  return (results) => publishSourceStatus({
    releaseRoot: config.publicReleaseRoot,
    results,
    now: getNow(),
    releasePointerStore: config.releasePointerStore,
  });
}

export function createCollectorService({
  config = {},
  cacheStore,
  scope = {},
  sourceIds = defaultSourceIds(),
  adapters,
  collectSources = defaultCollectSources,
  publisher,
  signingKey,
  registry = SOURCE_REGISTRY,
  clock = globalThis,
} = {}) {
  if (!config.privateDataRoot) throw new TypeError('collector config requires privateDataRoot');
  if (!config.publicReleaseRoot && !publisher) throw new TypeError('collector config requires publicReleaseRoot');
  if (!signingKey && !publisher) throw new TypeError('signingKey is required for the default publisher');
  const store = cacheStore ?? createFileCacheStore(config.privateDataRoot);
  let currentNow = new Date();
  const publish = publisher ?? createPublisher({ config, signingKey, getNow: () => currentNow });
  const publishFailureStatus = createFailurePublisher({ config, getNow: () => currentNow });
  const collect = (options) => collectSources({ ...options, adapters });
  const allSourceDefinitions = registry.filter((source) => sourceIds.includes(source.sourceId));

  async function collectCompleteSources(options) {
    const freshResults = await collect(options);
    const freshById = new Map(freshResults.map((result) => [result.sourceId, result]));
    const complete = [];
    for (const definition of allSourceDefinitions) {
      const fresh = freshById.get(definition.sourceId);
      if (fresh) {
        complete.push(fresh);
        continue;
      }
      const [state, normalized] = await Promise.all([
        store.readState(definition.sourceId),
        store.readNormalized(definition.sourceId),
      ]);
      if (!state || !normalized) {
        const error = new Error(`source cache is missing: ${definition.sourceId}`);
        error.code = 'SOURCE_CACHE_MISSING';
        throw error;
      }
      complete.push(resultFromCache(definition, state, normalized));
    }
    return complete;
  }

  async function runOnce({ now = new Date(), selectedSourceIds = sourceIds } = {}) {
    currentNow = now instanceof Date ? now : new Date(now);
    return runScheduledCollection({
      sourceIds: selectedSourceIds,
      scope,
      config,
      cacheStore: store,
      publisher: publish,
      onFailure: publishFailureStatus,
      now: currentNow,
      collectSources: collectCompleteSources,
    });
  }

  const selectedDefinitions = allSourceDefinitions;
  const scheduler = createScheduler({
    registry: selectedDefinitions,
    clock,
    run: ({ sourceIds: selectedSourceIds }) => runOnce({ selectedSourceIds, now: new Date() }),
    onError: (error, sourceId) => {
      console.error(`[collector] scheduled run failed source=${sourceId} code=${error.code ?? 'COLLECTOR_ERROR'}`);
    },
  });

  return Object.freeze({
    scheduler,
    runOnce,
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    runNow: (sourceId) => scheduler.runNow(sourceId),
  });
}

export function resolveInitialSourceIds(value) {
  if (value === undefined) return defaultSourceIds();
  if (typeof value !== 'string') throw new TypeError('COLLECTOR_INITIAL_SOURCE_IDS must be a comma-separated string');
  if (value.trim() === '') return defaultSourceIds();

  const selectedSourceIds = value.split(',').map((sourceId) => sourceId.trim());
  if (selectedSourceIds.some((sourceId) => sourceId.length === 0)) {
    throw new TypeError('COLLECTOR_INITIAL_SOURCE_IDS contains an empty source ID');
  }
  if (new Set(selectedSourceIds).size !== selectedSourceIds.length) {
    throw new TypeError('COLLECTOR_INITIAL_SOURCE_IDS contains duplicate source IDs');
  }
  const enabledSourceIds = new Set(defaultSourceIds());
  if (selectedSourceIds.some((sourceId) => !enabledSourceIds.has(sourceId))) {
    throw new TypeError('COLLECTOR_INITIAL_SOURCE_IDS contains a non-default source ID');
  }
  return selectedSourceIds;
}

async function loadScope(areaCatalogPath) {
  const input = JSON.parse(await readFile(areaCatalogPath, 'utf8'));
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
      areaCatalogPath,
      townNamesByCode: townNameMapFromAreaCatalog(input),
      townCodeResolver: createTownCodeResolver(input),
    };
  }
  return { scope: 'taiwan', coverage: 'TW', boundary: input, counties: TAIWAN_COUNTIES, areaCatalogPath };
}

async function readJsonConfig(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function signingMaterialFromEnvOrFile(environmentName, filePath) {
  return process.env[environmentName] ?? readFile(filePath);
}

async function main() {
  const config = loadServerConfig(process.env);
  const [privatePem, publicPem, scope, emergencyMedicalRoster, emergencyMedicalCrosswalk] = await Promise.all([
    signingMaterialFromEnvOrFile('SIGNING_PRIVATE_KEY_PEM', config.signingPrivateKeyPath),
    signingMaterialFromEnvOrFile('SIGNING_PUBLIC_KEY_PEM', config.signingPublicKeyPath),
    loadScope(config.areaCatalogPath),
    config.emergencyMedicalRosterPath ? readJsonConfig(config.emergencyMedicalRosterPath) : null,
    config.emergencyMedicalCrosswalkPath ? readJsonConfig(config.emergencyMedicalCrosswalkPath) : null,
  ]);
  const azureStorage = createAzureRuntimeStorage(config);
  const collectorConfig = {
    ...config,
    ...azureStorage,
    emergencyMedicalRoster,
    emergencyMedicalCrosswalk,
    addressPackPublicKey: readPublicKey(publicPem),
  };
  const signingKey = {
    privateKey: readPrivateKey(privatePem),
    publicKey: readPublicKey(publicPem),
    keyId: config.signingKeyId,
  };
  const service = createCollectorService({ config: collectorConfig, scope, signingKey });
  const initialRun = await service.runOnce({
    selectedSourceIds: resolveInitialSourceIds(process.env.COLLECTOR_INITIAL_SOURCE_IDS),
  });
  console.log(`[collector] initial run ${JSON.stringify({
    skipped: initialRun.skipped === true,
    reason: initialRun.reason ?? null,
    source_count: initialRun.source_count ?? 0,
    failed_sources: initialRun.failed_sources ?? [],
    source_statuses: initialRun.source_statuses ?? [],
  })}`);
  if (process.env.COLLECTOR_ONESHOT === 'true') return;
  service.start();
  const shutdown = () => {
    service.stop();
    process.exitCode = 0;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();

export { loadScope };
