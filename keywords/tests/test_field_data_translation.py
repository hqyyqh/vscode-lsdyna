import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
KEYWORDS_DIR = REPO_ROOT / "keywords"

sys.path.insert(0, str(KEYWORDS_DIR))

from validate_field_data_translation import (  # noqa: E402
    compare_field_data_structure,
    find_invalid_bilingual_help,
    find_help_text_character_errors,
    find_untranslated_help,
    load_json,
    sync_translation_data,
    sync_translation_file,
)


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
        localized["MAT_001"]["c"][0][0]["h"] = "Material ID\n材料 ID"
        localized["MAT_001"]["o"][0]["c"][0][0]["h"] = "Additional title line\n附加标题行"

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
                "c": [[{"n": "MID", "p": 0, "w": 10, "h": "Material ID\n材料 ID", "t": "integer"}]],
            }
        }

        synced = sync_translation_data(english, localized, english)

        self.assertEqual("Material ID\n材料 ID", synced["MAT_001"]["c"][0][0]["h"])
        self.assertEqual(0, synced["MAT_001"]["c"][0][0]["d"])
        self.assertIn("SET_NODE", synced)
        self.assertEqual([], compare_field_data_structure(english, synced))

    def test_sync_preserves_translation_only_when_previous_english_matches(self):
        previous_english = sample_field_data()
        english = sample_field_data()
        localized = copy.deepcopy(previous_english)
        localized["MAT_001"]["c"][0][0]["h"] = "Material ID\n材料 ID"
        localized["SET_NODE"]["c"][0][0]["h"] = "Set ID\n集合 ID"

        english["MAT_001"]["c"][0][0]["h"] = "Updated material identifier"
        synced = sync_translation_data(english, localized, previous_english)

        self.assertEqual(
            "Updated material identifier",
            synced["MAT_001"]["c"][0][0]["h"],
        )
        self.assertEqual("Set ID\n集合 ID", synced["SET_NODE"]["c"][0][0]["h"])
        self.assertEqual([], compare_field_data_structure(english, synced))

    def test_sync_file_writes_indented_utf8_json(self):
        english = sample_field_data()
        previous_english = sample_field_data()
        localized = copy.deepcopy(previous_english)
        localized["MAT_001"]["c"][0][0]["h"] = "Material ID\n材料 ID"

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            english_path = temporary_path / "field_data.json"
            previous_english_path = temporary_path / "field_data.previous.json"
            localized_path = temporary_path / "field_data_zh.json"
            for path, data in (
                (english_path, english),
                (previous_english_path, previous_english),
                (localized_path, localized),
            ):
                path.write_text(json.dumps(data), encoding="utf-8")

            errors = sync_translation_file(
                english_path,
                localized_path,
                previous_english_path,
            )

            self.assertEqual([], errors)
            written_bytes = localized_path.read_bytes()
            written = written_bytes.decode("utf-8")
            self.assertNotIn(b"\r", written_bytes)
            self.assertIn('\n  "MAT_001":', written)
            self.assertTrue(written.endswith("\n"))

    def test_content_reports_help_without_chinese_text(self):
        english = sample_field_data()
        localized = copy.deepcopy(english)
        localized["MAT_001"]["c"][0][0]["h"] = "Material ID"
        localized["SET_NODE"]["c"][0][0]["h"] = "Set ID\n集合 ID。"

        errors = find_untranslated_help(english, localized)

        self.assertTrue(any("MAT_001.c[0][0].h (MID)" in error for error in errors))
        self.assertFalse(any("SET_NODE.c[0][0].h" in error for error in errors))

    def test_symbol_only_help_is_a_valid_preserved_marker(self):
        english = sample_field_data()
        english["MAT_001"]["c"][0][0]["h"] = "&"
        localized = copy.deepcopy(english)

        self.assertEqual([], find_invalid_bilingual_help(english, localized))
        self.assertFalse(
            any("MAT_001.c[0][0].h" in error for error in find_untranslated_help(english, localized))
        )

    def test_help_character_gate_rejects_unicode_artifacts_and_literal_escapes(self):
        english = sample_field_data()
        localized = copy.deepcopy(english)
        english["MAT_001"]["c"][0][0]["h"] = "Material\ufffd ID\\n"
        localized["MAT_001"]["c"][0][0]["h"] = "Material\ufffd ID\\n\n材料 ID"

        errors = find_help_text_character_errors(english, localized)

        self.assertTrue(any("English help contains forbidden Unicode" in error for error in errors))
        self.assertTrue(any("localized help contains forbidden Unicode" in error for error in errors))
        self.assertTrue(any("literal escape sequences" in error for error in errors))

    def test_bilingual_contract_rejects_chinese_only_and_mismatched_english(self):
        english = sample_field_data()
        localized = copy.deepcopy(english)
        localized["MAT_001"]["c"][0][0]["h"] = "材料 ID"
        localized["SET_NODE"]["c"][0][0]["h"] = "Old set help\n集合 ID"

        errors = find_invalid_bilingual_help(english, localized)

        self.assertTrue(any("MAT_001.c[0][0].h (MID)" in error for error in errors))
        self.assertTrue(any("SET_NODE.c[0][0].h (SID)" in error for error in errors))

    def test_sync_discards_legacy_chinese_only_translation(self):
        english = sample_field_data()
        localized = copy.deepcopy(english)
        localized["MAT_001"]["c"][0][0]["h"] = "材料 ID"

        synced = sync_translation_data(english, localized, english)

        self.assertEqual("Material ID", synced["MAT_001"]["c"][0][0]["h"])

    def test_empty_english_help_rejects_and_discards_stale_localized_help(self):
        previous_english = sample_field_data()
        english = sample_field_data()
        localized = copy.deepcopy(previous_english)
        english["MAT_001"]["c"][0][0]["h"] = ""
        localized["MAT_001"]["c"][0][0]["h"] = "Old material help\n旧材料帮助"

        errors = find_invalid_bilingual_help(english, localized)
        synced = sync_translation_data(english, localized, previous_english)

        self.assertTrue(any("MAT_001.c[0][0].h (MID)" in error for error in errors))
        self.assertEqual("", synced["MAT_001"]["c"][0][0]["h"])

    def test_repository_localized_schema_mirrors_english(self):
        english = load_json(KEYWORDS_DIR / "field_data.json")
        localized = load_json(KEYWORDS_DIR / "field_data_zh.json")

        errors = [
            *compare_field_data_structure(english, localized),
            *find_invalid_bilingual_help(english, localized),
        ]

        self.assertEqual([], errors)


if __name__ == "__main__":
    unittest.main()
