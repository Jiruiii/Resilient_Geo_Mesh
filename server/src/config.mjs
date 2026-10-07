import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_REGISTRY } from './source-registry.mjs';
import {
  DEFAULT_MEDICAL_COORDINATE_CONCURRENCY,
  DEFAULT_MEDICAL_COORDINATE_ENDPOINT,
  DEFAULT_MEDICAL_COORDINATE_MAX_QUERIES,
  DEFAULT_MEDICAL_COORDINATE_RADIUS_METERS,
  DEFAULT_MEDICAL_COORDINATE_SPACING_METERS,
} from '../../pipeline/sources/medical-coordinates.mjs';

const SCHEDULE_ENV_BY_SOURCE = Object.freeze({
  'tdx-road-events': 'SCHEDULE_TDX_ROAD_EVENTS_MS',
  'cwa-earthquake': 'SCHEDULE_CWA_MS',
  'cwa-weather-warning': 'SCHEDULE_CWA_MS',
  'cwa-typhoon-warning': 'SCHEDULE_CWA_MS',
  'ncdr-hazard-events': 'SCHEDULE_NCDR_MS',
  'taiwan-shelter': 'SCHEDULE_STATIC_MS',
  'taiwan-medical': 'SCHEDULE_STATIC_MS',
  'taiwan-emergency-medical': 'SCHEDULE_STATIC_MS',
  'osm-taiwan': 'SCHEDULE_STATIC_MS',
});

function requiredAbsolutePath(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.normalize(value);
}

function signingPath(env, pathName, pemName) {
  if (env[pathName]) return requiredAbsolutePath(env, pathName);
  if (typeof env[pemName] === 'string' && env[pemName].length > 0) return null;
  throw new TypeError(`${pathName} or ${pemName} must be configured`);
}

function optionalAbsolutePath(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.normalize(value);
}

function positiveInteger(env, name, fallback) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/u.test(raw)) throw new TypeError(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function port(env) {
  const value = positiveInteger(env, 'PORT', 8787);
  if (value > 65535) throw new RangeError('PORT must be between 1 and 65535');
  return value;
}

function scheduleOverride(env, source) {
  const name = SCHEDULE_ENV_BY_SOURCE[source.sourceId];
  return positiveInteger(env, name, source.scheduleMs);
}

function httpUrl(env, name, fallback) {
  const value = env[name] ?? fallback;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    throw new TypeError(`${name} must be an HTTP or HTTPS URL`);
  }
}

function endpointList(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return [];
  return String(raw).split(',').map((value) => value.trim()).filter(Boolean)
    .map((value, index) => {
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
        return parsed.toString();
      } catch {
        throw new TypeError(`${name}[${index}] must be an HTTP or HTTPS URL`);
      }
    });
}

function optionalBlobEndpoint(env) {
  const value = env.AZURE_STORAGE_BLOB_ENDPOINT;
  if (value === undefined || value === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    throw new TypeError('AZURE_STORAGE_BLOB_ENDPOINT must be an HTTPS URL');
  }
}

function azureStorageSettings(env) {
  const container = env.AZURE_CONTROL_CONTAINER ?? 'resilientgeo-control';
  if (!/^[a-z0-9-]{3,63}$/u.test(container)) throw new TypeError('AZURE_CONTROL_CONTAINER is invalid');
  const pointerBlob = env.AZURE_RELEASE_POINTER_BLOB ?? 'current/release-pointer.json';
  const collectorLockBlob = env.AZURE_COLLECTOR_LOCK_BLOB ?? 'locks/collector.lock';
  for (const [name, value] of [
    ['AZURE_RELEASE_POINTER_BLOB', pointerBlob],
    ['AZURE_COLLECTOR_LOCK_BLOB', collectorLockBlob],
  ]) {
    if (typeof value !== 'string' || !value || value.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  return {
    azureStorageBlobEndpoint: optionalBlobEndpoint(env),
    azureControlContainer: container,
    azureReleasePointerBlob: pointerBlob,
    azureCollectorLockBlob: collectorLockBlob,
  };
}

export function loadServerConfig(env = process.env) {
  const privateDataRoot = requiredAbsolutePath(env, 'PRIVATE_DATA_ROOT');
  const publicReleaseRoot = requiredAbsolutePath(env, 'PUBLIC_RELEASE_ROOT');
  if (privateDataRoot === publicReleaseRoot) {
    throw new TypeError('PRIVATE_DATA_ROOT and PUBLIC_RELEASE_ROOT must be different');
  }
  const signingPrivateKeyPath = signingPath(env, 'SIGNING_PRIVATE_KEY_PATH', 'SIGNING_PRIVATE_KEY_PEM');
  const signingPublicKeyPath = signingPath(env, 'SIGNING_PUBLIC_KEY_PATH', 'SIGNING_PUBLIC_KEY_PEM');
  const signingKeyId = env.SIGNING_KEY_ID;
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) {
    throw new TypeError('SIGNING_KEY_ID must be a valid key id');
  }

  const scheduleMsBySource = Object.fromEntries(
    SOURCE_REGISTRY.map((source) => [source.sourceId, scheduleOverride(env, source)]),
  );
  const emergencyMedicalRosterPath = optionalAbsolutePath(env, 'EMERGENCY_MEDICAL_ROSTER_PATH');
  const emergencyMedicalCrosswalkPath = optionalAbsolutePath(env, 'EMERGENCY_MEDICAL_CROSSWALK_PATH');
  const medicalAddressPacksDirectory = optionalAbsolutePath(env, 'MEDICAL_ADDRESS_PACKS_DIR')
    ?? '/app/deploy/public/address-packs';
  if (Boolean(emergencyMedicalRosterPath) !== Boolean(emergencyMedicalCrosswalkPath)) {
    throw new TypeError('EMERGENCY_MEDICAL_ROSTER_PATH and EMERGENCY_MEDICAL_CROSSWALK_PATH must be set together');
  }
  return Object.freeze({
    privateDataRoot,
    publicReleaseRoot,
    areaCatalogPath: requiredAbsolutePath(env, 'AREA_CATALOG_PATH'),
    signingPrivateKeyPath,
    signingPublicKeyPath,
    signingKeyId,
    medicalCoordinateEndpoint: httpUrl(env, 'MEDICAL_COORDINATE_ENDPOINT', DEFAULT_MEDICAL_COORDINATE_ENDPOINT),
    medicalCoordinateFallbackEndpoints: Object.freeze(endpointList(env, 'MEDICAL_COORDINATE_FALLBACK_ENDPOINTS')),
    medicalCoordinateRadiusMeters: positiveInteger(env, 'MEDICAL_COORDINATE_RADIUS_METERS', DEFAULT_MEDICAL_COORDINATE_RADIUS_METERS),
    medicalCoordinateSpacingMeters: positiveInteger(env, 'MEDICAL_COORDINATE_SPACING_METERS', DEFAULT_MEDICAL_COORDINATE_SPACING_METERS),
    medicalCoordinateMaxQueries: positiveInteger(env, 'MEDICAL_COORDINATE_MAX_QUERIES', DEFAULT_MEDICAL_COORDINATE_MAX_QUERIES),
    medicalCoordinateConcurrency: positiveInteger(env, 'MEDICAL_COORDINATE_CONCURRENCY', DEFAULT_MEDICAL_COORDINATE_CONCURRENCY),
    medicalCoordinateTimeoutMs: positiveInteger(env, 'MEDICAL_COORDINATE_TIMEOUT_MS', 120000),
    emergencyMedicalRosterPath,
    emergencyMedicalCrosswalkPath,
    medicalAddressPacksDirectory,
    ...azureStorageSettings(env),
    host: env.HOST || '0.0.0.0',
    port: port(env),
    scheduleMsBySource: Object.freeze(scheduleMsBySource),
  });
}

export function loadApiConfig(env = process.env) {
  const publicReleaseRoot = requiredAbsolutePath(env, 'PUBLIC_RELEASE_ROOT');
  const signingPublicKeyPath = signingPath(env, 'SIGNING_PUBLIC_KEY_PATH', 'SIGNING_PUBLIC_KEY_PEM');
  const signingKeyId = env.SIGNING_KEY_ID;
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) {
    throw new TypeError('SIGNING_KEY_ID must be a valid key id');
  }
  return Object.freeze({
    publicReleaseRoot,
    addressPacksRoot: optionalAbsolutePath(env, 'ADDRESS_PACKS_ROOT'),
    signingPublicKeyPath,
    signingKeyId,
    ...azureStorageSettings(env),
    host: env.HOST || '0.0.0.0',
    port: port(env),
    serverVersion: env.SERVER_VERSION ?? null,
  });
}
