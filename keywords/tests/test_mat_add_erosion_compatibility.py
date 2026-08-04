from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path


KEYWORDS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KEYWORDS_DIR))

from pydyna_schema_adapter import apply_mat_add_erosion_compatibility_overlay  # noqa: E402
from validate_field_data_translation import (  # noqa: E402
    apply_reviewed_compatibility_localizations,
    find_compatibility_localization_errors,
)


def make_card(names: list[str]) -> list[dict[str, object]]:
    return [
        {
            "n": name,
            "p": index * 10,
            "w": 10,
            "h": "Flag." if index == 0 else ("Regularization curve." if index == 7 else ""),
            "t": "integer",
        }
        for index, name in enumerate(names)
    ]


def make_schema(names: list[str]) -> dict[str, dict[str, object]]:
    return {
        "MAT_ADD_EROSION": {"c": [[], [], make_card(names)]},
        "MAT_ADD_EROSION_TITLE": {
            "x": "MAT_ADD_EROSION",
            "c": [[], [], make_card(names)],
        },
    }


class MatAddErosionCompatibilityTest(unittest.TestCase):
    gap = ["IDAM", *("UNUSED" for _ in range(6)), "LCREGD"]
    restored = [
        "IDAM",
        "DMGTYP",
        "LCSDG",
        "ECRIT",
        "DMGEXP",
        "DCRIT",
        "FADEXP",
        "LCREGD",
    ]

    def test_restores_gap_and_rebuilds_snippets(self) -> None:
        schema = make_schema(self.gap)
        snippets: dict[str, dict[str, object]] = {}

        state = apply_mat_add_erosion_compatibility_overlay(schema, snippets)

        self.assertEqual("compatibility-overlay", state)
        self.assertEqual(self.restored, [field["n"] for field in schema["MAT_ADD_EROSION"]["c"][2]])
        fields = schema["MAT_ADD_EROSION"]["c"][2]
        self.assertEqual("integer", fields[1]["t"])
        self.assertIn("DMGTYP is interpreted digit-wise", fields[1]["h"])
        self.assertTrue(
            any("dmgtyp" in line for line in snippets["*MAT_ADD_EROSION"]["body"])
        )

    def test_preserves_an_upstream_complete_signature(self) -> None:
        schema = make_schema(self.gap)
        snippets: dict[str, dict[str, object]] = {}
        apply_mat_add_erosion_compatibility_overlay(schema, snippets)
        snapshot = copy.deepcopy(schema)

        state = apply_mat_add_erosion_compatibility_overlay(schema, snippets)

        self.assertEqual("upstream-complete", state)
        self.assertEqual(snapshot, schema)

    def test_rejects_an_unknown_upstream_layout(self) -> None:
        schema = make_schema(["IDAM", "NEW_FIELD", *("UNUSED" for _ in range(5)), "LCREGD"])

        with self.assertRaisesRegex(ValueError, "unknown IDAM...LCREGD signature"):
            apply_mat_add_erosion_compatibility_overlay(schema, {})

    def test_applies_reviewed_chinese_help_after_sync(self) -> None:
        english = make_schema(self.gap)
        apply_mat_add_erosion_compatibility_overlay(english, {})
        localized = copy.deepcopy(english)

        changed = apply_reviewed_compatibility_localizations(english, localized)

        self.assertEqual(12, changed)
        help_text = localized["MAT_ADD_EROSION"]["c"][2][1]["h"]
        self.assertIn("DMGTYP is interpreted digit-wise", help_text)
        self.assertIn("DMGTYP 按位解释", help_text)
        self.assertEqual([], find_compatibility_localization_errors(english, localized))

    def test_repository_artifacts_keep_the_legacy_fields(self) -> None:
        repo_root = KEYWORDS_DIR.parent
        english = json.loads((KEYWORDS_DIR / "field_data.json").read_text(encoding="utf-8"))
        localized = json.loads((KEYWORDS_DIR / "field_data_zh.json").read_text(encoding="utf-8"))
        snippets = json.loads((repo_root / "snippets" / "lsdyna.json").read_text(encoding="utf-8"))

        for keyword in ("MAT_ADD_EROSION", "MAT_ADD_EROSION_TITLE"):
            self.assertEqual(self.restored, [field["n"] for field in english[keyword]["c"][2]])
            self.assertEqual(self.restored, [field["n"] for field in localized[keyword]["c"][2]])
            self.assertTrue(any("dmgtyp" in line for line in snippets[f"*{keyword}"]["body"]))
        self.assertEqual([], find_compatibility_localization_errors(english, localized))


if __name__ == "__main__":
    unittest.main()
