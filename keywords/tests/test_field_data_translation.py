import copy
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
KEYWORDS_DIR = REPO_ROOT / "keywords"

sys.path.insert(0, str(KEYWORDS_DIR))

from validate_field_data_translation import compare_field_data_structure, sync_translation_data  # noqa: E402


def sample_field_data():
    return {
        "MAT_001": {
            "c": [
                [
                    {
                        "n": "MID",
                        "p": 0,
                        "w": 10,
                        "h": "Material ID",
                        "t": "integer",
                        "d": 0,
                        "e": ["0", "1"],
                    }
                ]
            ],
            "o": [
                {
                    "n": "TITLE",
                    "co": "pre/1",
                    "to": 1,
                    "c": [[{"n": "TITLE", "p": 0, "w": 80, "h": "Additional title line", "t": "string"}]],
                }
            ],
            "v": {"MAT_001_TITLE": {"active": ["TITLE"]}},
        },
        "SET_NODE": {
            "x": "SET_NODE_LIST",
            "c": [[{"n": "SID", "p": 0, "w": 10, "h": "Set ID", "t": "integer"}]],
        },
    }


class FieldDataTranslationTest(unittest.TestCase):
    def test_structure_allows_help_text_translation(self):
        english = sample_field_data()
        localized = copy.deepcopy(english)
        localized["MAT_001"]["c"][0][0]["h"] = "translated material id"
        localized["MAT_001"]["o"][0]["c"][0][0]["h"] = "translated title"

        errors = compare_field_data_structure(english, localized)

        self.assertEqual([], errors)

    def test_structure_reports_missing_keys_and_field_shape_changes(self):
        english = sample_field_data()
        localized = copy.deepcopy(english)
        del localized["SET_NODE"]
        del localized["MAT_001"]["c"][0][0]["d"]

        errors = compare_field_data_structure(english, localized)

        self.assertTrue(any("missing localized keyword: SET_NODE" in error for error in errors))
        self.assertTrue(any("MAT_001.c[0][0].d" in error for error in errors))

    def test_sync_preserves_existing_help_and_copies_missing_structure(self):
        english = sample_field_data()
        localized = {
            "MAT_001": {
                "c": [[{"n": "MID", "p": 0, "w": 10, "h": "translated material id", "t": "integer"}]],
            }
        }

        synced = sync_translation_data(english, localized)

        self.assertEqual("translated material id", synced["MAT_001"]["c"][0][0]["h"])
        self.assertEqual(0, synced["MAT_001"]["c"][0][0]["d"])
        self.assertIn("SET_NODE", synced)
        self.assertEqual([], compare_field_data_structure(english, synced))


if __name__ == "__main__":
    unittest.main()
