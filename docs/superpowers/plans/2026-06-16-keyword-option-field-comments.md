# Keyword Option Field Comments 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让新增的关键字后缀和 option 组合在 snippet、field hover、field 区域检测中都有稳定的字段注释与字段说明。

**架构：** 先修 `pydyna` 生成适配层，使宽字段也输出 `$#` 注释头，并为 `ID/MPP/TITLE` 等 title-order 后缀与 `A-F/G` 后置 option 生成组合 snippet。再在运行时 hover 解析里加入 `$#` 注释头优先匹配，避免真实 deck 或旧 snippet 中卡片行顺序与 pydyna 的 pre-option 顺序不一致时 hover 错位。

**技术栈：** Python 生成器与 unittest；TypeScript VS Code extension core；Mocha/Node 测试；现有 `keywords/generate_from_pydyna.py` 生成链路。

---

## 文件结构

工作区根目录：`D:\Project\vscode-lsdyna`

- 修改：`D:\Project\vscode-lsdyna\keywords\pydyna_schema_adapter.py`
  - 负责从 `pydyna/codegen` 生成 `snippets/lsdyna.json` 与 `keywords/field_data.json` 的中间 schema。
  - 本计划只在这里调整 snippet 渲染，不改 pydyna 上游数据。

- 修改：`D:\Project\vscode-lsdyna\keywords\tests\test_pydyna_schema_adapter.py`
  - 负责生成器行为测试。
  - 新增失败测试锁定 `MAT_024_TITLE` 宽字段注释和 `CONTACT_*_ID_MPP_OPTION_F` 组合 snippet。

- 重新生成：`D:\Project\vscode-lsdyna\snippets\lsdyna.json`
  - 生成后的 VS Code snippet 入口。

- 重新生成：`D:\Project\vscode-lsdyna\keywords\field_data.json`
  - 英文字段 hover schema。
  - 此文件大概率只因生成统计或结构同步改变；如果 diff 显示无变化，保持不提交。

- 重新同步：`D:\Project\vscode-lsdyna\keywords\field_data_zh.json`
  - 中文字段 hover schema，继续由 `validate_field_data_translation.py` 保持结构同步。

- 修改：`D:\Project\vscode-lsdyna\src\core\keywordSchema.ts`
  - 负责运行时关键字 schema lookup、option 渲染、field hover 行匹配。
  - 新增基于上一条 `$#` 注释行的 card 匹配 fallback。

- 修改：`D:\Project\vscode-lsdyna\test\core\keywordSchema.test.js`
  - 负责运行时 resolver 单元测试。
  - 新增 `CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP` 在缺少 pre-option 数据行但有 `$#` 注释行时仍能匹配正确字段的测试。

---

### 任务 1：为生成器缺口编写失败测试

**文件：**
- 修改：`D:\Project\vscode-lsdyna\keywords\tests\test_pydyna_schema_adapter.py`

- [ ] **步骤 1：新增宽字段注释测试**

在 `PydynaSchemaAdapterTest` 中加入：

```python
    def test_wide_single_field_snippet_keeps_comment_header(self):
        snippet = self.snippets["*MAT_024_TITLE"]

        self.assertEqual("*MAT_024_TITLE", snippet["body"][0])
        self.assertTrue(snippet["body"][1].startswith("$#"))
        self.assertIn("title", snippet["body"][1].lower())
        self.assertEqual("${1:TITLE}", snippet["body"][2])
```

- [ ] **步骤 2：新增后缀与后置 option 组合 snippet 测试**

在同一测试类中加入：

```python
    def test_contact_title_variant_post_option_snippet_combines_cards(self):
        snippet = self.snippets["*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_OPTION_F"]
        body_text = "\n".join(snippet["body"]).lower()

        self.assertEqual("*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP", snippet["body"][0])
        self.assertIn("*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_F", snippet["prefix"])
        self.assertIn("CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP + Optional Cards A-F", snippet["description"])

        for field_name in ["ignore", "mpp2", "cid", "ssid", "soft", "pstiff"]:
            self.assertIn(field_name, body_text)

        self.assertLess(body_text.index("ignore"), body_text.index("cid"))
        self.assertLess(body_text.index("cid"), body_text.index("ssid"))
        self.assertLess(body_text.index("ssid"), body_text.index("soft"))
        self.assertLess(body_text.index("soft"), body_text.index("pstiff"))
```

- [ ] **步骤 3：运行 Python 生成器测试并确认失败**

运行：

```powershell
python -m unittest keywords.tests.test_pydyna_schema_adapter.PydynaSchemaAdapterTest.test_wide_single_field_snippet_keeps_comment_header keywords.tests.test_pydyna_schema_adapter.PydynaSchemaAdapterTest.test_contact_title_variant_post_option_snippet_combines_cards
```

预期：

```text
FAILED
```

失败原因应分别指向：
- `*MAT_024_TITLE` 的 `body[1]` 当前是 `${1:TITLE}`，不是 `$#` 注释行。
- `*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_OPTION_F` 当前不存在。

- [ ] **步骤 4：Commit 测试**

```powershell
git add keywords/tests/test_pydyna_schema_adapter.py
git commit -m "test: cover keyword option field comment generation"
```

---

### 任务 2：修复 snippet 生成器

**文件：**
- 修改：`D:\Project\vscode-lsdyna\keywords\pydyna_schema_adapter.py`
- 测试：`D:\Project\vscode-lsdyna\keywords\tests\test_pydyna_schema_adapter.py`

- [ ] **步骤 1：让宽单字段也输出 `$#` 注释头**

在 `_build_snippet()` 中替换宽字段分支为：

```python
        if len(card) == 1 and card[0].get("w", 0) >= WIDE_FIELD_THRESHOLD:
            body.append(_comment_header(card))
            body.append(f'${{{tab}:{card[0]["n"]}}}')
            tab += 1
            continue
```

预期 `*MAT_024_TITLE` snippet 从：

```json
[
  "*MAT_024_TITLE",
  "${1:TITLE}",
  "$#     mid        ro ..."
]
```

变为：

```json
[
  "*MAT_024_TITLE",
  "$#                                                                         title",
  "${1:TITLE}",
  "$#     mid        ro ..."
]
```

- [ ] **步骤 2：抽取连续后置 option 链**

在 `_post_option_index()` 之后加入：

```python
def _post_option_chain(entry: dict[str, Any]) -> list[dict[str, Any]]:
    post_options = [
        option
        for option in entry.get("o", [])
        if _post_option_index(option) is not None and len(option["n"]) == 1 and "A" <= option["n"] <= "Z"
    ]
    if not post_options:
        return []

    post_options = sorted(post_options, key=lambda option: _post_option_index(option) or 0)
    expected = ord("A")
    chain: list[dict[str, Any]] = []
    for option in post_options:
        if ord(option["n"]) != expected:
            break
        chain.append(option)
        expected += 1
    return chain
```

- [ ] **步骤 3：用 helper 重写 `_add_post_option_snippets()`**

将 `_add_post_option_snippets()` 替换为：

```python
def _add_post_option_snippets(name: str, entry: dict[str, Any], snippets: dict[str, dict[str, Any]]) -> None:
    chain = _post_option_chain(entry)
    if not chain:
        return

    for option in chain:
        active_post = [candidate for candidate in chain if candidate["n"] <= option["n"]]
        rendered_cards = _render_cards(entry["c"], active_post)
        snippet_key = f"*{name}_OPTION_{option['n']}"
        snippet = _build_snippet(name, rendered_cards, description=f"{name} + Optional Cards A-{option['n']}")
        snippet["prefix"] = [f"*{name}_{option['n']}", f"{name}_{option['n']}", snippet["prefix"][0], name]
        snippets[snippet_key] = snippet

    title_options = _title_variant_options(entry.get("o", []))
    if not title_options:
        return

    combination_count = (2 ** len(title_options)) - 1
    if combination_count > TITLE_VARIANT_LIMIT:
        return

    for size in range(1, len(title_options) + 1):
        for selected in itertools.combinations(title_options, size):
            selected_options = list(selected)
            active_title = [option["n"] for option in sorted(selected_options, key=lambda option: option["to"])]
            variant_name = f"{name}_{'_'.join(active_title)}"
            for option in chain:
                active_post = [candidate for candidate in chain if candidate["n"] <= option["n"]]
                rendered_cards = _render_cards(entry["c"], selected_options + active_post)
                snippet_key = f"*{variant_name}_OPTION_{option['n']}"
                snippet = _build_snippet(
                    variant_name,
                    rendered_cards,
                    description=f"{variant_name} + Optional Cards A-{option['n']}",
                )
                snippet["prefix"] = [
                    f"*{variant_name}_{option['n']}",
                    f"{variant_name}_{option['n']}",
                    f"*{variant_name}",
                    variant_name,
                ]
                snippets[snippet_key] = snippet
```

- [ ] **步骤 4：运行任务 1 的失败测试并确认通过**

运行：

```powershell
python -m unittest keywords.tests.test_pydyna_schema_adapter.PydynaSchemaAdapterTest.test_wide_single_field_snippet_keeps_comment_header keywords.tests.test_pydyna_schema_adapter.PydynaSchemaAdapterTest.test_contact_title_variant_post_option_snippet_combines_cards
```

预期：

```text
OK
```

- [ ] **步骤 5：运行完整 Python 生成器测试**

运行：

```powershell
python -m unittest keywords.tests.test_pydyna_schema_adapter
```

预期：

```text
OK
```

- [ ] **步骤 6：Commit 生成器修复**

```powershell
git add keywords/pydyna_schema_adapter.py
git commit -m "fix: generate field comments for keyword option variants"
```

---

### 任务 3：重新生成 snippet 与 field_data

**文件：**
- 重新生成：`D:\Project\vscode-lsdyna\snippets\lsdyna.json`
- 重新生成：`D:\Project\vscode-lsdyna\keywords\field_data.json`
- 重新同步：`D:\Project\vscode-lsdyna\keywords\field_data_zh.json`

- [ ] **步骤 1：运行生成器**

```powershell
python keywords/generate_from_pydyna.py
```

预期输出包含：

```text
Written ... snippets to D:\Project\vscode-lsdyna\snippets\lsdyna.json
Written ... keyword definitions to D:\Project\vscode-lsdyna\keywords\field_data.json
Synchronized localized fallback data to D:\Project\vscode-lsdyna\keywords\field_data_zh.json
Generation stats:
```

- [ ] **步骤 2：验证两个用户例子**

运行：

```powershell
@'
const fs = require('fs');
const snippets = JSON.parse(fs.readFileSync('snippets/lsdyna.json', 'utf8'));
for (const key of [
  '*MAT_024_TITLE',
  '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP',
  '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_OPTION_F'
]) {
  const snippet = snippets[key];
  console.log(key, snippet ? 'FOUND' : 'MISSING');
  if (snippet) {
    console.log(snippet.body.slice(0, 8).join('\n'));
  }
}
'@ | node -
```

预期：

```text
*MAT_024_TITLE FOUND
```

并且 `*MAT_024_TITLE` 的第二行是 `$# ... title`。

```text
*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_OPTION_F FOUND
```

并且 body 中同时出现 `ignore/mpp2/cid/ssid/soft/pstiff` 对应的 `$#` 注释行。

- [ ] **步骤 3：验证中文 schema 结构同步**

```powershell
python keywords/validate_field_data_translation.py
```

预期：

```text
field_data translation structure check PASS
```

- [ ] **步骤 4：查看生成文件 diff**

```powershell
git diff -- snippets/lsdyna.json keywords/field_data.json keywords/field_data_zh.json
```

预期：
- `snippets/lsdyna.json` 新增宽字段 `$#` 注释行。
- `snippets/lsdyna.json` 新增 `*_ID_MPP_OPTION_F` 等后缀与 post option 组合 snippet。
- `field_data.json` 与 `field_data_zh.json` 不应出现无关结构破坏。

- [ ] **步骤 5：Commit 生成产物**

```powershell
git add snippets/lsdyna.json keywords/field_data.json keywords/field_data_zh.json
git commit -m "chore: regenerate keyword snippets and field data"
```

---

### 任务 4：为 hover 注释行 fallback 编写失败测试

**文件：**
- 修改：`D:\Project\vscode-lsdyna\test\core\keywordSchema.test.js`

- [ ] **步骤 1：新增 `CONTACT_ID_MPP` 注释行优先匹配测试**

在 `describe('keywordSchema resolver', ...)` 中加入：

```javascript
    it('uses field comment headers before line-count fallback for CONTACT option variants', () => {
        const { getCardForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP',
            '$#    ssid      msid     sstyp     mstyp    sboxid    mboxid       spr       mpr',
            '',
            '$#      fs        fd        dc        vc       vdc    penchk        bt        dt',
            '       0.0       0.0       0.0       0.0       0.0         0       0.0       0.0',
            '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
            '                 0.1         0     1.025         2         2                   1',
            '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac',
            '         0         0                 2.0         0         0         0       0.0'
        ].join('\n'));

        const ssid = getCardForDocumentLine(doc, 2);
        assert.ok(ssid);
        assert.equal(ssid[0].n, 'SSID');

        const fs = getCardForDocumentLine(doc, 4);
        assert.ok(fs);
        assert.equal(fs[0].n, 'FS');

        const soft = getCardForDocumentLine(doc, 6);
        assert.ok(soft);
        assert.equal(soft[0].n, 'SOFT');

        const pstiff = getCardForDocumentLine(doc, 8);
        assert.ok(pstiff);
        assert.equal(pstiff[0].n, 'PSTIFF');
    });
```

- [ ] **步骤 2：运行单测并确认失败**

运行：

```powershell
npm run compile
npx mocha --require test/register-out.js test/core/keywordSchema.test.js --grep "field comment headers"
```

预期：

```text
failing
```

失败原因应体现当前 resolver 仍按数据行计数优先，`*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP` 会把第一条数据行匹配到 `IGNORE/BCKT/...`。

- [ ] **步骤 3：Commit 测试**

```powershell
git add test/core/keywordSchema.test.js
git commit -m "test: cover field comment header card matching"
```

---

### 任务 5：实现 hover 注释行 fallback

**文件：**
- 修改：`D:\Project\vscode-lsdyna\src\core\keywordSchema.ts`
- 测试：`D:\Project\vscode-lsdyna\test\core\keywordSchema.test.js`

- [ ] **步骤 1：新增注释头解析 helper**

在 `countDataLinesThrough()` 前加入：

```typescript
function normalizeFieldLabel(value: string): string {
    return normalizeKeywordName(value).replace(/^_/, '');
}

function parseCommentHeaderLabels(lineText: string): string[] {
    const trimmed = lineText.trimStart();
    if (!trimmed.startsWith('$#')) {
        return [];
    }

    return trimmed
        .slice(2)
        .trim()
        .split(/\s+/)
        .map(normalizeFieldLabel)
        .filter(Boolean);
}

function previousCommentHeaderLabels(document: any, keywordLine: number, lineNum: number): string[] {
    for (let index = lineNum - 1; index > keywordLine; index--) {
        const text = document.lineAt(index).text;
        const trimmed = text.trimStart();
        if (trimmed.trim().length === 0) {
            continue;
        }
        if (trimmed.startsWith('$#')) {
            return parseCommentHeaderLabels(text);
        }
        return [];
    }
    return [];
}
```

- [ ] **步骤 2：新增 comment header card 匹配 helper**

在 `postOptions()` 后加入：

```typescript
function cardHeaderScore(card: KeywordCard, labels: string[]): number {
    if (labels.length === 0 || card.length === 0) {
        return 0;
    }

    const fieldNames = new Set(card.map(field => normalizeFieldLabel(field.n)));
    let score = 0;
    for (const label of labels) {
        if (fieldNames.has(label)) {
            score++;
        }
    }

    if (score === 0) {
        return 0;
    }

    const firstField = normalizeFieldLabel(card[0].n);
    if (labels[0] === firstField) {
        score += 1;
    }
    return score;
}

function renderHeaderCandidateCards(entry: KeywordEntry, activeOptions: string[]): KeywordCard[] {
    const selectedNames = new Set(activeOptions.map(normalizeKeywordName));
    for (const option of postOptions(entry, selectedNames)) {
        selectedNames.add(optionName(option));
    }

    const selectedOptions = (entry.o || []).filter(option => selectedNames.has(optionName(option)));
    return renderSelectedOptions(entry.c || [], selectedOptions);
}

function findCardByCommentHeader(entry: KeywordEntry, activeOptions: string[], labels: string[]): KeywordCard | null {
    const candidates = renderHeaderCandidateCards(entry, activeOptions);
    let bestCard: KeywordCard | null = null;
    let bestScore = 0;

    for (const card of candidates) {
        const score = cardHeaderScore(card, labels);
        if (score > bestScore) {
            bestScore = score;
            bestCard = card;
        }
    }

    const minimumScore = Math.max(2, Math.ceil(labels.length * 0.6));
    return bestScore >= minimumScore ? bestCard : null;
}
```

- [ ] **步骤 3：在 `getCardForDocumentLine()` 中优先使用 `$#` 注释头**

在 `const observedDataLineCount = countDataLinesThrough(...)` 前加入：

```typescript
    const headerLabels = previousCommentHeaderLabels(document, keywordLine, lineNum);
    const headerCard = findCardByCommentHeader(lookup.entry, lookup.activeOptions, headerLabels);
    if (headerCard) {
        return headerCard;
    }
```

保留原有 line-count fallback：

```typescript
    const observedDataLineCount = countDataLinesThrough(document, keywordLine, lineNum);
    if (observedDataLineCount <= 0) {
        return null;
    }

    const rendered = getRenderedCards(lookup.entry, lookup.activeOptions, observedDataLineCount);
    return rendered[observedDataLineCount - 1] || null;
```

- [ ] **步骤 4：运行新增 JS 单测并确认通过**

```powershell
npm run compile
npx mocha --require test/register-out.js test/core/keywordSchema.test.js --grep "field comment headers"
```

预期：

```text
passing
```

- [ ] **步骤 5：运行完整 resolver 测试**

```powershell
npm run compile
npx mocha --require test/register-out.js test/core/keywordSchema.test.js
```

预期：

```text
passing
```

- [ ] **步骤 6：Commit hover fallback**

```powershell
git add src/core/keywordSchema.ts test/core/keywordSchema.test.js
git commit -m "fix: match keyword fields from comment headers"
```

---

### 任务 6：全量验证与打包前检查

**文件：**
- 验证：`D:\Project\vscode-lsdyna\package.json`
- 验证：`D:\Project\vscode-lsdyna\keywords\tests`
- 验证：`D:\Project\vscode-lsdyna\test`

- [ ] **步骤 1：运行 Python 生成器测试**

```powershell
python -m unittest keywords.tests.test_pydyna_schema_adapter keywords.tests.test_field_data_translation
```

预期：

```text
OK
```

- [ ] **步骤 2：运行完整 JS 测试**

```powershell
npm test
```

预期：

```text
passing
```

- [ ] **步骤 3：运行一次针对用户例子的 resolver 验证**

```powershell
@'
const { getCardForDocumentLine } = require('./out/core/keywordSchema');
const lines = [
  '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP',
  '$#    ssid      msid     sstyp     mstyp    sboxid    mboxid       spr       mpr',
  '',
  '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
  '                 0.1         0     1.025         2         2                   1',
  '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac',
  '         0         0                 2.0         0         0         0       0.0'
];
const doc = { lineCount: lines.length, lineAt: i => ({ text: lines[i] }) };
for (const line of [2, 4, 6]) {
  const card = getCardForDocumentLine(doc, line);
  console.log(line, card && card.map(field => field.n).join(','));
}
'@ | node -
```

预期：

```text
2 SSID,MSID,SSTYP,MSTYP,SBOXID,MBOXID,SPR,MPR
4 SOFT,SOFSCL,LCIDAB,MAXPAR,SBOPT,DEPTH,BSORT,FRCFRQ
6 PSTIFF,IGNROFF,FSTOL,2DBINR,SSFTYP,SWTPR,TETFAC
```

- [ ] **步骤 4：检查没有计划外文件变更**

```powershell
git status --short
```

预期只包含本计划范围内文件，或为空。

- [ ] **步骤 5：最终 commit**

如果任务 6 发现需要补充小修，完成后提交：

```powershell
git add keywords/pydyna_schema_adapter.py keywords/tests/test_pydyna_schema_adapter.py snippets/lsdyna.json keywords/field_data.json keywords/field_data_zh.json src/core/keywordSchema.ts test/core/keywordSchema.test.js
git commit -m "fix: complete keyword option field comments"
```

如果前面每个任务都已经独立 commit，且任务 6 没有新增变更，则不创建空 commit。

---

### 任务 7：Push 与交付说明

**文件：**
- Git 分支：当前工作分支。

- [ ] **步骤 1：确认提交历史**

```powershell
git log --oneline -5
```

预期能看到本计划产生的测试、生成器、生成产物、hover fallback 相关提交。

- [ ] **步骤 2：推送当前分支**

```powershell
git push
```

如果当前分支没有 upstream，运行：

```powershell
git push -u origin HEAD
```

- [ ] **步骤 3：交付说明**

最终回复包含：
- 宽字段 `$#` 注释已覆盖，例如 `*MAT_024_TITLE`。
- title-order 后缀与后置 option 组合 snippet 已覆盖，例如 `*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP_OPTION_F`。
- hover resolver 已能在有 `$#` 注释行时优先按注释匹配字段，避免 `CONTACT_ID_MPP` 样例错位。
- 已运行的验证命令和结果。
- push 的分支名。

---

## 自检

**规格覆盖度：**
- `*MAT_024_TITLE` 缺 `$# title` 注释：任务 1、2、3 覆盖。
- `CONTACT` 类 `ID/MPP + A-F` 组合 snippet 缺失：任务 1、2、3 覆盖。
- `field hover` 在真实 deck 中按行数错位：任务 4、5、6 覆盖。
- `field_data_zh.json` 结构同步：任务 3、6 覆盖。
- 过程及时 commit/push：任务 1、2、3、4、5、6、7 覆盖。

**占位符扫描：**
- 计划中没有 `TODO`、`待定`、`后续实现`。
- 每个代码修改步骤都给出具体插入或替换代码。
- 每个验证步骤都有命令和预期结果。

**类型一致性：**
- Python helper 使用现有 `dict[str, Any]`、`list[dict[str, Any]]` 风格。
- TypeScript helper 使用现有 `KeywordEntry`、`KeywordCard`、`KeywordOption` 类型。
- JS 测试沿用现有 `fakeDoc` 与 `require('../../src/core/keywordSchema')` 入口。

