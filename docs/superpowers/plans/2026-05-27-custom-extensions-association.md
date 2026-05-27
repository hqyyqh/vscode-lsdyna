# LS-DYNA Custom Extensions Association 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现当用户打开匹配 `lsdyna.additionalExtensions` 中后缀的文件（如 `.asc` 等）时，插件能自动将其 VS Code 语言模式关联为 `lsdyna`。

**架构：** 
1. 在 `src/extension.js` 中编写 `associateLsdynaLanguages` 逻辑，用于将匹配文件的语言模式设为 `lsdyna`。
2. 在 `activate` 入口注册文件打开事件和配置变化监听器。
3. 在 `test/vscode-mock.js` 中添加 `setTextDocumentLanguage` 模拟实现，并在单元测试中验证自动关联行为。

**技术栈：** VS Code Extension API, Javascript (Node.js), Mocha for testing

---

### 任务 1：更新 VS Code 单元测试 Mock 对象

**文件：**
- 修改：[vscode-mock.js](file:///d:/Project/vscode-lsdyna/test/vscode-mock.js)

- [ ] **步骤 1：在 `vscode-mock.js` 中的 `languages` 模块添加 `setTextDocumentLanguage` 模拟函数**

```javascript
    languages: { 
        registerFoldingRangeProvider: () => ({}), 
        registerDocumentSymbolProvider: () => ({}), 
        registerDocumentLinkProvider: () => ({}), 
        registerHoverProvider: () => ({}), 
        registerCodeLensProvider: () => ({}), 
        registerInlayHintsProvider: () => ({}), 
        registerDefinitionProvider: () => ({}), 
        registerReferenceProvider: () => ({}), 
        registerRenameProvider: () => ({}), 
        registerCompletionItemProvider: () => ({}), 
        createDiagnosticCollection: () => ({ set: () => {}, delete: () => {} }),
        setTextDocumentLanguage: (doc, langId) => {
            doc.languageId = langId;
            return Promise.resolve(doc);
        }
    },
```

- [ ] **步骤 2：运行单元测试，验证 Mock 更改后所有现有测试正常通过**

运行：`npm test`
预期：PASS (210 passing)

- [ ] **步骤 3：Commit**

```bash
git add test/vscode-mock.js
git commit -m "test: mock vscode.languages.setTextDocumentLanguage"
```

---

### 任务 2：实现动态文件语言绑定和生命周期事件监听

**文件：**
- 修改：[extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js)

- [ ] **步骤 1：在 `src/extension.js` 中实现 `associateLsdynaLanguages` 逻辑，并在 `activate` 中进行初始化和注册事件监听**

在 `isLsdynaFile` 函数之后或 `activate` 函数之前添加：
```javascript
function associateLsdynaLanguages() {
    vscode.workspace.textDocuments.forEach(doc => {
        if (isLsdynaUri(doc.uri) && doc.languageId !== 'lsdyna') {
            vscode.languages.setTextDocumentLanguage(doc, 'lsdyna').then(undefined, err => {
                console.error('[lsdyna] Failed to set text document language:', err);
            });
        }
    });
}
```

并在 `activate` 函数内部：
- 启动时立即运行：
```javascript
    associateLsdynaLanguages();
```
- 注册文件打开监听：
```javascript
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (isLsdynaUri(doc.uri) && doc.languageId !== 'lsdyna') {
                vscode.languages.setTextDocumentLanguage(doc, 'lsdyna').then(undefined, err => {
                    console.error('[lsdyna] Failed to set text document language:', err);
                });
            }
        })
    );
```
- 修改 `onDidChangeConfiguration` 监听块以在 `lsdyna.additionalExtensions` 变化时重新触发：
```javascript
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('lsdyna.language')) {
                i18n.updateLanguage();
                _fieldData = null;
                if (includeTreeView) {
                    includeTreeView.title = i18n.get('includeTreeTitle');
                }
                if (keywordTreeView) {
                    keywordTreeView.title = i18n.get('keywordIndexTitle');
                }
            }
            if (e.affectsConfiguration('lsdyna.additionalExtensions')) {
                associateLsdynaLanguages();
            }
        })
    );
```

- [ ] **步骤 2：运行 `npm test` 验证语法和编译无错且现有测试通过**

运行：`npm test`
预期：PASS (210 passing)

- [ ] **步骤 3：Commit**

```bash
git add src/extension.js
git commit -m "feat(extension): dynamically associate custom extension files with lsdyna language mode"
```

---

### 任务 3：编写单元测试验证动态关联逻辑

**文件：**
- 修改：[phase7_features.test.js](file:///d:/Project/vscode-lsdyna/test/client/providers/phase7_features.test.js)

- [ ] **步骤 1：在 `test/client/providers/phase7_features.test.js` 中添加用于验证自定义后缀自动关联的测试用例**

在文件末尾或合适的 `describe` 块中添加：
```javascript
    describe('Dynamic language association', () => {
        it('should change document language to lsdyna if extension matches custom extensions list', async () => {
            const originalTextDocuments = vscodeMock.workspace.textDocuments;
            const originalOnDidOpenTextDocument = vscodeMock.workspace.onDidOpenTextDocument;
            const originalGet = vscodeMock.workspace.getConfiguration().get;
            
            let onOpenCallback;
            vscodeMock.workspace.onDidOpenTextDocument = (callback) => {
                onOpenCallback = callback;
                return { dispose() {} };
            };
            
            // Mock document matching .asc
            const doc = {
                uri: { fsPath: '/test/file.asc' },
                languageId: 'plaintext'
            };
            
            vscodeMock.workspace.textDocuments = [doc];
            
            // Re-import / initialize to trigger activation event setup or test internals
            const extension = require('../../../src/extension');
            const internals = extension._internals;
            
            // Setup configuration mock return for lsdyna.additionalExtensions
            vscodeMock.workspace.getConfiguration = () => ({
                get: (key) => {
                    if (key === 'additionalExtensions') {
                        return ['.k', '.key', '.dyna', '.asc'];
                    }
                    return undefined;
                }
            });

            // Re-run association trigger check
            const context = { subscriptions: [] };
            extension.activate(context);
            
            // Verify onOpenCallback is registered and doc languageId is set to lsdyna
            assert.equal(doc.languageId, 'lsdyna');
            
            // Mock opening a new document with configured suffix
            const newDoc = {
                uri: { fsPath: '/test/newfile.asc' },
                languageId: 'plaintext'
            };
            if (onOpenCallback) {
                onOpenCallback(newDoc);
            }
            assert.equal(newDoc.languageId, 'lsdyna');

            // Restore mock
            vscodeMock.workspace.textDocuments = originalTextDocuments;
            vscodeMock.workspace.onDidOpenTextDocument = originalOnDidOpenTextDocument;
            vscodeMock.workspace.getConfiguration = () => ({
                get: originalGet
            });
        });
    });
```

- [ ] **步骤 2：运行单元测试验证所有测试都顺利通过**

运行：`npm test`
预期：PASS (211 passing)

- [ ] **步骤 3：Commit**

```bash
git add test/client/providers/phase7_features.test.js
git commit -m "test(extension): add unit test for dynamic custom extension language association"
```
