import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { canonicalize } from './canonical.mjs';
import { signCanonical } from './crypto.mjs';

const TAIWAN_LONGITUDE = [118, 122.2];
const TAIWAN_LATITUDE = [21.8, 26.5];
const ADDRESS_DOOR_NUMBER = '[0-9零〇一二三四五六七八九十百o]+';
const ADDRESS_DOOR_PATTERN = new RegExp(
  `(${ADDRESS_DOOR_NUMBER}(?:(?:之|-)+${ADDRESS_DOOR_NUMBER})?(?:[、,，及和與/／]${ADDRESS_DOOR_NUMBER}(?:(?:之|-)+${ADDRESS_DOOR_NUMBER})?)*?)號`,
  'gu',
);
const FLOOR_LEVEL = '(?:\\d+|[零〇兩两一二三四五六七八九十百]+)';
const FLOOR_ANNOTATION_PATTERN = new RegExp(
  `(?:地下)?b?${FLOOR_LEVEL}(?:(?:至|到|~|～|-)(?:地下)?b?${FLOOR_LEVEL})?(?:樓|層|f|floor)(?:(?:之|-)+${FLOOR_LEVEL})?`,
  'giu',
);
const VILLAGE_AFTER_ADMIN = /(?<=[區鄉鎮])[\p{Script=Han}]{1,4}里(?=[\p{Script=Han}]{1,6}(?:路|街|大道))/gu;
const VILLAGE_AFTER_ROAD = /(?<=[路街巷弄段])[\p{Script=Han}]{1,4}里(?=[0-9零〇兩两一二三四五六七八九十百]+號)/gu;
const GEODETIC = Object.freeze({
  semiMajor: 6378137,
  inverseFlattening: 298.257222101,
  scale: 0.9999,
  falseEasting: 250000,
});

/** Parse RFC 4180 CSV while retaining line breaks inside quoted fields. */
export function parseCsv(input) {
  if (typeof input !== 'string') throw new TypeError('CSV input must be text');
  const text = input.replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      if (cell.length > 0 || closedQuote) throw new TypeError('CSV quote is misplaced');
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
      closedQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      cell = '';
      closedQuote = false;
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else {
      if (closedQuote && !/\s/u.test(character)) throw new TypeError('CSV data follows a closing quote');
      if (!closedQuote) cell += character;
    }
  }
  if (quoted) throw new TypeError('CSV has an unterminated quoted field');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows.shift().map((value) => value.trim());
  if (headers.some((value) => value.length === 0)) throw new TypeError('CSV header contains an empty field');
  if (new Set(headers).size !== headers.length) throw new TypeError('CSV header contains duplicate fields');
  return rows.map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new TypeError(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index].trim()]));
  });
}

/** Parse a JSON array from an official address resource without guessing nested schemas. */
export function parseJsonRows(input) {
  if (typeof input !== 'string') throw new TypeError('JSON input must be text');
  const payload = JSON.parse(input.replace(/^\uFEFF/u, ''));
  if (!Array.isArray(payload)) throw new TypeError('JSON address source records must be an array');
  if (payload.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new TypeError('JSON address source rows must be objects');
  }
  return payload;
}

export function normalizeAddressText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replaceAll('台', '臺')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[，,、]/gu, '')
    .toLowerCase();
}

function chineseNumberToArabic(value) {
  const digits = { 零: 0, 〇: 0, 兩: 2, 两: 2, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百]/u.test(value)) return value.split('').map((digit) => digits[digit]).join('');
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character in digits) {
      current = digits[character];
    } else if (character === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === '百') {
      total += (current || 1) * 100;
      current = 0;
    }
  }
  return String(total + current);
}

function addressNumberToArabic(value) {
  const chineseNumerals = /^[零〇兩两一二三四五六七八九十百]+$/u;
  if (chineseNumerals.test(value) && /[十百]/u.test(value)) return chineseNumberToArabic(value);
  const digits = { 零: '0', 〇: '0', 兩: '2', 两: '2', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', o: '0' };
  return value.split('').map((character) => digits[character] ?? character).join('');
}

function normalizeOfficialDoorplateMarker(value) {
  if (typeof value !== 'string') return '';
  const digit = '[0-9０-９零〇兩两一二三四五六七八九十百o]+';
  const floor = `(?:地下)?b?${digit}(?:樓|層|f|floor)`;
  const marker = new RegExp(
    `(${digit})(?:之(${digit}))?i-(?:之(${digit}))?(?=$|[、,，/／;；()（）]|${floor})`,
    'giu',
  );
  return value.replace(marker, (match, main, beforeMarker, afterMarker) => {
    if (beforeMarker && afterMarker && beforeMarker !== afterMarker) return match;
    const subdoor = beforeMarker ?? afterMarker;
    return `${main}${subdoor ? `之${subdoor}` : ''}號`;
  });
}

function compactAddressForBuildingMatch(value) {
  if (typeof value !== 'string') return '';
  const compact = normalizeOfficialDoorplateMarker(value)
    .normalize('NFKC')
    .replaceAll('台', '臺')
    .replace(/(?<=[\d零〇一二三四五六七八九十])\s+(?=[\d零〇一二三四五六七八九十]+(?:樓|層|f|floor))/giu, '、')
    .replace(/[\s\u3000]+/gu, '')
    .toLowerCase()
    .replace(/([0-9零〇兩两一二三四五六七八九十百o]+)(?=(?:段|巷|弄|號|樓|層|之|-))/gu,
      (_match, number) => addressNumberToArabic(number));
  if (!compact.includes('里')) return compact;
  return compact
    .replace(VILLAGE_AFTER_ADMIN, '')
    .replace(VILLAGE_AFTER_ROAD, '');
}

function floorAnnotationContentOnly(value) {
  const remainder = compactAddressForBuildingMatch(value)
    .replace(FLOOR_ANNOTATION_PATTERN, '')
    .replace(/(?:地下室|地下層|地下|夾層|夾樓|實際營業地址|營業地址|不含|包含|含|地址)/gu, '')
    .replace(/[a-z](?:棟|區|座|室)/giu, '')
    .replace(/([0-9零〇兩两一二三四五六七八九十百]+)[a-z]/giu, '$1')
    .replace(/[\d零〇兩两一二三四五六七八九十百]+/gu, '')
    .replace(/[、,，及和與至到/／;；.．:：()（）[\]{}【】\s\-之]/gu, '');
  return remainder.length === 0;
}

function onlyFloorAnnotations(value) {
  const withoutFloorParentheses = compactAddressForBuildingMatch(value)
    .replace(/\(([^()]*)\)|（([^（）]*)）/gu, (annotation, asciiContent, fullWidthContent) => {
      const content = asciiContent ?? fullWidthContent ?? '';
      return floorAnnotationContentOnly(content) ? '' : annotation;
    });
  return floorAnnotationContentOnly(withoutFloorParentheses);
}

function splitListedDoorNumbers(value) {
  return value.split(/[、,，及和與/／]/u).filter(Boolean);
}

function mainDoorNumber(value) {
  const main = value.split(/(?:之|-)+/u, 1)[0];
  if (/^[零〇一二三四五六七八九十百]+$/u.test(main) && /[十百]/u.test(main)) {
    return chineseNumberToArabic(main);
  }
  const digits = { 零: '0', 〇: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', o: '0' };
  return main.split('').map((character) => digits[character] ?? character).join('');
}

/** Return the first listed building-doorplate key, dropping floor and unit notes. */
export function normalizeAddressBuildingKeys(value) {
  const compact = compactAddressForBuildingMatch(value);
  if (!compact) return [];
  const doorMatches = [...compact.matchAll(ADDRESS_DOOR_PATTERN)];
  if (doorMatches.length > 0) {
    const first = doorMatches[0];
    const firstNumber = splitListedDoorNumbers(first[1])[0];
    const key = `${compact.slice(0, first.index)}${mainDoorNumber(firstNumber)}號`;
    const remainder = compact.slice(first.index + first[0].length);
    const postDoorplateRemainder = remainder;
    if (doorMatches.length > 1 || onlyFloorAnnotations(postDoorplateRemainder)) {
      return [normalizeAddressText(key)];
    }
    return [normalizeAddressText(compact)];
  }
  const withoutFloor = compact.replace(
    /(?<=號)(?:\((?:地下)?b?(?:\d+|[零〇一二三四五六七八九十]+)(?:樓|層|f|floor)\)|(?:地下)?b?(?:\d+|[零〇一二三四五六七八九十]+)(?:樓|層|f|floor))$/u,
    '',
  );
  const listedDoorNumbers = withoutFloor.match(/^(.*?)(\d+(?:[、,，及和與]\d+)+)號$/u);
  const addressVariants = listedDoorNumbers
    ? listedDoorNumbers[2].split(/[、,，及和與]/u).map((number) => `${listedDoorNumbers[1]}${number}號`)
    : [withoutFloor];
  return [...new Set(addressVariants.map(normalizeAddressText).filter(Boolean))];
}

/** Return the exact first doorplate identity, preserving any numbered subdoorplate. */
export function normalizeAddressDoorplateIdentity(value) {
  const compact = compactAddressForBuildingMatch(value);
  if (!compact) return null;
  const number = '[0-9零〇兩两一二三四五六七八九十百o]+';
  const doorNumber = `${number}(?:(?:之|-)+${number})?`;
  const match = new RegExp(`(${doorNumber})號`, 'u').exec(compact);
  if (!match) return null;
  return normalizeAddressText(`${compact.slice(0, match.index)}${match[1].replaceAll('-', '之')}號`);
}

/** Inverse TWD97/TM2 (EPSG:3825 or EPSG:3826) to WGS84 lon/lat. */
export function projectTwd97Tm2ToWgs84(easting, northing, centralMeridian = 121) {
  if (![easting, northing].every(Number.isFinite) || ![119, 121].includes(centralMeridian)) {
    throw new TypeError('TWD97/TM2 coordinate is invalid');
  }
  const { semiMajor: a, inverseFlattening, scale, falseEasting } = GEODETIC;
  const flattening = 1 / inverseFlattening;
  const eccentricitySquared = 2 * flattening - flattening * flattening;
  const secondEccentricitySquared = eccentricitySquared / (1 - eccentricitySquared);
  const meridionalArc = northing / scale;
  const mu = meridionalArc / (a * (
    1 - eccentricitySquared / 4 - 3 * eccentricitySquared ** 2 / 64
      - 5 * eccentricitySquared ** 3 / 256
  ));
  const e1 = (1 - Math.sqrt(1 - eccentricitySquared)) / (1 + Math.sqrt(1 - eccentricitySquared));
  const footpoint = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinFootpoint = Math.sin(footpoint);
  const cosFootpoint = Math.cos(footpoint);
  const tanFootpoint = Math.tan(footpoint);
  const curvaturePrime = secondEccentricitySquared * cosFootpoint * cosFootpoint;
  const tangentPrime = tanFootpoint * tanFootpoint;
  const primeVertical = a / Math.sqrt(1 - eccentricitySquared * sinFootpoint * sinFootpoint);
  const meridian = a * (1 - eccentricitySquared)
    / (1 - eccentricitySquared * sinFootpoint * sinFootpoint) ** 1.5;
  const d = (easting - falseEasting) / (primeVertical * scale);
  const latitude = footpoint - (primeVertical * tanFootpoint / meridian) * (
    d * d / 2
      - (5 + 3 * tangentPrime + 10 * curvaturePrime - 4 * curvaturePrime ** 2
        - 9 * secondEccentricitySquared) * d ** 4 / 24
      + (61 + 90 * tangentPrime + 298 * curvaturePrime + 45 * tangentPrime ** 2
        - 252 * secondEccentricitySquared - 3 * curvaturePrime ** 2) * d ** 6 / 720
  );
  const longitude = centralMeridian * Math.PI / 180 + (
    d
      - (1 + 2 * tangentPrime + curvaturePrime) * d ** 3 / 6
      + (5 - 2 * curvaturePrime + 28 * tangentPrime - 3 * curvaturePrime ** 2
        + 8 * secondEccentricitySquared + 24 * tangentPrime ** 2) * d ** 5 / 120
  ) / cosFootpoint;
  return [longitude * 180 / Math.PI, latitude * 180 / Math.PI];
}

const COUNTY_EDGE_LATITUDE_BAND = 0.05;
const compiledCountyBoundaries = new WeakMap();

function compileRing(ring) {
  const latitudeBins = new Map();
  let minLongitude = Infinity;
  let maxLongitude = -Infinity;
  let minLatitude = Infinity;
  let maxLatitude = -Infinity;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const left = ring[previous];
    const right = ring[current];
    const edge = [left[0], left[1], right[0], right[1]];
    minLongitude = Math.min(minLongitude, left[0], right[0]);
    maxLongitude = Math.max(maxLongitude, left[0], right[0]);
    minLatitude = Math.min(minLatitude, left[1], right[1]);
    maxLatitude = Math.max(maxLatitude, left[1], right[1]);
    const firstBand = Math.floor(Math.min(left[1], right[1]) / COUNTY_EDGE_LATITUDE_BAND);
    const lastBand = Math.floor(Math.max(left[1], right[1]) / COUNTY_EDGE_LATITUDE_BAND);
    for (let band = firstBand; band <= lastBand; band += 1) {
      const edges = latitudeBins.get(band) ?? [];
      edges.push(edge);
      latitudeBins.set(band, edges);
    }
  }
  return { latitudeBins, minLongitude, maxLongitude, minLatitude, maxLatitude };
}

function pointInCompiledRing(point, ring) {
  const [x, y] = point;
  if (x < ring.minLongitude || x > ring.maxLongitude || y < ring.minLatitude || y > ring.maxLatitude) return false;
  const edges = ring.latitudeBins.get(Math.floor(y / COUNTY_EDGE_LATITUDE_BAND)) ?? [];
  let inside = false;
  for (const [xi, yi, xj, yj] of edges) {
    const crosses = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function compilePolygon(rings) {
  return rings.map(compileRing);
}

function pointInCompiledPolygon(point, rings) {
  return rings.length > 0 && pointInCompiledRing(point, rings[0])
    && !rings.slice(1).some((ring) => pointInCompiledRing(point, ring));
}

function compileBoundary(geometry) {
  if (geometry?.type === 'Feature') return compileBoundary(geometry.geometry);
  if (geometry?.type === 'Polygon') return { type: 'Polygon', polygons: [compilePolygon(geometry.coordinates)] };
  if (geometry?.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', polygons: geometry.coordinates.map(compilePolygon) };
  }
  throw new TypeError('county boundary must be a Polygon or MultiPolygon');
}

function geometryContainsPoint(geometry, point) {
  let compiled = compiledCountyBoundaries.get(geometry);
  if (!compiled) {
    compiled = compileBoundary(geometry);
    compiledCountyBoundaries.set(geometry, compiled);
  }
  return compiled.polygons.some((polygon) => pointInCompiledPolygon(point, polygon));
}

function inTaiwan(point) {
  return point[0] >= TAIWAN_LONGITUDE[0] && point[0] <= TAIWAN_LONGITUDE[1]
    && point[1] >= TAIWAN_LATITUDE[0] && point[1] <= TAIWAN_LATITUDE[1];
}

/** Infer only among documented Taiwan WGS84 and TWD97/TM2 coordinate forms. */
export function inferAddressCoordinateSystem(samples, countyBoundary) {
  if (!Array.isArray(samples) || samples.length < 1) throw new TypeError('coordinate samples are required');
  const valid = samples.filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
  if (valid.length !== samples.length) throw new TypeError('coordinate samples contain invalid values');

  if (valid.every((row) => inTaiwan([row.x, row.y]))) {
    const inside = valid.filter((row) => geometryContainsPoint(countyBoundary, [row.x, row.y])).length;
    if (inside / valid.length >= 0.9) return 'EPSG:4326';
  }

  const candidates = [119, 121].map((centralMeridian) => {
    const inside = valid.filter((row) => geometryContainsPoint(
      countyBoundary,
      projectTwd97Tm2ToWgs84(row.x, row.y, centralMeridian),
    )).length;
    return { centralMeridian, ratio: inside / valid.length };
  }).sort((left, right) => right.ratio - left.ratio);
  const [best, next] = candidates;
  if (best.ratio < 0.9 || best.ratio - next.ratio < 0.2) {
    throw new TypeError('address coordinate system cannot be identified from county-boundary checks');
  }
  return `EPSG:${best.centralMeridian === 121 ? '3826' : '3825'}`;
}

function fieldValue(row, field) {
  const value = field ? row[field] : null;
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Resolve source variants of an official town code against the area catalog. */
export function canonicalTownCode(sourceCode, townNamesByCode = {}) {
  const normalized = String(sourceCode ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\.0+$/u, '');
  if (!normalized) return null;
  const candidates = new Set([normalized]);
  if (/^\d+$/u.test(normalized)) {
    candidates.add(normalized.padStart(8, '0'));
    candidates.add(normalized.padEnd(8, '0'));
    candidates.add(`${normalized.replace(/^0+(?=\d)/u, '').padStart(7, '0')}0`);
  }
  return [...candidates].find((candidate) => Object.hasOwn(townNamesByCode, candidate)) ?? null;
}

function coordinateValue(row, field) {
  const value = fieldValue(row, field);
  if (value === '') return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formattedAddress(row, fields, countyName, townNamesByCode, { townCodeResolver, coordinate, countyCode } = {}) {
  const sourceTownCode = fieldValue(row, fields.townCode);
  const townCode = canonicalTownCode(sourceTownCode, townNamesByCode)
    ?? townCodeResolver?.(sourceTownCode, coordinate, countyCode)
    ?? sourceTownCode;
  const town = townNamesByCode[townCode] ?? fieldValue(row, fields.townName);
  const suppliedAddress = normalizeOfficialDoorplateMarker(fieldValue(row, fields.fullAddress));
  if (suppliedAddress) {
    const countyPrefix = normalizeAddressText(countyName);
    const townPrefix = normalizeAddressText(town);
    const suppliedKey = normalizeAddressText(suppliedAddress);
    let address = suppliedAddress;
    if (!suppliedKey.startsWith(countyPrefix)) {
      address = townPrefix && suppliedKey.startsWith(townPrefix)
        ? `${countyName}${suppliedAddress}`
        : `${countyName}${town}${suppliedAddress}`;
    } else if (townPrefix && !suppliedKey.slice(countyPrefix.length).startsWith(townPrefix)) {
      address = `${countyName}${town}${suppliedAddress.slice(countyName.length)}`;
    }
    const aliases = [...new Set([
      suppliedAddress,
      suppliedKey.startsWith(countyPrefix) ? suppliedAddress.slice(countyName.length) : '',
    ].filter((value) => value !== '' && normalizeAddressText(value) !== normalizeAddressText(address)))];
    return { address, aliases, town, townCode };
  }
  const number = normalizeOfficialDoorplateMarker(fieldValue(row, fields.number));
  const tail = [
    fieldValue(row, fields.village),
    fieldValue(row, fields.street),
    fieldValue(row, fields.area),
    fieldValue(row, fields.lane),
    fieldValue(row, fields.alley),
    number,
  ].filter(Boolean);
  const noVillage = [
    fieldValue(row, fields.street), fieldValue(row, fields.area),
    fieldValue(row, fields.lane), fieldValue(row, fields.alley),
    number,
  ].filter(Boolean);
  const streetAndNumber = [
    fieldValue(row, fields.street),
    fieldValue(row, fields.area),
    fieldValue(row, fields.lane),
    fieldValue(row, fields.alley),
    number,
  ].filter(Boolean);
  const address = [countyName, town, ...tail].join('');
  const aliases = [...new Set([
    [countyName, town, ...noVillage].join(''),
    [town, ...noVillage].join(''),
    streetAndNumber.join(''),
  ].filter((value) => value !== '' && value !== address))];
  return { address, aliases, town, townCode };
}

function coordinateForRow(row, fields, coordinateSystem) {
  const xField = coordinateSystem === 'EPSG:4326'
    ? fields.longitude ?? fields.x
    : fields.x;
  const yField = coordinateSystem === 'EPSG:4326'
    ? fields.latitude ?? fields.y
    : fields.y;
  const x = coordinateValue(row, xField);
  const y = coordinateValue(row, yField);
  if (x === null || y === null) return null;
  if (coordinateSystem === 'EPSG:4326') return [x, y];
  if (coordinateSystem === 'EPSG:3826') return projectTwd97Tm2ToWgs84(x, y, 121);
  if (coordinateSystem === 'EPSG:3825') return projectTwd97Tm2ToWgs84(x, y, 119);
  throw new TypeError(`unsupported address coordinate system: ${coordinateSystem}`);
}

/** Build a county-bounded WGS84 package without assigning uncertain points. */
export function buildCountyAddressPack(rows, {
  countyCode,
  countyName,
  countyBoundary,
  coordinateSystem = 'auto',
  fields,
  sourceCountyCodes = [countyCode],
  sourceCountyNames = [],
  townNamesByCode = {},
  townCodeResolver,
  sourceVersion,
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError('address rows must be an array');
  if (typeof countyCode !== 'string' || !/^\d{5}$/u.test(countyCode)) {
    throw new TypeError('countyCode must be a five-digit code');
  }
  if (typeof countyName !== 'string' || countyName.length === 0) throw new TypeError('countyName is required');
  if (typeof sourceVersion !== 'string' || sourceVersion.length === 0) throw new TypeError('sourceVersion is required');
  if (!fields || typeof fields !== 'object') throw new TypeError('address source field mapping is required');
  if (coordinateSystem === 'auto') {
    const acceptedCountyCodes = new Set(sourceCountyCodes.map(String));
    const acceptedCountyNames = new Set((sourceCountyNames.length > 0 ? sourceCountyNames : [countyName])
      .map((value) => normalizeAddressText(value)));
    const samples = rows
      .filter((row) => (!fields.countyCode || acceptedCountyCodes.has(fieldValue(row, fields.countyCode)))
        && (!fields.countyName || acceptedCountyNames.has(normalizeAddressText(fieldValue(row, fields.countyName)))))
      .map((row) => ({ x: coordinateValue(row, fields.x), y: coordinateValue(row, fields.y) }))
      .filter((row) => row.x !== null && row.y !== null)
      .slice(0, 5000);
    coordinateSystem = inferAddressCoordinateSystem(samples, countyBoundary);
  }
  if (!['EPSG:4326', 'EPSG:3826', 'EPSG:3825'].includes(coordinateSystem)) {
    throw new TypeError(`unsupported address coordinate system: ${coordinateSystem}`);
  }

  const acceptedCountyCodes = new Set(sourceCountyCodes.map(String));
  const acceptedCountyNames = new Set((sourceCountyNames.length > 0 ? sourceCountyNames : [countyName])
    .map((value) => normalizeAddressText(value)));
  let unlocatedCount = 0;
  let excludedCount = 0;
  let sourceRowIndex = 0;
  const records = [];
  const identities = new Set();
  for (const row of rows) {
    const rowIndex = sourceRowIndex;
    sourceRowIndex += 1;
    if (fields.countyCode && !acceptedCountyCodes.has(fieldValue(row, fields.countyCode))) {
      excludedCount += 1;
      continue;
    }
    if (fields.countyName && !acceptedCountyNames.has(normalizeAddressText(fieldValue(row, fields.countyName)))) {
      excludedCount += 1;
      continue;
    }
    const coordinate = coordinateForRow(row, fields, coordinateSystem);
    const { address, aliases, town, townCode } = formattedAddress(row, fields, countyName, townNamesByCode, {
      townCodeResolver,
      coordinate,
      countyCode,
    });
    const searchKey = normalizeAddressText(address);
    if (!coordinate || searchKey.length === 0) {
      unlocatedCount += 1;
      continue;
    }
    if (!inTaiwan(coordinate)) {
      excludedCount += 1;
      continue;
    }
    const roundedCoordinate = coordinate.map((value) => Number(value.toFixed(6)));
    if (!inTaiwan(roundedCoordinate) || !geometryContainsPoint(countyBoundary, roundedCoordinate)) {
      excludedCount += 1;
      continue;
    }
    const identity = `${searchKey}\u0000${roundedCoordinate[0]}\u0000${roundedCoordinate[1]}`;
    if (identities.has(identity)) {
      excludedCount += 1;
      continue;
    }
    identities.add(identity);
    records.push({
      id: `address:${countyCode}:${rowIndex}`,
      kind: 'address',
      name: address,
      address,
      aliases: aliases.map(normalizeAddressText),
      search_key: searchKey,
      region: `${countyName}${town}`,
      county_code: countyCode,
      town_code: townCode || null,
      coordinate: roundedCoordinate,
    });
  }
  const locatedCount = records.length;
  return {
    schema_version: 'address-pack-v1',
    county_code: countyCode,
    county_name: countyName,
    source_version: sourceVersion,
    coordinate_system: coordinateSystem,
    coordinate_order: 'longitude,latitude',
    records,
    summary: {
      source_count: rows.length,
      located_count: locatedCount,
      unlocated_count: unlocatedCount,
      excluded_count: excludedCount,
      coverage_status: unlocatedCount === 0 && excludedCount === 0 ? 'complete' : 'partial',
    },
  };
}

async function gzipAddressPackStream(pack) {
  const chunks = [];
  async function* jsonChunks() {
    const header = {
      ...Object.fromEntries(Object.entries(pack).filter(([key, value]) => key !== 'records' && value !== undefined)),
      schema_version: 'address-pack-ndjson-v1',
    };
    yield `${JSON.stringify(header)}\n`;
    for (const record of pack.records) {
      yield `${JSON.stringify(record)}\n`;
    }
  }
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(
    Readable.from(jsonChunks()),
    createGzip({ level: 9, mtime: 0 }),
    sink,
  );
  return Buffer.concat(chunks);
}

export async function buildSignedAddressPackArtifact(pack, {
  privateKey,
  signingKeyId,
  sourceUrl,
  sourceSha256,
  licenseUrl = 'https://data.gov.tw/license',
  attribution = '資料來源：政府資料開放平臺及各縣市政府開放資料；依政府資料開放授權條款標示來源。',
  createdAt = new Date().toISOString(),
} = {}) {
  if (!privateKey) throw new TypeError('buildSignedAddressPackArtifact requires a private key');
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) {
    throw new TypeError('signingKeyId is invalid');
  }
  if (typeof sourceUrl !== 'string' || !/^https:\/\//u.test(sourceUrl)) throw new TypeError('sourceUrl must be HTTPS');
  if (sourceSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(sourceSha256)) {
    throw new TypeError('sourceSha256 must be a prefixed SHA-256 digest');
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new TypeError('createdAt is invalid');
  if (pack?.schema_version !== 'address-pack-v1' || !Array.isArray(pack.records) || !pack.summary) {
    throw new TypeError('address pack does not satisfy address-pack-v1');
  }
  const data = await gzipAddressPackStream(pack);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const summary = pack.summary;
  const unsignedManifest = {
    schema_version: 'address-pack-manifest-v1',
    county_code: pack.county_code,
    county_name: pack.county_name,
    source_version: pack.source_version,
    source_url: sourceUrl,
    source_sha256: sourceSha256 ?? null,
    license_url: licenseUrl,
    attribution,
    coordinate_system: pack.coordinate_system,
    coordinate_order: pack.coordinate_order,
    coverage_status: summary.coverage_status,
    source_count: summary.source_count,
    located_count: summary.located_count,
    unlocated_count: summary.unlocated_count,
    excluded_count: summary.excluded_count,
    data_file: `address-${pack.county_code}-${sha256.slice(0, 16)}.ndjson.gz`,
    data_format: 'application/x-ndjson',
    size_bytes: data.byteLength,
    sha256: `sha256:${sha256}`,
    created_at: createdAt,
    signature_algorithm: 'Ed25519',
    signing_key_id: signingKeyId,
  };
  const manifest = {
    ...unsignedManifest,
    signature: signCanonical(unsignedManifest, privateKey),
  };
  const manifestDigest = createHash('sha256')
    .update(canonicalize(manifest), 'utf8')
    .digest('hex');
  return {
    data,
    sha256,
    dataFile: unsignedManifest.data_file,
    manifest,
    manifestFile: `manifest-${pack.county_code}-${manifestDigest.slice(0, 16)}.json`,
    manifestSha256: `sha256:${manifestDigest}`,
  };
}

/** Build a signed 22-county discovery document; unavailable counties stay explicit. */
export function buildSignedAddressPackCatalog(counties, {
  privateKey,
  signingKeyId,
  createdAt = new Date().toISOString(),
  attribution = '門牌資料來源：各縣市政府與政府資料開放平臺；依政府資料開放授權條款標示來源。',
} = {}) {
  if (!privateKey) throw new TypeError('buildSignedAddressPackCatalog requires a private key');
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) {
    throw new TypeError('signingKeyId is invalid');
  }
  if (!Array.isArray(counties) || counties.length === 0) throw new TypeError('catalog counties are required');
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new TypeError('createdAt is invalid');
  const seen = new Set();
  const normalized = counties.map((county) => {
    if (!/^\d{5}$/u.test(county?.county_code ?? '') || typeof county.county_name !== 'string') {
      throw new TypeError('catalog county identity is invalid');
    }
    if (seen.has(county.county_code)) throw new TypeError(`duplicate address catalog county: ${county.county_code}`);
    seen.add(county.county_code);
    if (!['complete', 'partial', 'unavailable'].includes(county.coverage_status)) {
      throw new TypeError(`invalid address coverage status for ${county.county_code}`);
    }
    const available = county.coverage_status !== 'unavailable';
    if (available && (
      typeof county.manifest_url !== 'string' || !county.manifest_url.startsWith('/address-packs/')
      || !/^sha256:[a-f0-9]{64}$/u.test(county.manifest_sha256 ?? '')
    )) {
      throw new TypeError(`available county ${county.county_code} requires a pinned signed manifest`);
    }
    if (!available && (county.manifest_url != null || county.manifest_sha256 != null)) {
      throw new TypeError(`unavailable county ${county.county_code} cannot advertise a pack`);
    }
    return {
      county_code: county.county_code,
      county_name: county.county_name,
      coverage_status: county.coverage_status,
      source_name: county.source_name ?? null,
      source_version: county.source_version ?? null,
      source_url: county.source_url ?? null,
      license_url: county.license_url ?? null,
      coordinate_system: county.coordinate_system ?? null,
      source_count: county.source_count ?? null,
      located_count: county.located_count ?? null,
      unlocated_count: county.unlocated_count ?? null,
      excluded_count: county.excluded_count ?? null,
      manifest_url: county.manifest_url ?? null,
      manifest_sha256: county.manifest_sha256 ?? null,
    };
  }).sort((left, right) => left.county_code.localeCompare(right.county_code));

  const unsigned = {
    schema_version: 'address-pack-catalog-v1',
    created_at: createdAt,
    attribution,
    signature_algorithm: 'Ed25519',
    signing_key_id: signingKeyId,
    counties: normalized,
  };
  return { ...unsigned, signature: signCanonical(unsigned, privateKey) };
}
