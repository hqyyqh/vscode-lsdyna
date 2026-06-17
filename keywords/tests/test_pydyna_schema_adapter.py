import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
KEYWORDS_DIR = REPO_ROOT / "keywords"
CODEGEN_DIR = REPO_ROOT / "pydyna" / "codegen"

sys.path.insert(0, str(KEYWORDS_DIR))

from pydyna_schema_adapter import build_schema  # noqa: E402


class PydynaSchemaAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.generated = build_schema(CODEGEN_DIR)
        cls.field_data = cls.generated.field_data
        cls.snippets = cls.generated.snippets

    def test_mat_001_title_option_and_variant(self):
        mat = self.field_data["MAT_001"]
        title = next(option for option in mat["o"] if option["n"] == "TITLE")

        self.assertEqual(1, len(mat["c"]))
        self.assertEqual("pre/1", title["co"])
        self.assertEqual(1, title["to"])
        self.assertIn("MAT_001_TITLE", mat["v"])
        self.assertIn("MAT_001_TITLE", self.field_data)

        snippet = self.snippets["*MAT_001_TITLE"]
        self.assertEqual("*MAT_001_TITLE", snippet["body"][0])
        self.assertIn("title", snippet["body"][1].lower())
        self.assertIn("additional title line", title["c"][0][0]["h"].lower())

    def test_wide_single_field_snippet_keeps_comment_header(self):
        snippet = self.snippets["*MAT_024_TITLE"]

        self.assertEqual("*MAT_024_TITLE", snippet["body"][0])
        self.assertTrue(snippet["body"][1].startswith("$#"))
        self.assertIn("title", snippet["body"][1].lower())
        self.assertEqual("${1:TITLE}", snippet["body"][2])

    def test_contact_options_and_selection_snippet(self):
        contact = self.field_data["CONTACT_AUTOMATIC_SURFACE_TO_SURFACE"]
        options = {option["n"]: option for option in contact["o"]}

        for name in ["ID", "MPP", "A", "B", "C", "D", "E", "F", "G"]:
            self.assertIn(name, options)

        self.assertEqual("pre/2", options["ID"]["co"])
        self.assertEqual(1, options["ID"]["to"])
        self.assertEqual("post/6", options["F"]["co"])
        self.assertEqual(0, options["F"]["to"])

        snippet = self.snippets["*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_OPTION_F"]
        self.assertEqual("*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE", snippet["body"][0])
        self.assertIn("*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F", snippet["prefix"])
        self.assertIn("Optional Cards A-F", snippet["description"])

    def test_contact_title_variant_post_option_snippet_combines_cards(self):
        snippet = self.snippets["*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_OPTION_F"]
        body_text = "\n".join(snippet["body"]).lower()

        self.assertEqual("*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP", snippet["body"][0])
        self.assertIn("*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_F", snippet["prefix"])
        self.assertIn("CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP + Optional Cards A-F", snippet["description"])

        for field_name in ["ignore", "mpp2", "cid", "ssid", "soft", "pstiff"]:
            self.assertIn(field_name, body_text)

        self.assertLess(body_text.index("ignore"), body_text.index("cid"))
        self.assertLess(body_text.index("cid"), body_text.index("ssid"))
        self.assertLess(body_text.index("ssid"), body_text.index("soft"))
        self.assertLess(body_text.index("soft"), body_text.index("pstiff"))

    def test_manifest_alias_entries_point_to_same_schema(self):
        base = self.field_data["SET_NODE_LIST"]
        alias = self.field_data["SET_NODE"]
        title_alias = self.field_data["SET_NODE_TITLE"]

        self.assertIn("SET_NODE", base["a"])
        self.assertEqual("SET_NODE_LIST", alias["x"])
        self.assertEqual(base["c"], alias["c"])
        self.assertIn("*SET_NODE", self.snippets)
        self.assertEqual("*SET_NODE", self.snippets["*SET_NODE"]["body"][0])
        self.assertEqual("SET_NODE_LIST_TITLE", title_alias["x"])
        self.assertEqual(["TITLE"], title_alias["active"])
        self.assertIn("*SET_NODE_TITLE", self.snippets)
        self.assertEqual("*SET_NODE_TITLE", self.snippets["*SET_NODE_TITLE"]["body"][0])

    def test_local_set_part_alias_points_to_set_part_list_schema(self):
        base = self.field_data["SET_PART_LIST"]
        alias = self.field_data["SET_PART"]
        title_alias = self.field_data["SET_PART_TITLE"]

        self.assertIn("SET_PART", base["a"])
        self.assertEqual("SET_PART_LIST", alias["x"])
        self.assertEqual(base["c"], alias["c"])
        self.assertIn("*SET_PART", self.snippets)
        self.assertEqual("*SET_PART", self.snippets["*SET_PART"]["body"][0])
        self.assertEqual("SET_PART_LIST_TITLE", title_alias["x"])
        self.assertEqual(["TITLE"], title_alias["active"])
        self.assertIn("*SET_PART_TITLE", self.snippets)
        self.assertEqual("*SET_PART_TITLE", self.snippets["*SET_PART_TITLE"]["body"][0])

    def test_control_timestep_alias_and_cascading_metadata(self):
        control = self.field_data["CONTROL_TIMESTEP"]
        alias = self.field_data["CONTROL_TIME_STEP"]

        self.assertIn("CONTROL_TIME_STEP", control["a"])
        self.assertEqual("CONTROL_TIMESTEP", alias["x"])
        self.assertTrue(any(card[0].get("active") for card in control["c"][1:]))

    def test_card_set_keywords_expand_source_cards(self):
        section = self.field_data["SECTION_SHELL"]
        options = {option["n"]: option for option in section["o"]}

        self.assertEqual("SECID", section["c"][0][0]["n"])
        self.assertGreaterEqual(len(section["c"]), 2)
        self.assertIn("MISC", options)


if __name__ == "__main__":
    unittest.main()
