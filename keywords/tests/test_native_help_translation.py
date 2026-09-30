import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validate_native_help_translation import translation_errors, runtime_translation_errors, normalize, key


class NativeHelpTranslationTests(unittest.TestCase):
    def test_matches_javascript_whitespace_without_erasing_native_damage(self):
        self.assertEqual("Value. test", normalize("\ufeff Value.\n\t test\u00a0"))
        self.assertNotEqual(key("E1,\u0085,E7"), key("E1, ,E7"))

    def test_rejects_unrelated_chinese_in_runtime_index(self):
        source = "Value."
        rows = [{"english": source, "localized": "值。"}]
        errors, missing = runtime_translation_errors({key(source): "完全无关的中文。"}, {}, 2048, rows, {source})
        self.assertTrue(errors)
        self.assertEqual([], missing)

    def test_rejects_changed_source_and_lost_condition(self):
        source = "If OPTION > 2, use *DEFINE_CURVE."
        self.assertTrue(translation_errors([
            {"english": source, "localized": "使用 *DEFINE_CURVE。"}
        ], {source}))
        self.assertTrue(translation_errors([
            {"english": source.replace(">", "<"), "localized": "若 OPTION < 2，使用 *DEFINE_CURVE。"}
        ], {source}))
        self.assertEqual([], translation_errors([
            {"english": source, "localized": "若 OPTION > 2，使用 *DEFINE_CURVE。"}
        ], {source}))

    def test_source_damage_must_be_visible_in_chinese(self):
        row = {"english": "Initial ?.", "localized": "初始值。", "sourceIssue": "Missing symbol"}
        self.assertTrue(translation_errors([row], {row["english"]}))
        row["localized"] = "初始 ?（原文符号缺失）。"
        self.assertEqual([], translation_errors([row], {row["english"]}))

    def test_detects_unmarked_source_corruption_but_allows_native_tabs(self):
        source = "B\x13ezier curve."
        self.assertTrue(translation_errors([
            {"english": source, "localized": "Bézier 曲线。"}
        ], {source}))
        source = "Radius\tof the area."
        self.assertEqual([], translation_errors([
            {"english": source, "localized": "该区域的半径。"}
        ], {source}))


if __name__ == "__main__":
    unittest.main()
