#!/usr/bin/env node
import { createHash, createPublicKey } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCountyAddressPack,
  buildSignedAddressPackArtifact,
  buildSignedAddressPackCatalog,
  parseCsv,
  parseJsonRows,
} from '../lib/address-packs.mjs';
import { readPrivateKey } from '../lib/crypto.mjs';
import { getAddressSourceDefinitions, resolveAddressSourceFields } from '../sources/address-pack-sources.mjs';
import {
  createTownCodeResolver,
  normalizeAreaCatalog,
  townNameMapFromAreaCatalog,
} from '../sources/areas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_INPUT_DIR = process.env.ADDRESS_SOURCE_DIR ?? '/private/tmp';
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'deploy/public/address-packs');

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--allow-incomplete') {
      options.allowIncomplete = true;
      continue;
    }
    if (!key.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`invalid address-pack option: ${key}`);
    }
    options[key.slice(2).replaceAll('-', '_')] = args[index + 1];
    index += 1;
  }
  return options;
}

function decodeCsv(bytes, requestedEncoding) {
  if (requestedEncoding !== 'auto') return new TextDecoder(requestedEncoding, { fatal: true }).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('big5', { fatal: true }).decode(bytes);
  }
}

async function atomicWrite(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, filePath);
}

async function readGeoJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export function resolveAddressPackSigningKeyPath({ explicitPath, env = process.env } = {}) {
  return [explicitPath, env.SIGNING_PRIVATE_KEY_PATH, env.PIPELINE_SIGNING_PRIVATE_KEY]
    .find((value) => typeof value === 'string' && value.trim() !== '')?.trim() ?? null;
}

/** Load one official source, including documented multi-file and JSON resources. */
export async function loadAddressSourceRows(inputDir, definition) {
  const files = definition.inputFiles ?? [{
    file: definition.inputFile,
    format: definition.format ?? 'csv',
    encoding: definition.encoding,
  }];
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => !file?.file)) {
    throw new TypeError(`address source ${definition.sourceId} must list one or more input files`);
  }
  const rows = [];
  const missing = [];
  const sourceDigest = createHash('sha256');
  for (const sourceFile of files) {
    const inputPath = path.join(inputDir, sourceFile.file);
    let bytes;
    try {
      bytes = await readFile(inputPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(inputPath);
      continue;
    }
    if (bytes.length < 128 || bytes.subarray(0, 32).toString('utf8').trimStart().startsWith('<')) {
      throw new Error(`${inputPath} does not look like a complete address data download`);
    }
    const format = sourceFile.format ?? path.extname(sourceFile.file).slice(1).toLowerCase() ?? 'csv';
    const encoding = sourceFile.encoding ?? definition.encoding ?? 'utf-8';
    let sourceRows;
    if (format === 'csv') {
      sourceRows = parseCsv(decodeCsv(bytes, encoding));
    } else if (format === 'json') {
      sourceRows = parseJsonRows(new TextDecoder(encoding, { fatal: true }).decode(bytes));
    } else {
      throw new TypeError(`unsupported address source format for ${inputPath}: ${format}`);
    }
    if (sourceRows.length === 0) throw new Error(`${inputPath} has no address records`);
    for (const row of sourceRows) rows.push(row);
    sourceDigest.update(sourceFile.file).update('\u0000').update(bytes);
  }
  return {
    rows: missing.length === 0 ? rows : null,
    missing,
    sourceSha256: files.length === 1 && missing.length === 0
      ? `sha256:${sourceDigest.digest('hex')}`
      : `sha256:${sourceDigest.digest('hex')}`,
  };
}

function indexFeatures(collection, codeKey, nameKey, countyKey) {
  return new Map(collection.features.map((feature) => [
    String(feature.properties[codeKey]),
    {
      name: feature.properties[nameKey],
      countyCode: countyKey ? String(feature.properties[countyKey]) : null,
    },
  ]));
}

export async function buildAddressPackRelease({
  inputDir = DEFAULT_INPUT_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  privateKey,
  signingKeyId,
  createdAt = new Date().toISOString(),
  allowIncomplete = false,
} = {}) {
  if (!privateKey) throw new TypeError('address-pack release requires the current signing private key');
  if (!signingKeyId) throw new TypeError('address-pack release requires SIGNING_KEY_ID');
  const counties = await readGeoJson(path.join(ROOT, 'data/boundaries/geojson/county.geojson'));
  const towns = await readGeoJson(path.join(ROOT, 'data/boundaries/geojson/town.geojson'));
  const countyIndex = indexFeatures(counties, 'COUNTYCODE', 'COUNTYNAME');
  const townCatalog = normalizeAreaCatalog(towns, {
    retrievedAt: createdAt,
    source: 'local-boundary',
    sourceVersion: 'local-boundary',
  });
  const allTownNamesByCode = townNameMapFromAreaCatalog(townCatalog);
  const resolveTownCode = createTownCodeResolver(townCatalog);
  const completedCounties = [];
  const totals = { source_count: 0, located_count: 0, unlocated_count: 0, excluded_count: 0 };
  const countiesForCatalog = [];
  const missing = [];

  for (const definition of getAddressSourceDefinitions()) {
    const countyFeature = counties.features.find((feature) =>
      String(feature.properties.COUNTYCODE) === definition.countyCode);
    if (!countyFeature || countyIndex.get(definition.countyCode)?.name !== definition.countyName) {
      throw new Error(`local county boundary does not contain ${definition.countyCode} ${definition.countyName}`);
    }
    if (!definition.available) {
      countiesForCatalog.push({
        county_code: definition.countyCode,
        county_name: definition.countyName,
        coverage_status: 'unavailable',
      });
      continue;
    }

    const loaded = await loadAddressSourceRows(inputDir, definition);
    if (loaded.missing.length > 0) {
      missing.push(...loaded.missing);
      countiesForCatalog.push({
        county_code: definition.countyCode,
        county_name: definition.countyName,
        coverage_status: 'unavailable',
        source_name: definition.sourceName,
        source_version: definition.sourceVersion,
        source_url: definition.sourceUrl,
        license_url: definition.licenseUrl,
        coordinate_system: definition.coordinateSystem,
      });
      continue;
    }
    const { rows } = loaded;
    if (rows.length < 1) throw new Error(`${definition.sourceName} has no address records`);
    const headers = Object.keys(rows[0]);
    const fields = resolveAddressSourceFields(headers, definition);
    const townNamesByCode = Object.fromEntries(Object.entries(allTownNamesByCode)
      .filter(([code]) => code.startsWith(definition.countyCode)));
    const pack = buildCountyAddressPack(rows, {
      countyCode: definition.countyCode,
      countyName: definition.countyName,
      countyBoundary: countyFeature.geometry,
      coordinateSystem: definition.coordinateSystem,
      fields,
      sourceCountyCodes: definition.sourceCountyCodes ?? [definition.countyCode],
      sourceCountyNames: definition.sourceCountyNames ?? [definition.countyName],
      townNamesByCode,
      townCodeResolver(sourceTownCode, coordinate) {
        return resolveTownCode(sourceTownCode, coordinate, definition.countyCode);
      },
      sourceVersion: definition.sourceVersion,
    });
    if (pack.records.length === 0) {
      throw new Error(`${definition.sourceName} has no in-county located rows after coordinate checks`);
    }

    const artifact = await buildSignedAddressPackArtifact(pack, {
      privateKey,
      signingKeyId,
      sourceUrl: definition.sourceUrl,
      sourceSha256: loaded.sourceSha256,
      licenseUrl: definition.licenseUrl,
      createdAt,
    });
    await atomicWrite(path.join(outputDir, artifact.dataFile), artifact.data);
    await atomicWrite(path.join(outputDir, artifact.manifestFile), `${JSON.stringify(artifact.manifest, null, 2)}\n`);
    const manifestUrl = `/address-packs/${artifact.manifestFile}`;
    countiesForCatalog.push({
      county_code: definition.countyCode,
      county_name: definition.countyName,
      coverage_status: pack.summary.coverage_status,
      source_name: definition.sourceName,
      source_version: definition.sourceVersion,
      source_url: definition.sourceUrl,
      license_url: definition.licenseUrl,
      coordinate_system: pack.coordinate_system,
      source_count: pack.summary.source_count,
      located_count: pack.summary.located_count,
      unlocated_count: pack.summary.unlocated_count,
      excluded_count: pack.summary.excluded_count,
      manifest_url: manifestUrl,
      manifest_sha256: artifact.manifestSha256,
    });
    completedCounties.push(definition.countyCode);
    for (const key of Object.keys(totals)) totals[key] += pack.summary[key];
  }

  if (missing.length && !allowIncomplete) {
    throw new Error(`address source downloads are incomplete:\n${missing.join('\n')}`);
  }
  const catalog = buildSignedAddressPackCatalog(countiesForCatalog, {
    privateKey,
    signingKeyId,
    createdAt,
  });
  await atomicWrite(path.join(outputDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  const coverage = {
    generated_at: createdAt,
    expected_county_count: 22,
    counties: countiesForCatalog,
    totals,
    available_county_count: completedCounties.length,
    unavailable_county_codes: countiesForCatalog
      .filter((county) => county.coverage_status === 'unavailable')
      .map((county) => county.county_code),
  };
  await atomicWrite(path.join(outputDir, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
  const catalogHash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  return { completedCounties, coverage, catalogHash, missing };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const keyPath = resolveAddressPackSigningKeyPath({ explicitPath: options.private_key });
  const signingKeyId = options.signing_key_id ?? process.env.SIGNING_KEY_ID;
  if (!keyPath) throw new Error('set SIGNING_PRIVATE_KEY_PATH or PIPELINE_SIGNING_PRIVATE_KEY, or pass --private-key');
  const privateKey = readPrivateKey(await readFile(keyPath));
  const trustedKeys = JSON.parse(await readFile(path.join(ROOT, 'flutter/assets/data/trusted-keys.json'), 'utf8'));
  const actualPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  if (!signingKeyId || trustedKeys[signingKeyId] !== actualPublicKey) {
    throw new Error('the signing private key does not match the Flutter/Android trusted key for SIGNING_KEY_ID');
  }
  const result = await buildAddressPackRelease({
    inputDir: options.input_dir ?? DEFAULT_INPUT_DIR,
    outputDir: options.output_dir ?? DEFAULT_OUTPUT_DIR,
    privateKey,
    signingKeyId,
    createdAt: options.created_at ?? new Date().toISOString(),
    allowIncomplete: options.allow_incomplete === true,
  });
  process.stdout.write(`${JSON.stringify({
    catalog_sha256: result.catalogHash,
    available_county_count: result.coverage.available_county_count,
    missing_sources: result.missing,
    coverage: result.coverage.totals,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
