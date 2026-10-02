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
_APPROVED_QUESTION_MARK_LITERALS = (
    "*CONTACT_?_MPP",
    "em_[?].dat",
)

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


def unapproved_question_mark_count(text: str) -> int:
    """Count literal question marks that are not reviewed wildcard syntax."""

    remainder = text
    for literal in _APPROVED_QUESTION_MARK_LITERALS:
        remainder = remainder.replace(literal, "")
    # Ordinary sentence-ending English punctuation is valid.  Lost engineering
    # symbols occur inside identifiers/formulas or as a standalone glyph, so
    # they do not match this narrow punctuation form.
    remainder = re.sub(r"(?<=[A-Za-z0-9)])\?(?=\s|$)", "", remainder)
    return remainder.count("?")


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

    # Literal question marks already present in historical generated docstrings
    # are not caught by the U+FFFD gate above.  The following repairs were
    # reviewed against the official keyword manuals.  Keep them contextual:
    # an unrecognized question mark is rejected by ``sanitize_help_text``.
    text = text.replace("*CONTACT_?_MPP", "__LSDYNA_CONTACT_WILDCARD__")
    text = text.replace("SEII0 ? 0.0", "SEII0 != 0.0")
    text = text.replace("HLCID ? 0", "HLCID != 0")
    text = text.replace("ELFORM ? 2", "ELFORM != 2")
    text = text.replace("R_2?R_1", "R_2/R_1")
    text = text.replace("RATIO ?LS-DYNA value", "RATIO * LS-DYNA value")
    text = text.replace("SF_?Z1", "SF_Z1")
    text = text.replace("R?in component calcium_dynamics", "R-prime in component calcium_dynamics")
    text = text.replace("Screw : define x ? / ?", "Screw : define x_dot / omega")
    text = text.replace("Remark???? 1", "Remark 1")
    text = text.replace("Card?4", "Card 4")
    text = text.replace("1 / ?2", "1 / sqrt(2)")
    text = text.replace("(3?2)", "(3/2)")

    # Restore keyword identifiers before repairing variable notation.  For
    # example, the trailing ``T_?`` in ``*DUALCESE_ENSIGHT_?TIME?SEQ`` must not
    # be mistaken for the environment-temperature symbol ``T_infinity``.
    text = text.replace("AUTOMATIC_?ONE_?WAY_?SURFACE_?TO_?SURFACE_?TIEBREAK", "AUTOMATIC_ONE_WAY_SURFACE_TO_SURFACE_TIEBREAK")
    text = text.replace("AUTOMATIC_?GENERAL", "AUTOMATIC_GENERAL")
    text = text.replace("AIRBAG_?CPG", "AIRBAG_CPG")
    text = text.replace("DEFINE_?FUNCTION", "DEFINE_FUNCTION")
    text = text.replace("* RIGIDWALL_?PLANAR", "*RIGIDWALL_PLANAR")
    text = text.replace("* ICFD_?PART_VOL", "*ICFD_PART_VOL")
    text = text.replace("* LOAD_?BODY", "*LOAD_BODY")
    text = text.replace("* MAT_?126", "*MAT_126")
    text = text.replace("* INCLUDE_?UNITCELL", "*INCLUDE_UNITCELL")
    text = text.replace("*DEFINE_COORDI_NATE_VECTOR", "*DEFINE_COORDINATE_VECTOR")
    text = text.replace("*DEFINE_COOR_DINATE_VECTOR", "*DEFINE_COORDINATE_VECTOR")
    text = text.replace("*DEFINE__COORDINATE_VECTOR", "*DEFINE_COORDINATE_VECTOR")
    text = text.replace("*DEFINE_TRANSFOR-MATION", "*DEFINE_TRANSFORMATION")
    text = text.replace("MAT_OPTION TROPIC_ELASTIC", "*MAT_OPTIONTROPIC_ELASTIC")
    text = text.replace("theangle BETA", "the angle BETA")
    text = text.replace("*CONTROL_IMPlICIT_SOLVER", "*CONTROL_IMPLICIT_SOLVER")
    text = re.sub(
        r"\*[A-Z][A-Z0-9_?+\-]*_[A-Z0-9_?+\-]+",
        lambda match: match.group(0).replace("?", ""),
        text,
    )

    text = text.replace("?_init", "omega_init")
    text = text.replace("?_min", "omega_min")
    text = text.replace("?_max", "omega_max")
    text = text.replace("alpha parameters ?_a and ?_c", "alpha parameters alpha_a and alpha_c")
    text = text.replace("stoichiometry clamp ? c?_clamp", "Stoichiometry clamp c_clamp")
    text = text.replace("overpotential clamp ? ??_clamp", "Overpotential clamp eta_clamp")
    text = text.replace("?_(f,a)", "rho_(f,a)")
    text = text.replace("?_(c,a)", "rho_(c,a)")
    text = text.replace(
        "(?Ea?_k/R,?Ea?_(D_s )/R, ?Ea?_(R_f )/R)",
        "(Delta Ea_k/R, Delta Ea_(D_s)/R, Delta Ea_(R_f)/R)",
    )
    text = text.replace("Initial ?.", "Initial alpha.")
    text = text.replace("Heat capacity ratio ?.", "Heat capacity ratio gamma.")
    text = text.replace("?Cp?_ej", "Cp_ej")
    text = text.replace("Surface emission coefficient ?_rad", "Surface emission coefficient epsilon_rad")
    text = text.replace("Product JWL constant ?", "Product JWL constant omega")
    text = text.replace("Parameter ?_0", "Parameter tau_0")
    text = text.replace("?_0", "tau_0")
    text = text.replace("Permittivity ?_0", "Permittivity epsilon_0")
    text = text.replace("Eigenvalue expansion factor ?.", "Eigenvalue expansion factor tau.")

    text = text.replace("kJ.?mol?^(-1)", "kJ*mol^(-1)")
    text = text.replace("mol.?kg?^(-1)", "mol*kg^(-1)")
    text = text.replace("J.?mol?^(-1)", "J*mol^(-1)")
    text = text.replace("m^3 ?.mol?^(-1)", "m^3*mol^(-1)")
    text = text.replace("J?kg?^(-1)", "J*kg^(-1)")
    text = re.sub(r"Ns\s*\?m\s*\*\*\s*2", "N*s/m^2", text)
    text = text.replace("N?s / m2", "N*s/m^2")
    text = text.replace("W/m?K", "W/(m*K)")
    text = text.replace("W ?m", "W/(m*K)")

    text = text.replace("Material viscosity/damping control coefficient, ?.", "Material viscosity/damping control coefficient, alpha.")
    text = text.replace("Numerical viscosity control coefficient, ?.", "Numerical viscosity control coefficient, beta.")
    text = text.replace("0<=?<=1", "0<=beta<=1")
    text = text.replace("Stability control coefficient, ?.", "Stability control coefficient, epsilon.")
    text = text.replace("?(2 / 2) ", "")
    text = text.replace("A vector, b ?, in", "A vector, b, in")
    text = text.replace("direction of a x b ?,", "direction of a x b,")
    text = text.replace("? = A exp?(B / T)", "mu = A exp(B / T)")
    text = text.replace("?_r=?/?_0", "mu_r=mu/mu_0")
    text = text.replace("?_r=?/tau_0", "mu_r=mu/mu_0")
    text = text.replace("nonlinear behavior of ?.", "nonlinear behavior of mu.")
    text = text.replace("B=?H", "B=mu*H")
    text = text.replace("B = ?H", "B = mu*H")
    text = text.replace("H = B / ?", "H = B / mu")
    text = text.replace("C_3?", "C_3epsilon")
    text = text.replace("k or ? ? solve", "k or nu_tilde solve")
    text = text.replace("?/? solve", "epsilon/omega solve")
    text = text.replace("k - ? model", "k-epsilon model")
    text = text.replace("T_?", "T_infinity")

    text = text.replace("NINT(RR)?NINT(RS)?NINT(RT)", "NINT(RR) x NINT(RS) x NINT(RT)")
    text = text.replace("NINT(RR)?NINT(RS)", "NINT(RR) x NINT(RS)")
    text = text.replace("RR?RS?RT", "RR x RS x RT")
    text = text.replace("2??radians", "2*pi radians")
    text = text.replace("between 0 and 2?.", "between 0 and 2*pi.")
    text = text.replace("E1, ? E7", "E1, ..., E7")
    text = text.replace("_GENERAL?options", "_GENERAL options")
    text = text.replace("max?(", "max(")
    text = text.replace("L_s?(", "L_s/(")
    text = text.replace("L_t?(", "L_t/(")

    # The damaged glyphs in these coordinate-system descriptions only label
    # variables already named unambiguously in prose.  Removing the lost glyph
    # is safer than assigning one symbol to several differing conventions.
    text = text.replace("circumferential degree of freedom ?", "circumferential degree of freedom")
    text = text.replace("latitude degree of freedom  ?", "latitude degree of freedom")
    text = text.replace("latitude degree of freedom ?", "latitude degree of freedom")
    text = text.replace("longitude degree of freedom ?", "longitude degree of freedom")

    broken_reference = r"Error\s*!\s*Reference\s+source\s+not\s+found"
    text = re.sub(
        rf"Remark\s+{broken_reference}\s*\.?\s+of \*CONSTRAINED_JOINT_\.\.\.",
        "Remark 5 of *CONSTRAINED_JOINT_...",
        text,
        flags=re.IGNORECASE,
    )
    text = text.replace("Remark Remark 5 of *CONSTRAINED_JOINT_...", "Remark 5 of *CONSTRAINED_JOINT_...")
    text = re.sub(
        rf"Equations\s+{broken_reference}\s*\.?\s+and\s+{broken_reference}",
        "the relevant equations",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        rf"Figure\s+ERROR{broken_reference}",
        "the relevant figure",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        rf"See\s+{broken_reference}\s*\.?\s+in Appendix C",
        "See the relevant section in Appendix C",
        text,
        flags=re.IGNORECASE,
    )
    for label, replacement in (
        ("Remark", "the relevant remark"),
        ("Figure", "the relevant figure"),
        ("Table", "the relevant table"),
        ("Equation", "the relevant equation"),
    ):
        text = re.sub(
            rf"\b{label}\s+{broken_reference}",
            replacement,
            text,
            flags=re.IGNORECASE,
        )
    text = re.sub(
        r"(the relevant (?:remark|figure|table|equation))\.\s+(and\b)",
        r"\1 \2",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"(the relevant (?:remark|figure|table|equation))\.\s*(of\b)",
        r"\1 \2",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"(the relevant (?:remark|figure|table|equation))\.{2,}",
        r"\1.",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"(the relevant (?:remark|figure|table|equation))\.+(?=[A-Z][a-z])",
        r"\1. ",
        text,
        flags=re.IGNORECASE,
    )
    relevant_reference = r"the relevant (?:remarks?|figures?|tables?|equations?)"
    text = re.sub(
        rf"({relevant_reference})\.\s+(?=(?:in|of)\b)",
        r"\1 ",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        rf"({relevant_reference})\.(?=\))",
        r"\1",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        rf"({relevant_reference})\.,",
        r"\1,",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        rf"({relevant_reference}),\s+(?=for\b)",
        r"\1 ",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        rf"({relevant_reference})\s+of\s+(?=\*)",
        r"\1 in ",
        text,
        flags=re.IGNORECASE,
    )
    text = text.replace(
        "(see the relevant remark in *EFV_MAT)...(see the relevant remark in *EFV_MAT).",
        "(see the relevant remark in *EFV_MAT).",
    )
    text = text.replace(
        "(see the relevant remark in *EFV_MAT)...",
        "(see the relevant remark in *EFV_MAT).",
    )
    text = text.replace(
        "(see *PART)..(see the relevant remark in *EFV_MAT).",
        "(see *PART and the relevant remark in *EFV_MAT).",
    )
    text = text.replace("the relevant figure). a is", "the relevant figure); a is")
    text = re.sub(r"\b(used)\s*\.\s*\(see\b", r"\1 (see", text, flags=re.IGNORECASE)
    text = text.replace("Optional scale sactor", "Optional scale factor")
    text = text.replace("This field is ignore ELFORM != 2.", "This field is ignored if ELFORM != 2.")
    text = text.replace("*DEFINE_COORDINATE_VECTOR)..", "*DEFINE_COORDINATE_VECTOR).")
    text = text.replace(
        "Blast source ID (see *LOAD_BLAST_ENHANCED)D.",
        "Blast source ID (see *LOAD_BLAST_ENHANCED).",
    )
    text = text.replace("__LSDYNA_CONTACT_WILDCARD__", "*CONTACT_?_MPP")

    return text


def sanitize_help_text(text: str, *, path: str = "", field_name: str = "") -> str:
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
    if normalized.startswith("Nodal point ??") and re.fullmatch(r"N[1-8]", field_name):
        normalized = (
            f"Nodal point {field_name[1:]}. See Figure 19-26 of "
            "*ELEMENT_SHELL for the numbering sequence."
        )
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
    question_marks = unapproved_question_mark_count(normalized)
    if question_marks:
        raise HelpTextSanitizationError(
            f"unapproved literal question marks at {path or '<root>'}: {question_marks}"
        )
    return normalized


def sanitize_help_tree(value: object, *, path: str = "") -> object:
    """Recursively sanitize only ``h`` values in a generated field tree."""

    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if key == "h" and isinstance(child, str):
                result[key] = sanitize_help_text(
                    child,
                    path=child_path,
                    field_name=str(value.get("n", "")),
                )
            else:
                result[key] = sanitize_help_tree(child, path=child_path)
        return result
    if isinstance(value, list):
        return [sanitize_help_tree(child, path=f"{path}[{index}]") for index, child in enumerate(value)]
    return value
