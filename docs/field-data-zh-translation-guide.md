# `field_data_zh.json` maintenance and quality contract

## Sources and output

- English structure source: `keywords/field_data.json`
- Chinese authoring source: `keywords/field_data_zh.json`
- Runtime output: `out/runtime/field_help_zh.delta.json.gz`
- Structure/content validator: `keywords/validate_field_data_translation.py`
- Final quality gate: `keywords/audit_field_data_quality.py`
- Reviewed compatibility source: `keywords/compatibility/mat_add_erosion_legacy_fields.json`

The extension treats the English file as the schema authority. The Chinese file is
a reviewable authoring mirror. Compilation produces a deterministic, hash-bound
delta containing only Chinese help suffixes. The full Chinese JSON must not be
packaged in the VSIX.

## Data contract

Only user-facing help values may differ. Keyword names, object keys, array order,
field names, positions, widths, types, defaults, enums, options, aliases, variants,
and activation expressions must remain identical.

Every non-empty translated help value has exactly this form:

```text
<complete current English help>\n<reviewed Chinese help>
```

The English prefix is byte-for-byte authoritative. An untranslated value contains
only the English help and is a release-blocking fallback. Empty English help remains
empty. Chinese-only values and stale or shortened English prefixes are invalid.

The JSON format is UTF-8, two-space indentation, LF line endings, original key
order, and one final newline.

## Translation requirements

Write concise engineering Chinese suitable for LS-DYNA and CAE users. Preserve the
physical quantity, action, conditions, branch scope, defaults, signs, ranges,
warnings, and units. Do not use word-by-word machine-like phrasing.

Preserve technical literals exactly, including:

- `*KEYWORD` and card names;
- field identifiers, option names, variables, functions, filenames, and URLs;
- `EQ.`, `NE.`, `GT.`, `GE.`, `LT.`, `LE.`, `AND`, `OR`, and `IF`;
- numbers, signs, scientific notation, units, equations, and vector notation;
- established names and acronyms such as `MPP`, `SMP`, `ICFD`, `SPH`, `ALE`,
  `FSI`, `ID`, `PID`, `SID`, `CID`, `DOF`, `NURBS`, and `Johnson-Cook`.

Use established terms consistently, for example 节点、单元、部件、集合、接触、
刚体、载荷曲线、坐标系、自由度、应力、应变、应变率、失效、损伤、断裂、
摩擦、法向、切向、体积、质量流率、边界条件、材料轴和正交各向异性。

## Required quality gates

Run all of the following against the same English and Chinese files:

```bash
python keywords/validate_field_data_translation.py --check-content
python keywords/audit_field_data_quality.py
python -m unittest discover -s keywords/tests -p "test_*.py" -v
npm run build:field-help-delta
npm run check:contracts
```

Release requires zero values for every audit failure category:

- English fallback;
- invalid bilingual prefix;
- mechanical placeholder markers and generic templates;
- protected-token omission;
- obvious English prose residue;
- frozen terminology residue;
- safely repairable duplicate inconsistency.

Both Python tools return non-zero on failure. Normal maintenance and CI print a
summary only; they do not create tracked reports. Use `--output <temporary-path>`
with the audit only when local diagnostics are needed.

After building the delta, verify that its `sourceLocalizedSha256` equals the raw
SHA-256 of the LF Chinese source and that its localized count equals the validator's
non-empty translated count.

## Updating after PyDYNA

1. Save the old `field_data.json` outside the repository.
2. Regenerate the four English artifacts from the clean, pinned PyDYNA commit.
   The generator must apply and record all local compatibility overlays before
   publishing the English schema, snippets, reference index, and provenance.
3. Run the validator with `--sync --previous-english <snapshot>`. Synchronization
   also applies the reviewed Chinese help stored in compatibility overlays after
   the English source and field signature have been verified.
4. Review every fallback created by new, changed, or ambiguous English text.
5. Run all quality gates and rebuild the runtime delta.
6. Commit the four PyDYNA outputs separately from the reviewed Chinese update when
   practical, so reviewers can distinguish source changes from translations.

Synchronization preserves a Chinese suffix only when its complete old English
source still matches, including a unique translation-memory match after movement.
It never authorizes an old translation for changed English.

For `*MAT_ADD_EROSION`, the compatibility overlay retains the historical
`DMGTYP`, `LCSDG`, `ECRIT`, `DMGEXP`, `DCRIT`, and `FADEXP` positions for legacy
solver decks. If a future PyDYNA update supplies a different card shape or changes
the English definition, regeneration must stop for review rather than silently
reusing the old Chinese text.

## Repository hygiene

Do not commit review ledgers, batch packages, reviewer instructions, dashboards,
queues, dry runs, audit reports, or intermediate delta files. If temporary evidence
is required, keep it under an ignored local artifact directory or outside the
repository. Only the final JSON, final validators, their tests, stable documentation,
and reproducible build scripts belong on the development branch.
