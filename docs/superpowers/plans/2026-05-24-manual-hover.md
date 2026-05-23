# LS-DYNA Keyword Manual Hover and Opener Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 LS-DYNA PDF 书签索引，在 Hover 窗口底部增加对应的 PDF 链接，并在点击链接时实现精确到页码的 PDF 打开功能。

**架构：**
- 新建 `src/core/manualIndexer.js` 用于在插件激活时，后台异步提取 PDF 书签并配合 `workspaceState` 缓存。
- 修改 `src/extension.js` 中的 `LsdynaFieldHoverProvider` 在关键字/字段 Hover 时动态查询索引，生成命令链接并附加在悬浮内容最底部。
- 注册 VS Code `extension.openManual` 命令执行对应的 PDF 打开逻辑。
- 在 `package.json` 中定义配置选项。

**技术栈：** Node.js filesystem APIs, VS Code extension APIs

---

### 任务 1：在 package.json 中配置选项并注册命令

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：添加配置选项与命令声明**
在 `package.json` 中注册 `extension.openManual` 并在 `contributes.configuration` 下声明 `lsdyna.manualsDir` 和 `lsdyna.manualViewer`。

代码变更如下：
在 `contributes.commands` 中：
```json
            {
                "command": "extension.openManual",
                "title": "Open LS-DYNA Keyword Manual"
            }
```
在 `contributes` 中新增：
```json
        "configuration": {
            "title": "LS-DYNA",
            "properties": {
                "lsdyna.manualsDir": {
                    "type": "string",
                    "default": "LS-DYNA Manuals",
                    "description": "Path to the directory containing LS-DYNA PDF manuals (can be workspace-relative or absolute)."
                },
                "lsdyna.manualViewer": {
                    "type": "string",
                    "default": "system",
                    "enum": [
                        "system",
                        "vscode"
                    ],
                    "enumDescriptions": [
                        "Open using system default PDF viewer (supports page parameter on Windows)",
                        "Open using VS Code built-in PDF viewer"
                    ],
                    "description": "The PDF viewer to use when opening LS-DYNA manuals."
                }
            }
        }
```

---

### 任务 2：实现 PDF 书签索引器

**文件：**
- 创建：`src/core/manualIndexer.js`

- [ ] **步骤 1：创建并实现 manualIndexer.js 的全部索引逻辑**
编写 `src/core/manualIndexer.js`，包含高效提取 PDF `/Catalog` 与 `/Pages` 树，清洗书签关键字并建立 `Map` 的功能，并整合 `context.workspaceState` 进行缓存管理。

完整代码实现展示在实际创建中。

---

### 任务 3：集成到 extension.js 并实现打开命令

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：集成索引初始化与注册 openManual 命令**
在 `src/extension.js` 的 `activate` 函数中：
- 引入并调用 `manualIndexer.initialize(context)` 进行后台异步扫描。
- 注册 `extension.openManual` 命令：根据配置选择 VS Code 内置 `vscode.open` 还是 Windows 系统默认命令行方式跳转到指定页码。

---

### 任务 4：在 Hover 窗口中添加 PDF 手册链接

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：在关键字 Hover 和字段 Hover 底部添加手册链接**
修改 `LsdynaFieldHoverProvider.provideHover`，在关键字 hover（`trimmed.startsWith('*')`）和普通字段 hover 时，若索引器中存在对应的手册页码，在悬浮内容的末尾添加 `\n\n---\n`，并附上手册跳转链接。

---

### 任务 5：验证并编写测试

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：编写索引与 Hover 测试用例并运行**
在 `test/extension.test.js` 中添加针对 `manualIndexer` 的单元测试。运行整个测试集 `npm test` 以验证一切正常。
