# Sidebar Localization Refinement Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Refine the localization settings of the VS Code LS-DYNA extension sidebar by providing a full VS Code static NLS mechanism for `package.json` and improving the dynamic Chinese strings to meet LS-DYNA domain standards ("信达雅").

**架构：**
1. Extract static strings in `package.json` into `%viewsContainers.lsdyna-includes.title%`, `%views.lsdynaIncludeTree.name%`, etc., and create `package.nls.json` and `package.nls.zh-cn.json`.
2. Refine Chinese translations inside `src/core/i18n.js` to match dynamic professional terminologies (e.g., using "引用" instead of "使用").
3. Localize dynamic "Go to Keyword" command titles in `src/client/providers/keywordIndexProvider.js`.

**技术栈：** VS Code Extension API, Node.js NLS, Mocha Test Framework.

---

### Task 1: Static NLS Localization Setup

**Files:**
- Modify: `package.json`
- Create: `package.nls.json`
- Create: `package.nls.zh-cn.json`

- [ ] **Step 1: Create package.nls.json**
  Create file `package.nls.json` with base English strings.
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

- [ ] **Step 2: Create package.nls.zh-cn.json**
  Create file `package.nls.zh-cn.json` with refined Simplified Chinese strings.
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

- [ ] **Step 3: Modify package.json**
  Extract matching keys to placeholder variables:
  - In `viewsContainers.activitybar`: `{"id": "lsdyna-includes", "title": "%viewsContainers.lsdyna-includes.title%", ...}`
  - In `views`:
    - `{"id": "lsdynaIncludeTree", "name": "%views.lsdynaIncludeTree.name%"}`
    - `{"id": "lsdynaKeywordIndex", "name": "%views.lsdynaKeywordIndex.name%"}`
  - In `viewsWelcome`:
    - `{"view": "lsdynaIncludeTree", "contents": "%viewsWelcome.lsdynaIncludeTree.contents%"}`
    - `{"view": "lsdynaKeywordIndex", "contents": "%viewsWelcome.lsdynaKeywordIndex.contents%"}`
  - In `commands`:
    - Update `extension.scanIncludeTree` title to `"%commands.scanIncludeTree.title%"`
    - Update `extension.scanKeywordIndex` title to `"%commands.scanKeywordIndex.title%"`
    - Update `extension.keywordIndexSetLocal` title to `"%commands.keywordIndexSetLocal.title%"`
    - Update `extension.openToSide` title to `"%commands.openToSide.title%"`
    - Update `extension.revealInExplorer` title to `"%commands.revealInExplorer.title%"`

- [ ] **Step 4: Run Tests to Verify No Regressions**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 5: Commit Static NLS Changes**
  ```bash
  git add package.json package.nls.json package.nls.zh-cn.json
  git commit -m "feat(i18n): extract package.json static properties to NLS localizations"
  ```

---

### Task 2: Dynamic "信达雅" Translation Refinements

**Files:**
- Modify: `src/core/i18n.js`

- [ ] **Step 1: Modify src/core/i18n.js**
  Update Chinese strings to professional, polished phrasing and add `goToKeyword` dynamic key.
  ```javascript
      'zh-cn': {
          openFileFirst: '请先打开一个 LS-DYNA 文件。 (Debug: {0})',
          indexingKeywords: '正在扫描关键字…',
          manualDirNotConfigured: '未设置手册路径。配置后可在悬停时快速阅读 PDF 原文书签页。',
          configureFolder: '⚙️ 设置手册文件夹 (Configure Folder)',
          modifyManualPath: '修改手册路径',
          page: '第 {0} 页',
          openNewTab: '在新标签打开链接',
          openSplit: '分栏打开',
          openFolder: '打开文件所在路径',
          selectFolder: '设置 LS-DYNA 手册目录',
          manualDirSetTo: 'LS-DYNA 手册目录已设置为: {0}',
          sumatraNotFound: '未在所选手册文件夹中找到 SumatraPDF.exe。在 Windows 系统上，请将 SumatraPDF.exe 复制到该目录下以启用精确页码跳转。',
          notFound: '未找到',
          loadingFieldData: '加载 field data 文件...',
          
          // Tree Providers Extra
          missing: '缺失',
          circular: '循环',
          scanFailed: '扫描失败',
          scanningIncludes: '正在扫描包含文件树…',
          openEditor: '打开编辑器',
          openToSide: '并在侧边打开',
          folder: '文件夹',
          path: '路径',
          size: '大小',
          subIncludes: '子级 Include',
          status: '状态',
          circularDependency: '⚠️ *循环依赖*',
          scanFailedStatus: '❌ *扫描失败*',
          error: '错误',
          indexingKeywordsProgress: '正在索引关键字…',
          filesFound: '已找到 {0} 个文件',
          includeTreeTitle: '包含文件树',
          keywordIndexTitle: '关键字索引',
          openFile: '打开文件',
          revealInExplorer: '在资源管理器中显示',
          includeFile: '包含文件',
          keywordLabel: '关键字',
          keywordOccurrence: '关键字引用位置',
          file: '文件',
          line: '行',
          linePrefix: ':第 {0} 行',
          lineLabel: '第 {0} 行',
          aggregatedUsages: '聚合引用',
          totalUsages: '总引用次数',
          firstOccurrence: '首次引用位置',
          cardDataPreview: '卡片数据预览',
          usageSingular: '1 次引用',
          usagesPlural: '{0} 次引用',
          goToKeyword: '跳转到关键字'
      }
  ```
  Also, add `goToKeyword: 'Go to Keyword'` in the `en` block:
  ```javascript
      'en': {
          ...
          usageSingular: '1 usage',
          usagesPlural: '{0} usages',
          goToKeyword: 'Go to Keyword'
      }
  ```

- [ ] **Step 2: Run Tests to Verify No Regressions**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 3: Commit Dynamic i18n Refinements**
  ```bash
  git add src/core/i18n.js
  git commit -m "feat(i18n): refine dynamic Chinese translations for dynamic sidebar text"
  ```

---

### Task 3: Clean up Residual Hardcoded Strings

**Files:**
- Modify: `src/client/providers/keywordIndexProvider.js`

- [ ] **Step 1: Modify keywordIndexProvider.js**
  Replace `title: 'Go to keyword'` under `KeywordUsageItem` (around line 81) and `AggregatedKeywordUsageItem` (around line 117) with the dynamically translated key:
  ```javascript
  title: i18n.get('goToKeyword')
  ```

- [ ] **Step 2: Run Tests to Verify Compliance**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 3: Commit Code Cleanups**
  ```bash
  git add src/client/providers/keywordIndexProvider.js
  git commit -m "feat(i18n): use dynamic translation key for Go to Keyword command title"
  ```
