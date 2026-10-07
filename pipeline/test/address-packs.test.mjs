import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  buildSignedAddressPackCatalog,
  buildSignedAddressPackArtifact,
  inferAddressCoordinateSystem,
  buildCountyAddressPack,
  normalizeAddressBuildingKeys,
  normalizeAddressText,
  parseCsv,
  parseJsonRows,
  projectTwd97Tm2ToWgs84,
} from '../lib/address-packs.mjs';
import {
  getAddressSourceDefinitions,
  resolveAddressSourceFields,
} from '../sources/address-pack-sources.mjs';
import { generateEd25519KeyPair, verifyCanonical } from '../lib/crypto.mjs';
import { readSignedAddressPackFeatures } from '../lib/address-pack-reader.mjs';
import {
  loadAddressSourceRows,
  resolveAddressPackSigningKeyPath,
} from '../tools/build-address-packs.mjs';

test('parseCsv removes a UTF-8 BOM and preserves quoted commas and line breaks', () => {
  const parsed = parseCsv('\uFEFFname,address\r\n"Clinic, North","Line 1\r\nLine 2"\r\n');

  assert.deepEqual(parsed, [
    { name: 'Clinic, North', address: 'Line 1\r\nLine 2' },
  ]);
});

test('parseJsonRows accepts official dataset record arrays and rejects malformed row shapes', () => {
  assert.deepEqual(parseJsonRows('[{"縣市代碼":"10009","號":"1"}]'), [
    { 縣市代碼: '10009', 號: '1' },
  ]);
  assert.throws(() => parseJsonRows('{"metadata":true}'), /records must be an array/u);
});

test('normalizeAddressText folds full-width digits and removes spacing noise', () => {
  assert.equal(
    normalizeAddressText('臺北市  松山區 三民路 ９５巷 １弄３號'),
    '臺北市松山區三民路95巷1弄3號',
  );
});

test('normalizeAddressBuildingKeys normalizes sections, strips trailing details, and selects the first listed doorplate', () => {
  const buildingAddress = '臺北市松山區長春路446號';
  const buildingKey = normalizeAddressText(buildingAddress);

  assert.deepEqual(normalizeAddressBuildingKeys('臺北市松山區長春路４４６號（１樓）'), [buildingKey]);
  assert.deepEqual(normalizeAddressBuildingKeys('臺北市松山區長春路446號(地下1樓)'), [buildingKey]);
  assert.deepEqual(normalizeAddressBuildingKeys('臺北市松山區長春路446號1樓'), [buildingKey]);
  assert.deepEqual(normalizeAddressBuildingKeys('臺北市松山區長春路446號（後棟）'), [
    normalizeAddressText('臺北市松山區長春路446號（後棟）'),
  ]);
  assert.deepEqual(normalizeAddressBuildingKeys('臺北市松山區長春路447號（1樓）'), [
    normalizeAddressText('臺北市松山區長春路447號'),
  ]);
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區南京東路三段269巷6號'),
    normalizeAddressBuildingKeys('臺北市松山區南京東路3段269巷6號'),
  );
  assert.deepEqual(normalizeAddressBuildingKeys('臺北市松山區南京東路5段166、168號11樓'), [
    normalizeAddressText('臺北市松山區南京東路5段166號'),
  ]);
});

test('normalizeAddressBuildingKeys keeps the building doorplate across floor lists and repeated door alternatives', () => {
  const base = (address) => normalizeAddressText(address);

  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區南京東路3段256巷46號1、2樓'),
    [base('臺北市松山區南京東路3段256巷46號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區民生東路3段101號2樓、2樓之1及2樓之2'),
    [base('臺北市松山區民生東路3段101號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區民生東路3段101號1 2樓'),
    [base('臺北市松山區民生東路3段101號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區八德路3段164號1樓、164之1號(1樓)'),
    [base('臺北市松山區八德路3段164號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區敦化南路一段69號2樓、67號2樓'),
    [base('臺北市松山區敦化南路1段69號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區八德路三段２２５號２樓－４'),
    [base('臺北市松山區八德路3段225號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區延吉街9之4號'),
    [base('臺北市松山區延吉街9號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區南京東路四段66號2樓、寧安街68巷25號2樓'),
    [base('臺北市松山區南京東路4段66號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區八德路二段３８６號2樓-3'),
    [base('臺北市松山區八德路2段386號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區三民路113巷1-1號'),
    [base('臺北市松山區三民路113巷1號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區新東街11巷15--1號１樓'),
    [base('臺北市松山區新東街11巷15號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區八德路四段636號(實際營業地址:1、2層)'),
    [base('臺北市松山區八德路4段636號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區民生東路五段二六八號一樓'),
    [base('臺北市松山區民生東路5段268號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區新東街28號之2'),
    [base('臺北市松山區新東街28號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市大安區仁愛路4段122巷26號(含地下1樓)'),
    [base('臺北市大安區仁愛路4段122巷26號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市大安區光復南路五七0號三樓'),
    [base('臺北市大安區光復南路570號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市大安區忠孝東路四段一二 0號D棟九樓'),
    [base('臺北市大安區忠孝東路4段120號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區敦化南路一段二OO號三樓'),
    [base('臺北市松山區敦化南路1段200號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區復興北路333號4樓之3、之4'),
    [base('臺北市松山區復興北路333號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市松山區南京東路五段100號、102號6樓之1'),
    [base('臺北市松山區南京東路5段100號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市大安區忠孝東路四段六十號五樓'),
    [base('臺北市大安區忠孝東路4段60號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市大安區光復南路116巷1、3、5號1至4樓及地下1樓'),
    [base('臺北市大安區光復南路116巷1號')],
  );
  assert.deepEqual(
    normalizeAddressBuildingKeys('臺北市大安區延吉街二四一巷二弄5號1樓'),
    [base('臺北市大安區延吉街241巷2弄5號')],
  );
});

test('normalizeAddressBuildingKeys strips post-doorplate subnumbers and mixed floor annotations', () => {
  const base = (address) => normalizeAddressText(address);
  const cases = [
    [
      '臺北市大安區金華街１１８號－６三樓',
      '臺北市大安區金華街118號',
    ],
    [
      '臺北市大安區金山南路2段192巷8號1樓及夾層、2樓、3樓',
      '臺北市大安區金山南路2段192巷8號',
    ],
    [
      '臺北市大安區信義路三段一六二號之五一樓',
      '臺北市大安區信義路3段162號',
    ],
    [
      '臺北市大安區仁愛路3段29號地下室',
      '臺北市大安區仁愛路3段29號',
    ],
    [
      '臺北市大安區新生南路1段111號1樓(不含夾層)',
      '臺北市大安區新生南路1段111號',
    ],
    [
      '臺北市松山區八德路三段２２５號２樓－４',
      '臺北市松山區八德路3段225號',
    ],
    [
      '臺北市松山區延吉街9之4號',
      '臺北市松山區延吉街9號',
    ],
    [
      '臺北市大安區敦化南路1段191號地下、地下之1至8、地下之37至73、地下之84至85',
      '臺北市大安區敦化南路1段191號',
    ],
    [
      '臺北市大安區仁愛路四段二五號三A',
      '臺北市大安區仁愛路4段25號',
    ],
    [
      '臺北市大安區錦安里金華街118號',
      '臺北市大安區金華街118號',
    ],
    [
      '彰化縣彰化市中正路一段陽明里106號之2',
      '彰化縣彰化市中正路1段106號',
    ],
  ];

  for (const [address, expected] of cases) {
    assert.deepEqual(normalizeAddressBuildingKeys(address), [base(expected)], address);
  }
});

test('normalizes the repeated Hsinchu source I- doorplate marker as a doorplate', () => {
  const address = '新竹縣關西鎮北斗里正義路３４I-';
  assert.deepEqual(normalizeAddressBuildingKeys(address), [
    normalizeAddressText('新竹縣關西鎮正義路34號'),
  ]);

  const result = buildCountyAddressPack([{
    county: '10004', town: '1000404', village: '北斗里', road: '正義路', number: '３４I-',
    longitude: '121.176252', latitude: '24.79203',
  }], {
    countyCode: '10004',
    countyName: '新竹縣',
    countyBoundary: {
      type: 'Polygon',
      coordinates: [[[121.1, 24.7], [121.3, 24.7], [121.3, 24.9], [121.1, 24.9], [121.1, 24.7]]],
    },
    coordinateSystem: 'EPSG:4326',
    fields: {
      countyCode: 'county', townCode: 'town', village: 'village', street: 'road', number: 'number',
      longitude: 'longitude', latitude: 'latitude',
    },
    townNamesByCode: { '10004040': '關西鎮' },
    sourceVersion: 'test-version',
  });
  assert.equal(result.records[0].address, '新竹縣關西鎮北斗里正義路３４號');
  assert.ok(result.records[0].aliases.includes('新竹縣關西鎮正義路34號'));
});

test('TWD97 TM2 conversion returns WGS84 longitude then latitude in Taipei', () => {
  const [longitude, latitude] = projectTwd97Tm2ToWgs84(306847.96600313165, 2772208.373611303, 121);

  assert.ok(longitude > 121.4 && longitude < 121.8);
  assert.ok(latitude > 24.9 && latitude < 25.2);
});

test('inferAddressCoordinateSystem selects the only projection inside the county boundary', () => {
  const countyBoundary = {
    type: 'Polygon',
    coordinates: [[
      [121.4, 24.9], [121.8, 24.9], [121.8, 25.2], [121.4, 25.2], [121.4, 24.9],
    ]],
  };

  const projection = inferAddressCoordinateSystem([
    { x: 306847.966, y: 2772208.374 },
    { x: 298143.043, y: 2767433.787 },
  ], countyBoundary);

  assert.equal(projection, 'EPSG:3826');
});

test('buildCountyAddressPack only publishes verified in-county addresses and reports gaps', () => {
  const countyBoundary = {
    type: 'Polygon',
    coordinates: [[
      [121.4, 24.9], [121.8, 24.9], [121.8, 25.2], [121.4, 25.2], [121.4, 24.9],
    ]],
  };
  const result = buildCountyAddressPack([
    { county: '63000', town: '63000010', village: '三民里', road: '三民路', lane: '９５巷', number: '１號', x: '306847.966', y: '2772208.374' },
    { county: '63000', town: '63000010', village: '三民里', road: '三民路', lane: '', number: '２號', x: '', y: '' },
    { county: '65000', town: '65000010', village: '九如里', road: '三民路二段', lane: '', number: '１號', x: '298143.043', y: '2767433.787' },
  ], {
    countyCode: '63000',
    countyName: '臺北市',
    countyBoundary,
    coordinateSystem: 'auto',
    fields: {
      countyCode: 'county', townCode: 'town', village: 'village', street: 'road',
      lane: 'lane', number: 'number', x: 'x', y: 'y',
    },
    townNamesByCode: { '63000010': '松山區' },
    sourceVersion: '2026-10',
  });

  assert.equal(result.summary.source_count, 3);
  assert.equal(result.summary.located_count, 1);
  assert.equal(result.summary.unlocated_count, 1);
  assert.equal(result.summary.excluded_count, 1);
  assert.equal(result.summary.coverage_status, 'partial');
  assert.equal(result.coordinate_system, 'EPSG:3826');
  assert.equal(result.records[0].name, '臺北市松山區三民里三民路９５巷１號');
  assert.ok(result.records[0].aliases.includes('臺北市松山區三民路95巷1號'));
  assert.ok(result.records[0].coordinate[0] > 121.4 && result.records[0].coordinate[0] < 121.8);
});

test('buildCountyAddressPack restores a shortened official town code before generating aliases', () => {
  const countyBoundary = {
    type: 'Polygon',
    coordinates: [[[120.3, 23.5], [120.8, 23.5], [120.8, 23.9], [120.3, 23.9], [120.3, 23.5]]],
  };
  const result = buildCountyAddressPack([
    {
      county: '10009', town: '1000901', village: '仁愛里', road: '永安路', number: '１１８號',
      lon: '120.547763', lat: '23.707817',
    },
  ], {
    countyCode: '10009',
    countyName: '雲林縣',
    countyBoundary,
    coordinateSystem: 'EPSG:4326',
    fields: {
      countyCode: 'county', townCode: 'town', village: 'village', street: 'road', number: 'number',
      longitude: 'lon', latitude: 'lat',
    },
    townNamesByCode: { '10009010': '斗六市' },
    sourceVersion: 'test-version',
  });

  assert.equal(result.records[0].address, '雲林縣斗六市仁愛里永安路１１８號');
  assert.equal(result.records[0].town_code, '10009010');
  assert.ok(result.records[0].aliases.includes('雲林縣斗六市永安路118號'));
});

test('buildCountyAddressPack restores an unrecognized legacy town code from its verified coordinate', () => {
  const result = buildCountyAddressPack([{
    county: '64000', town: '6400100', village: '中原里', road: '七賢三路', number: '１１０號',
    longitude: '120.282114', latitude: '22.625673',
  }], {
    countyCode: '64000',
    countyName: '高雄市',
    countyBoundary: {
      type: 'Polygon',
      coordinates: [[[120.2, 22.5], [120.4, 22.5], [120.4, 22.7], [120.2, 22.7], [120.2, 22.5]]],
    },
    coordinateSystem: 'EPSG:4326',
    fields: {
      countyCode: 'county', townCode: 'town', village: 'village', street: 'road', number: 'number',
      longitude: 'longitude', latitude: 'latitude',
    },
    townNamesByCode: { '64000010': '鹽埕區' },
    townCodeResolver(sourceCode, coordinate) {
      return sourceCode === '6400100' && coordinate[0] === 120.282114 ? '64000010' : null;
    },
    sourceVersion: 'test-version',
  });

  assert.equal(result.records[0].address, '高雄市鹽埕區中原里七賢三路１１０號');
  assert.equal(result.records[0].town_code, '64000010');
  assert.ok(result.records[0].aliases.includes('高雄市鹽埕區七賢三路110號'));
});

test('buildCountyAddressPack excludes points that rounding moves outside the county boundary', async () => {
  const counties = JSON.parse(await readFile(
    new URL('../../data/boundaries/geojson/county.geojson', import.meta.url), 'utf8',
  ));
  const newTaipei = counties.features.find((feature) => feature.properties.COUNTYCODE === '65000');
  const result = buildCountyAddressPack([
    {
      county: '65000', town: '65000110', village: '白雲里', street: '汐碇路',
      lane: '５２６巷', number: '８０號之１', x: '315836.861819', y: '2769005.8408400',
    },
  ], {
    countyCode: '65000', countyName: '新北市', countyBoundary: newTaipei.geometry,
    coordinateSystem: 'EPSG:3826', sourceCountyCodes: ['65000'],
    fields: {
      countyCode: 'county', townCode: 'town', village: 'village', street: 'street',
      lane: 'lane', number: 'number', x: 'x', y: 'y',
    },
    sourceVersion: '11509',
  });

  assert.equal(result.summary.source_count, 1);
  assert.equal(result.summary.located_count, 0);
  assert.equal(result.summary.excluded_count, 1);
});

test('buildCountyAddressPack preserves an official full-address field without duplicating county or town', () => {
  const countyBoundary = {
    type: 'Polygon',
    coordinates: [[[120.9, 24.7], [121.1, 24.7], [121.1, 24.9], [120.9, 24.9], [120.9, 24.7]]],
  };
  const result = buildCountyAddressPack([
    { county: '10018', town: '10018010', village: '東門里', address: '新竹市東區中正路１號', x: '120.965', y: '24.804' },
  ], {
    countyCode: '10018', countyName: '新竹市', countyBoundary, coordinateSystem: 'EPSG:4326',
    fields: { countyCode: 'county', townCode: 'town', village: 'village', fullAddress: 'address', x: 'x', y: 'y' },
    townNamesByCode: { '10018010': '東區' }, sourceVersion: '2026-06',
  });

  assert.equal(result.records[0].address, '新竹市東區中正路１號');
  assert.equal(result.records[0].region, '新竹市東區');
  assert.equal(result.records[0].search_key, normalizeAddressText('新竹市東區中正路１號'));
});

test('address source loader combines documented CSV and JSON files and hashes the complete input set', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'address-source-loader-'));
  try {
    await writeFile(path.join(directory, 'east.csv'), `name,coordinate\n${'東區地址'.repeat(20)},120.9\n`);
    await writeFile(path.join(directory, 'west.json'), JSON.stringify([{ name: '西區地址'.repeat(25), coordinate: '120.8' }]));
    const result = await loadAddressSourceRows(directory, {
      sourceId: 'test-split-address-source',
      inputFiles: [
        { file: 'east.csv', format: 'csv', encoding: 'utf-8' },
        { file: 'west.json', format: 'json', encoding: 'utf-8' },
      ],
    });

    assert.equal(result.rows.length, 2);
    assert.match(result.sourceSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(result.missing, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('address pack builder accepts the established pipeline signer path setting', () => {
  assert.equal(
    resolveAddressPackSigningKeyPath({ env: { PIPELINE_SIGNING_PRIVATE_KEY: '/secure/pipeline-key.pem' } }),
    '/secure/pipeline-key.pem',
  );
  assert.equal(
    resolveAddressPackSigningKeyPath({ env: { SIGNING_PRIVATE_KEY_PATH: '/secure/server-key.pem', PIPELINE_SIGNING_PRIVATE_KEY: '/secure/pipeline-key.pem' } }),
    '/secure/server-key.pem',
  );
  assert.equal(
    resolveAddressPackSigningKeyPath({ explicitPath: '/secure/override.pem', env: {} }),
    '/secure/override.pem',
  );
});

test('source county codes are normalized when the city dataset uses its short official code', () => {
  const pack = buildCountyAddressPack([
    { county: '64', town: '6400100', street: '七賢三路', number: '１１０號', lon: '120.28', lat: '22.63' },
  ], {
    countyCode: '64000', countyName: '高雄市', sourceCountyCodes: ['64'],
    countyBoundary: {
      type: 'Polygon',
      coordinates: [[[120, 22], [121, 22], [121, 23], [120, 23], [120, 22]]],
    },
    coordinateSystem: 'EPSG:4326',
    fields: { countyCode: 'county', townCode: 'town', street: 'street', number: 'number', longitude: 'lon', latitude: 'lat' },
    sourceVersion: '115-06',
  });

  assert.equal(pack.records.length, 1);
  assert.equal(pack.summary.excluded_count, 0);
});

test('published short county codes are mapped explicitly for Taichung, Taoyuan, and Kinmen', () => {
  const sources = getAddressSourceDefinitions();
  assert.deepEqual(sources.find((item) => item.countyCode === '66000').sourceCountyCodes, ['66']);
  assert.deepEqual(sources.find((item) => item.countyCode === '68000').sourceCountyCodes, ['68']);
  assert.deepEqual(sources.find((item) => item.countyCode === '09020').sourceCountyCodes, ['9020']);
});

test('buildSignedAddressPackArtifact signs package coverage and hashes the compressed bytes', async () => {
  const key = generateEd25519KeyPair();
  const pack = {
    schema_version: 'address-pack-v1',
    county_code: '63000',
    county_name: '臺北市',
    source_version: '2026-10',
    coordinate_system: 'EPSG:3826',
    coordinate_order: 'longitude,latitude',
    records: [{ id: 'address:63000:a', name: '臺北市松山區三民路１號', coordinate: [121.55, 25.05] }],
    summary: { source_count: 2, located_count: 1, unlocated_count: 1, excluded_count: 0, coverage_status: 'partial' },
  };
  const artifact = await buildSignedAddressPackArtifact(pack, {
    privateKey: key.privateKey,
    signingKeyId: 'address-test-key',
    sourceUrl: 'https://data.gov.tw/dataset/155472',
    licenseUrl: 'https://data.gov.tw/license',
    createdAt: '2026-10-04T00:00:00.000Z',
  });
  const { signature, ...signedManifest } = artifact.manifest;

  assert.equal(artifact.manifest.coverage_status, 'partial');
  assert.equal(artifact.manifest.located_count, 1);
  assert.equal(artifact.manifest.sha256, `sha256:${artifact.sha256}`);
  assert.equal(verifyCanonical(signedManifest, signature, key.publicKey), true);
  const decoded = gunzipSync(artifact.data).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(decoded[0].schema_version, 'address-pack-ndjson-v1');
  assert.equal(decoded[1].id, 'address:63000:a');
});

test('signed address-pack reader validates the catalog and returns exact county address points', async () => {
  const key = generateEd25519KeyPair();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'signed-address-pack-'));
  try {
    const pack = {
      schema_version: 'address-pack-v1', county_code: '63000', county_name: '臺北市',
      source_version: '2026-10', coordinate_system: 'EPSG:3826',
      coordinate_order: 'longitude,latitude',
      records: [{
        id: 'address:63000:1', name: '臺北市內湖區內湖路1號',
        address: '臺北市內湖區內湖路1號', region: '臺北市內湖區',
        aliases: ['臺北市內湖區內湖路１號（1樓）'],
        county_code: '63000', town_code: '63000010', coordinate: [121.58, 25.08],
      }, {
        id: 'address:63000:2', name: '臺北市內湖里康寧路1號',
        address: '臺北市內湖里康寧路1號', region: '臺北市',
        aliases: ['臺北市康寧路1號', '康寧路1號'],
        county_code: '63000', town_code: '6300100', coordinate: [121.59, 25.09],
      }],
      summary: { source_count: 2, located_count: 2, unlocated_count: 0, excluded_count: 0, coverage_status: 'complete' },
    };
    const artifact = await buildSignedAddressPackArtifact(pack, {
      privateKey: key.privateKey, signingKeyId: 'address-test-key',
      sourceUrl: 'https://data.gov.tw/dataset/155472', createdAt: '2026-10-04T00:00:00.000Z',
    });
    await writeFile(path.join(directory, artifact.dataFile), artifact.data);
    await writeFile(path.join(directory, artifact.manifestFile), JSON.stringify(artifact.manifest));
    const counties = Array.from({ length: 22 }, (_, index) => ({
      county_code: String(10000 + index).padStart(5, '0'), county_name: `縣市${index}`,
      coverage_status: 'unavailable', manifest_url: null, manifest_sha256: null,
    }));
    counties[0] = {
      county_code: '63000', county_name: '臺北市', coverage_status: 'complete',
      source_count: 2, located_count: 2, unlocated_count: 0, excluded_count: 0,
      manifest_url: `/address-packs/${artifact.manifestFile}`,
      manifest_sha256: artifact.manifestSha256,
    };
    const catalog = buildSignedAddressPackCatalog(counties, {
      privateKey: key.privateKey, signingKeyId: 'address-test-key', createdAt: '2026-10-04T00:00:00.000Z',
    });
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify(catalog));
    const features = await readSignedAddressPackFeatures({
      directory,
      publicKey: key.publicKey,
      addresses: ['臺北市內湖區內湖路１號'],
    });

    assert.equal(features.length, 1);
    assert.deepEqual(features[0].geometry.coordinates, [121.58, 25.08]);
    assert.equal(features[0].properties.county_code, '63000');
    assert.equal(features[0].properties.coordinate_source, 'official-doorplate:63000');

    const aliasFeatures = await readSignedAddressPackFeatures({
      directory,
      publicKey: key.publicKey,
      addresses: ['臺北市內湖區內湖路１號（1樓）'],
    });
    assert.equal(aliasFeatures.length, 1);
    assert.deepEqual(aliasFeatures[0].properties.matched_address_keys, [
      normalizeAddressText('臺北市內湖區內湖路1號'),
    ]);

    const restoredTownAliasFeatures = await readSignedAddressPackFeatures({
      directory,
      publicKey: key.publicKey,
      addresses: ['臺北市內湖區康寧路1號'],
      townNamesByCode: { '63000010': '內湖區' },
      townCodeResolver(sourceCode, coordinate) {
        return sourceCode === '6300100' && coordinate[0] === 121.59 ? '63000010' : null;
      },
    });
    assert.equal(restoredTownAliasFeatures.length, 1);
    assert.deepEqual(restoredTownAliasFeatures[0].geometry.coordinates, [121.59, 25.09]);

    const floorVariantFeatures = await readSignedAddressPackFeatures({
      directory,
      publicKey: key.publicKey,
      addresses: ['臺北市內湖區內湖路１號（2樓）'],
    });
    assert.equal(floorVariantFeatures.length, 1);
    assert.deepEqual(floorVariantFeatures[0].properties.matched_address_keys, [
      normalizeAddressText('臺北市內湖區內湖路1號'),
    ]);

    const listedDoorNumberFeatures = await readSignedAddressPackFeatures({
      directory,
      publicKey: key.publicKey,
      addresses: ['臺北市內湖區內湖路１、２號１１樓'],
    });
    assert.equal(listedDoorNumberFeatures.length, 1);
    assert.deepEqual(listedDoorNumberFeatures[0].properties.matched_address_keys, [
      normalizeAddressText('臺北市內湖區內湖路1號'),
    ]);

    const changed = { ...catalog, attribution: 'tampered' };
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify(changed));
    await assert.rejects(
      () => readSignedAddressPackFeatures({ directory, publicKey: key.publicKey, addresses: ['臺北市內湖區內湖路1號'] }),
      /catalog failed verification/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('signed address-pack reader prefers a main doorplate unless an exact subdoorplate is requested', async () => {
  const key = generateEd25519KeyPair();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'signed-address-pack-main-doorplate-'));
  try {
    const records = [
      ['臺北市大安區錦安里金華街118之12號', ['臺北市大安區金華街118之12號'], [121.5269, 25.0299]],
      ['臺北市大安區錦安里金華街118之14號', ['臺北市大安區金華街118之14號'], [121.5270, 25.0300]],
      ['臺北市大安區錦安里金華街118號', ['臺北市大安區金華街118號'], [121.5268, 25.0301]],
    ].map(([address, aliases, coordinate], index) => ({
      id: `address:63000:${index + 1}`,
      name: address,
      address,
      region: '臺北市大安區',
      aliases,
      county_code: '63000',
      town_code: '63000030',
      coordinate,
    }));
    const artifact = await buildSignedAddressPackArtifact({
      schema_version: 'address-pack-v1', county_code: '63000', county_name: '臺北市',
      source_version: '2026-10', coordinate_system: 'EPSG:3826',
      coordinate_order: 'longitude,latitude', records,
      summary: { source_count: 3, located_count: 3, unlocated_count: 0, excluded_count: 0, coverage_status: 'complete' },
    }, {
      privateKey: key.privateKey, signingKeyId: 'address-test-key',
      sourceUrl: 'https://data.gov.tw/dataset/155472', createdAt: '2026-10-04T00:00:00.000Z',
    });
    await writeFile(path.join(directory, artifact.dataFile), artifact.data);
    await writeFile(path.join(directory, artifact.manifestFile), JSON.stringify(artifact.manifest));
    const counties = Array.from({ length: 22 }, (_, index) => ({
      county_code: String(10000 + index).padStart(5, '0'), county_name: `縣市${index}`,
      coverage_status: 'unavailable', manifest_url: null, manifest_sha256: null,
    }));
    counties[0] = {
      county_code: '63000', county_name: '臺北市', coverage_status: 'complete',
      source_count: 3, located_count: 3, unlocated_count: 0, excluded_count: 0,
      manifest_url: `/address-packs/${artifact.manifestFile}`,
      manifest_sha256: artifact.manifestSha256,
    };
    const catalog = buildSignedAddressPackCatalog(counties, {
      privateKey: key.privateKey, signingKeyId: 'address-test-key', createdAt: '2026-10-04T00:00:00.000Z',
    });
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify(catalog));

    const features = await readSignedAddressPackFeatures({
      directory,
      publicKey: key.publicKey,
      addresses: ['臺北市大安區金華街118號'],
    });

    assert.equal(features.length, 1);
    assert.deepEqual(features[0].geometry.coordinates, [121.5268, 25.0301]);

    const exactSubdoorFeatures = await readSignedAddressPackFeatures({
      directory,
      publicKey: key.publicKey,
      addresses: ['臺北市大安區金華街118-12號'],
    });

    assert.equal(exactSubdoorFeatures.length, 1);
    assert.deepEqual(exactSubdoorFeatures[0].geometry.coordinates, [121.5269, 25.0299]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('address source catalog includes all 18 published open-data counties and leaves four unavailable', () => {
  const sources = getAddressSourceDefinitions();

  assert.equal(sources.length, 22);
  assert.deepEqual(
    sources.filter((source) => source.available).map((source) => source.countyCode).sort(),
    ['09020', '10004', '10005', '10007', '10009', '10010', '10013', '10014', '10015', '10016', '10017', '10018', '63000', '64000', '65000', '66000', '67000', '68000'],
  );
  assert.equal(sources.filter((source) => !source.available).length, 4);
  const hsinchuCity = sources.find((source) => source.countyCode === '10018');
  assert.equal(hsinchuCity.inputFiles.length, 3);
  assert.equal(hsinchuCity.fields.fullAddress[0], '地址');
  const yunlin = sources.find((source) => source.countyCode === '10009');
  assert.deepEqual(yunlin.inputFiles.map((file) => file.format), ['json', 'json', 'json']);
});

test('Keelung official address CSV fields produce a WGS84 point inside the county boundary', async () => {
  const source = getAddressSourceDefinitions().find((item) => item.countyCode === '10017');
  assert.equal(source.available, true);
  assert.equal(source.sourceId, 'keelung-house-number-coordinates');
  assert.equal(source.sourceVersion, '11509');
  assert.equal(source.sourceUrl, 'https://www.klcg.gov.tw/tw/civil/2209-292163.html');
  assert.equal(source.coordinateSystem, 'EPSG:3826');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'keelung-address-source-'));
  try {
    const headers = '縣市,鄉鎮市區,村里,鄰,街、路段,巷,弄,號,橫座標,縱座標';
    const rows = [
      '基隆市,中正區,中正里,1,中正路,,,3號,330000,2780000',
      '新北市,瑞芳區,九份里,2,測試街,,,1號,330000,2780000',
      '基隆市,中正區,中正里,1,中正路,,,5號,,',
      '基隆市,中正區,中正里,1,中正路,,,7號,invalid,invalid',
    ];
    await writeFile(path.join(directory, source.inputFile), `${headers}\n${rows.join('\n')}\n`);
    const loaded = await loadAddressSourceRows(directory, source);
    assert.deepEqual(loaded.missing, []);
    assert.equal(loaded.rows.length, 4);

    const fields = resolveAddressSourceFields(Object.keys(loaded.rows[0]), source);
    assert.deepEqual(fields, {
      countyName: '縣市', townName: '鄉鎮市區', village: '村里', street: '街、路段',
      lane: '巷', alley: '弄', number: '號',
      x: '橫座標', y: '縱座標',
    });

    const counties = JSON.parse(await readFile(
      new URL('../../data/boundaries/geojson/county.geojson', import.meta.url), 'utf8',
    ));
    const boundary = counties.features.find((feature) => feature.properties.COUNTYCODE === '10017');
    const pack = buildCountyAddressPack(loaded.rows, {
      countyCode: source.countyCode,
      countyName: source.countyName,
      countyBoundary: boundary.geometry,
      coordinateSystem: source.coordinateSystem,
      fields,
      sourceCountyNames: source.sourceCountyNames,
      sourceVersion: source.sourceVersion,
    });

    assert.equal(pack.summary.source_count, 4);
    assert.equal(pack.summary.located_count, 1);
    assert.equal(pack.summary.unlocated_count, 2);
    assert.equal(pack.summary.excluded_count, 1);
    assert.equal(pack.coordinate_system, 'EPSG:3826');
    assert.equal(pack.records[0].region, '基隆市中正區');
    assert.ok(pack.records[0].coordinate[0] > 121.7 && pack.records[0].coordinate[0] < 121.9);
    assert.ok(pack.records[0].coordinate[1] > 25.0 && pack.records[0].coordinate[1] < 25.3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source field aliases bind the published city CSV headers without fuzzy guessing', () => {
  const source = getAddressSourceDefinitions().find((item) => item.countyCode === '65000');
  const fields = resolveAddressSourceFields([
    'countycode', 'areacode', 'village', 'street、road、section', 'area', 'lane', 'alley', 'number', 'x_3826', 'y_3826',
  ], source);

  assert.deepEqual(fields, {
    countyCode: 'countycode', townCode: 'areacode', village: 'village',
    street: 'street、road、section', area: 'area', lane: 'lane', alley: 'alley',
    number: 'number', x: 'x_3826', y: 'y_3826',
  });
  assert.throws(() => resolveAddressSourceFields(['countycode'], source), /required field/i);
});

test('source field aliases recognize address-only source files and the Tainan district-code header', () => {
  const source = getAddressSourceDefinitions().find((item) => item.countyCode === '10018');
  const fields = resolveAddressSourceFields([
    '省市縣市代碼', '鄉鎮市區代碼', '村里', '鄰', '地址', '橫座標', '縱座標',
  ], source);

  assert.equal(fields.fullAddress, '地址');
  assert.equal(fields.street, undefined);
  const tainan = getAddressSourceDefinitions().find((item) => item.countyCode === '67000');
  assert.equal(resolveAddressSourceFields([
    '縣市別代碼', '地址-行政區域代碼', '村里', '鄰', '街路段', '地區', '巷', '弄', '號', '橫座標[E 坐標]', '縱座標[N 坐標]',
  ], tainan).townCode, '地址-行政區域代碼');
});

test('address catalog is signed and pins each available county manifest digest', () => {
  const key = generateEd25519KeyPair();
  const catalog = buildSignedAddressPackCatalog([
    { county_code: '63000', county_name: '臺北市', coverage_status: 'partial', manifest_url: '/address-packs/manifest-63000.json', manifest_sha256: `sha256:${'a'.repeat(64)}` },
    { county_code: '10015', county_name: '花蓮縣', coverage_status: 'unavailable', manifest_url: null, manifest_sha256: null },
  ], {
    privateKey: key.privateKey,
    signingKeyId: 'address-test-key',
    createdAt: '2026-10-04T00:00:00.000Z',
  });
  const { signature, ...signedCatalog } = catalog;

  assert.equal(catalog.schema_version, 'address-pack-catalog-v1');
  assert.equal(
    catalog.counties.find((county) => county.county_code === '63000').manifest_sha256,
    `sha256:${'a'.repeat(64)}`,
  );
  assert.equal(verifyCanonical(signedCatalog, signature, key.publicKey), true);
});
