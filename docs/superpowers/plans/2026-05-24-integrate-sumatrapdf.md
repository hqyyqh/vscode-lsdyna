# SumatraPDF Integration Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Windows 平台将内置的 SumatraPDF.exe 集成打包入 VS Code 插件中，提供开箱即用的高效率 PDF 手册查看器，并移除所有旧有的 pdf.js Webview 和 Viewer 选项，对非 Windows 平台则优雅回退至系统默认打开方式。

**架构：** 在插件目录下添加 `bin/SumatraPDF.exe`。在 `src/extension.js` 中新增级联探测引擎 `resolveSumatraPath`，按优先级（自定义配置 -> 内置打包 -> 注册表 -> PATH -> 启发式常见路径）探测 SumatraPDF.exe 的路径。如果处于 Windows 平台，探测成功则使用 `spawn`（配以防空格截断与脱离父进程等参数）拉起后台进程；探测失败则执行 `openManualFallback` 启动命令。在非 Windows 平台，直接调用 `vscode.env.openExternal`。

**技术栈：** Node.js `child_process` (spawn, exec), VS Code Extension API.

---

### 任务 1：放置 SumatraPDF.exe 二进制文件

**文件：**
- 创建：`bin/SumatraPDF.exe` (由宿主系统 `C:\Users\qyang\Downloads\SumatraPDF.exe` 复制过来)
- 修改：`.gitignore` 和 `.vscodeignore` 以处理构建集成。

- [ ] **步骤 1：创建 bin 文件夹并复制 SumatraPDF.exe**
  在 Windows 命令行下运行复制命令，将 `C:\Users\qyang\Downloads\SumatraPDF.exe` 复制到项目根目录下的 `bin/SumatraPDF.exe`。

- [ ] **步骤 2：更新 gitignore 与 vscodeignore**
  修改 `.gitignore` 确保不忽略 `bin/` 中的可执行程序。
  修改 `.vscodeignore` 确保发布时将 `bin/SumatraPDF.exe` 打包进扩展，除非显式指定目标平台。

- [ ] **步骤 3：验证二进制文件存在**
  运行：`Test-Path bin/SumatraPDF.exe` (PowerShell)
  预期：返回 `True`。

- [ ] **步骤 4：Commit**
  ```bash
  git add bin/SumatraPDF.exe .gitignore .vscodeignore
  git commit -m "feat: add bundled SumatraPDF binary and config files"
  ```

---

### 任务 2：更新 `package.json` 配置声明

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：更新配置定义**
  删除 `"lsdyna.manualViewer"` 配置定义。
  添加 `"lsdyna.sumatrapdfPath"` 配置：
  ```json
  "lsdyna.sumatrapdfPath": {
      "type": "string",
      "default": "",
      "description": "Custom path to SumatraPDF.exe on Windows. If left blank, the extension will use the bundled version or automatically detect it from the system."
  }
  ```

- [ ] **步骤 2：验证 package.json 结构**
  运行 `npm run test` 或者简单的 lint/验证确保 json 文件语法正确。

- [ ] **步骤 3：Commit**
  ```bash
  git add package.json
  git commit -m "config: remove manualViewer and add sumatrapdfPath configuration"
  ```

---

### 任务 3：在 `src/extension.js` 中实现 `resolveSumatraPath` 探测引擎

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：实现 `resolveSumatraPath(context)` 异步函数**
  在 `src/extension.js` 中添加以下实现：
  ```javascript
  async function resolveSumatraPath(context) {
      const fs = require('fs');
      const path = require('path');
      const child_process = require('child_process');

      // 1. User configured path
      const configPath = vscode.workspace.getConfiguration('lsdyna').get('sumatrapdfPath');
      if (configPath && typeof configPath === 'string') {
          const expanded = configPath.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
          if (fs.existsSync(expanded)) {
              return expanded;
          }
      }

      // 2. Bundled binary path
      const bundledPath = context.asAbsolutePath(path.join('bin', 'SumatraPDF.exe'));
      if (fs.existsSync(bundledPath)) {
          return bundledPath;
      }

      // Helper to execute reg query asynchronously
      const queryReg = (key) => {
          return new Promise((resolve) => {
              child_process.exec(`reg query "${key}" /ve`, (error, stdout) => {
                  if (error || !stdout) return resolve(null);
                  const lines = stdout.split('\r\n');
                  for (const line of lines) {
                      if (line.includes('REG_SZ')) {
                          const idx = line.indexOf('REG_SZ');
                          let val = line.substring(idx + 6).trim();
                          if (val.startsWith('"') && val.endsWith('"')) {
                              val = val.substring(1, val.length - 1);
                          }
                          resolve(val);
                          return;
                      }
                  }
                  resolve(null);
              });
          });
      };

      // 3. Registry App Paths
      const regKeys = [
          'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\SumatraPDF.exe',
          'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\SumatraPDF.exe'
      ];
      for (const key of regKeys) {
          const regPath = await queryReg(key);
          if (regPath && fs.existsSync(regPath)) {
              return regPath;
          }
      }

      // 4. PATH Environment
      if (process.env.PATH) {
          const paths = process.env.PATH.split(path.delimiter);
          for (const p of paths) {
              const fullPath = path.join(p, 'SumatraPDF.exe');
              if (fs.existsSync(fullPath)) {
                  return fullPath;
              }
          }
      }

      // 5. Common Heuristic Paths
      const localAppData = process.env.LOCALAPPDATA || '';
      const appData = process.env.APPDATA || '';
      const commonPaths = [
          'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
          'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
          path.join(localAppData, 'SumatraPDF', 'SumatraPDF.exe'),
          path.join(appData, 'SumatraPDF', 'SumatraPDF.exe')
      ];
      for (const cp of commonPaths) {
          if (cp && fs.existsSync(cp)) {
              return cp;
          }
      }

      return null;
  }
  ```

- [ ] **步骤 2：运行基础 Mocha 测试进行语法检查**
  运行：`npx mocha test --recursive --timeout 10000` (可能由于未连接而失败，但主要是检查是否有引入语法错误)

- [ ] **步骤 3：Commit**
  ```bash
  git add src/extension.js
  git commit -m "feat: implement resolveSumatraPath detection helper"
  ```

---

### 任务 4：更新 `extension.openManual` 命令实现

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：更新 `extension.openManual` 逻辑**
  修改 `extension.openManual` 命令：
  ```javascript
          vscode.commands.registerCommand('extension.openManual', async (pdfPath, pageNum) => {
              if (!pdfPath) return;
              if (typeof pdfPath !== 'string') return;
              if (pdfPath.includes('"') || pdfPath.includes('&') || pdfPath.includes('|') || pdfPath.includes(';')) {
                  vscode.env.openExternal(vscode.Uri.file(pdfPath));
                  return;
              }

              if (process.platform === 'win32') {
                  try {
                      const exePath = await resolveSumatraPath(context);
                      if (exePath) {
                          const args = ['-reuse-instance'];
                          if (pageNum) {
                              args.push('-page', String(pageNum));
                          }
                          // Quoting the path manually because of windowsVerbatimArguments: true
                          args.push(`"${pdfPath}"`);

                          const child = child_process.spawn(exePath, args, {
                              detached: true,
                              windowsVerbatimArguments: true,
                              windowsHide: true,
                              stdio: 'ignore'
                          });
                          child.on('error', () => {
                              openManualFallback(pdfPath, pageNum);
                          });
                          child.unref();
                      } else {
                          openManualFallback(pdfPath, pageNum);
                      }
                  } catch (e) {
                      openManualFallback(pdfPath, pageNum);
                  }
              } else {
                  vscode.env.openExternal(vscode.Uri.file(pdfPath));
              }
          })
  ```
  并同时移除 `getWebviewContent`、`getDefaultPdfViewerOnWindows` 等不再使用的辅助函数（如果它们不用于其他地方）。

- [ ] **步骤 2：Commit**
  ```bash
  git add src/extension.js
  git commit -m "feat: update openManual command to use SumatraPDF and remove legacy viewer options"
  ```

---

### 任务 5：重构测试用例并最终验证

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：重构 `test/extension.test.js` 中的测试**
  清理已经删除的 webview 相关的 `describe` 和 `it` 用例。
  添加并重构与 SumatraPDF 以及 `spawn` 调用相关的测试。
  使用 mock `child_process.spawn` 和 `child_process.exec`。

- [ ] **步骤 2：执行全部单元测试**
  运行：`npx mocha test --recursive --timeout 10000`
  预期：全部测试用例 PASS。

- [ ] **步骤 3：Commit**
  ```bash
  git add test/extension.test.js
  git commit -m "test: refactor test suite for SumatraPDF integration"
  ```
