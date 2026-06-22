# 重构 Hover 渲染逻辑及增加触发路径 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 重构 Hover 卡片的 Markdown 文档排版，并在所有以 `*` 开头的关键字行上支持 Hover 触发，在未配置或配置后匹配到手册时引导用户或显示链接。

**架构：** 在 `src/extension.js` 中，重构 `appendManualLinks`，根据 manuals 匹配和 manualsDir 配置状态生成美化的 markdown；修改 `LsdynaFieldHoverProvider.provideHover` 中处理以 `*` 开头关键字行的拦截逻辑，使未配置手册或没有字段但有手册匹配时仍然返回 Hover。

**技术栈：** VS Code Extension API (MarkdownString, Hover, workspace.getConfiguration), Node.js (path).

---

### 任务 1：重构 `appendManualLinks`

**文件：**
- 修改：`src/extension.js` 中的 `appendManualLinks`

- [ ] **步骤 1：修改 `appendManualLinks` 结构**
  将 `src/extension.js` 中的 `appendManualLinks` 方法（第 479 - 490 行）替换为任务描述中指定的结构：
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

- [ ] **步骤 2：Commit**
  运行：
  ```powershell
  git add src/extension.js
  git commit -m "feat: refactor appendManualLinks to support beautiful manual links and configure prompt"
  ```

---

### 任务 2：调整 `provideHover` 对关键字行的拦截条件

**文件：**
- 修改：`src/extension.js` 中的 `LsdynaFieldHoverProvider.provideHover` 内处理关键字行逻辑（第 548 - 570 行）

- [ ] **步骤 1：修改 `provideHover` 关键字行拦截判断**
  在 `provideHover` 方法中，找到以 `*` 开头的分支：
  ```javascript
          // Hover on keyword lines
          if (trimmed.startsWith('*')) {
  ```
  将其替换为：
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

- [ ] **步骤 2：Commit**
  运行：
  ```powershell
  git add src/extension.js
  git commit -m "feat: redesign hover manuals card and enable configuration prompt on any keyword"
  ```

---

### 任务 3：更新与运行测试

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：添加单元测试**
  编辑 `test/extension.test.js` 中的 `LsdynaFieldHoverProvider` 套件。
  编写两个测试用例：
  1. 验证在未配置 `manualsDir` 且关键字未在 `field_data.json` 中时，能够显示配置提示 Hover。
  2. 验证在已配置 `manualsDir` 但未匹配到手册且未在 `field_data.json` 中时，返回 `null` 不显示 Hover。

  示例测试代码写入 `test/extension.test.js`：
  ```javascript
      it('displays configure prompt hover on unrecognized keyword when manualsDir is not configured', () => {
          const workspace = require('./vscode-mock').workspace;
          const originalGetConfiguration = workspace.getConfiguration;
          const manualIndexer = require('../src/core/manualIndexer');
          const originalGetManualFilesCount = manualIndexer.getManualFilesCount;

          workspace.getConfiguration = () => ({
              get: (key) => key === 'manualsDir' ? '' : undefined
          });
          manualIndexer.getManualFilesCount = () => 0;

          try {
              const provider = new LsdynaFieldHoverProvider();
              const doc = fakeDoc('*UNRECOGNIZED_KEYWORD\n');
              const hover = provider.provideHover(doc, { line: 0, character: 3 });
              assert.ok(hover);
              assert.ok(hover.contents[0].value.includes('未设置手册路径'));
              assert.ok(hover.contents[0].value.includes('command:extension.configureManualsDir'));
          } finally {
              workspace.getConfiguration = originalGetConfiguration;
              manualIndexer.getManualFilesCount = originalGetManualFilesCount;
          }
      });

      it('returns null on unrecognized keyword when manualsDir is configured but no manuals found', () => {
          const workspace = require('./vscode-mock').workspace;
          const originalGetConfiguration = workspace.getConfiguration;
          const manualIndexer = require('../src/core/manualIndexer');
          const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
          const originalGetManualLocations = manualIndexer.getManualLocations;

          workspace.getConfiguration = () => ({
              get: (key) => key === 'manualsDir' ? 'some/dir' : undefined
          });
          manualIndexer.getManualFilesCount = () => 1;
          manualIndexer.getManualLocations = () => [];

          try {
              const provider = new LsdynaFieldHoverProvider();
              const doc = fakeDoc('*UNRECOGNIZED_KEYWORD\n');
              const hover = provider.provideHover(doc, { line: 0, character: 3 });
              assert.strictEqual(hover, null);
          } finally {
              workspace.getConfiguration = originalGetConfiguration;
              manualIndexer.getManualFilesCount = originalGetManualFilesCount;
              manualIndexer.getManualLocations = originalGetManualLocations;
          }
      });
  ```

- [ ] **步骤 2：运行测试**
  运行命令：`npm run test`
  预期输出：所有测试用例（包括新增的 2 个）全部通过。

- [ ] **步骤 3：Commit**
  运行：
  ```powershell
  git add test/extension.test.js
  git commit -m "test: add test cases for unrecognized keyword hover in configured vs unconfigured manualsDir states"
  ```
