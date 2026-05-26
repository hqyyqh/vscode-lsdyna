# LS-DYNA VS Code Extension Sidebar Localization Refinement Design Spec

This specification outlines the refinement of the Simplified Chinese (`zh-cn`) and English (`en`) translations for the LS-DYNA sidebar (Include Tree & Keyword Index views) to improve quality ("信达雅") and complete full localization coverage.

## 1. Goal Description
The objective is to refine dynamic translation quality to align with LS-DYNA professional terminology, and to fix a critical completeness issue where the static contributions in `package.json` (such as sidebar titles, view names, welcome page content, and tool bar commands) were left unlocalized in English.

---

## 2. Static NLS Localization (`package.json` Integration)
We will introduce standard VS Code NLS localization by creating package localization bundles and extracting raw English labels into placeholders in `package.json`.

### 2.1 Modifying [package.json](file:///d:/Project/vscode-lsdyna/package.json)
We will replace hardcoded values with NLS `%placeholder%` markers:
- `contributes.viewsContainers.activitybar[0].title` -> `"%viewsContainers.lsdyna-includes.title%"`
- `contributes.views["lsdyna-includes"][0].name` -> `"%views.lsdynaIncludeTree.name%"`
- `contributes.views["lsdyna-includes"][1].name` -> `"%views.lsdynaKeywordIndex.name%"`
- `contributes.viewsWelcome[0].contents` -> `"%viewsWelcome.lsdynaIncludeTree.contents%"`
- `contributes.viewsWelcome[1].contents` -> `"%viewsWelcome.lsdynaKeywordIndex.contents%"`
- `contributes.commands` (sidebar-specific commands):
  - `extension.scanIncludeTree` title -> `"%commands.scanIncludeTree.title%"`
  - `extension.scanKeywordIndex` title -> `"%commands.scanKeywordIndex.title%"`
  - `extension.keywordIndexSetLocal` title -> `"%commands.keywordIndexSetLocal.title%"`
  - `extension.openToSide` title -> `"%commands.openToSide.title%"`
  - `extension.revealInExplorer` title -> `"%commands.revealInExplorer.title%"`

### 2.2 [NEW] [package.nls.json](file:///d:/Project/vscode-lsdyna/package.nls.json)
```json
{
    "viewsContainers.lsdyna-includes.title": "LS-DYNA Include Tree",
    "views.lsdynaIncludeTree.name": "Include Tree",
    "views.lsdynaKeywordIndex.name": "Keyword Index",
    "viewsWelcome.lsdynaIncludeTree.contents": "Welcome to LS-DYNA Include Tree!\n[Scan Include Tree](command:extension.scanIncludeTree)\nTo get started, open an LS-DYNA file (`.k`, `.key`, `.dyna`) and click the scan button.",
    "viewsWelcome.lsdynaKeywordIndex.contents": "Welcome to LS-DYNA Keyword Index!\n[Scan Keyword Index](command:extension.scanKeywordIndex)\nTo get started, open an LS-DYNA file (`.k`, `.key`, `.dyna`) and click the scan button.",
    "commands.scanIncludeTree.title": "Scan Include Tree",
    "commands.scanKeywordIndex.title": "Scan Full Tree",
    "commands.keywordIndexSetLocal.title": "View Current File",
    "commands.openToSide.title": "Open to Side",
    "commands.revealInExplorer.title": "Reveal in Explorer"
}
```

### 2.3 [NEW] [package.nls.zh-cn.json](file:///d:/Project/vscode-lsdyna/package.nls.zh-cn.json)
```json
{
    "viewsContainers.lsdyna-includes.title": "LS-DYNA 包含文件树",
    "views.lsdynaIncludeTree.name": "包含文件树",
    "views.lsdynaKeywordIndex.name": "关键字索引",
    "viewsWelcome.lsdynaIncludeTree.contents": "欢迎使用 LS-DYNA 包含文件树！\n[扫描包含文件树](command:extension.scanIncludeTree)\n若要开始，请先打开一个 LS-DYNA 文件（`.k`, `.key`, `.dyna`）然后点击上方或此处的扫描按钮。",
    "viewsWelcome.lsdynaKeywordIndex.contents": "欢迎使用 LS-DYNA 关键字索引！\n[扫描关键字索引](command:extension.scanKeywordIndex)\n若要开始，请先打开一个 LS-DYNA 文件（`.k`, `.key`, `.dyna`）然后点击上方或此处的扫描按钮。",
    "commands.scanIncludeTree.title": "扫描包含文件树",
    "commands.scanKeywordIndex.title": "扫描全树",
    "commands.keywordIndexSetLocal.title": "查看当前文件",
    "commands.openToSide.title": "分栏打开",
    "commands.revealInExplorer.title": "在资源管理器中显示"
}
```

---

## 3. Dynamic "信达雅" Translation Refinements (`src/core/i18n.js`)
We will refine the strings inside `src/core/i18n.js` to ensure terminology consistency and linguistic naturalness.

### 3.1 Chinese Translation Updates
- **`sumatraNotFound`**: Fixed grammar mix `复制 to` ➡️ `"复制到"`.
- **`aggregatedUsages`**: `"聚合使用"` ➡️ `"聚合引用"` (matches developer and LS-DYNA domain terms).
- **`totalUsages`**: `"总使用次数"` ➡️ `"总引用次数"`.
- **`firstOccurrence`**: `"首次出现位置"` ➡️ `"首次引用位置"`.
- **`keywordOccurrence`**: `"关键字出现位置"` ➡️ `"关键字引用位置"`.
- **`subIncludes`**: `"子级包含"` ➡️ `"子级 Include"`.
- **`scanningIncludes`**: `"正在扫描包含文件…"` ➡️ `"正在扫描包含文件树…"`.
- **`usageSingular`**: `"1 次使用"` ➡️ `"1 次引用"`.
- **`usagesPlural`**: `"{0} 次使用"` ➡️ `"{0} 次引用"`.
- **`goToKeyword`** *(NEW)*: `(None)` ➡️ `"跳转到关键字"` (to replace hardcoded command title in dynamic providers).

---

## 4. Hardcoded Code Cleanups

### 4.1 Modifying [keywordIndexProvider.js](file:///d:/Project/vscode-lsdyna/src/client/providers/keywordIndexProvider.js)
Replace `title: 'Go to keyword'` under `KeywordUsageItem` and `AggregatedKeywordUsageItem` commands with a localized equivalent:
```javascript
title: i18n.get('goToKeyword')
```

---

## 5. Verification Plan
- **Verify static localization**: Run extension locally, ensure sidebar containers, view titles, welcome page elements, and toolbar command tooltips dynamically load Simplified Chinese when VS Code is in Chinese locale, and English when in English locale.
- **Verify dynamic "信达雅" updates**: Trigger includes scanning and keyword indexing. Confirm all labels, stats, tooltips, and file context links in Chinese look natural, consistent, and professional.
- **Run existing unit tests**: Execute `npm test` to verify that there are no regressions.
