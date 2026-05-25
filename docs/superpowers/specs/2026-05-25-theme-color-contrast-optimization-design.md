# LS-DYNA VS Code 插件 - 包含树与关键字索引主题颜色对比度优化设计规约

本文档设计了优化 LS-DYNA 侧边栏（`Include Tree` 和 `Keyword Index`）以及编辑器中 `*INCLUDE` 文件引用装饰颜色的方案。目的是在 VS Code 亮色和暗色主题下均提供高可读性、高对比度的用户体验。

---

## 1. 当前问题分析

目前插件在以下几处使用了 VS Code 的主题颜色：
1. **侧边栏文件装饰器 (`LsdynaFileDecorationProvider`)**：
   - 已解析的文件使用 `testing.iconPassed`（通常为淡绿色，设计用于测试视图小图标，而非文本前景色）。在浅色主题下，该绿色的对比度非常低，文件名很难看清。
   - 缺失的文件使用 `editorWarning.foreground`（通常为淡橙色/黄色，设计用于波浪线或小图标）。在浅色主题下接近明黄色，在白底背景下几乎不可见。
2. **编辑器中 include 路径的行内装饰**：
   - 已解析路径后缀 `✓` 采用 `testing.iconPassed`。
   - 缺失路径及后缀 `⚠` 采用 `editorWarning.foreground`，同样在浅色主题下非常模糊。
3. **Include Tree 节点图标颜色**：
   - 缺失节点图标采用 `editorWarning.foreground`，在浅色下可读性一般。

---

## 2. 优化方案 (Option 2 - 全局自适应色彩优化)

我们将所有用于文字前景色或小图标的颜色改为 VS Code 原生设计用于列表和树文本装饰的自适应颜色。这些颜色在所有主流浅色/深色主题中都经过精心优化：

| 节点类型 | 旧颜色 Token (低对比度) | 新颜色 Token (高对比度) | 说明 |
| :--- | :--- | :--- | :--- |
| **已解析 Include (Resolved)** | `testing.iconPassed` | `gitDecoration.untrackedResourceForeground` | 专门用于文件树中新增/未跟踪文件的绿色文本，对比度优秀且随主题完美自适应。 |
| **缺失 Include (Missing)** | `editorWarning.foreground` | `list.warningForeground` | 专门用于列表/树中带有警告节点的文本颜色，在浅色下呈深橙褐色，在深色下呈亮橙色，极具对比度。 |

---

## 3. 具体修改内容

### A. 侧边栏文件装饰器

修改 `src/extension.js` 中的 `LsdynaFileDecorationProvider`：
- 已解析路径：`color` 属性从 `testing.iconPassed` 更改为 `gitDecoration.untrackedResourceForeground`。
- 缺失路径：`color` 属性从 `editorWarning.foreground` 更改为 `list.warningForeground`。

### B. 编辑器行内装饰

修改 `src/extension.js` 中的编辑器装饰配置：
- `resolvedDecoration`: `after.color` 从 `testing.iconPassed` 更改为 `gitDecoration.untrackedResourceForeground`。
- `missingDecoration`: `color` 以及 `after.color` 从 `editorWarning.foreground` 更改为 `list.warningForeground`。

### C. Include Tree 节点图标

修改 `src/client/providers/includeTreeProvider.js` 中的 `IncludeItem`：
- `exists` 为 `false` 时的警告图标：颜色从 `editorWarning.foreground` 更改为 `list.warningForeground`。
- 缺失节点 `_buildItemFromTreeNode` 和 `_buildItem`：图标颜色从 `editorWarning.foreground` 更改为 `list.warningForeground`。

---

## 4. 验证方案

### 自动化测试
运行已有的 Mocha 测试：
```bash
npm test
```
确保所有测试套件通过，且 `LsdynaFileDecorationProvider` 测试不因更改 ThemeColor 而损坏。

### 手动验证
1. 打开 VS Code。
2. 切换至浅色主题（例如 VS Code 默认的 `Light Modern` 或 `Quiet Light`）。
3. 观察侧边栏的 `Include Tree` 和 `Keyword Index`。
4. 确认已解析文件名（绿色）和缺失文件名（橙褐色）具有足够高的对比度，并且所有图标/文字清晰可见。
5. 切换至暗色主题，确认深色模式下的颜色依然舒适、符合直觉。
