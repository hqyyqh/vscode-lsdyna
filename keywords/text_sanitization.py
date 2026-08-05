#!/usr/bin/env python3
"""Normalize and validate solver help text at the generation boundary.

The generated English field data and the bilingual authoring mirror must never
contain encoding artifacts.  This module intentionally operates on help text
only; keyword names, field names, option values, and other schema literals are
not passed through it.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter


class HelpTextSanitizationError(ValueError):
    """Raised when help text contains an unsafe or ambiguous character."""


# These are formatting/control characters, not user-facing engineering text.
_REMOVABLE_FORMAT_CODEPOINTS = frozenset(
    {
        0x200B,  # ZERO WIDTH SPACE
        0x200C,  # ZERO WIDTH NON-JOINER
        0x200D,  # ZERO WIDTH JOINER
        0x200E,  # LEFT-TO-RIGHT MARK
        0x200F,  # RIGHT-TO-LEFT MARK
        0x2060,  # WORD JOINER
        0x2061,  # FUNCTION APPLICATION
        0x2062,  # INVISIBLE TIMES
        0x2063,  # INVISIBLE SEPARATOR
        0x2064,  # INVISIBLE PLUS
        0xFEFF,  # ZERO WIDTH NO-BREAK SPACE / BOM
    }
)

_BIDI_CONTROL_RANGES = ((0x202A, 0x202E), (0x2066, 0x2069))
_REPLACEMENT_CHARACTER = "\ufffd"

# Possessives verified against their full PyDYNA help-text contexts. U+FFFD is
# evidence of lost source data, so an arbitrary ``word�s`` must not be guessed.
_VERIFIED_POSSESSIVE_STEMS = (
    "element",
    "body",
    "contact",
    "software",
    "force",
    "airbag",
    "sheet",
    "Andrade",
    "liquid",
    "run",
    "calculation",
    "Young",
    "one",
    "ten",
    "hundred",
    "DYNA",
    "plane",
    "structure",
    "surface",
    "variable",
    "It",
    "steel",
)


def _is_bidi_control(codepoint: int) -> bool:
    return any(start <= codepoint <= end for start, end in _BIDI_CONTROL_RANGES)


def _is_noncharacter(codepoint: int) -> bool:
    return 0xFDD0 <= codepoint <= 0xFDEF or codepoint & 0xFFFF in (0xFFFE, 0xFFFF)


def forbidden_help_characters(text: str) -> Counter[str]:
    """Return forbidden code points in *text* with their occurrence counts.

    Newline is the only control character allowed in a help value.  Tabs are
    normalized to spaces before this check; carriage returns are normalized to
    LF.  Legitimate Chinese, Greek, mathematical, and unit symbols are not
    rejected merely because they are non-ASCII.
    """

    result: Counter[str] = Counter()
    for character in text:
        codepoint = ord(character)
        category = unicodedata.category(character)
        if character == _REPLACEMENT_CHARACTER:
            result[f"U+{codepoint:04X}"] += 1
        elif codepoint in _REMOVABLE_FORMAT_CODEPOINTS or _is_bidi_control(codepoint):
            result[f"U+{codepoint:04X}"] += 1
        elif _is_noncharacter(codepoint):
            result[f"U+{codepoint:04X}"] += 1
        elif category.startswith("C") and character != "\n":
            result[f"U+{codepoint:04X}"] += 1
    return result


def _repair_known_encoding_artifacts(text: str) -> str:
    """Repair deterministic source-artifact patterns before validation.

    PyDYNA's historical generated help contains replacement characters where
    punctuation or an ASCII wildcard was lost during extraction.  Each rule is
    deliberately contextual.  A remaining replacement character is treated as
    ambiguous and fails generation rather than being silently discarded.
    """

    # Historical generated Python docstrings also contain a few C0 sentinels
    # where the source extractor lost a line break or multiplication sign.
    text = text.replace("\x01", "\n")
    text = text.replace("\x02", "*")
    text = text.replace("\x03", "")
    text = text.replace("\x0c", "fi")
    text = text.replace("\x1e", "")
    text = text.replace("\x13", "")
    text = text.replace("Courant�CFriedrichs�CLewy", "Courant-Friedrichs-Lewy")
    text = text.replace("�1�", "1")
    text = text.replace("�+�", "+")

    # Protect quote-delimited command/file labels before possessive repair.
    text = text.replace("�em_[�].dat�", '"em_[?].dat"')
    text = text.replace("�emprint�", '"emprint"')
    for literal in ("R=", "sw1", "bem=filename", "lbem=filename2"):
        text = text.replace(f"�{literal}�", f'"{literal}"')

    # Possessives reviewed in the pinned source. Do not infer an apostrophe
    # from character adjacency: the replacement marker can represent many
    # unrelated symbols.
    for stem in _VERIFIED_POSSESSIVE_STEMS:
        text = text.replace(f"{stem}�s", f"{stem}'s")
    text = text.replace("shells� normal", "shells' normal")

    # Formula multiplication must be repaired before negative option values;
    # otherwise ``M�10`` is silently corrupted to ``M-10``.
    text = re.sub(r"(\d+(?:\.\d+)?)\s*�\s*10-(\d+)\b", r"\1 * 10^(-\2)", text)
    text = re.sub(r"(?<=[A-Za-z0-9])�(?=\d+\b)", " * ", text)
    text = re.sub(r"(?<=\d)�(?=[LMNP]\b)", " * ", text)
    text = text.replace("a�b", "a x b")
    text = text.replace("c�a", "c x a")

    # Numeric ranges/options and omitted-list markers.
    text = text.replace("�9", "-9")
    text = text.replace("�11", "-11")
    text = re.sub(r"(?<=E\d)�(?=E\d\b)", "-", text)
    text = re.sub(r",\s*�\s*,", ", ...,", text)
    text = re.sub(r",\s*�(?=\s+(?:will|are|and|or|if|E\d))", ", ...", text)
    text = re.sub(r"(?<=E\d)�(?=\s*(?:will|to|and|are|if))", "...", text)

    # ASCII-safe multiplication/range punctuation used in formulas.
    text = re.sub(r"(?<=stress)\s*�\s*(?=length)", " x ", text)
    text = re.sub(r"(?<=surface)\s*�\s*(?=on)", " - ", text)
    text = re.sub(r"(?<=only)\s*�\s*(?=on)", " - ", text)
    text = re.sub(r"(?<=symmetry)\s*�\s*(?=volume)", " - ", text)
    text = re.sub(r"(?<=symmetry\))\s*�\s*(?=volume)", " - ", text)
    text = re.sub(r"(?<=name)\s*�\s*(?=case)", " - ", text)

    # Quotation marks lost around a clearly delimited ASCII word/label.
    text = re.sub(r"�([A-Za-z][A-Za-z0-9_ -]*)�", r'"\1"', text)
    text = re.sub(r"�(?=\.\.\.)", '"', text)
    text = re.sub(r"(?<=\.\.\.)�", '"', text)
    text = text.replace('The "GEOM� column', 'The "GEOM" column')

    # Wildcard keyword spellings and engineering unit punctuation.
    text = text.replace("*CONTACT_�_MPP", "*CONTACT_?_MPP")
    text = text.replace("*CONTACT_..._MPP", "*CONTACT_?_MPP")
    text = text.replace("Butler�Volmer", "Butler-Volmer")
    text = text.replace("Gr�neisen", "Gruneisen")
    text = text.replace("B = �H", "B = mu*H")
    text = text.replace("recommended �C including", "recommended - including")
    text = text.replace("loading files �C to", "loading files - to")
    text = re.sub(r"�(?=C\b)", "deg ", text)
    text = re.sub(r"(?<![A-Za-z])�(?=s\b)", "u", text)

    # Greek-letter prose verified against the official PDF manual.  Spacing in
    # the damaged source distinguishes the k-epsilon/k-omega pair only within
    # this complete phrase, so repair the pair before the standalone k-omega.
    text = text.replace(
        "k � ? and k� ? models",
        "k-epsilon and k-omega models",
    )
    text = re.sub(r"\bk\s+�\s*\?", "k-omega", text)

    # Additional deterministic artifacts present in the checked-in PyDYNA
    # codegen used by the adapter tests.  These are all punctuation or quote
    # losses; an unrecognized replacement character must still fail below.
    text = text.replace(
        "\u00cf\u201eptional \u00e2\u20ac\u0153orthogonal\u00e2\u20ac\u009d",
        'optional "orthogonal"',
    )
    text = text.replace("beta\u0088 and", "beta and")
    text = text.replace("beta\u0088", "beta")
    text = text.replace("�adapt.msh", "adapt.msh")
    text = text.replace("�Dynain", "Dynain")
    text = text.replace("0.0 � the corresponding", "0.0; the corresponding")
    text = text.replace("�C", "-")
    text = text.replace("doesn�t", "doesn't")
    text = text.replace("�up�", '"up"')
    text = text.replace("�Up�", '"Up"')

    return text


def sanitize_help_text(text: str, *, path: str = "") -> str:
    """Return normalized help text or raise for an ambiguous artifact."""

    if not isinstance(text, str):
        raise TypeError(f"help text at {path or '<root>'} must be a string")

    normalized = unicodedata.normalize("NFC", text)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.replace("\t", "    ")
    # A few hand-authored bilingual values contain escaped layout markers as
    # two literal characters.  They must become real line breaks before the
    # English-prefix contract is checked.
    normalized = normalized.replace("\\r\\n", "\n").replace("\\n", "\n")
    normalized = normalized.replace("\\t", "    ")
    normalized = _repair_known_encoding_artifacts(normalized)
    removable = "".join(
        character
        for character in normalized
        if ord(character) in _REMOVABLE_FORMAT_CODEPOINTS
        or _is_bidi_control(ord(character))
    )
    if removable:
        normalized = "".join(
            character
            for character in normalized
            if ord(character) not in _REMOVABLE_FORMAT_CODEPOINTS
            and not _is_bidi_control(ord(character))
        )

    forbidden = forbidden_help_characters(normalized)
    if forbidden:
        details = ", ".join(f"{codepoint} x{count}" for codepoint, count in forbidden.items())
        raise HelpTextSanitizationError(
            f"ambiguous or forbidden help characters at {path or '<root>'}: {details}"
        )
    return normalized


def sanitize_help_tree(value: object, *, path: str = "") -> object:
    """Recursively sanitize only ``h`` values in a generated field tree."""

    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if key == "h" and isinstance(child, str):
                result[key] = sanitize_help_text(child, path=child_path)
            else:
                result[key] = sanitize_help_tree(child, path=child_path)
        return result
    if isinstance(value, list):
        return [sanitize_help_tree(child, path=f"{path}[{index}]") for index, child in enumerate(value)]
    return value
