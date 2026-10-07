import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMedicalCountyCoverage } from '../lib/medical-coverage.mjs';

test('medical coverage reports all 22 county rows and keeps unknown locations visible', () => {
  const result = buildMedicalCountyCoverage({
    features: [
      { properties: { county_code: '63000' } },
      { properties: { administrative_area: '花蓮縣花蓮市' } },
    ],
    unresolved: [
      { source_record: { 縣市及鄉鎮市區: '臺北市大安區', 機構名稱: '未定位院所' } },
      { source_record: { 機構名稱: '缺少縣市院所' } },
    ],
    excluded: [{ 縣市: '新北市', 地址: '新北市板橋區測試路' }],
  });

  assert.equal(result.county_count, 22);
  assert.equal(result.status, 'partial');
  assert.equal(result.source_count, 5);
  assert.equal(result.located_count, 2);
  assert.equal(result.unlocated_count, 1);
  assert.equal(result.excluded_count, 1);
  assert.equal(result.unassigned_count, 1);
  assert.deepEqual(result.counties.find((row) => row.county_code === '63000'), {
    county_code: '63000', county_name: '臺北市', master_count: 2,
    located_count: 1, unlocated_count: 1, excluded_count: 0, status: 'partial',
  });
  assert.equal(result.counties.find((row) => row.county_code === '09007').master_count, 0);
});
