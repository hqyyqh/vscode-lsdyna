# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/extension-icon.png" width="120" height="120" alt="DynaSense Icon">
  <h3>A Feature-Rich LS-DYNA Editor for VS Code</h3>
  <p>Built for CAE engineers: intelligent autocomplete, large file preview, and auto-alignment.</p>

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Available-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
[![Open VSX](https://img.shields.io/open-vsx/dt/hqyyqh/dynasense?label=Open%20VSX&logo=eclipse-ide)](https://open-vsx.org/extension/hqyyqh/dynasense)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

[English Version](README.md) | [中文说明](README_zh.md)

---

## 🌟 Core Features

<details open>
<summary><b>📖 LS-DYNA Manual Integration & Interactive Hover</b> (Click to expand)</summary>
<br>

- **Interactive Hover Cards:** Keyword and field hover tooltips provide direct links to the corresponding page in the LS-DYNA PDF manual.
- **Fast Search:** Powered by a custom binary PDF bookmark engine for fast retrieval.
- **Field-level Tooltips:** Hover cards explain the keyword and detail the type, length, and default values of each specific field.

![Hover Hints](./images/hover_hints.gif)

</details>

<details open>
<summary><b>⚡ Autocomplete & Formatting</b> (Click to expand)</summary>
<br>

- **Keyword Coverage:** Data is extracted from the official [ansys/pydyna](https://github.com/ansys/pydyna) database, supporting over **3100+** keywords.
- **Snippets:** Offers formatted snippet templates for rapid keyword insertion.
- **Path Autocomplete:** Type `/` to autocomplete included files in the same directory, filtering invalid paths.
- **Auto Comment Generation:** Use `$` or `#` to trigger automatic generation of field comments, right-aligned with no trailing spaces.
- **Tab Navigation:** Press `Tab` to jump between fields distributed across 10-character widths, with auto line wrapping.
- **Formatting:** Format data into the **10-column / 8-column** layout. Optional cursor-leave formatting is available through the experimental `lsdyna.autoFormat` setting and is disabled by default.

> **Feature Demos:**
> 
> | 🔑 Keyword Completion | 🛤️ Path Completion |
> | :---: | :---: |
> | ![Keyword Completion](./images/completion_keyword.gif) | ![Include Completion](./images/completion_include.gif) |
> | **📝 Quick Comment** | **📐 Tab Jumping** |
> | ![Comment Completion](./images/completion_comment.gif) | ![Tab Navigation](./images/tab_navigation.gif) |
> | **✨ Formatting** | |
> | ![Auto Formatting](./images/auto_format.gif) | |

</details>

<details open>
<summary><b>📂 Include Management & Fast Preview</b> (Click to expand)</summary>
<br>

- **Status Highlight & Relative Paths:** `*INCLUDE` paths are highlighted in blue (resolved) or orange (missing). Resolves relative paths like `*INCLUDE_PATH` and `../`.
- **Large File Preview:** Hover over include paths to utilize an internal O(1) async streaming reader to show header previews.
- **Project Include Tree:** Presents the nested **hierarchy reference tree** of the main model and all sub-included files in the sidebar.
- **Keyword Index Outline:** The sidebar provides an overview tree of all **used keywords** in the current file, with jump-to-definition.

| Include Tree & Index | Hover Preview |
| :---: | :---: |
| ![Include Tree](./images/include_tree.gif) | ![Open Include](./images/open_include.png) |

</details>

<details open>
<summary><b>🛠️ Navigation & Parameter (*PARAMETER) Tracking</b> (Click to expand)</summary>
<br>

- **Interactive CodeLens:**
  - Renders **"N references"** CodeLens above parameter definitions; click to open the reference list.
  - Offers formatting and option swapping for keywords (e.g., appending `_TITLE` to `*PART`).
- **Parameter Resolution:** Hovering over `&parameter` variables parses their evaluated values.
- **Global Rename:** Rename parameters globally across the document using the F2 key.
- **Editing Shuttle:** Use `Ctrl+Alt+Up` / `Ctrl+Alt+Down` to warp to the previous/next keyword start; supports syntax highlighting and code folding for `.k`, `.key`, `.dyna`, `.cfile` formats.

![Parameter Hints](./images/parameter_hints.png)

</details>

---

<a id="manual-integration-setup"></a>

## 📖 PDF Manual Integration Setup

> **Note**: Due to size limits, offline PDF manuals are not packaged within the `.vsix` extension. You can easily configure them using either of the methods below.

#### 🚀 Method 1: Download Pre-packed ZIP (Recommended)
We have pre-packed plug-and-play zip files with SumatraPDF included.

- **English Version**: [Download lsdyna_manual_pack_en.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna_manual_pack_en.zip)

**How to use**:
Extract the downloaded zip to any location on your PC. Then, click the **gear icon (⚙️)** on any hover card in VS Code to set the directory path to your extracted folder.

#### 🛠️ Method 2: DIY Setup
If you prefer using your own PDF files, follow these steps:
1. Download manuals from [Ansys LS-DYNA Official Website](https://lsdyna.ansys.com/manuals-download/).
2. Download a **Portable** version of SumatraPDF from [SumatraPDF Official Website](https://www.sumatrapdfreader.org/free-pdf-reader).
3. Place all the downloaded PDF files and `SumatraPDF.exe` into the same folder.
4. Click the **gear icon (⚙️)** on the hover card, or search for `lsdyna.manualsDir` in settings to point to this folder.

> ⚠️ **Important Note**
> The extension indexes PDF pages entirely based on **PDF Bookmarks**. Filenames do not affect the search, but if you modify or merge the PDFs, **you must preserve the original bookmarks** for the precise navigation to work.

On Windows, placing `SumatraPDF.exe` in the manuals directory enables precise page jumps. If SumatraPDF is unavailable or cannot start, DynaSense safely falls back to the system default PDF application; that application may ignore the requested `#page=` fragment.

---

## ⚙️ Extension Settings

In VS Code's `settings.json`, you can customize the following exclusive configurations:

| Setting | Default | Description |
| :--- | :--- | :--- |
| `lsdyna.manualsDir` | `"lsdyna_manual_pack"` | Directory containing LS-DYNA PDF manuals and, on Windows, the optional `SumatraPDF.exe`. |
| `lsdyna.enableTabNavigation` | `true` | Enable smart Tab/Shift+Tab field navigation. |
| `lsdyna.largeFile.enableRendering` | `true` | Enable editor rendering features for very large LS-DYNA files. |
| `lsdyna.codeLens.showOnAllKeywords` | `false` | Show keyword option CodeLens on every supported keyword. |
| `lsdyna.hover.previewMaxLines` | `20` | Controls the maximum number of lines displayed when hovering over an included file. |
| `lsdyna.autoFormat` | `"disabled"` | Experimental cursor-leave formatting mode: `onBlur` or `disabled`. |
| `lsdyna.language` | `"auto"` | Extension UI and hover language: follow VS Code, Simplified Chinese, or English. |
| `lsdyna.additionalExtensions` | `[".k",".key",".dyna",".asc"]` | Additional suffixes associated with the LS-DYNA language. |
| `lsdyna.scanner.fullScanLargeFiles` | `false` | Fully scan large files instead of the optimized head/tail strategy. |
| `lsdyna.ignoreFormattingKeywords` | `[]` | Keyword names or prefixes excluded from formatting, Tab alignment, and comment completion. |
| `lsdyna.customValidKeywords` | `["*END","*TITLE","*CASE_BEGIN","*CASE_END"]` | Additional keywords accepted by validation; a trailing `*` acts as a prefix wildcard. |

> [!TIP]
> **File Associations & Icons**
> By default, this extension targets `.k`, `.key`, `.dyna`, `.asc` files. If you want your custom files to not only be highlighted but also display the **exclusive blue engineering icon** in the file explorer, use the global setting:
> `"files.associations": { "*.my_ext": "lsdyna" }`

---

## Credits & Contributors

This project is a deeply customized and refactored version maintained by [hqyyqh](https://github.com/hqyyqh).
Special thanks to the following upstream open-source projects and original authors, without whose outstanding work this project would not exist:

- **Upstream Project:** This project is forked from [osullivryan/vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna). Huge thanks to the original author and core contributors:
  - [osullivryan](https://github.com/osullivryan) (Original Author & Founder)
  - [DCHartlen](https://github.com/DCHartlen) (Core Contributor)
  - [maxiiss](https://github.com/maxiiss) (Core Contributor)
  - [yshl](https://github.com/yshl) (Contributor)
- **Database Source:** The powerful keyword and field intelligent autocomplete data heavily references and extracts from the official open-source project [ansys/pydyna](https://github.com/ansys/pydyna).
- **Other References:** Excellent ecosystem works like [vim-lsdyna](https://github.com/gradzikb/vim-lsdyna).

Thank you to all developers who have contributed to the LS-DYNA editor ecosystem!

