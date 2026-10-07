const COUNTY_METADATA = [
  ['09007', '連江縣'], ['10002', '宜蘭縣'], ['10004', '新竹縣'], ['10005', '苗栗縣'],
  ['10007', '彰化縣'], ['10008', '南投縣'], ['10009', '雲林縣'], ['10010', '嘉義縣'],
  ['10013', '屏東縣'], ['10014', '臺東縣'], ['10015', '花蓮縣'], ['10016', '澎湖縣'],
  ['10017', '基隆市'], ['10018', '新竹市'], ['10020', '嘉義市'], ['63000', '臺北市'],
  ['64000', '高雄市'], ['65000', '新北市'], ['66000', '臺中市'], ['67000', '臺南市'],
  ['68000', '桃園市'], ['09020', '金門縣'],
];

const COMMON_TAIWAN_HEADERS = {
  countyCode: ['縣市代碼', '縣市別代碼', '省市縣市代碼', 'countycode', 'county_code'],
  townCode: ['鄉鎮市區代碼', '鄉鎮市區別代碼', 'areacode', 'area_code', 'towncode'],
  village: ['村里', '村里別', 'village'],
  street: ['街路段', '街、路段', '街_路段', '街或路段', 'street、road、section', 'street', 'road'],
  area: ['地區', 'area'],
  lane: ['巷', 'lane'],
  alley: ['弄', 'alley'],
  number: ['號', '號樓', '門牌號', 'number'],
  x: ['橫座標', '橫坐標', '橫座標[e坐標]', 'twd97橫坐標', 'x_3826', 'x', 'twd97x'],
  y: ['縱座標', '縱坐標', '縱座標[n坐標]', 'twd97縱坐標', 'y_3826', 'y', 'twd97y'],
  longitude: ['wgs84經度', '經度', 'longitude', 'lon'],
  latitude: ['wgs84緯度', '緯度', 'latitude', 'lat'],
};

const AVAILABLE_SOURCES = {
  '10004': {
    inputFile: 'nlsc-hsinchu-county-address.csv',
    sourceId: 'hsinchu-county-house-number-coordinates',
    sourceName: '新竹縣門牌位置',
    sourceVersion: '1150305',
    sourceUrl: 'https://data.gov.tw/dataset/172380',
    downloadUrl: 'https://ws.hsinchu.gov.tw/001/Upload/1/opendata/8774/2663/03e34b18-f513-46f5-a561-6940cac83712.csv',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'auto',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10005': {
    inputFile: 'nlsc-miaoli-address.csv',
    sourceId: 'miaoli-house-number-coordinates',
    sourceName: '苗栗縣迄 115 年 6 月門牌座標資料',
    sourceVersion: '115-06-30',
    sourceUrl: 'https://data.gov.tw/dataset/178083',
    downloadUrl: 'https://webws.miaoli.gov.tw/Download.ashx?icon=.csv&n=MTE15bm05LiK5Y2K5bm05bqm6IuX5qCX57ij6ZaA54mM6bue5L2N57at6K2357O757Wx6ZaA54mM5bqn5qiZ6LOH5paZLmNzdg%3D%3D&u=LzAwMS9VcGxvYWQvb3BlbmRhdGEvMjEzNy80MzI2OTU0MC03NzM5LTRmZDUtYTA0Ni1mZGQ5MTcwY2RkMmIuY3N2',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'auto',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10007': {
    inputFile: 'nlsc-changhua-address.csv',
    sourceId: 'changhua-house-number-coordinates',
    sourceName: '彰化縣門牌點位資料',
    sourceVersion: 'official-current-2025-06',
    sourceUrl: 'https://data.gov.tw/dataset/170727',
    downloadUrl: 'https://email.chcg.gov.tw/df/zf6yiecoy4nf5jgtbsacvhpwvog26v',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'auto',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10009': {
    inputFiles: [
      { file: 'nlsc-yunlin-address-01.json', format: 'json' },
      { file: 'nlsc-yunlin-address-02.json', format: 'json' },
      { file: 'nlsc-yunlin-address-03.json', format: 'json' },
    ],
    sourceId: 'yunlin-house-number-coordinates',
    sourceName: '雲林縣門牌座標資料',
    sourceVersion: '1140505',
    sourceUrl: 'https://data.gov.tw/dataset/166201',
    downloadUrl: 'https://ws.yunlin.gov.tw/001/Upload/539/opendata/15369/1788/9ca28454-15ad-467e-b7a3-92bce9188b60.json',
    licenseUrl: 'https://data.gov.tw/license',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10010': {
    inputFile: 'nlsc-chiayi-county-address.csv',
    sourceId: 'chiayi-county-house-number-coordinates',
    sourceName: '嘉義縣門牌位置',
    sourceVersion: '1150327',
    sourceUrl: 'https://data.gov.tw/dataset/172873',
    downloadUrl: 'https://ws-tm.cyhg.gov.tw/001/Upload/0/relfile/0/0/692ca166-b63f-4e9a-b2ce-9a643c48f2e6.csv',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'utf-8',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10013': {
    inputFile: 'nlsc-pingtung-address.csv',
    sourceId: 'pingtung-house-number-coordinates',
    sourceName: '屏東縣全縣門牌檔',
    sourceVersion: '1150914',
    sourceUrl: 'https://data.gov.tw/dataset/170847',
    downloadUrl: 'https://www-ws.pthg.gov.tw/Upload/2015pthg/0/relfile/0/0/f8e414e9-e224-41af-9178-c40890489764.csv',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'auto',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10014': {
    inputFile: 'nlsc-taitung-address.csv',
    sourceId: 'taitung-house-number-coordinates',
    sourceName: '臺東縣市門牌坐標資料',
    sourceVersion: 'official-current-2026-06-04',
    sourceUrl: 'https://data.gov.tw/dataset/165619',
    downloadUrl: 'https://ttone.taitung.gov.tw/download?id=dhHIYU0Y8nwyyZA%2BM4KOXg%3D%3D',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'auto',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10016': {
    inputFile: 'nlsc-penghu-address.csv',
    sourceId: 'penghu-house-number-coordinates',
    sourceName: '澎湖縣門牌位置數值資料',
    sourceVersion: '2026-09-24',
    sourceUrl: 'https://data.gov.tw/dataset/170852',
    downloadUrl: 'https://opendata.penghu.gov.tw/dataset/302f94b3-89f9-4877-969a-bd931df82cb3/resource/12be535a-83de-43ee-8922-fea1549bdd4e/download/u600000-03-2024-09-26-1727342410.csv',
    licenseUrl: 'https://data.gov.tw/principle',
    encoding: 'utf-8',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10017': {
    inputFile: 'nlsc-keelung-address.csv',
    sourceId: 'keelung-house-number-coordinates',
    sourceName: '基隆市門牌位置資料',
    sourceVersion: '11509',
    sourceUrl: 'https://www.klcg.gov.tw/tw/civil/2209-292163.html',
    downloadUrl: 'https://www.klcg.gov.tw/wSite/public/Attachment/00810/f1789379319200.csv',
    licenseUrl: 'https://www.klcg.gov.tw/tw/klcg1/3259-110276.html',
    sourceCountyNames: ['基隆市'],
    encoding: 'auto',
    coordinateSystem: 'EPSG:3826',
    fields: {
      countyName: ['縣市'], townName: ['鄉鎮市區'], village: ['村里'],
      street: ['街、路段'], lane: ['巷'], alley: ['弄'], number: ['號'],
      x: ['橫座標'], y: ['縱座標'],
    },
  },
  '10018': {
    inputFiles: [
      { file: 'nlsc-hsinchu-city-east.csv', format: 'csv', encoding: 'utf-8' },
      { file: 'nlsc-hsinchu-city-north.csv', format: 'csv', encoding: 'utf-8' },
      { file: 'nlsc-hsinchu-city-xiangshan.csv', format: 'csv', encoding: 'utf-8' },
    ],
    sourceId: 'hsinchu-city-house-number-coordinates',
    sourceName: '新竹市門牌坐標資料（僅供參考）',
    sourceVersion: 'official-current-2026-06-23',
    sourceUrl: 'https://data.gov.tw/dataset/157547',
    downloadUrl: 'https://data.gov.tw/dataset/157547',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'utf-8',
    coordinateSystem: 'auto',
    fields: {
      countyCode: COMMON_TAIWAN_HEADERS.countyCode,
      townCode: COMMON_TAIWAN_HEADERS.townCode,
      village: COMMON_TAIWAN_HEADERS.village,
      fullAddress: ['地址', 'address'],
      x: COMMON_TAIWAN_HEADERS.x,
      y: COMMON_TAIWAN_HEADERS.y,
    },
  },
  '67000': {
    inputFile: 'nlsc-tainan-address.csv',
    sourceId: 'tainan-house-number-coordinates',
    sourceName: '臺南市門牌坐標資料（僅供參考）',
    sourceVersion: '114',
    sourceUrl: 'https://data.gov.tw/dataset/120044',
    downloadUrl: 'https://data.tainan.gov.tw/File/ResourceCsvDownload/af44f904-2f4c-49b2-aaf8-1a64dce09bd4',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'utf-8',
    coordinateSystem: 'auto',
    fields: {
      ...COMMON_TAIWAN_HEADERS,
      townCode: ['地址-行政區域代碼', ...COMMON_TAIWAN_HEADERS.townCode],
    },
  },
  '68000': {
    inputFile: 'nlsc-taoyuan-address.csv',
    sourceCountyCodes: ['68'],
    sourceId: 'taoyuan-house-number-coordinates',
    sourceName: '桃園市門牌位置坐標資料',
    sourceVersion: '115-08',
    sourceUrl: 'https://data.gov.tw/dataset/157689',
    downloadUrl: 'https://opendata.tycg.gov.tw/api/dataset/ec47dbd5-9ed8-4c8d-8ce1-ccb63b1b72e6/resource/d00ecba4-dec2-4a62-bfc7-989a8359cebe/download',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'utf-8',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '09020': {
    inputFiles: [{ file: 'nlsc-kinmen-address.json', format: 'json', encoding: 'utf-8' }],
    sourceCountyCodes: ['9020'],
    sourceId: 'kinmen-house-number-coordinates',
    sourceName: '金門縣門牌位置數值資料',
    sourceVersion: '2024-12',
    sourceUrl: 'https://data.gov.tw/dataset/171571',
    downloadUrl: 'https://ws.kinmen.gov.tw/001/Upload/0/relfile/0/0/4ec84cf6-9ff7-4dd9-ab66-593eb1e4f8d5.json',
    licenseUrl: 'https://data.gov.tw/license',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '63000': {
    inputFile: 'nlsc-taipei-address.csv',
    sourceId: 'taipei-house-number-coordinates',
    sourceName: '臺北市門牌位置數值資料',
    sourceVersion: '2026-10-02',
    sourceUrl: 'https://data.gov.tw/dataset/155472',
    downloadUrl: 'https://data.taipei/api/dataset/b7c8e724-1e98-45ee-a0bd-f3840623ed97/resource/ce76ca0c-7f94-4935-ab47-1d2a41ca2abb/download',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'utf-8',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '65000': {
    inputFile: 'nlsc-newtaipei-address.csv',
    sourceId: 'new-taipei-house-number-coordinates',
    sourceName: '新北市門牌位置數值資料',
    sourceVersion: '11509',
    sourceUrl: 'https://data.gov.tw/dataset/168887',
    downloadUrl: 'https://data.ntpc.gov.tw/api/datasets/d7b568ab-3819-40c8-a6e7-a6b199443101/csv/file',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'utf-8',
    coordinateSystem: 'auto',
    fields: {
      countyCode: ['countycode'], townCode: ['areacode'], village: ['village'],
      street: ['street、road、section'], area: ['area'], lane: ['lane'], alley: ['alley'],
      number: ['number'], x: ['x_3826'], y: ['y_3826'],
    },
  },
  '66000': {
    inputFile: 'nlsc-taichung-address.csv',
    sourceCountyCodes: ['66'],
    sourceId: 'taichung-house-number-coordinates',
    sourceName: '臺中市 115 年月 GIS 門牌號碼',
    sourceVersion: '115-08',
    sourceUrl: 'https://data.gov.tw/dataset/177460',
    downloadUrl: 'https://drive.usercontent.google.com/download?id=1oCjMy_eccQHv7R-VUEBZiC9gtJZ18GcV&export=download&confirm=t&uuid=6498bfa9-edf9-4872-8a0f-d21537d3f138',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'auto',
    coordinateSystem: 'EPSG:4326',
    fields: {
      countyCode: COMMON_TAIWAN_HEADERS.countyCode,
      townCode: COMMON_TAIWAN_HEADERS.townCode,
      village: COMMON_TAIWAN_HEADERS.village,
      street: COMMON_TAIWAN_HEADERS.street,
      area: COMMON_TAIWAN_HEADERS.area,
      lane: COMMON_TAIWAN_HEADERS.lane,
      alley: COMMON_TAIWAN_HEADERS.alley,
      number: COMMON_TAIWAN_HEADERS.number,
      x: COMMON_TAIWAN_HEADERS.x,
      y: COMMON_TAIWAN_HEADERS.y,
      longitude: COMMON_TAIWAN_HEADERS.longitude,
      latitude: COMMON_TAIWAN_HEADERS.latitude,
    },
  },
  '64000': {
    inputFile: 'nlsc-kaohsiung-address.csv',
    sourceCountyCodes: ['64'],
    sourceId: 'kaohsiung-house-number-coordinates',
    sourceName: '高雄市 115 年門牌坐標資料（TWD97）',
    sourceVersion: '115-06',
    sourceUrl: 'https://data.gov.tw/dataset/177859',
    downloadUrl: 'https://data.kcg.gov.tw/File/directDownload/dd664f27-ddce-4721-88ef-3ece67308d77',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'auto',
    coordinateSystem: 'auto',
    fields: COMMON_TAIWAN_HEADERS,
  },
  '10015': {
    inputFile: 'nlsc-hualien-address.csv',
    sourceId: 'hualien-house-number-coordinates',
    sourceName: '花蓮縣門牌點位資料',
    sourceVersion: 'official-current-2026-10-04',
    sourceUrl: 'https://data.gov.tw/dataset/175221',
    downloadUrl: 'https://ws.hl.gov.tw/Download.ashx?u=LzAwMS9VcGxvYWQvNDY5L3JlbGZpbGUvMTM1MjIvMTk2NDg2LzY5YmY2NWM1LTQ3N2UtNGIxNC1iNzllLWIzYjMxMDdiZGM0NS5jc3Y%3d&n=5Zue6IGv57ij57Wm6bue5L2c5ZCN56%2bHLmNzdg%3d%3d',
    licenseUrl: 'https://data.gov.tw/license',
    encoding: 'big5',
    coordinateSystem: 'auto',
    fields: {
      countyCode: ['省市縣市代碼', '縣市別代碼', '縣市代碼'], townCode: ['鄉鎮市區代碼'],
      village: ['村里'], street: ['街路段'], area: ['地區'], lane: ['巷'],
      alley: ['弄'], number: ['號'], x: ['橫座標'], y: ['縱座標'],
    },
  },
};

function normalizeHeader(value) {
  return String(value).replace(/^\uFEFF/u, '').normalize('NFKC').replace(/[\s\u3000]/gu, '').toLowerCase();
}

export function getAddressSourceDefinitions() {
  return COUNTY_METADATA.map(([countyCode, countyName]) => {
    const source = AVAILABLE_SOURCES[countyCode];
    if (!source) {
      return {
        countyCode,
        countyName,
        available: false,
        coverageStatus: 'unavailable',
        sourceName: null,
        sourceVersion: null,
        sourceUrl: null,
        downloadUrl: null,
        licenseUrl: null,
        coordinateSystem: null,
      };
    }
    return {
      countyCode,
      countyName,
      available: true,
      coverageStatus: 'pending',
      ...source,
    };
  });
}

/** Resolve documented aliases exactly; an unknown required CSV column fails closed. */
export function resolveAddressSourceFields(headers, source) {
  if (!Array.isArray(headers) || !source?.fields) throw new TypeError('CSV headers and source definition are required');
  const actual = new Map(headers.map((header) => [normalizeHeader(header), header.trim()]));
  const fields = {};
  for (const [field, aliases] of Object.entries(source.fields)) {
    if (!Array.isArray(aliases) || aliases.length === 0) continue;
    const resolved = aliases.map(normalizeHeader).map((alias) => actual.get(alias)).find(Boolean);
    if (resolved) fields[field] = resolved;
  }
  const required = [];
  if (!fields.townCode && !fields.townName) required.push('townCode or townName');
  if (!fields.fullAddress) required.push('street', 'number');
  if (!fields.countyCode && !fields.countyName) required.push('countyCode or countyName');
  if (!fields.longitude || !fields.latitude) required.push('x', 'y');
  const missing = [...new Set(required.filter((field) => !fields[field]))];
  if (missing.length > 0) throw new TypeError(`required field not found in ${source.sourceId}: ${missing.join(', ')}`);
  return fields;
}
