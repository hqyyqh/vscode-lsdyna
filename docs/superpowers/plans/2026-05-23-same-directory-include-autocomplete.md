# Same Directory Include Autocomplete Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `*INCLUDE` 卡片中，输入 `/` 或 `\` 时能够补全当前目录下的候选文件。

**架构：** 在 `LsdynaIncludeCompletionProvider` 中，提取输入前缀 `currentPrefix`。对于同目录下（不含斜杠）的文件，若 `currentPrefix` 含有斜杠或 `./` 前缀，动态为补全项设置相应的 `filterText`。

**技术栈：** VS Code Extension API (Javascript), Mocha for testing.

---

### 任务 1：编写同目录自动补全的测试用例（TDD 失败测试）

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：在 `test/extension.test.js` 的 `LsdynaIncludeCompletionProvider` 块中编写失败测试用例**

在 `provides completion items for includes inside valid paths` 测试的 `try` 块里，添加对以 `/` 和 `\` 触发补全时，能否包含同级文件 `file1.k` 的校验。

```javascript
            // Test case: triggers autocomplete with '/' for same-directory file 'file1.k'
            const slashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n/`, mainFile);
            const slashList = provider.provideCompletionItems(slashDoc, { line: 3, character: 1 });
            assert.ok(slashList);
            const file1ItemSlash = slashList.items.find(item => item.label === 'file1.k');
            assert.ok(file1ItemSlash, 'should suggest file1.k when typing /');
            assert.strictEqual(file1ItemSlash.filterText, '/file1.k');

            // Test case: triggers autocomplete with '\' for same-directory file 'file1.k'
            const backslashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n\\`, mainFile);
            const backslashList = provider.provideCompletionItems(backslashDoc, { line: 3, character: 1 });
            assert.ok(backslashList);
            const file1ItemBackslash = backslashList.items.find(item => item.label === 'file1.k');
            assert.ok(file1ItemBackslash, 'should suggest file1.k when typing \\');
            assert.strictEqual(file1ItemBackslash.filterText, '\\file1.k');

            // Test case: triggers autocomplete with './' for same-directory file 'file1.k'
            const dotSlashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n./`, mainFile);
            const dotSlashList = provider.provideCompletionItems(dotSlashDoc, { line: 3, character: 2 });
            assert.ok(dotSlashList);
            const file1ItemDotSlash = dotSlashList.items.find(item => item.label === 'file1.k');
            assert.ok(file1ItemDotSlash, 'should suggest file1.k when typing ./');
            assert.strictEqual(file1ItemDotSlash.filterText, './file1.k');
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test`
预期：在 `LsdynaIncludeCompletionProvider provides completion items for includes inside valid paths` 测试中发生断言错误，提示找不到 `file1.k`（或者 `filterText` 不是预期的 `/file1.k`）。

---

### 任务 2：实现同级文件动态 `filterText` 逻辑

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：修改 `LsdynaIncludeCompletionProvider` 中的 `provideCompletionItems` 方法**

修改 [src/extension.js:859-868](file:///d:/Project/vscode-lsdyna/src/extension.js#L859-L868)，添加 `currentPrefix` 计算和同级文件的 `filterText` 赋值。

```javascript
        const trimmedStart = lineText.length - lineText.trimStart().length;
        if (position.character < trimmedStart) {
            return [];
        }
        const range = new vscode.Range(position.line, trimmedStart, position.line, position.character);
        const currentPrefix = lineText.slice(trimmedStart, position.character);

        const items = [];
        for (const file of suggestions) {
            const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
            item.detail = 'Include File';
            item.range = range;
            if (!file.includes('/') && !file.includes('\\')) {
                if (currentPrefix.startsWith('./')) {
                    item.filterText = './' + file;
                } else if (currentPrefix.startsWith('.\\')) {
                    item.filterText = '.\\' + file;
                } else if (currentPrefix.startsWith('/')) {
                    item.filterText = '/' + file;
                } else if (currentPrefix.startsWith('\\')) {
                    item.filterText = '\\' + file;
                }
            }
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npm test`
预期：所有 156 个测试用例全部通过。

- [ ] **步骤 3：进行 Git Commit**

运行：
```bash
git add src/extension.js test/extension.test.js
git commit -m "fix: set matching filterText for same-directory include candidates on slash trigger"
```
