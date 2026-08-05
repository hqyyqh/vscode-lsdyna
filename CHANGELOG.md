# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Change-mark color schemes:** Session marks now offer one adaptive theme-aware default plus orange/blue, red/blue, high-contrast, and custom choices. Presets switch automatically across light, dark, high-contrast, and high-contrast-light themes; custom colors are applied consistently to gutter shapes, line tints, the overview ruler, and the minimap.

### Fixed
- **Chinese field help:** Published the reviewed Chinese field-help set with exact English-source binding, protected LS-DYNA identifiers and numeric branches, and the reviewed legacy `*MAT_ADD_EROSION` compatibility descriptions.
- **Session change marks after Save As:** A copied deck now inherits the source editing baseline, so only the lines actually changed since the source was opened become saved-green. Unrelated same-content files are not linked, and uncertain lifecycle cases fall back to a clean target instead of marking the whole file as inserted.
- **Include paths and change-mark indicators:** Every schema-backed Include filename/path card—including structured variants such as `*INCLUDE_TRANSFORM`, `*INCLUDE_STAMPED_PART`, and `*INCLUDE_MULTISCALE`—now keeps numeric prefixes, underscores, separators, and extensions in one path-string highlight without recoloring later numeric cards. Resolved includes rely on their native clickable link underline, while unresolved includes show one trailing warning-triangle icon. Include status no longer occupies the editor glyph margin or hides line change marks.
- **Reference Hover:** Known current-file curve, table, and generic-definition candidates can be inspected before a project scan while the binding remains explicitly uncertain. Candidate links and previews no longer imply a unique resolved definition.
- **Table references:** Child curve/table rows retain exact, ambiguous, uncertain, or missing state. Ambiguous and uncertain children are never selected implicitly or used to build a combined 3D preview.
- **Parameter Hover:** Current-file source definitions are labeled separately from occurrence-aware effective values in the selected or unique main-deck context.

### Changed
- **Theme-aware visual system:** Syntax highlighting remains controlled by standard TextMate scopes, editor/tree warnings now use VS Code semantic theme colors, rulers inherit `editorRuler.foreground`, and SVG/animated fallbacks share one audited palette for light, dark, high-contrast, and high-contrast-light themes. Change marks also use a non-color unsaved status dot.
- **Include status clarity:** Existing include paths rely on their native underlined document link; missing paths use a trailing theme-aware exclamation indicator. Resolved files no longer borrow Git untracked colors in the Include Tree.
- **Keyword data:** Regenerated snippets, field help, and reference metadata from the frozen PyDYNA source recorded in `keywords/pydyna-source.json`. The reproducible build retains reviewed legacy `*MAT_ADD_EROSION` fields used by older solver decks.
- **Chinese field help packaging:** The full localized schema remains the review source but is compiled into a hash-bound runtime delta. The extension now loads one authoritative English schema and applies Chinese help lazily, reducing package size and avoiding a second complete schema in memory.
- **Keyword actions:** Select Cards, Format, and (when supported) Configure Options now live in the keyword Hover action area instead of occupying editor lines by default. `lsdyna.codeLens.showOnAllKeywords` remains available for users who want these CodeLens actions above every keyword.
- **English and Chinese copy:** Revised commands, settings, status messages, manual-reader controls, and README terminology for clearer LS-DYNA workflows. Added localization contracts for manifest text, locale keys, and placeholders.
- **Manual setup documentation:** Updated both READMEs with the current English-original and bilingual manual-pack downloads, the Windows-only SumatraPDF requirement, and the notice that only the bundled PDF manuals are the official authoritative reference.
- **Release page guidance:** Automated GitHub releases now append maintained English and Chinese instructions for VSIX installation, window reloads, and manual-pack setup instead of the obsolete manual-pack text.

## [3.1.1] - 2026-07-24

### Added
- **Session change marks (no Git):** **Orange** = unsaved, **green** = saved since open. Shapes live only in the **glyph margin** (**solid** = modified, **hollow** = inserted, **triangle** = deleted on a neighbor line) — no left text border. Optional **whole-line** tint (`showLineBackground`) and a separate **minimap / overview** layer (`showMinimap`, dual-color). Theme colors via `lsdyna.changeMarks.unsaved` / `.saved`. Commands: next/previous mark (`Alt+F5` / `Shift+Alt+F5`), reset baseline, and diff vs opened / unsaved.
- **Field help quiet switch:** Card field hover help can be turned off for this session or permanently from the hover card footer, and turned back on from the DynaSense status bar menu (or command palette). Setting `lsdyna.enableFieldHover` (default on). Include path / parameter / keyword hovers stay available when field help is off.
- **Card field cell edit protect:** On fixed-width card data lines, Delete/Backspace (while a field is selected) clears the **cell** with space padding so later fields do not shift left. Independent setting `lsdyna.enableCellEditProtect` (default on). **Typing is not intercepted** (keywords `*…`, comments `$…`, free text use the normal editor).
- **Include path completion:** Path suggestions only fire on the **filename card** of multi-card keywords (for example `*INCLUDE_TRANSFORM` offset/scale lines no longer open path completion). On an `*INCLUDE` filename line, typing a name fragment opens suggestions automatically (no Ctrl+Space). Matches show the full relative path so duplicate names in different folders stay clear.
- **Ancestor `*INCLUDE_PATH` inheritance (project index / Include Tree):** When indexing from a main job, child decks inherit PATH cards declared on include ancestors (nearest first). Short names in children resolve without copying PATH into every file. Opening a child alone still uses file-local paths only (no workspace-wide PATH union).

### Fixed
- **Include path completion:** Typing a name after `/`, `\`, `./`, or `.\` now stays in one-level folder browsing instead of unexpectedly switching to recursive filename search. Browse suggestions keep folders before files and use natural alphanumeric ordering (`1`, `2`, `10`).
- **Tab on card lines:** Daily Tab no longer token-repacks a free-format or collapsed line (that was re-pinning values into the wrong columns after a clear). Explicit format commands still re-rack by tokens/commas.
- **Cell Backspace/Delete:** Deletes to the left within the owned field; empty-row delete and exclusive caret boundaries no longer clear the wrong field.
- **Tab after finishing a field:** Caret at a full field’s exclusive end (same column as the next field start) no longer skips the next field; empty previous fields still advance normally. Shift+Tab stays geometric so it does not skip backward.
- **Cell type-over strict scope:** Typing rewrites a field **only after Tab/SelectCell** marks the cell (A then short Ap for multi-digit). Without Tab, or when typing `*` / `$`, input is normal editor text (no R1 pad). Delete/Backspace cell clear remains.
- **Tab free-format align restored:** Free-format / collapsed card lines (e.g. `1 2 3 4`) again token-rack into fixed columns on Tab. Intact grids still use in-place R1 only (empty cells kept).

### Changed
- **Status bar (deck context HUD):** Main text prioritizes **current-file** deck errors/warnings, then the **current keyword** — not environment “setup items”. Detail shows field `n/N` without a permanent Manual OK badge; after Include Tree scan, detail also shows the **scan root short name** (tooltip always states scanned vs not). Click menu is **LS-DYNA quick actions**: problems and Include scan first; environment & manuals check sunk (manuals CTA still rises when unconfigured).
- **Include path completion (how it feels when editing):** Under `*INCLUDE`, `/` and `\` walk one folder level at a time (search roots = deck directory + valid `*INCLUDE_PATH` entries). Suggestions insert the **full relative path** with `/` (for example `mats/steel/mat.k`), not only a bare file name.
- **Docs:** README (EN/中文) rewritten for CAE users—manual pack flavors, include workflow, Linux path-case checklist, and plain-language path completion steps.
- **Docs:** README explains ancestor `*INCLUDE_PATH` inheritance when scanning from the main deck vs file-local search when a child is opened alone.

### Behavior notes
- Empty `*INCLUDE` lines no longer dump the entire file list; start with `/` to browse or type a name to search.
- Accepting a completion always writes `/` separators (helpful when the same deck will run on Linux).
- Include Tree from main: PATH on main/setup applies to nested short includes.
- After a main-job scan, editor jump / DocumentLink / path color / `*INCLUDE` completion / path-case checks on child decks use the same ancestor-aware search roots as the tree (cached from the project snapshot). Opening a child alone without a scan still stays file-local.
- Incremental graph updates resolve includes with snapshot effective paths; changing `*INCLUDE_PATH` cards flags a full root rebuild (`requiresFullRebuild`).

## [3.1.0] - 2026-07-21

### Added
- **Manual packs:** Two install flavors — **English-only** and **bilingual** (EN + 中文). If Chinese indexes are missing, the reader skips them safely instead of breaking.
- **Manual PDFs:** Opens the PDF file named in the pack manifest (including versioned or Chinese-only file names), with a fallback to the older `title.pdf` layout.

### Changed
- **Manual Reader:** Whether you can switch the document to Chinese depends on **what the pack contains**, not only on VS Code’s display language. Menus/toolbars still follow the extension UI language.
- **Manual Reader:** “Open PDF” uses the **page numbers from this pack’s index** for the PDF that ships in the pack (so bilingual dual-text PDFs stay aligned after merge).
- **Config / docs:** Point `lsdyna.manualsDir` at a pack root such as `lsdyna-manual-pack-en` or `lsdyna-manual-pack-bilingual`.

### Fixed
- **Hover:** Clearer actions when a keyword is unknown (status bar and info icons).
- **Manual Reader:** Wider Variable column; full-width panel and font scaling from later 3.0.x work are included in this minor.

## [3.0.13] - 2026-07-08

### Added
- **Status Bar**: Added an in-editor diagnostic details view from the DynaSense status dashboard.

### Changed
- **Status Bar**: Refined dashboard action names and ordering, moving DynaSense output to the end and placing healthy environment status after primary workflow actions.
- **i18n**: The extension language now follows VS Code display language changes at runtime when `lsdyna.language` is set to `auto`.
- **Formatter**: Restored `*INCLUDE_PATH` wrapping through both document formatting and the CodeLens formatting command.

### Fixed
- **Keywords**: Accepted numbered `*CASE_BEGIN_<n>` and `*CASE_END_<n>` variants as valid custom case boundary keywords.

## [3.0.12] - 2026-06-25

### Fixed
- **i18n**: Added missing Chinese translations for field data.

### Changed
- **Build**: Excluded `scripts` folder from the extension package.

## [3.0.11] - 2026-06-25

- Triggered clean release.

## [3.0.10] - 2026-06-25

### Fixed
- **Hover**: Added support for referencing curve/table definitions from real number fields.
- **Hover**: Removed keyword option entry.
- **Snippets**: Synchronized `MAT_ADD_EROSION` damage field annotations.
- **Keywords**: Restored `MAT_ADD_EROSION` damage field descriptions.

### Changed
- **References**: Refactored to remove field reference override files.

## [3.0.9] - 2026-06-24

### Added
- **Hover**: Added graphical 1D and 3D Curve/Table definition previews with dynamic SVG plots on field hovers, with automatic theme adaptation.
- **Index**: Implemented project-level reference index cache across Include hierarchies for multi-file curve/table definition resolution.
- **Data**: Upgraded PyDyna keyword schema mapping to accurately capture LCID/TBID field references.

## [3.0.8] - 2026-06-22

### Added
- **Quality**: Added CI-enforced contracts for manifest settings, activation events, localization parity, README defaults, command registration, and strict UTF-8 documentation.
- **Diagnostics**: Added an explicit `include-path-too-long` diagnostic for LS-DYNA Include paths beyond the confirmed three-line/236-character limit.

### Changed
- **Parser**: Unified indented and mixed-case keyword recognition across Include, block, keyword, parameter, and navigation paths; large-file tail scans now report real line numbers.
- **Workspace**: Watchers now include `.asc` and valid configured extensions, rebuild on configuration changes, and refresh projects when previously missing Include files appear.
- **Diagnostics**: Project diagnostics are merged by project root, so refreshing one root no longer removes another root's shared-file diagnostics; stale document diagnostics are cleared.
- **Docs**: Restored 61 corrupted Superpowers records from strict UTF-8 Git history and aligned both READMEs with all 11 manifest settings.

### Security
- **Windows**: Replaced shell-built PDF and Explorer commands with parameterized `spawn` (`shell: false`) and VS Code's `revealFileInOS`/`openExternal` APIs.

## [3.0.7] - 2026-06-20
### Added
- **Features**: Added i18n support and a setup guide dialogue for configuring the PDF manual directory (`configureManualsDir`).
- **Features**: Enhanced keyword hover messages with a direct setup guide link for the PDF manual.
- **CI/CD**: Auto-tagging and streamlined dual marketplace releases (Open VSX and VS Code Marketplace).
- **CI/CD**: Upgraded GitHub Actions runtime to Node 24.
- **Docs**: Added PDF manual setup instructions and Open VSX marketplace badges to README.

### Changed
- **Tests**: Renamed `phase7_features.test.js` to `advanced_features.test.js` and updated related references.

## [3.0.6] - 2026-06-20
### Added
- **Assets**: Switched to brand new DynaSense extension icons and refined the activity bar icon.

### Fixed
- **Editor**: Added a custom tooltip to `*INCLUDE_PATH` DocumentLinks to override the default confusing "Execute Command" tooltip.

## [3.0.5] - 2026-06-18
### Changed
- **Enhancement**: Continuous improvements and bug fixes for LS-DYNA syntax parsing and language features.

## [3.0.4] - 2026-06-17
### Changed
- **Enhancement**: Core IntelliSense engine updates and stability improvements.

*(Older versions are not listed here but can be found in the git commit history.)*
