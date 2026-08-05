#!/usr/bin/env python3
"""Enforce final, report-free quality gates for ``field_data_zh.json``."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


KEYWORDS_DIR = Path(__file__).resolve().parent
DEFAULT_ENGLISH_PATH = KEYWORDS_DIR / "field_data.json"
DEFAULT_LOCALIZED_PATH = KEYWORDS_DIR / "field_data_zh.json"

TEMPLATE_RE = re.compile(
    r"^字段\s+[^；；]+的参数说明；请依据源文定义该字段的物理含义、取值范围及选项。"
)
ENGLISH_RESIDUE_RE = re.compile(
    r"\b(?:the|with|for|from|must|option|define|specify|when|please|except|"
    r"automatically|determined|through|beginning|existing|respectively|thus)\b"
)
# A line break between two Chinese sentences is legitimate.  Only horizontal
# whitespace is a mechanical translation artefact (for example ``参数 说明``).
MECHANICAL_SPACING_RE = re.compile(r"[\u3400-\u9fff][^\S\r\n]+[\u3400-\u9fff]")
LATIN_WORD_RE = re.compile(r"[A-Za-z]+(?:[-'][A-Za-z]+)*")
CONDITION_PAIR_RE = re.compile(
    r"\b([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*([-+]?(?:\d+(?:\.\d+)?|\.\d+))\b"
)
MIXED_TERM_RULES = {
    "low_regime_machine_translation": re.compile(r"低制度弹簧"),
    "high_regime_machine_translation": re.compile(r"高制度弹簧"),
    "general_remarks_residue": re.compile(r"\bGeneral Remarks\b"),
    "normal_format_machine_translation": re.compile(r"法向格式"),
    "new_legends_residue": re.compile(r"\bNew Legends\b"),
    "lowercase_segment_residue": re.compile(r"(?<![A-Za-z_])segment\b"),
    "lowercase_card_residue": re.compile(r"(?<![A-Za-z_])cards?\b"),
    "lowercase_rank_residue": re.compile(r"(?<![A-Za-z_])rank\b"),
    "lowercase_ascii_residue": re.compile(r"(?<![A-Za-z_])ascii\b"),
    "time_birth_residue": re.compile(r"\btime\s*=\s*BIRTH\b"),
    "joint_label_residue": re.compile(
        r"\b(?:Gears|Rack and Pinion|Pulley|Screw|Motors|Harmonic)\b"
    ),
    # Final user-facing translations must not contain audit/process notes.
    "process_annotation_residue": re.compile(r"英文源|独立盲审译文|翻译记录|候选译文"),
}
PROTECTED_SOURCE_TOKEN_RE = re.compile(
    r"(?:\*[A-Z0-9_?+-]+|\b(?:EQ|NE|GT|GE|LT|LE)\.|"
    r"\b(?:AND|OR|IF|MPP|SMP|ICFD|SPH|ALE|FSI|NURBS|ID|PID|SID|CID|DOF|SEI|AMMG)\b|"
    r"(?<![A-Za-z])[-+]?\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?|\b\d+[A-Z]\b)"
)
MECHANICAL_MARKERS = (
    "字段说明：",
    "独立盲审译文：",
    "翻译：",
    "source-preserving",
)
REQUIRED_TERMS = {
    "node": "节点",
    "element": "单元",
    "part": "部件",
    "set": "集合",
    "contact": "接触",
    "rigid body": "刚体",
    "load curve": "载荷曲线",
    "coordinate system": "坐标系",
    "degree of freedom": "自由度",
    "default": "默认值",
    "stress": "应力",
    "strain": "应变",
    "failure": "失效",
    "damage": "损伤",
    "fracture": "断裂",
    "friction": "摩擦",
    "normal": "法向",
    "tangential": "切向",
    "volume": "体积",
    "mass flow rate": "质量流率",
    "boundary condition": "边界条件",
    "ignored": "将被忽略",
    "material axes": "材料轴",
    "material direction": "材料方向",
    "locally orthotropic": "局部正交各向异性",
    "globally orthotropic": "全局正交各向异性",
    "normal vector": "法向量",
    "midsurface": "中面",
    "inner surface": "内表面",
    "outer surface": "外表面",
    "connectivity": "连接关系",
    "cross product": "叉积",
    "cylindrical coordinate system": "柱坐标系",
    "centerline axis": "中心线轴",
    "fiber direction": "纤维方向",
    "axisymmetric analysis": "轴对称分析",
    "planar analysis": "平面分析",
    "solid element": "实体单元",
    "shell element": "壳单元",
    "hexahedron": "六面体单元",
    "interface force": "界面力",
    "wear": "磨损",
    "springback": "回弹",
    "Newton scheme": "牛顿法",
    "convergence criterion": "收敛判据",
    "tolerance": "容差",
    "clamping": "钳位",
    "material fraction": "材料分数",
    "volume fraction": "体积分数",
}

# These tokens are removed before looking for copied English prose.  They are
# identifiers, keyword names, formulas, or solver-facing abbreviations rather
# than translatable sentences.
PROTECTED_LATIN_RE = re.compile(
    r"`[^`]*`|\*[A-Z0-9_?+\-]+|&[A-Za-z_][A-Za-z0-9_-]*|"
    r"\b[A-Z][A-Z0-9_]{1,}\b"
)
NON_CRITICAL_PROTECTED_TOKENS = {
    "ALE", "AMMG", "AND", "CID", "DOF", "EQ", "FSI", "GE", "GT", "ICFD",
    "IF", "LE", "LT", "MPP", "NE", "NOT", "NURBS", "OFF", "ON", "OR",
    "PID", "SEI", "SID", "SMP", "SPH",
}
IGNORED_LATIN_WORDS = {
    "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh",
    "aint", "cm", "cos", "cosh", "csc", "ctn", "deg", "dm", "exp",
    "false", "ft", "ghz", "gpa", "hz", "inch", "kg", "khz", "kn",
    "km", "kpa", "lb", "lbf", "ln", "log", "log10", "max", "mg",
    "mhz", "min", "mm", "mod", "mpa", "ms", "msec", "nint", "ns",
    "nt", "pa", "pres", "psi", "rad", "rpm", "sec", "sign", "sin",
    "sinh", "slug", "sqrt", "tan", "tanh", "temp", "true", "v", "vx",
    "vy", "vz",
}

# Four-word overlap is useful for finding copied English prose, but many
# solver formulas and file/keyword identifiers naturally repeat English words
# (for example "vx vy vz temp" or "Gauss Legendre"). These terms are
# ignored when deciding whether an overlap is prose rather than notation.
TECHNICAL_OVERLAP_WORDS = {
    "acos", "acosh", "alfa", "anint", "asin", "asinh", "atan", "atan2",
    "atanh", "axis", "beam", "calcium", "centroid", "circuit", "circuitsource",
    "component", "contact", "cosh", "csc", "ctn", "current", "dat", "ddx",
    "ddy", "ddz", "density", "depth", "drag", "dynain", "elout", "elastic",
    "element", "energy", "enstrophy", "exchanger", "flux", "ft", "gauss",
    "geometry", "heat", "inch", "initial", "internal", "ke", "kn", "lb",
    "legendre", "lbf", "lifepo", "material", "matsum", "max", "miller",
    "min", "momentum", "ms", "msec", "nt", "one", "option", "part", "plot",
    "pres", "pressure", "psi", "qr", "rms", "sec", "segment", "settings",
    "sign", "sliding", "slug", "source", "surface", "system", "tdc", "temp",
    "tiebreak", "time", "total", "transform", "velocity", "var", "vorticity",
    "volume", "way", "wear", "x", "y", "z", "ctof", "ftoc", "ftok", "ktof",
    "ktoc", "ctok", "vx", "vy", "vz", "bx", "by", "bz", "ex", "ey", "ez",
    "fx", "fy", "fz", "coupling", "commands", "reference", "level", "rigid",
    "offset", "before", "inc", "tied", "edge", "nodes", "recommended", "triangular",
    "shell", "area", "weighted", "remark", "axisymmetric", "solid", "symmetry",
    "stretch", "integrated", "fully", "thickness", "kirchhoff", "plane", "stress",
    "strain", "belytschko", "hughes", "liu", "leviathan", "pian", "sumihara",
}
PROSE_OVERLAP_WORDS = {
    "a", "an", "and", "are", "as", "at", "before", "being", "by", "can",
    "computed", "defined", "denotes", "during", "excluded", "for", "from",
    "given", "if", "included", "into", "is", "must", "not", "of", "only",
    "provided", "represents", "respectively", "see", "set", "should", "the",
    "these", "this", "those", "to", "used", "using", "when", "where", "with",
    "without",
}
PROSE_SIGNAL_WORDS = PROSE_OVERLAP_WORDS - {
    "a", "an", "and", "as", "at", "by", "for", "from", "if", "into", "is",
    "of", "only", "the", "to", "when", "where", "with", "without",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def iter_help_occurrences(
    english: Any,
    localized: Any,
    path: str = "",
) -> Iterable[tuple[str, str, str, str]]:
    """Yield path, English source, Chinese suffix, and raw localized help."""
    if isinstance(english, dict):
        localized_dict = localized if isinstance(localized, dict) else {}
        source = english.get("h")
        if isinstance(source, str) and source:
            raw = localized_dict.get("h", "")
            raw = raw if isinstance(raw, str) else ""
            prefix = f"{source}\n"
            suffix = raw[len(prefix):] if raw.startswith(prefix) else ""
            yield f"{path}.h" if path else "h", source, suffix, raw
        for key, child in english.items():
            if key == "h":
                continue
            child_path = f"{path}.{key}" if path else key
            yield from iter_help_occurrences(child, localized_dict.get(key), child_path)
        return

    if isinstance(english, list):
        localized_list = localized if isinstance(localized, list) else []
        for index, child in enumerate(english):
            localized_child = localized_list[index] if index < len(localized_list) else None
            yield from iter_help_occurrences(child, localized_child, f"{path}[{index}]")


def protected_source_tokens(source: str) -> list[str]:
    return list(dict.fromkeys(PROTECTED_SOURCE_TOKEN_RE.findall(source)))


def critical_source_tokens(source: str) -> list[str]:
    """Return solver names whose loss can change the meaning of a translation."""
    critical: list[str] = []
    for token in protected_source_tokens(source):
        if token.startswith("*"):
            body = token[1:]
            # Formula multiplication (``*2``, ``*K``, ``*PI``) and variable
            # prefixes ending in an underscore are not complete keyword names.
            # Keep actual keyword-like names, including the historical source
            # spellings containing ``?`` or an internal hyphen.
            if len(body) >= 5 and "_" in body and not body.endswith("_"):
                critical.append(token)
            continue
        if (
            re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", token)
            and token not in NON_CRITICAL_PROTECTED_TOKENS
        ):
            critical.append(token)
    return critical


def protected_token_present(token: str, suffix: str) -> bool:
    """Match minor legacy spelling differences in keyword names."""
    if not token.startswith("*"):
        return token in suffix
    normalized_token = token.replace("?", "").replace("-", "").replace("_", "")
    normalized_suffix = suffix.replace("?", "").replace("-", "").replace("_", "")
    return token in suffix or normalized_token in normalized_suffix


def source_condition_pairs(source: str) -> list[tuple[str, str]]:
    """Return explicit solver condition pairs whose loss changes semantics."""
    return list(dict.fromkeys(CONDITION_PAIR_RE.findall(source)))


def condition_pair_present(name: str, value: str, suffix: str) -> bool:
    # Keep the solver variable/value pair even when the Chinese prose uses
    # natural wording such as ``PFORM 设为 0`` or ``TBEG 默认值为 0.0``.
    suffix = suffix.replace("−", "-").replace("–", "-")
    try:
        from decimal import Decimal

        canonical_value = format(Decimal(value), "f").rstrip("0").rstrip(".")
        if canonical_value in {"", "-0"}:
            canonical_value = "0"
    except Exception:
        canonical_value = value
    numeric_variants = {value, canonical_value}
    name_variants = {name}
    name_variants.update({
        "OPTION": "选项",
        "TYPE": "类型",
        "EQ": "EQ",
    }.get(name, ""))
    name_variants.discard("")
    relation = r"(?:=|设为|设置为|取值为|取|等于|为|是)"
    for name_variant in name_variants:
        for value_variant in numeric_variants:
            direct = re.compile(
                r"\b" + re.escape(name_variant) + r"\s*=\s*"
                + re.escape(value_variant) + r"(?![0-9A-Za-z])"
            )
            dotted = re.compile(
                r"\b" + re.escape(name_variant) + r"\s*[.:]\s*"
                + re.escape(value_variant) + r"(?![0-9A-Za-z])"
            )
            natural = re.compile(
                r"\b" + re.escape(name_variant) + r"[^。；;\n]{0,24}"
                + relation + r"[^。；;\n]{0,12}" + re.escape(value_variant)
            )
            if direct.search(suffix) or dotted.search(suffix) or natural.search(suffix):
                return True
        # A negative-limit description such as ``MULO 为负（如 -1）`` is a
        # faithful rendering of the source condition ``MULO = -1``.
        if value.startswith("-") and re.search(
            r"\b" + re.escape(name_variant) + r"[^。；;\n]{0,24}为负", suffix
        ):
            return True
    return False


def _latin_words(value: str) -> list[str]:
    masked = PROTECTED_LATIN_RE.sub(" ", value)
    return [
        word.lower()
        for word in LATIN_WORD_RE.findall(masked)
        if len(word) > 1 and word.lower() not in IGNORED_LATIN_WORDS
    ]


def _source_phrase_residue(source: str, suffix: str, phrase_size: int = 4) -> list[str]:
    source_words = _latin_words(source)
    suffix_words = _latin_words(suffix)
    if len(source_words) < phrase_size or len(suffix_words) < phrase_size:
        return []
    source_phrases = {
        " ".join(source_words[index:index + phrase_size])
        for index in range(len(source_words) - phrase_size + 1)
    }
    suffix_phrases = {
        " ".join(suffix_words[index:index + phrase_size])
        for index in range(len(suffix_words) - phrase_size + 1)
    }
    return sorted(source_phrases & suffix_phrases)


def _copied_source_prose(source: str, suffix: str) -> list[str]:
    """Return source overlaps that look like copied natural-language prose."""
    phrases = _source_phrase_residue(source, suffix)
    copied: list[str] = []
    for phrase in phrases:
        words = set(phrase.split())
        if words & PROSE_SIGNAL_WORDS and not words <= TECHNICAL_OVERLAP_WORDS:
            copied.append(phrase)
    return copied


def _term_residue(source: str, suffix: str) -> list[str]:
    # Solver-facing identifiers such as ``OPTION.EQ.PART`` are intentionally
    # kept in English.  Mask those identifiers before checking for copied
    # prose terms so the gate only reports lower-case natural-language residue.
    suffix_for_terms = PROTECTED_LATIN_RE.sub(" ", suffix)
    residue: list[str] = []
    for term in REQUIRED_TERMS:
        boundary = r"(?<![A-Za-z0-9_*])" + re.escape(term) + r"(?![A-Za-z0-9_])"
        if re.search(boundary, source, re.IGNORECASE) and re.search(
            boundary, suffix_for_terms, re.IGNORECASE
        ):
            residue.append(term)
    return residue


def build_report(english: Any, localized: Any) -> dict[str, Any]:
    rows = list(iter_help_occurrences(english, localized))
    fallbacks: list[str] = []
    invalid_bilingual: list[str] = []
    templates: list[str] = []
    english_residue: list[str] = []
    mechanical_spacing: list[str] = []
    source_phrase_residue: list[dict[str, Any]] = []
    copied_source_prose: list[dict[str, Any]] = []
    review_queue: list[str] = []
    protected_omissions: list[dict[str, Any]] = []
    condition_omissions: list[dict[str, Any]] = []
    marker_counts: Counter[str] = Counter()
    terminology_residue: Counter[str] = Counter()
    mixed_term_residue: Counter[str] = Counter()
    by_source: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)

    for path, source, suffix, raw in rows:
        if raw == source:
            fallbacks.append(path)
        elif not raw.startswith(f"{source}\n"):
            invalid_bilingual.append(path)

        if TEMPLATE_RE.search(suffix):
            templates.append(path)
        if ENGLISH_RESIDUE_RE.search(suffix):
            english_residue.append(path)
        if MECHANICAL_SPACING_RE.search(suffix):
            mechanical_spacing.append(path)
        phrases = _source_phrase_residue(source, suffix)
        if phrases:
            source_phrase_residue.append({"path": path, "phrases": phrases})
        copied_phrases = _copied_source_prose(source, suffix)
        if copied_phrases:
            copied_source_prose.append({"path": path, "phrases": copied_phrases})
        if len(_latin_words(suffix)) >= 6:
            review_queue.append(path)
        for marker in MECHANICAL_MARKERS:
            marker_counts[marker] += suffix.count(marker)

        missing = [
            token for token in critical_source_tokens(source)
            if not protected_token_present(token, suffix)
        ]
        if missing:
            protected_omissions.append({"path": path, "tokens": missing})

        missing_conditions = [
            f"{name} = {value}"
            for name, value in source_condition_pairs(source)
            if not condition_pair_present(name, value, suffix)
        ]
        if missing_conditions:
            condition_omissions.append({"path": path, "conditions": missing_conditions})

        terminology_residue.update(_term_residue(source, suffix))
        for rule_name, rule in MIXED_TERM_RULES.items():
            if rule.search(suffix):
                mixed_term_residue[rule_name] += 1
        by_source[source].append((path, suffix))

    duplicate_groups: list[dict[str, Any]] = []
    consensus_repairable = 0
    for source, entries in by_source.items():
        variants = Counter(suffix for _, suffix in entries if suffix)
        if len(variants) <= 1:
            continue
        proper = [suffix for suffix in variants if not TEMPLATE_RE.search(suffix)]
        repairable = sum(
            count
            for suffix, count in variants.items()
            if TEMPLATE_RE.search(suffix) and proper
        )
        consensus_repairable += repairable
        duplicate_groups.append(
            {
                "source": source,
                "occurrences": len(entries),
                "variant_count": len(variants),
                "proper_variant_count": len(proper),
                "consensus_repairable": repairable,
            }
        )

    failures = {
        "fallback_occurrences": len(fallbacks),
        "invalid_bilingual_occurrences": len(invalid_bilingual),
        "mechanical_marker_occurrences": sum(marker_counts.values()),
        "generic_template_occurrences": len(templates),
        "protected_token_omissions": len(protected_omissions),
        "condition_pair_omissions": len(condition_omissions),
        "english_residue_occurrences": len(english_residue),
        "mechanical_spacing_occurrences": len(mechanical_spacing),
        "copied_source_prose_occurrences": len(copied_source_prose),
        "terminology_residue_occurrences": sum(terminology_residue.values()),
        "mixed_term_residue_occurrences": sum(mixed_term_residue.values()),
        "duplicate_consensus_repairable_occurrences": consensus_repairable,
    }
    status = "pass" if all(value == 0 for value in failures.values()) else "fail"

    return {
        "schema_version": 5,
        "occurrence_count": len(rows),
        **failures,
        "mechanical_marker_counts": dict(marker_counts),
        "terminology_residue_counts": dict(terminology_residue),
        "mixed_term_residue_counts": dict(mixed_term_residue),
        "source_phrase_residue_occurrences": len(source_phrase_residue),
        "duplicate_source_units_with_variants": len(duplicate_groups),
        "examples": {
            "fallback_paths": fallbacks[:100],
            "invalid_bilingual_paths": invalid_bilingual[:100],
            "generic_template_paths": templates[:100],
            "english_residue_paths": english_residue[:100],
            "mechanical_spacing_paths": mechanical_spacing[:100],
            "source_phrase_residue_paths": source_phrase_residue[:100],
            "copied_source_prose_paths": copied_source_prose[:100],
            "review_queue_paths": review_queue[:100],
            "protected_token_omissions": protected_omissions[:100],
            "condition_pair_omissions": condition_omissions[:100],
            "duplicate_variants": sorted(
                duplicate_groups,
                key=lambda item: (-item["consensus_repairable"], -item["variant_count"]),
            )[:100],
        },
        "quality_gate": {
            "status": status,
            "requirements": {key: value == 0 for key, value in failures.items()},
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--english", type=Path, default=DEFAULT_ENGLISH_PATH)
    parser.add_argument("--localized", type=Path, default=DEFAULT_LOCALIZED_PATH)
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional diagnostic JSON. CI and normal maintenance do not create a report.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report(load_json(args.english), load_json(args.localized))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    summary = {
        "quality_gate": report["quality_gate"],
        "counts": {
            key: report[key]
            for key in report["quality_gate"]["requirements"]
        },
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if report["quality_gate"]["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
