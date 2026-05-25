# 包含树与关键字索引主题颜色对比度与描述简化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化已解析及缺失的 include 文件引用在 VS Code 侧边栏和编辑器中的颜色，确保在亮暗主题中都有极高可读性和对比度；并且简化侧边栏文件描述，将相对路径移入悬停提示。

**架构：**
1. 将 `LsdynaFileDecorationProvider`（文件装饰器）中的颜色修改为 VS Code 树/列表的推荐主题前景色（已解析使用 `gitDecoration.untrackedResourceForeground`，缺失使用 `list.warningForeground`）（已完成）。
2. 在编辑器内，修改行内文本和 `✓`/`⚠` 徽标装饰类型定义，使用自适应色（已完成）。
3. 修改 `IncludeItem` 的警告节点图标颜色（已完成）。
4. 简化 `IncludeItem` 的侧边栏描述（`description`），移除相对路径（`relDir`），仅显示大小/状态；在悬浮提示（`tooltip`）中增加 `Folder` 字段显示相对路径。

**技术栈：** VS Code Ext API (`ThemeColor`, `ThemeIcon`, `MarkdownString`)

---

### 任务 1：优化侧边栏文件装饰器 `LsdynaFileDecorationProvider` 的颜色配置（已完成）

### 任务 2：优化编辑器内 include 路径装饰颜色（已完成）

### 任务 3：优化 Include Tree 的警告图标颜色（已完成）

---

### 任务 4：简化侧边栏描述并将相对路径移入悬停卡片

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：修改 `applyVividDescription` 函数，移除相对路径的拼接**

修改 `src/client/providers/includeTreeProvider.js` 中的 `applyVividDescription(item, relDir)`：使其忽略 `relDir` 参数，直接把 `item.description` 设为大小或状态，并在此之前或在此处将 `relDir` 缓存到 `item.relDir` 以便后续 `resolveTreeItem` 构建悬停卡片时使用。

修改前：
```javascript
function applyVividDescription(item, relDir) {
    let statusText = '';
    if (item.description === 'not found') {
        statusText = 'not found';
    } else if (item.description === 'missing') {
        statusText = 'missing';
    } else if (item.description === 'circular') {
        statusText = 'circular';
    } else if (item.description === 'scan failed') {
        statusText = 'scan failed';
    } else if (item.fileSizeVal !== undefined) {
        statusText = formatVividBytes(item.fileSizeVal);
    }

    if (relDir && statusText) {
        item.description = `${relDir}  •  ${statusText}`;
    } else if (relDir) {
        item.description = relDir;
    } else if (statusText) {
        item.description = statusText;
    } else {
        item.description = '';
    }
}
```

修改后：
```javascript
function applyVividDescription(item, relDir) {
    let statusText = '';
    if (item.description === 'not found') {
        statusText = 'not found';
    } else if (item.description === 'missing') {
        statusText = 'missing';
    } else if (item.description === 'circular') {
        statusText = 'circular';
    } else if (item.description === 'scan failed') {
        statusText = 'scan failed';
    } else if (item.fileSizeVal !== undefined) {
        statusText = formatVividBytes(item.fileSizeVal);
    }

    item.relDir = relDir || '';
    if (statusText) {
        item.description = statusText;
    } else {
        item.description = '';
    }
}
```

- [ ] **步骤 2：在构建节点时传入并在 `resolveTreeItem` 中构建悬浮提示卡片（加入 Folder 相对路径）**

修改 `resolveTreeItem(item, element, token)` 以将缓存的 `relDir` 作为 Folder 项目展示到 Markdown 提示中。

修改前：
```javascript
    async resolveTreeItem(item, element, token) {
        if (!item.filePath || !fs.existsSync(item.filePath)) {
            return item;
        }
        try {
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(item.filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **Path**: \`${item.filePath}\`\n`);
            if (item.fileSizeStr) {
                tooltip.appendMarkdown(`- **Size**: \`${item.fileSizeStr}\`\n`);
            }
            
            if (item.contextValue !== 'file-missing') {
                if (item.children && item.children.length > 0) {
                    tooltip.appendMarkdown(`- **Sub-includes**: ${item.children.length}\n`);
                }
            }
            
            tooltip.appendMarkdown(`\n---\n`);
            tooltip.appendMarkdown(`[Open Editor](command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(item.filePath)))}) | `);
            tooltip.appendMarkdown(`[Open to Side](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))})`);
            tooltip.isTrusted = true;
            
            item.tooltip = tooltip;
        } catch (e) {
            // Fallback to basic tooltip
        }
        return item;
    }
```

修改后：
```javascript
    async resolveTreeItem(item, element, token) {
        if (!item.filePath || !fs.existsSync(item.filePath)) {
            return item;
        }
        try {
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(item.filePath)}**\n\n`);
            if (item.relDir) {
                tooltip.appendMarkdown(`- **Folder**: \`${item.relDir}\`\n`);
            }
            tooltip.appendMarkdown(`- **Path**: \`${item.filePath}\`\n`);
            if (item.fileSizeStr) {
                tooltip.appendMarkdown(`- **Size**: \`${item.fileSizeStr}\`\n`);
            }
            
            if (item.contextValue !== 'file-missing') {
                if (item.children && item.children.length > 0) {
                    tooltip.appendMarkdown(`- **Sub-includes**: ${item.children.length}\n`);
                }
            }
            
            tooltip.appendMarkdown(`\n---\n`);
            tooltip.appendMarkdown(`[Open Editor](command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(item.filePath)))}) | `);
            tooltip.appendMarkdown(`[Open to Side](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))})`);
            tooltip.isTrusted = true;
            
            item.tooltip = tooltip;
        } catch (e) {
            // Fallback to basic tooltip
        }
        return item;
    }
```

- [ ] **步骤 3：修复测试用例 `test/extension.test.js` 以适配移除 `relDir` 的 `description` 格式**

在 `test/extension.test.js` 中找到 `applyVividDescription` 测试代码，更新断言中对 `description` 值的预期（不含有 `relDir` 前缀和 `•` 连接符）。

修改前：
```javascript
        // Test applyVividDescription
        const mockItem1 = { contextValue: 'file', description: '', fileSizeVal: 1024 * 5 };
        applyVividDescription(mockItem1, 'sub');
        assert.strictEqual(mockItem1.description, 'sub  •  ▏ 5.0 KB');

        const mockItem2 = { contextValue: 'file-missing', description: 'not found' };
        applyVividDescription(mockItem2, 'sub');
        assert.strictEqual(mockItem2.description, 'sub  •  not found');
```

修改后：
```javascript
        // Test applyVividDescription
        const mockItem1 = { contextValue: 'file', description: '', fileSizeVal: 1024 * 5 };
        applyVividDescription(mockItem1, 'sub');
        assert.strictEqual(mockItem1.description, '▏ 5.0 KB');
        assert.strictEqual(mockItem1.relDir, 'sub');

        const mockItem2 = { contextValue: 'file-missing', description: 'not found' };
        applyVividDescription(mockItem2, 'sub');
        assert.strictEqual(mockItem2.description, 'not found');
        assert.strictEqual(mockItem2.relDir, 'sub');
```

- [ ] **步骤 4：运行单元测试**

运行：`npm test`
预期输出：`183 passing`

- [ ] **步骤 5：Commit**

```bash
git add src/client/providers/includeTreeProvider.js test/extension.test.js
git commit -m "style: simplify sidebar description and move relative folder path to hover tooltip"
```
