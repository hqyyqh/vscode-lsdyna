"""Validate manual semantics translation coverage against actual manual semantic rule summaries.

Reviewed manual semantics translations must preserve conditions, negation,
protected tokens, and source meaning. Source-review metadata is not display text.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

from audit_field_data_quality import (
    critical_source_tokens, protected_token_present,
    source_condition_pairs, condition_pair_present,
    _normalized_option_tokens, _numeric_option_present,
)
from text_sanitization import forbidden_help_characters

ROOT = Path(__file__).resolve().parents[1]
JS_WHITESPACE = re.compile(r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")

# Reviewed sentence endings followed by independent numeric option headings.
# The shared scanner reads "G_ I C . GT.0.0:" / "- PC . EQ.3.0:" as
# variable comparisons. Bind these three false positives to complete sources;
# all option tokens remain mandatory and any source change loses the exception.
SOURCE_OPTION_BOUNDARIES = {
    "722df252c13e498825cc2bcda9b5b8c2b2170609609a47fe51b74e3911cfa28e": {("C", "GT", "0")},
    "a6e708a76355d3d72ab7e246298a21de8ae6a5a69803dc447c35283c78d621dd": {("C", "GT", "0")},
    "73f59d56b809f264371adeb0be6688d64337689fa3c1661adbd31002fd67afdd": {("PC", "EQ", "3")},
}


def normalize(text: str) -> str:
    return JS_WHITESPACE.sub(" ", text).strip(" ")


def key(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def manual_semantic_sources(shard_dir: Path | None = None) -> dict[str, dict]:
    """Collect all unique summaries across manual semantics shards with metadata."""
    if shard_dir is None:
        shard_dir = ROOT / "keywords/manual_semantics/shards"
    sources = {}
    if not shard_dir.exists():
        raise ValueError(f"Manual semantic source directory missing: {shard_dir}")
    for shard_file in sorted(shard_dir.glob("*.json.gz")):
        content = json.loads(gzip.decompress(shard_file.read_bytes()))
        for rule in content.get("rules", []):
            kind = rule.get("kind")
            rel_presence = rule.get("relation", {}).get("presence")
            is_conditional = (kind == "card-presence" and rel_presence == "conditional")
            is_field_choice = (kind == "field-choice")
            is_field_dep = (kind == "field-dependency")
            is_keyword_option = (kind == "keyword-option")
            if not (is_conditional or is_field_choice or is_field_dep or is_keyword_option):
                continue
            summary = rule.get("summary")
            if not summary or not summary.strip():
                continue
            norm = normalize(summary)
            if norm not in sources:
                sources[norm] = {
                    "raw": summary,
                    "kinds": set(),
                    "keywords": set(),
                    "ruleIds": set(),
                }
            entry = sources[norm]
            if is_conditional:
                entry["kinds"].add("conditional")
            elif is_field_choice:
                entry["kinds"].add("fieldChoice")
            elif is_field_dep:
                entry["kinds"].add("fieldDependency")
            elif is_keyword_option:
                entry["kinds"].add("keywordOption")
            entry["keywords"].add(rule.get("keyword"))
            entry["ruleIds"].add(rule.get("ruleId"))
    if not sources:
        raise ValueError(f"No manual semantic sources found in {shard_dir}")
    return sources


def translation_errors(rows: list[dict], sources: dict[str, dict]) -> list[str]:
    seen = set()
    errors = []
    for index, row in enumerate(rows):
        english = row.get("english", "")
        localized = row.get("localized", "")
        label = f"translation[{index}]"
        norm = normalize(english)
        if not norm or norm not in sources:
            errors.append(f"{label}: source is not in the manual semantics corpus: {english[:80]!r}")
        if norm in seen:
            errors.append(f"{label}: duplicate normalized source: {english[:80]!r}")
        seen.add(norm)
        if not localized or not re.search(r"[\u3400-\u9fff]", localized):
            errors.append(f"{label}: Chinese translation missing for {english[:80]!r}")
        if forbidden_help_characters(localized):
            errors.append(f"{label}: forbidden character in Chinese text for {english[:80]!r}")
        if forbidden_help_characters(english.replace("\t", "").replace("\r", "")) and not row.get("sourceIssue"):
            errors.append(f"{label}: damaged source requires sourceIssue")
        missing = [token for token in critical_source_tokens(english) if not protected_token_present(token, localized)]
        sentence_boundaries = SOURCE_OPTION_BOUNDARIES.get(key(english), set())
        condition_source = english.translate(str.maketrans({'≥': '>=', '≤': '<=', '≠': '!='}))
        conditions = [pair for pair in source_condition_pairs(condition_source)
                      if pair not in sentence_boundaries and not condition_pair_present(*pair, localized)]
        options = [token for token in _normalized_option_tokens(english, numeric_only=True)
                   if not _numeric_option_present(token, localized)]
        if missing or conditions or options:
            errors.append(f"{label}: protected tokens {missing}, conditions {conditions}, options {options} for {english[:80]!r}")
    return errors


def runtime_index_errors(entries: dict, shards: dict, shard_size: int, rows: list[dict]) -> list[str]:
    """Verify that every reviewed row matches its resolved runtime translation.

    Correctly distinguishes missing keys, integer shard slots (including 0),
    and direct string translations.
    """
    errors = []
    for row in rows:
        english = row.get("english", "")
        expected_localized = row.get("localized", "")
        identity = key(english)

        if identity not in entries:
            errors.append(f"Runtime text index missing reviewed translation for: {english[:80]!r}")
            continue

        val = entries[identity]
        resolved_text = None

        if isinstance(val, int) and not isinstance(val, bool):
            shard_idx = val // shard_size
            shard = shards.get(shard_idx)
            offset = val - shard["start"] if shard and "start" in shard else -1
            if not shard or not (0 <= offset < len(shard.get("english", []))):
                errors.append(f"Invalid shard slot {val} for: {english[:80]!r}")
                continue
            if normalize(shard["english"][offset]) != normalize(english):
                errors.append(f"Wrong source slot for: {english[:80]!r} (expected {english[:40]!r}, got {shard['english'][offset][:40]!r})")
                continue
            localized = shard.get("localized", [])
            resolved_text = localized[offset] if offset < len(localized) else None
        elif isinstance(val, str):
            resolved_text = val
        else:
            errors.append(f"Invalid runtime index entry type {type(val).__name__} for: {english[:80]!r}")
            continue

        if not isinstance(resolved_text, str) or not re.search(r"[\u3400-\u9fff]", resolved_text):
            errors.append(f"Runtime translation has no Chinese text for: {english[:80]!r}")
            continue

        if resolved_text != expected_localized:
            errors.append(
                f"Runtime text index differs from reviewed text for: {english[:80]!r} "
                f"(expected {expected_localized[:40]!r}, got {resolved_text[:40]!r})"
            )

    return errors


def validate_runtime_artifacts(
    runtime_dir: Path,
    authoring_path: Path,
    rows: list[dict],
) -> list[str]:
    """Check required runtime artifacts and compare reviewed rows against text-index."""
    errors = []
    manifest_file = runtime_dir / "manifest.json"
    text_index_file = runtime_dir / "text-index.json.gz"

    if not manifest_file.exists():
        errors.append(f"Runtime manifest missing: {manifest_file}. Run 'npm run build:field-help-runtime' first.")
    if not text_index_file.exists():
        errors.append(f"Runtime text-index missing: {text_index_file}. Run 'npm run build:field-help-runtime' first.")
    if errors:
        return errors

    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"Failed to read runtime manifest: {exc}")
        return errors

    descriptor = manifest.get("textIndex", {})
    expected_manual_sha = hashlib.sha256(authoring_path.read_bytes()).hexdigest()
    if descriptor.get("manualSemanticsSha256") != expected_manual_sha:
        errors.append("Runtime text index is stale for manual_semantics_zh.json; rebuild field-help runtime")

    try:
        encoded = text_index_file.read_bytes()
        if hashlib.sha256(encoded).hexdigest() != descriptor.get("sha256"):
            errors.append("Runtime text index hash mismatch")
        entries = json.loads(gzip.decompress(encoded))
    except Exception as exc:
        errors.append(f"Failed to read/decompress text-index: {exc}")
        return errors

    shard_size = manifest.get("shardSize", 2048)
    shards = {}
    shards_dir = runtime_dir / "shards"
    for shard_entry in manifest.get("shards", []):
        shard_path = shards_dir / shard_entry.get("file", "")
        if not shard_path.exists():
            errors.append(f"Runtime shard missing: {shard_path}")
            continue
        try:
            encoded_shard = shard_path.read_bytes()
            if hashlib.sha256(encoded_shard).hexdigest() != shard_entry.get("sha256"):
                errors.append(f"Runtime shard hash mismatch: {shard_path}")
                continue
            shard_data = json.loads(gzip.decompress(encoded_shard))
            shards[shard_entry["shardIndex"]] = shard_data
        except Exception as exc:
            errors.append(f"Failed to read/decompress shard {shard_path}: {exc}")

    errors.extend(runtime_index_errors(entries, shards, shard_size, rows))
    return errors


def main(
    argv: list[str] | None = None,
    *,
    authoring_path: Path | None = None,
    shard_dir: Path | None = None,
    runtime_dir: Path | None = None,
) -> int:
    if argv is None:
        argv = sys.argv[1:]

    if shard_dir is None:
        shard_dir = ROOT / "keywords/manual_semantics/shards"
    if authoring_path is None:
        authoring_path = ROOT / "keywords/manual_semantics_zh.json"
    if runtime_dir is None:
        runtime_dir = ROOT / "out/runtime/field_help"

    try:
        sources = manual_semantic_sources(shard_dir)
    except (ValueError, OSError) as exc:
        print(json.dumps({"errors": [str(exc)]}, ensure_ascii=False))
        return 1
    path = authoring_path
    if not path.exists():
        print(json.dumps({
            "source_count": len(sources),
            "reviewed_entries": 0,
            "untranslated_count": len(sources),
            "errors": [f"{path} does not exist"],
        }, ensure_ascii=False, indent=2))
        return 1

    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(json.dumps({
            "source_count": len(sources),
            "reviewed_entries": 0,
            "untranslated_count": len(sources),
            "errors": [f"Invalid JSON in {path}: {exc}"],
        }, ensure_ascii=False, indent=2))
        return 1

    errors = translation_errors(rows, sources)

    # Runtime artifacts validation
    runtime_errors = validate_runtime_artifacts(runtime_dir, path, rows)
    errors.extend(runtime_errors)

    reviewed_norms = {normalize(r["english"]) for r in rows if r.get("english")}
    missing_sources = [info["raw"] for norm, info in sources.items() if norm not in reviewed_norms]

    is_stage_report = "--stage-report" in argv
    is_summary = "--summary" in argv

    summary = {
        "source_count": len(sources),
        "reviewed_entries": len(rows),
        "source_issue_entries": sum(bool(r.get("sourceIssue")) for r in rows),
        "untranslated_count": len(missing_sources),
        "errors": errors,
    }
    if not is_summary:
        summary["missing_examples"] = [s[:120] for s in missing_sources[:10]]
    if is_stage_report:
        summary["acceptance_status"] = (
            "STRUCTURAL_CHECKS_PASSED (language and UI review still required)" if not errors and not missing_sources
            else "INCOMPLETE (stage report only, not certified for acceptance)"
        )

    print(json.dumps(summary, ensure_ascii=False, indent=2))

    # Strict acceptance gate:
    # 1. Any errors (syntax, token violations, stale runtime, etc.) MUST fail (exit 1).
    # 2. Any missing translations MUST fail (exit 1), including under --summary.
    # 3. Only an explicit --stage-report returns 0 when translation is incomplete (provided errors are 0).
    if errors:
        return 1
    if missing_sources and not is_stage_report:
        return 1
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
