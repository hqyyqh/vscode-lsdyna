# Curve/Table 字段 Hover 可视化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 当鼠标悬浮在 LS-DYNA keyword card 中引用 `*DEFINE_CURVE*` 或 `*DEFINE_TABLE*` 的字段上时，在 Hover 中毫秒级展示对应定义摘要、静态可视化预览，并提供跳转到定义关键字的链接；字段引用语义和定义索引在目录树扫描阶段预先生成并缓存，Hover 不做项目级识别。

**架构：** 在 keyword schema 之上增加机器可读的字段引用语义层，离线/构建期生成 `keywords/field_reference_index.json`，运行时按 keyword/card/field 直接查 JSON；用现有 `FileIndex.keywordBlocks` 和 `BlockReader` 在项目索引阶段抽取 curve/table 定义，随 `FileIndex.referenceDefinitions` 和 `ProjectSnapshot.fileIndexes` 缓存。Hover 阶段只读取当前字段值并查询内存中的项目引用索引，渲染安全 Markdown/SVG 预览和命令链接；没有可用项目索引时只尝试当前文件的已缓存 FileIndex，仍不触发全项目磁盘扫描。

**技术栈：** TypeScript、Node.js Buffer/fs、VS Code Hover MarkdownString/command URI、现有 ProjectSnapshot/FileIndex 缓存、Mocha。

---

## 可行性与必要性评估

### 可行性结论

功能可行，且适合建立在当前高性能扫描与索引架构上。关键原因：

- `ProjectSnapshot.fileIndexes` 已经缓存了全项目文件、keyword block byte range 和 include 关系，能够承载 curve/table 定义索引。
- `LsdynaFieldHoverProvider` 已经能定位当前 keyword card、field、字段列范围和帮助文本，适合作为展示入口。
- `keywords/field_data.json` 中 `LCSS` 等字段的帮助文本已经包含 “Load curve ID or Table ID” 语义，但当前缺少机器可读引用类型，需要补一层显式 metadata/规则。
- VS Code Hover 支持 Markdown、command link 和静态 image。使用安全的 `data:image/svg+xml;base64,...` 可生成无脚本、无外部依赖的曲线预览。

### 稳健性判断

稳健方案必须满足四条原则：

1. 字段是否引用 curve/table 不能只靠字段名猜测。优先使用显式 `keywords/field_reference_overrides.json`，再用高置信帮助文本规则补充。
2. Hover 期间不能读全项目文件。定义解析必须发生在 FileIndex 构建/项目快照阶段，Hover 只查内存 Map。
3. 字段引用判定必须预生成成 JSON 并随扩展加载到内存。Hover 不做帮助文本正则扫描，只做 O(1) lookup。
4. 可视化必须可降级。无法绘图时仍显示定义位置、数据表摘要和跳转链接。
5. 不求一次覆盖所有 LS-DYNA 引用类型。本计划只覆盖 curve/table/function-curve 引用，不加入 part/set/node/material 等其它 ID 引用。

### 主要风险与处理方式

- **同一 ID 同时存在 curve 和 table：** Hover 显示 ambiguity，列出所有候选定义，不擅自选择。
- **重复定义同一 curve/table ID：** Hover 标注 duplicate definitions，并按项目 include 顺序列出。
- **字段值为 `0`、空白、非整数或 `&PARAM`：** 视为未定义或动态引用；显示普通字段 Hover，不绘图。
- **curve 点中含 `&PARAM` 或表达式：** 保留原始行摘要；SVG 只绘制可解析的数值点，并显示 skipped non-numeric rows 计数。
- **`*DEFINE_CURVE_FUNCTION`：** 无离散点时不画曲线，只展示 function 文本摘要和跳转链接。
- **Hover Markdown 对 SVG 支持因 VS Code 版本差异异常：** 测试 Markdown 输出结构；运行时若 SVG 为空则显示 Markdown table fallback。
- **未保存编辑导致 snapshot 过期：** 当前文档字段值以 TextDocument 为准；定义索引来自最近 snapshot。若定义块本身正在未保存修改，第一阶段不解析未保存 definition。
- **大 table/curve：** 预览只采样最多 200 个点，Markdown 表格只展示前 8 行和总数。
- **扫描等待：** 目录树扫描仍可能明显耗时。手动触发 `Scan Include Tree` / `Scan Keyword Index` 时使用既有进度入口建立缓存；Hover 在扫描完成前显示“需要先扫描目录树以索引跨文件 curve/table 定义”的轻量提示。如果当前文件的 FileIndex 已有定义，则直接预览当前文件定义，不要求项目扫描完成。
- **大文件扫描：** 沿用 `lsdyna.scanner.fullScanLargeFiles` 作为显式开关。默认不为了 Hover 自动开启大文件全量扫描；用户手动扫描目录树时才承担该等待成本。
- **安全：** 所有 label/title/function 文本进行 Markdown/SVG escaping；command URI 只传 `{ filePath, lineIndex, character }`，命令内部再校验参数类型。

### 收益与必要性

收益高，尤其对汽车整车 crash/NVH/occupant safety deck：

- 材料、载荷、边界运动和失效模型大量依赖 `LCID/LCSS/LCSR/TBID`；Hover 直接看到曲线形态能显著减少打开多个 include 文件查找定义的上下文切换。
- 对 `*MAT_PIECEWISE_LINEAR_PLASTICITY` 的 `LCSS` 这类“curve 或 table 二义字段”，可快速判断实际使用的是单条应力-塑性应变曲线还是应变率表。
- 对大型 include 项目，结合现有 FileIndex 后能做到 O(1) 定义查找，不会重回慢扫描。

必要性为中高。它不是求解必需功能，但对模型审查、参数核查、材料曲线校验和新人理解 deck 非常有价值。建议作为当前高性能索引架构验证后的第一类“语义消费”功能实施。

---

## LS-DYNA 语义边界

本功能扫描所有以 `*DEFINE_CURVE` 或 `*DEFINE_TABLE` 开头的定义关键字，并按可视化能力分级：

- **可绘制 curve：** `*DEFINE_CURVE*` 中首张数据卡可解析出 curve ID，后续数据行可解析为 X/Y 点。包含 `_TITLE` 时读取标题；包含 `_FUNCTION` 时作为 function curve，只展示函数摘要，不画离散点。
- **可展示 table：** `*DEFINE_TABLE*` 中首张数据卡可解析出 table ID，后续数据行可解析为 `value -> child ID`。`*DEFINE_TABLE_3D*` 的 child ID 指向 table，其它 table 默认指向 curve。
- **暂不画但索引：** 其它以 `*DEFINE_CURVE` 或 `*DEFINE_TABLE` 开头、格式无法稳定解析的扩展变体仍记录 keyword/id/位置；Hover 显示定义位置与原始摘要，不生成曲线图。
- **不纳入：** `*DEFINE_FUNCTION`、`*DEFINE_VECTOR`、`*DEFINE_COORDINATE*` 等不是 curve/table 前缀的定义，即使语义上可能影响曲线，也不在本目标内。

本轮需要显式扫描 schema 中的 `DEFINE_CURVE*` / `DEFINE_TABLE*` 关键字，并在验证记录中列出：

- 已支持绘制/展示的关键字集合。
- 仅索引位置、暂不绘制的关键字集合。
- schema 中不存在但 scanner 可按前缀容忍处理的未来变体。

字段引用支持范围：

- `targetKinds: ['curve']`：只解析到 curve/function-curve。
- `targetKinds: ['table']`：只解析到 table。
- `targetKinds: ['curve', 'table']`：先按实际定义查找；若两类都存在则显示二义。
- `0`、空白、非数字 token 不触发可视化。
- 字段值是整数才触发引用解析。负整数默认按 LS-DYNA 常见开关语义取绝对值搜索 ID，同时在 Hover 中保留原始负号并标注“negative switch stripped for lookup”；显式 override 可设置 `allowSignedSwitch: false` 禁止这种行为。

`*MAT_PIECEWISE_LINEAR_PLASTICITY` 的 `LCSS` 必须作为第一批显式规则：

```json
{
  "MAT_PIECEWISE_LINEAR_PLASTICITY": {
    "2:LCSS": {
      "targetKinds": ["curve", "table"],
      "label": "effective stress versus effective plastic strain",
      "allowNegative": false
    },
    "2:LCSR": {
      "targetKinds": ["curve"],
      "label": "strain rate scaling effect on yield stress",
      "allowNegative": false
    }
  },
  "MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE": {
    "2:LCSS": {
      "targetKinds": ["curve", "table"],
      "label": "effective stress versus effective plastic strain",
      "allowNegative": false
    },
    "2:LCSR": {
      "targetKinds": ["curve"],
      "label": "strain rate scaling effect on yield stress",
      "allowNegative": false
    }
  }
}
```

## 字段引用扫描与 JSON 索引方案

新增 `keywords/field_reference_index.json`，由脚本从 `keywords/field_data.json` 与 `keywords/field_reference_overrides.json` 生成并提交到仓库。运行时 `fieldReferenceClassifier` 只读取这个 JSON，不在 Hover 中执行推断。

生成规则：

1. 遍历所有 keyword schema entry 的所有 card/field，记录 1-based `cardIndex`、`fieldName`、`fieldType`、`position`、`width`。
2. 只考虑 `field.t === "integer"` 的字段；LS-DYNA 负数开关通过 `allowSignedSwitch: true` 表示，解析时用 `Math.abs(id)` 查找定义。
3. 显式 overrides 优先，适合 `LCSS` 这类 curve/table 二义字段、或帮助文本不稳定但工程上确定的字段。
4. 高置信自动规则只接受帮助文本包含 `load curve id`、`curve id`、`table id`、`*DEFINE_CURVE`、`*DEFINE_TABLE` 等明确语义的整数字段；仅字段名像 `LCID` 但帮助文本没有曲线/表语义时不纳入，避免误识别其它 ID。
5. JSON 结构以 keyword 为第一层、`cardIndex:FIELD` 为第二层，便于 Hover 直接 lookup。每条记录包含 `targetKinds`、`confidence`、`source`、`allowSignedSwitch`、`label`。
6. 测试读取生成 JSON，确保 `MAT_PIECEWISE_LINEAR_PLASTICITY` 的 `LCSS` 为 `["curve","table"]`，普通 `MID` 不出现，且至少覆盖一批由 schema 自动识别的 `LCID/TBID` 字段。

缓存策略：

- `referenceDefinitions` 存在于每个 `FileIndex`，和 `keywordBlocks/includeEntries` 一起进入 L1 内存缓存、L1.5 file scan disk cache、L2 project snapshot disk cache。
- 引入 `SCANNER_VERSION = 2`，使旧 file scan payload 自动失效，避免旧缓存缺少 `referenceDefinitions`。
- 不新增独立 curve/table cache 文件。复用现有 per-file signature + scanner version 更简单、更少失效状态，也天然支持过期删除和 LRU project snapshot cache。
- 保持默认 `PROJECT_SNAPSHOT_DISK_CACHE_BYTES = 256MB`。这是比“按时间过期”更好的默认：LS-DYNA 工程可能长时间不变，时间过期会制造无意义重扫；容量驱逐能控制磁盘占用且保留常用项目热缓存。

用户提示策略：

- Hover 命中 curve/table 引用但内存项目索引为空时，显示当前字段普通说明并附加一句提示：`Run Scan Include Tree to index cross-file curve/table definitions.`。
- 如果当前文件 FileIndex 已缓存且含该 ID 定义，直接展示预览，不显示目录树扫描提示。
- 手动目录树扫描完成后，`cacheReferenceIndexFromSnapshot()` 建立项目级 Map，之后 Hover 只读内存。

---

## 文件结构

- 创建：`keywords/field_reference_overrides.json` - 高置信字段引用显式规则。
- 创建：`keywords/field_reference_index.json` - 由 schema/overrides 生成的运行时字段引用索引。
- 创建：`scripts/generate-field-reference-index.cjs` - 生成并校验字段引用索引。
- 修改：`src/core/keywordSchema.ts` - 为 `KeywordField` 增加可选引用 metadata 类型，不改变现有 schema 读取行为。
- 创建：`src/core/references/fieldReferenceClassifier.ts` - 根据 keyword/card/field 判断是否为 curve/table 引用字段。
- 创建：`src/core/references/curveTableDefinitionScanner.ts` - 从 `FileIndex.keywordBlocks` 解析 curve/table/function 定义。
- 创建：`src/core/references/projectReferenceIndex.ts` - 聚合项目级 ID Map，并提供 O(1) resolve。
- 创建：`src/core/references/curvePlotRenderer.ts` - 生成安全 SVG data URI 与 Markdown fallback。
- 创建：`src/core/references/fieldReferenceHover.ts` - 组合字段值、定义解析结果和 Hover Markdown section。
- 修改：`src/core/scanner/scannerContracts.ts` - 增加 `SCANNER_VERSION`，扩展 `FileIndex.referenceDefinitions` 契约。
- 修改：`src/core/scanner/fileIndexBuilder.ts` - 构建 FileIndex 时抽取 `referenceDefinitions`。
- 修改：`src/core/cache/fileScanCacheStore.ts` - scanner version 升级后旧 FileIndex 缓存失效。
- 修改：`src/core/cache/snapshotSerializer.ts` - 确认 `referenceDefinitions` 随 fileIndexes JSON 往返。
- 修改：`src/extension.ts` - 缓存项目引用索引、增强 `LsdynaFieldHoverProvider`、注册跳转命令。
- 修改：`package.json`、`package.nls.json`、`package.nls.zh-cn.json` - 注册 `extension.openLsdynaReferenceDefinition` 命令及本地化标题。
- 测试：`test/core/references/fieldReferenceClassifier.test.js`
- 测试：`test/core/references/fieldReferenceIndex.test.js`
- 测试：`test/core/references/curveTableDefinitionScanner.test.js`
- 测试：`test/core/references/projectReferenceIndex.test.js`
- 测试：`test/core/references/curvePlotRenderer.test.js`
- 测试：`test/extension.test.js`
- 测试：`test/core/scanner/fileIndexBuilder.test.js`
- 测试：`test/core/cache/fileScanCacheStore.test.js`
- 测试：`test/core/cache/snapshotSerializer.test.js`

---

## 数据契约

```typescript
type ReferenceTargetKind = 'curve' | 'table' | 'functionCurve';

type FieldReferenceInfo = {
    keyword: string;
    cardIndex: number;
    fieldName: string;
    targetKinds: ReferenceTargetKind[];
    label?: string;
    allowNegative?: boolean;
    confidence: 'explicit' | 'high';
};

type CurvePoint = {
    xRaw: string;
    yRaw: string;
    x: number | null;
    y: number | null;
    lineIndex: number;
};

type CurveDefinition = {
    kind: 'curve' | 'functionCurve';
    id: number;
    idRaw: string;
    keyword: string;
    filePath: string;
    startLine: number;
    endLine: number;
    title?: string;
    points: CurvePoint[];
    functionText?: string;
    scale?: { sfa?: number; sfo?: number; offa?: number; offo?: number };
};

type TableRow = {
    valueRaw: string;
    value: number | null;
    childIdRaw: string;
    childId: number | null;
    childKind: 'curve' | 'table';
    lineIndex: number;
};

type TableDefinition = {
    kind: 'table';
    tableType: '1d' | '2d' | '3d';
    id: number;
    idRaw: string;
    keyword: string;
    filePath: string;
    startLine: number;
    endLine: number;
    title?: string;
    rows: TableRow[];
    scale?: { sfa?: number; offa?: number };
};

type FileReferenceDefinitions = {
    curves: CurveDefinition[];
    tables: TableDefinition[];
};

type ProjectReferenceIndex = {
    curvesById: Map<number, CurveDefinition[]>;
    tablesById: Map<number, TableDefinition[]>;
    files: string[];
};
```

---

## 任务 1：建立字段引用判别层

**文件：**
- 创建：`keywords/field_reference_overrides.json`
- 修改：`src/core/keywordSchema.ts`
- 创建：`src/core/references/fieldReferenceClassifier.ts`
- 创建：`test/core/references/fieldReferenceClassifier.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const keywordSchema = require('../../../out/core/keywordSchema');
const {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('../../../out/core/references/fieldReferenceClassifier');

describe('fieldReferenceClassifier', () => {
    it('classifies MAT_024 LCSS as curve or table from explicit override', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const field = lookup.entry.c[1].find(item => item.n === 'LCSS');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 2,
            field,
        });

        assert.deepEqual(info.targetKinds, ['curve', 'table']);
        assert.equal(info.confidence, 'explicit');
    });

    it('does not classify MID as curve or table', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const field = lookup.entry.c[0].find(item => item.n === 'MID');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 1,
            field,
        });

        assert.equal(info, null);
    });

    it('parses only valid positive integer reference values by default', () => {
        assert.deepEqual(parseFieldReferenceValue('      1001', { allowNegative: false }), { id: 1001, raw: '1001' });
        assert.equal(parseFieldReferenceValue('         0', { allowNegative: false }), null);
        assert.equal(parseFieldReferenceValue('     &LCSS', { allowNegative: false }), null);
        assert.equal(parseFieldReferenceValue('        -7', { allowNegative: false }), null);
    });
});
```

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceClassifier.test.js`
预期：FAIL，模块不存在。

- [ ] **步骤 2：添加 override JSON**

创建 `keywords/field_reference_overrides.json`：

```json
{
  "MAT_PIECEWISE_LINEAR_PLASTICITY": {
    "2:LCSS": {
      "targetKinds": ["curve", "table"],
      "label": "effective stress versus effective plastic strain",
      "allowNegative": false
    },
    "2:LCSR": {
      "targetKinds": ["curve"],
      "label": "strain rate scaling effect on yield stress",
      "allowNegative": false
    }
  },
  "MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE": {
    "2:LCSS": {
      "targetKinds": ["curve", "table"],
      "label": "effective stress versus effective plastic strain",
      "allowNegative": false
    },
    "2:LCSR": {
      "targetKinds": ["curve"],
      "label": "strain rate scaling effect on yield stress",
      "allowNegative": false
    }
  }
}
```

- [ ] **步骤 3：扩展 keyword schema 类型**

在 `src/core/keywordSchema.ts` 的 `KeywordField` 中增加：

```typescript
    ref?: {
        targetKinds?: string[];
        label?: string;
        allowNegative?: boolean;
    };
```

不改变 `loadKeywordSchema()` 的 JSON 合并逻辑。

- [ ] **步骤 4：实现 classifier**

创建 `src/core/references/fieldReferenceClassifier.ts`，核心导出：

```typescript
'use strict';

const fs = require('fs');
const path = require('path');

type ReferenceTargetKind = 'curve' | 'table' | 'functionCurve';

let overrideCache = null;

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function loadOverrides() {
    if (overrideCache) return overrideCache;
    const filePath = path.join(__dirname, '..', '..', '..', 'keywords', 'field_reference_overrides.json');
    try {
        overrideCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        overrideCache = {};
    }
    return overrideCache;
}

function normalizeTargetKinds(values) {
    const allowed = new Set(['curve', 'table', 'functionCurve']);
    return (values || []).filter(value => allowed.has(value));
}

function getExplicitOverride(keyword, cardIndex, fieldName) {
    const overrides = loadOverrides();
    const keywordRules = overrides[normalizeKeyword(keyword)] || {};
    return keywordRules[`${cardIndex}:${normalizeFieldName(fieldName)}`] || null;
}

function inferHighConfidenceReference(field) {
    const name = normalizeFieldName(field?.n);
    const help = String(field?.h || '').toLowerCase();
    const text = `${name} ${help}`;
    if (field?.t !== 'integer') return null;

    const mentionsCurve = /\b(load\s+curve|curve\s+id|\blcid\b|\blc[a-z0-9_]*\b)/i.test(text);
    const mentionsTable = /\b(table\s+id|\btbid\b)/i.test(text);
    if (mentionsCurve && mentionsTable) return { targetKinds: ['curve', 'table'], confidence: 'high' };
    if (mentionsCurve) return { targetKinds: ['curve'], confidence: 'high' };
    if (mentionsTable) return { targetKinds: ['table'], confidence: 'high' };
    return null;
}

function getFieldReferenceInfo({ keyword, cardIndex, field }) {
    if (!field) return null;
    const explicit = getExplicitOverride(keyword, cardIndex, field.n);
    if (explicit) {
        return {
            keyword: normalizeKeyword(keyword),
            cardIndex,
            fieldName: normalizeFieldName(field.n),
            targetKinds: normalizeTargetKinds(explicit.targetKinds),
            label: explicit.label,
            allowNegative: explicit.allowNegative === true,
            confidence: 'explicit',
        };
    }

    const inferred = inferHighConfidenceReference(field);
    if (!inferred) return null;
    return {
        keyword: normalizeKeyword(keyword),
        cardIndex,
        fieldName: normalizeFieldName(field.n),
        targetKinds: inferred.targetKinds,
        label: undefined,
        allowNegative: false,
        confidence: inferred.confidence,
    };
}

function parseFieldReferenceValue(rawValue, info) {
    const raw = String(rawValue || '').trim();
    if (!raw) return null;
    if (!/^-?\d+$/.test(raw)) return null;
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id === 0) return null;
    if (id < 0 && !info?.allowNegative) return null;
    return { id, raw };
}

module.exports = {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
};

export {};
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceClassifier.test.js`
预期：3 passing。

- [ ] **步骤 6：Commit**

```bash
git add keywords/field_reference_overrides.json src/core/keywordSchema.ts src/core/references/fieldReferenceClassifier.ts test/core/references/fieldReferenceClassifier.test.js
git commit -m "feat: classify curve and table reference fields"
```

---

## 任务 2：解析 curve/table 定义块

**文件：**
- 创建：`src/core/references/curveTableDefinitionScanner.ts`
- 创建：`test/core/references/curveTableDefinitionScanner.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');
const { readBlockText } = require('../../../out/core/scanner/blockReader');
const { scanCurveTableDefinitionsFromFileIndex } = require('../../../out/core/references/curveTableDefinitionScanner');

async function buildFileIndex(filePath) {
    return {
        filePath,
        keywordBlocks: await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 64 }),
    };
}

describe('scanCurveTableDefinitionsFromFileIndex', () => {
    it('parses DEFINE_CURVE_TITLE id, title, scale and numeric points', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-curve-'));
        const filePath = path.join(dir, 'curves.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE_TITLE',
            'Steel hardening',
            '$#    lcid      sidr       sfa       sfo      offa      offo',
            '      1001         0       2.0       3.0       1.0      -1.0',
            '$#                a1                  o1',
            '                 0.0               100.0',
            '                 1.0               200.0',
            '*END',
        ].join('\\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.curves.length, 1);
            assert.equal(result.curves[0].id, 1001);
            assert.equal(result.curves[0].title, 'Steel hardening');
            assert.equal(result.curves[0].scale.sfa, 2);
            assert.deepEqual(result.curves[0].points.map(point => [point.x, point.y]), [[0, 100], [1, 200]]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('parses DEFINE_TABLE_2D rows as value to curve id', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-table-'));
        const filePath = path.join(dir, 'table.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_TABLE_2D_TITLE',
            'rate table',
            '$#    tbid       sfa      offa',
            '      2001       1.0       0.0',
            '$#             value             curveId',
            '               0.01                1001',
            '                1.0                1002',
            '*END',
        ].join('\\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.tables.length, 1);
            assert.equal(result.tables[0].id, 2001);
            assert.equal(result.tables[0].tableType, '2d');
            assert.deepEqual(result.tables[0].rows.map(row => [row.value, row.childId, row.childKind]), [
                [0.01, 1001, 'curve'],
                [1.0, 1002, 'curve'],
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps non-numeric curve rows as raw rows without crashing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-symbolic-'));
        const filePath = path.join(dir, 'symbolic.k');
        fs.writeFileSync(filePath, '*DEFINE_CURVE\\n1001\\n&x0 &y0\\n1.0 2.0\\n');

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.curves[0].points.length, 2);
            assert.equal(result.curves[0].points[0].x, null);
            assert.equal(result.curves[0].points[0].xRaw, '&x0');
            assert.equal(result.curves[0].points[1].x, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/curveTableDefinitionScanner.test.js`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现定义扫描器**

创建 `src/core/references/curveTableDefinitionScanner.ts`，实现以下导出：

```typescript
const DEFINE_CURVE_PREFIXES = new Set([
    '*DEFINE_CURVE',
    '*DEFINE_CURVE_TITLE',
    '*DEFINE_CURVE_FUNCTION',
    '*DEFINE_CURVE_FUNCTION_TITLE',
]);

const DEFINE_TABLE_PREFIXES = new Set([
    '*DEFINE_TABLE',
    '*DEFINE_TABLE_TITLE',
    '*DEFINE_TABLE_2D',
    '*DEFINE_TABLE_2D_TITLE',
    '*DEFINE_TABLE_3D',
    '*DEFINE_TABLE_3D_TITLE',
]);

async function scanCurveTableDefinitionsFromFileIndex(fileIndex, readKeywordBlockText) {
    const curves = [];
    const tables = [];
    for (const block of fileIndex.keywordBlocks || []) {
        const keyword = String(block.keyword || '').toUpperCase();
        if (!isReferenceDefinitionKeyword(keyword)) continue;
        const text = await readKeywordBlockText(block);
        const lines = splitMeaningfulLines(text, block.startLine);
        if (keyword.startsWith('*DEFINE_CURVE')) {
            const curve = parseCurveBlock(keyword, block, lines);
            if (curve) curves.push(curve);
            continue;
        }
        if (keyword.startsWith('*DEFINE_TABLE')) {
            const table = parseTableBlock(keyword, block, lines);
            if (table) tables.push(table);
        }
    }
    return { curves, tables };
}
```

实现细节：

- `splitMeaningfulLines(text, startLine)` 返回 `{ text, lineIndex }[]`，跳过空行与 `$` 注释行。
- `_TITLE` 关键字的第一个 meaningful line 是 title，下一行才是 ID card。
- `parseFixedOrWhitespaceFields(line, widths)` 先按固定宽度提取非空 token；如果固定宽度结果少于 2 个，则用 whitespace split。
- `parseNumberToken(token)` 对 `1.0`、`1.0E-3` 返回 number，对 `&param`、空白、表达式返回 null。
- `parseIntegerToken(token)` 只接受整数 token，返回 `{ id, raw }` 或 null。
- `*DEFINE_CURVE_FUNCTION*` 解析 `LCID` 和 function text，不生成 points。
- `*DEFINE_TABLE_3D*` 的 row childKind 为 `table`，其它 table row childKind 为 `curve`。

- [ ] **步骤 3：运行定义扫描器测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/curveTableDefinitionScanner.test.js`
预期：3 passing。

- [ ] **步骤 4：Commit**

```bash
git add src/core/references/curveTableDefinitionScanner.ts test/core/references/curveTableDefinitionScanner.test.js
git commit -m "feat: scan curve and table definitions from file index"
```

---

## 任务 3：把定义索引接入 FileIndex 与缓存版本

**文件：**
- 修改：`src/core/scanner/scannerContracts.ts`
- 修改：`src/core/scanner/fileIndexBuilder.ts`
- 修改：`src/core/cache/fileScanCacheStore.ts`
- 修改：`src/core/cache/snapshotSerializer.ts`
- 修改：`test/core/scanner/fileIndexBuilder.test.js`
- 修改：`test/core/cache/fileScanCacheStore.test.js`
- 修改：`test/core/cache/snapshotSerializer.test.js`

- [ ] **步骤 1：编写失败测试**

在 `test/core/scanner/fileIndexBuilder.test.js` 增加：

```javascript
it('includes curve and table reference definitions in the file index', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-ref-'));
    const filePath = path.join(dir, 'refs.k');
    fs.writeFileSync(filePath, [
        '*DEFINE_CURVE',
        '      1001',
        '       0.0       0.0',
        '       1.0       1.0',
        '*DEFINE_TABLE',
        '      2001',
        '       0.0      1001',
    ].join('\\n'));

    try {
        const index = await buildFileIndex(filePath, { highWaterMark: 32 });
        assert.equal(index.referenceDefinitions.curves[0].id, 1001);
        assert.equal(index.referenceDefinitions.tables[0].id, 2001);
        assert.ok(index.scannerVersion >= 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
```

在 `test/core/cache/fileScanCacheStore.test.js` 增加旧 scanner version 缓存失效断言，构造 `fileIndex.scannerVersion: 1` 时 `get()` 返回 null。

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/fileIndexBuilder.test.js test/core/cache/fileScanCacheStore.test.js`
预期：FAIL，`referenceDefinitions` 不存在或 version 不匹配。

- [ ] **步骤 2：升级 scanner contract**

在 `src/core/scanner/scannerContracts.ts`：

```typescript
const SCANNER_VERSION = 2;
```

补充 `FileIndex.referenceDefinitions` 的 JSDoc/类型说明，结构为：

```typescript
referenceDefinitions: {
    curves: CurveDefinition[];
    tables: TableDefinition[];
};
```

- [ ] **步骤 3：修改 fileIndexBuilder**

在 `src/core/scanner/fileIndexBuilder.ts` 引入：

```typescript
const { scanCurveTableDefinitionsFromFileIndex } = require('../references/curveTableDefinitionScanner');
```

构建流程中在 includeResult 后增加：

```typescript
const partialIndex = {
    filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    scannerVersion: SCANNER_VERSION,
    keywordBlocks,
};
const referenceDefinitions = await scanCurveTableDefinitionsFromFileIndex(
    partialIndex,
    block => readBlockText(block)
);
```

返回对象加入：

```typescript
referenceDefinitions,
```

- [ ] **步骤 4：确保 snapshot JSON 往返**

`snapshotSerializer` 当前会把完整 `fileIndexes` 作为普通对象数组序列化。测试中加入：

```javascript
referenceDefinitions: {
    curves: [{ id: 1001, kind: 'curve', filePath: childFile, keyword: '*DEFINE_CURVE', startLine: 10, endLine: 13, points: [] }],
    tables: [],
},
```

并断言 hydrate 后该字段保留。

- [ ] **步骤 5：运行相关测试**

运行：

```bash
npm run compile && npx mocha --require test/register-out.js test/core/scanner/fileIndexBuilder.test.js test/core/cache/fileScanCacheStore.test.js test/core/cache/snapshotSerializer.test.js
```

预期：全部 passing。

- [ ] **步骤 6：Commit**

```bash
git add src/core/scanner/scannerContracts.ts src/core/scanner/fileIndexBuilder.ts src/core/cache/fileScanCacheStore.ts src/core/cache/snapshotSerializer.ts test/core/scanner/fileIndexBuilder.test.js test/core/cache/fileScanCacheStore.test.js test/core/cache/snapshotSerializer.test.js
git commit -m "feat: cache curve and table definitions in file indexes"
```

---

## 任务 4：建立项目级 O(1) 引用索引

**文件：**
- 创建：`src/core/references/projectReferenceIndex.ts`
- 创建：`test/core/references/projectReferenceIndex.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const path = require('path');
const {
    buildProjectReferenceIndex,
    resolveReferenceDefinitions,
} = require('../../../out/core/references/projectReferenceIndex');

describe('projectReferenceIndex', () => {
    it('resolves curve and table ids in O(1) maps', () => {
        const filePath = path.resolve('main.k');
        const snapshot = {
            files: [filePath],
            fileIndexes: new Map([[
                filePath,
                {
                    filePath,
                    referenceDefinitions: {
                        curves: [{ kind: 'curve', id: 1001, filePath, keyword: '*DEFINE_CURVE', startLine: 4, endLine: 8, points: [] }],
                        tables: [{ kind: 'table', id: 2001, tableType: '2d', filePath, keyword: '*DEFINE_TABLE_2D', startLine: 9, endLine: 13, rows: [] }],
                    },
                },
            ]]),
        };

        const index = buildProjectReferenceIndex(snapshot);

        assert.equal(index.curvesById.get(1001).length, 1);
        assert.equal(index.tablesById.get(2001).length, 1);
        assert.deepEqual(resolveReferenceDefinitions(index, 1001, ['curve']).map(item => item.id), [1001]);
        assert.deepEqual(resolveReferenceDefinitions(index, 2001, ['curve', 'table']).map(item => item.id), [2001]);
    });

    it('preserves duplicate definitions for hover ambiguity reporting', () => {
        const fileA = path.resolve('a.k');
        const fileB = path.resolve('b.k');
        const makeCurve = filePath => ({ kind: 'curve', id: 7, filePath, keyword: '*DEFINE_CURVE', startLine: 1, endLine: 4, points: [] });
        const snapshot = {
            files: [fileA, fileB],
            fileIndexes: new Map([
                [fileA, { filePath: fileA, referenceDefinitions: { curves: [makeCurve(fileA)], tables: [] } }],
                [fileB, { filePath: fileB, referenceDefinitions: { curves: [makeCurve(fileB)], tables: [] } }],
            ]),
        };

        const index = buildProjectReferenceIndex(snapshot);
        assert.equal(resolveReferenceDefinitions(index, 7, ['curve']).length, 2);
    });
});
```

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/projectReferenceIndex.test.js`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 projectReferenceIndex**

创建 `src/core/references/projectReferenceIndex.ts`：

```typescript
'use strict';

function addToMap(map, id, definition) {
    if (!Number.isFinite(id)) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(definition);
}

function fileIndexEntries(snapshot) {
    if (!snapshot || !snapshot.fileIndexes) return [];
    if (snapshot.fileIndexes instanceof Map) return [...snapshot.fileIndexes.entries()];
    return Object.entries(snapshot.fileIndexes);
}

function buildProjectReferenceIndex(snapshot) {
    const curvesById = new Map();
    const tablesById = new Map();
    const files = [];

    for (const [filePath, fileIndex] of fileIndexEntries(snapshot)) {
        files.push(filePath);
        const refs = fileIndex.referenceDefinitions || { curves: [], tables: [] };
        for (const curve of refs.curves || []) addToMap(curvesById, curve.id, curve);
        for (const table of refs.tables || []) addToMap(tablesById, table.id, table);
    }

    return { curvesById, tablesById, files };
}

function resolveReferenceDefinitions(index, id, targetKinds) {
    const results = [];
    if (!index || !Number.isFinite(id)) return results;
    if ((targetKinds || []).includes('curve')) {
        results.push(...(index.curvesById.get(id) || []));
    }
    if ((targetKinds || []).includes('table')) {
        results.push(...(index.tablesById.get(id) || []));
    }
    if ((targetKinds || []).includes('functionCurve')) {
        results.push(...(index.curvesById.get(id) || []).filter(item => item.kind === 'functionCurve'));
    }
    return results;
}

module.exports = {
    buildProjectReferenceIndex,
    resolveReferenceDefinitions,
};

export {};
```

- [ ] **步骤 3：运行测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/projectReferenceIndex.test.js`
预期：2 passing。

- [ ] **步骤 4：Commit**

```bash
git add src/core/references/projectReferenceIndex.ts test/core/references/projectReferenceIndex.test.js
git commit -m "feat: build project curve table reference index"
```

---

## 任务 5：实现安全 SVG 与 Markdown 可视化

**文件：**
- 创建：`src/core/references/curvePlotRenderer.ts`
- 创建：`test/core/references/curvePlotRenderer.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
} = require('../../../out/core/references/curvePlotRenderer');

describe('curvePlotRenderer', () => {
    it('renders safe SVG data URI for numeric curve points', () => {
        const uri = renderCurveSvgDataUri({
            title: 'stress < plastic strain',
            xLabel: 'x',
            yLabel: 'y',
            points: [
                { x: 0, y: 0, xRaw: '0', yRaw: '0', lineIndex: 1 },
                { x: 1, y: 2, xRaw: '1', yRaw: '2', lineIndex: 2 },
            ],
        });

        assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
        const svg = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
        assert.ok(svg.includes('&lt;'));
        assert.ok(!svg.includes('<script'));
        assert.ok(!svg.includes('NaN'));
    });

    it('returns null when fewer than two numeric points exist', () => {
        const uri = renderCurveSvgDataUri({
            title: 'symbolic',
            points: [{ x: null, y: null, xRaw: '&x', yRaw: '&y', lineIndex: 1 }],
        });
        assert.equal(uri, null);
    });

    it('renders markdown fallback table with capped rows', () => {
        const md = renderCurveMarkdownFallback({
            points: Array.from({ length: 10 }, (_, index) => ({
                xRaw: String(index),
                yRaw: String(index * 2),
                x: index,
                y: index * 2,
                lineIndex: index + 1,
            })),
        }, 3);

        assert.ok(md.includes('| x | y |'));
        assert.ok(md.includes('7 more rows'));
    });
});
```

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/curvePlotRenderer.test.js`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 renderer**

创建 `src/core/references/curvePlotRenderer.ts`，包含：

```typescript
function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function numericPoints(points) {
    return (points || []).filter(point =>
        Number.isFinite(point.x) && Number.isFinite(point.y)
    );
}

function renderCurveSvgDataUri({ title = 'Curve', xLabel = 'x', yLabel = 'y', points = [] }) {
    const data = numericPoints(points);
    if (data.length < 2) return null;
    const sampled = samplePoints(data, 200);
    const bounds = computeBounds(sampled);
    const polyline = sampled.map(point => `${scaleX(point.x, bounds)},${scaleY(point.y, bounds)}`).join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220" viewBox="0 0 420 220">` +
        `<rect width="420" height="220" fill="#1e1e1e"/>` +
        `<text x="12" y="20" fill="#cccccc" font-size="12">${escapeXml(title)}</text>` +
        `<line x1="42" y1="184" x2="400" y2="184" stroke="#777"/>` +
        `<line x1="42" y1="34" x2="42" y2="184" stroke="#777"/>` +
        `<polyline fill="none" stroke="#4fc1ff" stroke-width="2" points="${polyline}"/>` +
        `<text x="190" y="210" fill="#aaaaaa" font-size="10">${escapeXml(xLabel)}</text>` +
        `<text x="4" y="112" fill="#aaaaaa" font-size="10" transform="rotate(-90 10 112)">${escapeXml(yLabel)}</text>` +
        `</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
```

同时实现 `samplePoints`、`computeBounds`、`scaleX`、`scaleY` 和 `renderCurveMarkdownFallback(definition, maxRows = 8)`。

- [ ] **步骤 3：运行 renderer 测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/curvePlotRenderer.test.js`
预期：3 passing。

- [ ] **步骤 4：Commit**

```bash
git add src/core/references/curvePlotRenderer.ts test/core/references/curvePlotRenderer.test.js
git commit -m "feat: render curve table hover previews"
```

---

## 任务 6：组合 Hover 引用 section

**文件：**
- 创建：`src/core/references/fieldReferenceHover.ts`
- 创建：`test/core/references/fieldReferenceHover.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const { buildReferenceHoverSection } = require('../../../out/core/references/fieldReferenceHover');

describe('fieldReferenceHover', () => {
    it('renders curve preview section with definition command link', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 1001,
            definitions: [{
                kind: 'curve',
                id: 1001,
                keyword: '*DEFINE_CURVE',
                filePath: 'C:/model/main.k',
                startLine: 10,
                endLine: 14,
                title: 'hardening',
                points: [
                    { x: 0, y: 0, xRaw: '0', yRaw: '0', lineIndex: 12 },
                    { x: 1, y: 2, xRaw: '1', yRaw: '2', lineIndex: 13 },
                ],
            }],
        });

        assert.ok(section.includes('LCSS reference'));
        assert.ok(section.includes('*DEFINE_CURVE'));
        assert.ok(section.includes('command:extension.openLsdynaReferenceDefinition'));
        assert.ok(section.includes('data:image/svg+xml;base64,'));
    });

    it('renders unresolved reference message', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 9999,
            definitions: [],
        });

        assert.ok(section.includes('No matching curve/table definition found'));
    });

    it('renders table rows and child ids', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                endLine: 25,
                rows: [
                    { valueRaw: '0.01', value: 0.01, childIdRaw: '1001', childId: 1001, childKind: 'curve', lineIndex: 23 },
                ],
            }],
        });

        assert.ok(section.includes('| value | curve ID |'));
        assert.ok(section.includes('1001'));
    });
});
```

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceHover.test.js`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 Hover section builder**

创建 `src/core/references/fieldReferenceHover.ts`：

```typescript
const { renderCurveSvgDataUri, renderCurveMarkdownFallback } = require('./curvePlotRenderer');

function encodeCommandArgs(args) {
    return encodeURIComponent(JSON.stringify([args]));
}

function definitionLink(definition) {
    const args = encodeCommandArgs({
        filePath: definition.filePath,
        lineIndex: definition.startLine || 0,
        character: 0,
    });
    return `[$(go-to-file) Open definition](command:extension.openLsdynaReferenceDefinition?${args} "Open definition")`;
}

function buildReferenceHoverSection({ fieldName, id, definitions }) {
    const lines = [
        '',
        '---',
        '',
        `**$(graph-line) ${fieldName} reference:** \`${id}\``,
    ];

    if (!definitions || definitions.length === 0) {
        lines.push('', `$(warning) No matching curve/table definition found for ID \`${id}\`.`);
        return lines.join('\n');
    }

    if (definitions.length > 1) {
        lines.push('', `$(warning) ${definitions.length} matching definitions found. Review duplicates/ambiguity before trusting the preview.`);
    }

    for (const definition of definitions.slice(0, 4)) {
        lines.push('', `**${definition.keyword}** in \`${definition.filePath}\``, definitionLink(definition));
        if (definition.kind === 'curve') appendCurvePreview(lines, definition);
        if (definition.kind === 'functionCurve') appendFunctionPreview(lines, definition);
        if (definition.kind === 'table') appendTablePreview(lines, definition);
    }

    if (definitions.length > 4) {
        lines.push('', `${definitions.length - 4} more definitions omitted from hover.`);
    }
    return lines.join('\n');
}
```

实现 `appendCurvePreview`、`appendFunctionPreview`、`appendTablePreview`：

- curve：优先 SVG，随后显示前 8 行 fallback table。
- functionCurve：显示 fenced code block，最多 8 行。
- table：显示 `| value | curve ID |` 或 `| value | table ID |`，最多 8 行。

- [ ] **步骤 3：运行 Hover section 测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceHover.test.js`
预期：3 passing。

- [ ] **步骤 4：Commit**

```bash
git add src/core/references/fieldReferenceHover.ts test/core/references/fieldReferenceHover.test.js
git commit -m "feat: build curve table hover markdown sections"
```

---

## 任务 7：接入 VS Code Hover 与跳转命令

**文件：**
- 修改：`src/extension.ts`
- 修改：`package.json`
- 修改：`package.nls.json`
- 修改：`package.nls.zh-cn.json`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：编写失败测试**

在 `test/extension.test.js` 的 `LsdynaFieldHoverProvider` describe 中增加：

```javascript
it('appends curve preview and definition link for LCSS references from cached file index', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-curve-'));
    const filePath = path.join(tempRoot, 'main.k');
    const doc = fakeDoc([
        '*MAT_PIECEWISE_LINEAR_PLASTICITY',
        '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
        '         1       7.8     210.0       0.3     400.0       0.0',
        '$#       c         p      lcss      lcsr        vp',
        '       0.0       0.0      1001         0       0.0',
    ].join('\\n'), filePath);
    doc.languageId = 'lsdyna';

    const fileIndex = {
        filePath,
        referenceDefinitions: {
            curves: [{
                kind: 'curve',
                id: 1001,
                keyword: '*DEFINE_CURVE',
                filePath,
                startLine: 10,
                endLine: 13,
                points: [
                    { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                    { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                ],
            }],
            tables: [],
        },
    };

    try {
        cacheFileIndexesFromSnapshot({
            rootFile: filePath,
            files: [filePath],
            fileIndexes: new Map([[filePath, fileIndex]]),
        });
        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('**LCSS**'));
        assert.ok(value.includes('LCSS reference'));
        assert.ok(value.includes('*DEFINE_CURVE'));
        assert.ok(value.includes('command:extension.openLsdynaReferenceDefinition'));
        assert.ok(value.includes('data:image/svg+xml;base64,'));
    } finally {
        setFileIndexForTesting(filePath, null);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
```

再增加命令注册测试，使用已有 VS Code mock 的命令注册集合，确认 `extension.openLsdynaReferenceDefinition` 存在并会调用 `vscode.open` 或 `showTextDocument`。

运行：`npm run compile && npx mocha --require test/register-out.js test/extension.test.js --grep "LCSS references|openLsdynaReferenceDefinition"`
预期：FAIL，Hover 未附加引用 section。

- [ ] **步骤 2：在 extension 中缓存 project reference index**

在 `src/extension.ts` 顶部引入：

```typescript
const {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('./core/references/fieldReferenceClassifier');
const {
    buildProjectReferenceIndex,
    resolveReferenceDefinitions,
} = require('./core/references/projectReferenceIndex');
const { buildReferenceHoverSection } = require('./core/references/fieldReferenceHover');
```

新增缓存：

```typescript
const activeProjectReferenceIndexCache = new Map();

function normalizeSnapshotRootKey(rootFile) {
    return normalizeFileIndexKey(rootFile);
}

function cacheReferenceIndexFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.rootFile) return;
    const key = normalizeSnapshotRootKey(snapshot.rootFile);
    activeProjectReferenceIndexCache.set(key, {
        snapshot,
        referenceIndex: buildProjectReferenceIndex(snapshot),
    });
}

function getReferenceIndexForDocument(document) {
    const docKey = normalizeFileIndexKey(document.uri.fsPath);
    for (const cached of activeProjectReferenceIndexCache.values()) {
        const files = cached.snapshot.files || [];
        if (files.some(filePath => normalizeFileIndexKey(filePath) === docKey)) {
            return cached.referenceIndex;
        }
    }
    const fileIndex = getFileIndexForDocument(document);
    if (!fileIndex) return null;
    return buildProjectReferenceIndex({
        rootFile: document.uri.fsPath,
        files: [document.uri.fsPath],
        fileIndexes: new Map([[document.uri.fsPath, fileIndex]]),
    });
}
```

在 `indexClient.loadProjectSnapshot` wrapper 中调用：

```typescript
cacheReferenceIndexFromSnapshot(snapshot);
```

并导出 `_internals.cacheReferenceIndexFromSnapshot` 以便测试。

- [ ] **步骤 3：增强 field Hover**

在 `LsdynaFieldHoverProvider.provideHover()` 中，取得 `field` 后计算 cardIndex：

```typescript
const cardInfo = keywordSchema.getCardInfoForDocumentLine
    ? keywordSchema.getCardInfoForDocumentLine(document, position.line, getFieldData())
    : null;
```

如果不新增 `getCardInfoForDocumentLine`，在当前函数内通过 keyword line 到 position line 的 data line count 得到 1-based `cardIndex`。推荐在 `keywordSchema.ts` 增加 `getCardInfoForDocumentLine()` 返回 `{ card, cardIndex, keywordName }`，并让旧 `getCardForDocumentLine()` 复用它。

字段值读取：

```typescript
const rawFieldValue = text.slice(field.p, field.p + field.w);
const referenceInfo = getFieldReferenceInfo({
    keyword: kwName,
    cardIndex,
    field,
});
const referenceValue = referenceInfo ? parseFieldReferenceValue(rawFieldValue, referenceInfo) : null;
if (referenceInfo && referenceValue) {
    const referenceIndex = getReferenceIndexForDocument(document);
    const definitions = resolveReferenceDefinitions(referenceIndex, referenceValue.id, referenceInfo.targetKinds);
    md.appendMarkdown(buildReferenceHoverSection({
        fieldName: field.n,
        id: referenceValue.id,
        definitions,
    }));
}
```

要求：没有 `referenceIndex` 时不抛错，只保留普通 field Hover。

- [ ] **步骤 4：注册跳转命令**

在 `package.json` 的 commands 中加入：

```json
{
  "command": "extension.openLsdynaReferenceDefinition",
  "title": "%commands.openLsdynaReferenceDefinition.title%",
  "icon": "$(go-to-file)"
}
```

在 `package.nls.json`：

```json
"commands.openLsdynaReferenceDefinition.title": "Open LS-DYNA Reference Definition"
```

在 `package.nls.zh-cn.json`：

```json
"commands.openLsdynaReferenceDefinition.title": "打开 LS-DYNA 引用定义"
```

在 `activate()` 中注册：

```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('extension.openLsdynaReferenceDefinition', async (target) => {
        if (!target || typeof target.filePath !== 'string') return;
        const lineIndex = Number.isFinite(target.lineIndex) ? target.lineIndex : 0;
        const character = Number.isFinite(target.character) ? target.character : 0;
        const uri = vscode.Uri.file(target.filePath);
        const pos = new vscode.Position(lineIndex, character);
        const range = new vscode.Range(pos, pos);
        await vscode.commands.executeCommand('vscode.open', uri, { selection: range, preview: false });
    })
);
```

- [ ] **步骤 5：运行 Hover 集成测试**

运行：

```bash
npm run compile && npx mocha --require test/register-out.js test/extension.test.js --grep "LCSS references|openLsdynaReferenceDefinition"
```

预期：相关测试 passing。

- [ ] **步骤 6：Commit**

```bash
git add src/extension.ts package.json package.nls.json package.nls.zh-cn.json test/extension.test.js
git commit -m "feat: show curve table previews in field hover"
```

---

## 任务 8：补齐 keywordSchema cardInfo 支撑

**文件：**
- 修改：`src/core/keywordSchema.ts`
- 修改：`test/core/keywordSchema.test.js`
- 修改：`src/extension.ts`

- [ ] **步骤 1：编写失败测试**

在 `test/core/keywordSchema.test.js` 增加：

```javascript
it('returns card info with keyword name and one-based card index', () => {
    const keywordSchema = require('../../src/core/keywordSchema');
    const doc = {
        lineCount: 5,
        lineAt(index) {
            return { text: [
                '*MAT_PIECEWISE_LINEAR_PLASTICITY',
                '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
                '         1       7.8     210.0       0.3     400.0       0.0',
                '$#       c         p      lcss      lcsr        vp',
                '       0.0       0.0      1001         0       0.0',
            ][index] };
        },
    };

    const info = keywordSchema.getCardInfoForDocumentLine(doc, 4, keywordSchema.loadKeywordSchema(() => 'en'));

    assert.equal(info.keywordName, 'MAT_PIECEWISE_LINEAR_PLASTICITY');
    assert.equal(info.cardIndex, 2);
    assert.ok(info.card.some(field => field.n === 'LCSS'));
});
```

运行：`npm run compile && npx mocha --require test/register-out.js test/core/keywordSchema.test.js --grep "card info"`
预期：FAIL，函数不存在。

- [ ] **步骤 2：实现 getCardInfoForDocumentLine**

在 `src/core/keywordSchema.ts` 中抽取现有 `getCardForDocumentLine()` 的逻辑，新增：

```typescript
export function getCardInfoForDocumentLine(
    document: any,
    lineNum: number,
    schema: KeywordSchema = loadKeywordSchema(),
): { card: KeywordCard; cardIndex: number; keywordName: string; activeOptions: string[] } | null {
    // 复用当前 keywordLine、lookup、comment header、observedDataLineCount 逻辑。
    // headerCard 命中时，cardIndex 取 rendered candidates 中该 card 的 1-based index。
    // fallback 按 observedDataLineCount 返回 rendered[observedDataLineCount - 1]。
}
```

修改旧函数：

```typescript
export function getCardForDocumentLine(document, lineNum, schema = loadKeywordSchema()) {
    const info = getCardInfoForDocumentLine(document, lineNum, schema);
    return info ? info.card : null;
}
```

- [ ] **步骤 3：让 extension 使用 cardInfo**

在 `LsdynaFieldHoverProvider` 中用 `cardInfo.card`、`cardInfo.cardIndex`、`cardInfo.keywordName` 代替单独推断。保留旧行为：`cardInfo` 为 null 时返回 null。

- [ ] **步骤 4：运行测试**

运行：

```bash
npm run compile && npx mocha --require test/register-out.js test/core/keywordSchema.test.js test/extension.test.js --grep "card info|LCSS references"
```

预期：相关测试 passing。

- [ ] **步骤 5：Commit**

```bash
git add src/core/keywordSchema.ts src/extension.ts test/core/keywordSchema.test.js test/extension.test.js
git commit -m "refactor: expose keyword card context for hover references"
```

---

## 任务 9：完善 table hover 的子 curve 链接

**文件：**
- 修改：`src/core/references/fieldReferenceHover.ts`
- 修改：`src/core/references/projectReferenceIndex.ts`
- 修改：`test/core/references/fieldReferenceHover.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
it('renders resolved child curve links for table rows when available', () => {
    const childCurve = {
        kind: 'curve',
        id: 1001,
        keyword: '*DEFINE_CURVE',
        filePath: 'C:/model/main.k',
        startLine: 30,
        endLine: 35,
        points: [],
    };
    const section = buildReferenceHoverSection({
        fieldName: 'LCSS',
        id: 2001,
        definitions: [{
            kind: 'table',
            tableType: '2d',
            id: 2001,
            keyword: '*DEFINE_TABLE_2D',
            filePath: 'C:/model/main.k',
            startLine: 20,
            endLine: 25,
            rows: [{ valueRaw: '0.01', value: 0.01, childIdRaw: '1001', childId: 1001, childKind: 'curve', lineIndex: 23 }],
            resolvedChildren: new Map([[1001, [childCurve]]),
        }],
    });

    assert.ok(section.includes('1001'));
    assert.ok(section.includes('Open child curve'));
    assert.ok(section.includes('lineIndex'));
});
```

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceHover.test.js --grep "child curve"`
预期：FAIL，table row 不显示 child definition 链接。

- [ ] **步骤 2：增强 table definition resolution**

在 Hover 接入处，当 `definition.kind === 'table'` 时，根据 row 的 `childKind` 和 `childId` 从 `ProjectReferenceIndex` 查子定义，注入 `resolvedChildren`：

```typescript
function attachResolvedTableChildren(definition, referenceIndex) {
    if (definition.kind !== 'table') return definition;
    const resolvedChildren = new Map();
    for (const row of definition.rows || []) {
        if (!Number.isFinite(row.childId)) continue;
        const targetKinds = row.childKind === 'table' ? ['table'] : ['curve'];
        const matches = resolveReferenceDefinitions(referenceIndex, row.childId, targetKinds);
        if (matches.length > 0) resolvedChildren.set(row.childId, matches);
    }
    return { ...definition, resolvedChildren };
}
```

在 table markdown 中每行显示 child link：

```markdown
| 0.01 | 1001 [$(go-to-file)](...) |
```

- [ ] **步骤 3：运行 table hover 测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/references/fieldReferenceHover.test.js`
预期：全部 passing。

- [ ] **步骤 4：Commit**

```bash
git add src/core/references/fieldReferenceHover.ts src/core/references/projectReferenceIndex.ts test/core/references/fieldReferenceHover.test.js
git commit -m "feat: link table hover rows to child definitions"
```

---

## 任务 10：性能、回归与验证记录

**文件：**
- 创建：`docs/superpowers/verification/2026-06-23-curve-table-field-hover-visualization.md`
- 修改：相关测试文件按前面任务结果自然更新。

- [ ] **步骤 1：运行全量测试**

运行：

```bash
npm test
```

预期：全部 passing。

- [ ] **步骤 2：运行 scanner benchmark**

运行：

```bash
npm run test:scanner-benchmark
```

预期：通过；记录 10MB deck skeleton 扫描耗时。

- [ ] **步骤 3：运行引用相关定向测试**

运行：

```bash
npx mocha --require test/register-out.js test/core/references/*.test.js
```

预期：全部 passing。

- [ ] **步骤 4：执行残留慢路径搜索**

运行：

```bash
rg -n "readFileSync\\(|createReadStream\\(|scanKeywordSkeletonFromFile\\(|buildProjectIndex\\(" src/core/references src/extension.ts
```

预期：

- `src/core/references/curveTableDefinitionScanner.ts` 可出现 block reader 相关调用。
- `src/extension.ts` 的 Hover 逻辑不得在 `provideHover()` 内直接调用 `buildProjectIndex()`、`scanKeywordSkeletonFromFile()` 或项目级磁盘扫描。

- [ ] **步骤 5：生成验证记录**

创建 `docs/superpowers/verification/2026-06-23-curve-table-field-hover-visualization.md`：

```markdown
# Curve/Table 字段 Hover 可视化验证记录

**日期：** 2026-06-23

## 验证范围

只验证 curve/table 字段引用判别、定义索引、Hover 可视化和定义跳转，不包含其它 ID 类型引用。

## 验证结果

- `npm test`：退出码 0，记录通过数量。
- `npm run test:scanner-benchmark`：退出码 0，记录 10MB deck 扫描耗时。
- `npx mocha --require test/register-out.js test/core/references/*.test.js`：退出码 0。
- 慢路径搜索：Hover provider 中无项目级磁盘扫描。

## LS-DYNA 语义样例

- `*MAT_PIECEWISE_LINEAR_PLASTICITY` card 2 的 `LCSS` 识别为 curve/table 引用。
- 当 ID 指向 `*DEFINE_CURVE` 时展示曲线预览。
- 当 ID 指向 `*DEFINE_TABLE_2D` 时展示 value -> curve ID 表格与 child curve 跳转。
```

- [ ] **步骤 6：Commit**

```bash
git add docs/superpowers/verification/2026-06-23-curve-table-field-hover-visualization.md
git commit -m "test: verify curve table hover visualization"
```

---

## 完成标准

- 悬浮在 `*MAT_PIECEWISE_LINEAR_PLASTICITY` 的 `LCSS` 字段，字段值为已定义 curve ID 时，Hover 同时显示原字段说明、curve 定义位置、静态曲线图、前几行数据和跳转链接。
- 悬浮在 `LCSS` 字段，字段值为已定义 table ID 时，Hover 显示 table 定义位置、value -> curve/table ID 列表、子定义跳转链接。
- 悬浮在无定义、重复定义或二义定义 ID 上时，Hover 明确提示状态，不崩溃。
- Hover 路径不触发全项目磁盘扫描；定义查找使用内存 Map。
- `npm test` 与 `npm run test:scanner-benchmark` 全部通过。
- 新增的 `referenceDefinitions` 能随 FileIndex 缓存和 ProjectSnapshot 序列化往返。
- 现有 include hover、manual hover、parameter hover、普通字段 hover 行为保持兼容。

---

## 不纳入本目标的内容

- 不实现可编辑曲线图。
- 不实现 Webview 图表面板。
- 不计算或求值 `*PARAMETER` 表达式。
- 不覆盖 part/set/node/material 等其它 ID 类型。
- 不做工程诊断，例如“引用曲线单位不匹配”或“材料曲线单调性错误”。
- 不修改 LS-DYNA deck 内容。
