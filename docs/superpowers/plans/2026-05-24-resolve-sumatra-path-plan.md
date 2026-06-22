# resolveSumatraPath 探测引擎 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `src/extension.js` 中实现 `resolveSumatraPath` 探测引擎，非阻塞异步探测 Windows 上的 `SumatraPDF.exe`。

**架构：** 在 `src/extension.js` 中新增 `resolveSumatraPath(context)` 异步函数，内部按照以下优先级探测路径：
1. `lsdyna.sumatrapdfPath` 环境变量展开后的路径（正则：`/%([^%]+)%/g`）
2. 捆绑的二进制路径（`bin/SumatraPDF.exe`）
3. 注册表 App Paths 项（利用 `child_process.exec` 和 Promise 异步查询）
4. 环境变量 `PATH` 下的目录
5. 常见的启发式安装路径（Program Files, AppData）

**技术栈：** Node.js `fs`, `path`, `child_process`, VS Code Extension API.

---

### 任务 1：在 src/extension.js 中实现 resolveSumatraPath 并运行 Mocha 语法检查

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：在 src/extension.js 中添加 resolveSumatraPath(context) 异步函数**

  在 `src/extension.js` 中添加以下代码（位于 `openManualFallback` 附近）：

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

- [ ] **步骤 2：运行 Mocha 单元测试进行语法与基础功能检查**

  运行：`npx mocha test --recursive --timeout 10000`
  预期：测试应成功运行（可能存在之前失败的无关测试，但确保本修改没有使整个 extension.js 抛出语法错误或无法 require）。

- [ ] **步骤 3：Commit 改动**

  运行：
  ```bash
  git add src/extension.js
  git commit -m "feat: implement resolveSumatraPath detection helper"
  ```
