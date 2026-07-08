# Runtime i18n Coverage 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将插件运行时用户可见文本集中接入现有中英 i18n 自动切换方案。

**架构：** 继续使用 `src/core/i18n.ts` 作为运行时词典和语言解析入口。新增缺失词条，替换 `src/extension.ts` 与 `src/core/references/fieldReferenceHover.ts` 中的运行时硬编码文案，并用测试锁定中文、英文和缺 key 场景。

**技术栈：** VS Code Extension API mock、CommonJS TypeScript 源码、Mocha、Node assert、现有 `npm run compile` 和 `npm test`。

---

## 文件结构

- 修改：`src/core/i18n.ts` - 增加运行时中英词条。
- 修改：`src/core/references/fieldReferenceHover.ts` - 字段引用 Hover 的标题、提示、链接、表头和省略说明接入 `i18n.get(...)`。
- 修改：`src/extension.ts` - 诊断、跳转错误、打开 include 失败提示、字段 Hover 卡片列标题、补全说明接入 `i18n.get(...)`。
- 修改：`src/client/providers/includeTreeProvider.ts` - 去掉 `scannedFilesProgress` 的英文后备模板，使用新增词条。
- 修改：`src/client/providers/keywordIndexProvider.ts` - 去掉 `scannedFilesProgress` 的英文后备模板，使用新增词条。
- 修改：`test/extension.test.js` - 覆盖诊断、字段 Hover 卡片列、补全文档等运行时语言切换。
- 修改：`test/core/references/fieldReferenceHover.test.js` - 覆盖引用 Hover 中英文输出。
- 修改：`test/client/providers/advanced_features.test.js` - 诊断断言改为本地化断言。
- 新增或修改：运行时 i18n parity 测试，放在 `test/extension.test.js` 的现有 i18n 区域，确保 `src/` 使用的 key 在中英词典中都存在。

### 任务 1：写失败测试覆盖缺失 key 和字段引用 Hover

**文件：**
- 修改：`test/core/references/fieldReferenceHover.test.js`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：新增字段引用 Hover 的中文断言**

```javascript
vscodeMock.workspace.getConfiguration = () => ({
    get: (key) => key === 'language' ? 'zh-cn' : undefined
});
i18n.updateLanguage();

const section = buildReferenceHoverSection({
    fieldName: 'LCSS',
    id: 1001,
    raw: '-1001',
    isSignedSwitch: true,
    definitions: [],
    needsProjectScan: true,
});

assert.ok(section.includes('LCSS 引用'));
assert.ok(section.includes('原始值'));
assert.ok(section.includes('负号开关'));
assert.ok(section.includes('扫描引用文件树'));
```

- [ ] **步骤 2：新增运行时 i18n key parity 测试**

```javascript
const fs = require('fs');
const path = require('path');

const i18nSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'i18n.ts'), 'utf8');
const usedKeys = [...scanSourceI18nKeys(path.join(__dirname, '..', 'src'))];

for (const key of usedKeys) {
    assert.ok(i18n.get(key) !== key, `${key} should resolve`);
}
assert.equal(i18n.get('scannedFilesProgress', 3), '已扫描 3 个文件...');
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceHover.test.js test/extension.test.js`

预期：FAIL，至少出现中文 Hover 文案断言失败或 `scannedFilesProgress should resolve` 失败。

### 任务 2：写失败测试覆盖诊断和补全文档

**文件：**
- 修改：`test/extension.test.js`
- 修改：`test/client/providers/advanced_features.test.js`

- [ ] **步骤 1：将项目诊断断言改为语言相关**

```javascript
assert.equal(mainDiags[0].message, i18n.get('includedFileNotFound', 'missing.k'));
assert.equal(childDiags[0].message, i18n.get('circularIncludeDependency', 'main.k -> child.k -> main.k'));
```

- [ ] **步骤 2：新增字段补全文档中文断言**

```javascript
vscodeMock.workspace.getConfiguration = () => ({
    get: (key) => key === 'language' ? 'zh-cn' : undefined
});
i18n.updateLanguage();

const provider = new LsdynaFieldCompletionProvider();
const items = provider.provideCompletionItems(document, position);
assert.ok(items[0].detail.includes('插入字段注释行'));
assert.ok(items[0].documentation.value.includes('按下 Tab 将插入'));
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/providers/advanced_features.test.js test/extension.test.js`

预期：FAIL，诊断或补全文档仍为英文或硬编码中文，无法随语言自动切换。

### 任务 3：补齐词典

**文件：**
- 修改：`src/core/i18n.ts`

- [ ] **步骤 1：在 `zh-cn` 与 `en` 字典中添加缺失运行时词条**

```javascript
scannedFilesProgress: '已扫描 {0} 个文件...',
cardColumns: '卡片列',
referenceLabel: '{0} 引用',
rawValue: '原始值：`{0}`。',
negativeSwitchStripped: '$(info) 已去除负号开关后查找。',
noMatchingDefinition: '$(warning) 未找到 ID `{0}` 对应的曲线/表格定义。',
runScanIncludeTreeForDefinitions: '运行 **扫描引用文件树** 以索引跨文件曲线/表格定义。',
openDefinition: '打开定义',
openChildDefinition: '打开子级 {0}',
```

- [ ] **步骤 2：补齐诊断、错误和补全文档词条**

```javascript
lineExceeds80Characters: '当前行超过 80 个字符 ({0})；LS-DYNA 可能会截断。',
cannotRenameSymbol: '无法重命名此符号。',
notOnAnyKeyword: '当前位置不在任何关键字块内。',
keywordHasNoFilenameCard: '此关键字没有文件名卡片。',
keywordNotSupported: '此关键字不支持该操作。',
noFileToJumpTo: '没有可跳转的文件。',
fileNotFound: '{0} 未找到。',
noMoreKeywordsFound: '未找到后续关键字。',
noPreviousKeywordsFound: '未找到前一个关键字。',
failedToOpenFile: '打开文件失败：{0}',
fieldCommentCompletionDetail: '(LS-DYNA) 插入字段注释行',
rowTemplateDocumentation: '插入一整行预对齐的数据卡片模板。',
```

- [ ] **步骤 3：运行 key parity 测试验证仍失败于生产代码未替换处**

运行：`npm run compile && npx mocha --require test/register-out.js test/extension.test.js test/core/references/fieldReferenceHover.test.js`

预期：部分测试仍 FAIL，因为生产代码还在输出硬编码英文。

### 任务 4：替换运行时硬编码文案

**文件：**
- 修改：`src/core/references/fieldReferenceHover.ts`
- 修改：`src/extension.ts`
- 修改：`src/client/providers/includeTreeProvider.ts`
- 修改：`src/client/providers/keywordIndexProvider.ts`

- [ ] **步骤 1：字段引用 Hover 接入 `i18n.get(...)`**

```javascript
function definitionLink(definition, title = i18n.get('openDefinition')) {
    // existing command URI behavior stays unchanged
}

lines.push(`**$(graph-line) ${i18n.get('referenceLabel', fieldName)}:** \`${id}\``);
lines.push(i18n.get('rawValue', raw));
lines.push(i18n.get('negativeSwitchStripped'));
```

- [ ] **步骤 2：字段 Hover、诊断和跳转错误接入 `i18n.get(...)`**

```javascript
throw new Error(i18n.get('notOnAnyKeyword'));
throw new Error(i18n.get('fileNotFound', filePath));
md.appendMarkdown(`\n\n---\n\n${helpText}\n\n---\n\n**$(table) ${i18n.get('cardColumns')}:**\n\n${gridTable}`);
```

- [ ] **步骤 3：补全和 include 打开错误接入 `i18n.get(...)`**

```javascript
item.detail = i18n.get('fieldCommentCompletionDetail');
templateItem.documentation = new vscode.MarkdownString(i18n.get('rowTemplateDocumentation'));
vscode.window.showErrorMessage(i18n.get('failedToOpenFile', err.message));
```

- [ ] **步骤 4：扫描进度使用新增 key**

```javascript
progress.report({ message: i18n.get('scannedFilesProgress', scannedCount) });
```

- [ ] **步骤 5：运行目标测试验证通过**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceHover.test.js test/client/providers/advanced_features.test.js test/extension.test.js`

预期：PASS。

### 任务 5：全量验证和残留扫描

**文件：**
- 不新增生产文件。
- 可能修改测试断言以使用 `i18n.get(...)`。

- [ ] **步骤 1：运行完整测试**

运行：`npm test`

预期：PASS。

- [ ] **步骤 2：运行编译**

运行：`npm run compile`

预期：PASS。

- [ ] **步骤 3：扫描已知残留文案**

运行：

```powershell
rg -n "Open definition|Open child|No matching curve/table definition|Scan Include Tree|Card Columns|Cannot rename this symbol|No more keywords found|Included file|Circular include dependency|Insert a pre-aligned" src test
```

预期：`src/` 中无未本地化的运行时用户文案残留；`test/` 可出现用于断言英文语言包的文本。
