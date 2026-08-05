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

    def test_rejects_mechanical_chinese_spacing_and_copied_source_phrase(self):
        source = (
            "Viscous damping coefficient in percent of critical for explicit contact."
        )
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nViscous damping 系数 在 percent 的 critical 接触。"
        )

        report = build_report(english, localized)

        self.assertEqual("fail", report["quality_gate"]["status"])
        self.assertEqual(1, report["mechanical_spacing_occurrences"])

    def test_rejects_copied_english_prose_but_keeps_formula_overlap(self):
        source = "The damping coefficient is used for explicit contact."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nThe damping coefficient is used for 接触。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["copied_source_prose_occurrences"])

    def test_keeps_formula_and_protected_solver_tokens_out_of_phrase_gate(self):
        source = "The value is given by zeta=(VDC/100)*zedacrit."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n该值由公式 `zeta=(VDC/100)*zedacrit` 给出。"
        )

        report = build_report(english, localized)

        self.assertEqual(0, report["mechanical_spacing_occurrences"])
        self.assertEqual(0, report["source_phrase_residue_occurrences"])

    def test_allows_sentence_breaks_between_chinese_lines(self):
        source = "First option. Second option."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n第一项。\n第二项。"
        )

        report = build_report(english, localized)

        self.assertEqual(0, report["mechanical_spacing_occurrences"])

    def test_ignores_uppercase_solver_identifiers_in_terminology_gate(self):
        source = "OPTION.EQ.PART: Part ID is included in the set."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nOPTION.EQ.PART：部件标识已加入集合。"
        )

        report = build_report(english, localized)

        self.assertEqual(0, report["terminology_residue_occurrences"])

    def test_normalizes_legacy_keyword_spelling_and_ignores_formula_stars(self):
        source = "Use x*2 with *DEFINE_?FUNCTION and *CONTROL_TEST."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n使用公式 x×2，并使用 *DEFINE_FUNCTION 和 *CONTROL_TEST。"
        )

        report = build_report(english, localized)

        self.assertEqual("pass", report["quality_gate"]["status"])
        self.assertEqual(0, report["protected_token_omissions"])

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
