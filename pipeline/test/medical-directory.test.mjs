import assert from 'node:assert/strict';
import test from 'node:test';

const medicalDirectory = await import('../lib/medical-directory.mjs').catch(() => ({}));

test('medical directory keeps unlocated records searchable without adding coordinates', () => {
  assert.equal(typeof medicalDirectory.buildMedicalDirectoryFeatures, 'function');
  const entries = medicalDirectory.buildMedicalDirectoryFeatures({
    locatedFeatures: [{
      feature_id: 'medical:h001',
      properties: {
        name: '臺北醫院', address: '臺北市大安區仁愛路一段1號',
        administrative_area: '臺北市大安區', county_code: '63000',
      },
    }],
    unresolved: [{
      medical_id: 'h002', name: '待定位診所', address: '新北市板橋區文化路1號',
      geometry_status: 'unresolved', coordinate_failure_reason: 'no_coordinate_candidate',
      source_record: { 機構代碼: 'H002', 縣市鄉鎮: '新北市板橋區' },
    }],
    excluded: [{ 機構代碼: 'H003', 機構名稱: '界外醫院', 地址: '臺中市西區公益路1號' }],
    sourceVersion: 'master-2026-10',
    sourceUrl: 'https://data.gov.tw/dataset/15393',
    issuedAt: '2026-10-04T00:00:00.000Z',
    expiresAt: '2026-11-03T00:00:00.000Z',
  });

  assert.equal(entries.length, 3);
  const located = entries.find((entry) => entry.feature_id === 'medical-directory:h001');
  assert.equal(located.geometry, null);
  assert.equal(located.properties.geometry_status, 'located');
  assert.equal(located.properties.point_feature_id, 'medical:h001');
  const unresolved = entries.find((entry) => entry.feature_id === 'medical-directory:h002');
  assert.equal(unresolved.geometry, null);
  assert.equal(unresolved.properties.geometry_status, 'unresolved');
  assert.equal(unresolved.properties.point_feature_id, null);
  assert.equal(unresolved.properties.county_code, '65000');
  assert.equal(unresolved.properties.coordinate_failure_reason, 'no_coordinate_candidate');
  const excluded = entries.find((entry) => entry.feature_id === 'medical-directory:h003');
  assert.equal(excluded.properties.geometry_status, 'excluded');
  assert.equal(excluded.properties.point_feature_id, null);
  assert.equal(JSON.stringify(entries).includes('source_record'), false);
});

test('medical directory retains distinct source rows that share an institution code', () => {
  const entries = medicalDirectory.buildMedicalDirectoryFeatures({
    unresolved: [
      { medical_id: 'h001', name: '同代碼診所', address: '臺北市內湖區成功路1號', source_record: { 機構代碼: 'H001' } },
      { medical_id: 'h001', name: '同代碼診所', address: '臺北市內湖區成功路2號', source_record: { 機構代碼: 'H001' } },
    ],
    sourceVersion: 'master-2026-10',
    issuedAt: '2026-10-04T00:00:00.000Z',
    expiresAt: '2026-11-03T00:00:00.000Z',
  });

  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((entry) => entry.feature_id)).size, 2);
  assert.ok(entries.every((entry) => entry.properties.geometry_status === 'unresolved'));
  assert.ok(entries.every((entry) => entry.geometry === null));
});
