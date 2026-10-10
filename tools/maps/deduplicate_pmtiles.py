"""Remove duplicate regional tiles without changing a single OSM tile payload.

The overview stays unchanged. Regional precedence is north, central, south,
east; the first archive containing a tile owns it. A union digest verifies
that every original tile is still present exactly once before publishing.
Requires the pinned dependencies in requirements-pmtiles.txt.
"""
import argparse
import hashlib
import json
from pathlib import Path

from pmtiles.reader import Reader, MmapSource, all_tiles
from pmtiles.tile import zxy_to_tileid
from pmtiles.writer import write

REGIONS = ("north", "central", "south", "east")


def deduplicate(source: Path, output: Path):
    if source.resolve() == output.resolve():
        raise ValueError("Use a separate output directory; never overwrite inputs")
    output.mkdir(parents=True, exist_ok=True)
    seen = {}
    report = {}
    for region in REGIONS:
        name = f"taiwan-{region}.pmtiles"
        destination = output / name
        if destination.exists():
            raise FileExistsError(destination)
        total = kept = 0
        with (source / name).open("rb") as stream:
            get_bytes = MmapSource(stream)
            reader = Reader(get_bytes)
            with write(str(destination)) as writer:
                for (z, x, y), data in all_tiles(get_bytes):
                    tile_id = zxy_to_tileid(z, x, y)
                    digest = hashlib.sha256(data).digest()
                    total += 1
                    if tile_id in seen:
                        if seen[tile_id] != digest:
                            raise ValueError(f"Conflicting OSM snapshots at {z}/{x}/{y}")
                        continue
                    seen[tile_id] = digest
                    writer.write_tile(tile_id, data)
                    kept += 1
                writer.finalize(reader.header(), reader.metadata())
        report[name] = {"input_tiles": total, "output_tiles": kept,
                        "bytes": destination.stat().st_size,
                        "sha256": hashlib.file_digest(destination.open("rb"), "sha256").hexdigest()}

    verified = {}
    for region in REGIONS:
        with (output / f"taiwan-{region}.pmtiles").open("rb") as stream:
            for (z, x, y), data in all_tiles(MmapSource(stream)):
                tile_id = zxy_to_tileid(z, x, y)
                if tile_id in verified:
                    raise ValueError(f"Duplicate output tile at {z}/{x}/{y}")
                verified[tile_id] = hashlib.sha256(data).digest()
    if verified != seen:
        raise ValueError("Output tiles differ from the complete input union")
    report["verified_unique_tiles"] = len(verified)
    (output / "verification.json").write_text(json.dumps(report, indent=2), "utf8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(deduplicate(args.source, args.output), indent=2))
