# LS-DYNA VS Code 插件 - 包含树与关键字索引主题颜色与可读性优化设计规约

本文档设计了优化 LS-DYNA 侧边栏（`Include Tree` 和 `Keyword Index`）以及编辑器中 `*INCLUDE` 文件引用装饰颜色的方案。目的是在 VS Code 亮色和暗色主题下均提供高可读性、高对比度的用户体验，并解决由于单行信息过长导致的可读性差、容易看错的问题。

---

## 1. 当前问题分析

目前插件在以下几处使用了 VS Code 的主题颜色：
1. **侧边栏文件装饰器 (`LsdynaFileDecorationProvider`)**：
   - 已解析的文件使用 `testing.iconPassed`（通常为淡绿色，在浅色主题下对比度非常低，文件名很难看清）。
   - 缺失的文件使用 `editorWarning.foreground`（通常为淡黄色，在白底背景下几乎不可见）。
2. **编辑器中 include 路径的行内装饰**：
   - 已解析路径后缀 `✓` 采用 `testing.iconPassed`。
   - 缺失路径及后缀 `⚠` 采用 `editorWarning.foreground`，同样在浅色主题下非常模糊。
3. **Include Tree 节点文本过长**：
   - 树视图节点目前在一行内同时显示了文件名、相对路径以及文件大小（如：`vehicle_body.k    submodels/loading  •  █ 1.2 MB`）。这导致行文本过长，在侧边栏较窄时会被截断，难以阅读。

---

## 2. 优化方案 (色彩自适应 + 描述信息简化 Option A)

我们将通过以下两个方向彻底解决对比度与可读性问题：

### A. 全局色彩自适应优化
我们将所有文字前景色改为 VS Code 原生设计用于列表和树文本装饰的自适应颜色：

| 节点类型 | 旧颜色 Token | 新颜色 Token | 说明 |
| :--- | :--- | :--- | :--- |
| **已解析 (Resolved)** | `testing.iconPassed` | `gitDecoration.untrackedResourceForeground` | 文件树中未跟踪文件的绿色文本，对比度优秀且随主题自适应。 |
| **缺失 (Missing)** | `editorWarning.foreground` | `list.warningForeground` | 列表/树中带有警告的文本颜色，浅色下呈深橙褐色，深色下呈亮橙色，高对比度。 |

### B. 描述信息简化 (Option A)
为了提高包含树侧边栏的整洁度和可读性，对树节点的 `description` 和 `tooltip` 字段进行如下调整：
1.  **侧边栏描述 (`description`)**：移除相对路径信息，**仅显示文件大小或状态**（例如 `█ 1.2 MB`，`not found` 等）。
2.  **悬浮提示卡片 (`tooltip`)**：将相对路径作为独立的 **Folder** 字段呈现，并且使完整的绝对路径、大小及状态在卡片中清晰可见。

**树节点渲染效果**：
- 标签：`vehicle_body.k`
- 描述：`█ 1.2 MB`
- 对比原先的 `submodels/loading  •  █ 1.2 MB` 缩短了超过 60% 的字符长度。

---

## 3. 具体修改内容

### A. 侧边栏文件装饰器与编辑器行内装饰
- 修改 `src/extension.js` 中的 `LsdynaFileDecorationProvider` 的返回颜色以及编辑器装饰类型定义（已于前一步完成）。

### B. Include Tree (包含树) 描述信息与悬停卡片修改
修改 `src/client/providers/includeTreeProvider.js` 中的描述和悬浮提示卡片逻辑：
1.  **`applyVividDescription(item, relDir)`**：
    - 不再拼入 `relDir`。`item.description` 直接设置为 `statusText`（即只保留大小或缺失/环状依赖状态）。
2.  **`resolveTreeItem(item, element, token)`** / 节点 `tooltip` 构造：
    - 获取当前节点的 `relDir`，以 `- **Folder**: \`submodels/loading\`` 的形式添加到 `tooltip` 的 Markdown 文本中。
    - 确保 `IncludeItem` 在构造和树遍历时记录其 `relDir`。

---

## 4. 验证方案

### 自动化测试
运行 Mocha 测试：
```bash
npm test
```
需要确保所有测试（特别是 `applyVividDescription` 的测试用例）均通过。

### 手动验证
切换 VS Code 主题（Light Modern / Dark Modern），检查侧边栏的 Include Tree 中相对路径是否已隐藏，只显示文件名与大小，并确保悬浮提示卡片内完整地展示了 Folder 等信息。
