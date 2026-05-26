# VS Code LS-DYNA Extension i18n Localization Design Specification

This specification outlines the architecture, design, and implementation plan for adding full multi-language (Chinese and English) support to the LS-DYNA VS Code extension.

---

## 1. Requirements & Goals

- **Configuration Control**: Add a setting `lsdyna.language` in VS Code settings allowing the user to explicitly select either `zh-cn` (Simplified Chinese) or `en` (English). Default is `zh-cn`.
- **Dynamic Hot-Reload**: Toggling the language setting must update the extension's UI prompts, warnings, and Hover card text **instantly** without requiring a VS Code reload or window reload.
- **Robust Field Data Fallback**: 
  - If language is set to `zh-cn`, try loading `field_data_zh.json`. If it fails to load, gracefully fall back to the English `field_data.json` so the extension doesn't break.
  - If language is set to `en`, directly load `field_data.json` to conserve memory (~11MB saved).
- **Comprehensive UI Localization**: Translate all extension-host warnings, informational popups, custom hover panel link labels, and tree view warnings.
- **Packaging Integrity**: Ensure `field_data_zh.json` is packaged and included in final `.vsix` releases.

---

## 2. Architecture & Components

### 2.1 Localization Manager (`src/core/i18n.js` - [NEW])
A lightweight, zero-dependency key-value translation manager that holds dictionaries for `zh-cn` and `en` text. It supports basic variable formatting (e.g. `i18n.get('page', 24)` -> `第 24 页` or `Page 24`).

### 2.2 Configuration Binding (`src/extension.js` - [MODIFY])
Listens to `vscode.workspace.onDidChangeConfiguration`. On `lsdyna.language` changes, it updates the language state in `i18n` and invalidates the cached `_fieldData` schema, ensuring the next Hover query pulls the newly configured language package.

### 2.3 Packaging Rules (`.vscodeignore` - [MODIFY])
Includes `!keywords/field_data_zh.json` to white-list it from the ignored `keywords/**` folder.

---

## 3. UI Translations Map

| Key | Chinese (`zh-cn`) | English (`en`) |
| :--- | :--- | :--- |
| `openFileFirst` | 请先打开一个 LS-DYNA 文件。 (Debug: {0}) | Please open an LS-DYNA file first. (Debug: {0}) |
| `indexingKeywords` | 正在扫描关键字… | Scanning keywords… |
| `manualDirNotConfigured`| 未设置手册路径。配置后可在悬停时快速阅读 PDF 原文书签页。| Manuals directory is not configured. Configure it to quickly view PDF manual bookmarks on hover. |
| `configureFolder` | ⚙️ 设置手册文件夹 (Configure Folder) | ⚙️ Configure Manuals Folder |
| `modifyManualPath` | 修改手册路径 | Modify manuals directory |
| `page` | 第 {0} 页 | Page {0} |
| `openNewTab` | 在新标签打开链接 | Open link in new tab |
| `openSplit` | 分栏打开 | Open link in split editor |
| `openFolder` | 打开文件所在路径 | Open containing folder |
| `selectFolder` | 设置 LS-DYNA 手册目录 | Configure LS-DYNA Manuals Directory |
| `manualDirSetTo` | LS-DYNA 手册目录已设置为: {0} | LS-DYNA manuals directory set to: {0} |
| `sumatraNotFound` | 未在所选手册文件夹中找到 SumatraPDF.exe。在 Windows 系统上，请将 SumatraPDF.exe 复制到该目录下以启用精确页码跳转。 | SumatraPDF.exe not found in the selected folder. On Windows, please copy SumatraPDF.exe into this folder for precise page navigation. |
| `notFound` | 未找到 | Not found |

---

## 4. Verification & Testing

- **Configuration Changes**: Toggling settings from `zh-cn` to `en` changes hovers and logs immediately.
- **Unit Tests Adaptation**: Update `test/extension.test.js` to run in both locales or gracefully assert English when default is English, and Chinese when default is Chinese.
