#!/usr/bin/env python3
"""Keep only high-zoom PMTiles that intersect the Taipei/New Taipei demo."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import zxy_to_tileid
from pmtiles.writer import write


# The regional archive covers much more than the fixed walkthrough needs.
WEST, SOUTH, EAST, NORTH = 121.30, 24.82, 121.85, 25.30


def _tile_limits(zoom: int) -> tuple[int, int, int, int]:
    count = 1 << zoom

    def x(longitude: float) -> int:
        return math.floor((longitude + 180) / 360 * count)

    def y(latitude: float) -> int:
        radians = math.radians(latitude)
        return math.floor((1 - math.asinh(math.tan(radians)) / math.pi) / 2 * count)

    return x(WEST), y(NORTH), x(EAST), y(SOUTH)


def clip(source: Path, destination: Path) -> None:
    if source.resolve() == destination.resolve():
        raise ValueError("Source and destination must differ")
    kept = 0
    with source.open("rb") as stream:
        source_bytes = MmapSource(stream)
        reader = Reader(source_bytes)
        with write(str(destination)) as writer:
            for (zoom, tile_x, tile_y), data in all_tiles(source_bytes):
                if zoom < 13 or zoom > 15:
                    continue
                min_x, min_y, max_x, max_y = _tile_limits(zoom)
                if min_x <= tile_x <= max_x and min_y <= tile_y <= max_y:
                    writer.write_tile(zxy_to_tileid(zoom, tile_x, tile_y), data)
                    kept += 1
            writer.finalize(reader.header(), reader.metadata())
    if kept == 0 or destination.stat().st_size >= source.stat().st_size:
        destination.unlink(missing_ok=True)
        raise ValueError("Clipped archive is empty or not smaller than source")
    print(f"Kept {kept} tiles: {source.stat().st_size} -> {destination.stat().st_size} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    clip(args.source, args.destination)
