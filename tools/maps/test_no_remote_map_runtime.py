#!/usr/bin/env python3
"""Reject remote map/runtime dependencies in app-owned source files.

This is intentionally narrower than a repository-wide URL audit. Documentation,
build output, package caches, and the vendored MapLibre distribution are not
application runtime wiring and are therefore outside this check.

The single sanctioned online tile host is the NLSC EMAP raster
(wmts.nlsc.gov.tw), injected at runtime by flutter/lib/data/map_basemap.dart
above the offline OSM PMTiles. It is optional: the offline layers always render
underneath, so the map never depends on it. Any other tile host is rejected.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


RUNTIME_PATHS = (
    Path("flutter/lib"),
    Path("flutter/assets/map"),
    Path("flutter/web/index.html"),
    Path("flutter/web/flutter_bootstrap.js"),
    Path("flutter/web/pmtiles.js"),
    Path("flutter/web/pmtiles_protocol.js"),
    Path("flutter/web/fonts"),
    Path("flutter/web/maplibre/6.4.1/metadata.json"),
    Path("flutter/pubspec.yaml"),
)

VENDORED_MAPLIBRE_PREFIX = Path("flutter/web/maplibre/6.4.1/dist")

FORBIDDEN_PATTERNS = (
    re.compile(r"unpkg\.com", re.IGNORECASE),
    re.compile(r"(?:fonts\.)?gstatic\.com", re.IGNORECASE),
    re.compile(r"google_maps_flutter|google_maps_flutter_web", re.IGNORECASE),
    re.compile(
        r"https?://[^\s\"']*(?:tile|tiles)[^\s\"']*"
        r"(?:openstreetmap|osm\.org)",
        re.IGNORECASE,
    ),
    # Any WMTS/tile endpoint other than the optional NLSC EMAP base map.
    re.compile(
        r"https?://(?!wmts\.nlsc\.gov\.tw/)[^\s\"']*(?:/wmts/|\{z\})",
        re.IGNORECASE,
    ),
)


def _is_text_file(path: Path) -> bool:
    return path.suffix.lower() in {
        ".dart",
        ".html",
        ".js",
        ".json",
        ".md",
        ".mjs",
        ".yaml",
        ".yml",
        ".txt",
    }


def _iter_files(root: Path):
    for relative in RUNTIME_PATHS:
        path = root / relative
        if not path.exists():
            continue
        if path.is_file():
            candidates = (path,)
        else:
            candidates = path.rglob("*")
        for candidate in candidates:
            if not candidate.is_file() or not _is_text_file(candidate):
                continue
            relative_candidate = candidate.relative_to(root)
            if relative_candidate.is_relative_to(VENDORED_MAPLIBRE_PREFIX):
                continue
            yield relative_candidate, candidate


def scan(root: Path) -> list[str]:
    findings: list[str] = []
    for relative, path in _iter_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), start=1):
            for pattern in FORBIDDEN_PATTERNS:
                if pattern.search(line):
                    findings.append(
                        f"{relative}:{line_number}: forbidden runtime reference "
                        f"matched {pattern.pattern!r}"
                    )
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root to scan (default: repository containing this tool)",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    findings = scan(root)
    if findings:
        print("Remote map/runtime references found:", file=sys.stderr)
        print("\n".join(findings), file=sys.stderr)
        return 1
    print(f"No forbidden remote map/runtime references under {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
