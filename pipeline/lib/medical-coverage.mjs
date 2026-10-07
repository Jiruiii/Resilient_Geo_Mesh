import { TAIWAN_COUNTIES } from '../sources/taiwan-counties.mjs';

function normalizeText(value) {
  return String(value ?? '').replaceAll('台', '臺').replace(/\s+/gu, '');
}

function countyFor(record, feature, options) {
  const properties = feature?.properties ?? {};
  const resolved = options.areaResolver?.(record?.source_record ?? record, feature?.geometry);
  const code = String(properties.county_code ?? resolved?.county_code ?? '');
  let county = TAIWAN_COUNTIES.find((entry) => entry.code === code);
  if (county) return county;

  const sourceRecord = record?.source_record ?? record ?? {};
  const text = normalizeText([
    properties.administrative_area,
    properties.county_name,
    sourceRecord.縣市,
    sourceRecord.縣市名稱,
    sourceRecord.縣市鄉鎮,
    sourceRecord.縣市及鄉鎮市區,
    sourceRecord.行政區,
    sourceRecord.地址,
    sourceRecord.機構地址,
    sourceRecord.address,
  ].filter(Boolean).join(' '));
  return [...TAIWAN_COUNTIES].sort((left, right) => right.name.length - left.name.length)
    .find((entry) => text.includes(normalizeText(entry.name))) ?? null;
}

/** Aggregate the source master against a stable 22-county denominator. */
export function buildMedicalCountyCoverage({ features = [], unresolved = [], excluded = [], options = {} } = {}) {
  const counts = new Map(TAIWAN_COUNTIES.map(({ code, name }) => [code, {
    county_code: code,
    county_name: name,
    master_count: 0,
    located_count: 0,
    unlocated_count: 0,
    excluded_count: 0,
  }]));
  let unassigned = 0;

  function increment(record, feature, field) {
    const county = countyFor(record, feature, options);
    if (!county) {
      unassigned += 1;
      return;
    }
    const row = counts.get(county.code);
    row.master_count += 1;
    row[field] += 1;
  }

  for (const feature of features) increment(feature?.properties ?? feature, feature, 'located_count');
  for (const row of unresolved) increment(row, null, 'unlocated_count');
  for (const row of excluded) increment(row, null, 'excluded_count');

  const counties = [...counts.values()].map((row) => ({
    ...row,
    status: row.master_count === row.located_count + row.unlocated_count + row.excluded_count
      && row.unlocated_count === 0 ? 'complete' : 'partial',
  }));
  return {
    status: counties.every((row) => row.status === 'complete') && unassigned === 0 ? 'complete' : 'partial',
    county_count: counties.length,
    source_count: counties.reduce((total, row) => total + row.master_count, 0) + unassigned,
    located_count: counties.reduce((total, row) => total + row.located_count, 0),
    unlocated_count: counties.reduce((total, row) => total + row.unlocated_count, 0),
    excluded_count: counties.reduce((total, row) => total + row.excluded_count, 0),
    unassigned_count: unassigned,
    counties,
  };
}
