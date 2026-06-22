# LS-DYNA Global Manuals Directory Configuration 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将手册路径配置（`lsdyna.manualsDir`）持久化行为限制为仅写入全局（Global）设置，且在发生写入失败时弹窗报错。

**架构：**
1. 在 `test/vscode-mock.js` 中添加 `ConfigurationTarget` 模拟对象。
2. 在 `src/core/i18n.js` 中添加 `failedToSaveGlobalConfig` 国际化翻译词条。
3. 在 `src/extension.js` 中修改 `extension.configureManualsDir` 实现逻辑，使用 try-catch 包裹配置更新，且 Target 设为 `vscode.ConfigurationTarget.Global`。
4. 在 `test/client/providers/phase7_features.test.js` 中编写对应的单元测试进行验证。

**技术栈：** VS Code Extension API, Javascript (Node.js), Mocha for testing

---

### 任务 1：更新单元测试 VS Code Mock 对象

**文件：**
- 修改：[vscode-mock.js](file:///d:/Project/vscode-lsdyna/test/vscode-mock.js)

- [ ] **步骤 1：在 `test/vscode-mock.js` 导出的模块中，添加 `ConfigurationTarget` 属性**

```javascript
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
```

- [ ] **步骤 2：运行单元测试确保现有测试无影响**

运行：`npm test`
预期：PASS (211 passing)

- [ ] **步骤 3：Commit**

```bash
git add test/vscode-mock.js
git commit -m "test: mock vscode.ConfigurationTarget"
```

---

### 任务 2：添加国际化多语言词条

**文件：**
- 修改：[i18n.js](file:///d:/Project/vscode-lsdyna/src/core/i18n.js)

- [ ] **步骤 1：在 `src/core/i18n.js` 的 `zh-cn` 和 `en` 词典中增加 `failedToSaveGlobalConfig` 翻译**

在 `zh-cn` 中添加：
```javascript
        failedToSaveGlobalConfig: '无法将手册路径保存到全局配置：{0}',
```
在 `en` 中添加：
```javascript
        failedToSaveGlobalConfig: 'Failed to save manuals directory globally: {0}',
```

- [ ] **步骤 2：运行单元测试，验证无语法错误**

运行：`npm test`
预期：PASS (211 passing)

- [ ] **步骤 3：Commit**

```bash
git add src/core/i18n.js
git commit -m "feat(i18n): add failedToSaveGlobalConfig translation keys"
```

---

### 任务 3：实现强制全局写入和错误捕捉

**文件：**
- 修改：[extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js)

- [ ] **步骤 1：修改 `src/extension.js` 中 `extension.configureManualsDir` 命令实现，应用 `try-catch` 和 `vscode.ConfigurationTarget.Global`**

定位并替换以下代码：
```javascript
            if (folders && folders[0]) {
                const selectedPath = folders[0].fsPath;
                const config = vscode.workspace.getConfiguration('lsdyna');

                try {
                    await config.update('manualsDir', selectedPath, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(i18n.get('manualDirSetTo', selectedPath));
                } catch (err) {
                    vscode.window.showErrorMessage(i18n.get('failedToSaveGlobalConfig', err.message));
                }

                if (process.platform === 'win32') {
```

- [ ] **步骤 2：运行单元测试，验证无语法或逻辑错误**

运行：`npm test`
预期：PASS (211 passing)

- [ ] **步骤 3：Commit**

```bash
git add src/extension.js
git commit -m "feat(extension): force manualsDir config to save globally and handle failure"
```

---

### 任务 4：编写单元测试验证配置更新

**文件：**
- 修改：[phase7_features.test.js](file:///d:/Project/vscode-lsdyna/test/client/providers/phase7_features.test.js)

- [ ] **步骤 1：在 `test/client/providers/phase7_features.test.js` 尾部添加对 `extension.configureManualsDir` 的单元测试**

```javascript
    describe('extension.configureManualsDir command', () => {
        it('should update manualsDir config globally and show success info', async () => {
            const originalShowOpenDialog = vscodeMock.window.showOpenDialog;
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalShowInformationMessage = vscodeMock.window.showInformationMessage;

            let updateCalled = false;
            let updateKey, updateVal, updateTarget;

            vscodeMock.window.showOpenDialog = async () => [{ fsPath: '/path/to/manuals' }];
            vscodeMock.workspace.getConfiguration = () => ({
                update: async (key, val, target) => {
                    updateCalled = true;
                    updateKey = key;
                    updateVal = val;
                    updateTarget = target;
                }
            });

            let infoMsg = '';
            vscodeMock.window.showInformationMessage = (msg) => {
                infoMsg = msg;
            };

            const extension = require('../../../src/extension');
            const internals = extension._internals;

            // Find registered command handler or call activate to register it
            let registeredCallback;
            const originalRegisterCommand = vscodeMock.commands.registerCommand;
            vscodeMock.commands.registerCommand = (cmd, cb) => {
                if (cmd === 'extension.configureManualsDir') {
                    registeredCallback = cb;
                }
                return { dispose() {} };
            };

            const context = { subscriptions: [] };
            extension.activate(context);

            if (registeredCallback) {
                await registeredCallback();
            }

            assert.ok(updateCalled);
            assert.equal(updateKey, 'manualsDir');
            assert.equal(updateVal, '/path/to/manuals');
            assert.equal(updateTarget, vscodeMock.ConfigurationTarget.Global);
            assert.ok(infoMsg.includes('/path/to/manuals'));

            // Restore mocks
            vscodeMock.window.showOpenDialog = originalShowOpenDialog;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.window.showInformationMessage = originalShowInformationMessage;
            vscodeMock.commands.registerCommand = originalRegisterCommand;
        });

        it('should show error message if global config update fails', async () => {
            const originalShowOpenDialog = vscodeMock.window.showOpenDialog;
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalShowErrorMessage = vscodeMock.window.showErrorMessage;

            vscodeMock.window.showOpenDialog = async () => [{ fsPath: '/path/to/manuals' }];
            vscodeMock.workspace.getConfiguration = () => ({
                update: async () => {
                    throw new Error('Permission Denied');
                }
            });

            let errorMsg = '';
            vscodeMock.window.showErrorMessage = (msg) => {
                errorMsg = msg;
            };

            const extension = require('../../../src/extension');

            let registeredCallback;
            const originalRegisterCommand = vscodeMock.commands.registerCommand;
            vscodeMock.commands.registerCommand = (cmd, cb) => {
                if (cmd === 'extension.configureManualsDir') {
                    registeredCallback = cb;
                }
                return { dispose() {} };
            };

            const context = { subscriptions: [] };
            extension.activate(context);

            if (registeredCallback) {
                await registeredCallback();
            }

            assert.ok(errorMsg.includes('Permission Denied'));

            vscodeMock.window.showOpenDialog = originalShowOpenDialog;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.window.showErrorMessage = originalShowErrorMessage;
            vscodeMock.commands.registerCommand = originalRegisterCommand;
        });
    });
```

- [ ] **步骤 2：运行单元测试，验证所有 213 项测试都顺利通过**

运行：`npm test`
预期：PASS (213 passing)

- [ ] **步骤 3：Commit**

```bash
git add test/client/providers/phase7_features.test.js
git commit -m "test(extension): add unit tests for global configureManualsDir command"
```
