# LS-DYNA Include Hover Actions Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在用户 Hover 到有效的 `*INCLUDE` 文件路径时，显示自定义浮窗，提供：在新标签打开链接、分栏打开、以及打开文件所在路径（Windows Explorer 且选中文件）三个快捷功能，并配备 Codicon 图标指引。

**架构：** 在 `src/extension.js` 中注册三个基础包装命令（用以稳定地从 markdown link 中传参），并在 `LsdynaFieldHoverProvider` 中增加针对 include 字段的 hover 检查。如果 include 文件存在，则生成一个带有图标和 command 链接的 `vscode.Hover` 对象。

**技术栈：** VS Code API (vscode.Hover, vscode.MarkdownString, vscode.commands.registerCommand)

---

## 拟修改/创建文件

- 修改：[src/extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js) (命令注册，`LsdynaFieldHoverProvider` 逻辑更新)
- 修改：[test/extension.test.js](file:///d:/Project/vscode-lsdyna/test/extension.test.js) (新增单元测试，验证 Hover 结果与命令注册)
- 创建：[docs/superpowers/plans/2026-05-23-include-hover-actions.md](file:///d:/Project/vscode-lsdyna/docs/superpowers/plans/2026-05-23-include-hover-actions.md) (当前计划)

---

### 任务 1：注册包装命令

**文件：**
- 修改：[src/extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js:1030-1065)

- [ ] **步骤 1：在 `activate` 方法中添加三个新命令**
  
  ```javascript
      context.subscriptions.push(
          vscode.commands.registerCommand('extension.openIncludeNewTab', (filePath) => {
              try {
                  const uri = vscode.Uri.file(filePath);
                  vscode.commands.executeCommand('vscode.open', uri, { preview: false });
              } catch (err) {
                  vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
              }
          })
      );
      context.subscriptions.push(
          vscode.commands.registerCommand('extension.openIncludeSplit', (filePath) => {
              try {
                  const uri = vscode.Uri.file(filePath);
                  vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
              } catch (err) {
                  vscode.window.showErrorMessage(`Failed to split open file: ${err.message}`);
              }
          })
      );
      context.subscriptions.push(
          vscode.commands.registerCommand('extension.openIncludeFolder', (filePath) => {
              try {
                  const uri = vscode.Uri.file(filePath);
                  vscode.commands.executeCommand('revealFileInOS', uri);
              } catch (err) {
                  vscode.window.showErrorMessage(`Failed to reveal folder: ${err.message}`);
              }
          })
      );
  ```

- [ ] **步骤 2：测试命令注册逻辑 (暂时以单测形式)**
  通过修改 `test/extension.test.js` 确保能够存根 `vscode.commands.registerCommand` 并正常运作（详细在后续任务进行）。

---

### 任务 2：在 Hover 模块拦截并展示 Include 浮窗

**文件：**
- 修改：[src/extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js:478-500)

- [ ] **步骤 1：修改 `LsdynaFieldHoverProvider.provideHover`，在头部增加对 Include 文件的存在性校验与 Hover 生成**

  在 `provideHover(document, position)` 顶部，判断是否处于 Include 行内：
  ```javascript
          // Hover on include file paths
          const includeEntries = findIncludeFileLines(document);
          const includeEntry = includeEntries.find(entry => includeScanner.includeEntryContainsLine(entry, position.line));
          if (includeEntry) {
              const ranges = includeScanner.getIncludeEntryRanges(includeEntry);
              const rangeOnLine = ranges.find(r => r.lineIndex === position.line && position.character >= r.startChar && position.character <= r.endChar);
              if (rangeOnLine) {
                  try {
                      const searchPaths = getSearchPath(document);
                      const fullPath = searchFileFromPaths(includeEntry.fileName, searchPaths);
                      const uri = vscode.Uri.file(fullPath);
                      const hoverRange = new vscode.Range(rangeOnLine.lineIndex, rangeOnLine.startChar, rangeOnLine.lineIndex, rangeOnLine.endChar);
                      
                      const openNewTabArgs = encodeURIComponent(JSON.stringify([fullPath]));
                      const openSplitArgs = encodeURIComponent(JSON.stringify([fullPath]));
                      const openFolderArgs = encodeURIComponent(JSON.stringify([fullPath]));
                      
                      const md = new vscode.MarkdownString(
                          `### 📂 **Include File: ${includeEntry.fileName}**\n` +
                          `*File exists / 文件存在*\n\n` +
                          `---\n\n` +
                          `- [$(go-to-file) **在新标签打开链接**](command:extension.openIncludeNewTab?${openNewTabArgs})\n` +
                          `- [$(split-horizontal) **分栏打开**](command:extension.openIncludeSplit?${openSplitArgs})\n` +
                          `- [$(folder-opened) **打开文件所在路径**](command:extension.openIncludeFolder?${openFolderArgs})`
                      );
                      md.isTrusted = true;
                      return new vscode.Hover(md, hoverRange);
                  } catch (e) {
                      // File does not exist, fall through to default keyword/field hover behavior
                  }
              }
          }
  ```

---

### 任务 3：编写单元测试进行验证

**文件：**
- 修改：[test/extension.test.js](file:///d:/Project/vscode-lsdyna/test/extension.test.js:1395-1396)

- [ ] **步骤 1：编写针对 LsdynaFieldHoverProvider 的 include hover 测试用例**
  
  ```javascript
      it('returns custom hover actions for existing include files', () => {
          const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-test-'));
          const includeFile = path.join(tempRoot, 'sub.key');
          const mainFile = path.join(tempRoot, 'main.k');

          fs.writeFileSync(includeFile, '*KEYWORD\n');
          fs.writeFileSync(mainFile, '*INCLUDE\nsub.key\n');

          try {
              const doc = fakeDoc(fs.readFileSync(mainFile, 'utf8'), mainFile);
              doc.languageId = 'lsdyna';
              const provider = new LsdynaFieldHoverProvider();

              // Hovering over 'sub.key' on line 1, character 3
              const hover = provider.provideHover(doc, { line: 1, character: 3 });

              assert.ok(hover);
              assert.ok(hover.contents[0].value.includes('Include File: sub.key'));
              assert.ok(hover.contents[0].value.includes('extension.openIncludeNewTab'));
              assert.ok(hover.contents[0].value.includes('extension.openIncludeSplit'));
              assert.ok(hover.contents[0].value.includes('extension.openIncludeFolder'));
          } finally {
              fs.rmSync(tempRoot, { recursive: true, force: true });
          }
      });

      it('returns null (or falls through) for non-existent include files', () => {
          const doc = fakeDoc('*INCLUDE\nmissing_file.key\n', '/project/main.k');
          doc.languageId = 'lsdyna';
          const provider = new LsdynaFieldHoverProvider();

          const hover = provider.provideHover(doc, { line: 1, character: 3 });
          assert.strictEqual(hover, null);
      });
  ```

- [ ] **步骤 2：运行测试验证失败/通过**
  运行：`npm test` 验证新增加 of 测 试 用例 通过，并且 原 有 的 156 项 测试 也没有受到任何影响。

---

### 任务 4：Git Commit 提交

- [ ] **步骤 1：检查修改并执行 commit**
  ```bash
  git add src/extension.js test/extension.test.js docs/superpowers/plans/2026-05-23-include-hover-actions.md
  git commit -m "feat: add hover actions for existing include files"
  ```
