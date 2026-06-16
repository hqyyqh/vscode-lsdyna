#!/usr/bin/env python3
"""Validate and synchronize localized LS-DYNA field data structure.

The localized field_data_zh.json file must mirror field_data.json structurally.
Only user-facing help/description text may differ; field names, positions,
widths, defaults, enums, options, aliases, variants, and active expressions must
stay identical.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any


KEYWORDS_DIR = Path(__file__).resolve().parent
DEFAULT_ENGLISH_PATH = KEYWORDS_DIR / "field_data.json"
DEFAULT_LOCALIZED_PATH = KEYWORDS_DIR / "field_data_zh.json"
TRANSLATABLE_KEYS = {"h", "description", "desc", "summary"}


def load_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, data: Any) -> None:
    with open(path, "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, separators=(",", ":"))


def _format_path(path: str) -> str:
    return path or "<root>"


def compare_field_data_structure(english: dict[str, Any], localized: dict[str, Any]) -> list[str]:
    """Return structural mismatches between English and localized field data."""
    errors: list[str] = []

    english_keys = set(english)
    localized_keys = set(localized)
    for key in sorted(english_keys - localized_keys):
        errors.append(f"missing localized keyword: {key}")
    for key in sorted(localized_keys - english_keys):
        errors.append(f"extra localized keyword: {key}")

    for key in sorted(english_keys & localized_keys):
        _compare_node(english[key], localized[key], key, errors)

    return errors


def _compare_node(english: Any, localized: Any, path: str, errors: list[str]) -> None:
    if isinstance(english, dict):
        if not isinstance(localized, dict):
            errors.append(f"{_format_path(path)}: expected object, got {type(localized).__name__}")
            return

        english_keys = set(english)
        localized_keys = set(localized)
        for key in sorted(english_keys - localized_keys):
            errors.append(f"{_format_path(path)}.{key}: missing localized key")
        for key in sorted(localized_keys - english_keys):
            errors.append(f"{_format_path(path)}.{key}: extra localized key")

        for key in sorted(english_keys & localized_keys):
            next_path = f"{path}.{key}" if path else key
            if key in TRANSLATABLE_KEYS:
                continue
            _compare_node(english[key], localized[key], next_path, errors)
        return

    if isinstance(english, list):
        if not isinstance(localized, list):
            errors.append(f"{_format_path(path)}: expected list, got {type(localized).__name__}")
            return
        if len(english) != len(localized):
            errors.append(f"{_format_path(path)}: length differs, expected {len(english)}, got {len(localized)}")
            return
        for index, english_item in enumerate(english):
            _compare_node(english_item, localized[index], f"{path}[{index}]", errors)
        return

    if english != localized:
        errors.append(f"{_format_path(path)}: expected {english!r}, got {localized!r}")


def sync_translation_data(english: Any, localized: Any) -> Any:
    """Return English data with localized text copied where structure still aligns."""
    if isinstance(english, dict):
        result: dict[str, Any] = {}
        localized_dict = localized if isinstance(localized, dict) else {}
        for key, english_value in english.items():
            localized_value = localized_dict.get(key)
            if key in TRANSLATABLE_KEYS and key in localized_dict:
                result[key] = copy.deepcopy(localized_value)
            else:
                result[key] = sync_translation_data(english_value, localized_value)
        return result

    if isinstance(english, list):
        localized_list = localized if isinstance(localized, list) else []
        result = []
        for index, english_item in enumerate(english):
            localized_item = localized_list[index] if index < len(localized_list) else None
            result.append(sync_translation_data(english_item, localized_item))
        return result

    return copy.deepcopy(english)


def sync_translation_file(
    english_path: Path = DEFAULT_ENGLISH_PATH,
    localized_path: Path = DEFAULT_LOCALIZED_PATH,
) -> list[str]:
    english = load_json(english_path)
    localized = load_json(localized_path) if localized_path.exists() else {}
    synced = sync_translation_data(english, localized)
    write_json(localized_path, synced)
    return compare_field_data_structure(english, synced)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--english", type=Path, default=DEFAULT_ENGLISH_PATH)
    parser.add_argument("--localized", type=Path, default=DEFAULT_LOCALIZED_PATH)
    parser.add_argument("--sync", action="store_true", help="Update localized JSON with English structural fallback.")
    args = parser.parse_args(argv)

    if args.sync:
        errors = sync_translation_file(args.english, args.localized)
    else:
        english = load_json(args.english)
        localized = load_json(args.localized)
        errors = compare_field_data_structure(english, localized)

    if errors:
        print("field_data translation structure check FAILED", file=sys.stderr)
        for error in errors[:200]:
            print(f"- {error}", file=sys.stderr)
        if len(errors) > 200:
            print(f"... {len(errors) - 200} more errors", file=sys.stderr)
        return 1

    print("field_data translation structure check PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
