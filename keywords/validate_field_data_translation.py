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
from collections import defaultdict
from pathlib import Path
from typing import Any


KEYWORDS_DIR = Path(__file__).resolve().parent
DEFAULT_ENGLISH_PATH = KEYWORDS_DIR / "field_data.json"
DEFAULT_LOCALIZED_PATH = KEYWORDS_DIR / "field_data_zh.json"
MAT_ADD_EROSION_OVERLAY_PATH = (
    KEYWORDS_DIR / "compatibility" / "mat_add_erosion_legacy_fields.json"
)
TRANSLATABLE_KEYS = {"h", "description", "desc", "summary"}
HAN_RANGE_START = "\u3400"
HAN_RANGE_END = "\u9fff"


def load_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, data: Any) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write("\n")


def _mat_add_erosion_damage_card(entry: Any, keyword: str) -> list[dict[str, Any]]:
    cards = entry.get("c") if isinstance(entry, dict) else None
    candidates = [
        card
        for card in cards or []
        if isinstance(card, list)
        and len(card) == 8
        and str(card[0].get("n", "")).upper() == "IDAM"
        and str(card[-1].get("n", "")).upper() == "LCREGD"
    ]
    if len(candidates) != 1:
        raise ValueError(f"{keyword} must contain exactly one IDAM...LCREGD card")
    return candidates[0]


def apply_reviewed_compatibility_localizations(
    english: dict[str, Any],
    localized: dict[str, Any],
    overlay_path: Path = MAT_ADD_EROSION_OVERLAY_PATH,
) -> int:
    """Apply the reviewed bilingual help for local compatibility overlays."""
    overlay = load_json(overlay_path)
    present = [keyword in english for keyword in overlay["keywords"]]
    if not any(present):
        return 0
    if not all(present):
        raise ValueError("MAT_ADD_EROSION compatibility keyword pair is incomplete")
    changed = 0
    for keyword in overlay["keywords"]:
        english_card = _mat_add_erosion_damage_card(english.get(keyword), keyword)
        localized_card = _mat_add_erosion_damage_card(localized.get(keyword), keyword)
        english_signature = [field.get("n") for field in english_card]
        localized_signature = [field.get("n") for field in localized_card]
        if english_signature != overlay["restoredSignature"]:
            raise ValueError(
                f"{keyword} English compatibility signature is not restored: {english_signature}"
            )
        if localized_signature != english_signature:
            raise ValueError(
                f"{keyword} localized compatibility signature differs: {localized_signature}"
            )
        for offset, definition in enumerate(overlay["fields"], start=1):
            if english_card[offset].get("h") != definition["english"]:
                raise ValueError(
                    f"{keyword}.{definition['name']} English help changed; review the compatibility translation"
                )
            reviewed = f"{definition['english']}\n{definition['chinese']}"
            if localized_card[offset].get("h") != reviewed:
                localized_card[offset]["h"] = reviewed
                changed += 1
    return changed


def find_compatibility_localization_errors(
    english: dict[str, Any], localized: dict[str, Any]
) -> list[str]:
    candidate = copy.deepcopy(localized)
    try:
        changed = apply_reviewed_compatibility_localizations(english, candidate)
    except (KeyError, TypeError, ValueError) as error:
        return [f"MAT_ADD_EROSION compatibility localization: {error}"]
    if changed:
        return [
            f"MAT_ADD_EROSION compatibility localization is stale in {changed} field occurrences"
        ]
    return []


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


def contains_han_text(value: Any) -> bool:
    return any(HAN_RANGE_START <= char <= HAN_RANGE_END for char in str(value or ""))


def is_valid_localized_help(english_help: str, localized_help: str) -> bool:
    """Accept an English fallback or English followed by a Chinese translation."""
    if localized_help == english_help:
        return True
    if not english_help:
        return False
    prefix = f"{english_help}\n"
    return localized_help.startswith(prefix) and contains_han_text(localized_help[len(prefix):])


def find_invalid_bilingual_help(english: Any, localized: Any, path: str = "") -> list[str]:
    """Return help paths that violate the English-prefix bilingual contract."""
    errors: list[str] = []
    if isinstance(english, dict):
        localized_dict = localized if isinstance(localized, dict) else {}
        english_help = str(english.get("h") or "")
        localized_help = str(localized_dict.get("h") or "")
        if "h" in english and not is_valid_localized_help(english_help, localized_help):
            field_name = english.get("n")
            suffix = f" ({field_name})" if field_name else ""
            errors.append(
                f"{_format_path(path)}.h{suffix}: expected exact English fallback or "
                "English source followed by a newline and Chinese translation"
            )

        for key, english_value in english.items():
            if key == "h":
                continue
            next_path = f"{path}.{key}" if path else key
            errors.extend(find_invalid_bilingual_help(english_value, localized_dict.get(key), next_path))
        return errors

    if isinstance(english, list):
        localized_list = localized if isinstance(localized, list) else []
        for index, english_item in enumerate(english):
            localized_item = localized_list[index] if index < len(localized_list) else None
            errors.extend(find_invalid_bilingual_help(english_item, localized_item, f"{path}[{index}]"))
        return errors

    return errors


def find_untranslated_help(english: Any, localized: Any, path: str = "") -> list[str]:
    """Return paths whose localized help text still lacks Chinese text."""
    errors: list[str] = []
    if isinstance(english, dict):
        localized_dict = localized if isinstance(localized, dict) else {}
        english_help = str(english.get("h") or "")
        localized_help = str(localized_dict.get("h") or "")
        if english_help and not contains_han_text(localized_help):
            field_name = english.get("n")
            suffix = f" ({field_name})" if field_name else ""
            errors.append(f"{_format_path(path)}.h{suffix}: missing Chinese help text")

        for key, english_value in english.items():
            if key == "h":
                continue
            next_path = f"{path}.{key}" if path else key
            errors.extend(find_untranslated_help(english_value, localized_dict.get(key), next_path))
        return errors

    if isinstance(english, list):
        localized_list = localized if isinstance(localized, list) else []
        for index, english_item in enumerate(english):
            localized_item = localized_list[index] if index < len(localized_list) else None
            errors.extend(find_untranslated_help(english_item, localized_item, f"{path}[{index}]"))
        return errors

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


def _collect_translation_memory(
    previous_english: Any,
    localized: Any,
    memory: dict[str, set[str]],
) -> None:
    if isinstance(previous_english, dict):
        localized_dict = localized if isinstance(localized, dict) else {}
        for key, previous_value in previous_english.items():
            localized_value = localized_dict.get(key)
            if (
                key in TRANSLATABLE_KEYS
                and isinstance(previous_value, str)
                and isinstance(localized_value, str)
            ):
                memory[previous_value].add(localized_value)
            else:
                _collect_translation_memory(previous_value, localized_value, memory)
        return

    if isinstance(previous_english, list):
        localized_list = localized if isinstance(localized, list) else []
        for index, previous_item in enumerate(previous_english):
            localized_item = localized_list[index] if index < len(localized_list) else None
            _collect_translation_memory(previous_item, localized_item, memory)


def _select_localized_text(
    english_value: str,
    previous_english_value: Any,
    localized_value: Any,
    memory: dict[str, set[str]],
) -> str:
    if isinstance(previous_english_value, str) and previous_english_value == english_value:
        if isinstance(localized_value, str) and is_valid_localized_help(english_value, localized_value):
            return copy.deepcopy(localized_value)

    candidates = {
        candidate
        for candidate in memory.get(english_value, set())
        if is_valid_localized_help(english_value, candidate)
    }
    if len(candidates) == 1:
        return copy.deepcopy(next(iter(candidates)))

    return copy.deepcopy(english_value)


def sync_translation_data(
    english: Any,
    localized: Any,
    previous_english: Any | None = None,
) -> Any:
    """Return a structural English mirror with only source-matched translations retained."""
    translation_memory: dict[str, set[str]] = defaultdict(set)
    if previous_english is not None:
        _collect_translation_memory(previous_english, localized, translation_memory)
    return _sync_translation_data(english, localized, previous_english, translation_memory)


def _sync_translation_data(
    english: Any,
    localized: Any,
    previous_english: Any,
    translation_memory: dict[str, set[str]],
) -> Any:
    if isinstance(english, dict):
        result: dict[str, Any] = {}
        localized_dict = localized if isinstance(localized, dict) else {}
        previous_dict = previous_english if isinstance(previous_english, dict) else {}
        for key, english_value in english.items():
            localized_value = localized_dict.get(key)
            previous_value = previous_dict.get(key)
            if key in TRANSLATABLE_KEYS and isinstance(english_value, str):
                result[key] = _select_localized_text(
                    english_value,
                    previous_value,
                    localized_value,
                    translation_memory,
                )
            else:
                result[key] = _sync_translation_data(
                    english_value,
                    localized_value,
                    previous_value,
                    translation_memory,
                )
        return result

    if isinstance(english, list):
        localized_list = localized if isinstance(localized, list) else []
        previous_list = previous_english if isinstance(previous_english, list) else []
        result = []
        for index, english_item in enumerate(english):
            localized_item = localized_list[index] if index < len(localized_list) else None
            previous_item = previous_list[index] if index < len(previous_list) else None
            result.append(
                _sync_translation_data(
                    english_item,
                    localized_item,
                    previous_item,
                    translation_memory,
                )
            )
        return result

    return copy.deepcopy(english)


def sync_translation_file(
    english_path: Path = DEFAULT_ENGLISH_PATH,
    localized_path: Path = DEFAULT_LOCALIZED_PATH,
    previous_english_path: Path | None = None,
) -> list[str]:
    english = load_json(english_path)
    localized = load_json(localized_path) if localized_path.exists() else {}
    previous_english = (
        load_json(previous_english_path)
        if previous_english_path is not None
        else None
    )
    synced = sync_translation_data(english, localized, previous_english)
    apply_reviewed_compatibility_localizations(english, synced)
    write_json(localized_path, synced)
    return [
        *compare_field_data_structure(english, synced),
        *find_invalid_bilingual_help(english, synced),
        *find_compatibility_localization_errors(english, synced),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--english", type=Path, default=DEFAULT_ENGLISH_PATH)
    parser.add_argument("--localized", type=Path, default=DEFAULT_LOCALIZED_PATH)
    parser.add_argument("--sync", action="store_true", help="Update localized JSON with English structural fallback.")
    parser.add_argument(
        "--previous-english",
        type=Path,
        help=(
            "Pre-update English schema. Only localized text whose English source still "
            "matches is retained; unmatched text safely falls back to current English."
        ),
    )
    parser.add_argument("--check-content", action="store_true", help="Require localized help text to contain Chinese text.")
    args = parser.parse_args(argv)

    if args.sync:
        errors = sync_translation_file(
            args.english,
            args.localized,
            args.previous_english,
        )
    else:
        english = load_json(args.english)
        localized = load_json(args.localized)
        errors = compare_field_data_structure(english, localized)
        errors.extend(find_invalid_bilingual_help(english, localized))
        errors.extend(find_compatibility_localization_errors(english, localized))
        if args.check_content:
            errors.extend(find_untranslated_help(english, localized))

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
