// Display-only boundaries. The unsimplified NLSC catalog remains private on
// the server; warning masks do not claim street-level hazard precision.
const METRES_PER_DEGREE = 111195;
const TOLERANCE_METRES = 25;

function segmentError(point, start, end, longitudeScale) {
  const ax = start[0] * longitudeScale;
  const ay = start[1] * METRES_PER_DEGREE;
  const bx = end[0] * longitudeScale;
  const by = end[1] * METRES_PER_DEGREE;
  const px = point[0] * longitudeScale;
  const py = point[1] * METRES_PER_DEGREE;
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const fraction = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return (px - ax - fraction * dx) ** 2 + (py - ay - fraction * dy) ** 2;
}

function simplifyOpen(points, longitudeScale) {
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;
    let candidate = first + 1;
    let error = -1;
    for (let index = first + 1; index < last; index++) {
      const distance = segmentError(points[index], points[first], points[last], longitudeScale);
      if (distance > error) {
        candidate = index;
        error = distance;
      }
    }
    if (error > TOLERANCE_METRES ** 2) {
      keep.add(candidate);
      stack.push([first, candidate], [candidate, last]);
    }
  }
  return [...keep].sort((left, right) => left - right).map((index) => points[index]);
}

function simplifyRing(ring) {
  const first = ring[0];
  const points = ring.at(-1)[0] === first[0] && ring.at(-1)[1] === first[1]
    ? ring.slice(0, -1) : ring;
  if (points.length < 3) return ring;
  const longitudeScale = METRES_PER_DEGREE * Math.cos(first[1] * Math.PI / 180);
  let opposite = 1;
  let farthest = -1;
  for (let index = 1; index < points.length; index++) {
    const distance = (points[index][0] - first[0]) ** 2 + (points[index][1] - first[1]) ** 2;
    if (distance > farthest) {
      farthest = distance;
      opposite = index;
    }
  }
  let simplified = [
    ...simplifyOpen(points.slice(0, opposite + 1), longitudeScale).slice(0, -1),
    ...simplifyOpen([...points.slice(opposite), first], longitudeScale).slice(0, -1),
  ];
  if (simplified.length < 3) {
    let third = -1;
    let error = -1;
    for (let index = 1; index < points.length; index++) {
      if (index === opposite) continue;
      const distance = segmentError(points[index], first, points[opposite], longitudeScale);
      if (distance > error) {
        error = distance;
        third = index;
      }
    }
    simplified = [first, points[third], points[opposite]];
  }
  const rounded = simplified.map(([longitude, latitude]) => [
    Number(longitude.toFixed(6)), Number(latitude.toFixed(6)),
  ]).filter((point, index, list) => index === 0 ||
    point[0] !== list[index - 1][0] || point[1] !== list[index - 1][1]);
  if (rounded.length < 3) return ring;
  return [...rounded, rounded[0]];
}

export function simplifyDisplayGeometry(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const simplified = polygons.map((rings) => rings.map(simplifyRing));
  return {
    type: geometry.type,
    coordinates: geometry.type === 'Polygon' ? simplified[0] : simplified,
  };
}
