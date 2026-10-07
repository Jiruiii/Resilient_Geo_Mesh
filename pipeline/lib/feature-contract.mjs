import { normalizeCoordinate } from './geo.mjs';
import { signCanonical, verifyCanonical } from './crypto.mjs';
import { sha256Canonical } from './canonical.mjs';

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const NAMESPACE_RE = /^[a-z][a-z0-9._-]{0,31}$/u;
const FEATURE_TYPES = new Set([
  'ROAD',
  'SHELTER',
  'HOSPITAL',
  'CLINIC',
  'MEDICAL_FACILITY',
  'POI',
  'OSM_FEATURE',
]);
const GEOMETRY_TYPES = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
]);

const FEATURE_PAYLOAD_FIELDS = [
  'namespace',
  'dataset_id',
  'layer_id',
  'feature_id',
  'feature_type',
  'geometry',
  'properties',
  'source',
  'source_version',
  'issued_at',
  'expires_at',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTime(value, field) {
  if (typeof value !== 'string' || !RFC3339_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an RFC 3339 timestamp`);
  }
  return new Date(value);
}

function validPosition(position) {
  try {
    normalizeCoordinate(position);
    return true;
  } catch {
    return false;
  }
}

function samePosition(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length >= 2 && right.length >= 2
    && left[0] === right[0] && left[1] === right[1];
}

function geometryErrors(geometry, path = 'geometry') {
  const errors = [];
  if (!isObject(geometry) || !GEOMETRY_TYPES.has(geometry.type)) {
    return [`${path} must be a supported GeoJSON geometry`];
  }
  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries) || geometry.geometries.length === 0) {
      return [`${path}.geometries must be non-empty`];
    }
    return geometry.geometries.flatMap((child, index) => geometryErrors(child, `${path}.geometries[${index}]`));
  }
  if (!Array.isArray(geometry.coordinates)) return [`${path}.coordinates must be an array`];
  if (geometry.type === 'Point') {
    if (!validPosition(geometry.coordinates)) errors.push(`${path}.coordinates is invalid`);
  } else if (geometry.type === 'LineString') {
    if (geometry.coordinates.length < 2) errors.push(`${path}.coordinates must contain two positions`);
    geometry.coordinates.forEach((position, index) => {
      if (!validPosition(position)) errors.push(`${path}.coordinates[${index}] is invalid`);
    });
  } else if (geometry.type === 'Polygon') {
    if (geometry.coordinates.length < 1) errors.push(`${path}.coordinates must contain a ring`);
    geometry.coordinates.forEach((ring, ringIndex) => {
      if (!Array.isArray(ring) || ring.length < 4) {
        errors.push(`${path}.coordinates[${ringIndex}] must contain four positions`);
        return;
      }
      ring.forEach((position, positionIndex) => {
        if (!validPosition(position)) errors.push(`${path}.coordinates[${ringIndex}][${positionIndex}] is invalid`);
      });
      if (!samePosition(ring[0], ring.at(-1))) errors.push(`${path}.coordinates[${ringIndex}] must be closed`);
    });
  } else if (geometry.type === 'MultiPoint') {
    if (geometry.coordinates.length < 1) errors.push(`${path}.coordinates must be non-empty`);
    geometry.coordinates.forEach((position, index) => {
      if (!validPosition(position)) errors.push(`${path}.coordinates[${index}] is invalid`);
    });
  } else if (geometry.type === 'MultiLineString') {
    if (geometry.coordinates.length < 1) errors.push(`${path}.coordinates must be non-empty`);
    geometry.coordinates.forEach((line, lineIndex) => {
      if (!Array.isArray(line) || line.length < 2) errors.push(`${path}.coordinates[${lineIndex}] must contain two positions`);
      line?.forEach((position, positionIndex) => {
        if (!validPosition(position)) errors.push(`${path}.coordinates[${lineIndex}][${positionIndex}] is invalid`);
      });
    });
  } else if (geometry.type === 'MultiPolygon') {
    if (geometry.coordinates.length < 1) errors.push(`${path}.coordinates must be non-empty`);
    geometry.coordinates.forEach((polygon, polygonIndex) => {
      errors.push(...geometryErrors({ type: 'Polygon', coordinates: polygon }, `${path}.coordinates[${polygonIndex}]`));
    });
  }
  return errors;
}

function validBase64(value) {
  return typeof value === 'string' && value.length >= 4 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

function requiredStringErrors(feature) {
  const errors = [];
  for (const field of ['dataset_id', 'layer_id', 'feature_id', 'source', 'source_version', 'signing_key_id']) {
    if (typeof feature[field] !== 'string' || feature[field].length === 0) errors.push(`${field} must be a non-empty string`);
  }
  if (typeof feature.namespace !== 'string' || !NAMESPACE_RE.test(feature.namespace)) errors.push('namespace is invalid');
  for (const field of ['dataset_id', 'layer_id', 'feature_id']) {
    if (typeof feature[field] === 'string' && !IDENTIFIER_RE.test(feature[field])) errors.push(`${field} is invalid`);
  }
  if (typeof feature.feature_type !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(feature.feature_type)) {
    errors.push('feature_type is invalid');
  }
  return errors;
}

export function featurePayload(feature) {
  return Object.fromEntries(FEATURE_PAYLOAD_FIELDS
    .filter((field) => feature[field] !== undefined)
    .map((field) => [field, feature[field]]));
}

export function validateFeatureShape(feature, { signed = true } = {}) {
  if (!isObject(feature)) return ['feature must be an object'];
  const errors = [];
  for (const field of [
    'schema_version',
    'namespace',
    'dataset_id',
    'layer_id',
    'feature_id',
    'feature_type',
    'geometry',
    'properties',
    'source',
    'source_version',
    'issued_at',
    'expires_at',
    'signature_algorithm',
    'signing_key_id',
    'provenance',
  ]) {
    if (!(field in feature)) errors.push(`missing required field: ${field}`);
  }
  if (feature.schema_version !== 'feature-v0') errors.push('schema_version must be feature-v0');
  errors.push(...requiredStringErrors(feature));
  const directoryEntry = feature.layer_id === 'taiwan-medical-directory'
    && feature.feature_type === 'MEDICAL_DIRECTORY_ENTRY';
  if (directoryEntry) {
    if (feature.geometry !== null) errors.push('medical directory geometry must be null');
    const status = feature.properties?.geometry_status;
    const pointId = feature.properties?.point_feature_id;
    if (!['located', 'unresolved', 'excluded'].includes(status)) {
      errors.push('medical directory geometry_status is invalid');
    } else if (status === 'located' && (typeof pointId !== 'string' || pointId.length === 0)) {
      errors.push('located medical directory entries require point_feature_id');
    } else if (status !== 'located' && pointId !== null) {
      errors.push('unlocated medical directory entries cannot have point_feature_id');
    }
  } else {
    errors.push(...geometryErrors(feature.geometry));
  }
  if (!isObject(feature.properties)) errors.push('properties must be an object');
  let issuedAt;
  let expiresAt;
  try { issuedAt = parseTime(feature.issued_at, 'issued_at'); } catch (error) { errors.push(error.message); }
  try { expiresAt = parseTime(feature.expires_at, 'expires_at'); } catch (error) { errors.push(error.message); }
  if (issuedAt && expiresAt && expiresAt < issuedAt) errors.push('expires_at must not precede issued_at');
  if (feature.signature_algorithm !== 'Ed25519') errors.push('signature_algorithm must be Ed25519');
  if (!isObject(feature.provenance)) {
    errors.push('provenance must be an object');
  } else {
    if (typeof feature.provenance.original_source !== 'string' || feature.provenance.original_source.length === 0) {
      errors.push('provenance.original_source must be a non-empty string');
    }
    try { parseTime(feature.provenance.received_at, 'provenance.received_at'); } catch (error) { errors.push(error.message); }
    if (!isObject(feature.provenance.transport_source) || typeof feature.provenance.transport_source.kind !== 'string') {
      errors.push('provenance.transport_source.kind is required');
    }
  }
  if (signed) {
    if (typeof feature.payload_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/iu.test(feature.payload_hash)) {
      errors.push('payload_hash must match sha256:<64 hex characters>');
    }
    if (!validBase64(feature.signature)) errors.push('signature must be base64');
  }
  return errors;
}

export function signFeature(feature, privateKey) {
  const errors = validateFeatureShape(feature, { signed: false });
  if (errors.length > 0) throw new TypeError(`invalid feature: ${errors.join('; ')}`);
  if (!privateKey) throw new TypeError('signFeature requires a private key');
  const payloadHash = sha256Canonical(featurePayload(feature));
  const signed = {
    ...feature,
    payload_hash: payloadHash,
    signature_algorithm: 'Ed25519',
  };
  return {
    ...signed,
    signature: signCanonical({ ...featurePayload(signed), payload_hash: payloadHash }, privateKey),
  };
}

export function verifyFeature(feature, publicKey, options = {}) {
  const errors = validateFeatureShape(feature);
  if (errors.length > 0) return { valid: false, stage: 'schema', errors, current: false };
  if (options.trustedKeyIds?.length > 0 && !options.trustedKeyIds.includes(feature.signing_key_id)) {
    return { valid: false, stage: 'trust', errors: ['signing_key_id is not trusted'], current: false };
  }
  const expectedHash = sha256Canonical(featurePayload(feature));
  if (expectedHash !== feature.payload_hash) {
    return { valid: false, stage: 'integrity', errors: ['payload_hash_mismatch'], expectedHash, current: false };
  }
  if (!publicKey || !verifyCanonical({ ...featurePayload(feature), payload_hash: feature.payload_hash }, feature.signature, publicKey)) {
    return { valid: false, stage: 'signature', errors: ['signature_invalid'], current: false };
  }
  const now = options.now ? new Date(options.now) : new Date();
  const expired = now >= new Date(feature.expires_at);
  return { valid: true, expired, current: !expired, errors: [] };
}
