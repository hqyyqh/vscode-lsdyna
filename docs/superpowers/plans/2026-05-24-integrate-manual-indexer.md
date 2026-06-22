# 集成 manualIndexer 并注册 openManual 命令实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 VS Code 插件中集成 `manualIndexer`，注册 `extension.openManual` 命令并支持在不同操作系统和配置下以指定方式打开 LS-DYNA PDF 手册且能精确跳转至对应页码。

**架构：**
1. 在插件启动时，在后台异步调用 `manualIndexer.initialize(context)`。
2. 注册 `extension.openManual` 命令，根据 `lsdyna.manualViewer` 的设置决定打开 PDF 方式。
3. 当选择系统（system）打开且为 Windows 时，构造以 `file:///` 开头的 URL 并带上页码锚点 `#page=X`，使用 `child_process.exec` 的 `cmd.exe /c start` 调用打开，若失败则降级到 `vscode.env.openExternal`。在非 Windows 或配置为 `"vscode"` 时，直接通过 VS Code 相关 API 打开。
4. 修改 `package.json` 中的命令属性和 activationEvents。

**技术栈：** VS Code Extension API, Node.js (fs, child_process, process, path), Mocha (tests)

---

### 任务 1：修改 package.json 配置与命令声明

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：更新 `activationEvents` 和 `contributes.commands`**

修改 `package.json` 中的 `activationEvents` 列表，加入 `"onCommand:extension.openManual"`。
并在 `contributes.commands` 中为 `extension.openManual` 增加 `"category": "LS-DYNA"`。

修改后的 `package.json` 部分片段：
```json
    "activationEvents": [
        "onLanguage:lsdyna",
        "onLanguage:lsprepost-command-file",
        "onCommand:extension.openManual"
    ],
```
以及：
```json
            {
                "command": "extension.openManual",
                "title": "Open LS-DYNA Keyword Manual",
                "category": "LS-DYNA"
            }
```

- [ ] **步骤 2：验证 package.json 格式**
运行 npm test 或使用 JSON 验证器确保 `package.json` 格式正确无误。

---

### 任务 2：在 extension.js 中引入并初始化 manualIndexer

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：引入依赖**
在 `src/extension.js` 头部引入 `manualIndexer` 模块及 `child_process`：
```javascript
const child_process = require('child_process');
const manualIndexer = require('./core/manualIndexer');
```

- [ ] **步骤 2：在 `activate` 中异步初始化**
在 `activate(context)` 开头调用：
```javascript
    manualIndexer.initialize(context).catch(err => {
        logDebug(`Failed to initialize manual indexer: ${err.message}`);
    });
```

---

### 任务 3：实现并注册 openManual 命令

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：在 `activate(context)` 中注册 `extension.openManual` 命令**

具体实现逻辑如下：
```javascript
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openManual', (pdfPath, pageNum) => {
            const config = vscode.workspace.getConfiguration('lsdyna');
            const viewer = config.get('manualViewer') || 'system';

            if (viewer === 'vscode') {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdfPath));
            } else {
                // system (default)
                if (process.platform === 'win32') {
                    let fileUrl = `file:///${pdfPath.replace(/\\/g, '/')}`;
                    if (pageNum) {
                        fileUrl += `#page=${pageNum}`;
                    }
                    try {
                        child_process.exec(`cmd.exe /c start "" "${fileUrl}"`, (error) => {
                            if (error) {
                                vscode.env.openExternal(vscode.Uri.file(pdfPath));
                            }
                        });
                    } catch (e) {
                        vscode.env.openExternal(vscode.Uri.file(pdfPath));
                    }
                } else {
                    vscode.env.openExternal(vscode.Uri.file(pdfPath));
                }
            }
        })
    );
```

---

### 任务 4：编写测试并验证

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：在 `test/extension.test.js` 中添加对 `extension.openManual` 的单元测试**

在 `test/extension.test.js` 底部添加 `describe('extension.openManual', ...)` 测试集，验证：
1. 注册的命令成功执行。
2. 配置为 vscode 时，调用了 `vscode.commands.executeCommand`。
3. 配置为 system 且在 Windows (win32) 下时，成功拼接 file url 并使用 child_process.exec 调用。
4. 在命令执行出错或非 Windows 时降级/直接使用 `vscode.env.openExternal`。

测试代码范例：
```javascript
describe('extension.openManual', () => {
    let originalPlatform;
    let execCalls = [];
    let executeCommandCalls = [];
    let openExternalCalls = [];
    let originalExec;
    let originalExecuteCommand;
    let originalOpenExternal;
    let originalGetConfiguration;

    before(() => {
        originalPlatform = process.platform;
        originalExec = child_process.exec;
        originalExecuteCommand = vscodeMock.commands.executeCommand;
        originalOpenExternal = vscodeMock.env ? vscodeMock.env.openExternal : undefined;

        // Mock env and openExternal if not exists
        if (!vscodeMock.env) {
            vscodeMock.env = {};
        }
        vscodeMock.env.openExternal = (uri) => {
            openExternalCalls.push(uri);
            return Promise.resolve(true);
        };
    });

    after(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        child_process.exec = originalExec;
        vscodeMock.commands.executeCommand = originalExecuteCommand;
        if (originalOpenExternal) {
            vscodeMock.env.openExternal = originalOpenExternal;
        } else {
            delete vscodeMock.env.openExternal;
        }
    });

    beforeEach(() => {
        execCalls = [];
        executeCommandCalls = [];
        openExternalCalls = [];
        child_process.exec = (cmd, cb) => {
            execCalls.push(cmd);
            cb(null);
        };
        vscodeMock.commands.executeCommand = (cmd, ...args) => {
            executeCommandCalls.push({ cmd, args });
            return Promise.resolve();
        };
    });

    it('uses vscode.open when viewer is vscode', () => {
        // mock configuration
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key) => key === 'manualViewer' ? 'vscode' : undefined
        });

        const testPath = 'D:\\manuals\\lsdyna.pdf';
        // Run command handler manually if possible, or trigger it via the registered command
        // We will call the registered handler directly or mock registerCommand to capture the callback.
    });
});
```

- [ ] **步骤 2：运行 `npm test` 并确认所有测试（包括新写的测试）均通过**

- [ ] **步骤 3：提交修改**
使用 git commit，提交信息设为 `feat: integrate manualIndexer and register openManual command`。
