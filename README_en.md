# VS Code LS-DYNA extension
[简体中文](README.md)

> [!NOTE]
> **Customized Version Notice (Modified by hqyyqh)**
> This extension is a customized version based on the original [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) developed by Ryan O'Sullivan ([osullivryan](https://github.com/osullivryan)).
> - **Modifier:** hqyyqh (Modified starting May 2026)
> - **Source Code:** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **License:** Distributed under the GNU General Public License v3.0 (GPL-3.0). All original licenses and credits are preserved.

![Version](https://img.shields.io/badge/version-2.0.7--hqyyqh.0-blue)

<img alt="GitHub Actions" src="https://img.shields.io/github/actions/workflow/status/osullivryan/vscode-lsdyna/master_ci.yaml?branch=master&style=for-the-badge&label=CI">

## Integrates [LS-DYNA](https://www.lstc.com/) into VS Code.

This extension integrates LS-DYNA formatting, keyword snippets, and language tooling into VS Code.

### Installation

Please visit the project's [Releases page](https://github.com/hqyyqh/vscode-lsdyna/releases) to download the latest `.vsix` extension package, and install it in VS Code via "Install from VSIX". For specific dependency configurations and FAQs, please refer to the installation guide on that page.

### Features

**Syntax & Navigation**
- Syntax highlighting for `.k`, `.key`, and `.dyna` files
- Keyword folding — each `*KEYWORD` block collapses independently
- Jump to next/previous keyword: `Ctrl+Alt+Down` / `Ctrl+Alt+Up`
- Select the current keyword block via the right-click context menu
- Support mapping custom file extensions to the LS-DYNA language mode via settings

![Plugin Settings](images/设置.png)

**Include Files (*INCLUDE)**
- `*INCLUDE` filenames are highlighted green (resolved) or red (missing), including continued filenames and multiple files listed under one exact `*INCLUDE` block
- Right-click an include filename → **Open *INCLUDE File**, or Ctrl/Cmd+Click
- Resolves `*INCLUDE_PATH`, `*INCLUDE_PATH_RELATIVE`, and `../` style relative paths
- Autocomplete for same-directory include paths (triggered by slash `/` or backspace, automatically filtering out remote/invalid paths)
  ![Include File Completion](images/include文件补全.gif)
- Hover actions on include files to jump or inspect target file details
![Include File Actions](images/打开include文件.png)

**Parameters (*PARAMETER)**
- Rename parameter across the file (F2)
- Inlay hints show the resolved value of each `&parameter` reference inline
- "N references" CodeLens above each parameter definition — click to open the References panel
- Bare variable names in `*PARAMETER_EXPRESSION` values are highlighted the same color as `&param` references

![Parameter Hints](images/参数提示.png)

**LS-DYNA Manual Integration**
- Bookmark-based PDF manual indexing and cache for instant search
- Interactive hover cards: Keyword and field hovers display links to the exact page of the LS-DYNA PDF manual
  ![Hover Hints](images/悬浮提示.gif)
- Hover cards contain detailed descriptions of each field of the keyword

**Sidebar Panel**
- Recursively scans all `*INCLUDE` files and displays them as a tree
- Shows all keywords used in the current file.
![Include Tree](images/引用树.gif)

**Diagnostics**
- Lines exceeding 80 characters (excluding comments) are flagged as warnings.
- Missing include files are flagged as warnings directly on their inclusion lines.

**Smart Autocomplete & Formatting**
- Tab-completable snippets for common LS-DYNA keywords
  ![Keyword Completion](images/关键字补全.gif)
- **Smart Tab Navigation**: Press `Tab` to align fields to their physical columns, loop through fields on the current line, and automatically wrap to the next line smoothly
  ![Tab Navigation](images/tab跳转和编辑.gif)
- **Comment Completion**: Trigger field comment generation using `$` or `#`, perfectly right-aligned without trailing spaces
  ![Comment Completion](images/注释补全.gif)
- Automatically format data lines
  ![Auto Formatting](images/自动格式化.gif)

**LS-PrePost**
- Syntax highlighting for `.cfile` command files

### Settings

In addition to standard VS Code settings, this extension provides several dedicated configuration options.

**LS-DYNA Dedicated Settings:**

| Setting | Default | Description |
|---|---|---|
| `lsdyna.language` | `"zh-cn"` | Select the UI and Hover language for the extension (supports `zh-cn` and `en`) |
| `lsdyna.manualsDir` | `""` | Path to the directory containing LS-DYNA PDF manuals (absolute or workspace-relative). On Windows, copy `SumatraPDF.exe` into this folder for precise page navigation. |
| `lsdyna.additionalExtensions` | `[".k", ".key", ".dyna", ".asc"]` | Additional file extensions to associate with the LS-DYNA language |

**Recommended VS Code Settings:**

| Setting | Default | Description |
|---|---|---|
| `editor.hover.enabled` | `true` | Show keyword and field hover tooltips |
| `editor.inlayHints.enabled` | `on` | Show resolved parameter values inline |
| `editor.codeLens` | `true` | Show "N references" above parameter definitions |
| `editor.wordWrap` | `off` | Word wrap (recommended off for fixed-width columns) |

These can be scoped to LS-DYNA files only by adding them under `"[lsdyna]"` in your `settings.json`:

```json
"[lsdyna]": {
    "editor.hover.enabled": false,
    "editor.inlayHints.enabled": "off"
}
```

### Keyword Data

Snippets and hover documentation are generated from the [pydyna](https://github.com/ansys/pydyna) keyword database (`kwd.json`), which is maintained by Ansys and covers 3168 LS-DYNA keywords with full field definitions, types, defaults, and help text. This data is used at build time only — it is not bundled in the extension.

To regenerate after updating pydyna:

```bash
# Clone pydyna as a sibling of this repo (one-time setup)
git clone https://github.com/ansys/pydyna ../pydyna

# Regenerate snippets and hover field data
python keywords/generate_from_pydyna.py
```

This overwrites `snippets/lsdyna.json` and `keywords/field_data.json`.

### Contributing new Keywords

There are a few ways you can go about adding keywords or features:

1. Send me an email or message on Github with the desired keyword (and an example).
2. Make a pull request:
    1. Create a fork of the master.
    2. Clone [pydyna](https://github.com/ansys/pydyna) as a sibling directory (`../pydyna`).
    3. Run `python keywords/generate_from_pydyna.py` from the repo root to regenerate `snippets/lsdyna.json` from the full pydyna keyword database (3168 keywords).
    4. Create a new pull request to merge your branch into master.

### Contributors

- [osullivryan](https://github.com/osullivryan) (Original Author)
- [hqyyqh](https://github.com/hqyyqh) (Customized Version Maintainer)
- [yshl](https://github.com/yshl)
- [maxiiss](https://github.com/maxiiss)

### Some References

[vim-lsdyna](https://github.com/gradzikb/vim-lsdyna)  
[DCHartlen's vscode extension](https://github.com/DCHartlen/LSDynaForVSCode)