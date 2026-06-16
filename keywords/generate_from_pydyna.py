#!/usr/bin/env python3
"""Generate VS Code snippets and hover field data from pydyna codegen metadata.

Usage:
    python keywords/generate_from_pydyna.py [path/to/kwd.json]

Outputs:
    snippets/lsdyna.json
    keywords/field_data.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pydyna_schema_adapter import build_schema
from validate_field_data_translation import sync_translation_file


REPO_ROOT = Path(__file__).parent.parent
CODEGEN_DIR = REPO_ROOT / "pydyna" / "codegen"
DEFAULT_KWD = CODEGEN_DIR / "kwd.json"
OUTPUT_SNIPPETS = REPO_ROOT / "snippets" / "lsdyna.json"
OUTPUT_FIELDS = REPO_ROOT / "keywords" / "field_data.json"
OUTPUT_FIELDS_ZH = REPO_ROOT / "keywords" / "field_data_zh.json"


def _resolve_kwd_path() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    if DEFAULT_KWD.exists():
        return DEFAULT_KWD
    return REPO_ROOT.parent / "pydyna" / "codegen" / "kwd.json"


def main() -> None:
    kwd_path = _resolve_kwd_path()
    if not kwd_path.exists():
        print(f"Error: {kwd_path} not found", file=sys.stderr)
        print("Usage: python keywords/generate_from_pydyna.py [path/to/kwd.json]", file=sys.stderr)
        sys.exit(1)

    codegen_dir = kwd_path.parent
    print(f"Loading pydyna codegen metadata from {codegen_dir} ...")
    generated = build_schema(codegen_dir, kwd_path)

    OUTPUT_SNIPPETS.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_SNIPPETS, "w", encoding="utf-8") as f:
        json.dump(generated.snippets, f, indent=4)
    print(f"Written {len(generated.snippets)} snippets to {OUTPUT_SNIPPETS}")

    OUTPUT_FIELDS.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FIELDS, "w", encoding="utf-8") as f:
        json.dump(generated.field_data, f, separators=(",", ":"))
    size_kb = OUTPUT_FIELDS.stat().st_size // 1024
    print(f"Written {len(generated.field_data)} keyword definitions to {OUTPUT_FIELDS} ({size_kb} KB)")

    if OUTPUT_FIELDS_ZH.exists():
        errors = sync_translation_file(OUTPUT_FIELDS, OUTPUT_FIELDS_ZH)
        if errors:
            raise RuntimeError("field_data_zh.json synchronization produced structural errors")
        print(f"Synchronized localized fallback data to {OUTPUT_FIELDS_ZH}")

    print("Generation stats:")
    for key, value in generated.stats.items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
