"""Validate runtime translation coverage against the actual native English corpus.

Damaged native source text is immutable here. Reviewed translations disclose its
ambiguity in Chinese and sourceIssue; they must not invent missing identifiers.
"""
from __future__ import annotations

import ast
import gzip
import hashlib
import io
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

ROOT = Path(__file__).resolve().parents[3]
JS_WHITESPACE = re.compile(r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


def normalize(text: str) -> str:
    # Match ECMAScript trim/\s exactly. U+0085 in native extraction is not
    # layout whitespace and must not silently disappear from source identity.
    return JS_WHITESPACE.sub(" ", text).strip(" ")


def key(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def native_sources() -> set[str]:
    root = ROOT / "keywords/runtime/native-help"
    manifest_bytes = (root / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    fields = {}
    for shard in manifest["shards"].values():
        encoded = (root / shard["file"]).read_bytes()
        if hashlib.sha256(encoded).hexdigest() != shard["sha256"]:
            raise ValueError(f"Native source hash mismatch: {shard['file']}")
        fields.update(json.loads(gzip.decompress(encoded)))
    descriptor = json.loads((root / "native-null-help.manifest.json").read_bytes())
    size = descriptor["uncompressedBytes"]
    if (descriptor["file"] != "native-null-help.json.gz"
            or descriptor["sourceSha256"] != manifest["sourceSha256"]
            or descriptor["catalogSha256"] != hashlib.sha256(manifest_bytes).hexdigest()
            or type(size) is not int or not 0 < size <= 8 * 1024 * 1024):
        raise ValueError("Native null-help supplement identity mismatch")
    encoded = (root / descriptor["file"]).read_bytes()
    if hashlib.sha256(encoded).hexdigest() != descriptor["sha256"]:
        raise ValueError("Native null-help supplement hash mismatch")
    with gzip.GzipFile(fileobj=io.BytesIO(encoded)) as stream:
        decoded = stream.read(size + 1)
    if len(decoded) != size or hashlib.sha256(decoded).hexdigest() != descriptor["uncompressedSha256"]:
        raise ValueError("Native null-help supplement content mismatch")
    supplement = json.loads(decoded)
    if (supplement["sourceSha256"] != manifest["sourceSha256"]
            or type(descriptor["nativeHelpFields"]) is not int
            or len(supplement["fields"]) != descriptor["nativeHelpFields"]):
        raise ValueError("Native null-help supplement payload mismatch")
    for address, field in supplement["fields"].items():
        native = fields.get(address)
        if (not native or isinstance(native.get("help"), str)
                or native["name"] != field["name"] or native["type"] != field["type"]
                or type(field["type"]) is not int
                or not isinstance(field["help"], str) or not field["help"].strip()):
            raise ValueError(f"Native null-help supplement field mismatch: {address}")
        fields[address] = field
    sources = {field["help"] for field in fields.values() if isinstance(field.get("help"), str) and field["help"].strip()}
    # Strict spelling readers use captured file-reader help outside the GUI catalog.
    for name in ["lspp-contact-id-mpp-fixed-readers.json", "lspp-contact-mpp-tail-readers.json"]:
        reader = json.loads((ROOT / "keywords/runtime/native-readers" / name).read_bytes())
        if reader["sourceSha256"] != manifest["sourceSha256"]:
            raise ValueError(f"Native reader source mismatch: {name}")
        texts = reader["fieldHelpByAddress"].values()
        if any(not isinstance(text, str) for text in texts):
            raise ValueError(f"Native reader help is not text: {name}")
        sources.update(text for text in texts if text.strip())
    return sources


def parameter_sources() -> set[str]:
    source = (ROOT / "src/core/keywordSchema.ts").read_text(encoding="utf-8")
    block = source.split("const PARAMETER_MANUAL_HELP:", 1)[1].split("function parameterFieldHelp", 1)[0]
    return {ast.literal_eval(text) for text in re.findall(r"'(?:\\.|[^'\\])*'", block)}


def translation_errors(rows: list[dict], sources: set[str]) -> list[str]:
    allowed = {normalize(text) for text in sources}
    seen = set()
    errors = []
    for index, row in enumerate(rows):
        english, localized = row.get("english", ""), row.get("localized", "")
        label = f"translation[{index}]"
        normalized = normalize(english)
        if not normalized or normalized not in allowed:
            errors.append(f"{label}: source is not in the current native/parameter corpus")
        if normalized in seen:
            errors.append(f"{label}: duplicate normalized source")
        seen.add(normalized)
        if not re.search(r"[\u3400-\u9fff]", localized):
            errors.append(f"{label}: Chinese translation missing")
        if forbidden_help_characters(localized):
            errors.append(f"{label}: forbidden character in Chinese text")
        # Native extraction may legitimately use tabs/CR for layout. Other
        # forbidden source characters must be disclosed, never silently guessed.
        source_damage = forbidden_help_characters(english.replace("\t", "").replace("\r", ""))
        if source_damage and not row.get("sourceIssue"):
            errors.append(f"{label}: damaged source requires sourceIssue: {source_damage}")
        missing = [token for token in critical_source_tokens(english) if not protected_token_present(token, localized)]
        conditions = [pair for pair in source_condition_pairs(english) if not condition_pair_present(*pair, localized)]
        options = [token for token in _normalized_option_tokens(english, numeric_only=True)
                   if not _numeric_option_present(token, localized)]
        if missing or conditions or options:
            errors.append(f"{label}: protected tokens {missing}, conditions {conditions}, options {options}")
        if row.get("sourceIssue") and not re.search(r"原文|原始|缺失|乱码|无法确认|不完整|损坏", localized):
            errors.append(f"{label}: sourceIssue must also be disclosed in the displayed Chinese")
    return errors


def runtime_translation_errors(entries: dict, shards: dict, shard_size: int,
                               rows: list[dict], sources: set[str]) -> tuple[list[str], list[str]]:
    errors, missing = [], []
    reviewed = {key(row["english"]): row["localized"] for row in rows}
    for english in sorted(sources):
        identity = key(english)
        value = entries.get(identity)
        if isinstance(value, int) and not isinstance(value, bool):
            shard = shards.get(value // shard_size)
            offset = value - shard["start"] if shard else -1
            if not shard or not 0 <= offset < len(shard["english"]):
                errors.append(f"Invalid source slot for {english[:80]!r}")
                continue
            if normalize(shard["english"][offset]) != normalize(english):
                errors.append(f"Wrong source slot for {english[:80]!r}")
            value = shard["localized"][offset]
        if not isinstance(value, str) or not re.search(r"[\u3400-\u9fff]", value):
            missing.append(english)
        if identity in reviewed and value != reviewed[identity]:
            errors.append(f"Runtime translation differs from reviewed text for {english[:80]!r}")
    return errors, missing


def main() -> int:
    sources = native_sources() | parameter_sources()
    path = ROOT / "keywords/authoring/native_field_help_zh.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    errors = translation_errors(rows, sources)
    runtime = ROOT / "out/runtime/field_help"
    manifest = json.loads((runtime / "manifest.json").read_text(encoding="utf-8"))
    for name, property_name in [("field_data.json", "baseSha256"), ("field_data_zh.json", "localizedSourceSha256")]:
        if manifest[property_name] != hashlib.sha256((ROOT / "keywords" / ("runtime/schema" if name == "field_data.json" else "authoring") / name).read_bytes()).hexdigest():
            errors.append(f"Runtime manifest is stale for {name}")
    descriptor = manifest.get("textIndex", {})
    if descriptor.get("sourceSha256") != hashlib.sha256(path.read_bytes()).hexdigest():
        errors.append("Runtime text index is stale; rebuild field-help runtime")
    encoded = (runtime / "text-index.json.gz").read_bytes()
    if hashlib.sha256(encoded).hexdigest() != descriptor.get("sha256"):
        errors.append("Runtime text index hash mismatch")
    entries = json.loads(gzip.decompress(encoded))
    shards = {}
    for entry in manifest["shards"]:
        encoded_shard = (runtime / "shards" / entry["file"]).read_bytes()
        shard = json.loads(gzip.decompress(encoded_shard))
        if (hashlib.sha256(encoded_shard).hexdigest() != entry["sha256"]
                or len(encoded_shard) != entry["compressedBytes"]
                or shard["baseSha256"] != manifest["baseSha256"]
                or shard["start"] != entry["start"] or shard["count"] != entry["count"]
                or len(shard["english"]) != entry["count"] or len(shard["localized"]) != entry["count"]):
            errors.append(f"Runtime shard identity/shape mismatch: {entry['file']}")
        shards[entry["shardIndex"]] = shard
    runtime_errors, missing = runtime_translation_errors(entries, shards, manifest["shardSize"], rows, sources)
    errors.extend(runtime_errors)
    summary = {"source_count": len(sources), "reviewed_entries": len(rows),
               "source_issue_entries": sum(bool(row.get("sourceIssue")) for row in rows),
               "untranslated_count": len(missing), "errors": errors,
               "missing_examples": [text[:160] for text in missing[:10]]}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return int(bool(errors or missing))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
