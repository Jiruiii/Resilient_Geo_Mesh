import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE_HREF = "/Resilient_Geo_Mesh/"


class ShowcasePagesTests(unittest.TestCase):
    def test_pages_builder_accepts_the_current_repository_base_href(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            build = Path(temp_dir)
            (build / "index.html").write_text(
                f'<html><head><base href="{BASE_HREF}"></head><body></body></html>'
            )
            (build / "flutter_bootstrap.js").write_text("window.flutter = {};")
            for tone in ("light", "dark"):
                style_path = (
                    build / "assets/assets/map/styles" / f"showcase-{tone}.json"
                )
                style_path.parent.mkdir(parents=True, exist_ok=True)
                style_path.write_text(
                    json.dumps(
                        {
                            "sources": {
                                "taiwan-overview": {},
                                "taiwan-north": {},
                            }
                        }
                    )
                )
            scenario = build / "assets/assets/data/showcase/scenario.json"
            scenario.parent.mkdir(parents=True, exist_ok=True)
            scenario.write_text("{}")

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools/showcase/prepare_pages.py"),
                    str(build),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_workflow_builds_assets_under_the_current_repository_path(self):
        workflow = (ROOT / ".github/workflows/pages-showcase.yml").read_text()
        self.assertIn(f"--base-href {BASE_HREF}", workflow)

    def test_pages_attribution_targets_the_current_repository_path(self):
        index = (ROOT / "flutter/web/index.html").read_text()
        self.assertIn("location.pathname === '/Resilient_Geo_Mesh'", index)
        self.assertIn(
            "location.pathname.startsWith('/Resilient_Geo_Mesh/')", index
        )


if __name__ == "__main__":
    unittest.main()
