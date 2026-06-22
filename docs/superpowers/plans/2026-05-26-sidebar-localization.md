# 侧边栏及 Hover 悬停提示彻底多语言化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 LS-DYNA 侧边栏（包含树、关键字索引树）的节点描述、悬停 Tooltips 和悬停快捷操作链接的多语言动态切换，并补充缺失的操作链接（如在资源管理器中显示）。

**架构：** 在 `src/core/i18n.js` 中新增翻译词条，在 `includeTreeProvider.js` 和 `keywordIndexProvider.js` 中通过 `i18n.get(...)` 动态替换原有英文硬编码，实现即时切换语言不卡顿。

**技术栈：** VS Code Extension API, Javascript (Node.js)

---

## 文件变更列表
- `src/core/i18n.js` (修改) - 扩充中英文本地化字典
- `src/client/providers/includeTreeProvider.js` (修改) - 替换硬编码，扩展悬停 Tooltip 链接
- `src/client/providers/keywordIndexProvider.js` (修改) - 替换硬编码，实现动态描述单复数和悬停链接

---

### 任务 1：扩充 `i18n.js` 词典

**文件：**
- 修改：`src/core/i18n.js`

- [ ] **步骤 1：修改 `src/core/i18n.js` 增加词条**
  在 `LOCALES['zh-cn']` 和 `LOCALES['en']` 中补充所有侧边栏相关的翻译字根。

  ```javascript
  // 增加到 zh-cn 词条：
  openFile: '打开文件',
  revealInExplorer: '在资源管理器中显示',
  includeFile: '包含文件',
  keywordLabel: '关键字',
  keywordOccurrence: '关键字出现位置',
  file: '文件',
  line: '行',
  linePrefix: ':第 {0} 行',
  lineLabel: '第 {0} 行',
  aggregatedUsages: '聚合使用',
  totalUsages: '总使用次数',
  firstOccurrence: '首次出现位置',
  cardDataPreview: '卡片数据预览',
  usageSingular: '1 次使用',
  usagesPlural: '{0} 次使用'

  // 增加到 en 词条：
  openFile: 'Open File',
  revealInExplorer: 'Reveal in Explorer',
  includeFile: 'Include File',
  keywordLabel: 'Keyword',
  keywordOccurrence: 'Keyword Occurrence',
  file: 'File',
  line: 'Line',
  linePrefix: ':line {0}',
  lineLabel: 'Line {0}',
  aggregatedUsages: 'Aggregated Usages',
  totalUsages: 'Total Usages',
  firstOccurrence: 'First Occurrence',
  cardDataPreview: 'Card Data Preview',
  usageSingular: '1 usage',
  usagesPlural: '{0} usages'
  ```

- [ ] **步骤 2：运行单元测试验证 `i18n` 无语法错误**
  运行：`npm test`
  预期：187 个测试通过 (PASS)

- [ ] **步骤 3：Commit**
  ```bash
  git add src/core/i18n.js
  git commit -m "feat: expand i18n keys for sidebar localization"
  ```

---

### 任务 2：彻底多语言化 `includeTreeProvider.js`

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`

- [ ] **步骤 1：修改 `_buildItemFromTreeNode`、`_buildItem` 和 `resolveTreeItem`**
  - 将 `### Include File:` 统一替换为 `### ${i18n.get('includeFile')}:`
  - 在 `resolveTreeItem` 中将硬编码的操作链接：
    `[${i18n.get('openEditor')}](command:vscode.open?...) | [${i18n.get('openToSide')}](command:extension.openToSide?...)`
    修改并扩充为：
    `[${i18n.get('openFile')}](command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(item.filePath)))}) | [${i18n.get('openToSide')}](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))}) | [${i18n.get('revealInExplorer')}](command:extension.revealInExplorer?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))})`

- [ ] **步骤 2：运行单元测试**
  运行：`npm test`
  预期：187 个测试通过 (PASS)

- [ ] **步骤 3：Commit**
  ```bash
  git add src/client/providers/includeTreeProvider.js
  git commit -m "feat: localize includeTreeProvider dynamic tooltips and actions"
  ```

---

### 任务 3：彻底多语言化 `keywordIndexProvider.js`

**文件：**
- 修改：`src/client/providers/keywordIndexProvider.js`

- [ ] **步骤 1：替换关键字列表描述及单复数逻辑**
  - 在 `_buildRootsFromKeywordMap` 中，修改 `item.description` 的赋值：
    `item.description = usages.length === 1 ? i18n.get('usageSingular') : i18n.get('usagesPlural', usages.length);`
  - 修改 Tooltip 结构：
    `### ${i18n.get('keywordLabel')}: **${keyword}**`
    `- **${i18n.get('totalUsages')}**: ${usages.length}`
  - 在 `AggregatedKeywordUsageItem` 构造函数中修改 `this.description`：
    `this.description = count === 1 ? i18n.get('usageSingular') : i18n.get('usagesPlural', count);`
  - 在 `KeywordUsageItem` 构造函数中修改 `this.description`：
    `this.description = i18n.get('linePrefix', lineIndex);`

- [ ] **步骤 2：替换所有悬停 Tooltips 内部文本**
  - 本地化 `KeywordUsageItem` 和 `AggregatedKeywordUsageItem` 构造函数中的 Markdown Tooltip 标签（使用 `file`、`path`、`line`、`totalUsages`、`firstOccurrence`、`lineLabel` 等字根）。
  - 在 `resolveTreeItem` 中，本地化卡片数据预览头：`**${i18n.get('cardDataPreview')}:**`，且替换底部的英文硬编码链接，补充 `Reveal in Explorer` 链接。

- [ ] **步骤 3：运行单元测试**
  运行：`npm test`
  预期：187 个测试通过 (PASS)

- [ ] **步骤 4：Commit**
  ```bash
  git add src/client/providers/keywordIndexProvider.js
  git commit -m "feat: fully localize keywordIndexProvider items, descriptions and tooltips"
  ```
