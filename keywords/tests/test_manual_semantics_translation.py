import gzip
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from validate_manual_semantics_translation import (
    key,
    normalize,
    runtime_index_errors,
    validate_runtime_artifacts,
    main,
    translation_errors,
)


def _make_mock_environment(temp_path: Path, sources_dict: dict[str, str], reviewed_dict: dict[str, str]):
    shards_dir = temp_path / "shards"
    shards_dir.mkdir(parents=True, exist_ok=True)
    shard_rules = []
    for idx, src in enumerate(sources_dict.keys()):
        shard_rules.append({
            "ruleId": f"rule_{idx}",
            "keyword": "*TEST_KEYWORD",
            "kind": "card-presence",
            "relation": {"presence": "conditional"},
            "summary": src,
        })
    shard_content = gzip.compress(json.dumps({"rules": shard_rules}).encode("utf-8"))
    (shards_dir / "shard_000.json.gz").write_bytes(shard_content)

    authoring_file = temp_path / "manual_semantics_zh.json"
    rows = [{"english": eng, "localized": zh} for eng, zh in reviewed_dict.items()]
    authoring_bytes = json.dumps(rows, ensure_ascii=False, indent=2).encode("utf-8")
    authoring_file.write_bytes(authoring_bytes)
    authoring_sha = hashlib.sha256(authoring_bytes).hexdigest()

    runtime_dir = temp_path / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    text_index = {key(eng): zh for eng, zh in reviewed_dict.items()}
    index_bytes = gzip.compress(json.dumps(text_index).encode("utf-8"))
    (runtime_dir / "text-index.json.gz").write_bytes(index_bytes)
    index_sha = hashlib.sha256(index_bytes).hexdigest()

    manifest = {
        "shardSize": 2048,
        "shards": [],
        "textIndex": {
            "sha256": index_sha,
            "manualSemanticsSha256": authoring_sha,
        },
    }
    (runtime_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    return shards_dir, authoring_file, runtime_dir


class ManualSemanticsValidatorTests(unittest.TestCase):
    def test_unicode_comparisons_cannot_be_dropped_or_reversed(self):
        for operator, reversed_operator in [('≥', '≤'), ('≤', '≥'), ('≠', '=')]:
            english = f'Card 14. Include if IEXTRA {operator} 1.'
            row = {'english': english, 'localized': f'卡片 14。IEXTRA {operator} 1 时加入。'}
            self.assertEqual([], translation_errors([row], {normalize(english): {}}))
            for replacement in ['…', reversed_operator]:
                bad = {**row, 'localized': row['localized'].replace(operator, replacement), 'sourceIssue': '原文损坏'}
                self.assertTrue(translation_errors([bad], {normalize(english): {}}))

    def test_source_issue_is_internal_metadata_without_displayed_disclaimer(self):
        english = 'EQ.1: Use the curve for…'
        row = {'english': english, 'localized': 'EQ.1：使用曲线…', 'sourceIssue': '原文截断'}
        self.assertEqual([], translation_errors([row], {normalize(english): {}}))

    def test_reviewed_sentence_boundary_does_not_invent_a_condition(self):
        english = 'Energy release rate G_ I C in Mode I or the lower bound of the rate-dependent G_ I C . GT.0.0: Energy release rate G_ I C in Mode I. G1C_0 is a curve ID if the THERMAL keyword option is used. G1C_0 is a function ID if the FUNCTIONS keyword option is used. LE.0.0: Lower bound val…'
        localized = 'I 型能量释放率 G_ I C，或与速率相关的 G_ I C 的下限。GT.0.0：I 型能量释放率 G_ I C；采用 THERMAL 关键字选项时，G1C_0 为曲线 ID；采用 FUNCTIONS 关键字选项时，G1C_0 为函数 ID。LE.0.0：下限值。原文末尾截断。'
        row = {'english': english, 'localized': localized, 'sourceIssue': 'Truncated summary'}
        self.assertEqual([], translation_errors([row], {normalize(english): {}}))
        self.assertTrue(translation_errors([{**row, 'localized': localized.replace('GT.0.0', '')}], {normalize(english): {}}))
        changed = 'Use C . GT.0.0 for this field.'
        self.assertTrue(translation_errors([{'english': changed, 'localized': '此字段使用 GT.0.0。'}], {changed: {}}))
        changed = english.replace('Energy release rate', 'Critical energy release rate', 1)
        self.assertTrue(translation_errors([{**row, 'english': changed}], {normalize(changed): {}}))

    def test_missing_manifest_or_text_index_fails_strictly(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir) / "runtime"
            runtime_dir.mkdir(parents=True)
            authoring_file = Path(temp_dir) / "manual_semantics_zh.json"
            authoring_file.write_text("[]", encoding="utf-8")
            rows = [{"english": "Sample source.", "localized": "示例中文。"}]

            # Both missing
            errors = validate_runtime_artifacts(runtime_dir, authoring_file, rows)
            self.assertTrue(any("Runtime manifest missing" in e for e in errors))
            self.assertTrue(any("Runtime text-index missing" in e for e in errors))

            # Only manifest present, text-index missing
            manifest_path = runtime_dir / "manifest.json"
            manifest_path.write_text(json.dumps({}), encoding="utf-8")
            errors = validate_runtime_artifacts(runtime_dir, authoring_file, rows)
            self.assertFalse(any("Runtime manifest missing" in e for e in errors))
            self.assertTrue(any("Runtime text-index missing" in e for e in errors))

            # Only text-index present, manifest missing
            manifest_path.unlink()
            text_index_path = runtime_dir / "text-index.json.gz"
            text_index_path.write_bytes(gzip.compress(b"{}"))
            errors = validate_runtime_artifacts(runtime_dir, authoring_file, rows)
            self.assertTrue(any("Runtime manifest missing" in e for e in errors))
            self.assertFalse(any("Runtime text-index missing" in e for e in errors))

    def test_shard_slot_zero_handled_correctly(self):
        source = "Card 1. Value for condition."
        localized = "卡片 1。条件值。"
        identity = key(source)
        shard_size = 2048

        shards = {
            0: {
                "shardIndex": 0,
                "start": 0,
                "count": 1,
                "english": [source],
                "localized": [localized],
            }
        }
        # Slot 0 pointing to shard 0 offset 0
        entries = {identity: 0}
        rows = [{"english": source, "localized": localized}]

        # 1. Matching translation -> no errors
        errors = runtime_index_errors(entries, shards, shard_size, rows)
        self.assertEqual([], errors)

        # 2. Slot 0 translation mismatch -> fails
        mismatched_rows = [{"english": source, "localized": "完全不同的中文。"}]
        errors = runtime_index_errors(entries, shards, shard_size, mismatched_rows)
        self.assertTrue(any("Runtime text index differs from reviewed text" in e for e in errors))

    def test_nonzero_integer_slot_out_of_bounds_or_wrong_translation_fails(self):
        source = "Card 2. Second rule."
        localized = "卡片 2。第二条规则。"
        identity = key(source)
        shard_size = 2048
        rows = [{"english": source, "localized": localized}]

        # Case 1: Slot pointing to missing shard
        entries_missing_shard = {identity: 4096}  # shard 2, not in shards
        errors = runtime_index_errors(entries_missing_shard, {}, shard_size, rows)
        self.assertTrue(any("Invalid shard slot 4096" in e for e in errors))

        # Case 2: Slot offset out of bounds within existing shard
        shards = {
            1: {
                "shardIndex": 1,
                "start": 2048,
                "count": 2,
                "english": ["Other A", "Other B"],
                "localized": ["其他 A", "其他 B"],
            }
        }
        entries_oob = {identity: 2055}  # offset 7 >= count 2
        errors = runtime_index_errors(entries_oob, shards, shard_size, rows)
        self.assertTrue(any("Invalid shard slot 2055" in e for e in errors))

        # Case 3: Slot points to wrong source slot (english text mismatch)
        entries_wrong_source = {identity: 2048}
        errors = runtime_index_errors(entries_wrong_source, shards, shard_size, rows)
        self.assertTrue(any("Wrong source slot" in e for e in errors))

        # Case 4: English matches but translation differs from reviewed
        shards_matching_source = {
            1: {
                "shardIndex": 1,
                "start": 2048,
                "count": 1,
                "english": [source],
                "localized": ["错误的中文。"],
            }
        }
        entries_matching_source = {identity: 2048}
        errors = runtime_index_errors(entries_matching_source, shards_matching_source, shard_size, rows)
        self.assertTrue(any("Runtime text index differs from reviewed text" in e for e in errors))

    def test_untranslated_exits_nonzero_in_default_and_summary_modes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            sources = {
                "Card 1. Rule one.": "卡片 1。规则一。",
                "Card 2. Rule two.": "卡片 2。规则二。",
            }
            # Only Card 1 is reviewed; Card 2 is untranslated
            reviewed = {"Card 1. Rule one.": "卡片 1。规则一。"}
            shards_dir, authoring_file, runtime_dir = _make_mock_environment(temp_path, sources, reviewed)

            with patch("sys.stdout", io.StringIO()) as out:
                code_default = main([], authoring_path=authoring_file, shard_dir=shards_dir, runtime_dir=runtime_dir)
                self.assertEqual(1, code_default)

                code_summary = main(["--summary"], authoring_path=authoring_file, shard_dir=shards_dir, runtime_dir=runtime_dir)
                self.assertEqual(1, code_summary)

                code_stage = main(["--stage-report"], authoring_path=authoring_file, shard_dir=shards_dir, runtime_dir=runtime_dir)
                self.assertEqual(0, code_stage)
                self.assertIn("INCOMPLETE (stage report only, not certified for acceptance)", out.getvalue())

    def test_complete_and_correct_runtime_artifacts_pass(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            sources = {
                "Card 1. Valid test.": "卡片 1。有效测试。",
                "Card 2. Another rule.": "卡片 2。另一条规则。",
            }
            # All sources reviewed and translated
            reviewed = sources
            shards_dir, authoring_file, runtime_dir = _make_mock_environment(temp_path, sources, reviewed)

            with patch("sys.stdout", io.StringIO()) as out:
                code_default = main([], authoring_path=authoring_file, shard_dir=shards_dir, runtime_dir=runtime_dir)
                self.assertEqual(0, code_default)

                code_summary = main(["--summary"], authoring_path=authoring_file, shard_dir=shards_dir, runtime_dir=runtime_dir)
                self.assertEqual(0, code_summary)

                code_stage = main(["--stage-report"], authoring_path=authoring_file, shard_dir=shards_dir, runtime_dir=runtime_dir)
                self.assertEqual(0, code_stage)
                self.assertIn("STRUCTURAL_CHECKS_PASSED", out.getvalue())
                self.assertIn("language and UI review still required", out.getvalue())

    def test_missing_source_and_corrupted_runtime_shard_fail(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = {"Card 1. Rule.": "卡片 1。规则。"}
            sources, authoring, runtime = _make_mock_environment(root, source, source)
            with patch("sys.stdout", io.StringIO()):
                self.assertEqual(1, main([], authoring_path=authoring,
                    shard_dir=root / "missing", runtime_dir=runtime))
            shard_dir = runtime / "shards"
            shard_dir.mkdir()
            (shard_dir / "0.json.gz").write_bytes(gzip.compress(b"{}"))
            manifest_path = runtime / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["shards"] = [{"file": "0.json.gz", "shardIndex": 0, "sha256": "0" * 64}]
            manifest_path.write_text(json.dumps(manifest))
            errors = validate_runtime_artifacts(runtime, authoring,
                [{"english": text, "localized": localized} for text, localized in source.items()])
            self.assertTrue(any("Runtime shard hash mismatch" in error for error in errors))

    def test_errors_always_fail_even_in_stage_report(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            sources = {"Card 1. Rule with EQ.1": "卡片 1。条件 EQ.1"}
            # Localized translation drops protected token EQ.1 -> syntax/token error!
            reviewed = {"Card 1. Rule with EQ.1": "卡片 1。缺失标记。"}
            shards_dir, authoring_file, runtime_dir = _make_mock_environment(temp_path, sources, reviewed)

            with patch("sys.stdout", io.StringIO()):
                code_stage = main(["--stage-report"], authoring_path=authoring_file, shard_dir=shards_dir, runtime_dir=runtime_dir)
                # Any error causes exit code 1 even under --stage-report
                self.assertEqual(1, code_stage)


if __name__ == "__main__":
    unittest.main()
