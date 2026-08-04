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


def _term_residue(source: str, suffix: str) -> list[str]:
    residue: list[str] = []
    for term in REQUIRED_TERMS:
        boundary = r"(?<![A-Za-z0-9_*])" + re.escape(term) + r"(?![A-Za-z0-9_])"
        if re.search(boundary, source, re.IGNORECASE) and re.search(
            boundary, suffix, re.IGNORECASE
        ):
            residue.append(term)
    return residue


def build_report(english: Any, localized: Any) -> dict[str, Any]:
    rows = list(iter_help_occurrences(english, localized))
    fallbacks: list[str] = []
    invalid_bilingual: list[str] = []
    templates: list[str] = []
    english_residue: list[str] = []
    protected_omissions: list[dict[str, Any]] = []
    marker_counts: Counter[str] = Counter()
    terminology_residue: Counter[str] = Counter()
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
        for marker in MECHANICAL_MARKERS:
            marker_counts[marker] += suffix.count(marker)

        missing = [token for token in protected_source_tokens(source) if token not in suffix]
        if missing:
            protected_omissions.append({"path": path, "tokens": missing})

        terminology_residue.update(_term_residue(source, suffix))
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
        "english_residue_occurrences": len(english_residue),
        "terminology_residue_occurrences": sum(terminology_residue.values()),
        "duplicate_consensus_repairable_occurrences": consensus_repairable,
    }
    status = "pass" if all(value == 0 for value in failures.values()) else "fail"

    return {
        "schema_version": 3,
        "occurrence_count": len(rows),
        **failures,
        "mechanical_marker_counts": dict(marker_counts),
        "terminology_residue_counts": dict(terminology_residue),
        "duplicate_source_units_with_variants": len(duplicate_groups),
        "examples": {
            "fallback_paths": fallbacks[:100],
            "invalid_bilingual_paths": invalid_bilingual[:100],
            "generic_template_paths": templates[:100],
            "english_residue_paths": english_residue[:100],
            "protected_token_omissions": protected_omissions[:100],
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
