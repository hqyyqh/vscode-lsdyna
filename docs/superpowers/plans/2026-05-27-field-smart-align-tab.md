# LS-DYNA Card Field Smart Align and Tab Navigation 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现基于物理列宽对齐的 LS-DYNA 卡片数据行 Tab 导航和自动换行对齐，解决用户输入少于 10 个字符时的列错位与 Tab 跳转问题。

**架构：**
1. 升级 `alignLineText` 对齐算法为混合模式：空行补齐空格、物理区间切分对齐（防后续列漂移）、空格切分Fallback（兼容自由格式）。
2. 在 `src/extension.js` 中实现 `handleTabAlignment(editor)` 函数并导出，在用户按 Tab 时对齐当前行并把光标移到下一个卡位或自动换行。
3. 监听 selection 变化，当光标落在有效的数据卡片行上时，动态将 context key `lsdyna.shouldAlignTab` 设为 `true`，以在 `package.json` 中触发 Tab 快捷键拦截；离开时设为 `false`。

**技术栈：** VS Code Extension API, Node.js, Mocha

---

### 任务 1：升级对齐算法 `alignLineText` 为混合对齐模式

**文件：**
- 修改：`src/extension.js` (第 1426-1451 行左右)
- 测试：`test/client/providers/phase7_features.test.js`

- [ ] **步骤 1：编写失败的测试**
  在 `test/client/providers/phase7_features.test.js` 的 `alignLineText` describe 块中添加三个测试用例：
  1. 空行应当返回由卡片总宽决定数量的空格行。
  2. 物理区间切分：如果用户只在第二个字段输入 `123`，对齐后第一个字段保留 10 个空格，第二个字段右对齐为 `       123`，而不是把 `123` 挪到第一个字段。
  3. 空格切分Fallback：非对齐的空格分隔行，仍能正确按顺序分配对齐。

  在 `test/client/providers/phase7_features.test.js` 中追加以下测试代码：
  ```javascript
  it('formats empty line and returns a space-filled line matching card length', () => {
      const cardFields = [
          { n: 'NID', p: 0, w: 8 },
          { n: 'X', p: 8, w: 16 }
      ];
      const aligned = alignLineText('', cardFields);
      assert.equal(aligned, '                        '); // 8 + 16 = 24 spaces
  });

  it('preserves the physical columns and avoids shifting values leftward', () => {
      const cardFields = [
          { n: 'NID', p: 0, w: 10 },
          { n: 'X', p: 10, w: 10 }
      ];
      const rawText = '          123'; // 10 spaces followed by '123'
      const aligned = alignLineText(rawText, cardFields);
      assert.equal(aligned, '                 123'); // 10 spaces + 7 spaces + '123'
  });

  it('falls back to whitespace-splitting for unaligned lists', () => {
      const cardFields = [
          { n: 'NID', p: 0, w: 10 },
          { n: 'X', p: 10, w: 10 }
      ];
      const rawText = '12323 10'; // Space separated but not in column 10
      const aligned = alignLineText(rawText, cardFields);
      assert.equal(aligned, '     12323        10');
  });
  ```

- [ ] **步骤 2：运行测试验证失败**
  运行：`npm test`
  预期：Mocha 测试运行，新增的 `alignLineText` 测试失败（AssertionError 或未按新逻辑输出）。

- [ ] **步骤 3：编写最少实现代码**
  修改 `src/extension.js` 中的 `alignLineText` 函数：
  ```javascript
  function alignLineText(text, card) {
      if (!card || card.length === 0) return text;

      const trimmed = text.trim();
      if (trimmed.length === 0) {
          let emptyLine = '';
          let prevEnd = 0;
          for (const f of card) {
              const gap = f.p - prevEnd;
              if (gap > 0) emptyLine += ' '.repeat(gap);
              emptyLine += ' '.repeat(f.w);
              prevEnd = f.p + f.w;
          }
          return emptyLine;
      }

      const tokens = trimmed.split(/\s+/).filter(t => t.length > 0);

      // Attempt physical column extraction
      const physVals = [];
      let hasInternalSpace = false;
      for (let i = 0; i < card.length; i++) {
          const f = card[i];
          if (f.p >= text.length) {
              physVals.push('');
              continue;
          }
          const rawVal = text.slice(f.p, Math.min(text.length, f.p + f.w));
          const val = rawVal.trim();
          physVals.push(val);

          if (val.length > 0 && /\s/.test(val)) {
              hasInternalSpace = true;
          }
      }

      const nonEvPhysVals = physVals.filter(v => v.length > 0);
      const useTokens = hasInternalSpace || (nonEvPhysVals.length !== tokens.length);

      let alignedText = '';
      let prevEnd = 0;

      for (let i = 0; i < card.length; i++) {
          const f = card[i];
          const gap = f.p - prevEnd;
          if (gap > 0) alignedText += ' '.repeat(gap);

          let val = '';
          if (useTokens) {
              if (i < tokens.length) {
                  val = tokens[i];
              }
          } else {
              val = physVals[i];
          }

          const paddedVal = val.padStart(f.w);
          alignedText += paddedVal;
          prevEnd = f.p + f.w;
      }

      return alignedText;
  }
  ```

- [ ] **步骤 4：运行测试验证通过**
  运行：`npm test`
  预期：所有 `alignLineText` 相关测试 100% PASS。

- [ ] **步骤 5：Commit**
  ```bash
  git add src/extension.js test/client/providers/phase7_features.test.js
  git commit -m "feat(autocomplete): update alignLineText to support physical column alignment and spacing fallback"
  ```

---

### 任务 2：实现 Tab 导航逻辑 `handleTabAlignment` 并进行 TDD 验证

**文件：**
- 修改：`src/extension.js` (新增 `handleTabAlignment` 并导出到 `_internals`)
- 测试：`test/client/providers/phase7_features.test.js`

- [ ] **步骤 1：编写失败的测试**
  在 `test/client/providers/phase7_features.test.js` 中新增一个 describe 块 `handleTabAlignment`：
  1. 测试用例 1：光标在第一个字段时按 Tab，应该对齐行，并将光标移动到第 10 列。
  2. 测试用例 2：光标在最后一个字段时按 Tab，且下一行是数据行，应该换行并将光标移动到下一行第 0 列。
  3. 测试用例 3：光标在最后一个字段时按 Tab，且当前是文件最后一行，自动新建空行并将光标移入新行第 0 列。

  添加测试代码：
  ```javascript
  describe('handleTabAlignment', () => {
      it('aligns the line and moves the cursor to the next field', async () => {
          const document = fakeDoc('*NODE\n12323\n', '/project/main.k');
          document.languageId = 'lsdyna';
          let editCalled = false;
          let editVal = '';
          let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 5), new vscodeMock.Position(1, 5));

          const editor = {
              document,
              edit: async (callback) => {
                  editCalled = true;
                  const builder = {
                      replace: (r, v) => { editVal = v; }
                  };
                  callback(builder);
                  return true;
              },
              get selection() { return selectionVal; },
              set selection(v) { selectionVal = v; }
          };

          const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
          vscodeMock.window.activeTextEditor = editor;

          try {
              await handleTabAlignment(editor);
              assert.ok(editCalled);
              // Width of NID is 8 in mock *NODE
              assert.equal(editVal.slice(0, 8), '   12323');
              // The next field start position is column 8
              assert.equal(selectionVal.active.character, 8);
              assert.equal(selectionVal.active.line, 1);
          } finally {
              vscodeMock.window.activeTextEditor = originalActiveTextEditor;
          }
      });

      it('wraps cursor to the next line on the last field if the next line is a card line', async () => {
          const document = fakeDoc('*NODE\n   12323               0               0\n       0       0       0\n', '/project/main.k');
          document.languageId = 'lsdyna';
          let editCalled = false;
          // Cursor placed in the last field (col 32, i.e., field index 2)
          let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 35), new vscodeMock.Position(1, 35));

          const editor = {
              document,
              edit: async (callback) => {
                  editCalled = true;
                  return true;
              },
              get selection() { return selectionVal; },
              set selection(v) { selectionVal = v; }
          };

          const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
          vscodeMock.window.activeTextEditor = editor;

          try {
              await handleTabAlignment(editor);
              // Cursor should have jumped to line 2, character 0
              assert.equal(selectionVal.active.line, 2);
              assert.equal(selectionVal.active.character, 0);
          } finally {
              vscodeMock.window.activeTextEditor = originalActiveTextEditor;
          }
      });
  });
  ```

- [ ] **步骤 2：运行测试验证失败**
  运行：`npm test`
  预期：测试运行，`handleTabAlignment` describe 报错，因为 `handleTabAlignment` 未定义。

- [ ] **步骤 3：编写最少实现代码**
  在 `src/extension.js` 中实现 `handleTabAlignment`：
  ```javascript
  async function handleTabAlignment(editor) {
      if (!editor) return;

      const document = editor.document;
      const selection = editor.selection;
      const lineNum = selection.active.line;
      const col = selection.active.character;

      const line = document.lineAt(lineNum);
      const text = line.text;

      const card = getCardFieldsForLine(document, lineNum);
      if (!card || card.length === 0) {
          await vscode.commands.executeCommand('tab');
          return;
      }

      // 1. Determine current field index based on cursor position
      let currentFieldIndex = 0;
      for (let i = 0; i < card.length; i++) {
          const f = card[i];
          const nextF = card[i + 1];
          const end = nextF ? nextF.p : (f.p + f.w);
          if (col >= f.p && col < end) {
              currentFieldIndex = i;
              break;
          }
      }

      const targetIndex = currentFieldIndex + 1;

      // 2. Align current line
      const alignedText = alignLineText(text, card);

      // 3. Edit current line
      await editor.edit(editBuilder => {
          const range = new vscode.Range(
              new vscode.Position(lineNum, 0),
              new vscode.Position(lineNum, text.length)
          );
          editBuilder.replace(range, alignedText);
      }, { undoStopBefore: false, undoStopAfter: false });

      // 4. Handle cursor movement
      if (targetIndex < card.length) {
          const targetCol = card[targetIndex].p;
          const newPos = new vscode.Position(lineNum, targetCol);
          editor.selection = new vscode.Selection(newPos, newPos);
      } else {
          // It's the last field, wrap to the next line
          const nextLineNum = lineNum + 1;
          if (nextLineNum < document.lineCount) {
              const nextLine = document.lineAt(nextLineNum);
              const trimmedNext = nextLine.text.trimStart();
              if (trimmedNext.startsWith('*') || trimmedNext.startsWith('$')) {
                  // If next line is a keyword or comment, just move to line end or line start
                  const newPos = new vscode.Position(lineNum, alignedText.length);
                  editor.selection = new vscode.Selection(newPos, newPos);
              } else {
                  // Jump to start of the next card line
                  const newPos = new vscode.Position(nextLineNum, 0);
                  editor.selection = new vscode.Selection(newPos, newPos);
              }
          } else {
              // At the end of the file, append a new line and move there
              await editor.edit(editBuilder => {
                  editBuilder.insert(new vscode.Position(lineNum, alignedText.length), '\n');
              }, { undoStopBefore: false, undoStopAfter: false });
              const newPos = new vscode.Position(nextLineNum, 0);
              editor.selection = new vscode.Selection(newPos, newPos);
          }
      }
  }
  ```
  并在 `src/extension.js` 的 `module.exports._internals` 中追加导出 `handleTabAlignment`：
  ```javascript
  module.exports._internals = {
      ...
      alignLineText,
      formatLineIfNeeded,
      handleTabAlignment
  };
  ```

- [ ] **步骤 4：运行测试验证通过**
  运行：`npm test`
  预期：所有的 Mocha 单元测试通过。

- [ ] **步骤 5：Commit**
  ```bash
  git add src/extension.js test/client/providers/phase7_features.test.js
  git commit -m "feat(autocomplete): implement handleTabAlignment for right-aligning fields and wrapping lines"
  ```

---

### 任务 3：配置 package.json 快捷键和绑定 Context Key 状态切换

**文件：**
- 修改：`package.json`
- 修改：`src/extension.js` (在 `activate` 中注册命令并订阅事件)

- [ ] **步骤 1：编写失败的测试**
  在 `test/client/providers/phase7_features.test.js` 中验证 context key 的切换逻辑：
  ```javascript
  describe('Selection context key setting', () => {
      it('sets shouldAlignTab context based on current line card applicability', async () => {
          let lastContextKey = null;
          let lastContextVal = null;
          const originalExecuteCommand = vscodeMock.commands.executeCommand;
          vscodeMock.commands.executeCommand = async (cmd, ...args) => {
              if (cmd === 'setContext') {
                  lastContextKey = args[0];
                  lastContextVal = args[1];
              }
              return originalExecuteCommand ? originalExecuteCommand(cmd, ...args) : undefined;
          };

          try {
              const document = fakeDoc('*NODE\n12323\n$ Comment\n', '/project/main.k');
              document.languageId = 'lsdyna';
              
              // Simulate editor select line 1 (data line)
              const editor = {
                  document,
                  selection: { active: new vscodeMock.Position(1, 2) }
              };

              // Invoke internals handler trigger
              const { handleSelectionChange } = require('../../../src/extension')._internals;
              
              handleSelectionChange(editor);
              assert.equal(lastContextKey, 'lsdyna.shouldAlignTab');
              assert.equal(lastContextVal, true);

              // Simulate editor select line 2 (comment line)
              editor.selection.active = new vscodeMock.Position(2, 2);
              handleSelectionChange(editor);
              assert.equal(lastContextKey, 'lsdyna.shouldAlignTab');
              assert.equal(lastContextVal, false);
          } finally {
              vscodeMock.commands.executeCommand = originalExecuteCommand;
          }
      });
  });
  ```
  在 `src/extension.js` 中将 `handleSelectionChange` 导出到 `_internals`。

- [ ] **步骤 2：运行测试验证失败**
  运行：`npm test`
  预期：测试由于找不到导出的 `handleSelectionChange` 或 `executeCommand` 没有设置正确的 context 失败。

- [ ] **步骤 3：编写最少实现代码**
  1. 在 `package.json` 的 `keybindings` 中注册：
     ```json
     {
         "command": "extension.lsdynaTab",
         "key": "tab",
         "when": "editorTextFocus && editorLangId == 'lsdyna' && !suggestWidgetVisible && lsdyna.shouldAlignTab"
     }
     ```
  2. 在 `package.json` 的 `commands` 中注册：
     ```json
     {
         "command": "extension.lsdynaTab",
         "title": "Align Card Field and Tab Next"
     }
     ```
  3. 在 `src/extension.js` 的 `activate` 中注册命令，挂载事件监听：
     ```javascript
     // 注册命令
     context.subscriptions.push(
         vscode.commands.registerCommand('extension.lsdynaTab', () => {
             return handleTabAlignment(vscode.window.activeTextEditor);
         })
     );
     ```
  4. 更新 `handleSelectionChange` 使其设置 context key：
     ```javascript
     function handleSelectionChange(editor) {
         if (!editor || !isLsdynaFile(editor.document)) {
             lastActiveLineNum = null;
             lastActiveDoc = null;
             vscode.commands.executeCommand('setContext', 'lsdyna.shouldAlignTab', false);
             return;
         }

         const currentLineNum = editor.selection.active.line;
         const currentDoc = editor.document;

         const line = currentDoc.lineAt(currentLineNum);
         const trimmed = line.text.trimStart();
         const isCardLine = !trimmed.startsWith('*') && !trimmed.startsWith('$');
         const cardFields = isCardLine ? getCardFieldsForLine(currentDoc, currentLineNum) : null;
         const hasCard = cardFields && cardFields.length > 0;
         
         vscode.commands.executeCommand('setContext', 'lsdyna.shouldAlignTab', hasCard);

         if (lastActiveDoc === currentDoc && lastActiveLineNum !== null && lastActiveLineNum !== currentLineNum) {
             formatLineIfNeeded(currentDoc, lastActiveLineNum);
         }

         lastActiveLineNum = currentLineNum;
         lastActiveDoc = currentDoc;
     }
     ```
  5. 在 `module.exports._internals` 中导出 `handleSelectionChange`。

- [ ] **步骤 4：运行测试验证通过**
  运行：`npm test`
  预期：所有测试套件 100% PASS。

- [ ] **步骤 5：Commit**
  ```bash
  git add package.json src/extension.js test/client/providers/phase7_features.test.js
  git commit -m "feat(autocomplete): register lsdynaTab command and bind to tab key with dynamic context key"
  ```
