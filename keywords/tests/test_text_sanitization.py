import sys
import unittest
from pathlib import Path


KEYWORDS_DIR = Path(__file__).resolve().parents[1]
if str(KEYWORDS_DIR) not in sys.path:
    sys.path.insert(0, str(KEYWORDS_DIR))

from text_sanitization import (  # noqa: E402
    HelpTextSanitizationError,
    sanitize_help_text,
    sanitize_help_tree,
)


class TextSanitizationTests(unittest.TestCase):
    def test_repairs_deterministic_source_artifacts(self):
        value = (
            "element�s thickness; OPTION = 7, �9; E1, �, E7; "
            "stress � length; temperature 10�C"
        )
        self.assertEqual(
            "element's thickness; OPTION = 7, -9; E1, ..., E7; "
            "stress x length; temperature 10deg C",
            sanitize_help_text(value),
        )

    def test_repairs_formula_multiplication_before_negative_options(self):
        value = (
            "NOWRT = L + M�10 + N�100 + P�1000; "
            "A = 1.732�10 ^ (-6); THK_MIN < 1.0 �10-20; OPTION = �9"
        )
        self.assertEqual(
            "NOWRT = L + M * 10 + N * 100 + P * 1000; "
            "A = 1.732 * 10 ^ (-6); THK_MIN < 1.0 * 10^(-20); OPTION = -9",
            sanitize_help_text(value),
        )

    def test_repairs_reviewed_quote_and_vector_contexts(self):
        self.assertEqual(
            'The "GEOM" column; vector a x b and c x a; thin shells\' normal',
            sanitize_help_text(
                'The "GEOM� column; vector a�b and c�a; thin shells� normal'
            ),
        )

    def test_repairs_verified_turbulence_model_names(self):
        self.assertEqual(
            "Applicable to k-omega turbulence models; "
            "terms for k-epsilon and k-omega models",
            sanitize_help_text(
                "Applicable to k � ? turbulence models; "
                "terms for k � ? and k� ? models"
            ),
        )

    def test_removes_format_controls_and_normalizes_line_endings(self):
        self.assertEqual("a    b\nc", sanitize_help_text("a\t\u200cb\r\nc"))
        self.assertEqual("a\nb", sanitize_help_text("a\\nb"))

    def test_repairs_codegen_control_sentinels(self):
        self.assertEqual(
            "Constraint type:\nEQ.1: no flow\nNIP = PR * PS; Bezier",
            sanitize_help_text("Constraint type:\x01EQ.1: no flow\nNIP = PR \x02 PS; B\x13ezier"),
        )

    def test_repairs_codegen_punctuation_losses(self):
        value = (
            "Courant�CFriedrichs�CLewy; r-\x1eaxis; "
            "set to �1�; steel�s; beta\x88 and the gama directions"
        )

        self.assertEqual(
            'Courant-Friedrichs-Lewy; r-axis; set to 1; steel\'s; '
            "beta and the gama directions",
            sanitize_help_text(value),
        )

    def test_unknown_replacement_character_blocks_generation(self):
        with self.assertRaises(HelpTextSanitizationError):
            sanitize_help_text("unknown � character")

    def test_unreviewed_apostrophe_like_context_blocks_generation(self):
        with self.assertRaises(HelpTextSanitizationError):
            sanitize_help_text("worker�s value")
        with self.assertRaises(HelpTextSanitizationError):
            sanitize_help_text('The "FIELD� column')

    def test_noncharacter_blocks_generation(self):
        with self.assertRaises(HelpTextSanitizationError):
            sanitize_help_text("bad\ufdd0")

    def test_tree_only_sanitizes_help_values(self):
        tree = {"n": "FIELD\u200b", "h": "element�s"}
        self.assertEqual(
            {"n": "FIELD\u200b", "h": "element's"},
            sanitize_help_tree(tree),
        )


if __name__ == "__main__":
    unittest.main()
