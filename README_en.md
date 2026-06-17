# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/ls.svg" width="120" height="120" alt="LS-DYNA Icon">
  <h3>The Ultimate LS-DYNA Engineering Editor for VS Code</h3>
  <p>Built for real CAE engineers: massive intelligent autocomplete, ultra-fast large file preview, and OCD-saving auto-alignment.</p>

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/hqyyqh.dynasense?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

[English Version](README_en.md) | [中文说明](README.md)

---

## 🌟 Core Features

### 1. 🧠 Intelligent Autocomplete & IntelliSense
* **Full Keyword Coverage:** Data is deeply extracted from the official [ansys/pydyna](https://github.com/ansys/pydyna) database, supporting syntax tree parsing for over **3100+** LS-DYNA keywords.
* **Smart Field Snippets:** Not only does it autocomplete keywords, but it intelligently pops up snippet templates with detailed annotations (length, type, default values) as you type.

### 2. ⚡️ Ultra-Fast O(1) Hover Preview
* Say goodbye to UI freezing when opening huge `.k` files!
* Hover over the file path after `*INCLUDE` or `*INCLUDE_PATH` to **instantly preview** the header content of the included file.
* Utilizing an internal O(1) asynchronous block stream reader, previews pop up in milliseconds regardless of whether the included file is a few megabytes or several gigabytes.
* *Preview length is customizable in settings.*

### 3. 🎨 OCD-Saving Code Formatting
* One-click formatting to align messy field data into the perfectly neat **10-column / 8-column** classic LS-DYNA standard format.
* Supports shortcut trigger (`Ctrl+Shift+F`) and **auto-formatting the current line on save**.
* `*INCLUDE` paths are automatically padded to 512 columns to prevent truncation.

### 4. 💡 Smart Interactive CodeLens
* Dynamically renders clickable action buttons (CodeLens) right above your keywords.
* **One-click Option Swapping:** Easily append options like `_TITLE` to keywords (e.g., `*PART`).
* **Precision Formatting:** Quickly format the specific keyword block you are currently working on.

### 5. 🗺️ Project Navigation Outline
* **Include Tree:** Clearly presents the nested hierarchy tree of the main model and all sub-included files in the sidebar.
* **Keyword Index:** Provides an overview of all keywords in the current file with blazing-fast jump-to-definition.

### 6. 🚀 Immersive Editing Shortcuts
* **Smart Tab Jumping:** Flawlessly jump between standard 10-character width fields (Cells) using `Tab` and `Shift+Tab`.
* **Keyword Shuttle:** Use `Ctrl+Alt+Up` / `Ctrl+Alt+Down` to warp directly to the start of the previous/next keyword across thousands of lines of text.

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

