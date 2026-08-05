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

from text_sanitization import (
    forbidden_help_characters,
    unapproved_question_mark_count,
)


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
    r"\b([A-Z][A-Z0-9_]*)[ \t]*"
    r"(?:(?:[ \t]+\.[ \t]*(EQ|NE|GT|GE|LT|LE)[ \t]*\.)|"
    r"(>=|<=|!=|<>|=|>|<))[ \t]*"
    r"([-+]?(?:\d+(?:\.\d+)?|\.\d+))\b"
)
OPTION_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:(?:OPTION)[ \t]*\.[ \t]*\.?[ \t]*)?"
    r"(?:EQ|NE|GT|GE|LT|LE)[ \t]*[.:][ \t]*"
    r"(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)|[A-Z][A-Z0-9_]*)"
)
NAMED_OPTION_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:(?:OPTION)[ \t]*\.[ \t]*\.?[ \t]*)?"
    r"(?:EQ|NE|GT|GE|LT|LE)[ \t]*\.[ \t]*[A-Z][A-Z0-9_]*"
)
OPTION_RANGE_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?P<left_rel>EQ|NE|GT|GE|LT|LE)[ \t]*[.:][ \t]*"
    r"(?P<left>[-+]?\d+(?:\.\d+)?)"
    r"[ \t]*(?P<separator>[-~～至到/])[ \t]*"
    r"(?:(?P<right_rel>EQ|NE|GT|GE|LT|LE)[ \t]*[.:][ \t]*)?"
    r"(?P<right>[-+]?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
LITERAL_ESCAPE_RE = re.compile(r"\\[nrt]")
SOURCE_TEXT_ARTIFACT_RE = re.compile(
    r"Error\s*!\s*Reference\s+source\s+not\s+found|Remark\?{2,}|"
    r"Blast source ID \(see \*LOAD_BLAST_ENHANCED\)D\.|"
    r"\*DEFINE_(?:COORDI_NATE|COOR_DINATE)_VECTOR|"
    r"\*DEFINE__COORDINATE_VECTOR|\*DEFINE_TRANSFOR-MATION|"
    r"MAT_OPTION TROPIC_ELASTIC|"
    r"(?-i:\*CONTROL_IMPlICIT_SOLVER)|"
    r"the relevant (?:remarks?|figures?|tables?|equations?)"
    r"(?:\.\s+(?:in|of)\b|\.\)|\.,|,\s+for\b)",
    re.IGNORECASE,
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
    "duplicated_less_than_relation": re.compile(r"小于或小于"),
    "malformed_keyword_ellipsis": re.compile(r"\*[A-Z0-9_]+_。{2,}"),
    "double_chinese_period": re.compile(r"。。+"),
    "colon_period": re.compile(r"[：:]。"),
    "comma_period": re.compile(r"[，,]。"),
    "manual_start_residue": re.compile(r"\bManual\s+start\b", re.IGNORECASE),
    "parametric_point_residue": re.compile(r"\bparametric\s+point\b", re.IGNORECASE),
    "short_prose_residue": re.compile(
        r"Equation-的-state|\b(?:Nodal|Shell|Preload|Remaining|interaces|"
        r"isolate|postforming|Image)\b|\bRemark\s+\d|\bResponse：|"
        r"\bheat\s+(?:source|treatment)\b|\b1st\s+term\b|in\s+该\s+model|"
        r"\bNeutral\s+angle\b|\bjoint's\b|\bedge\s+centers\b|"
        r"\bface\s+centers\b|\bmode\s+ID\b|\bin\s+block\b",
    ),
    "engineering_term_calque": re.compile(
        r"豁免|运动硬化|小时玻璃|剪切线模量|剪应力-剪应力|"
        r"有效相变应力|合力法向力|作用力合力|插入件 1|"
        r"节点发射逻辑|实体力学求解器|引导刚体|充电状态（SOC）|"
        r"电流沿电荷方向流动|干燥颗粒|覆盖真实厚度|"
        r"x 轴（x 轴）|I 型模态阻尼力"
    ),
    # Final user-facing translations must not contain audit/process notes.
    "process_annotation_residue": re.compile(
        r"英文源|源文|原文|独立盲审译文|翻译记录|候选译文|"
        r"英文末句|适用关系不明确|"
        r"按可辨语义|疑似|疑为|无法确定|未明确说明|句末|拼写错误|"
        r"格式损坏|异常比较|控制字符|需源确认|引用损坏|后续说明缺失"
    ),
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
    "constraint": "约束",
    "constraints": "约束",
    "constrained": "受约束",
    "rotation": "转动",
    "rotations": "转动",
    "displacement": "位移",
    "displacements": "位移",
    "component": "分量",
    "percentage": "百分比",
    "Young's modulus": "杨氏模量",
    "hardening law": "硬化法则",
    # Single-word residue checks catch short machine-translated fragments that
    # are too small for the copied-prose n-gram gate.  The expected Chinese
    # values document terminology; the gate itself checks that the English
    # source word was not copied into the localized suffix.
    "coefficient": "系数",
    "factor": "因子",
    "flag": "标志",
    "number": "数量",
    "parameter": "参数",
    "temperature": "温度",
    "pressure": "压力",
    "velocity": "速度",
    "force": "力",
    "moment": "力矩",
    "angle": "角度",
    "radius": "半径",
    "length": "长度",
    "width": "宽度",
    "thickness": "厚度",
    "area": "面积",
    "energy": "能量",
    "density": "密度",
    "ratio": "比值",
    "method": "方法",
    "direction": "方向",
    "coordinate": "坐标",
    "axis": "轴",
    "file": "文件",
    "input": "输入",
    "output": "输出",
    "description": "说明",
    "equation": "方程",
    "hourglass": "沙漏",
    "formulation": "公式",
    "formulations": "公式",
}

# This help entry intentionally enumerates solver-facing variable names such as
# ``temperature`` and ``x_velocity``.  They are identifiers, not untranslated
# prose, so the generic terminology-residue gate must not classify them as
# translation defects.
LITERAL_IDENTIFIER_LIST_PATHS = {"LSO_VARIABLE_GROUP.c[3][0].h"}

INCOMPLETE_SUFFIX_RE = re.compile(
    r"(?:沿与\[|(?:与|和|并|或|在|按|以|由|沿|从|至|及|则|若|如果|基于|此处|但)|"
    r"[\[（(]|[，,])[ \t]*$"
)
REFERENCED_IDENTIFIER_RE = re.compile(r"\b[A-Z][A-Z0-9_]{2,}\b")
IGNORED_REFERENCED_IDENTIFIERS = {
    "ABS", "ABSOLUTE", "ACTIVE", "ALL", "AND", "BLANK", "CONTACT", "CPU",
    "DEFAULT", "DESCRIPTION", "DOF", "EMBED", "EQ", "ERODING", "FALSE",
    "FLAG", "GE", "GLOBAL", "GT", "ID", "IF", "LE", "LSDYNA", "LT",
    "MANUAL", "MAX", "MIN", "MORTAR", "NE", "NODE", "NOTE", "NOT",
    "OFF", "ON", "ONLY", "OPTION", "OR", "PART", "PARTS", "PERCENT",
    "RIGID", "SEE", "SET", "STRESS", "TABLE", "TRUE", "TYPE", "USED",
    "UNIT", "USER", "VARIABLE", "WARNING", "WITHOUT",
}
REFERENCED_IDENTIFIER_ALIASES = {
    # Known pydyna/manual source spellings and equivalent formula notation.
    "AOPT0": ("AOPT=0", "AOPT = 0"),
    "B10": ("B*10", "B X 10", "B×10", "B × 10"),
    "BCTRAN": ("BCEXP",),
    "BIRTH": ("激活时间",),
    "EQ4": ("EQ.4",),
    "GRPT": ("GRPFT",),
    "IDPID": ("PID", "部件 ID"),
    "IDTHERM": ("IDTHRM",),
    "M10": ("M*10", "M X 10", "M×10", "M × 10"),
    "NODID": ("NODEID",),
    "PID": ("部件 ID",),
    "PSID": ("部件集 ID",),
    "SID": ("集合 ID", "部件集 ID"),
}
BARE_OPTION_LINE_RE = re.compile(
    r"(?m)^[ \t]*(?:EQ|NE|GT|GE|LT|LE)[ \t]*[.:][ \t]*"
    r"[-+]?\d+(?:\.\d+)?[ \t]*[。.]?[ \t]*$"
)
BRACKET_PAIRS = {"(": ")", "[": "]", "{": "}", "（": "）", "【": "】"}

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


def iter_help_field_names(value: Any, path: str = "") -> Iterable[tuple[str, str]]:
    """Yield help paths and their solver field names for consistency checks."""
    if isinstance(value, dict):
        if isinstance(value.get("h"), str) and value["h"]:
            yield f"{path}.h" if path else "h", str(value.get("n", ""))
        for key, child in value.items():
            if key == "h":
                continue
            child_path = f"{path}.{key}" if path else key
            yield from iter_help_field_names(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from iter_help_field_names(child, f"{path}[{index}]")


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


def missing_referenced_identifiers(source: str, suffix: str, field_name: str) -> list[str]:
    """Find cross-field solver identifiers lost from the localized explanation."""
    identifiers = set(REFERENCED_IDENTIFIER_RE.findall(source))
    identifiers.difference_update(IGNORED_REFERENCED_IDENTIFIERS)
    identifiers.discard(field_name.upper())
    normalized_suffix = re.sub(r"[-_\s]", "", suffix).upper()
    missing: list[str] = []
    for token in sorted(identifiers):
        normalized_token = re.sub(r"[-_\s]", "", token).upper()
        aliases = REFERENCED_IDENTIFIER_ALIASES.get(token, ())
        if normalized_token in normalized_suffix:
            continue
        if any(alias.upper() in suffix.upper() for alias in aliases):
            continue
        missing.append(token)
    return missing


def _canonical_number(value: str) -> str:
    from decimal import Decimal

    canonical = format(Decimal(value), "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    return "0" if canonical in {"", "-0"} else canonical


def _canonical_relation(dotted: str, symbolic: str) -> str:
    if dotted:
        return dotted.upper()
    return {
        "=": "EQ", "!=": "NE", "<>": "NE", ">": "GT", ">=": "GE",
        "<": "LT", "<=": "LE",
    }[symbolic]


def source_condition_pairs(source: str) -> list[tuple[str, str, str]]:
    """Return explicit solver comparisons whose loss changes semantics."""
    pairs = [
        (name, _canonical_relation(dotted, symbolic), _canonical_number(value))
        for name, dotted, symbolic, value in CONDITION_PAIR_RE.findall(source)
    ]
    return list(dict.fromkeys(pairs))


def condition_pair_present(name: str, relation_name: str, value: str, suffix: str) -> bool:
    # Keep the solver variable/value pair even when the Chinese prose uses
    # natural wording such as ``PFORM 设为 0`` or ``TBEG 默认值为 0.0``.
    suffix = suffix.replace("−", "-").replace("–", "-")
    try:
        canonical_value = _canonical_number(value)
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
    symbolic_relations = {
        "EQ": r"(?:=|等于|设为|设置为|取值为|取|为|是)",
        "NE": r"(?:!=|<>|≠|不等于|非)",
        "GT": r"(?:>|大于|高于|超过)",
        "GE": r"(?:>=|≥|不小于|大于或等于|至少)",
        "LT": r"(?:<|小于|低于|不足)",
        "LE": r"(?:<=|≤|不大于|小于或等于|至多)",
    }
    relation = symbolic_relations[relation_name]
    for name_variant in name_variants:
        for value_variant in numeric_variants:
            direct = re.compile(
                r"\b" + re.escape(name_variant) + r"\s*(?:\.\s*"
                + re.escape(relation_name) + r"\s*\.|" + relation + r")\s*"
                + re.escape(value_variant) + r"(?![0-9A-Za-z])"
            )
            dotted_equal = re.compile(
                r"\b" + re.escape(name_variant) + r"\s*[.:]\s*"
                + re.escape(value_variant) + r"(?![0-9A-Za-z])"
            )
            natural = re.compile(
                r"\b" + re.escape(name_variant) + r"[^。；;\n]{0,24}"
                + relation + r"[^。；;\n]{0,12}" + re.escape(value_variant)
            )
            if (
                direct.search(suffix)
                or natural.search(suffix)
                or (relation_name == "EQ" and dotted_equal.search(suffix))
            ):
                return True
        if relation_name == "LT" and canonical_value == "0" and re.search(
            r"\b" + re.escape(name_variant) + r"[^。；;\n]{0,24}(?:为负|负值)", suffix
        ):
            return True
        if relation_name == "GT" and canonical_value == "0" and re.search(
            r"\b" + re.escape(name_variant) + r"[^。；;\n]{0,24}(?:为正|正值)", suffix
        ):
            return True
    return False


def _normalized_option_tokens(text: str, *, numeric_only: bool = False) -> list[str]:
    """Extract solver option labels without treating prose as translatable text."""
    tokens: list[str] = []
    for match in OPTION_TOKEN_RE.finditer(text):
        token = re.sub(r"\s+", "", match.group(0)).replace(":", ".")
        token = token.replace("..", ".").upper()
        numeric_match = re.fullmatch(
            r"(?:(?:OPTION)\.)?(EQ|NE|GT|GE|LT|LE)\.([-+]?(?:\d+(?:\.\d+)?|\.\d+))",
            token,
        )
        if numeric_only:
            if not numeric_match:
                continue
            canonical = _canonical_number(numeric_match.group(2))
            token = f"{numeric_match.group(1)}.{canonical}"
        tokens.append(token)
    return list(dict.fromkeys(tokens))


def _expanded_numeric_option_tokens(text: str) -> set[str]:
    """Return explicit option values, including compact integer ranges/groups."""
    tokens = set(_normalized_option_tokens(text, numeric_only=True))
    for match in OPTION_RANGE_RE.finditer(text):
        left = _canonical_number(match.group("left"))
        right = _canonical_number(match.group("right"))
        left_rel = match.group("left_rel").upper()
        right_rel = (match.group("right_rel") or left_rel).upper()
        separator = match.group("separator")
        tokens.update({f"{left_rel}.{left}", f"{right_rel}.{right}"})
        if (
            separator == "/"
            or not re.fullmatch(r"[-+]?\d+", left)
            or not re.fullmatch(r"[-+]?\d+", right)
        ):
            continue
        start, stop = int(left), int(right)
        if abs(stop - start) > 500:
            continue
        relations = {left_rel, right_rel}
        for number in range(min(start, stop), max(start, stop) + 1):
            for relation in relations:
                tokens.add(f"{relation}.{number}")
    return tokens


def _numeric_option_present(token: str, suffix: str) -> bool:
    if token in _expanded_numeric_option_tokens(suffix):
        return True
    relation_name, value = token.split(".", 1)
    relation = {
        "EQ": r"(?:=|等于|设为|设置为|取值为|取|为|是)",
        "NE": r"(?:!=|<>|≠|不等于|非)",
        "GT": r"(?:>|大于|高于|超过)",
        "GE": r"(?:>=|≥|不小于|大于或等于|至少)",
        "LT": r"(?:<|小于|低于|不足)",
        "LE": r"(?:<=|≤|不大于|小于或等于|至多)",
    }[relation_name]
    return bool(re.search(relation + r"[^。；;\n]{0,12}" + re.escape(value), suffix))


def _unbalanced_brackets(value: str) -> list[str]:
    stack: list[str] = []
    closing = {right: left for left, right in BRACKET_PAIRS.items()}
    for character in value:
        if character in BRACKET_PAIRS:
            stack.append(character)
        elif character in closing:
            if (
                stack
                and stack[-1] in {"(", "["}
                and character in {")", "]"}
            ):
                stack.pop()
                continue
            if not stack or stack[-1] != closing[character]:
                return [character]
            stack.pop()
    return stack


def _named_option_tokens(text: str) -> list[str]:
    """Return labels such as ``OPTION.EQ.PART`` whose spelling is semantic."""
    tokens = [
        re.sub(r"\s+", "", match.group(0)).replace("..", ".").upper()
        for match in NAMED_OPTION_TOKEN_RE.finditer(text)
    ]
    return list(dict.fromkeys(tokens))


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
    field_names = dict(iter_help_field_names(english))
    fallbacks: list[str] = []
    invalid_bilingual: list[str] = []
    templates: list[str] = []
    english_residue: list[str] = []
    mechanical_spacing: list[str] = []
    source_phrase_residue: list[dict[str, Any]] = []
    copied_source_prose: list[dict[str, Any]] = []
    review_queue: list[str] = []
    protected_omissions: list[dict[str, Any]] = []
    referenced_identifier_omissions: list[dict[str, Any]] = []
    condition_omissions: list[dict[str, Any]] = []
    unicode_violations: list[dict[str, Any]] = []
    question_mark_artifacts: list[dict[str, Any]] = []
    field_label_mismatches: list[dict[str, Any]] = []
    source_text_artifacts: list[dict[str, Any]] = []
    literal_escape_violations: list[str] = []
    option_label_omissions: list[dict[str, Any]] = []
    option_value_mismatches: list[dict[str, Any]] = []
    punctuation_balance_violations: list[dict[str, Any]] = []
    incomplete_suffixes: list[str] = []
    marker_counts: Counter[str] = Counter()
    terminology_residue: Counter[str] = Counter()
    mixed_term_residue: Counter[str] = Counter()
    by_source: defaultdict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
    field_names = dict(iter_help_field_names(english))

    for path, source, suffix, raw in rows:
        source_forbidden = forbidden_help_characters(source)
        localized_forbidden = forbidden_help_characters(raw)
        if source_forbidden or localized_forbidden:
            unicode_violations.append(
                {
                    "path": path,
                    "english": dict(source_forbidden),
                    "localized": dict(localized_forbidden),
                }
            )
        source_question_marks = unapproved_question_mark_count(source)
        suffix_question_marks = unapproved_question_mark_count(suffix)
        if source_question_marks or suffix_question_marks:
            question_mark_artifacts.append(
                {
                    "path": path,
                    "english": source_question_marks,
                    "localized": suffix_question_marks,
                }
            )
        source_artifact = SOURCE_TEXT_ARTIFACT_RE.search(source)
        if source_artifact:
            source_text_artifacts.append(
                {"path": path, "artifact": source_artifact.group(0)}
            )
        field_name = field_names.get(path, "")
        if re.fullmatch(r"N[1-8]", field_name):
            leading_label = re.match(r"^[ \t]*节点[ \t]*N?([1-8])\b", suffix)
            if leading_label and leading_label.group(1) != field_name[1:]:
                field_label_mismatches.append(
                    {
                        "path": path,
                        "field": field_name,
                        "localized_label": leading_label.group(0).strip(),
                    }
                )
        if LITERAL_ESCAPE_RE.search(source) or LITERAL_ESCAPE_RE.search(raw):
            literal_escape_violations.append(path)

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

        missing_identifiers = missing_referenced_identifiers(
            source, suffix, field_names.get(path, "")
        )
        if missing_identifiers:
            referenced_identifier_omissions.append(
                {"path": path, "tokens": missing_identifiers}
            )

        missing_conditions = [
            f"{name} {relation_name} {value}"
            for name, relation_name, value in source_condition_pairs(source)
            if not condition_pair_present(name, relation_name, value, suffix)
        ]
        if missing_conditions:
            condition_omissions.append({"path": path, "conditions": missing_conditions})

        source_named_options = _named_option_tokens(source)
        localized_named_options = set(_named_option_tokens(suffix))
        missing_option_labels = [
            token for token in source_named_options if token not in localized_named_options
        ]
        if missing_option_labels:
            option_label_omissions.append(
                {"path": path, "tokens": missing_option_labels}
            )

        source_numeric_options = _expanded_numeric_option_tokens(source)
        localized_numeric_options = _expanded_numeric_option_tokens(suffix)
        missing_numeric_options = sorted(
            token for token in source_numeric_options
            if not _numeric_option_present(token, suffix)
        )
        if missing_numeric_options:
            option_value_mismatches.append(
                {
                    "path": path,
                    "english": sorted(source_numeric_options),
                    "localized": sorted(localized_numeric_options),
                    "missing": missing_numeric_options,
                }
            )

        unbalanced = _unbalanced_brackets(suffix)
        if unbalanced:
            punctuation_balance_violations.append(
                {"path": path, "unbalanced": unbalanced}
            )
        if INCOMPLETE_SUFFIX_RE.search(suffix.strip()) or BARE_OPTION_LINE_RE.search(suffix):
            incomplete_suffixes.append(path)

        if path not in LITERAL_IDENTIFIER_LIST_PATHS:
            terminology_residue.update(_term_residue(source, suffix))
        for rule_name, rule in MIXED_TERM_RULES.items():
            if rule.search(suffix):
                mixed_term_residue[rule_name] += 1
        by_source[(source, field_names.get(path, ""))].append((path, suffix))

    duplicate_groups: list[dict[str, Any]] = []
    consensus_repairable = 0
    for (source, field_name), entries in by_source.items():
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
                "field_name": field_name,
                "occurrences": len(entries),
                "variant_count": len(variants),
                "proper_variant_count": len(proper),
                "consensus_repairable": repairable,
                "paths": [path for path, _ in entries[:20]],
                "variants": [
                    {"count": count, "text": suffix}
                    for suffix, count in variants.most_common(10)
                ],
            }
        )

    failures = {
        "fallback_occurrences": len(fallbacks),
        "invalid_bilingual_occurrences": len(invalid_bilingual),
        "mechanical_marker_occurrences": sum(marker_counts.values()),
        "generic_template_occurrences": len(templates),
        "protected_token_omissions": len(protected_omissions),
        "referenced_identifier_omissions": len(referenced_identifier_omissions),
        "condition_pair_omissions": len(condition_omissions),
        "unicode_violations": len(unicode_violations),
        "question_mark_artifact_occurrences": len(question_mark_artifacts),
        "field_label_mismatch_occurrences": len(field_label_mismatches),
        "source_text_artifact_occurrences": len(source_text_artifacts),
        "literal_escape_violations": len(literal_escape_violations),
        "option_label_omissions": len(option_label_omissions),
        "option_value_mismatches": len(option_value_mismatches),
        "punctuation_balance_violations": len(punctuation_balance_violations),
        "incomplete_suffix_occurrences": len(incomplete_suffixes),
        "english_residue_occurrences": len(english_residue),
        "mechanical_spacing_occurrences": len(mechanical_spacing),
        "copied_source_prose_occurrences": len(copied_source_prose),
        "terminology_residue_occurrences": sum(terminology_residue.values()),
        "mixed_term_residue_occurrences": sum(mixed_term_residue.values()),
        "duplicate_consensus_repairable_occurrences": consensus_repairable,
        "duplicate_source_variant_units": len(duplicate_groups),
    }
    status = "pass" if all(value == 0 for value in failures.values()) else "fail"

    return {
        "schema_version": 8,
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
            "referenced_identifier_omissions": referenced_identifier_omissions[:100],
            "condition_pair_omissions": condition_omissions[:100],
            "unicode_violations": unicode_violations[:100],
            "question_mark_artifacts": question_mark_artifacts[:100],
            "field_label_mismatches": field_label_mismatches[:100],
            "source_text_artifacts": source_text_artifacts[:100],
            "literal_escape_paths": literal_escape_violations[:100],
            "option_label_omissions": option_label_omissions[:100],
            "option_value_mismatches": option_value_mismatches[:100],
            "punctuation_balance_violations": punctuation_balance_violations[:100],
            "incomplete_suffix_paths": incomplete_suffixes[:100],
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
