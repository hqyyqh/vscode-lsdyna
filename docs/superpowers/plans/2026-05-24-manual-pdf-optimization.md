# LS-DYNA PDF Manual Search & SumatraPDF Path Optimization Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化帮助手册和 SumatraPDF 调用逻辑，支持用户选择本地手册目录，自动监听目录变化重构缓存，并在 Hover 卡片中提供美观的配置/修改指引。

**架构：**
1. 在 `package.json` 中移除 `lsdyna.sumatrapdfPath`，修改 `lsdyna.manualsDir` 的默认值，并注册配置命令。
2. 在 `src/extension.js` 中实现配置命令并在 Windows 上进行 `SumatraPDF.exe` 检测及警告。
3. 重构 `resolveSumatraPath` 严格从配置的手册目录获取路径。
4. 重构 `appendManualLinks` 及 Hover 提供器逻辑，渲染现代化的 Hover 卡片。
5. 在 `src/core/manualIndexer.js` 中引入 `fs.watch` 监听器实现自动防抖重索引。
6. 更新 `README.md` 和 `README_zh.md` 配置文档说明。

**技术栈：** VS Code Extension API, Node.js (fs, path), Markdown

---

### 任务 1：修改 package.json 配置与指令

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：修改 metadata**
  编辑 `package.json`，在 `contributes.commands` 列表中注册 `extension.configureManualsDir` 命令：
  ```json
              {
                  "command": "extension.configureManualsDir",
                  "title": "Configure LS-DYNA Manuals Directory",
                  "category": "LS-DYNA"
              }
  ```
  在 `contributes.configuration.properties` 中：
  - 将 `lsdyna.manualsDir.default` 改为 `""`，更新其 `description`。
  - 删除 `lsdyna.sumatrapdfPath` 属性。

- [ ] **步骤 2：验证 package.json 语法**
  运行：`node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))"`
  预期：运行无报错。

- [ ] **步骤 3：Commit**
  运行：
  ```powershell
  git add package.json
  git commit -m "chore: register manuals config command and deprecate separate sumatrapdf path in package.json"
  ```

---

### 任务 2：实现手册目录选择命令与 SumatraPDF 路径解析

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：实现并注册 `extension.configureManualsDir` 命令**
  在 `activate(context)` 中实现 `extension.configureManualsDir` 命令：
  ```javascript
      context.subscriptions.push(
          vscode.commands.registerCommand('extension.configureManualsDir', async () => {
              const folders = await vscode.window.showOpenDialog({
                  canSelectFolders: true,
                  canSelectFiles: false,
                  canSelectMany: false,
                  openLabel: '选择手册文件夹 (Select Manuals Folder)'
              });
              if (folders && folders[0]) {
                  const selectedPath = folders[0].fsPath;
                  const config = vscode.workspace.getConfiguration('lsdyna');
                  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                  await config.update('manualsDir', selectedPath, target);

                  vscode.window.showInformationMessage(`LS-DYNA 手册目录已设置为: ${selectedPath}`);

                  if (process.platform === 'win32') {
                      const fs = require('fs');
                      const path = require('path');
                      const sumatraPath = path.join(selectedPath, 'SumatraPDF.exe');
                      if (!fs.existsSync(sumatraPath)) {
                          vscode.window.showWarningMessage('未在所选手册文件夹中找到 SumatraPDF.exe。在 Windows 系统上，请将 SumatraPDF.exe 复制到该目录下以启用精确页码跳转。');
                      }
                  }
                  await manualIndexer.initialize(context);
              }
          })
      );
  ```

- [ ] **步骤 2：重构 `resolveSumatraPath` 路径解析**
  修改 `resolveSumatraPath` 函数，移除原先对注册表、环境变量 PATH 和常用安装路径的搜索逻辑。严格检查 `lsdyna.manualsDir` 绝对或相对路径下是否存在 `SumatraPDF.exe`。
  ```javascript
  async function resolveSumatraPath(context) {
      const fs = require('fs');
      const path = require('path');
      const manualsDir = vscode.workspace.getConfiguration('lsdyna').get('manualsDir');
      if (manualsDir && typeof manualsDir === 'string') {
          let resolvedDir = manualsDir;
          if (!path.isAbsolute(manualsDir)) {
              const workspaceFolders = vscode.workspace.workspaceFolders;
              if (workspaceFolders && workspaceFolders.length > 0) {
                  resolvedDir = path.resolve(workspaceFolders[0].uri.fsPath, manualsDir);
              } else {
                  resolvedDir = path.resolve(process.cwd(), manualsDir);
              }
          }
          const sumatraPath = path.join(resolvedDir, 'SumatraPDF.exe');
          if (fs.existsSync(sumatraPath)) {
              return sumatraPath;
          }
      }
      return null;
  }
  ```

- [ ] **步骤 3：验证与测试**
  运行：`npm test` 并检查 `src/extension.js` 的编译正确性。

- [ ] **步骤 4：Commit**
  运行：
  ```powershell
  git add src/extension.js
  git commit -m "feat: implement configureManualsDir command and restrict SumatraPDF resolution"
  ```

---

### 任务 3：重构 Hover 渲染逻辑及增加触发路径

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：重构 `appendManualLinks` 布局**
  编辑 `src/extension.js` 中的 `appendManualLinks(md, kwName)`，按如下逻辑进行美化排布：
  ```javascript
  function appendManualLinks(md, kwName) {
      const cleanKw = manualIndexer.cleanKeyword(kwName);
      const manuals = manualIndexer.getManualLocations(cleanKw);
      const manualsDir = vscode.workspace.getConfiguration('lsdyna').get('manualsDir');
      const fileCount = manualIndexer.getManualFilesCount();

      md.appendMarkdown('\n\n---');

      if (!manualsDir || fileCount === 0) {
          md.appendMarkdown('\n\n#### 📚 帮助文档 (Manuals)\n\n未设置手册路径。配置后可在悬停时快速阅读 PDF 原文书签页。');
          md.appendMarkdown('\n\n[⚙️ 设置手册文件夹 (Configure Folder)](command:extension.configureManualsDir)');
      } else if (manuals.length > 0) {
          md.appendMarkdown('\n\n#### 📚 帮助文档 (Manuals)');
          for (const man of manuals) {
              const volName = path.basename(man.file, '.pdf');
              const openArgs = encodeURIComponent(JSON.stringify([man.file, man.page]));
              md.appendMarkdown(`\n\n* [$(book) 打开手册 - ${volName} (第 ${man.page} 页)](command:extension.openManual?${openArgs})`);
          }
          md.appendMarkdown('\n\n---');
          md.appendMarkdown('\n\n[$(edit) 修改手册路径 (Change Path)](command:extension.configureManualsDir)');
      } else {
          md.appendMarkdown('\n\n[$(edit) 修改手册路径 (Change Path)](command:extension.configureManualsDir)');
      }
  }
  ```

- [ ] **步骤 2：调整 `provideHover` 对关键字行的拦截条件**
  编辑 `LsdynaFieldHoverProvider.provideHover` 方法中对 `trimmed.startsWith('*')` 块的拦截逻辑，支持在未配置手册或没有卡片字段但有手册匹配时展示 Hover：
  ```javascript
          // Hover on keyword lines
          if (trimmed.startsWith('*')) {
              const kwName = trimmed.slice(1).toUpperCase().split(/[\s,$]/)[0];
              if (!kwName) return null;
              const entry = lookupKeyword(kwName);
              if (!entry) {
                  const cleanKw = manualIndexer.cleanKeyword(kwName);
                  const manuals = manualIndexer.getManualLocations(cleanKw);
                  const manualsDir = vscode.workspace.getConfiguration('lsdyna').get('manualsDir');
                  const fileCount = manualIndexer.getManualFilesCount();
                  const hasManuals = manuals.length > 0;
                  const notConfigured = !manualsDir || fileCount === 0;

                  if (hasManuals || notConfigured) {
                      const md = new vscode.MarkdownString(`**\\*${kwName}**`);
                      md.isTrusted = true;
                      md.supportThemeIcons = true;
                      appendManualLinks(md, kwName);
                      return new vscode.Hover(md);
                  }
                  return null;
              }
              const md = new vscode.MarkdownString(keywordHoverMarkdown(kwName, entry));
              md.isTrusted = true;
              md.supportThemeIcons = true;
              appendManualLinks(md, kwName);
              return new vscode.Hover(md);
          }
  ```

- [ ] **步骤 3：验证与 Commit**
  检查修改无格式错误。
  运行：
  ```powershell
  git add src/extension.js
  git commit -m "feat: redesign hover manuals card and enable configuration prompt on any keyword"
  ```

---

### 任务 4：自动监听手册文件夹重构缓存

**文件：**
- 修改：`src/core/manualIndexer.js`

- [ ] **步骤 1：引入 module-level 变量并导出 `getManualFilesCount`**
  编辑 `src/core/manualIndexer.js`：
  - 声明 module 级别的变量 `let pdfFilesList = [];`、`let dirWatcher = null;` 和 `let refreshTimeout = null;`。
  - 增加并导出 `getManualFilesCount` 方法：
    ```javascript
    function getManualFilesCount() {
        return pdfFilesList.length;
    }
    ```
    并将其添加到 `module.exports`。

- [ ] **步骤 2：在 `initialize` 中添加 `fs.watch` 自动监视目录变化**
  在 `initialize(context)` 函数的起始位置关闭已有监视器：
  ```javascript
      if (dirWatcher) {
          try { dirWatcher.close(); } catch {}
          dirWatcher = null;
      }
  ```
  在成功解析并遍历出 `uniqueDirs` 后，为每个目录注册 `fs.watch`。如果发生 `.pdf` 文件更新或重命名，对 `initialize(context)` 进行 1 秒防抖重新调用：
  ```javascript
          for (const dir of uniqueDirs) {
              log(`Scanning directory: "${dir}"`);

              // 自动注册文件监听器
              try {
                  dirWatcher = fs.watch(dir, (eventType, filename) => {
                      if (filename && filename.toLowerCase().endsWith('.pdf')) {
                          log(`Manual PDF directory changed (${eventType} on ${filename}). Re-initializing indexer...`);
                          if (refreshTimeout) clearTimeout(refreshTimeout);
                          refreshTimeout = setTimeout(() => {
                              initialize(context).catch(err => log(`Failed to auto-refresh manuals: ${err.message}`));
                          }, 1000);
                      }
                  });
              } catch (watchErr) {
                  log(`Failed to watch directory "${dir}": ${watchErr.message}`);
              }
              // ...
          }
  ```
  并在 `initialize` 结束前，将 `pdfFilesList` 指向成功扫描的 `pdfFiles` 结果：
  ```javascript
          pdfFilesList = pdfFiles;
  ```

- [ ] **步骤 3：验证监听器功能并 Commit**
  确保 `npm test` 单元测试不受影响。
  运行：
  ```powershell
  git add src/core/manualIndexer.js
  git commit -m "feat: add manuals folder active watcher with debounce to re-index automatically"
  ```

---

### 任务 5：更新文档与配置说明

**文件：**
- 修改：`README.md`
- 修改：`README_zh.md`

- [ ] **步骤 1：更新 `README.md` 中的设置说明表**
  在 `README.md` 的 Settings 列表中删除 `lsdyna.sumatrapdfPath` 这一行，并更新 `lsdyna.manualsDir` 的描述，强调 `SumatraPDF.exe` 需复制到此目录下。

- [ ] **步骤 2：更新 `README_zh.md` 中的设置说明表**
  在 `README_zh.md` 对应的配置列表中进行中译同步删除和更新。

- [ ] **步骤 3：Commit**
  运行：
  ```powershell
  git add README.md README_zh.md
  git commit -m "docs: update manuals folder and sumatrapdf configuration instruction in READMEs"
  ```
