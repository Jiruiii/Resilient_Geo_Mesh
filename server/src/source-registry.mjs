const DYNAMIC_OUTPUT = Object.freeze({ type: 'government-feed' });

function dynamic(sourceId, feedId, scheduleMs, coverage = 'TW', enabledByDefault = true) {
  return Object.freeze({
    sourceId,
    feedId,
    kind: 'dynamic',
    scheduleMs,
    coverage,
    output: DYNAMIC_OUTPUT,
    enabledByDefault,
  });
}

function staticLayer(sourceId, scheduleMs = 24 * 60 * 60 * 1000, enabledByDefault = true) {
  return Object.freeze({
    sourceId,
    feedId: null,
    kind: 'static',
    scheduleMs,
    coverage: 'TW',
    output: Object.freeze({ type: 'layer', layerId: sourceId }),
    enabledByDefault,
  });
}

export const SOURCE_REGISTRY = Object.freeze([
  dynamic('tdx-road-events', 'tdx-road', 15 * 60 * 1000, 'TW', false),
  dynamic('cwa-earthquake', 'cwa-earthquake', 10 * 60 * 1000),
  dynamic('cwa-weather-warning', 'cwa-warning', 10 * 60 * 1000),
  dynamic('cwa-typhoon-warning', 'cwa-typhoon', 10 * 60 * 1000),
  dynamic('ncdr-hazard-events', 'ncdr', 10 * 60 * 1000),
  staticLayer('taiwan-shelter'),
  staticLayer('taiwan-medical'),
  staticLayer('taiwan-emergency-medical', 24 * 60 * 60 * 1000, false),
  staticLayer('osm-taiwan', 24 * 60 * 60 * 1000, false),
]);

// Search-only medical directory is published beside map layers from the
// `taiwan-medical` source result; it is not a separate upstream collector.
export const AUXILIARY_LAYER_IDS = Object.freeze(['taiwan-medical-directory']);

const SOURCE_BY_ID = new Map(SOURCE_REGISTRY.map((source) => [source.sourceId, source]));

export function getSourceDefinition(sourceId) {
  const source = SOURCE_BY_ID.get(sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  return source;
}

export function defaultSourceIds() {
  return SOURCE_REGISTRY.filter((source) => source.enabledByDefault).map((source) => source.sourceId);
}
