#!/usr/bin/env node

import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { canonicalize } from '../lib/canonical.mjs';
import { verifyCanonical } from '../lib/crypto.mjs';
import { normalizeAddressBuildingKeys } from '../lib/address-packs.mjs';
import { readSignedAddressPackFeatures } from '../lib/address-pack-reader.mjs';
import { createTownCodeResolver, townNameMapFromAreaCatalog } from '../sources/areas.mjs';
import { medicalCoordinateAddressTexts } from '../sources/medical-address-corrections.mjs';
import { TAIWAN_COUNTIES } from '../sources/taiwan-counties.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CODE_FIELDS = [
  '機構代碼', '醫療機構代碼', '院所代碼', '醫事機構代碼',
  'facility_code', 'institution_code', 'medical_id', 'id', 'ID',
];
const NAME_FIELDS = ['機構名稱', '醫療機構名稱', '院所名稱', '醫事機構名稱', '名稱', 'name'];
const ADDRESS_FIELDS = ['地址', '機構地址', '醫事機構地址', 'address'];
const COUNTY_FIELDS = ['縣市', '縣市名稱', '縣市鄉鎮', '縣市區名', '行政區', '行政區域'];
const ADDRESS_DIAGNOSTIC_LABELS = {
  address_source_unavailable: '該縣市門牌來源不可用',
  ambiguous_coordinates: '同一地址對應多個座標',
  candidate_county_unknown: '候選座標缺少縣市資訊',
  county_mismatch: '候選座標縣市不符',
  missing_address: '主檔地址缺漏',
  missing_county: '無法判定主檔縣市',
  no_exact_address_candidate: '可用門牌包找不到同門牌建物地址',
  unique_candidate_still_unresolved: '有唯一地址候選但仍未定位',
};

function firstText(record, fields) {
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sourceRecord(row) {
  return row?.properties?.source_record ?? row?.source_record ?? row ?? {};
}

function institutionCode(row, state) {
  const record = sourceRecord(row);
  const sourceCode = firstText(record, CODE_FIELDS);
  const normalizedCode = state === 'located'
    ? String(row?.feature_id ?? '').match(/^medical:(.+)$/u)?.[1] ?? null
    : state === 'unresolved' ? firstText(row, ['medical_id']) : sourceCode;
  const canonicalCode = (value) => String(value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, '-')
    .slice(0, 240);
  if (!sourceCode || !normalizedCode) {
    throw new TypeError(`medical ${state} record has no source institution code`);
  }
  if (canonicalCode(sourceCode) !== canonicalCode(normalizedCode)) {
    throw new TypeError('institution code does not match its source record');
  }
  return canonicalCode(sourceCode);
}

function countyFor(row) {
  const record = sourceRecord(row);
  const properties = row?.properties ?? {};
  const code = firstText(properties, ['county_code']) ?? firstText(record, ['county_code', '縣市代碼']);
  const byCode = TAIWAN_COUNTIES.find((county) => county.code === code);
  if (byCode) return byCode;

  const text = [
    firstText(properties, ['administrative_area', 'county_name']),
    ...COUNTY_FIELDS.map((field) => firstText(record, [field])),
    firstText(properties, ['address']),
    firstText(record, ADDRESS_FIELDS),
  ].filter(Boolean).join(' ').normalize('NFKC').replaceAll('台', '臺');
  return [...TAIWAN_COUNTIES]
    .sort((left, right) => right.name.length - left.name.length)
    .find((county) => text.includes(county.name)) ?? null;
}

function verifyCatalog(catalog, trustedKeys) {
  if (catalog?.schema_version !== 'address-pack-catalog-v1'
    || catalog.signature_algorithm !== 'Ed25519'
    || !Array.isArray(catalog.counties)
    || catalog.counties.length !== TAIWAN_COUNTIES.length
    || typeof catalog.signature !== 'string') {
    throw new TypeError('signed address-pack catalog is missing required fields');
  }
  const ids = new Set();
  for (const county of catalog.counties) {
    if (!/^\d{5}$/u.test(county?.county_code ?? '')
      || typeof county.county_name !== 'string'
      || !['complete', 'partial', 'unavailable'].includes(county.coverage_status)
      || ids.has(county.county_code)) {
      throw new TypeError('signed address-pack catalog has invalid or duplicate counties');
    }
    ids.add(county.county_code);
  }
  if (ids.size !== TAIWAN_COUNTIES.length
    || TAIWAN_COUNTIES.some((county) => !ids.has(county.code))) {
    throw new TypeError('signed address-pack catalog does not cover all Taiwan counties');
  }
  const encodedKey = trustedKeys?.[catalog.signing_key_id];
  if (typeof encodedKey !== 'string') throw new TypeError('catalog signing key is not trusted');
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(encodedKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new TypeError('trusted catalog public key is invalid');
  }
  const { signature, ...unsigned } = catalog;
  if (!verifyCanonical(unsigned, signature, publicKey)) throw new TypeError('address-pack catalog signature is invalid');
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function addressTextFor(row) {
  const record = sourceRecord(row);
  return firstText(row?.properties, ['address']) ?? firstText(row, ADDRESS_FIELDS) ?? firstText(record, ADDRESS_FIELDS);
}

function indexAddressPackFeatures(features) {
  const byAddress = new Map();
  for (const feature of features) {
    const properties = feature?.properties ?? {};
    const keys = [
      properties.address,
      ...(Array.isArray(properties.aliases) ? properties.aliases : []),
      ...(Array.isArray(properties.matched_address_keys) ? properties.matched_address_keys : []),
    ];
    for (const key of new Set(keys.flatMap(normalizeAddressBuildingKeys).filter(Boolean))) {
      const matches = byAddress.get(key) ?? [];
      matches.push(feature);
      byAddress.set(key, matches);
    }
  }
  return byAddress;
}

function candidateCountyCode(feature) {
  const explicitCode = firstText(feature?.properties, ['county_code']);
  if (explicitCode) return explicitCode;
  return countyFor(feature)?.code ?? null;
}

function candidateCoordinateKey(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2
    || !coordinates.every((value) => Number.isFinite(Number(value)))) return null;
  return coordinates.map((value) => Number(value).toFixed(7)).join(',');
}

function addressDiagnosticCategory(row, candidatesByAddress, catalogByCode) {
  const address = addressTextFor(row);
  const addressKeys = normalizeAddressBuildingKeys(address);
  if (!address || addressKeys.length === 0) return 'missing_address';

  const county = countyFor(row);
  if (!county) return 'missing_county';
  if (catalogByCode.get(county.code)?.coverage_status === 'unavailable') {
    return 'address_source_unavailable';
  }

  const exactCandidates = [...new Set(addressKeys.flatMap((key) => candidatesByAddress.get(key) ?? []))];
  if (exactCandidates.length === 0) return 'no_exact_address_candidate';

  const sameCountyCandidates = exactCandidates.filter((feature) => candidateCountyCode(feature) === county.code);
  if (sameCountyCandidates.length === 0) {
    return exactCandidates.some((feature) => candidateCountyCode(feature) === null)
      ? 'candidate_county_unknown'
      : 'county_mismatch';
  }

  const coordinateKeys = new Set(sameCountyCandidates.map(candidateCoordinateKey).filter(Boolean));
  if (coordinateKeys.size > 1) return 'ambiguous_coordinates';
  return 'unique_candidate_still_unresolved';
}

/** Classify unresolved rows against signed building-doorplate keys and return counts only. */
export function summarizeAddressPackDiagnostics({
  unresolvedRecords = [],
  addressPackFeatures = [],
  catalog,
} = {}) {
  if (!Array.isArray(unresolvedRecords) || !Array.isArray(addressPackFeatures)
    || !Array.isArray(catalog?.counties)) {
    throw new TypeError('address-pack diagnostics require unresolved rows, candidate features, and a catalog');
  }

  const catalogByCode = new Map(catalog.counties.map((county) => [county.county_code, county]));
  const candidatesByAddress = indexAddressPackFeatures(addressPackFeatures);
  const categoryCounts = new Map();
  const counties = new Map();
  for (const row of unresolvedRecords) {
    const county = countyFor(row);
    const category = addressDiagnosticCategory(row, candidatesByAddress, catalogByCode);
    increment(categoryCounts, category);
    const key = county?.code ?? 'unassigned';
    let countyRow = counties.get(key);
    if (!countyRow) {
      countyRow = {
        county_code: county?.code ?? null,
        county_name: county?.name ?? '未分類',
        unresolved_count: 0,
        categories: new Map(),
      };
      counties.set(key, countyRow);
    }
    countyRow.unresolved_count += 1;
    increment(countyRow.categories, category);
  }

  return {
    method: 'exact_building_address_variants_and_county',
    classified_unresolved_count: unresolvedRecords.length,
    category_counts: sortedCounts(categoryCounts),
    counties: [...counties.values()]
      .sort((left, right) => String(left.county_code ?? '99999').localeCompare(String(right.county_code ?? '99999')))
      .map((county) => ({
        county_code: county.county_code,
        county_name: county.county_name,
        unresolved_count: county.unresolved_count,
        category_counts: sortedCounts(county.categories),
      })),
  };
}

/** Summarize one actual normalized collector result without returning facility-level data. */
export function auditMedicalRound({ normalized, catalog, trustedKeys, addressPackFeatures } = {}) {
  if (!normalized || !Array.isArray(normalized.features)
    || !Array.isArray(normalized.unresolved_medical)
    || !Array.isArray(normalized.excluded_medical)) {
    throw new TypeError('medical collector output must include features, unresolved_medical, and excluded_medical');
  }
  const report = normalized.coordinate_report;
  if (!report || !Number.isInteger(report.source_count)
    || !Number.isInteger(report.matched_count)
    || !Number.isInteger(report.unresolved_count)
    || !Number.isInteger(report.rejected_coordinate_count)) {
    throw new TypeError('medical coordinate report is missing required counts');
  }
  verifyCatalog(catalog, trustedKeys);

  const rows = [
    ...normalized.features.map((row) => ({ row, state: 'located' })),
    ...normalized.unresolved_medical.map((row) => ({ row, state: 'unresolved' })),
    ...normalized.excluded_medical.map((row) => ({ row, state: 'excluded' })),
  ];
  if (rows.length !== report.source_count
    || normalized.features.length !== report.matched_count
    || normalized.unresolved_medical.length !== report.unresolved_count) {
    throw new TypeError('medical collector rows do not reconcile with the coordinate report');
  }

  const identities = new Map();
  const locatedFeatureIds = new Map();
  const countyRows = new Map(TAIWAN_COUNTIES.map(({ code, name }) => [code, {
    county_code: code,
    county_name: name,
    master_count: 0,
    located_count: 0,
    unresolved_count: 0,
    excluded_count: 0,
    reasons: new Map(),
  }]));
  const reasonCounts = new Map();
  const coordinateSources = new Map();
  const addressCompleteness = {
    complete_count: 0,
    missing_name_count: 0,
    missing_address_count: 0,
    missing_county_count: 0,
  };
  let unassignedCountyCount = 0;

  for (const { row, state } of rows) {
    const code = institutionCode(row, state);
    identities.set(code, (identities.get(code) ?? 0) + 1);
    if (state === 'located' && typeof row?.feature_id === 'string') {
      locatedFeatureIds.set(row.feature_id, (locatedFeatureIds.get(row.feature_id) ?? 0) + 1);
    }

    const record = sourceRecord(row);
    const properties = row?.properties ?? {};
    const name = firstText(properties, ['name']) ?? firstText(record, NAME_FIELDS);
    const address = firstText(properties, ['address']) ?? firstText(record, ADDRESS_FIELDS);
    const county = countyFor(row);
    const reason = state === 'unresolved'
      ? firstText(row, ['coordinate_failure_reason']) ?? 'unknown'
      : null;
    if (reason) increment(reasonCounts, reason);
    if (!name) addressCompleteness.missing_name_count += 1;
    if (!address) addressCompleteness.missing_address_count += 1;
    if (!county) addressCompleteness.missing_county_count += 1;
    if (name && address && county) addressCompleteness.complete_count += 1;

    if (!county) {
      unassignedCountyCount += 1;
      continue;
    }
    const countyRow = countyRows.get(county.code);
    countyRow.master_count += 1;
    countyRow[`${state}_count`] += 1;
    if (reason) increment(countyRow.reasons, reason);
    if (state === 'located') {
      increment(coordinateSources, firstText(properties, ['coordinate_source']) ?? 'unknown');
    }
  }

  const unresolvedReasonCounts = sortedCounts(reasonCounts);
  const reportedUnresolvedReasonCounts = sortedCounts(
    new Map(Object.entries(report.unresolved_reason_counts ?? {}).filter(([, count]) => count > 0)),
  );
  if (JSON.stringify(unresolvedReasonCounts) !== JSON.stringify(reportedUnresolvedReasonCounts)) {
    throw new TypeError(`unresolved reason counts do not reconcile: ${JSON.stringify({ actual: unresolvedReasonCounts, reported: reportedUnresolvedReasonCounts })}`);
  }

  const catalogByCode = new Map(catalog.counties.map((county) => [county.county_code, county]));
  const counties = [...countyRows.values()].map((row) => ({
    county_code: row.county_code,
    county_name: row.county_name,
    master_count: row.master_count,
    located_count: row.located_count,
    unresolved_count: row.unresolved_count,
    excluded_count: row.excluded_count,
    unresolved_reason_counts: sortedCounts(row.reasons),
    address_source_status: catalogByCode.get(row.county_code).coverage_status,
  }));
  const unavailableAddressCounties = catalog.counties
    .filter((county) => county.coverage_status === 'unavailable')
    .map((county) => county.county_code)
    .sort();
  const duplicateCodeGroups = [...identities.values()].filter((count) => count > 1).length;
  const duplicateExtraRows = [...identities.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const duplicateFeatureGroups = [...locatedFeatureIds.values()].filter((count) => count > 1).length;
  const duplicateFeatureExtraRows = [...locatedFeatureIds.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const validationStatus = duplicateCodeGroups > 0
    ? 'blocked_duplicate_institution_codes'
    : duplicateFeatureGroups > 0 ? 'blocked_duplicate_medical_feature_ids'
    : unassignedCountyCount > 0 ? 'blocked_unassigned_county_records' : 'audited';

  return {
    schema_version: 'medical-unresolved-audit-v1',
    validation_status: validationStatus,
    retrieved_at: normalized.retrieved_at ?? null,
    source_version: report.source_version ?? null,
    counts: {
      source_count: report.source_count,
      located_count: normalized.features.length,
      unresolved_count: normalized.unresolved_medical.length,
      excluded_count: normalized.excluded_medical.length,
      rejected_coordinate_count: report.rejected_coordinate_count,
      unique_institution_code_count: identities.size,
      duplicate_institution_code_count: duplicateCodeGroups,
      duplicate_institution_extra_row_count: duplicateExtraRows,
      duplicate_medical_feature_id_count: duplicateFeatureGroups,
      duplicate_medical_feature_extra_row_count: duplicateFeatureExtraRows,
      invalid_institution_code_count: 0,
      unassigned_county_count: unassignedCountyCount,
    },
    match_summary: {
      unique_match_count: normalized.features.length,
      ambiguous_candidate_match_count: unresolvedReasonCounts.multiple_candidates ?? 0,
    },
    unresolved_reason_counts: unresolvedReasonCounts,
    address_match_diagnostics: Array.isArray(addressPackFeatures)
      ? summarizeAddressPackDiagnostics({
        unresolvedRecords: normalized.unresolved_medical,
        addressPackFeatures,
        catalog,
      })
      : null,
    address_completeness: addressCompleteness,
    candidate_count: report.candidate_count ?? null,
    candidate_source_ids: [...new Set(report.source_ids ?? [])].sort(),
    coordinate_sources: sortedCounts(coordinateSources),
    address_catalog: {
      signing_key_id: catalog.signing_key_id,
      created_at: catalog.created_at,
      unavailable_county_codes: unavailableAddressCounties,
    },
    unavailable_address_counties: unavailableAddressCounties,
    counties,
  };
}

export function renderMedicalAuditMarkdown(audit) {
  const lines = [
    '# 醫療院所未定位原因與官方來源覆蓋稽核',
    '',
    `- 本輪擷取時間：${audit.retrieved_at ?? '未提供'}`,
    `- 醫療主檔版本：${audit.source_version ?? '未提供'}`,
    `- 稽核狀態：${audit.validation_status}`,
    `- 門牌 catalog 簽章金鑰：${audit.address_catalog.signing_key_id}`,
    `- 門牌 catalog 建立時間：${audit.address_catalog.created_at}`,
    '',
    '## 數量對帳',
    '',
    '| 主檔列 | 已定位 | 未定位 | 排除 | 唯一機構代碼 | 重複代碼組 | 重複額外列 | 重複點位 ID 組 | 點位 ID 額外列 | 候選座標排除 |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${audit.counts.source_count} | ${audit.counts.located_count} | ${audit.counts.unresolved_count} | ${audit.counts.excluded_count} | ${audit.counts.unique_institution_code_count} | ${audit.counts.duplicate_institution_code_count} | ${audit.counts.duplicate_institution_extra_row_count} | ${audit.counts.duplicate_medical_feature_id_count} | ${audit.counts.duplicate_medical_feature_extra_row_count} | ${audit.counts.rejected_coordinate_count} |`,
    '',
    `未分類縣市列：${audit.counts.unassigned_county_count}；這些列不計入逐縣市分布。`,
    '',
    '候選座標排除數是獨立統計，不計入院所主檔列數。',
    ...(audit.counts.duplicate_institution_code_count > 0
      ? ['', '重複機構代碼使本輪身分對帳未通過；此份文件只保留彙總，不列出代碼或院所內容。']
      : []),
    '',
    '## 未定位原因',
    '',
    '| 原因 | 筆數 |',
    '| --- | ---: |',
    ...Object.entries(audit.unresolved_reason_counts).map(([reason, count]) => `| ${reason} | ${count} |`),
    '',
    '## 簽章門牌包同門牌建物地址細分（僅彙總）',
    '',
    ...(audit.address_match_diagnostics
      ? [
        `分類筆數：${audit.address_match_diagnostics.classified_unresolved_count}`,
        '',
        '| 分類 | 筆數 |',
        '| --- | ---: |',
        ...Object.entries(audit.address_match_diagnostics.category_counts)
          .map(([category, count]) => `| ${ADDRESS_DIAGNOSTIC_LABELS[category] ?? category} | ${count} |`),
        '',
        '| 縣市代碼 | 縣市 | 未定位 | 地址細分 |',
        '| --- | --- | ---: | --- |',
        ...audit.address_match_diagnostics.counties.map((county) =>
          `| ${county.county_code ?? '未分類'} | ${county.county_name} | ${county.unresolved_count} | ${Object.entries(county.category_counts).map(([key, count]) => `${ADDRESS_DIAGNOSTIC_LABELS[key] ?? key}: ${count}`).join('；')} |`),
      ]
      : ['尚未執行。重跑時請提供 `--address-packs deploy/public/address-packs`。']),
    '',
    '此細分按縣市比對建物門牌：正規化路段及門牌的國字、阿拉伯數字與中英數混寫，將門牌之號與連字號後綴歸併到主號，並忽略樓層及單位註記。除逐筆核實的地址修正外，地址欄列出多個門牌或地址時只取第一個；只有同一正規化主門牌有多筆官方座標時才套用 100 公尺界線，超出則保留歧異。缺少第一個門牌候選時維持未定位，不改選後續地址。既有 NLSC 候選明細未保存在快照中，因此不推論其逐筆失敗原因。',
    '',
    '## 門牌來源缺口',
    '',
    audit.unavailable_address_counties.length > 0
      ? `目前 catalog 標示 unavailable 的縣市代碼：${audit.unavailable_address_counties.join('、')}`
      : '目前 catalog 沒有標示 unavailable 的縣市。',
    '',
    '| 縣市代碼 | 縣市 | 主檔 | 已定位 | 未定位 | 排除 | 門牌來源狀態 |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...audit.counties
      .filter((county) => county.master_count > 0 || county.address_source_status === 'unavailable')
      .map((county) => `| ${county.county_code} | ${county.county_name} | ${county.master_count} | ${county.located_count} | ${county.unresolved_count} | ${county.excluded_count} | ${county.address_source_status} |`),
    '',
    '## 座標來源',
    '',
    '| 來源 | 已定位院所數 |',
    '| --- | ---: |',
    ...Object.entries(audit.coordinate_sources).map(([source, count]) => `| ${source} | ${count} |`),
    '',
    `候選來源：${audit.candidate_source_ids.length > 0 ? audit.candidate_source_ids.join('、') : '未提供'}`,
    '',
    '本報告只保留彙總，不輸出院所名稱、地址或機構代碼。',
    '',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const name = argument.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${name.replaceAll('_', '-')}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const required of ['normalized', 'catalog']) {
    if (!options[required]) throw new Error(`missing --${required}`);
  }
  const normalized = JSON.parse(await readFile(options.normalized, 'utf8'));
  const catalog = JSON.parse(await readFile(options.catalog, 'utf8'));
  const trustedKeysPath = options.trusted_keys ?? path.join(ROOT, 'flutter/assets/data/trusted-keys.json');
  const trustedKeys = JSON.parse(await readFile(trustedKeysPath, 'utf8'));
  let addressPackFeatures;
  if (options.address_packs) {
    verifyCatalog(catalog, trustedKeys);
    const addressPackDirectory = path.resolve(options.address_packs);
    const addressPackCatalog = JSON.parse(await readFile(path.join(addressPackDirectory, 'catalog.json'), 'utf8'));
    if (canonicalize(addressPackCatalog) !== canonicalize(catalog)) {
      throw new TypeError('address-pack directory catalog does not match --catalog');
    }
    const encodedKey = trustedKeys[catalog.signing_key_id];
    const publicKey = createPublicKey({
      key: Buffer.from(encodedKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const areaCatalogPath = path.resolve(options.area_catalog ?? path.join(ROOT, 'data/area-catalog.json'));
    const areaCatalog = JSON.parse(await readFile(areaCatalogPath, 'utf8'));
    addressPackFeatures = await readSignedAddressPackFeatures({
      directory: addressPackDirectory,
      publicKey,
      addresses: medicalCoordinateAddressTexts(normalized.unresolved_medical),
      townNamesByCode: townNameMapFromAreaCatalog(areaCatalog),
      townCodeResolver: createTownCodeResolver(areaCatalog),
    });
  }
  const audit = auditMedicalRound({ normalized, catalog, trustedKeys, addressPackFeatures });
  const markdownPath = path.resolve(options.markdown_out ?? path.join(ROOT, 'docs/medical-unresolved-audit.md'));
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, renderMedicalAuditMarkdown(audit), 'utf8');
  process.stdout.write(`${JSON.stringify({ audit, markdown: markdownPath }, null, 2)}\n`);
  if (audit.validation_status !== 'audited') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  });
}
