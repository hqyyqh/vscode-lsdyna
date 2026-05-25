# LS-DYNA VS Code 插件 - 包含树与关键字索引主题颜色与可读性优化设计规约

本文档设计了优化 LS-DYNA 侧边栏（`Include Tree` 和 `Keyword Index`）以及编辑器中 `*INCLUDE` 文件引用装饰颜色的方案。目的是在 VS Code 亮色和暗色主题下均提供高可读性、高对比度的用户体验，并解决用户反馈的文件名过小、切换文件易看错的问题。

---

## 1. 当前问题分析

目前插件在以下几处使用了 VS Code 的主题颜色：
1. **侧边栏文件装饰器 (`LsdynaFileDecorationProvider`)**：
   - 已解析的文件使用 `testing.iconPassed`（通常为淡绿色，在浅色主题下对比度非常低，文件名很难看清）。
   - 缺失的文件使用 `editorWarning.foreground`（通常为淡黄色，在白底背景下几乎不可见）。
2. **编辑器中 include 路径的行内装饰**：
   - 已解析路径后缀 `✓` 采用 `testing.iconPassed`。
   - 缺失路径及后缀 `⚠` 采用 `editorWarning.foreground`，同样在浅色主题下非常模糊。
3. **侧边栏节点字体太小，切换文件易看错**：
   - VS Code 的原生 TreeView 不允许自定义字体大小和行高。
   - 文件树节点文字紧凑，当项目包含几十个 include 文件时，快速点击切换极易看错或选错。

---

## 2. 优化方案 (色彩自适应 + Emoji 视觉强化)

我们将通过以下两个方向彻底解决对比度与可读性问题：

### A. 全局色彩自适应优化
我们将所有文字前景色改为 VS Code 原生设计用于列表和树文本装饰的自适应颜色：

| 节点类型 | 旧颜色 Token | 新颜色 Token | 说明 |
| :--- | :--- | :--- | :--- |
| **已解析 (Resolved)** | `testing.iconPassed` | `gitDecoration.untrackedResourceForeground` | 文件树中未跟踪文件的绿色文本，对比度优秀且随主题自适应。 |
| **缺失 (Missing)** | `editorWarning.foreground` | `list.warningForeground` | 列表/树中带有警告的文本颜色，浅色下呈深橙褐色，深色下呈亮橙色，高对比度。 |

### B. 大图标与视觉区分（Emoji 前缀）
在原生 TreeView 无法增大字号的限制下，我们通过在节点文本前引入明亮、具有高度区分性的 Emoji 前缀，让用户能够仅凭视觉轮廓/颜色块即可快速判断节点属性：

- **普通/已解析的 include 文件**：前缀加 `📄 `（例如：`📄 vehicle_body.k`）
- **缺失的 include 文件**：前缀加 `⚠️ `（例如：`⚠️ engine_bracket.k`）
- **循环引用的 include 文件**：前缀加 `🔄 `（例如：`🔄 loop_chassis.k`）
- **关键字索引类别（Key Category）**：前缀加 `🏷️ `（例如：`🏷️ *PART`）
- **关键字文件内引用（Key Usages）**：前缀加 `📄 `（例如：`📄 root.key`）

---

## 3. 具体修改内容

### A. 侧边栏文件装饰器与编辑器行内装饰
- 修改 `src/extension.js` 中的 `LsdynaFileDecorationProvider` 的返回颜色以及编辑器装饰类型定义（已于前一步完成）。

### B. Include Tree (包含树) 增加 Emoji 前缀与警告图标颜色
修改 `src/client/providers/includeTreeProvider.js`：
1. `IncludeItem` 构造函数中：
   - 更改 `new vscode.ThemeColor('editorWarning.foreground')` 为 `new vscode.ThemeColor('list.warningForeground')`。
   - 根据 `exists` 动态为 label 添加前缀：`exists ? '📄 ' : '⚠️ '`。
2. `_buildItemFromTreeNode` 方法中：
   - `node.cycle` 时，`item.label = '🔄 ' + basename`。
   - `node.missing` 时，`item.label = '⚠️ ' + basename`。
3. `_buildItem` 方法中：
   - `visited` 循环依赖时，`item.label = '🔄 ' + basename`。

### C. Keyword Index (关键字索引) 增加 Emoji 前缀
修改 `src/client/providers/keywordIndexProvider.js`：
1. `KeywordItem` 构造函数中：将 label 格式化为 `🏷️ ${keyword}`。
2. `KeywordUsageItem` 构造函数中：将 label 格式化为 `📄 ${basename}`。
3. `AggregatedKeywordUsageItem` 构造函数中：将 label 格式化为 `📄 ${basename}`。

---

## 4. 验证方案

### 自动化测试
运行 Mocha 测试：
```bash
npm test
```
需要更新 `test/extension.test.js` 中的断言以适配包含 `🏷️ ` 前缀的关键字分类名（例如 `['🏷️ MAT_ELASTIC', '🏷️ PART']`）。

### 手动验证
切换 VS Code 主题（Light Modern / Dark Modern），检查侧边栏的 Include Tree 与 Keyword Index 的 Emoji 前缀及文本可读性。
