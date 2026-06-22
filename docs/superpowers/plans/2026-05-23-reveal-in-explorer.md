# 资源管理器定位与左侧体积展示 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现从 Include Tree 节点直接在 Windows 资源管理器中打开并选中相应文件，并将文件大小以包含生动 Emoji 的格式展示在左侧文件名与子路径之后。

**架构：**
1. 在 `package.json` 中配置一个 inline 菜单项，绑定 icon 为 `$(folder-opened)`，显示在 hover 节点右侧。
2. 注册命令 `extension.revealInExplorer`，执行 VS Code 原生的 `revealFileInOS` 命令定位文件。
3. 清除 `LsdynaFileDecorationProvider` 为已解析文件提供的体积 badge，仅保留绿色文字状态；Missing 文件依然保留 `⚠`。
4. 重构 `src/client/providers/includeTreeProvider.js`，根据文件大小采用不同的 Emoji（`⚡`、`💾`、`📦`），并整合子路径与体积，形成 `[子路径]  •  [Emoji] [体积]` 的左侧描述样式。

**技术栈：** VS Code Ext API, Node.js, Mocha

---

### 任务 1：配置 `package.json` 支持右置 Reveal 图标按钮

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：在 `package.json` 中定义命令与菜单**

在 `"commands"` 数组中添加：
```json
        {
            "command": "extension.revealInExplorer",
            "title": "Reveal in File Explorer",
            "icon": "$(folder-opened)"
        }
```

在 `"menus"` 的 `"view/item/context"` 数组中添加：
```json
            "view/item/context": [
                {
                    "command": "extension.revealInExplorer",
                    "when": "view == lsdynaIncludeTree && viewItem == file",
                    "group": "inline"
                }
            ]
```

---

### 任务 2：实现 `extension.revealInExplorer` 命令与更新 `LsdynaFileDecorationProvider`

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：在 `src/extension.js` 中注册命令**

在 `activate(context)` 方法中添加对 `extension.revealInExplorer` 命令的注册：
```javascript
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.revealInExplorer', async (item) => {
            if (item && item.resourceUri) {
                await vscode.commands.executeCommand('revealFileInOS', item.resourceUri);
            }
        })
    );
```

- [ ] **步骤 2：在 `LsdynaFileDecorationProvider` 中取消 Resolved 文件的体积显示**

修改 `provideFileDecoration(uri)`，移除 `badge: this.includeTreeProvider.resolvedPaths.get(key)`：
```javascript
        if (this.includeTreeProvider.resolvedPaths.has(key)) {
            return {
                tooltip: 'Resolved Include Reference',
                color: new vscode.ThemeColor('testing.iconPassed')
            };
        }
```

---

### 任务 3：重构左侧 `description` 的生动展示逻辑

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`

- [ ] **步骤 1：添加生动体积格式化与描述构建辅助函数**

在 `src/client/providers/includeTreeProvider.js` 的 `formatShortBytes` 后面增加 `formatVividBytes` 与 `applyVividDescription`：
```javascript
function formatVividBytes(bytes) {
    if (bytes === 0) return '⚡ 0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < sizes.length - 1) {
        val /= 1024;
        i++;
    }
    let emoji = '💾';
    if (bytes < 10 * 1024) {
        emoji = '⚡';
    } else if (bytes >= 1024 * 1024) {
        emoji = '📦';
    }
    return `${emoji} ${val.toFixed(1)} ${sizes[i]}`;
}

function applyVividDescription(item, relDir) {
    let statusText = '';
    if (item.contextValue === 'file-missing') {
        statusText = 'not found';
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

- [ ] **步骤 2：修改 `IncludeItem` 的构造函数记录字节数值**

在 `IncludeItem` 构造函数中：
```javascript
class IncludeItem extends vscode.TreeItem {
    constructor(filePath, exists) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
        this.filePath = filePath;
        this.children = [];
        this.resourceUri = vscode.Uri.file(filePath);
        this.fileSizeStr = '';
        this.fileSizeVal = undefined;

        if (!exists) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            this.description = 'not found';
            this.contextValue = 'file-missing';
        } else {
            this.contextValue = 'file';
            try {
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    this.fileSizeStr = formatBytes(stats.size);
                    this.fileSizeVal = stats.size;
                }
            } catch (e) {
                // ignore
            }
        }
        applyVividDescription(this, '');
    }
}
```

- [ ] **步骤 3：修改 `_buildItemFromTreeNode` 以组合子路径与生动描述**

重构 `_buildItemFromTreeNode` 中的 description 处理，移除旧的 `item.description = dirStr`，改为调用 `applyVividDescription`：
```javascript
    _buildItemFromTreeNode(node, rootPath) {
        const exists = !node.missing && fs.existsSync(node.filePath);
        const item = new IncludeItem(node.filePath, exists);
        if (node.cycle) {
            item.description = 'circular';
            item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node.missing) {
            item.description = 'missing';
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else {
            item.children = (node.children || []).map(childNode => this._buildItemFromTreeNode(childNode, rootPath || node.filePath));
            item.collapsibleState = item.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
        }

        let dirStr = '';
        if (rootPath && rootPath !== node.filePath) {
            const dir = path.dirname(rootPath);
            const rel = path.relative(dir, node.filePath);
            const relDir = path.dirname(rel);
            dirStr = relDir === '.' ? '' : relDir;
        }
        applyVividDescription(item, dirStr);

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### Include File: **${path.basename(node.filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **Path**: \`${node.filePath}\`\n`);
        if (node.cycle) {
            tooltip.appendMarkdown(`- **Status**: ⚠️ *Circular dependency*\n`);
        } else if (!node.missing && item.children.length > 0) {
            tooltip.appendMarkdown(`- **Sub-includes**: ${item.children.length}\n`);
        }
        item.tooltip = tooltip;

        return item;
    }
```

- [ ] **步骤 4：修改 `_buildItem` 以组合子路径与生动描述**

重构 `_buildItem` 里的同样逻辑：
```javascript
        let dirStr = '';
        if (actualRootPath !== filePath) {
            const dir = path.dirname(actualRootPath);
            const rel = path.relative(dir, filePath);
            const relDir = path.dirname(rel);
            dirStr = relDir === '.' ? '' : relDir;
        }

        let includeEntries;
        let searchPaths;
        try {
            ({ includeEntries, searchPaths } = await includeScanner.collectIncludeDirectivesFromFile(filePath));
        } catch (error) {
            item.description = 'scan failed';
            applyVividDescription(item, dirStr);

            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
            tooltip.appendMarkdown(`- **Status**: ❌ *Scan failed*\n`);
            tooltip.appendMarkdown(`- **Error**: ${error.message}\n`);
            item.tooltip = tooltip;

            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            return item;
        }

        for (const { fileName } of includeEntries) {
            let childPath;
            try {
                childPath = this.searchFileFromPaths(fileName, searchPaths);
            } catch (e) {
                childPath = path.resolve(path.dirname(filePath), fileName);
            }
            item.children.push(await this._buildItem(childPath, new Set(visited), progress, actualRootPath));
        }

        item.collapsibleState = item.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        applyVividDescription(item, dirStr);
```

---

### 任务 4：更新并运行单元测试

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：修改 `LsdynaFileDecorationProvider` 测试用例**

在 `test/extension.test.js` 中，Resolved 文件的 badge 断言变更为 `undefined`：
```javascript
        assert.strictEqual(resolvedDec.badge, undefined);
```

- [ ] **步骤 2：添加 `formatVividBytes` 与 `applyVividDescription` 的单元测试**

在 `test/extension.test.js` 中添加针对生动体积格式化的测试用例。

- [ ] **步骤 3：在终端中运行所有单元测试验证**

运行命令：
```powershell
npm test
```
预期输出：所有 155+ 项测试全部成功。

- [ ] **步骤 4：Commit 代码变更**

运行命令：
```powershell
git add package.json src/extension.js src/client/providers/includeTreeProvider.js test/extension.test.js
git commit -m "feat: show vivid file sizes on left and add inline open in OS explorer button"
```
