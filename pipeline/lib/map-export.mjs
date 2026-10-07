import { bboxOfGeometry } from './geo.mjs';

const DISPLAY_FIELDS = [
  'name',
  'address',
  'phone',
  'departments',
  'capacity',
  'disaster_types',
  'administrative_area',
  'facility_type',
  'area_id',
  'county_code',
  'town_code',
  'village_code',
  'coverage',
  'coordinate_source',
  'osm_id',
];

function displayKind(feature) {
  if (feature.layer_id === 'osm-road') return 'road';
  if (feature.layer_id === 'shelter' || feature.feature_type === 'SHELTER') return 'shelter';
  if (['medical', 'taiwan-medical'].includes(feature.layer_id)
    || ['HOSPITAL', 'CLINIC', 'MEDICAL_FACILITY'].includes(feature.feature_type)) return 'medical';
  return 'poi';
}

function displayFields(properties = {}) {
  return Object.fromEntries(DISPLAY_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(properties, field))
    .map((field) => [field, properties[field]]));
}

function featureBounds(features) {
  if (features.length === 0) return null;
  const boxes = features.map((feature) => bboxOfGeometry(feature.geometry));
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ].map((value) => Number(value.toFixed(7)));
}

export function exportMapData(features, options = {}) {
  if (!Array.isArray(features)) throw new TypeError('exportMapData requires a feature array');
  const displayFeatures = features
    .filter((feature) => feature && typeof feature === 'object' && feature.geometry)
    .map((feature) => ({
      id: feature.feature_id,
      kind: displayKind(feature),
      geometry: feature.geometry,
      source: feature.source,
      ...displayFields(feature.properties),
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const datasetId = options.datasetId
    ?? features.find((feature) => typeof feature?.dataset_id === 'string')?.dataset_id
    ?? 'resilientgeo-taiwan';
  const snapshotAt = options.snapshotAt
    ?? features.map((feature) => feature.issued_at).filter(Boolean).sort().at(-1)
    ?? null;
  const sourceIds = [...new Set(features.map((feature) => feature.source).filter(Boolean))].sort();
  return {
    schema_version: 'offline-map-display-v1',
    dataset_id: datasetId,
    snapshot_at: snapshotAt,
    coverage: options.coverage ?? (datasetId.includes('taiwan') ? 'TW' : undefined),
    bounds: featureBounds(displayFeatures),
    sources: sourceIds.map((sourceId) => ({
      source_id: sourceId,
      snapshot_at: snapshotAt,
      ...(sourceId.startsWith('osm-') ? {
        attribution: '© OpenStreetMap contributors',
        attribution_url: 'https://www.openstreetmap.org/copyright',
      } : {}),
    })),
    features: displayFeatures,
  };
}
