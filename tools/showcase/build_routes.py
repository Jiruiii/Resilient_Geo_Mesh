#!/usr/bin/env python3
"""Build compact, fixed-origin showcase paths from the bundled walking graph."""

import heapq
import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GRAPH_PATH = ROOT / "android/app/src/main/assets/routing/walk-roads.json"
SCENARIO_PATH = ROOT / "flutter/assets/data/showcase/scenario.json"
OUTPUT_PATH = ROOT / "flutter/assets/data/showcase/routes.json"
BLOCKED_WAY_ID = 203384045
START_SNAP_LIMIT_M = 300.0
DESTINATION_SNAP_LIMIT_M = 100.0


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    delta_lon = lon2 - lon1
    delta_lat = lat2 - lat1
    haversine = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(haversine))


def shortest_paths(
    source: int,
    adjacency: list[list[tuple[int, float, int]]],
    blocked_way_id: int | None = None,
) -> tuple[list[float], list[tuple[int, int] | None]]:
    distances = [math.inf] * len(adjacency)
    previous: list[tuple[int, int] | None] = [None] * len(adjacency)
    distances[source] = 0.0
    pending = [(0.0, source)]
    while pending:
        distance, node = heapq.heappop(pending)
        if distance != distances[node]:
            continue
        for neighbor, length, way_id in adjacency[node]:
            if way_id == blocked_way_id:
                continue
            candidate = distance + length
            if candidate >= distances[neighbor]:
                continue
            distances[neighbor] = candidate
            previous[neighbor] = (node, way_id)
            heapq.heappush(pending, (candidate, neighbor))
    return distances, previous


def reconstruct(
    target: int,
    previous: list[tuple[int, int] | None],
) -> tuple[list[int], set[int]]:
    nodes = [target]
    way_ids: set[int] = set()
    node = target
    while previous[node] is not None:
        node, way_id = previous[node]  # type: ignore[misc]
        nodes.append(node)
        way_ids.add(way_id)
    nodes.reverse()
    return nodes, way_ids


def nearest_node(
    point: tuple[float, float], coordinates: list[tuple[float, float]]
) -> tuple[int, float]:
    return min(
        ((index, distance_m(point, coordinate)) for index, coordinate in enumerate(coordinates)),
        key=lambda item: item[1],
    )


def main() -> None:
    graph = json.loads(GRAPH_PATH.read_text())
    scenario = json.loads(SCENARIO_PATH.read_text())
    coordinate_ids: dict[tuple[float, float], int] = {}
    coordinates: list[tuple[float, float]] = []
    ways: list[tuple[int, list[int]]] = []

    def node_for(point: tuple[float, float]) -> int:
        if point not in coordinate_ids:
            coordinate_ids[point] = len(coordinates)
            coordinates.append(point)
        return coordinate_ids[point]

    for way_id, _road_class_index, flat in graph["ways"]:
        way_nodes = [
            node_for((float(lon), float(lat)))
            for lon, lat in zip(flat[::2], flat[1::2])
        ]
        ways.append((int(way_id), way_nodes))

    adjacency: list[list[tuple[int, float, int]]] = [
        [] for _ in range(len(coordinates))
    ]
    for way_id, way_nodes in ways:
        for start, end in zip(way_nodes, way_nodes[1:]):
            if start == end:
                continue
            length = distance_m(coordinates[start], coordinates[end])
            adjacency[start].append((end, length, way_id))
            adjacency[end].append((start, length, way_id))

    origin = tuple(map(float, scenario["origin"]))
    start, start_snap_m = nearest_node(origin, coordinates)
    if start_snap_m > START_SNAP_LIMIT_M:
        raise SystemExit(f"showcase origin is {start_snap_m:.1f} m from the road graph")

    normal_distances, normal_previous = shortest_paths(start, adjacency)
    detour_distances, detour_previous = shortest_paths(
        start, adjacency, BLOCKED_WAY_ID
    )
    routes: dict[str, dict[str, object]] = {}
    for feature in sorted(scenario["features"], key=lambda item: item["id"]):
        if feature["geometry"]["type"] != "Point":
            continue
        destination = tuple(map(float, feature["geometry"]["coordinates"]))
        end, end_snap_m = nearest_node(destination, coordinates)
        if end_snap_m > DESTINATION_SNAP_LIMIT_M or math.isinf(normal_distances[end]):
            continue

        normal_nodes, normal_ways = reconstruct(end, normal_previous)
        route: dict[str, object] = {
            "distance_m": round(
                normal_distances[end] + start_snap_m + end_snap_m, 1
            ),
            "polyline": [
                [lon, lat]
                for lon, lat in [origin, *(coordinates[node] for node in normal_nodes), destination]
            ],
        }
        if BLOCKED_WAY_ID in normal_ways and not math.isinf(detour_distances[end]):
            detour_nodes, _ = reconstruct(end, detour_previous)
            route["detour_distance_m"] = round(
                detour_distances[end] + start_snap_m + end_snap_m, 1
            )
            route["detour_polyline"] = [
                [lon, lat]
                for lon, lat in [origin, *(coordinates[node] for node in detour_nodes), destination]
            ]
        routes[feature["id"]] = route

    asset = {
        "schema_version": "showcase-routes-v1",
        "graph_version": graph["graph_version"],
        "attribution": "© OpenStreetMap contributors",
        "blocked_event_id": "showcase:route-road-closed",
        "blocked_way_id": BLOCKED_WAY_ID,
        "routes": routes,
    }
    OUTPUT_PATH.write_text(
        json.dumps(asset, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    print(f"wrote {len(routes)} routes to {OUTPUT_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
