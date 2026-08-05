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

    def test_accepts_reviewed_wildcard_keyword_and_ignores_formula_stars(self):
        source = "Use x*2 with *CONTACT_?_MPP and *CONTROL_TEST."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n使用公式 x×2，并使用 *CONTACT_?_MPP 和 *CONTROL_TEST。"
        )

        report = build_report(english, localized)

        self.assertEqual("pass", report["quality_gate"]["status"])
        self.assertEqual(0, report["protected_token_omissions"])

    def test_rejects_unreviewed_literal_question_mark_artifacts(self):
        source = "Use *DEFINE_?FUNCTION for A ? B."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n使用 *DEFINE_?FUNCTION 计算 A 与 B 的关系。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["question_mark_artifact_occurrences"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_known_source_extraction_artifacts(self):
        source = "Blast source ID (see *LOAD_BLAST_ENHANCED)D."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n爆炸源 ID（参见 *LOAD_BLAST_ENHANCED）。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["source_text_artifact_occurrences"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_broken_reference_repair_grammar(self):
        source = "See the relevant equation. in *MAT_107."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n参见 *MAT_107 中的相应公式。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["source_text_artifact_occurrences"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_malformed_keyword_reference_names(self):
        source = "Use *DEFINE_COORDI_NATE_VECTOR."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n使用 *DEFINE_COORDINATE_VECTOR。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["source_text_artifact_occurrences"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_mismatched_sequential_node_label(self):
        source = "Nodal point 2."
        english = sample(source)
        english["CONTROL_TEST"]["c"][0][0]["n"] = "N2"
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n节点 N1。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["field_label_mismatch_occurrences"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_missing_explicit_condition_pair(self):
        source = "Scale factor when SOFT = 0 or SOFT = 2."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n或 SOFT = 2 时的比例因子。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["condition_pair_omissions"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_accepts_natural_chinese_condition_and_rejects_mixed_terms(self):
        source = "OPTION = 2 uses the segment card."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n选项设为 2 时使用该段卡片。"
        )

        report = build_report(english, localized)

        self.assertEqual(0, report["condition_pair_omissions"])
        self.assertEqual(0, report["mixed_term_residue_occurrences"])

    def test_rejects_missing_named_option_label(self):
        source = "OPTION.EQ.PART: Part option."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nOPTION.EQ.部件：部件选项。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["option_label_omissions"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_missing_cross_field_identifier(self):
        source = "History-variable index HISVN used for erosion."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n用于侵蚀的历史变量索引。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["referenced_identifier_omissions"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_allows_equivalent_formula_identifier_notation(self):
        source = "The value is computed as B10 + A."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n该值按 B × 10 + A 计算。"
        )

        report = build_report(english, localized)

        self.assertEqual(0, report["referenced_identifier_omissions"])

    def test_rejects_changed_numeric_option_value(self):
        source = "EM dimension type: EQ.2 or EQ.3."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nEM 维度类型：EQ.3 或 EQ.4。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["option_value_mismatches"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_missing_values_in_long_option_table(self):
        source = "Options:\n" + "\n".join(
            f"EQ.{value}: Option {value}." for value in range(1, 13)
        )
        english = sample(source)
        localized = copy.deepcopy(english)
        translated = "选项：\n" + "\n".join(
            f"EQ.{value}：选项 {value}。" for value in range(1, 12)
        )
        localized["CONTROL_TEST"]["c"][0][0]["h"] = f"{source}\n{translated}"

        report = build_report(english, localized)

        self.assertEqual(1, report["option_value_mismatches"])
        self.assertEqual(
            ["EQ.12"], report["examples"]["option_value_mismatches"][0]["missing"]
        )

    def test_accepts_compact_option_ranges_and_pairs(self):
        source = (
            "Options:\nEQ.1: A.\nEQ.2: B.\nEQ.3: C.\n"
            "EQ.10: D.\nEQ.11: E.\nEQ.12: F."
        )
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n选项：EQ.1～EQ.3：前三项；EQ.10～EQ.12：后三项。"
        )

        report = build_report(english, localized)

        self.assertEqual(0, report["option_value_mismatches"])

    def test_accepts_unicode_not_equal_as_equivalent_relation(self):
        source = "Use the scale parameter when MPBN != 0."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nMPBN ≠ 0 时使用比例参数。"
        )

        report = build_report(english, localized)

        self.assertEqual(0, report["condition_pair_omissions"])

    def test_rejects_changed_comparison_operator(self):
        source = "If CMO>0 use global constraints; if CM0<0 use a local system."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nCMO = +1.0 时使用全局约束；CM0 = -1.0 时使用局部坐标系。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["condition_pair_omissions"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_unbalanced_or_incomplete_translation(self):
        source = "Parameter dimension and final description."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n参数量纲为 [L/T，并沿与["
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["punctuation_balance_violations"])
        self.assertEqual(1, report["incomplete_suffix_occurrences"])

    def test_rejects_bare_option_and_short_english_prose(self):
        source = "Rotational constraint. EQ.323: rotate about z, x, and z."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\nRotational constraint：\nEQ.323。"
        )

        report = build_report(english, localized)

        self.assertGreater(report["terminology_residue_occurrences"], 0)
        self.assertEqual(1, report["incomplete_suffix_occurrences"])

    def test_rejects_malformed_punctuation_and_short_mixed_phrase(self):
        source = "Last parametric point ID in block."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n最后 parametric point ID 在 block。。"
        )

        report = build_report(english, localized)

        self.assertGreater(report["mixed_term_residue_occurrences"], 0)
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_non_engineering_terminology_calques(self):
        source = "Kinematic hardening and hourglass control."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n运动硬化与小时玻璃控制。"
        )

        report = build_report(english, localized)

        self.assertGreater(report["mixed_term_residue_occurrences"], 0)
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_inconsistent_translations_of_identical_source(self):
        source = "Node ID."
        english = {
            "A": sample(source)["CONTROL_TEST"],
            "B": sample(source)["CONTROL_TEST"],
        }
        localized = copy.deepcopy(english)
        localized["A"]["c"][0][0]["h"] = f"{source}\n节点 ID。"
        localized["B"]["c"][0][0]["h"] = f"{source}\n节点标识。"

        report = build_report(english, localized)

        self.assertEqual(1, report["duplicate_source_variant_units"])
        self.assertEqual("fail", report["quality_gate"]["status"])

    def test_rejects_forbidden_unicode_and_literal_escape(self):
        source = "Node ID."
        english = sample(source)
        localized = copy.deepcopy(english)
        localized["CONTROL_TEST"]["c"][0][0]["h"] = (
            f"{source}\n节点\ufffd ID\\n。"
        )

        report = build_report(english, localized)

        self.assertEqual(1, report["unicode_violations"])
        self.assertEqual(1, report["literal_escape_violations"])
        self.assertEqual("fail", report["quality_gate"]["status"])

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
