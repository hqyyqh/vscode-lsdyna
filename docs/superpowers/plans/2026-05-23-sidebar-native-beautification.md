# Sidebar Native Beautification Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 通过原生 VS Code API（FileDecorationProvider、异步树节点解析 resolveTreeItem、Markdown 富文本悬浮卡片、内联和标题栏动作按钮）对侧边栏的 Include Tree 和 Keyword Index 进行深度美化与交互体验提升。

**架构：**
1. **FileDecorationProvider**：注册一个全局的文件装饰提供者，它读取已扫描的 Include 列表。如果文件在列表中且存在，在侧边栏和资源管理器中赋予绿色文字和 `✓` 徽章；若缺失，赋予黄色文字和 `⚠` 徽章。
2. **异步 resolveTreeItem**：在用户悬浮树节点时，动态读取目标文件的局部代码片段（前几行数据），并生成包含语法高亮预览和快捷链接的 Markdown 卡片。
3. **Keyword Index Toggle**：优化标题栏控制按钮，当处于 `local` 模式时显示 `Scan Project` 按钮，处于 `recursive` 模式时显示 `View Current File` 按钮，形成完美的交互双态。

**技术栈：** VS Code Ext API (`FileDecorationProvider`, `resolveTreeItem`, `MarkdownString`, `ThemeColor`, `ThemeIcon`), Node.js `readline`/`fs`。

---

## 计划涉及文件一览

- 修改：`package.json` —— 调整按钮显示逻辑和增加刷新命令
- 修改：`src/extension.js` —— 注册 `FileDecorationProvider`，协调扫描数据与装饰更新
- 修改：`src/client/providers/includeTreeProvider.js` —— 实现 `resolveTreeItem` 生成富文本悬浮卡片，记录并暴露已扫描的文件状态
- 修改：`src/client/providers/keywordIndexProvider.js` —— 实现 `resolveTreeItem` 与异步文件代码片段读取，丰富悬浮卡片内容
- 修改：`test/extension.test.js` —— 新增文件片段读取与装饰提供者的单元测试

---

### 任务 1：实现文件代码片段高效读取工具

为了在悬浮关键字时显示对应的 LS-DYNA 卡片数据，且不影响大文件的打开性能，必须实现一个基于流的高效局部文件读取器。

**文件：**
- 修改：`src/client/providers/keywordIndexProvider.js` (在文件末尾添加辅助函数并导出)
- 修改：`test/extension.test.js` (添加测试)

- [ ] **步骤 1：在测试文件中编写 `readFileSnippet` 的单元测试**

```javascript
// 在 test/extension.test.js 中添加以下测试用例：
describe('readFileSnippet', () => {
    it('reads a specific range of lines from a file efficiently', async () => {
        const tempFile = path.join(os.tmpdir(), `lsdyna-snippet-test-${Date.now()}.k`);
        fs.writeFileSync(tempFile, 'line0\nline1\nline2\nline3\nline4\nline5\n', 'utf8');
        try {
            const { readFileSnippet } = require('../src/client/providers/keywordIndexProvider');
            const snippet = await readFileSnippet(tempFile, 2, 3);
            assert.strictEqual(snippet, 'line2\nline3\nline4');
        } finally {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test`
预期：FAIL，报错提示 `readFileSnippet is not a function`

- [ ] **步骤 3：编写 `readFileSnippet` 实现代码**

```javascript
// 在 src/client/providers/keywordIndexProvider.js 末尾添加：
const readline = require('readline');

function readFileSnippet(filePath, lineIndex, maxLines = 6) {
    return new Promise((resolve) => {
        if (!fs.existsSync(filePath)) {
            return resolve(null);
        }
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        
        let current = 0;
        const lines = [];
        
        rl.on('line', (line) => {
            if (current >= lineIndex && current < lineIndex + maxLines) {
                lines.push(line);
            }
            if (current >= lineIndex + maxLines) {
                rl.close();
            }
            current++;
        });
        
        rl.on('close', () => {
            stream.destroy();
            resolve(lines.join('\n'));
        });
        
        rl.on('error', () => {
            stream.destroy();
            resolve(null);
        });
    });
}
```
并在文件最后的 `module.exports` 中导出 `readFileSnippet`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test`
预期：PASS，所有 152 项测试均通过。

- [ ] **步骤 5：Commit**

```bash
git add src/client/providers/keywordIndexProvider.js test/extension.test.js
git commit -m "feat: implement high-performance file snippet reader"
```

---

### 任务 2：重构 TreeDataProvider 并实现异步悬浮卡片解析

实现 `resolveTreeItem`，提升 Hover Tooltip 的视觉质感。

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`
- 修改：`src/client/providers/keywordIndexProvider.js`

- [ ] **步骤 1：为 Include TreeProvider 增加 `resolveTreeItem`**

在 `src/client/providers/includeTreeProvider.js` 的 `LsdynaIncludeTreeProvider` 类中添加 `resolveTreeItem` 方法：

```javascript
    async resolveTreeItem(item, element, token) {
        if (!element.filePath || !fs.existsSync(element.filePath)) {
            return element;
        }
        try {
            const stats = fs.statSync(element.filePath);
            const sizeKB = (stats.size / 1024).toFixed(1);
            
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(element.filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **Path**: \`${element.filePath}\`\n`);
            tooltip.appendMarkdown(`- **Size**: \`${sizeKB} KB\`\n`);
            
            if (element.contextValue === 'file-missing') {
                tooltip.appendMarkdown(`- **Status**: ❌ *Missing / Not found*\n`);
            } else {
                tooltip.appendMarkdown(`- **Status**: ✅ *Resolved*\n`);
                if (element.children && element.children.length > 0) {
                    tooltip.appendMarkdown(`- **Sub-includes**: ${element.children.length}\n`);
                }
            }
            
            tooltip.appendMarkdown(`\n---\n`);
            tooltip.appendMarkdown(`[Open Editor](command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(element.filePath)))}) | `);
            tooltip.appendMarkdown(`[Open to Side](command:extension.openToSide?${encodeURIComponent(JSON.stringify(element))})`);
            tooltip.isTrusted = true;
            
            element.tooltip = tooltip;
        } catch (e) {
            // Fallback to basic tooltip
        }
        return element;
    }
```

- [ ] **步骤 2：为 Keyword Index Provider 增加 `resolveTreeItem` 并动态生成卡片预览**

在 `src/client/providers/keywordIndexProvider.js` 的 `LsdynaKeywordIndexProvider` 类中添加 `resolveTreeItem` 方法：

```javascript
    async resolveTreeItem(item, element, token) {
        if (element instanceof KeywordUsageItem) {
            const snippet = await readFileSnippet(element.resourceUri.fsPath, element.command.arguments[1], 8);
            if (snippet) {
                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`### Keyword: **${element.label}**\n\n`);
                tooltip.appendMarkdown(`- **File**: \`${element.resourceUri.fsPath}\`\n`);
                tooltip.appendMarkdown(`- **Line**: ${element.command.arguments[1] + 1}\n\n`);
                tooltip.appendMarkdown(`**Card Data Preview:**\n`);
                tooltip.appendMarkdown(`\`\`\`lsdyna\n${snippet}\n\`\`\``);
                
                tooltip.appendMarkdown(`\n---\n`);
                tooltip.appendMarkdown(`[Open File](command:vscode.open?${encodeURIComponent(JSON.stringify(element.resourceUri))}) | `);
                tooltip.appendMarkdown(`[Open to Side](command:extension.openToSide?${encodeURIComponent(JSON.stringify(element))})`);
                tooltip.isTrusted = true;
                
                element.tooltip = tooltip;
            }
        }
        return element;
    }
```

- [ ] **步骤 3：运行测试验证 Tree Provider**

运行：`npm test`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/client/providers/includeTreeProvider.js src/client/providers/keywordIndexProvider.js
git commit -m "feat: implement resolveTreeItem for sidebar providers"
```

---

### 任务 3：设计并注册全局 FileDecorationProvider

为 LS-DYNA 的文件提供绿色（已解析）和橙黄色（丢失）的边框徽章及文字着色，并自动刷新。

**文件：**
- 修改：`src/extension.js`
- 修改：`src/client/providers/includeTreeProvider.js`

- [ ] **步骤 1：记录 Include 扫描的文件状态**

在 `src/client/providers/includeTreeProvider.js` 的 `LsdynaIncludeTreeProvider` 中，我们需要记录已成功扫描的 Resolved 文件集合和 Missing 文件集合。

在 `LsdynaIncludeTreeProvider` 类的 `constructor` 中新增：
```javascript
        this.resolvedPaths = new Set();
        this.missingPaths = new Set();
```

修改 `scan()` 方法，在扫描成功后填充这两个 Set：
```javascript
    async scan() {
        const uri = getActiveUri();
        if (!uri || !isLsdynaUri(uri)) {
            // ...
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning includes…', cancellable: false },
            async (progress) => {
                this.resolvedPaths.clear();
                this.missingPaths.clear();
                
                if (this.loadProjectSnapshot) {
                    const snapshot = await this.loadProjectSnapshot(uri.fsPath);
                    this.root = this._buildRootFromSnapshot(snapshot, uri.fsPath);
                    
                    // 递归收集 snapshot 中的路径
                    const collectPaths = (node) => {
                        if (node.missing) {
                            this.missingPaths.add(node.filePath);
                        } else {
                            this.resolvedPaths.add(node.filePath);
                        }
                        if (node.children) {
                            node.children.forEach(collectPaths);
                        }
                    };
                    if (snapshot.graph && snapshot.graph.toTree) {
                        collectPaths(snapshot.graph.toTree(uri.fsPath));
                    }
                } else {
                    this.root = await this._buildItem(uri.fsPath, new Set(), progress, uri.fsPath);
                    
                    // 递归收集手动扫描的路径
                    const collectTreePaths = (item) => {
                        if (item.contextValue === 'file-missing') {
                            this.missingPaths.add(item.filePath);
                        } else {
                            this.resolvedPaths.add(item.filePath);
                        }
                        if (item.children) {
                            item.children.forEach(collectTreePaths);
                        }
                    };
                    collectTreePaths(this.root);
                }
                this.root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                this._onDidChangeTreeData.fire(undefined);
            }
        );
    }
```

- [ ] **步骤 2：在 `src/extension.js` 中注册 `LsdynaFileDecorationProvider`**

在 `src/extension.js` 中，新增一个 FileDecorationProvider 类，并在 `activate()` 中进行注册：

```javascript
class LsdynaFileDecorationProvider {
    constructor(includeTreeProvider) {
        this.includeTreeProvider = includeTreeProvider;
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    }

    refresh() {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri) {
        if (uri.scheme !== 'file') return undefined;
        const fsPath = uri.fsPath;

        if (this.includeTreeProvider.missingPaths.has(fsPath)) {
            return {
                badge: '⚠',
                tooltip: 'Missing Include Reference',
                color: new vscode.ThemeColor('editorWarning.foreground')
            };
        }

        if (this.includeTreeProvider.resolvedPaths.has(fsPath)) {
            return {
                badge: '✓',
                tooltip: 'Resolved Include Reference',
                color: new vscode.ThemeColor('testing.iconPassed')
            };
        }

        return undefined;
    }
}
```

在 `activate(context)` 方法中：
```javascript
    // 实例化装饰提供者
    const fileDecorationProvider = new LsdynaFileDecorationProvider(includeTreeProvider);
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileDecorationProvider)
    );

    // 修改已有的 scanIncludeTree 注册逻辑，在扫描完成后调用刷新
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.scanIncludeTree', async () => {
            await includeTreeProvider.scan();
            fileDecorationProvider.refresh();
        })
    );
```

- [ ] **步骤 3：对 Missing Include 节点设置 `resourceUri`**

为了让 `FileDecorationProvider` 能够渲染 Missing Includes（未找到的文件），我们必须给 Missing Include 节点也附带 `resourceUri = vscode.Uri.file(filePath)`。

在 `src/client/providers/includeTreeProvider.js` 的 `IncludeItem` 的构造函数中：
```javascript
        if (!exists) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            this.description = 'not found';
            this.contextValue = 'file-missing';
            this.resourceUri = vscode.Uri.file(filePath); // 关键修改：即使不存在也赋 resourceUri，激活 Decoration
        } else {
            this.resourceUri = vscode.Uri.file(filePath);
            this.contextValue = 'file';
        }
```

- [ ] **步骤 4：运行测试验证**

运行：`npm test`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/extension.js src/client/providers/includeTreeProvider.js
git commit -m "feat: implement FileDecorationProvider for project include files"
```

---

### 任务 4：微调 package.json 以支持双态标题栏与动作可见性

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：修改标题栏按钮的 visible 状态**

修改 `package.json` 中的 `menus.view/title` 部分，在 `extension.scanKeywordIndex` 和 `extension.keywordIndexSetLocal` 的 `when` 条件中，加入 `lsdyna.keywordIndexMode` 上下文判断，使其在 local 模式时展示 `Scan` 按钮，在 recursive 模式时展示 `View Current File` 按钮。

在 `package.json` 中：
```json
            "view/title": [
                {
                    "command": "extension.scanIncludeTree",
                    "when": "view == lsdynaIncludeTree",
                    "group": "navigation@1"
                },
                {
                    "command": "extension.scanKeywordIndex",
                    "when": "view == lsdynaKeywordIndex && lsdyna.keywordIndexMode == 'local'",
                    "group": "navigation@1"
                },
                {
                    "command": "extension.keywordIndexSetLocal",
                    "when": "view == lsdynaKeywordIndex && lsdyna.keywordIndexMode == 'recursive'",
                    "group": "navigation@1"
                }
            ]
```

- [ ] **步骤 2：运行单元测试**

运行：`npm test`
预期：PASS，所有 152 项测试均通过。

- [ ] **步骤 3：Commit**

```bash
git add package.json
git commit -m "style: optimize title toolbar navigation toggles"
```

---

## 验证计划

### 自动化测试
运行已有的完整测试套件，并新增针对 `readFileSnippet` 的测试用例：
```bash
npm test
```

### 手动验证步骤
1. 加载侧载运行插件，打开大文件 `ram-detailed-v3a.key`。
2. 展开 `Include Tree`，点击右上角的 **Sync/Scan** 旋转图标。
3. 检查 `Include Tree` 中：
   - 已成功解析的文件其名称右侧应该出现绿色的 `✓` 徽章，文字呈淡绿色。
   - 未找到的包含文件右侧应该出现琥珀色的 `⚠` 徽章，文字呈琥珀色。
4. 鼠标悬浮在 Include 节点上，稍等片刻，检查是否出现包含文件大小、绝对路径以及快速操作链接（`Open Editor`, `Open to Side`）的 Markdown 提示卡片。
5. 展开 `Keyword Index`，点击右上角的 **Scan** 图标转换为 recursive 模式（项目级扫描）。
6. 点击进入具体关键字，悬浮到具体引用项（`:line XX`）节点上，确认气泡内显示出该引用行及附近 8 行的真实 LS-DYNA 代码卡片预览（带高亮）。
7. 确认 Keyword Index 右上角按钮切换为 **View Current File** (文件图标)，点击后能够快速切回 local 模式，右上角按钮同步变回 **Scan** (雷达/搜索图标)。
