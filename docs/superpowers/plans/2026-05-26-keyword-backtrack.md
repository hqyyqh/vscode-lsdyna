# 关键字匹配帮助文档逐级回退逻辑 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 LS-DYNA 手册索引器中增加关键字的逐级回退查找逻辑，且当配置了手册但未匹配到书签时完全隐藏悬浮窗底部的帮助文档栏。

**架构：** 在 `manualIndexer.js` 的 `getManualLocations` 方法中，如果精确的关键字没有匹配，则通过下划线 `_` 逐级向前截断进行回退查找；在 `extension.js` 的 `appendManualLinks` 中，若已配置手册路径但匹配列表为空，则不向 Markdown 实例追加任何分割线或齿轮链接。

**技术栈：** VS Code Extension API, JavaScript, Node.js

---

### 任务 1：支持关键字回退匹配

**文件：**
- 修改：`src/core/manualIndexer.js`
- 测试：`test/core/manualIndexer.test.js`

- [ ] **步骤 1：编写失败的测试**
  在 `test/core/manualIndexer.test.js` 的 `describe('initialize & getManualLocations', ...)` 中添加以下测试：
  ```javascript
        it('backtracks keywords by dropping suffix tokens', () => {
            const nodeLocs = getManualLocations('*NODE');
            const backtrackedLocs = getManualLocations('*NODE_SUB_KW');
            assert.deepEqual(backtrackedLocs, nodeLocs);
            assert.ok(backtrackedLocs.length > 0);
        });
  ```

- [ ] **步骤 2：运行测试验证失败**
  运行：`npm test`
  预期：测试运行并失败，抛出错误：`AssertionError [ERR_ASSERTION]: Expected deep equality: [] deepEqual [ { file: '...', page: 1 } ]`

- [ ] **步骤 3：编写最少实现代码**
  修改 `src/core/manualIndexer.js` 中的 `getManualLocations`：
  ```javascript
  function getManualLocations(kwName) {
      const cleaned = cleanKeyword(kwName);
      let locs = keywordMap.get(cleaned);
      if (locs && locs.length > 0) {
          return locs;
      }
      
      const tokens = cleaned.split('_');
      for (let i = tokens.length - 1; i >= 1; i--) {
          const candidate = tokens.slice(0, i).join('_');
          locs = keywordMap.get(candidate);
          if (locs && locs.length > 0) {
              return locs;
          }
      }
      return [];
  }
  ```

- [ ] **步骤 4：运行测试验证通过**
  运行：`npm test`
  预期：PASS

- [ ] **步骤 5：Commit**
  ```bash
  git add src/core/manualIndexer.js test/core/manualIndexer.test.js
  git commit -m "feat: implement keyword backtrack matching for PDF manuals"
  ```

---

### 任务 2：隐藏没有匹配手册时的底部帮助文档栏

**文件：**
- 修改：`src/extension.js`
- 测试：`test/extension.test.js`

- [ ] **步骤 1：编写失败的测试**
  在 `test/extension.test.js` 的 `describe('LsdynaFieldHoverProvider', ...)` 中添加以下测试：
  ```javascript
      it('hides bottom manual section when manualsDir is configured but no manuals found for recognized keyword', () => {
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
              const doc = fakeDoc('*CONTROL_TERMINATION\n');
              const hover = provider.provideHover(doc, { line: 0, character: 3 });
              assert.ok(hover);
              assert.ok(!hover.contents[0].value.includes('command:extension.openManual'));
              assert.ok(!hover.contents[0].value.includes('command:extension.configureManualsDir'));
          } finally {
              workspace.getConfiguration = originalGetConfiguration;
              manualIndexer.getManualFilesCount = originalGetManualFilesCount;
              manualIndexer.getManualLocations = originalGetManualLocations;
          }
      });
  ```

- [ ] **步骤 2：运行测试验证失败**
  运行：`npm test`
  预期：测试失败，因为仍然追加了 `\n\n[$(settings-gear)](command:extension.configureManualsDir "修改手册路径")` 导致断言错误。

- [ ] **步骤 3：编写最少实现代码**
  修改 `src/extension.js` 中的 `appendManualLinks` 函数：
  ```javascript
  function appendManualLinks(md, kwName) {
      const cleanKw = manualIndexer.cleanKeyword(kwName);
      const manuals = manualIndexer.getManualLocations(cleanKw);
      const manualsDir = vscode.workspace.getConfiguration('lsdyna').get('manualsDir');
      const fileCount = manualIndexer.getManualFilesCount();

      const notConfigured = !manualsDir || fileCount === 0;

      if (notConfigured) {
          md.appendMarkdown('\n\n---');
          md.appendMarkdown('\n\n未设置手册路径。配置后可在悬停时快速阅读 PDF 原文书签页。');
          md.appendMarkdown('\n\n[⚙️ 设置手册文件夹 (Configure Folder)](command:extension.configureManualsDir)');
      } else if (manuals.length > 0) {
          md.appendMarkdown('\n\n---');
          const links = [];
          for (const man of manuals) {
              const volName = path.basename(man.file, '.pdf');
              const openArgs = encodeURIComponent(JSON.stringify([man.file, man.page]));
              links.push(`[$(book) ${volName} (第 ${man.page} 页)](command:extension.openManual?${openArgs})`);
          }
          md.appendMarkdown(`\n\n[$(settings-gear)](command:extension.configureManualsDir "修改手册路径") &nbsp;&nbsp; ${links.join(' &nbsp;&nbsp; ')}`);
      }
  }
  ```

- [ ] **步骤 4：运行测试验证通过**
  运行：`npm test`
  预期：PASS

- [ ] **步骤 5：Commit**
  ```bash
  git add src/extension.js test/extension.test.js
  git commit -m "feat: hide bottom manuals bar when manualsDir is configured but no manuals match"
  ```
