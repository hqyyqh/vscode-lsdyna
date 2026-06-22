# Include 路径自动补全 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现当用户在 `*INCLUDE` 关键字行下方输入文件路径时，自动提示在有效的 `*INCLUDE_PATH` 或 `*INCLUDE_PATH_RELATIVE` 中存在的文件路径候选。

**架构：**
1. 定义 `LsdynaIncludeCompletionProvider` 类，实现 VS Code 的 `CompletionItemProvider` 接口。
2. 检索当前文档中的搜索路径并过滤出在当前系统上真实存在的有效目录。
3. 递归遍历有效目录收集文件，并将相对于搜索目录的路径转换成以正斜杠 `/` 分隔的候选文本提供给 VS Code 自动补全。
4. 在 `src/extension.js` 中注册此 CompletionItemProvider。

**技术栈：** VS Code CompletionItemProvider API, Node.js `fs`

---

### 任务 1：定义 `LsdynaIncludeCompletionProvider` 并注册

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：在 `src/extension.js` 中编写 `LsdynaIncludeCompletionProvider`**

在 `LsdynaFileDecorationProvider` 的上方或下方，添加类定义：
```javascript
class LsdynaIncludeCompletionProvider {
    provideCompletionItems(document, position, token, context) {
        if (shouldSkipAutomaticDocumentScan(document)) return [];

        const lineText = document.lineAt(position.line).text;
        if (lineText.trimStart().startsWith('$')) {
            return [];
        }

        // Find enclosing keyword
        let kwLine = -1;
        for (let i = position.line; i >= 0; i--) {
            const text = document.lineAt(i).text.trimStart();
            if (text.startsWith('*')) {
                kwLine = i;
                break;
            }
        }

        if (kwLine === -1) return [];

        const kwText = document.lineAt(kwLine).text.trim().toUpperCase();
        if (!kwText.startsWith('*INCLUDE') || kwText.startsWith('*INCLUDE_PATH')) {
            return [];
        }

        const searchPaths = getSearchPath(document);
        const validPaths = [];
        for (const p of searchPaths) {
            let targetPath = p;
            if (!path.isAbsolute(p)) {
                targetPath = path.resolve(path.dirname(document.uri.fsPath), p);
            }
            try {
                if (fs.existsSync(targetPath)) {
                    const stats = fs.statSync(targetPath);
                    if (stats.isDirectory()) {
                        validPaths.push(targetPath);
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        const suggestions = new Set();
        const maxFiles = 300;
        const maxDepth = 3;

        function walkDir(dir, baseDir, depth = 0) {
            if (depth > maxDepth || suggestions.size >= maxFiles) {
                return;
            }
            try {
                const list = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of list) {
                    if (suggestions.size >= maxFiles) break;

                    const name = entry.name;
                    if (name.startsWith('.') ||
                        name === 'node_modules' ||
                        name === 'venv' ||
                        name === '.git' ||
                        name === '.github' ||
                        name === '.vscode' ||
                        name === 'build' ||
                        name === 'dist' ||
                        name === 'out' ||
                        name === 'target') {
                        continue;
                    }

                    const fullPath = path.join(dir, name);
                    if (entry.isDirectory()) {
                        walkDir(fullPath, baseDir, depth + 1);
                    } else if (entry.isFile()) {
                        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
                        suggestions.add(relPath);
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        for (const baseDir of validPaths) {
            walkDir(baseDir, baseDir);
        }

        const items = [];
        for (const file of suggestions) {
            const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
            item.detail = 'Include File';
            items.push(item);
        }

        return items;
    }
}
```

- [ ] **步骤 2：在 `activate(context)` 中注册 CompletionItemProvider**

在 `activate` 函数内添加：
```javascript
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaIncludeCompletionProvider(),
            '/', '\\'
        )
    );
```

- [ ] **步骤 3：在 `module.exports._internals` 中导出 `LsdynaIncludeCompletionProvider`**

在 `src/extension.js` 最下方的 `_internals` 块中加入 `LsdynaIncludeCompletionProvider`。

---

### 任务 2：编写并运行单元测试

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：在 `test/extension.test.js` 中编写 `LsdynaIncludeCompletionProvider` 测试用例**

在文件末尾添加测试用例：
```javascript
// ---------------------------------------------------------------------------
// LsdynaIncludeCompletionProvider
// ---------------------------------------------------------------------------

describe('LsdynaIncludeCompletionProvider', () => {
    it('provides completion items for includes inside valid paths', () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();

        // Create a temporary workspace layout
        const tempDir = path.join(os.tmpdir(), `lsdyna-completion-test-${Date.now()}`);
        fs.mkdirSync(tempDir);

        const subDir = path.join(tempDir, 'submodels');
        fs.mkdirSync(subDir);

        const invalidDir = 'D:\\non_existent_folder_path_xyz'; // Represents a path from another computer

        fs.writeFileSync(path.join(tempDir, 'file1.k'), '');
        fs.writeFileSync(path.join(subDir, 'file2.k'), '');

        // Main file has valid relative path and invalid absolute path from another machine
        const mainFileContent = `*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE_PATH\n${invalidDir}\n*INCLUDE\n`;
        const mainFile = path.join(tempDir, 'main.k');
        fs.writeFileSync(mainFile, mainFileContent);

        const doc = fakeDoc(mainFileContent, mainFile);

        try {
            // Position is at line 4 (directly under *INCLUDE)
            const position = { line: 4, character: 0 };
            const items = provider.provideCompletionItems(doc, position);

            assert.ok(items);
            const labels = items.map(item => item.label);

            // Should contain files from submodels (since submodels is valid)
            assert.ok(labels.includes('file2.k'));

            // Should not show anything from the invalidDir since it is validated to not exist
            assert.ok(!labels.includes('non_existent_xyz'));
        } finally {
            // Cleanup
            fs.unlinkSync(path.join(tempDir, 'file1.k'));
            fs.unlinkSync(path.join(subDir, 'file2.k'));
            fs.rmdirSync(subDir);
            fs.unlinkSync(mainFile);
            fs.rmdirSync(tempDir);
        }
    });
});
```

- [ ] **步骤 2：在终端中运行所有单元测试验证**

运行命令：
```powershell
npm test
```
预期输出：所有 156+ 项测试全部成功。

- [ ] **步骤 3：Commit 代码**

运行命令：
```powershell
git add src/extension.js test/extension.test.js
git commit -m "feat: implement include path autocomplete filtering out invalid remote paths"
```
