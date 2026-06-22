# LS-DYNA Field Comment Completion 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在用户输入 `$` 或 `$#` 时自动在补全列表中提示并在接受时插入对应下一行数据卡片的对齐字段注释。

**架构：**
1. 在 `src/extension.js` 中实现 `generateCommentLine(card)` 格式化对齐函数并将其导出为 `_internals`。
2. 修改 `LsdynaFieldCompletionProvider.provideCompletionItems` 中的 guard 以防其拦截 `$` 及以 `$#` 开头的注释触发。
3. 当判定符合插入条件时，利用 `getCardFieldsForLine` 得到下一行对应的 card 定义，调用 `generateCommentLine` 产生注释行，并通过 VS Code 的 `CompletionItem` 提供补全及 Markdown tooltip 预览。

**技术栈：** Node.js, VS Code Extension API, Mocha

---

### 任务 1：实现 `generateCommentLine` 函数及单元测试

**文件：**
- 修改：`src/extension.js`
- 修改：`test/client/providers/phase7_features.test.js`

- [ ] **步骤 1：编写失败的测试**
  在 `test/client/providers/phase7_features.test.js` 中的 `LsdynaFieldCompletionProvider` suite 附近添加对 `generateCommentLine` 的测试用例。
  ```javascript
  describe('generateCommentLine', () => {
      it('should align field names based on field offsets and width', () => {
          const { generateCommentLine } = require('../../../src/extension')._internals;
          const card = [
              { n: 'SECID', p: 0, w: 10 },
              { n: 'MID', p: 10, w: 10 },
              { n: 'ELFORM', p: 20, w: 10 }
          ];
          const result = generateCommentLine(card);
          // SECID aligns at 2 (since $# takes 0-1), length 5. Right align in [2, 9] with 1 space right padding -> "SECID " -> '$#SECID   '
          // MID aligns at 10, length 3. Right align in [10, 19] with 1 space right padding -> "    MID "
          // ELFORM aligns at 20, length 6. Right align in [20, 29] with 1 space right padding -> "  ELFORM "
          const expected = '$#SECID       MID    ELFORM';
          assert.strictEqual(result, expected);
      });
  });
  ```

- [ ] **步骤 2：运行测试验证失败**
  运行：`npm test`
  预期：FAIL，报错 `generateCommentLine is not a function` 或者是未定义。

- [ ] **步骤 3：编写最少实现代码并导出**
  在 `src/extension.js` 中编写 `generateCommentLine` 实现并添加在 `_internals` 的导出项中：
  ```javascript
  function generateCommentLine(card) {
      if (!card || card.length === 0) return '';
      const lastField = card[card.length - 1];
      const totalLen = lastField.p + lastField.w;
      const chars = Array(totalLen).fill(' ');
      chars[0] = '$';
      chars[1] = '#';
      for (let i = 0; i < card.length; i++) {
          const f = card[i];
          const name = f.n || '';
          let startIdx = f.p;
          if (startIdx < 2) {
              startIdx = 2;
          }
          let maxEnd = f.p + f.w;
          if (i < card.length - 1) {
              maxEnd = Math.min(maxEnd, card[i + 1].p);
          }
          const maxLen = maxEnd - startIdx;
          if (maxLen <= 0) continue;
          let alignedName = name;
          if (name.length < maxLen) {
              alignedName = name.padStart(maxLen - 1) + ' ';
          } else {
              alignedName = name.slice(0, maxLen);
          }
          for (let k = 0; k < alignedName.length; k++) {
              chars[startIdx + k] = alignedName[k];
          }
      }
      return chars.join('').trimEnd();
  }
  ```
  在 `src/extension.js` 底部的 `_internals` 中加入 `generateCommentLine`。

- [ ] **步骤 4：运行测试验证通过**
  运行：`npm test`
  预期：PASS

- [ ] **步骤 5：Commit**
  运行：
  ```bash
  git add src/extension.js test/client/providers/phase7_features.test.js
  git commit -m "feat(autocomplete): implement generateCommentLine alignment function and export it"
  ```

---

### 任务 2：修改 Guard 并集成字段注释补全逻辑

**文件：**
- 修改：`src/extension.js`
- 修改：`test/client/providers/phase7_features.test.js`

- [ ] **步骤 1：编写自动补全注释触发的单元测试**
  在 `test/client/providers/phase7_features.test.js` 中的 `LsdynaFieldCompletionProvider` 自动补全测试套件中添加测试用例，模拟在输入 `$` 时返回 `$#` 注释补全项的场景。
  ```javascript
  it('should return $# completion item with documentation when typing $ under a keyword block', () => {
      const provider = new LsdynaFieldCompletionProvider();
      const document = fakeDoc('*SECTION_SHELL\n$\n', '/project/main.k');
      document.languageId = 'lsdyna';

      const pos = new vscodeMock.Position(1, 1); // cursor after '$'
      const items = provider.provideCompletionItems(document, pos);

      assert.strictEqual(items.length, 1);
      const item = items[0];
      assert.strictEqual(item.label, '$#');
      assert.strictEqual(item.detail, '(LS-DYNA) 插入字段注释行');
      assert.ok(item.insertText.includes('$#SECID'));
      assert.ok(item.documentation.value.includes('$#SECID'));
  });
  ```

- [ ] **步骤 2：运行测试验证失败**
  运行：`npm test`
  预期：FAIL（返回的补全列表为空数组，因为原本的 guard 拦截了以 `$` 开头的行）。

- [ ] **步骤 3：编写最少实现代码**
  修改 `src/extension.js` 中 `LsdynaFieldCompletionProvider.provideCompletionItems` 方法的 guard 并加入 `$#` CompletionItem 生成逻辑。
  ```javascript
  // Modified guard
  if (trimmed.startsWith('*') || (trimmed.startsWith('$') && !trimmed.startsWith('$#') && trimmed !== '$')) return [];

  const isCommentTrigger = trimmed === '$' || trimmed.startsWith('$#');
  if (isCommentTrigger) {
      const card = getCardFieldsForLine(document, position.line + 1);
      if (!card || card.length === 0) return [];

      const commentText = generateCommentLine(card);
      if (!commentText) return [];

      const item = new vscode.CompletionItem('$#', vscode.CompletionItemKind.Snippet);
      item.detail = '(LS-DYNA) 插入字段注释行';
      item.documentation = new vscode.MarkdownString(`**插入字段注释行**\n\n按下 Tab 将插入：\n\`${commentText}\``);
      item.insertText = commentText;
      item.range = new vscode.Range(position.line, 0, position.line, position.character);

      return [item];
  }
  ```

- [ ] **步骤 4：运行测试验证通过**
  运行：`npm test`
  预期：PASS

- [ ] **步骤 5：Commit**
  运行：
  ```bash
  git add src/extension.js test/client/providers/phase7_features.test.js
  git commit -m "feat(autocomplete): integrate $# comment completion into LsdynaFieldCompletionProvider"
  ```
