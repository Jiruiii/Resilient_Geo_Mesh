#!/usr/bin/env python3
"""Build the small, display-only county mask bundled with Flutter.

The collector keeps the original county boundaries. This output is only a
visual reference for county-level CWA warnings, never an authoritative point
in polygon source.
"""
from __future__ import annotations

import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "data/boundaries/geojson/county.geojson"
OUTPUT = ROOT / "flutter/assets/map/boundaries/cwa-county-warning.geojson"
TOLERANCE_METRES = 25
METRES_PER_DEGREE = 111_195


def _distance_squared(point, start, end, longitude_scale):
    ax, ay = start[0] * longitude_scale, start[1] * METRES_PER_DEGREE
    bx, by = end[0] * longitude_scale, end[1] * METRES_PER_DEGREE
    px, py = point[0] * longitude_scale, point[1] * METRES_PER_DEGREE
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    fraction = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / length_squared)) if length_squared else 0
    return (px - ax - fraction * dx) ** 2 + (py - ay - fraction * dy) ** 2


def _simplify_open(points, longitude_scale):
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last - first < 2:
            continue
        index = max(
            range(first + 1, last),
            key=lambda i: _distance_squared(points[i], points[first], points[last], longitude_scale),
        )
        error = _distance_squared(points[index], points[first], points[last], longitude_scale)
        if error > TOLERANCE_METRES ** 2:
            keep.add(index)
            stack.extend(((first, index), (index, last)))
    return [points[index] for index in sorted(keep)]


def _simplify_ring(ring):
    points = ring[:-1] if ring[0] == ring[-1] else ring
    longitude_scale = METRES_PER_DEGREE * math.cos(math.radians(points[0][1]))
    anchor = points[0]
    opposite = max(
        range(1, len(points)),
        key=lambda i: (points[i][0] - anchor[0]) ** 2 + (points[i][1] - anchor[1]) ** 2,
    )
    simplified = _simplify_open(points[:opposite + 1], longitude_scale)[:-1]
    simplified += _simplify_open(points[opposite:] + [anchor], longitude_scale)[:-1]
    if len(simplified) < 3:
        # Preserve even very small offshore islands as a triangle.
        third = max(
            (point for point in points if point != anchor and point != points[opposite]),
            key=lambda point: _distance_squared(point, anchor, points[opposite], longitude_scale),
        )
        simplified = [anchor, third, points[opposite]]
    rounded = [[round(point[0], 6), round(point[1], 6)] for point in simplified]
    distinct = [rounded[0]]
    for point in rounded[1:]:
        if point != distinct[-1]:
            distinct.append(point)
    if len(distinct) < 3:
        raise ValueError("county boundary ring collapsed after simplification")
    if _signed_area(distinct) * _signed_area(points) < 0:
        distinct.reverse()
    return distinct + [distinct[0]]


def _signed_area(points):
    closed = points + [points[0]]
    return sum(
        start[0] * end[1] - end[0] * start[1]
        for start, end in zip(closed, closed[1:])
    )


def build():
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    features = []
    for feature in source["features"]:
        properties = feature["properties"]
        geometry = feature["geometry"]
        polygons = (
            [geometry["coordinates"]]
            if geometry["type"] == "Polygon"
            else geometry["coordinates"]
        )
        simplified = [[_simplify_ring(ring) for ring in polygon] for polygon in polygons]
        features.append({
            "type": "Feature",
            "properties": {
                "area_id": f"tw.{properties['COUNTYCODE']}",
                "county_name": properties["COUNTYNAME"],
            },
            "geometry": {
                "type": geometry["type"],
                "coordinates": simplified[0] if geometry["type"] == "Polygon" else simplified,
            },
        })
    features.sort(key=lambda feature: feature["properties"]["area_id"])
    if len(features) != 22 or len({feature["properties"]["area_id"] for feature in features}) != 22:
        raise ValueError("expected 22 unique county boundaries")
    output = {"type": "FeatureCollection", "features": features}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()
