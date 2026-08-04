# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/extension-icon.png" width="120" height="120" alt="DynaSense Icon">
  <h3>An LS-DYNA deck editor for VS Code</h3>
  <p>Keyword help, fixed-width card editing, Include Tree navigation, reference previews, and local manuals for CAE engineers.</p>

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Available-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
[![Open VSX](https://img.shields.io/open-vsx/dt/hqyyqh/dynasense?label=Open%20VSX&logo=eclipse-ide)](https://open-vsx.org/extension/hqyyqh/dynasense)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

[English Version](README.md) | [中文说明](README_zh.md)

---

## Quick start

Install DynaSense from the VS Code Marketplace or Open VSX, then:

1. **Open a deck** — open a `.k`, `.key`, or `.dyna` file, whether it is a main deck or an included file.
2. **Insert a keyword** — type `*` to choose from more than 4,700 keywords and insert a ready-made card layout.
3. **Edit by field** — press `Tab` / `Shift+Tab` on a data line. Delete clears the selected field without shifting later fields; typing after Tab replaces that field only.
4. **Read help and references** — hover a keyword, field, parameter, curve ID, or table ID.
5. **Scan the model** — open **LS-DYNA** in the activity bar → **Include Tree**, then scan from the main file.

| Keyword completion | Field help |
| :---: | :---: |
| ![Keyword completion](./images/completion_keyword.gif) | ![Field help](./images/hover_hints.gif) |

---

## Core workflows

### Edit keyword cards safely

- Keyword and field data come from the open-source [ansys/pydyna](https://github.com/ansys/pydyna) project and cover more than 4,700 keywords.
- Snippets insert formatted cards. Keyword hover actions let you select cards, formats, and optional fields where supported.
- `Tab` follows the actual 10-character or 8-character field widths. After the last field, the next Tab returns to the first field on the **same data line**; it does not create or enter another line.
- Type `$` or `$#` to generate aligned field-header comments. `Ctrl+/` adds or removes the LS-DYNA `$` line comment marker.
- Format a selection or the whole file on demand. Automatic formatting is experimental and off by default because it rewrites card spacing.

| Include path completion | Tab navigation | Formatting |
| :---: | :---: | :---: |
| ![Include completion](./images/completion_include.gif) | ![Tab navigation](./images/tab_navigation.gif) | ![Formatting](./images/auto_format.gif) |

### Manage `*INCLUDE` files

- On the filename line below `*INCLUDE`, type `/` or `\` to browse one folder level at a time. Type a filename or part of one, such as `LC_Front`, to search all subfolders. Accepted paths use forward slashes for easier transfer to Linux.
- Scan the Include Tree from the main deck to apply its `*INCLUDE_PATH` and `*INCLUDE_PATH_RELATIVE` directories to included files. If an included file is opened alone before a scan, only that file's folder and its own path cards are known.
- An underlined path was found locally and can be opened. A trailing **!** means that the file was not found using the currently known folders; it may also mean the file has not been synchronized to this computer.
- The tree reports real circular includes as errors. Reusing one material file from several parents is normal and is not treated as a cycle.
- Hover a path to preview its header. Paths beyond LS-DYNA's three-line, 236-character limit are reported before submission.

On Windows, `sub/part.k` may still open when the disk path is `Sub/Part.k`, but Linux normally requires exact capitalization. The default `crossPlatform` check keeps navigation working and warns about the mismatch; use `strict` for a final Linux submission check.

| Include Tree | Include preview |
| :---: | :---: |
| ![Include Tree](./images/include_tree.gif) | ![Include preview](./images/open_include.png) |

### Check parameters, curves, and referenced definitions

- Hover `&name` to see its source definition in the current file and, after a project scan, its effective value at that occurrence in the selected or uniquely identified main-deck context.
- Hover supported curve and table reference fields to inspect their definitions and graphical 1D or combined 3D previews. When several targets are possible, DynaSense lists the candidates instead of silently choosing one.
- Use **Go to Definition** for resolved references. If a file can belong to more than one model, run **Select Main Deck Context** so inherited parameters and references are evaluated in the intended model.
- `F2` renames a parameter within the current document. `Ctrl+Alt+Up` / `Ctrl+Alt+Down` jumps to the previous or next keyword.
- If a valid keyword is newer than the bundled library, add it to the custom valid list from its hover, a Quick Fix, or DynaSense quick actions.

![Parameter hints](./images/parameter_hints.png)

### Read local manuals beside the deck

A complete manual pack adds keyword/title and full-text search, chapter navigation, independent text sizing, reading progress, image zoom, and PDF page jumps. The bilingual pack also provides English/Chinese switching and sentence translation previews where translations exist. The reader restores the previous reading position and normally opens beside the deck editor.

See [Manual setup](#manual-setup) for the current downloads. The pack must be fully extracted so the reader can use its `manifest.json`, indexes, images, and PDF files together.

### Track this editing session

- Session change marks work without Git. The default amber/green colors automatically switch for light, dark, and high-contrast themes; you can instead choose an orange/blue, red/blue, high-contrast, or custom scheme in VS Code Settings. Different marker shapes distinguish modified, inserted, and deleted lines.
- Commands are available for next/previous mark, comparison with the opened or saved version, and resetting the baseline.
- Very large decks use limited scanning and can skip change marks to keep editing responsive. Enable a full scan only when complete indexing is needed and the additional load time is acceptable.

---

<a id="manual-setup"></a>

## Manual setup

PDF manuals are not included in the `.vsix` because of their size. Download one complete **2026-08-04** manual pack:

| Manual pack | Download |
| --- | --- |
| **English original** | [Download `lsdyna-manual-pack-en_20260804.zip`](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-en_20260804.zip) |
| **Bilingual: English original + Chinese translation** | [Download `lsdyna-manual-pack-bilingual_20260804.zip`](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-bilingual_20260804.zip) |

> **Authority notice:** Only the PDF manuals are the official, authoritative reference. The in-editor text, Chinese translations, hover summaries, search results, and indexes are convenience aids. If any content differs, follow the PDF manual.

1. Download one package and fully extract it to a stable local folder; do not select the zip file itself.
2. Run **Set LS-DYNA Manuals Directory**, or edit `lsdyna.manualsDir` in VS Code Settings.
3. Select the outer extracted folder that contains `manifest.json`.
4. Run **LS-DYNA: Open Manual Reader**, or open a section from the **Manuals** view.

**Important notes**

- The pack uses the third-party [SumatraPDF](https://www.sumatrapdfreader.org/free-pdf-reader) application to open the official PDF at the requested page. SumatraPDF supports **Windows only**.
- The in-editor manual reader remains available on Windows, macOS, and Linux. On non-Windows systems, PDFs open in the system's default application, which may ignore the requested page number.
- Keep the extracted folder structure intact. Moving or renaming the whole outer folder is fine, but renaming or deleting its internal `manifest.json`, index, image, or PDF files can break search, images, or PDF links.
- The English pack contains the English original only. Install the bilingual pack when Chinese content and translation previews are required.

---

## Common settings

Search for `LS-DYNA` in VS Code Settings. Most users only need these options:

| Setting | Default | When to change it |
| :--- | :--- | :--- |
| `lsdyna.manualsDir` | `"lsdyna_manual_pack"` | Select the fully extracted manual-pack folder containing `manifest.json`. |
| `lsdyna.include.pathCaseCheck` | `"crossPlatform"` | Use `strict` before submitting to Linux when capitalization must match exactly. |
| `lsdyna.enableTabNavigation` | `true` | Turn off to restore normal Tab spaces. |
| `lsdyna.enableCellEditProtect` | `true` | Keeps Delete/Backspace from shifting later fixed-width fields. |
| `lsdyna.enableFieldHover` | `true` | Turn off for a quieter editor; include, keyword, and parameter help remains available. |
| `lsdyna.unknownKeywordSeverity` | `"error"` | Lower to warning, hint, or off if your solver is newer than the bundled library. |
| `lsdyna.scanner.fullScanLargeFiles` | `false` | Enable only when a complete index of very large files is required. |
| `lsdyna.language` | `"auto"` | Changes the extension interface language; manual content still depends on the installed pack. |

<details>
<summary><strong>Advanced options and appearance</strong></summary>

The complete settings index is kept here for release checks and advanced use; normal workflows do not require changing these defaults.

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| `lsdyna.changeMarks.enabled` | `true` | Show changes made during this editing session. |
| `lsdyna.changeMarks.colorScheme` | `"adaptive"` | Pick one adaptive preset, or choose `custom`; all preset colors switch with the active light/dark theme. |
| `lsdyna.changeMarks.customUnsavedColor` | `"#e2a03a"` | Unsaved color used only by the custom scheme (`#RRGGBB`). |
| `lsdyna.changeMarks.customSavedColor` | `"#89d185"` | Saved-since-open color used only by the custom scheme (`#RRGGBB`). |
| `lsdyna.changeMarks.maxLineCount` | `100000` | Skip session marks above this file size. |
| `lsdyna.changeMarks.debounceMs` | `250` | Wait this many milliseconds after editing before refreshing marks. |
| `lsdyna.changeMarks.showOverviewRuler` | `true` | Show marks on the editor overview ruler. |
| `lsdyna.changeMarks.showLineBackground` | `true` | Add a light tint to changed lines. |
| `lsdyna.changeMarks.showMinimap` | `true` | Show saved and unsaved changes in the minimap. |
| `lsdyna.navigation.pulseOnJump` | `true` | Briefly highlight the destination after a jump. |
| `lsdyna.statusBar.level` | `"simple"` | Choose off, simple, or detailed current-file status. |
| `lsdyna.health.showFirstRunNotice` | `true` | Show one-time setup guidance. |
| `lsdyna.largeFile.enableRendering` | `true` | Disable extra rendering only for exceptionally large files. |
| `lsdyna.codeLens.showOnAllKeywords` | `false` | Show extra actions above every keyword. |
| `lsdyna.hover.previewMaxLines` | `20` | Limit lines shown in an include-file preview. |
| `lsdyna.autoFormat` | `"disabled"` | Experimental automatic card formatting after leaving a line. |
| `lsdyna.additionalExtensions` | `[".k",".key",".dyna",".asc"]` | File suffixes treated as LS-DYNA decks. |
| `lsdyna.ignoreFormattingKeywords` | `[]` | Keywords excluded from formatting and field tools. |
| `lsdyna.customValidKeywords` | `["*END","*TITLE","*CASE_BEGIN","*CASE_END"]` | Confirmed keywords that should not be reported as unknown. |
| `lsdyna.warnLowercaseKeyword` | `false` | Warn when a keyword is not uppercase. |

For a custom suffix, also use VS Code's `files.associations`, for example `"*.my_ext": "lsdyna"`. The color-scheme setting is the recommended way to customize every change-mark layer consistently. Existing `lsdyna.changeMarks.unsaved` and `.saved` entries under `workbench.colorCustomizations` remain compatible in adaptive mode.

</details>

> **Before submitting a model:** scan the Include Tree from the correct main deck → resolve every missing **!** → remove circular includes → use strict path-capitalization checking for Linux → confirm that the submitted folders match the scanned `*INCLUDE_PATH` layout.

---

## Credits and contributors

Maintained by [hqyyqh](https://github.com/hqyyqh) as a deep customization of the LS-DYNA VS Code ecosystem.

- **Upstream:** [osullivryan/vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) — thanks to [osullivryan](https://github.com/osullivryan), [DCHartlen](https://github.com/DCHartlen), [maxiiss](https://github.com/maxiiss), and [yshl](https://github.com/yshl).
- **Keyword data:** [ansys/pydyna](https://github.com/ansys/pydyna).
- **Also inspired by:** [vim-lsdyna](https://github.com/gradzikb/vim-lsdyna) and the wider LS-DYNA editor community.
