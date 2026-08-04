import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path


KEYWORDS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KEYWORDS_DIR))

from audit_field_data_quality import build_report, main  # noqa: E402


def sample(help_text: str) -> dict:
    return {
        "CONTROL_TEST": {
            "c": [[{"n": "OPT", "p": 0, "w": 10, "t": "integer", "h": help_text}]]
        }
    }


class FieldDataQualityAuditTest(unittest.TestCase):
    def test_accepts_clean_bilingual_help_with_protected_tokens(self):
        source = "EQ. 1: Set ID for *CONTROL_TEST."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nEQ. 1：*CONTROL_TEST 的集合 ID。"
        )

        report = build_report(english, localized)

        self.assertEqual("pass", report["quality_gate"]["status"])

    def test_rejects_fallback_markers_residue_and_missing_literals(self):
        source = "EQ. 2: Friction option for *CONTROL_TEST."
        english = sample(source)
        fallback = copy.deepcopy(english)
        fallback_report = build_report(english, fallback)
        self.assertEqual(1, fallback_report["fallback_occurrences"])

        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n字段说明：friction option。"
        )
        report = build_report(english, localized)

        self.assertEqual("fail", report["quality_gate"]["status"])
        self.assertEqual(1, report["mechanical_marker_occurrences"])
        self.assertEqual(1, report["english_residue_occurrences"])
        self.assertGreater(report["protected_token_omissions"], 0)
        self.assertEqual(1, report["terminology_residue_occurrences"])

    def test_cli_returns_nonzero_and_writes_only_when_requested(self):
        source = "Node ID."
        english = sample(source)
        localized = copy.deepcopy(english)
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            english_path = root / "en.json"
            localized_path = root / "zh.json"
            output_path = root / "audit.json"
            english_path.write_text(json.dumps(english), encoding="utf-8")
            localized_path.write_text(json.dumps(localized), encoding="utf-8")

            result = main([
                "--english", str(english_path),
                "--localized", str(localized_path),
            ])
            self.assertEqual(1, result)
            self.assertFalse(output_path.exists())

            result = main([
                "--english", str(english_path),
                "--localized", str(localized_path),
                "--output", str(output_path),
            ])
            self.assertEqual(1, result)
            self.assertTrue(output_path.exists())


if __name__ == "__main__":
    unittest.main()
