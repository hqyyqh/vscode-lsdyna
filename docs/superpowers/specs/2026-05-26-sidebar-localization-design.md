# LS-DYNA VS Code Extension Sidebar Localization Design Spec

This specification outlines the dynamic and static localization changes required to achieve comprehensive Simplified Chinese (`zh-cn`) and English (`en`) support for the LS-DYNA sidebar (Include Tree & Keyword Index views), including item descriptions, dynamic hover tooltips, and bottom action links.

## 1. Static Localization (VS Code System Locale Integration)

All static contribution titles inside `package.json` already map to `%placeholder%` strings resolved via `package.nls.json` and `package.nls.zh-cn.json`. The static command titles and icons in tree item context menus (inline actions) will directly follow the VS Code display language.

The commands include:
- `extension.openToSide` (title: `%command.openToSide%`) -> "Open to Side" / "分栏打开"
- `extension.revealInExplorer` (title: `%command.revealInExplorer%`) -> "Reveal in Explorer" / "在资源管理器中显示"
- `extension.scanIncludeTree` (title: `%command.scanIncludeTree%`) -> "Scan Include Tree" / "扫描包含文件树"
- `extension.scanKeywordIndex` (title: `%command.scanKeywordIndex%`) -> "Scan Full Tree" / "扫描关键字索引"

No additional static configuration logic is required since this is handled natively by VS Code.

## 2. Dynamic Localization Updates (`src/core/i18n.js`)

We will expand `src/core/i18n.js` to support new dynamic properties.

### Key additions to `zh-cn`:
- `openFile`: `"打开文件"`
- `revealInExplorer`: `"在资源管理器中显示"`
- `includeFile`: `"包含文件"`
- `keywordLabel`: `"关键字"`
- `keywordOccurrence`: `"关键字出现位置"`
- `file`: `"文件"`
- `line`: `"行"`
- `linePrefix`: `":第 {0} 行"`
- `lineLabel`: `"第 {0} 行"`
- `aggregatedUsages`: `"聚合使用"`
- `totalUsages`: `"总使用次数"`
- `firstOccurrence`: `"首次出现位置"`
- `cardDataPreview`: `"卡片数据预览"`
- `usageSingular`: `"1 次使用"`
- `usagesPlural`: `"{0} 次使用"`

### Key additions to `en`:
- `openFile`: `"Open File"`
- `revealInExplorer`: `"Reveal in Explorer"`
- `includeFile`: `"Include File"`
- `keywordLabel`: `"Keyword"`
- `keywordOccurrence`: `"Keyword Occurrence"`
- `file`: `"File"`
- `line`: `"Line"`
- `linePrefix`: `":line {0}"`
- `lineLabel`: `"Line {0}"`
- `aggregatedUsages`: `"Aggregated Usages"`
- `totalUsages`: `"Total Usages"`
- `firstOccurrence`: `"First Occurrence"`
- `cardDataPreview`: `"Card Data Preview"`
- `usageSingular`: `"1 usage"`
- `usagesPlural`: `"{0} usages"`

---

## 3. Dynamic Sidebar Components Updates

### 3.1 Include Tree Provider (`src/client/providers/includeTreeProvider.js`)

We will update the dynamic tree elements and resolved tooltips:
1. **Tree Node Tooltip Header:**
   - Change `### Include File: **${path.basename(...)}**` to `### ${i18n.get('includeFile')}: **${path.basename(...)}**`.
2. **Item Context Tooltip Actions:**
   - In `resolveTreeItem()`, replace hardcoded strings with:
     `[${i18n.get('openFile')}](command:vscode.open?...) | [${i18n.get('openToSide')}](command:extension.openToSide?...) | [${i18n.get('revealInExplorer')}](command:extension.revealInExplorer?...)`.
   - Adding `revealInExplorer` action to the tooltip context brings parity and completeness.

### 3.2 Keyword Index Provider (`src/client/providers/keywordIndexProvider.js`)

We will fully localize all dynamic keyword index nodes and details.
1. **Keyword Pluralization & Description:**
   - Change `item.description = `${usages.length} usage${usages.length === 1 ? '' : 's'}`` to:
     `item.description = usages.length === 1 ? i18n.get('usageSingular') : i18n.get('usagesPlural', usages.length)`.
   - Update `AggregatedKeywordUsageItem` description to use the same `usageSingular` / `usagesPlural` keys.
2. **Line Label Prefix:**
   - Update `KeywordUsageItem`'s `this.description = \`:line \${lineIndex + 1}\`` to:
     `this.description = i18n.get('linePrefix', lineIndex + 1)`.
3. **Keyword Tooltip:**
   - Update top-level keyword node tooltip:
     `### ${i18n.get('keywordLabel')}: **${keyword}**`
     `- **${i18n.get('totalUsages')}**: ${usages.length}`
4. **Keyword Usage Tooltip:**
   - Update usage occurrence node tooltip:
     `### ${i18n.get('keywordOccurrence')}`
     `- **${i18n.get('file')}**: \`${rel}\``
     `- **${i18n.get('path')}**: \`${filePath}\``
     `- **${i18n.get('line')}**: ${lineIndex + 1}`
5. **Aggregated Usages Tooltip:**
   - Update aggregated node tooltip:
     `### ${i18n.get('aggregatedUsages')}`
     `- **${i18n.get('file')}**: \`${rel}\``
     `- **${i18n.get('path')}**: \`${filePath}\``
     `- **${i18n.get('totalUsages')}**: ${count}`
     `- **${i18n.get('firstOccurrence')}**: ${i18n.get('lineLabel', firstLineIndex + 1)}`
6. **Resolved Detail Tooltip Bottom Links:**
   - Inside `resolveTreeItem()` for keyword occurrences, replace hardcoded bottom actions and add `Reveal in Explorer`:
     `[${i18n.get('openFile')}](command:vscode.open?...) | [${i18n.get('openToSide')}](command:extension.openToSide?...) | [${i18n.get('revealInExplorer')}](command:extension.revealInExplorer?...)`.
   - Localize card preview header: `**${i18n.get('cardDataPreview')}:**`.

---

## 4. Verification Plan

1. **Verify dynamic config reload:** Change `lsdyna.language` setting dynamically between `en` and `zh-cn`. Check that include tree, keyword item descriptions, and tooltips update instantly.
2. **Validate hover and actions:** Hover over include tree nodes and keyword nodes. Confirm all headers, lists, and bottom links translate correctly and function when clicked.
3. **Run existing unit tests:** Run `npm test` to ensure that none of the modified providers break existing mock tests.
