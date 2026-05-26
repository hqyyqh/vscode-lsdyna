# Field Smart Autocomplete Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Implement a smart, column-aligned individual field autocomplete and a full-row card template auto-expansion provider for the LS-DYNA VS Code extension.

**架构：**
1. Add new i18n keys to `src/core/i18n.js` to dynamically localise autocomplete labels and details in English and Simplified Chinese.
2. Implement `LsdynaFieldCompletionProvider` inside `src/extension.js` that calculates spacing gaps (`field.p - col`) dynamically for single fields and structures precise `Tab`-cyclable snippets for full row card templates.
3. Register the new provider during extension activation in `activate()`.
4. Add comprehensive unit tests in `test/client/providers/phase7_features.test.js` to test trigger guards, smart padding calculations, and full row template configurations.

**技术栈：** VS Code Extension API (`CompletionItemProvider`, `SnippetString`), JavaScript, Node.js, Mocha Test Framework.

---

### Task 1: Extend i18n Translation Bundles

**Files:**
- Modify: `src/core/i18n.js`

- [ ] **Step 1: Modify src/core/i18n.js**
  Add field autocomplete specific i18n keys to Simplified Chinese (`zh-cn`) and English (`en`) blocks.
  *Key additions to 'zh-cn':*
  ```javascript
          fieldCompletionLabel: '{0} (第 {1}-{2} 列)',
          rowTemplateLabel: '✨ 生成整行卡片模板 (Card {0})',
          fieldDetail: '卡片字段 ({0}) - {1}',
          rowTemplateDetail: 'LS-DYNA 字段对齐模板',
  ```
  *Key additions to 'en':*
  ```javascript
          fieldCompletionLabel: '{0} (Col {1}-{2})',
          rowTemplateLabel: '✨ Generate Row Card Template (Card {0})',
          fieldDetail: 'Card Field ({0}) - {1}',
          rowTemplateDetail: 'LS-DYNA Column-Aligned Template',
  ```

- [ ] **Step 2: Run Tests to Verify No Regressions**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 3: Commit i18n Key Additions**
  ```bash
  git add src/core/i18n.js
  git commit -m "feat(i18n): add translation keys for field smart autocomplete and templates"
  ```

---

### Task 2: Implement LsdynaFieldCompletionProvider

**Files:**
- Modify: `src/extension.js`

- [ ] **Step 1: Implement the LsdynaFieldCompletionProvider class**
  Add the complete `LsdynaFieldCompletionProvider` implementation to `src/extension.js` (around line 1294).
  ```javascript
  class LsdynaFieldCompletionProvider {
      provideCompletionItems(document, position, token, context) {
          if (!document || shouldSkipAutomaticDocumentScan(document)) return [];
  
          const line = document.lineAt(position.line);
          const text = line.text;
          const trimmed = text.trimStart();
  
          // Guard: Skip keywords and comments
          if (trimmed.startsWith('*') || trimmed.startsWith('$')) return [];
  
          // Find enclosing keyword
          let kwLine = null;
          for (let i = position.line - 1; i >= 0; i--) {
              const t = document.lineAt(i).text.trimStart();
              if (t.startsWith('*')) { kwLine = i; break; }
          }
          if (kwLine === null) return [];
  
          const kwText = document.lineAt(kwLine).text.trim();
          const kwName = kwText.slice(1).toUpperCase().split(/[\s,]/)[0];
          const entry = lookupKeyword(kwName);
          if (!entry) return [];
  
          // Count which card index this line is
          let cardIndex = 0;
          for (let i = kwLine + 1; i < position.line; i++) {
              const t = document.lineAt(i).text.trimStart();
              if (!t.startsWith('$') && t.length > 0) cardIndex++;
          }
  
          let effectiveCardIndex = cardIndex;
          if (kwName.endsWith('_TITLE')) {
              if (cardIndex === 0) return [];
              effectiveCardIndex = cardIndex - 1;
          }
  
          const cards = entry.c;
          const clampedIndex = entry.r ? Math.min(effectiveCardIndex, cards.length - 1) : effectiveCardIndex;
          const card = cards[clampedIndex];
          if (!card || card.length === 0) return [];
  
          const items = [];
  
          // 1. Row Card Template (Only when line is empty or near the beginning)
          if (text.trim().length === 0 || position.character <= 1) {
              const templateItem = new vscode.CompletionItem(
                  i18n.get('rowTemplateLabel', clampedIndex + 1),
                  vscode.CompletionItemKind.Snippet
              );
              templateItem.detail = i18n.get('rowTemplateDetail');
              templateItem.documentation = new vscode.MarkdownString('Insert a pre-aligned full data card row.');
  
              let snippetText = '';
              let prevEnd = 0;
              for (let j = 0; j < card.length; j++) {
                  const f = card[j];
                  const gap = f.p - prevEnd;
                  if (gap > 0) snippetText += ' '.repeat(gap);
  
                  const isFloat = f.h && (f.h.toLowerCase().includes('float') || f.h.toLowerCase().includes('real') || f.n.toUpperCase().startsWith('X') || f.n.toUpperCase().startsWith('Y') || f.n.toUpperCase().startsWith('Z'));
                  const defVal = isFloat ? '0.0' : '0';
                  const padLen = Math.max(0, f.w - defVal.length);
                  const placeholder = ' '.repeat(padLen) + defVal;
  
                  snippetText += `\${${j + 1}:${placeholder}}`;
                  prevEnd = f.p + f.w;
              }
              templateItem.insertText = new vscode.SnippetString(snippetText);
              // Ensure template is sorted at top
              templateItem.sortText = '0_' + clampedIndex;
              items.push(templateItem);
          }
  
          // 2. Individual Aligned Fields
          const col = position.character;
          for (let j = 0; j < card.length; j++) {
              const f = card[j];
              if (col <= f.p) {
                  const padding = f.p - col;
                  const label = i18n.get('fieldCompletionLabel', f.n, f.p + 1, f.p + f.w);
                  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
                  item.detail = i18n.get('fieldDetail', f.t || 'I', f.n);
                  if (f.h) {
                      item.documentation = new vscode.MarkdownString(f.h);
                  }
  
                  const isFloat = f.h && (f.h.toLowerCase().includes('float') || f.h.toLowerCase().includes('real') || f.n.toUpperCase().startsWith('X') || f.n.toUpperCase().startsWith('Y') || f.n.toUpperCase().startsWith('Z'));
                  const defVal = isFloat ? '0.0' : '0';
                  const padLen = Math.max(0, f.w - defVal.length);
                  const placeholder = ' '.repeat(padLen) + defVal;
  
                  // Insert spaces to align, then insert aligned placeholder
                  const insertText = ' '.repeat(padding) + `\${1:${placeholder}}`;
                  item.insertText = new vscode.SnippetString(insertText);
                  item.range = new vscode.Range(position.line, col, position.line, col);
                  // Sort individual fields in order of column position
                  item.sortText = '1_' + String(f.p).padStart(3, '0');
                  items.push(item);
              }
          }
  
          return items;
      }
  }
  ```

- [ ] **Step 2: Register LsdynaFieldCompletionProvider in activate()**
  Inside the `activate(context)` function in `src/extension.js` (around line 1353), append the provider registration.
  ```javascript
      context.subscriptions.push(
          vscode.languages.registerCompletionItemProvider(
              { language: 'lsdyna' },
              new LsdynaFieldCompletionProvider()
          )
      );
  ```

- [ ] **Step 3: Run Tests to Verify No Compile Errors**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 4: Commit Core Autocomplete Implementation**
  ```bash
  git add src/extension.js
  git commit -m "feat(autocomplete): implement LsdynaFieldCompletionProvider for smart column alignment"
  ```

---

### Task 3: Add Unit Tests

**Files:**
- Modify: `test/client/providers/phase7_features.test.js`

- [ ] **Step 1: Append Completion Provider Unit Tests**
  Add standard unit tests inside `test/client/providers/phase7_features.test.js` to ensure the logic runs correctly under different line prefixes and cursor positions.
  ```javascript
      describe('LsdynaFieldCompletionProvider', () => {
          it('skips keywords and comment lines', () => {
              const provider = new LsdynaFieldCompletionProvider();
              const document = fakeDoc('*NODE\n$ This is a comment\n', '/project/main.k');
              document.languageId = 'lsdyna';
              
              const pos1 = new vscodeMock.Position(0, 2); // on *NODE
              const items1 = provider.provideCompletionItems(document, pos1);
              assert.deepEqual(items1, []);
  
              const pos2 = new vscodeMock.Position(1, 4); // on comment
              const items2 = provider.provideCompletionItems(document, pos2);
              assert.deepEqual(items2, []);
          });
  
          it('returns full row template and individual fields on empty line', () => {
              const provider = new LsdynaFieldCompletionProvider();
              const document = fakeDoc('*NODE\n\n', '/project/main.k');
              document.languageId = 'lsdyna';
  
              const pos = new vscodeMock.Position(1, 0); // start of empty line
              const items = provider.provideCompletionItems(document, pos);
              
              assert.ok(items.length > 0);
              // Should contain row template item at index 0
              const templateItem = items[0];
              assert.ok(templateItem.label.includes('卡片') || templateItem.label.includes('Template'));
              assert.equal(templateItem.insertText.value.length, 80); // 8 fields * 10 columns = 80 chars
  
              // Should contain individual fields starting from index 1
              const fieldItem1 = items[1];
              assert.ok(fieldItem1.label.includes('NID'));
              assert.equal(fieldItem1.insertText.value, '${1:         0}'); // 0 spaces padding + 10 chars placeholder
          });
      });
  ```
  *(Note: We need to import LsdynaFieldCompletionProvider from `src/extension.js` in the test file imports around line 8. We will export it in the `module.exports` at the bottom of extension.js).*
  We will modify `extension.js` bottom to export `LsdynaFieldCompletionProvider` under `_internals` or directly.
  Currently, `extension.js` exports:
  ```javascript
  module.exports = {
      activate,
      deactivate,
      _internals: {
          ...
      }
  }
  ```
  We will append `LsdynaFieldCompletionProvider` to `_internals` to keep testing high cohesion.

- [ ] **Step 2: Run Tests to Verify Compliance**
  Run: `npm test`
  Expected: PASS (All tests including new ones pass)

- [ ] **Step 3: Commit Autocomplete Unit Tests**
  ```bash
  git add test/client/providers/phase7_features.test.js src/extension.js
  git commit -m "test(autocomplete): add unit tests for LsdynaFieldCompletionProvider"
  ```
