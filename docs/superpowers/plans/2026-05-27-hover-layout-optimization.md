# LS-DYNA Hover Layout Optimization 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化 Hover 悬浮窗布局以丢弃没必要的行占用，并将卡片结构表格转置且使用粗体行内代码块高亮当前字段。

**架构：**
1. 修改 `src/extension.js` 中 `LsdynaFieldHoverProvider.provideHover` 内的 `gridTable` 及 MarkdownString 拼接逻辑。
2. 更新 `test/client/providers/phase7_features.test.js` 中的相关 Hover 测试用例以匹配新格式。

**技术栈：** Node.js, VS Code Extension API, Mocha

---

### 任务 1：升级 Hover 渲染排版及字段名高亮

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：定位并替换 `LsdynaFieldHoverProvider.provideHover` 里的表格构造与 MD 拼接逻辑**
  在 `src/extension.js` 中定位：
  ```javascript
          const headers = card.map(f => f.n === field.n ? `**${f.n}**` : f.n);
          const separators = card.map(() => '---');
          const columns = card.map(f => `${f.p + 1}-${f.p + f.w}`);

          const gridTable = [
              `| ${headers.join(' | ')} |`,
              `| ${separators.join(' | ')} |`,
              `| ${columns.join(' | ')} |`
          ].join('\n');

          const md = new vscode.MarkdownString(`### Field: **${field.n}**${typeLabel}${helpText}\n\n---\n**Card Structure:**\n\n${gridTable}`);
  ```
  替换为：
  ```javascript
          const columnsHeader = card.map(f => `${f.p + 1}-${f.p + f.w}`);
          const separators = card.map(() => '---');
          const fieldNamesBody = card.map(f => f.n === field.n ? `**\`${f.n}\`**` : f.n);

          const gridTable = [
              `| ${columnsHeader.join(' | ')} |`,
              `| ${separators.join(' | ')} |`,
              `| ${fieldNamesBody.join(' | ')} |`
          ].join('\n');

          const md = new vscode.MarkdownString(`### **${field.n}**${typeLabel}${helpText}\n\n**Card Columns:**\n${gridTable}`);
  ```

- [ ] **步骤 2：进行 Commit**
  ```bash
  git add src/extension.js
  git commit -m "feat(hover): optimize hover layout and highlight hovered field name with transposed table"
  ```

---

### 任务 2：更新 Hover 单元测试并验证

**文件：**
- 修改：`test/client/providers/phase7_features.test.js`

- [ ] **步骤 1：修改现有 Hover 单元测试中的断言以防失败**
  在 `test/client/providers/phase7_features.test.js` 中定位到有关 Hover 的测试用例（如包含 `LsdynaFieldHoverProvider` 的 describe 块）。
  将匹配旧版 Hover 字符串断言修改为匹配新版。
  例如，如果是检查 `Field: **MID**`，改成检查 `### **MID**`；并添加断言检查表头变更为 `11-20` 且字段体包含高亮的 `**\`MID\`**`。
  ```javascript
  // 具体测试更新
  ```

- [ ] **步骤 2：运行全量单元测试确保通过**
  运行：`npm test`
  预期：PASS (216 passing)

- [ ] **步骤 3：进行 Commit**
  ```bash
  git add test/client/providers/phase7_features.test.js
  git commit -m "test(hover): update unit tests for hover layout and highlighting optimization"
  ```
