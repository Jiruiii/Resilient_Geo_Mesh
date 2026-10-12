/**
 * Shared by crowd reports and rescue requests. Pure module with no imports so
 * the event contract can depend on it without an import cycle.
 */

export const CROWD_LOCATION_SOURCES = Object.freeze(['CURRENT_LOCATION', 'MAP_PICK']);
export const CROWD_HINT_KINDS = Object.freeze(['COUNTY', 'DISTRICT', 'VILLAGE', 'ROAD', 'FACILITY']);
export const CROWD_HINT_PRECISIONS = Object.freeze(['AREA', 'ROAD', 'POINT']);
export const CROWD_HINT_TEXT_MAX_CODE_POINTS = 80;

/**
 * Taiwan including Penghu, Kinmen, Matsu, Green/Orchid Island and Pratas.
 * Reports outside it are rejected rather than relayed.
 */
export const TAIWAN_REPORT_BOUNDS = Object.freeze([116.5, 20.5, 122.5, 26.8]);

export function roundCoordinate(value) {
  return Number(value.toFixed(6));
}

export function isoSeconds(date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export function locationHintErrors(hint) {
  if (hint === undefined || hint === null) return [];
  if (typeof hint !== 'object' || Array.isArray(hint)) return ['location_hint must be an object'];
  const errors = [];
  if (hint.method !== 'ADDRESS') errors.push('location_hint.method must be ADDRESS');
  if (!CROWD_HINT_KINDS.includes(hint.kind)) errors.push('location_hint.kind is invalid');
  if (!CROWD_HINT_PRECISIONS.includes(hint.precision)) errors.push('location_hint.precision is invalid');
  for (const field of ['query', 'label']) {
    const value = hint[field];
    if (typeof value !== 'string' || [...value].length > CROWD_HINT_TEXT_MAX_CODE_POINTS) {
      errors.push(`location_hint.${field} must be a string of at most ${CROWD_HINT_TEXT_MAX_CODE_POINTS} characters`);
    }
  }
  return errors;
}

export function coordinateErrors(lon, lat) {
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return ['location must be finite numbers'];
  }
  const [minLon, minLat, maxLon, maxLat] = TAIWAN_REPORT_BOUNDS;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return ['location is outside the supported area'];
  return [];
}
