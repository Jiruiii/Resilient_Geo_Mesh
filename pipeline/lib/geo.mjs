/**
 * Geometry helpers for area-aware chunking.
 *
 * A bbox is always `[minLon, minLat, maxLon, maxLat]` in WGS84 degrees, matching
 * the `[longitude, latitude]` coordinate order fixed by the v0 data contract.
 * Values are derived from event geometry only, never hand-entered, so a receiver
 * can recompute and verify them.
 */

const BBOX_PRECISION = 6;

function round(value) {
  return Number(value.toFixed(BBOX_PRECISION));
}

function extendFromCoordinates(box, coordinates) {
  if (typeof coordinates[0] === 'number') {
    const [lon, lat] = coordinates;
    if (lon < box[0]) box[0] = lon;
    if (lat < box[1]) box[1] = lat;
    if (lon > box[2]) box[2] = lon;
    if (lat > box[3]) box[3] = lat;
    return;
  }
  for (const child of coordinates) extendFromCoordinates(box, child);
}

function extendFromGeometry(box, geometry) {
  if (!geometry || typeof geometry.type !== 'string') {
    throw new TypeError('cannot compute a bbox for a non-geometry value');
  }
  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries) || geometry.geometries.length === 0) {
      throw new TypeError('GeometryCollection needs a non-empty geometries array');
    }
    for (const child of geometry.geometries) extendFromGeometry(box, child);
    return;
  }
  if (!Array.isArray(geometry.coordinates)) {
    throw new TypeError(`geometry ${geometry.type} needs a coordinates array`);
  }
  extendFromCoordinates(box, geometry.coordinates);
}

export function bboxOfGeometry(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  extendFromGeometry(box, geometry);
  if (!box.every(Number.isFinite)) throw new TypeError('geometry produced an empty bbox');
  return box.map(round);
}

export function bboxOfEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError('bboxOfEvents requires a non-empty events array');
  }
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const event of events) extendFromGeometry(box, event.geometry);
  if (!box.every(Number.isFinite)) throw new TypeError('events produced an empty bbox');
  return box.map(round);
}

export function bboxContains(outer, inner) {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3]
  );
}

export function bboxIntersects(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

const GEOMETRY_TYPES = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
]);

export class GeoValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'GeoValidationError';
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeCoordinate(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2 || coordinate.length > 3) {
    throw new GeoValidationError('coordinate must contain longitude, latitude, and optional altitude');
  }
  if (!isFiniteNumber(coordinate[0]) || coordinate[0] < -180 || coordinate[0] > 180) {
    throw new GeoValidationError('longitude must be between -180 and 180');
  }
  if (!isFiniteNumber(coordinate[1]) || coordinate[1] < -90 || coordinate[1] > 90) {
    throw new GeoValidationError('latitude must be between -90 and 90');
  }
  if (coordinate.length === 3 && !isFiniteNumber(coordinate[2])) {
    throw new GeoValidationError('altitude must be a finite number');
  }
  return [...coordinate];
}

function samePosition(left, right) {
  return left.length >= 2 && right.length >= 2 && left[0] === right[0] && left[1] === right[1];
}

function validateLineCoordinates(coordinates, path) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new GeoValidationError(`${path} must contain at least two positions`);
  }
  coordinates.forEach((coordinate, index) => normalizeCoordinate(coordinate, `${path}[${index}]`));
}

function validatePolygonCoordinates(coordinates, path) {
  if (!Array.isArray(coordinates) || coordinates.length < 1) {
    throw new GeoValidationError(`${path} must contain a linear ring`);
  }
  coordinates.forEach((ring, index) => {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new GeoValidationError(`${path}[${index}] must contain at least four positions`);
    }
    ring.forEach((coordinate, coordinateIndex) => normalizeCoordinate(coordinate, `${path}[${index}][${coordinateIndex}]`));
    if (!samePosition(ring[0], ring[ring.length - 1])) {
      throw new GeoValidationError(`${path}[${index}] must be closed`);
    }
  });
}

function validateGeometry(geometry, path = 'geometry') {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) {
    throw new GeoValidationError(`${path} must be a GeoJSON geometry`);
  }
  if (!GEOMETRY_TYPES.has(geometry.type)) {
    throw new GeoValidationError(`${path}.type is not supported`);
  }
  if (geometry.type === 'Point') normalizeCoordinate(geometry.coordinates, `${path}.coordinates`);
  if (geometry.type === 'LineString') validateLineCoordinates(geometry.coordinates, `${path}.coordinates`);
  if (geometry.type === 'Polygon') validatePolygonCoordinates(geometry.coordinates, `${path}.coordinates`);
  if (geometry.type === 'MultiPoint') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 1) {
      throw new GeoValidationError(`${path}.coordinates must not be empty`);
    }
    geometry.coordinates.forEach((coordinate, index) => normalizeCoordinate(coordinate, `${path}.coordinates[${index}]`));
  }
  if (geometry.type === 'MultiLineString') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 1) {
      throw new GeoValidationError(`${path}.coordinates must not be empty`);
    }
    geometry.coordinates.forEach((line, index) => validateLineCoordinates(line, `${path}.coordinates[${index}]`));
  }
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 1) {
      throw new GeoValidationError(`${path}.coordinates must not be empty`);
    }
    geometry.coordinates.forEach((polygon, index) => validatePolygonCoordinates(polygon, `${path}.coordinates[${index}]`));
  }
  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries) || geometry.geometries.length < 1) {
      throw new GeoValidationError(`${path}.geometries must not be empty`);
    }
    geometry.geometries.forEach((child, index) => validateGeometry(child, `${path}.geometries[${index}]`));
  }
}

function asGeometry(value) {
  if (value?.type === 'Feature') return value.geometry;
  if (value?.type === 'FeatureCollection') return value;
  return value;
}

function collectGeometries(value, path = 'boundary') {
  const geometry = asGeometry(value);
  if (geometry?.type === 'FeatureCollection') {
    if (!Array.isArray(geometry.features) || geometry.features.length < 1) {
      throw new GeoValidationError(`${path}.features must not be empty`);
    }
    return geometry.features.flatMap((feature, index) => collectGeometries(feature, `${path}.features[${index}]`));
  }
  validateGeometry(geometry, path);
  return [geometry];
}

function positionsFromGeometry(geometry) {
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(positionsFromGeometry);
  const positions = [];
  function visit(value) {
    if (Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
      positions.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
  }
  visit(geometry.coordinates);
  return positions;
}

function envelope(geometry) {
  const positions = positionsFromGeometry(geometry);
  if (positions.length === 0) throw new GeoValidationError('geometry has no positions');
  // A loop, not Math.min(...spread): a county boundary has far more vertices
  // than a spread argument list can hold.
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of positions) {
    if (x < box.minX) box.minX = x;
    if (y < box.minY) box.minY = y;
    if (x > box.maxX) box.maxX = x;
    if (y > box.maxY) box.maxY = y;
  }
  return box;
}

function envelopesIntersect(left, right) {
  return left.minX <= right.maxX && left.maxX >= right.minX && left.minY <= right.maxY && left.maxY >= right.minY;
}

function pointOnSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-10) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-10
    && point[0] <= Math.max(start[0], end[0]) + 1e-10
    && point[1] >= Math.min(start[1], end[1]) - 1e-10
    && point[1] <= Math.max(start[1], end[1]) + 1e-10;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const prior = ring[previous];
    if (pointOnSegment(point, prior, current)) return true;
    const intersects = ((current[1] > point[1]) !== (prior[1] > point[1]))
      && point[0] < ((prior[0] - current[0]) * (point[1] - current[1])) / (prior[1] - current[1]) + current[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0])) return false;
  return polygon.slice(1).every((hole) => !pointInRing(point, hole));
}

function pointInGeometry(point, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  if (geometry.type === 'GeometryCollection') return geometry.geometries.some((child) => pointInGeometry(point, child));
  return false;
}

/** A point inside the largest land polygon, for locating an area alert on a map. */
export function representativePointInBoundary(boundaryInput) {
  const polygons = collectGeometries(boundaryInput)
    .flatMap((geometry) => geometry.type === 'MultiPolygon'
      ? geometry.coordinates
      : geometry.type === 'Polygon' ? [geometry.coordinates] : [])
    .sort((left, right) => ringArea(right[0]) - ringArea(left[0]));
  for (const polygon of polygons) {
    const box = envelope({ type: 'Polygon', coordinates: polygon });
    const latitude = (box.minY + box.maxY) / 2;
    const center = [(box.minX + box.maxX) / 2, latitude];
    if (pointInPolygon(center, polygon)) return { type: 'Point', coordinates: center };

    const crossings = [];
    const outer = polygon[0];
    for (let index = 1; index < outer.length; index += 1) {
      const start = outer[index - 1];
      const end = outer[index];
      if ((start[1] <= latitude && latitude < end[1])
        || (end[1] <= latitude && latitude < start[1])) {
        crossings.push(start[0] + (latitude - start[1])
          * (end[0] - start[0]) / (end[1] - start[1]));
      }
    }
    crossings.sort((left, right) => left - right);
    const spans = [];
    for (let index = 1; index < crossings.length; index += 2) {
      spans.push([crossings[index - 1], crossings[index]]);
    }
    spans.sort((left, right) => (right[1] - right[0]) - (left[1] - left[0]));
    for (const [left, right] of spans) {
      const point = [(left + right) / 2, latitude];
      if (pointInPolygon(point, polygon)) return { type: 'Point', coordinates: point };
    }
    for (const point of outer) {
      if (pointInPolygon(point, polygon)) {
        return { type: 'Point', coordinates: point.slice(0, 2) };
      }
    }
  }
  throw new GeoValidationError('boundary has no representative point');
}

function ringArea(ring) {
  let twiceArea = 0;
  for (let index = 1; index < ring.length; index += 1) {
    twiceArea += ring[index - 1][0] * ring[index][1]
      - ring[index][0] * ring[index - 1][1];
  }
  return Math.abs(twiceArea);
}

const preparedBoundaryCache = new WeakMap();

/**
 * Validated boundary geometries with their envelopes, computed once per
 * boundary object. Nationwide collection tests thousands of records against
 * the same 390-area catalog; re-validating every polygon vertex for each
 * record made that effectively unbounded. Boundaries are treated as
 * immutable once passed in.
 */
function preparedBoundaries(boundaryInput) {
  const cacheable = boundaryInput !== null && typeof boundaryInput === 'object';
  const cached = cacheable ? preparedBoundaryCache.get(boundaryInput) : undefined;
  if (cached) return cached;
  const prepared = collectGeometries(boundaryInput).map((geometry) => ({ geometry, box: envelope(geometry) }));
  if (cacheable) preparedBoundaryCache.set(boundaryInput, prepared);
  return prepared;
}

export function isGeometryInBoundary(geometryInput, boundaryInput) {
  const geometry = asGeometry(geometryInput);
  validateGeometry(geometry, 'geometry');
  const boundaries = preparedBoundaries(boundaryInput);
  const point = geometry.type === 'Point' ? geometry.coordinates : null;
  if (point) {
    const pointBox = { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] };
    return boundaries.some(({ geometry: boundary, box }) => (
      envelopesIntersect(pointBox, box) && pointInGeometry(point, boundary)
    ));
  }
  const geometryEnvelope = envelope(geometry);
  return boundaries.some(({ box }) => envelopesIntersect(geometryEnvelope, box));
}

export function isGeometryInNeihu(geometryInput, boundaryInput) {
  return isGeometryInBoundary(geometryInput, boundaryInput);
}

export function filterRecordsToBoundary(records, boundary, getGeometry = (record) => record?.geometry) {
  if (!Array.isArray(records)) throw new GeoValidationError('records must be an array');
  return records.filter((record, index) => {
    const geometry = getGeometry(record);
    if (!geometry) throw new GeoValidationError(`record ${index} geometry is required`);
    return isGeometryInBoundary(geometry, boundary);
  });
}

export function filterRecordsToNeihu(records, boundary, getGeometry = (record) => record?.geometry) {
  return filterRecordsToBoundary(records, boundary, getGeometry);
}
