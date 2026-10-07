import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

import { canonicalize } from './canonical.mjs';
import { verifyCanonical } from './crypto.mjs';
import {
  canonicalTownCode,
  normalizeAddressBuildingKeys,
  normalizeAddressDoorplateIdentity,
} from './address-packs.mjs';

const COUNTY_CODE = /^\d{5}$/u;
const DATA_FILE = /^address-\d{5}-[a-f0-9]{16}\.ndjson\.gz$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TAIWAN_BOUNDS = { minLongitude: 118, maxLongitude: 122.2, minLatitude: 21.8, maxLatitude: 26.5 };

async function readAddressPackRecords(filePath, { onHeader, onRecord } = {}) {
  const stream = createReadStream(filePath).pipe(createGunzip());
  let header = null;
  let count = 0;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (header === null) {
      header = record;
      if (header.schema_version !== 'address-pack-ndjson-v1' || !/^\d{5}$/u.test(header.county_code ?? '')) {
        throw new TypeError('address-pack header is invalid');
      }
      onHeader?.(header);
      continue;
    }
    count += 1;
    onRecord?.(record, header);
  }
  if (!header) throw new TypeError('address-pack has no NDJSON header');
  return count;
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function signedDocumentValid(document, publicKey) {
  if (!document || typeof document !== 'object' || typeof document.signature !== 'string'
    || typeof document.signing_key_id !== 'string') return false;
  const { signature, ...unsigned } = document;
  return verifyCanonical(unsigned, signature, publicKey);
}

function countyFeaturesForText(counties, addressTexts) {
  return counties.filter((county) => addressTexts.some((text) =>
    typeof text === 'string' && text.includes(county.county_name)));
}

function requestedDoorplatesByBuildingKey(addresses) {
  const identitiesByKey = new Map();
  for (const address of addresses) {
    if (typeof address !== 'string') continue;
    const identity = normalizeAddressDoorplateIdentity(address);
    if (!identity) continue;
    for (const key of normalizeAddressBuildingKeys(address)) {
      const identities = identitiesByKey.get(key) ?? new Set();
      identities.add(identity);
      identitiesByKey.set(key, identities);
    }
  }
  return identitiesByKey;
}

function recordAddressTexts(record, countyName, townNamesByCode, townCodeResolver) {
  const sourceTexts = [
    record.address ?? record.name,
    ...(Array.isArray(record.aliases) ? record.aliases : []),
  ].filter((value) => typeof value === 'string' && value.trim());
  const townCode = canonicalTownCode(record.town_code, townNamesByCode)
    ?? townCodeResolver?.(record.town_code, record.coordinate, record.county_code);
  const townName = townCode ? townNamesByCode[townCode] : null;
  if (!townName) return sourceTexts;

  const countyPrefixes = [countyName, countyName.replaceAll('臺', '台')]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const withRestoredTown = sourceTexts.map((sourceText) => {
    const countyPrefix = countyPrefixes.find((prefix) => sourceText.startsWith(prefix));
    if (!countyPrefix) return `${countyName}${townName}${sourceText}`;
    const afterCounty = sourceText.slice(countyPrefix.length);
    if (afterCounty.startsWith(townName)) return sourceText;
    return `${countyName}${townName}${afterCounty}`;
  });
  return [...new Set([...sourceTexts, ...withRestoredTown])];
}

/** Read only signed doorplate records that exactly match a medical address. */
export async function readSignedAddressPackFeatures({
  directory,
  publicKey,
  addresses = [],
  townNamesByCode = {},
  townCodeResolver,
} = {}) {
  if (!directory || addresses.length === 0) return [];
  const wantedAddresses = new Set(addresses.flatMap(normalizeAddressBuildingKeys).filter(Boolean));
  if (wantedAddresses.size === 0) return [];
  const wantedDoorplates = requestedDoorplatesByBuildingKey(addresses);
  const candidatesByWantedAddress = new Map([...wantedAddresses].map((address) => [address, {
    exact: new Map(),
    fallback: new Map(),
  }]));
  const catalogPath = path.join(directory, 'catalog.json');
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!publicKey) throw new TypeError('address-pack public key is required when a signed catalog is present');
  if (catalog.schema_version !== 'address-pack-catalog-v1' || catalog.signature_algorithm !== 'Ed25519'
    || !Array.isArray(catalog.counties) || catalog.counties.length !== 22
    || !signedDocumentValid(catalog, publicKey)) {
    throw new TypeError('signed address-pack catalog failed verification');
  }

  const sourceTexts = addresses.filter((value) => typeof value === 'string');
  const namedCountyEntries = countyFeaturesForText(catalog.counties, sourceTexts);
  const selectedCounties = namedCountyEntries.length > 0
    ? namedCountyEntries
    : catalog.counties.filter((county) => county.coverage_status !== 'unavailable');
  const output = [];
  for (const county of selectedCounties) {
    if (!COUNTY_CODE.test(county.county_code ?? '') || county.coverage_status === 'unavailable') continue;
    const manifestName = path.basename(county.manifest_url ?? '');
    if (!/^manifest-\d{5}-[a-f0-9]{16}\.json$/u.test(manifestName)
      || !SHA256.test(county.manifest_sha256 ?? '')) {
      throw new TypeError(`address-pack manifest reference is invalid for ${county.county_code}`);
    }
    const manifest = JSON.parse(await readFile(path.join(directory, manifestName), 'utf8'));
    if (digest(Buffer.from(canonicalize(manifest), 'utf8')) !== county.manifest_sha256
      || !signedDocumentValid(manifest, publicKey)
      || manifest.schema_version !== 'address-pack-manifest-v1'
      || manifest.county_code !== county.county_code
      || manifest.coverage_status !== county.coverage_status
      || manifest.data_format !== 'application/x-ndjson'
      || !DATA_FILE.test(manifest.data_file ?? '')
      || !SHA256.test(manifest.sha256 ?? '')) {
      throw new TypeError(`signed address-pack manifest failed verification for ${county.county_code}`);
    }
    const dataPath = path.join(directory, manifest.data_file);
    const compressed = await readFile(dataPath);
    if (compressed.byteLength !== manifest.size_bytes || digest(compressed) !== manifest.sha256) {
      throw new TypeError(`address-pack data integrity check failed for ${county.county_code}`);
    }
    const recordCount = await readAddressPackRecords(dataPath, {
      onHeader(header) {
        if (header.county_code !== county.county_code || header.summary?.located_count !== manifest.located_count) {
          throw new TypeError(`address-pack content does not match its manifest for ${county.county_code}`);
        }
      },
      onRecord(record, header) {
        if (record.county_code !== header.county_code) {
          throw new TypeError(`address-pack record county is inconsistent in ${county.county_code}`);
        }
        const coordinate = record.coordinate;
        if (!Array.isArray(coordinate) || coordinate.length !== 2
          || !coordinate.every(Number.isFinite)
          || coordinate[0] < TAIWAN_BOUNDS.minLongitude || coordinate[0] > TAIWAN_BOUNDS.maxLongitude
          || coordinate[1] < TAIWAN_BOUNDS.minLatitude || coordinate[1] > TAIWAN_BOUNDS.maxLatitude) {
          throw new TypeError(`address-pack record has an invalid WGS84 coordinate in ${county.county_code}`);
        }
        const recordAddressTextsForMatch = recordAddressTexts(
          record,
          county.county_name,
          townNamesByCode,
          townCodeResolver,
        );
        const matchedAddressKeys = [...new Set(recordAddressTextsForMatch
          .flatMap(normalizeAddressBuildingKeys)
          .filter((address) => address && wantedAddresses.has(address)))];
        if (matchedAddressKeys.length === 0) return;
        const exactDoorplates = new Set(recordAddressTextsForMatch
          .map(normalizeAddressDoorplateIdentity)
          .filter(Boolean));
        const coordinateKey = `${Number(coordinate[0])},${Number(coordinate[1])}`;
        for (const address of matchedAddressKeys) {
          const addressCandidates = candidatesByWantedAddress.get(address);
          const requestedDoorplates = wantedDoorplates.get(address) ?? new Set();
          const bucket = [...exactDoorplates].some((identity) => requestedDoorplates.has(identity))
            ? addressCandidates.exact
            : addressCandidates.fallback;
          if (bucket.size >= 2 || bucket.has(coordinateKey)) continue;
          bucket.set(coordinateKey, {
            id: record.id,
            kind: 'address',
            geometry: { type: 'Point', coordinates: coordinate },
            properties: {
              name: record.name,
              address: record.address,
              matched_address_keys: matchedAddressKeys,
              administrative_area: record.region,
              county_code: record.county_code,
              town_code: record.town_code,
              coordinate_source: `official-doorplate:${county.county_code}`,
              coordinate_source_version: header.source_version,
            },
          });
        }
      },
    });
    if (recordCount !== manifest.located_count) {
      throw new TypeError(`address-pack content count does not match its manifest for ${county.county_code}`);
    }
  }
  const selected = new Map();
  for (const candidates of candidatesByWantedAddress.values()) {
    for (const feature of (candidates.exact.size > 0 ? candidates.exact : candidates.fallback).values()) {
      if (!selected.has(feature.id)) selected.set(feature.id, feature);
    }
  }
  output.push(...selected.values());
  return output;
}
