#!/usr/bin/env python3
"""Generate VS Code snippets and hover field data from pydyna codegen metadata.

Usage:
    python keywords/generate_from_pydyna.py [path/to/kwd.json]
    python keywords/generate_from_pydyna.py --codegen-dir path/to/codegen

Outputs:
    snippets/lsdyna.json
    keywords/field_data.json
"""

from __future__ import annotations

import json
import argparse
from pathlib import Path

from pydyna_schema_adapter import build_schema


REPO_ROOT = Path(__file__).parent.parent
CODEGEN_DIR = REPO_ROOT / "pydyna" / "codegen"
DEFAULT_KWD = CODEGEN_DIR / "kwd.json"
OUTPUT_SNIPPETS = REPO_ROOT / "snippets" / "lsdyna.json"
OUTPUT_FIELDS = REPO_ROOT / "keywords" / "field_data.json"
MANUAL_KEYWORD_CLASSES_DIR = (
    Path("src")
    / "ansys"
    / "dyna"
    / "core"
    / "keywords"
    / "keyword_classes"
    / "manual"
)


def _default_kwd_path() -> Path:
    if DEFAULT_KWD.exists():
        return DEFAULT_KWD
    return REPO_ROOT.parent / "pydyna" / "codegen" / "kwd.json"


def _create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate VS Code keyword artifacts from a single PyDYNA codegen tree."
    )
    parser.add_argument(
        "kwd_json",
        nargs="?",
        type=Path,
        help="Legacy positional path to kwd.json.",
    )
    parser.add_argument(
        "--codegen-dir",
        type=Path,
        help="Directory containing kwd.json, manifest.json, and additional-cards.json.",
    )
    parser.add_argument(
        "--kwd-file",
        type=Path,
        help="Explicit kwd.json path; it must belong to --codegen-dir when both are supplied.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Load and validate the selected source without writing runtime artifacts.",
    )
    parser.add_argument(
        "--output-snippets",
        type=Path,
        help="Destination for generated snippets (defaults to snippets/lsdyna.json).",
    )
    parser.add_argument(
        "--output-fields",
        type=Path,
        help="Destination for generated English field data (defaults to keywords/field_data.json).",
    )
    parser.add_argument(
        "--stats-file",
        type=Path,
        help="Optional JSON destination for generation statistics.",
    )
    return parser


def _resolve_codegen_inputs_from_args(
    parser: argparse.ArgumentParser, args: argparse.Namespace
) -> tuple[Path, Path]:
    if args.codegen_dir and args.kwd_json:
        parser.error("kwd_json positional argument cannot be combined with --codegen-dir")
    if args.kwd_file and args.kwd_json:
        parser.error("kwd_json positional argument cannot be combined with --kwd-file")

    if args.codegen_dir:
        codegen_dir = args.codegen_dir
        kwd_path = args.kwd_file or codegen_dir / "kwd.json"
    else:
        kwd_path = args.kwd_file or args.kwd_json or _default_kwd_path()
        codegen_dir = kwd_path.parent

    codegen_dir = codegen_dir.resolve()
    kwd_path = kwd_path.resolve()
    if args.codegen_dir and kwd_path.parent != codegen_dir:
        parser.error("--kwd-file must be inside --codegen-dir")

    required_paths = (
        kwd_path,
        codegen_dir / "manifest.json",
        codegen_dir / "additional-cards.json",
        codegen_dir.parent / MANUAL_KEYWORD_CLASSES_DIR,
    )
    for required_path in required_paths:
        if not required_path.exists():
            parser.error(f"Missing required PyDYNA input: {required_path}")
    return codegen_dir, kwd_path


def resolve_codegen_inputs(argv: list[str] | None = None) -> tuple[Path, Path]:
    parser = _create_parser()
    return _resolve_codegen_inputs_from_args(parser, parser.parse_args(argv))


def write_pretty_json(path: Path, value: object, *, sort_keys: bool = False) -> None:
    """Write deterministic UTF-8 JSON with two-space indentation and LF endings."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as file:
        json.dump(value, file, ensure_ascii=False, indent=2, sort_keys=sort_keys)
        file.write("\n")


def main(argv: list[str] | None = None) -> None:
    parser = _create_parser()
    args = parser.parse_args(argv)
    codegen_dir, kwd_path = _resolve_codegen_inputs_from_args(parser, args)

    codegen_dir = kwd_path.parent
    print(f"Loading pydyna codegen metadata from {codegen_dir} ...")
    generated = build_schema(codegen_dir, kwd_path)

    print("Generation stats:")
    for key, value in generated.stats.items():
        print(f"  {key}: {value}")

    if args.dry_run:
        print("Dry run completed without writing runtime artifacts.")
        return

    output_snippets = (args.output_snippets or OUTPUT_SNIPPETS).resolve()
    output_fields = (args.output_fields or OUTPUT_FIELDS).resolve()
    write_pretty_json(output_snippets, generated.snippets)
    print(f"Written {len(generated.snippets)} snippets to {output_snippets}")

    write_pretty_json(output_fields, generated.field_data)
    size_kb = output_fields.stat().st_size // 1024
    print(f"Written {len(generated.field_data)} keyword definitions to {output_fields} ({size_kb} KB)")

    if args.stats_file:
        stats_file = args.stats_file.resolve()
        write_pretty_json(stats_file, generated.stats, sort_keys=True)


if __name__ == "__main__":
    main()
