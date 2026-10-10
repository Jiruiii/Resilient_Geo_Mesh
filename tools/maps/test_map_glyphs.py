"""Verify actual glyph bitmaps, not merely the existence of .pbf files."""
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "flutter/assets/map/fonts/NotoSansRegular"


def fields(data):
    position = 0

    def varint():
        nonlocal position
        value = shift = 0
        while True:
            byte = data[position]
            position += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
            shift += 7

    while position < len(data):
        tag = varint()
        wire = tag & 7
        if wire == 0:
            value = varint()
        elif wire == 2:
            length = varint()
            value = data[position:position + length]
            position += length
        else:
            raise ValueError(f"Unexpected glyph protobuf wire type {wire}")
        yield tag >> 3, value


def glyphs(data):
    result = {}
    for field, stack in fields(data):
        if field != 1:
            continue
        for field, glyph in fields(stack):
            if field == 3:
                props = dict(fields(glyph))
                if {1, 3, 4, 5, 6, 7} <= props.keys():
                    result[props[1]] = props
    return result


class MapGlyphTest(unittest.TestCase):
    def test_pinned_files_match_checksums(self):
        metadata = json.loads((FONTS / "metadata.json").read_text("utf8"))
        self.assertEqual(len(metadata["files"]), 257)
        for name, expected in metadata["files"].items():
            data = (FONTS / name).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), expected["sha256"], name)

    def test_taiwan_labels_have_real_offline_bitmaps(self):
        labels = json.loads((ROOT / "flutter/assets/map/labels/taiwan-reference-labels.geojson").read_text("utf8"))
        names = "".join(f["properties"].get("name", "") for f in labels["features"])
        names += "臺北市新北市金門連江澎湖蘭嶼綠島琉球信義路忠孝東路一二三四五六七八九十段123ABC"
        cache = {}
        missing = []
        for char in sorted(set(names)):
            if char.isspace():
                continue
            code = ord(char)
            # These archives cover Unicode BMP. Supplementary-plane names
            # (four reference features) remain source text; do not silently
            # replace official place names with a different character.
            if code > 0xFFFF:
                continue
            start = code // 256 * 256
            if start not in cache:
                cache[start] = glyphs((FONTS / f"{start}-{start+255}.pbf").read_bytes())
            glyph = cache[start].get(code)
            if not glyph or not glyph.get(2):
                missing.append(char)
                continue
            self.assertEqual(len(glyph[2]), (glyph[3] + 6) * (glyph[4] + 6), char)
        self.assertEqual(missing, [], f"Missing actual glyphs: {''.join(missing)}")


if __name__ == "__main__":
    unittest.main()
