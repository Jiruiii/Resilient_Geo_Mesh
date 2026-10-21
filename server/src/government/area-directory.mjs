import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DIRECTORY_FILENAME = 'administrative-area-directory.json';
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COUNTY_ID_PATTERN = /^tw\.\d{5}$/u;
const TOWN_ID_PATTERN = /^tw\.\d{8}$/u;

function parseDirectory(input) {
  if (!input || input.schema_version !== 'taiwan-area-directory-v1' || input.coverage !== 'TW'
    || input.target_coordinate_system !== 'EPSG:4326' || !HASH_PATTERN.test(input.source_version ?? '')
    || !Array.isArray(input.areas) || input.area_count !== input.areas.length) {
    throw new TypeError('directory metadata is invalid');
  }

  const areas = new Map();
  for (const area of input.areas) {
    if (!area || typeof area !== 'object' || typeof area.area_id !== 'string'
      || typeof area.county_name !== 'string' || !area.county_name.trim() || areas.has(area.area_id)) {
      throw new TypeError('directory area entry is invalid');
    }
    if (area.level === 'county') {
      if (!COUNTY_ID_PATTERN.test(area.area_id) || area.parent_area_id !== null || area.town_name !== null) {
        throw new TypeError('directory county entry is invalid');
      }
    } else if (area.level === 'town') {
      if (!TOWN_ID_PATTERN.test(area.area_id) || !COUNTY_ID_PATTERN.test(area.parent_area_id ?? '')
        || area.area_id.slice(3, 8) !== area.parent_area_id.slice(3)
        || typeof area.town_name !== 'string' || !area.town_name.trim()) {
        throw new TypeError('directory town entry is invalid');
      }
    } else {
      throw new TypeError('directory area level is invalid');
    }
    areas.set(area.area_id, area);
  }

  const counties = [...areas.values()].filter((area) => area.level === 'county');
  const towns = [...areas.values()].filter((area) => area.level === 'town');
  if (areas.size !== 390 || counties.length !== 22 || towns.length !== 368
    || towns.some((town) => areas.get(town.parent_area_id)?.level !== 'county'
      || areas.get(town.parent_area_id)?.county_name !== town.county_name)) {
    throw new TypeError('directory coverage or parent links are invalid');
  }
  return areas;
}

/** Loads and validates the compact signed-ID catalog next to the configured catalog path. */
export async function loadGovernmentAreaDirectory(areaCatalogPath) {
  if (typeof areaCatalogPath !== 'string' || !path.isAbsolute(areaCatalogPath)) {
    throw new TypeError('AREA_CATALOG_PATH must be an absolute path');
  }
  const directoryPath = path.join(path.dirname(areaCatalogPath), DIRECTORY_FILENAME);
  try {
    const raw = await readFile(directoryPath, 'utf8');
    return parseDirectory(JSON.parse(raw));
  } catch (error) {
    throw new TypeError(`government administrative area directory is missing or invalid: ${directoryPath}`, { cause: error });
  }
}
