# 解析器正确性与路径边界实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 统一关键字行语义、消除虚拟尾部行号，并严格执行 Include 路径三行/236 字符上限。

**架构：** 文本和字节扫描共用一个轻量分类模块；大文件尾部位置由独立定位器提供真实行号；路径格式器返回结构化结果而非无条件字符串数组。

**技术栈：** TypeScript、Node.js streams/Buffer、Mocha、VS Code Diagnostic API

---

## 文件结构

- 创建：`src/core/parser/keywordLine.ts` — 文本和 Buffer 关键字分类。
- 创建：`src/core/parser/tailLineLocator.ts` — 尾部完整行和真实行号定位。
- 创建：`test/core/parser/keywordLine.test.js`、`test/core/parser/tailLineLocator.test.js`。
- 修改：`src/core/parser/includeScanner.ts`、`keywordScanner.ts`、`blockScanner.ts`、`keywordValidator.ts`。
- 修改：`src/extension.ts` — 参数/导航统一与路径结构化结果、诊断。
- 修改：对应 parser 与 advanced feature 测试。

### 任务 1：共享关键字行分类器

**文件：**
- 创建：`src/core/parser/keywordLine.ts`
- 创建：`test/core/parser/keywordLine.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const { classifyKeywordLine, findKeywordAsterisk } = require('../../../out/core/parser/keywordLine');

assert.deepEqual(classifyKeywordLine('\t *Include,foo'), {
    isKeyword: true,
    indent: 2,
    rawKeyword: '*Include',
    normalizedKeyword: '*INCLUDE',
    hasLowercase: true,
});
assert.equal(findKeywordAsterisk(Buffer.from(' \t*include')), 2);
assert.equal(findKeywordAsterisk(Buffer.from('  123')), -1);
```

- [ ] **步骤 2：运行并确认模块缺失**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/parser/keywordLine.test.js`
预期：FAIL，找不到模块。

- [ ] **步骤 3：实现分类器**

实现 `classifyKeywordLine(text)`，仅跳过空格和 Tab，提取到空白或逗号为止；比较名称使用 `toUpperCase()`，保留原始名称。实现 `findKeywordAsterisk(buffer,start,end)`，跳过 `0x20/0x09/0x0d` 后仅判断 `0x2a`。

- [ ] **步骤 4：运行测试并提交**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/parser/keywordLine.test.js`
预期：PASS。

```powershell
git add src/core/parser/keywordLine.ts test/core/parser/keywordLine.test.js
git commit -m "feat: centralize keyword line classification"
```

### 任务 2：迁移核心扫描器与参数辅助逻辑

**文件：**
- 修改：`src/core/parser/includeScanner.ts`
- 修改：`src/core/parser/keywordScanner.ts`
- 修改：`src/core/parser/blockScanner.ts`
- 修改：`src/core/parser/keywordValidator.ts`
- 修改：`src/extension.ts`
- 修改：`test/core/parser/*.test.js`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：为前导空白和混合大小写添加失败测试**

覆盖 ` \t*include`、`*Include_Path`、`  *parameter_expression`、`\t*node`；断言 Include 解析、Block 切分、Keyword 索引和参数定义/引用均工作，小写 validator 仍产生 warning。

- [ ] **步骤 2：确认现有 Include/Block/参数测试失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/parser/*.test.js test/extension.test.js --grep "leading whitespace|mixed case"`。

- [ ] **步骤 3：迁移核心扫描器**

所有文本路径调用 `classifyKeywordLine`。Include 状态中的 `state.keyword` 保存 `normalizedKeyword`。Buffer 快速路径使用 `findKeywordAsterisk`；Include 预检对候选行做 ASCII 大小写无关比较，不再使用全 Buffer 的大小写敏感 `indexOf('*INCLUDE')`。

- [ ] **步骤 4：迁移 extension 参数和导航辅助函数**

把直接 `line.startsWith('*')` 的参数定义、参数引用、当前关键字和导航代码改为共享分类器；评论识别继续允许前导空白后的 `$`。

- [ ] **步骤 5：运行 parser 与 extension 测试**

运行：`npm test`
预期：全部通过，原有 lowercase warning 测试保持有效。

- [ ] **步骤 6：Commit 统一语义**

```powershell
git add src/core/parser src/extension.ts test/core/parser test/extension.test.js
git commit -m "fix: normalize keyword parsing across scanners"
```

### 任务 3：真实尾部行号定位

**文件：**
- 创建：`src/core/parser/tailLineLocator.ts`
- 创建：`test/core/parser/tailLineLocator.test.js`
- 修改：`src/core/parser/includeScanner.ts`
- 修改：`src/core/parser/keywordScanner.ts`

- [ ] **步骤 1：编写失败测试**

创建超过 500KB 的临时文件，尾部包含 `*INCLUDE\nmissing.k` 与 `*NODE`。断言定位器返回的 `startOffset` 位于完整行起点，`startLineIndex` 等于 fixture 实际行号；两个 scanner 返回的尾部记录不得大于文件总行数。

- [ ] **步骤 2：实现 `locateTailWindow`**

签名：

```typescript
async function locateTailWindow(filePath: string, fileStat: { size: number; mtimeMs: number }, tailBytes = 200 * 1024): Promise<{
    startOffset: number;
    startLineIndex: number;
}>;
```

使用 1MB Buffer 顺序统计 `startOffset` 前的 `0x0a`；初始尾部偏移不为 0 时，向后读取窗口并将起点推进到首个换行之后。缓存键为绝对路径、size、mtimeMs。

- [ ] **步骤 3：替换两个 `9999999`**

两个 scanner 调用 `locateTailWindow` 并用真实 `startLineIndex`。定位失败时回退全文件流式扫描，不允许任何虚拟行号。

- [ ] **步骤 4：运行测试并搜索虚拟值**

运行：`npm test`
预期：PASS。

运行：`rg -n "9999999" src test`
预期：无匹配。

- [ ] **步骤 5：Commit**

```powershell
git add src/core/parser/tailLineLocator.ts src/core/parser/includeScanner.ts src/core/parser/keywordScanner.ts test/core/parser
git commit -m "fix: report real line numbers for tail scans"
```

### 任务 4：三行路径限制与诊断

**文件：**
- 修改：`src/extension.ts`
- 修改：`test/client/providers/advanced_features.test.js`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：添加完整边界失败测试**

对 80/81/156/157/236 字符断言 `formatted` 行数和每行不超过 80；237 字符断言 `tooLong`、不调用 editor edit，并生成 code 为 `include-path-too-long` 的 Diagnostic。覆盖 INCLUDE、INCLUDE_PATH、CRLF 和合法多行回并。

- [ ] **步骤 2：实现结构化 `splitIncludePathEntry`**

```typescript
type IncludePathFormatResult =
    | { status: 'unchanged'; lines: string[] }
    | { status: 'formatted'; lines: string[] }
    | { status: 'tooLong'; maxLength: 236; actualLength: number };
```

长度超过 236 直接返回 `tooLong`。否则按 78、78、80 切分，非末行追加 ` +`。

- [ ] **步骤 3：接入格式化与诊断**

`formatPathEntryIfNeeded` 对 `tooLong` 不写文档；`updateDiagnostics` 为路径范围添加明确错误消息。缩短后的合法多行仍可合并。

- [ ] **步骤 4：运行边界和全量测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/providers/advanced_features.test.js test/extension.test.js --grep "path"`
预期：PASS。

运行：`npm test`
预期：全部通过。

- [ ] **步骤 5：Commit**

```powershell
git add src/extension.ts test/client/providers/advanced_features.test.js test/extension.test.js
git commit -m "fix: enforce LS-DYNA include path length limits"
```
