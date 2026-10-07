import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadApiConfig, loadServerConfig } from '../src/config.mjs';

const VALID_ENV = {
  PRIVATE_DATA_ROOT: '/var/lib/resilientgeo-private',
  PUBLIC_RELEASE_ROOT: '/var/lib/resilientgeo-public',
  AREA_CATALOG_PATH: '/var/lib/resilientgeo-private/area-catalog.json',
  SIGNING_PRIVATE_KEY_PATH: '/run/secrets/resilientgeo-signing-private-key',
  SIGNING_PUBLIC_KEY_PATH: '/run/secrets/resilientgeo-signing-public-key',
  SIGNING_KEY_ID: 'government-feed-2026',
  PORT: '8787',
};

test('loads separated data roots, signing paths, port, and source schedule overrides', () => {
  const config = loadServerConfig({
    ...VALID_ENV,
    SCHEDULE_TDX_ROAD_EVENTS_MS: '120000',
    SCHEDULE_STATIC_MS: '3600000',
  });

  assert.deepEqual(config, {
    privateDataRoot: '/var/lib/resilientgeo-private',
    publicReleaseRoot: '/var/lib/resilientgeo-public',
    areaCatalogPath: '/var/lib/resilientgeo-private/area-catalog.json',
    signingPrivateKeyPath: '/run/secrets/resilientgeo-signing-private-key',
    signingPublicKeyPath: '/run/secrets/resilientgeo-signing-public-key',
    signingKeyId: 'government-feed-2026',
    medicalCoordinateEndpoint: 'https://api.nlsc.gov.tw/other/MarkBufferAnlys/med',
    medicalCoordinateFallbackEndpoints: [],
    medicalCoordinateRadiusMeters: 25000,
    medicalCoordinateSpacingMeters: 30000,
    medicalCoordinateMaxQueries: 500,
    medicalCoordinateConcurrency: 4,
    medicalCoordinateTimeoutMs: 120000,
    emergencyMedicalRosterPath: null,
    emergencyMedicalCrosswalkPath: null,
    medicalAddressPacksDirectory: '/app/deploy/public/address-packs',
    azureStorageBlobEndpoint: null,
    azureControlContainer: 'resilientgeo-control',
    azureReleasePointerBlob: 'current/release-pointer.json',
    azureCollectorLockBlob: 'locks/collector.lock',
    host: '0.0.0.0',
    port: 8787,
    scheduleMsBySource: {
      'tdx-road-events': 120000,
      'cwa-earthquake': 600000,
      'cwa-weather-warning': 600000,
      'cwa-typhoon-warning': 600000,
      'ncdr-hazard-events': 600000,
      'taiwan-shelter': 3600000,
      'taiwan-medical': 3600000,
      'taiwan-emergency-medical': 3600000,
      'osm-taiwan': 3600000,
    },
  });
  assert.equal(config.emergencyMedicalRosterPath, null);
  assert.equal(config.emergencyMedicalCrosswalkPath, null);
});

test('loads official medical coordinate endpoint and fallback source settings', () => {
  const config = loadServerConfig({
    ...VALID_ENV,
    MEDICAL_COORDINATE_ENDPOINT: 'https://api.nlsc.gov.tw/custom/med',
    MEDICAL_COORDINATE_FALLBACK_ENDPOINTS: 'https://health-a.gov.tw/medical.json,https://health-b.gov.tw/medical.json',
    MEDICAL_COORDINATE_RADIUS_METERS: '10000',
    MEDICAL_COORDINATE_SPACING_METERS: '12000',
    MEDICAL_COORDINATE_MAX_QUERIES: '120',
    MEDICAL_COORDINATE_CONCURRENCY: '2',
    MEDICAL_COORDINATE_TIMEOUT_MS: '60000',
  });

  assert.equal(config.medicalCoordinateEndpoint, 'https://api.nlsc.gov.tw/custom/med');
  assert.deepEqual(config.medicalCoordinateFallbackEndpoints, [
    'https://health-a.gov.tw/medical.json',
    'https://health-b.gov.tw/medical.json',
  ]);
  assert.equal(config.medicalCoordinateRadiusMeters, 10000);
  assert.equal(config.medicalCoordinateSpacingMeters, 12000);
  assert.equal(config.medicalCoordinateMaxQueries, 120);
  assert.equal(config.medicalCoordinateConcurrency, 2);
  assert.equal(config.medicalCoordinateTimeoutMs, 60000);
});

test('rejects missing signing private key path', () => {
  const env = { ...VALID_ENV };
  delete env.SIGNING_PRIVATE_KEY_PATH;
  assert.throws(() => loadServerConfig(env), /SIGNING_PRIVATE_KEY_PATH/u);
});

test('rejects an invalid port', () => {
  assert.throws(() => loadServerConfig({ ...VALID_ENV, PORT: '70000' }), /PORT/u);
});

test('rejects negative schedule overrides', () => {
  assert.throws(
    () => loadServerConfig({ ...VALID_ENV, SCHEDULE_STATIC_MS: '-1' }),
    /SCHEDULE_STATIC_MS/u,
  );
});

test('rejects relative private or public data roots', () => {
  assert.throws(
    () => loadServerConfig({ ...VALID_ENV, PRIVATE_DATA_ROOT: './private' }),
    /PRIVATE_DATA_ROOT/u,
  );
  assert.throws(
    () => loadServerConfig({ ...VALID_ENV, PUBLIC_RELEASE_ROOT: './public' }),
    /PUBLIC_RELEASE_ROOT/u,
  );
});

test('requires reviewed emergency medical roster and crosswalk paths together', () => {
  assert.throws(() => loadServerConfig({
    ...VALID_ENV,
    EMERGENCY_MEDICAL_ROSTER_PATH: '/run/config/emergency-roster.json',
  }), /must be set together/u);
  const config = loadServerConfig({
    ...VALID_ENV,
    EMERGENCY_MEDICAL_ROSTER_PATH: '/run/config/emergency-roster.json',
    EMERGENCY_MEDICAL_CROSSWALK_PATH: '/run/config/emergency-crosswalk.json',
  });
  assert.equal(config.emergencyMedicalRosterPath, '/run/config/emergency-roster.json');
  assert.equal(config.emergencyMedicalCrosswalkPath, '/run/config/emergency-crosswalk.json');
});

test('Azure storage settings require HTTPS and expose only names and endpoints', () => {
  const config = loadServerConfig({
    ...VALID_ENV,
    AZURE_STORAGE_BLOB_ENDPOINT: 'https://resilientgeo.blob.core.windows.net',
    AZURE_CONTROL_CONTAINER: 'resilientgeo-control',
    AZURE_RELEASE_POINTER_BLOB: 'current/release-pointer.json',
    AZURE_COLLECTOR_LOCK_BLOB: 'locks/collector.lock',
  });
  assert.equal(config.azureStorageBlobEndpoint, 'https://resilientgeo.blob.core.windows.net');
  assert.equal(config.azureControlContainer, 'resilientgeo-control');
  assert.throws(() => loadServerConfig({
    ...VALID_ENV,
    AZURE_STORAGE_BLOB_ENDPOINT: 'http://resilientgeo.blob.core.windows.net',
  }), /HTTPS URL/u);
  const api = loadApiConfig({
    PUBLIC_RELEASE_ROOT: '/var/lib/resilientgeo-public',
    SIGNING_PUBLIC_KEY_PEM: 'public-key',
    SIGNING_KEY_ID: 'government-feed-2026',
    AZURE_STORAGE_BLOB_ENDPOINT: 'https://resilientgeo.blob.core.windows.net',
  });
  assert.equal(api.signingPublicKeyPath, null);
  assert.equal(api.azureStorageBlobEndpoint, 'https://resilientgeo.blob.core.windows.net');
});
