import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
KEYWORDS_DIR = REPO_ROOT / "keywords"
MANUAL_RELATIVE_PATH = (
    Path("src")
    / "ansys"
    / "dyna"
    / "core"
    / "keywords"
    / "keyword_classes"
    / "manual"
)

sys.path.insert(0, str(KEYWORDS_DIR))

from generate_from_pydyna import resolve_codegen_inputs, write_pretty_json  # noqa: E402


class GenerateFromPydynaTest(unittest.TestCase):
    def _create_codegen_tree(self, root: Path) -> Path:
        codegen_dir = root / "codegen"
        codegen_dir.mkdir(parents=True)
        for filename in ("kwd.json", "manifest.json", "additional-cards.json"):
            (codegen_dir / filename).write_text("{}", encoding="utf-8")
        (root / MANUAL_RELATIVE_PATH).mkdir(parents=True)
        return codegen_dir

    def test_codegen_dir_selects_its_kwd_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            codegen_dir = self._create_codegen_tree(Path(temporary_directory))

            resolved_codegen_dir, kwd_file = resolve_codegen_inputs(
                ["--codegen-dir", str(codegen_dir)]
            )

            self.assertEqual(codegen_dir.resolve(), resolved_codegen_dir)
            self.assertEqual((codegen_dir / "kwd.json").resolve(), kwd_file)

    def test_positional_kwd_file_remains_supported(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            codegen_dir = self._create_codegen_tree(Path(temporary_directory))

            resolved_codegen_dir, kwd_file = resolve_codegen_inputs(
                [str(codegen_dir / "kwd.json")]
            )

            self.assertEqual(codegen_dir.resolve(), resolved_codegen_dir)
            self.assertEqual((codegen_dir / "kwd.json").resolve(), kwd_file)

    def test_rejects_kwd_file_from_another_codegen_tree(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            codegen_dir = self._create_codegen_tree(root / "selected")
            other_codegen_dir = self._create_codegen_tree(root / "other")
            error_output = StringIO()

            with redirect_stderr(error_output), self.assertRaises(SystemExit):
                resolve_codegen_inputs(
                    [
                        "--codegen-dir",
                        str(codegen_dir),
                        "--kwd-file",
                        str(other_codegen_dir / "kwd.json"),
                    ]
                )

            self.assertIn("must be inside --codegen-dir", error_output.getvalue())

    def test_rejects_missing_required_codegen_input(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            codegen_dir = self._create_codegen_tree(Path(temporary_directory))
            (codegen_dir / "manifest.json").unlink()
            error_output = StringIO()

            with redirect_stderr(error_output), self.assertRaises(SystemExit):
                resolve_codegen_inputs(["--codegen-dir", str(codegen_dir)])

            self.assertIn(str((codegen_dir / "manifest.json").resolve()), error_output.getvalue())

    def test_pretty_json_writer_uses_utf8_two_spaces_lf_and_final_newline(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "nested" / "artifact.json"

            write_pretty_json(output, {"中文": {"value": 1}})

            written = output.read_bytes()
            self.assertNotIn(b"\r", written)
            self.assertTrue(written.endswith(b"\n"))
            self.assertFalse(written.endswith(b"\n\n"))
            self.assertIn('  "中文"', written.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
