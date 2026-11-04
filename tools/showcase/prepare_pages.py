#!/usr/bin/env python3
"""Trim a Flutter Web release into the static, API-free Pages walkthrough."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


EXTRA_SCRIPTS = (
    "nlsc_static_layers.js",
    "nlsc_government_feed.js",
    "rescue_outbox.js",
    "locator_siren.js",
    "government_http.js",
    "government_crowd_signer.js",
)

UNUSED_ASSETS = (
    "assets/assets/map/pmtiles/taiwan-central.pmtiles",
    "assets/assets/map/pmtiles/taiwan-south.pmtiles",
    "assets/assets/map/pmtiles/taiwan-east.pmtiles",
    "assets/assets/map/search/taiwan-roads.json",
    "assets/assets/map/boundaries/taiwan-administrative-area-index.json",
    "assets/assets/data/taiwan/ncdr-hazard-events.json",
)


def prepare(root: Path) -> None:
    index_path = root / "index.html"
    html = index_path.read_text()
    if '<base href="/OSS/">' not in html:
        raise ValueError("Flutter Web must be built with --base-href /OSS/")
    if 'name="viewport"' not in html:
        html = html.replace(
            '<meta charset="UTF-8">',
            '<meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">',
        )
    for script in EXTRA_SCRIPTS:
        html = html.replace(f'  <script src="{script}"></script>\n', "")
        (root / script).unlink(missing_ok=True)
    html, removed = re.subn(
        r"  <script>\s*void \(async \(\) => \{.*?\}\)\(\);\s*</script>\n",
        "",
        html,
        count=1,
        flags=re.DOTALL,
    )
    if removed != 1 and "navigator.serviceWorker" in html:
        raise ValueError("Expected to remove the production service worker prefetch")
    html = html.replace(
        "ResilientGeo 台灣離線地圖 UI 開發入口",
        "ResilientGeo 手機展示，資料為固定模擬情境",
    ).replace(
        "ResilientGeo 台灣離線地圖</title>",
        "ResilientGeo 手機展示</title>",
    )
    index_path.write_text(html)

    bootstrap_path = root / "flutter_bootstrap.js"
    bootstrap = bootstrap_path.read_text()
    bootstrap, removed_worker = re.subn(
        r"\s*serviceWorkerSettings:\s*\{\s*serviceWorkerVersion:\s*[^}]+\},",
        "",
        bootstrap,
        count=1,
    )
    if removed_worker != 1 and "serviceWorkerSettings" in bootstrap:
        raise ValueError("Expected to disable the production service worker")
    bootstrap_path.write_text(bootstrap)

    for relative in UNUSED_ASSETS:
        (root / relative).unlink(missing_ok=True)
    (root / "flutter_service_worker.js").unlink(missing_ok=True)
    (root / ".nojekyll").touch()

    for tone in ("light", "dark"):
        style_path = root / f"assets/assets/map/styles/showcase-{tone}.json"
        style = json.loads(style_path.read_text())
        sources = style["sources"]
        if any(f"taiwan-{region}" in sources for region in ("central", "south", "east")):
            raise ValueError("Showcase style still references omitted regional archives")
        if not {"taiwan-overview", "taiwan-north"}.issubset(sources):
            raise ValueError("Showcase style is missing overview or north detail")

    if any(f'<script src="{script}"' in html for script in EXTRA_SCRIPTS):
        raise ValueError("Production network script remains in showcase index")
    if not (root / "assets/assets/data/showcase/scenario.json").is_file():
        raise ValueError("Showcase scenario asset is missing")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: prepare_pages.py FLUTTER_BUILD_WEB_DIRECTORY")
    prepare(Path(sys.argv[1]))
