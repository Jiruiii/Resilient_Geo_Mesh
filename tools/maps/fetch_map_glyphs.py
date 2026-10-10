"""Install pinned Noto glyphs, including CJK, for both offline map renderers."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

COMMIT = "601ae60796ceceda2cbd2ed3d2ea92d17a84be4b"
BASE = f"https://raw.githubusercontent.com/maplibre/demotiles/{COMMIT}/font/Noto%20Sans%20Regular/"
DESTINATION = Path(__file__).resolve().parents[2] / "flutter/assets/map/fonts/NotoSansRegular"


def download(name):
    with urllib.request.urlopen(BASE + name, timeout=60) as response:
        data = response.read()
    (DESTINATION / name).write_bytes(data)
    return name, {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


if __name__ == "__main__":
    DESTINATION.mkdir(parents=True, exist_ok=True)
    names = [f"{start}-{start+255}.pbf" for start in range(0, 65536, 256)]
    names.append("LICENSE.md")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        files = dict(pool.map(download, names))
    manifest = {"repository": "https://github.com/maplibre/demotiles",
                "commit": COMMIT, "source_path": "font/Noto Sans Regular",
                "local_alias": "NotoSansRegular", "files": files}
    (DESTINATION / "metadata.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf8")
    print(f"Installed {len(names)-1} glyph ranges, {sum(f['bytes'] for f in files.values())} bytes")
