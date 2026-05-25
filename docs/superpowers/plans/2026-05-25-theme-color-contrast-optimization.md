# 包含树与关键字索引主题颜色对比度优化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化已解析及缺失的 include 文件引用在 VS Code 侧边栏和编辑器中的颜色，确保在亮暗主题中都有极高可读性和对比度。

**架构：**
1. 将 `LsdynaFileDecorationProvider`（文件装饰器）中的颜色修改为 VS Code 树/列表的推荐主题前景色（已解析使用 `gitDecoration.untrackedResourceForeground`，缺失使用 `list.warningForeground`）。
2. 在编辑器内，修改行内文本和 `✓`/`⚠` 徽标装饰类型定义，同样使用对应的高对比度自适应 ThemeColor。
3. 修改 `IncludeItem` 的警告节点图标颜色，统一使用 `list.warningForeground`。

**技术栈：** VS Code Ext API (`ThemeColor`, `ThemeIcon`, `createTextEditorDecorationType`, `FileDecorationProvider`)

---

### 任务 1：优化侧边栏文件装饰器 `LsdynaFileDecorationProvider` 的颜色配置

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：修改 `LsdynaFileDecorationProvider` 的返回颜色**

在 `src/extension.js` 中找到 `LsdynaFileDecorationProvider` 类的 `provideFileDecoration(uri)` 方法，将返回的 `ThemeColor` 修改为 `list.warningForeground` 和 `gitDecoration.untrackedResourceForeground`。

修改前：
```javascript
        if (this.includeTreeProvider.missingPaths.has(key)) {
            return {
                badge: '⚠',
                tooltip: 'Missing Include Reference',
                color: new vscode.ThemeColor('editorWarning.foreground')
            };
        }

        if (this.includeTreeProvider.resolvedPaths.has(key)) {
            return {
                tooltip: 'Resolved Include Reference',
                color: new vscode.ThemeColor('testing.iconPassed')
            };
        }
```

修改后：
```javascript
        if (this.includeTreeProvider.missingPaths.has(key)) {
            return {
                badge: '⚠',
                tooltip: 'Missing Include Reference',
                color: new vscode.ThemeColor('list.warningForeground')
            };
        }

        if (this.includeTreeProvider.resolvedPaths.has(key)) {
            return {
                tooltip: 'Resolved Include Reference',
                color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
            };
        }
```

- [ ] **步骤 2：运行单元测试验证功能无损**

运行：`npm test`
预期输出：`183 passing`

- [ ] **步骤 3：Commit**

```bash
git add src/extension.js
git commit -m "style: optimize sidebar file decoration colors for better light theme contrast"
```

---

### 任务 2：优化编辑器内 include 路径装饰颜色

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：修改编辑器装饰类型定义**

在 `src/extension.js` 的 `activate` 函数中，找到 `resolvedDecoration` 和 `missingDecoration` 的创建代码，将颜色参数更新为高对比度自适应色。

修改前：
```javascript
    // Decorations: green for resolved paths, yellow for missing ones
    const resolvedDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('textLink.foreground'),
        after: {
            contentText: ' ✓',
            color: new vscode.ThemeColor('testing.iconPassed'),
            margin: '0 0 0 5px'
        }
    });
    const missingDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('editorWarning.foreground'),
        fontStyle: 'italic',
        after: {
            contentText: ' ⚠',
            color: new vscode.ThemeColor('editorWarning.foreground'),
            margin: '0 0 0 5px',
            fontStyle: 'normal'
        }
    });
```

修改后：
```javascript
    // Decorations: green for resolved paths, yellow for missing ones
    const resolvedDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('textLink.foreground'),
        after: {
            contentText: ' ✓',
            color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
            margin: '0 0 0 5px'
        }
    });
    const missingDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('list.warningForeground'),
        fontStyle: 'italic',
        after: {
            contentText: ' ⚠',
            color: new vscode.ThemeColor('list.warningForeground'),
            margin: '0 0 0 5px',
            fontStyle: 'normal'
        }
    });
```

- [ ] **步骤 2：运行单元测试**

运行：`npm test`
预期输出：`183 passing`

- [ ] **步骤 3：Commit**

```bash
git add src/extension.js
git commit -m "style: optimize editor include decoration colors for light theme compatibility"
```

---

### 任务 3：优化 Include Tree 的警告图标颜色

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`

- [ ] **步骤 1：修改 `IncludeItem` 构造函数和节点生成逻辑中的图标颜色**

在 `src/client/providers/includeTreeProvider.js` 中找到 `IncludeItem` 类构造函数及 `_buildItemFromTreeNode` 方法中为警告/缺失节点设置 `iconPath` 的位置，将颜色从 `editorWarning.foreground` 更改为 `list.warningForeground`。

1. 构造函数中修改：
修改前：
```javascript
        if (!exists) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            this.description = 'not found';
            this.contextValue = 'file-missing';
        }
```
修改后：
```javascript
        if (!exists) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            this.description = 'not found';
            this.contextValue = 'file-missing';
        }
```

2. `_buildItemFromTreeNode` 方法中修改：
修改前：
```javascript
        } else if (node.missing) {
            item.description = 'missing';
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
```
修改后：
```javascript
        } else if (node.missing) {
            item.description = 'missing';
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
```

- [ ] **步骤 2：运行全部单元测试**

运行：`npm test`
预期输出：`183 passing`

- [ ] **步骤 3：Commit**

```bash
git add src/client/providers/includeTreeProvider.js
git commit -m "style: update warning icon colors in Include Tree to use list.warningForeground"
```
