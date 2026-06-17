# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/ls.svg" width="120" height="120" alt="LS-DYNA Icon">
  <h3>A Feature-Rich LS-DYNA Editor for VS Code</h3>
  <p>Built for CAE engineers: intelligent autocomplete, large file preview, and auto-alignment.</p>

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/hqyyqh.dynasense?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
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
- **Formatting:** Format to align data into the **10-column / 8-column** layout. Supports **auto-format on save**.

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

## ⚙️ Extension Settings

In VS Code's `settings.json`, you can customize the following exclusive configurations:

| Setting | Default | Description |
| :--- | :--- | :--- |
| `lsdyna.additionalExtensions` | `[".txt"]` | Dynamically add custom file extensions you want the extension to highlight. |
| `lsdyna.hover.previewMaxLines` | `20` | Controls the maximum number of lines displayed when hovering over an included file. |
| `lsdyna.format.enableOnSave` | `true` | Enables auto-formatting of data fields on the line where the cursor is located when saving (Ctrl+S). |
| `lsdyna.index.enableIncludeTree` | `true` | Enables the `*INCLUDE` nested hierarchy tree view in the sidebar. |

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

