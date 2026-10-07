import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { signCanonical } from '../lib/crypto.mjs';
import { TAIWAN_COUNTIES } from '../sources/taiwan-counties.mjs';
import {
  auditMedicalRound,
  renderMedicalAuditMarkdown,
  summarizeAddressPackDiagnostics,
} from '../tools/audit-unresolved-medical.mjs';

const keyPair = generateKeyPairSync('ed25519');
const trustedKeys = {
  'audit-test-key': keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
};

function signedCatalog(coverageOverrides = {}) {
  const unsigned = {
    schema_version: 'address-pack-catalog-v1',
    created_at: '2026-10-05T00:00:00.000Z',
    attribution: 'test-only signed catalog',
    signature_algorithm: 'Ed25519',
    signing_key_id: 'audit-test-key',
    counties: TAIWAN_COUNTIES.map(({ code, name }) => ({
      county_code: code,
      county_name: name,
      coverage_status: coverageOverrides[code] ?? (code === '63000' ? 'partial' : 'unavailable'),
      ...((coverageOverrides[code] ?? (code === '63000' ? 'partial' : 'unavailable')) !== 'unavailable' ? {
        source_name: 'official address source',
        source_version: 'test-version',
        source_url: 'https://example.gov.tw/source',
        license_url: 'https://example.gov.tw/license',
        coordinate_system: 'EPSG:4326',
        manifest_url: '/address-packs/manifest-63000-test.json',
        manifest_sha256: `sha256:${'a'.repeat(64)}`,
      } : {}),
    })),
  };
  return { ...unsigned, signature: signCanonical(unsigned, keyPair.privateKey) };
}

function medicalRecord(code, county, address, name = `院所 ${code}`) {
  return {
    機構代碼: code,
    機構名稱: name,
    縣市: county,
    行政區: `${county}行政區`,
    地址: address,
  };
}

function normalizedRound() {
  const locatedRecord = medicalRecord('0000000001', '臺北市', '臺北市大安區和平東路一段1號');
  return {
    features: [{
      feature_id: 'medical:0000000001',
      properties: {
        name: locatedRecord.機構名稱,
        address: locatedRecord.地址,
        county_code: '63000',
        coordinate_source: 'nlsc-medical-coordinates',
        source_record: locatedRecord,
      },
    }],
    unresolved_medical: [
      {
        medical_id: '0000000002',
        name: '院所 0000000002',
        address: null,
        coordinate_failure_reason: 'no_coordinate_candidate',
        source_record: medicalRecord('0000000002', '新北市', null),
      },
      {
        medical_id: '0000000003',
        name: '院所 0000000003',
        address: '新北市板橋區中山路一段1號',
        coordinate_failure_reason: 'multiple_candidates',
        source_record: medicalRecord('0000000003', '新北市', '新北市板橋區中山路一段1號'),
      },
    ],
    excluded_medical: [medicalRecord('0000000004', '嘉義市', '嘉義市西區中山路1號', '')],
    coordinate_report: {
      source_count: 4,
      candidate_count: 19,
      matched_count: 1,
      unresolved_count: 2,
      rejected_coordinate_count: 7,
      source_ids: ['nlsc-medical-coordinates', 'official-doorplate:65000'],
      unresolved_reason_counts: { no_coordinate_candidate: 1, multiple_candidates: 1 },
    },
  };
}

test('audits current medical identity, reason, county, address, candidate, and catalog counts', () => {
  const report = auditMedicalRound({
    normalized: normalizedRound(),
    catalog: signedCatalog(),
    trustedKeys,
  });

  assert.equal(report.validation_status, 'audited');
  assert.deepEqual(report.counts, {
    source_count: 4,
    located_count: 1,
    unresolved_count: 2,
    excluded_count: 1,
    rejected_coordinate_count: 7,
    unique_institution_code_count: 4,
    duplicate_institution_code_count: 0,
    duplicate_institution_extra_row_count: 0,
    duplicate_medical_feature_id_count: 0,
    duplicate_medical_feature_extra_row_count: 0,
    invalid_institution_code_count: 0,
    unassigned_county_count: 0,
  });
  assert.deepEqual(report.unresolved_reason_counts, {
    multiple_candidates: 1,
    no_coordinate_candidate: 1,
  });
  assert.deepEqual(report.address_completeness, {
    complete_count: 2,
    missing_name_count: 1,
    missing_address_count: 1,
    missing_county_count: 0,
  });
  assert.deepEqual(report.coordinate_sources, { 'nlsc-medical-coordinates': 1 });
  assert.deepEqual(report.candidate_source_ids, [
    'nlsc-medical-coordinates',
    'official-doorplate:65000',
  ]);
  assert.equal(report.unavailable_address_counties.length, 21);
  assert.deepEqual(report.unavailable_address_counties.slice(0, 3), ['09007', '09020', '10002']);
  assert.deepEqual(report.counties.find((row) => row.county_code === '65000'), {
    county_code: '65000',
    county_name: '新北市',
    master_count: 2,
    located_count: 0,
    unresolved_count: 2,
    excluded_count: 0,
    unresolved_reason_counts: { multiple_candidates: 1, no_coordinate_candidate: 1 },
    address_source_status: 'unavailable',
  });
  assert.doesNotMatch(JSON.stringify(report), /0000000001|院所 0000000002/u);
  const markdown = renderMedicalAuditMarkdown(report);
  assert.doesNotMatch(markdown, /0000000001|院所 0000000002/u);
  assert.match(markdown, /國字、阿拉伯數字與中英數混寫/u);
  assert.match(markdown, /多個門牌或地址時只取第一個/u);
  assert.match(markdown, /只有同一正規化主門牌.*100 公尺界線/u);
});

test('marks duplicate institution codes as blocked without losing the aggregate diagnosis', () => {
  const normalized = normalizedRound();
  normalized.unresolved_medical[0].medical_id = '0000000001';
  normalized.unresolved_medical[0].source_record.機構代碼 = '0000000001';

  const report = auditMedicalRound({
    normalized,
    catalog: signedCatalog(),
    trustedKeys,
  });
  assert.equal(report.validation_status, 'blocked_duplicate_institution_codes');
  assert.equal(report.counts.duplicate_institution_code_count, 1);
  assert.equal(report.counts.duplicate_institution_extra_row_count, 1);
});

test('reports source rows whose county cannot be assigned from explicit administrative data', () => {
  const normalized = normalizedRound();
  const unresolved = normalized.unresolved_medical[0];
  unresolved.source_record.縣市 = null;
  unresolved.source_record.行政區 = '苓雅區';
  unresolved.source_record.地址 = '苓雅區中山一路1號';

  const report = auditMedicalRound({
    normalized,
    catalog: signedCatalog(),
    trustedKeys,
  });

  assert.equal(report.validation_status, 'blocked_unassigned_county_records');
  assert.equal(report.counts.unassigned_county_count, 1);
  assert.match(renderMedicalAuditMarkdown(report), /未分類縣市列：1/u);
});

test('reports duplicate located feature IDs alongside duplicate institution codes', () => {
  const normalized = normalizedRound();
  const second = structuredClone(normalized.features[0]);
  second.feature_id = normalized.features[0].feature_id;
  normalized.features.push(second);
  normalized.coordinate_report.source_count = 5;
  normalized.coordinate_report.matched_count = 2;

  const report = auditMedicalRound({
    normalized,
    catalog: signedCatalog(),
    trustedKeys,
  });

  assert.equal(report.validation_status, 'blocked_duplicate_institution_codes');
  assert.equal(report.counts.duplicate_institution_code_count, 1);
  assert.equal(report.counts.duplicate_institution_extra_row_count, 1);
  assert.equal(report.counts.duplicate_medical_feature_id_count, 1);
  assert.equal(report.counts.duplicate_medical_feature_extra_row_count, 1);
});

test('classifies unresolved records against signed address-pack candidates using counts only', () => {
  const records = [
    { medical_id: 'secret-code-missing-address', source_record: medicalRecord('secret-code-missing-address', '新北市', null, 'secret-name') },
    { medical_id: 'secret-code-missing-county', source_record: medicalRecord('secret-code-missing-county', null, '沒有縣市的地址', 'secret-name') },
    { medical_id: 'secret-code-no-match', source_record: medicalRecord('secret-code-no-match', '新北市', '新北市板橋區沒有門牌的路1號', 'secret-name') },
    { medical_id: 'secret-code-county-mismatch', source_record: medicalRecord('secret-code-county-mismatch', '新北市', '新北市板橋區跨縣市候選路1號', 'secret-name') },
    { medical_id: 'secret-code-ambiguous', source_record: medicalRecord('secret-code-ambiguous', '新北市', '新北市板橋區歧異路1號', 'secret-name') },
    { medical_id: 'secret-code-unique', source_record: medicalRecord('secret-code-unique', '新北市', '新北市板橋區唯一候選路1號', 'secret-name') },
    { medical_id: 'secret-code-floor-variant', source_record: medicalRecord('secret-code-floor-variant', '新北市', '新北市板橋區唯一候選路2號1樓', 'secret-name') },
    { medical_id: 'secret-code-unavailable', source_record: medicalRecord('secret-code-unavailable', '連江縣', '連江縣南竿鄉無來源路1號', 'secret-name') },
  ];
  const candidate = (address, countyCode, coordinates) => ({
    geometry: { type: 'Point', coordinates },
    properties: {
      address,
      matched_address_keys: [address],
      county_code: countyCode,
    },
  });
  const catalog = signedCatalog({ 65000: 'partial' });
  const diagnostics = summarizeAddressPackDiagnostics({
    unresolvedRecords: records,
    addressPackFeatures: [
      candidate('新北市板橋區跨縣市候選路1號', '63000', [121.5, 25.0]),
      candidate('新北市板橋區歧異路1號', '65000', [121.4, 25.0]),
      candidate('新北市板橋區歧異路1號', '65000', [121.4001, 25.0]),
      candidate('新北市板橋區唯一候選路1號', '65000', [121.45, 25.0]),
      candidate('新北市板橋區唯一候選路2號', '65000', [121.46, 25.0]),
    ],
    catalog,
  });

  assert.equal(diagnostics.method, 'exact_building_address_variants_and_county');
  assert.deepEqual(diagnostics.category_counts, {
    address_source_unavailable: 1,
    ambiguous_coordinates: 1,
    county_mismatch: 1,
    missing_address: 1,
    missing_county: 1,
    no_exact_address_candidate: 1,
    unique_candidate_still_unresolved: 2,
  });
  assert.equal(diagnostics.classified_unresolved_count, 8);
  assert.deepEqual(diagnostics.counties.find((row) => row.county_code === '65000'), {
    county_code: '65000',
    county_name: '新北市',
    unresolved_count: 6,
    category_counts: {
      ambiguous_coordinates: 1,
      county_mismatch: 1,
      missing_address: 1,
      no_exact_address_candidate: 1,
      unique_candidate_still_unresolved: 2,
    },
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-code|secret-name|唯一候選路|歧異路/u);
});

test('accepts an official non-numeric institution code as a stable identity', () => {
  const record = medicalRecord('AB12345678', '臺北市', '臺北市中正區忠孝西路一段1號');
  const report = auditMedicalRound({
    normalized: {
      features: [],
      unresolved_medical: [{
        medical_id: 'ab12345678',
        name: record.機構名稱,
        address: record.地址,
        coordinate_failure_reason: 'no_coordinate_candidate',
        source_record: record,
      }],
      excluded_medical: [],
      coordinate_report: {
        source_count: 1,
        matched_count: 0,
        unresolved_count: 1,
        rejected_coordinate_count: 0,
        source_ids: [],
        unresolved_reason_counts: { no_coordinate_candidate: 1 },
      },
    },
    catalog: signedCatalog(),
    trustedKeys,
  });

  assert.equal(report.counts.unique_institution_code_count, 1);
  assert.equal(report.counts.invalid_institution_code_count, 0);
});

test('CLI writes a redacted blocked audit and exits nonzero for duplicate institution codes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'medical-audit-'));
  const normalized = normalizedRound();
  normalized.unresolved_medical[0].medical_id = '0000000001';
  normalized.unresolved_medical[0].source_record.機構代碼 = '0000000001';
  normalized.unresolved_medical[0].name = 'SECRET_FACILITY_NAME';
  normalized.unresolved_medical[0].address = 'SECRET_FULL_ADDRESS_123';
  normalized.unresolved_medical[0].source_record.機構名稱 = 'SECRET_FACILITY_NAME';
  normalized.unresolved_medical[0].source_record.地址 = 'SECRET_FULL_ADDRESS_123';
  const normalizedPath = path.join(directory, 'normalized.json');
  const catalogPath = path.join(directory, 'catalog.json');
  const trustedKeysPath = path.join(directory, 'trusted-keys.json');
  const markdownPath = path.join(directory, 'audit.md');
  const scriptPath = new URL('../tools/audit-unresolved-medical.mjs', import.meta.url).pathname;
  await writeFile(normalizedPath, JSON.stringify(normalized));
  await writeFile(catalogPath, JSON.stringify(signedCatalog()));
  await writeFile(trustedKeysPath, JSON.stringify(trustedKeys));

  try {
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--normalized', normalizedPath,
      '--catalog', catalogPath,
      '--trusted-keys', trustedKeysPath,
      '--markdown-out', markdownPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /blocked_duplicate_institution_codes/u);
    assert.doesNotMatch(result.stdout, /0000000001|SECRET_FACILITY_NAME|SECRET_FULL_ADDRESS_123|院所 0000000002/u);
    const markdown = await readFile(markdownPath, 'utf8');
    assert.match(markdown, /重複機構代碼/u);
    assert.doesNotMatch(markdown, /0000000001|SECRET_FACILITY_NAME|SECRET_FULL_ADDRESS_123|院所 0000000002/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects missing audit inputs and a catalog without a trusted signature', () => {
  assert.throws(() => auditMedicalRound({
    normalized: { features: [], unresolved_medical: [], excluded_medical: [] },
    catalog: signedCatalog(),
    trustedKeys,
  }), /coordinate report/u);

  const catalog = signedCatalog();
  catalog.signature = 'invalid';
  assert.throws(() => auditMedicalRound({
    normalized: normalizedRound(),
    catalog,
    trustedKeys,
  }), /catalog signature/u);
});
