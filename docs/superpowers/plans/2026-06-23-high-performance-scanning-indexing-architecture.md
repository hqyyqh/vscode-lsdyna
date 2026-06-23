# 高性能扫描与索引架构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立统一、完整、可缓存、可复用的 LS-DYNA 文本扫描与项目索引底座，替代重复扫描和大文件头尾扫描策略。

**架构：** 用字节流 Keyword Skeleton Scanner 生成文件级 `KeywordBlock[]`，再由 Block Reader 和 Include parser 在同一份扫描结果上派生 Include、Keyword Index、Folding、Document Symbol 等现有能力。Project indexer 只消费 `FileIndex`，文件缓存和项目快照缓存以 `scannerVersion + size + mtimeMs` 失效，所有重扫描在 worker/LSP 侧完成。

**技术栈：** TypeScript、Node.js `fs.createReadStream`/`Buffer`、Mocha、VS Code Extension API、vscode-languageclient/server、Worker Threads

---

## LS-DYNA 文本格式审查结论

从 LS-DYNA 整车仿真 deck 的实际结构看，本目标没有方向性问题，但必须保持为“文本结构索引层”，不能提前进入工程语义解析。

本架构只承认以下文本事实：

- Keyword 行由第一个非空格/Tab 字符为 `*` 判定，大小写不敏感，token 到空白、逗号、`$`、CR 或 LF 为止。
- `$` 注释行必须完全跳过，即使注释内容包含 `*PART`、`*INCLUDE` 或其它 keyword 字样，也不能生成 block。
- `*NODE`、`*ELEMENT_*` 等大数据块只作为 block 边界记录，不解析节点和单元数据。
- `*INCLUDE`、`*INCLUDE_PATH`、`*INCLUDE_PATH_RELATIVE` 的路径卡片仍由现有 include 状态机负责解释，包括续行、搜索路径和 range。
- 文件内容按字节扫描，keyword token 只按 ASCII 读取，标题、注释、路径中的非 ASCII 字符只在 Block Reader 或 include parser 需要时解码。
- 行号统一使用 0-based，和 VS Code `TextDocument.lineAt()`、`Range`、现有测试保持一致。
- Byte offset 必须以原始文件字节为准，CRLF/LF、最后一行无换行都不能破坏 block 边界。

范围边界：

- 本目标不新增上层 UI 能力。
- 本目标不新增工程语义诊断。
- 本目标不解析 keyword 字段含义。
- 本目标只让现有扫描、导航、树视图和 provider 消费统一索引。

## 文件结构

- 创建：`src/core/scanner/keywordSkeletonScanner.ts` - 字节流 keyword skeleton 扫描器。
- 创建：`src/core/scanner/blockReader.ts` - 按 byte range 读取 keyword block。
- 创建：`src/core/scanner/fileIndexBuilder.ts` - 单文件 `FileIndex` 构建入口。
- 创建：`src/core/scanner/scannerContracts.ts` - `KeywordBlock`、`FileIndex`、scan options/stats 常量和类型。
- 创建：`test/core/scanner/keywordSkeletonScanner.test.js` - scanner 正确性测试。
- 创建：`test/core/scanner/blockReader.test.js` - block reader range 测试。
- 创建：`test/core/scanner/fileIndexBuilder.test.js` - 单文件 index 聚合测试。
- 修改：`src/core/parser/includeScanner.ts` - 暴露从 block/file index 解析 include 的兼容路径。
- 修改：`src/core/parser/keywordScanner.ts` - 变成 skeleton scanner 的兼容 facade。
- 修改：`src/core/parser/blockScanner.ts` - 变成 skeleton scanner 的兼容 facade。
- 修改：`src/core/cache/fileScanCacheStore.ts` - 缓存 payload 升级为 `FileIndex`，加入 scanner version。
- 修改：`src/core/cache/snapshotSerializer.ts` - 序列化/反序列化 project snapshot 中的 file index 数据。
- 修改：`src/core/project/projectIndexer.ts` - 项目索引只加载一次 `FileIndex`，不再 keyword/include 双扫。
- 修改：`src/core/incremental/graphUpdater.ts` - 文件变更增量更新复用 `FileIndex`。
- 修改：`src/client/services/indexClient.ts` - 统一 `loadProjectSnapshot(rootFile, options, onProgress)` 签名。
- 修改：`src/server/requestRouter.ts`、`src/server/sessionManager.ts`、`src/worker/projectIndexLoader.ts`、`src/worker/scanWorker.ts` - 让 options、进度和缓存目录贯穿到 worker。
- 修改：`src/extension.ts` - 修正 index client wrapper，现有 provider 优先消费 project/file index。
- 修改：`src/client/providers/includeTreeProvider.ts`、`src/client/providers/keywordIndexProvider.ts` - 树视图消费统一 snapshot。
- 修改：相关测试：`test/core/project/projectIndexer.test.js`、`test/core/incremental/graphUpdater.test.js`、`test/client/services/indexClient.test.js`、`test/server/lspBridge.test.js`、`test/extension.test.js`。

## 数据契约

```typescript
const SCANNER_VERSION = 1;

type KeywordBlock = {
    filePath: string;
    keyword: string;
    rawKeyword: string;
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
    keywordStartChar: number;
    keywordLineEndOffset: number;
    flags: {
        isNodeBlock: boolean;
        isElementBlock: boolean;
    };
};

type FileIndex = {
    filePath: string;
    size: number;
    mtimeMs: number;
    scannerVersion: number;
    keywordBlocks: KeywordBlock[];
    includeEntries: Array<{
        lineIndex: number;
        startChar: number;
        endLineIndex: number;
        endChar: number;
        fileName: string;
        segments: Array<{ lineIndex: number; startChar: number; endChar: number }>;
    }>;
    searchPaths: string[];
    pathEntries: Array<{
        lineIndex: number;
        startChar: number;
        endLineIndex: number;
        endChar: number;
        pathName: string;
        searchPath: string;
        isRelative: boolean;
        segments: Array<{ lineIndex: number; startChar: number; endChar: number }>;
    }>;
    scanStats: {
        mode: 'stream-skeleton' | 'text-document' | 'cache';
        durationMs: number;
        decodedLineCount: number;
        keywordCount: number;
    };
};
```

## 任务 1：建立 scanner 合同与测试夹具

**文件：**
- 创建：`src/core/scanner/scannerContracts.ts`
- 创建：`test/core/scanner/keywordSkeletonScanner.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');

function writeFixture(name, text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-skeleton-'));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, text);
    return filePath;
}

describe('scanKeywordSkeletonFromFile', () => {
    it('detects LS-DYNA keyword blocks without decoding data cards', async () => {
        const filePath = writeFixture('main.k', [
            '$ *PART inside comment',
            '*KEYWORD',
            '  *include',
            'body.k',
            '*NODE',
            '1,0,0,0',
            '2,1,0,0',
            '*ELEMENT_SHELL',
            '1,1,1,2,3,4',
            '*END'
        ].join('\n'));

        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 8 });
        assert.deepEqual(blocks.map(block => block.keyword), [
            '*KEYWORD',
            '*INCLUDE',
            '*NODE',
            '*ELEMENT_SHELL',
            '*END'
        ]);
        assert.equal(blocks[1].startLine, 2);
        assert.equal(blocks[1].keywordStartChar, 2);
        assert.equal(blocks[2].flags.isNodeBlock, true);
        assert.equal(blocks[3].flags.isElementBlock, true);
        assert.ok(blocks[1].endOffset > blocks[1].startOffset);
    });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/keywordSkeletonScanner.test.js`

预期：FAIL，错误包含 `Cannot find module '../../../out/core/scanner/keywordSkeletonScanner'`。

- [ ] **步骤 3：创建 scanner 合同**

在 `src/core/scanner/scannerContracts.ts` 中写入：

```typescript
'use strict';

const SCANNER_VERSION = 1;

function isNodeKeyword(keyword) {
    return keyword === '*NODE' || keyword.startsWith('*NODE_');
}

function isElementKeyword(keyword) {
    return keyword === '*ELEMENT' || keyword.startsWith('*ELEMENT_');
}

module.exports = {
    SCANNER_VERSION,
    isNodeKeyword,
    isElementKeyword,
};

export {};
```

- [ ] **步骤 4：提交合同和失败测试**

运行：`npm run compile`

预期：PASS。

```powershell
git add src/core/scanner/scannerContracts.ts test/core/scanner/keywordSkeletonScanner.test.js
git commit -m "test: define scanner contract for keyword skeleton"
```

## 任务 2：实现 Keyword Skeleton Scanner

**文件：**
- 创建：`src/core/scanner/keywordSkeletonScanner.ts`
- 修改：`test/core/scanner/keywordSkeletonScanner.test.js`

- [ ] **步骤 1：补充 chunk 边界和 CRLF 测试**

在 `test/core/scanner/keywordSkeletonScanner.test.js` 中追加：

```javascript
it('handles lowercase keywords, CRLF, chunk boundaries, and final line without newline', async () => {
    const filePath = writeFixture('crlf.k', '*keyword\r\n\t*part\r\n$ comment\r\n*end');
    const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 5 });

    assert.deepEqual(blocks.map(block => block.keyword), ['*KEYWORD', '*PART', '*END']);
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[1].startLine, 1);
    assert.equal(blocks[1].keywordStartChar, 1);
    assert.equal(blocks[2].endLine, 3);
    assert.equal(blocks[2].endOffset, fs.statSync(filePath).size);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/keywordSkeletonScanner.test.js`

预期：FAIL，`scanKeywordSkeletonFromFile` 尚未实现。

- [ ] **步骤 3：实现 scanner**

在 `src/core/scanner/keywordSkeletonScanner.ts` 中实现：

```typescript
'use strict';

const fs = require('fs');
const { isElementKeyword, isNodeKeyword } = require('./scannerContracts');

function isHorizontalWhitespace(byte) {
    return byte === 0x20 || byte === 0x09;
}

function isKeywordTokenTerminator(byte) {
    return byte === 0x20 || byte === 0x09 || byte === 0x2c || byte === 0x24 || byte === 0x0d || byte === 0x0a;
}

function normalizeAsciiKeyword(buffer, start, end) {
    const bytes = [];
    for (let index = start; index < end; index++) {
        const byte = buffer[index];
        if (byte >= 0x61 && byte <= 0x7a) {
            bytes.push(byte - 0x20);
        } else {
            bytes.push(byte);
        }
    }
    return Buffer.from(bytes).toString('ascii');
}

function extractKeywordFromLine(lineBuffer) {
    let index = 0;
    while (index < lineBuffer.length && isHorizontalWhitespace(lineBuffer[index])) index++;
    if (index >= lineBuffer.length) return null;
    if (lineBuffer[index] === 0x24) return null;
    if (lineBuffer[index] !== 0x2a) return null;

    const tokenStart = index;
    index++;
    while (index < lineBuffer.length && !isKeywordTokenTerminator(lineBuffer[index])) index++;
    if (index <= tokenStart + 1) return null;

    const rawKeyword = lineBuffer.toString('utf8', tokenStart, index);
    const keyword = normalizeAsciiKeyword(lineBuffer, tokenStart, index);
    return { keyword, rawKeyword, keywordStartChar: tokenStart };
}

function closePreviousBlock(blocks, nextStartOffset, nextStartLine) {
    const previous = blocks[blocks.length - 1];
    if (!previous) return;
    previous.endOffset = nextStartOffset;
    previous.endLine = Math.max(previous.startLine, nextStartLine - 1);
}

async function scanKeywordSkeletonFromFile(filePath, options = {}) {
    const stat = await fs.promises.stat(filePath);
    const stream = fs.createReadStream(filePath, {
        highWaterMark: options.highWaterMark || 1024 * 1024,
    });
    const blocks = [];
    let remainder = Buffer.alloc(0);
    let absoluteOffset = 0;
    let lineStartOffset = 0;
    let lineIndex = 0;

    async function processLine(lineBuffer, startOffset, currentLine) {
        const parsed = extractKeywordFromLine(lineBuffer);
        if (!parsed) return;
        closePreviousBlock(blocks, startOffset, currentLine);
        blocks.push({
            filePath,
            keyword: parsed.keyword,
            rawKeyword: parsed.rawKeyword,
            startOffset,
            endOffset: stat.size,
            startLine: currentLine,
            endLine: currentLine,
            keywordStartChar: parsed.keywordStartChar,
            keywordLineEndOffset: startOffset + lineBuffer.length,
            flags: {
                isNodeBlock: isNodeKeyword(parsed.keyword),
                isElementBlock: isElementKeyword(parsed.keyword),
            },
        });
    }

    try {
        for await (const chunk of stream) {
            const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
            const combinedStartOffset = absoluteOffset - remainder.length;
            let offset = 0;
            let nextNewLine = -1;

            while ((nextNewLine = combined.indexOf(0x0a, offset)) !== -1) {
                const lineBuffer = combined.subarray(offset, nextNewLine);
                const startOffset = combinedStartOffset + offset;
                await processLine(lineBuffer, startOffset, lineIndex);
                offset = nextNewLine + 1;
                lineIndex++;
                lineStartOffset = combinedStartOffset + offset;
            }

            remainder = combined.subarray(offset);
            absoluteOffset += chunk.length;
        }

        if (remainder.length > 0) {
            await processLine(remainder, lineStartOffset, lineIndex);
        }
    } finally {
        stream.destroy();
    }

    if (blocks.length > 0) {
        const last = blocks[blocks.length - 1];
        last.endOffset = stat.size;
        last.endLine = remainder.length > 0 ? lineIndex : Math.max(last.startLine, lineIndex - 1);
    }

    return blocks;
}

module.exports = {
    extractKeywordFromLine,
    scanKeywordSkeletonFromFile,
};

export {};
```

- [ ] **步骤 4：运行 scanner 测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/keywordSkeletonScanner.test.js`

预期：PASS。

- [ ] **步骤 5：提交 scanner**

```powershell
git add src/core/scanner/keywordSkeletonScanner.ts test/core/scanner/keywordSkeletonScanner.test.js
git commit -m "feat: add stream keyword skeleton scanner"
```

## 任务 3：实现 Block Reader

**文件：**
- 创建：`src/core/scanner/blockReader.ts`
- 创建：`test/core/scanner/blockReader.test.js`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');
const { readBlockText } = require('../../../out/core/scanner/blockReader');

describe('readBlockText', () => {
    it('reads only the requested LS-DYNA keyword block byte range', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-block-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nbody.k\n*END\n');

        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 6 });
        const includeBlock = blocks.find(block => block.keyword === '*INCLUDE');
        const text = await readBlockText(includeBlock);
        assert.equal(text, '*INCLUDE\nbody.k\n');
    });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/blockReader.test.js`

预期：FAIL，找不到 `blockReader`。

- [ ] **步骤 3：实现 Block Reader**

在 `src/core/scanner/blockReader.ts` 中写入：

```typescript
'use strict';

const fs = require('fs');

async function readBlockBuffer(block) {
    const length = Math.max(0, block.endOffset - block.startOffset);
    const handle = await fs.promises.open(block.filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, block.startOffset);
        return buffer;
    } finally {
        await handle.close();
    }
}

async function readBlockText(block, encoding = 'utf8') {
    const buffer = await readBlockBuffer(block);
    return buffer.toString(encoding);
}

module.exports = {
    readBlockBuffer,
    readBlockText,
};

export {};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/blockReader.test.js`

预期：PASS。

- [ ] **步骤 5：提交 Block Reader**

```powershell
git add src/core/scanner/blockReader.ts test/core/scanner/blockReader.test.js
git commit -m "feat: add keyword block reader"
```

## 任务 4：构建单文件 FileIndex

**文件：**
- 创建：`src/core/scanner/fileIndexBuilder.ts`
- 创建：`test/core/scanner/fileIndexBuilder.test.js`
- 修改：`src/core/parser/includeScanner.ts`

- [ ] **步骤 1：编写失败测试**

```javascript
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');

describe('buildFileIndex', () => {
    it('builds keyword and include data from one skeleton scan', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nsub/body.k\n*INCLUDE_PATH_RELATIVE\nincludes\n*END\n');

        const index = await buildFileIndex(filePath, { highWaterMark: 7 });
        assert.equal(index.filePath, filePath);
        assert.equal(index.scannerVersion, 1);
        assert.deepEqual(index.keywordBlocks.map(block => block.keyword), [
            '*KEYWORD',
            '*INCLUDE',
            '*INCLUDE_PATH_RELATIVE',
            '*END'
        ]);
        assert.equal(index.includeEntries.length, 1);
        assert.equal(index.includeEntries[0].fileName, 'sub/body.k');
        assert.ok(index.searchPaths.some(searchPath => searchPath.endsWith('includes')));
    });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/fileIndexBuilder.test.js`

预期：FAIL，找不到 `fileIndexBuilder` 或 include parser 新入口。

- [ ] **步骤 3：在 includeScanner 中增加 block 入口**

在 `src/core/parser/includeScanner.ts` 中导出新函数：

```typescript
async function collectIncludeDirectivesFromKeywordBlocks(filePath, keywordBlocks, readBlockText) {
    const basePath = path.dirname(filePath);
    const state = createIncludeDirectiveState(basePath);
    for (const block of keywordBlocks) {
        if (!block.keyword.startsWith('*INCLUDE')) continue;
        const text = await readBlockText(block);
        const lines = text.split(/\r?\n/);
        for (let lineOffset = 0; lineOffset < lines.length; lineOffset++) {
            if (lineOffset === lines.length - 1 && lines[lineOffset] === '') continue;
            processIncludeDirectiveLine(state, lines[lineOffset], block.startLine + lineOffset);
        }
    }
    return finalizeIncludeDirectiveState(state);
}
```

并加入 `module.exports`：

```typescript
collectIncludeDirectivesFromKeywordBlocks,
```

- [ ] **步骤 4：实现 FileIndex Builder**

在 `src/core/scanner/fileIndexBuilder.ts` 中写入：

```typescript
'use strict';

const fs = require('fs');
const { collectIncludeDirectivesFromKeywordBlocks } = require('../parser/includeScanner');
const { readBlockText } = require('./blockReader');
const { SCANNER_VERSION } = require('./scannerContracts');
const { scanKeywordSkeletonFromFile } = require('./keywordSkeletonScanner');

async function buildFileIndex(filePath, options = {}) {
    const startedAt = Date.now();
    const stat = await fs.promises.stat(filePath);
    const keywordBlocks = await scanKeywordSkeletonFromFile(filePath, options);
    const includeResult = await collectIncludeDirectivesFromKeywordBlocks(
        filePath,
        keywordBlocks,
        block => readBlockText(block)
    );
    return {
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        scannerVersion: SCANNER_VERSION,
        keywordBlocks,
        includeEntries: includeResult.includeEntries,
        searchPaths: includeResult.searchPaths,
        pathEntries: includeResult.pathEntries || [],
        scanStats: {
            mode: 'stream-skeleton',
            durationMs: Date.now() - startedAt,
            decodedLineCount: includeResult.includeEntries.length + (includeResult.pathEntries || []).length,
            keywordCount: keywordBlocks.length,
        },
    };
}

module.exports = {
    buildFileIndex,
};

export {};
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/scanner/fileIndexBuilder.test.js test/core/parser/includeScanner.test.js`

预期：PASS。

- [ ] **步骤 6：提交 FileIndex Builder**

```powershell
git add src/core/scanner/fileIndexBuilder.ts src/core/parser/includeScanner.ts test/core/scanner/fileIndexBuilder.test.js
git commit -m "feat: build file index from keyword skeleton"
```

## 任务 5：兼容现有 keyword/block scanner API

**文件：**
- 修改：`src/core/parser/keywordScanner.ts`
- 修改：`src/core/parser/blockScanner.ts`
- 修改：`test/core/parser/keywordScanner.test.js`
- 修改：`test/core/parser/blockScanner.test.js`

- [ ] **步骤 1：添加兼容性测试**

在现有测试中加入断言：

```javascript
assert.deepEqual(
    (await collectKeywordsFromFile(filePath, { fullScanLargeFiles: false })).map(item => item.keyword),
    ['KEYWORD', 'INCLUDE', 'NODE', 'END']
);
assert.deepEqual(
    (await collectBlocksFromFile(filePath)).map(item => item.keyword),
    ['KEYWORD', 'INCLUDE', 'NODE', 'END']
);
```

- [ ] **步骤 2：运行测试记录当前行为**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/parser/keywordScanner.test.js test/core/parser/blockScanner.test.js`

预期：当前测试可能 PASS；新增完整大文件场景在旧头尾扫描路径下应暴露遗漏风险。

- [ ] **步骤 3：迁移 keywordScanner 文件扫描入口**

将 `collectKeywordsFromFile(filePath, options)` 改为调用 `scanKeywordSkeletonFromFile(filePath, options)`，返回：

```typescript
return blocks.map(block => ({
    keyword: block.keyword.slice(1),
    filePath: block.filePath,
    lineIndex: block.startLine,
}));
```

保留 `collectKeywordsFromLineReader` 不变，用于未保存文档和小范围文本。

- [ ] **步骤 4：迁移 blockScanner 文件扫描入口**

将 `collectBlocksFromFile(filePath)` 改为调用 `scanKeywordSkeletonFromFile(filePath)`，返回：

```typescript
return blocks.map(block => ({
    keyword: block.keyword.slice(1),
    startLine: block.startLine,
    endLine: block.endLine,
}));
```

保留 `collectBlocksFromLineReader` 不变。

- [ ] **步骤 5：运行兼容测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/parser/keywordScanner.test.js test/core/parser/blockScanner.test.js test/core/scanner/*.test.js`

预期：PASS。

- [ ] **步骤 6：提交兼容 facade**

```powershell
git add src/core/parser/keywordScanner.ts src/core/parser/blockScanner.ts test/core/parser/keywordScanner.test.js test/core/parser/blockScanner.test.js
git commit -m "refactor: route file scanners through keyword skeleton"
```

## 任务 6：项目索引改为单次 FileIndex 加载

**文件：**
- 修改：`src/core/project/projectIndexer.ts`
- 修改：`src/core/cache/fileScanCacheStore.ts`
- 修改：`test/core/project/projectIndexer.test.js`
- 修改：`test/core/cache/fileScanCacheStore.test.js`

- [ ] **步骤 1：编写 projectIndexer 防重复扫描测试**

在 `test/core/project/projectIndexer.test.js` 中增加：

```javascript
it('loads each file index once and derives keywords plus includes from that result', async () => {
    let loadCount = 0;
    const indexer = createProjectIndexer({
        loadFileIndex: async (filePath) => {
            loadCount++;
            return {
                filePath,
                size: 10,
                mtimeMs: 1,
                scannerVersion: 1,
                keywordBlocks: [{ keyword: '*KEYWORD', filePath, startLine: 0 }],
                includeEntries: [],
                searchPaths: [path.dirname(filePath)],
                pathEntries: [],
                scanStats: { mode: 'stream-skeleton', durationMs: 1, decodedLineCount: 0, keywordCount: 1 },
            };
        },
        getFileSignature: async () => ({ mtimeMs: 1, size: 10 }),
    });
    await indexer.buildProjectIndex(rootFile);
    assert.equal(loadCount, 1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/project/projectIndexer.test.js --grep "loads each file index once"`

预期：FAIL，`createProjectIndexer` 不接受 `loadFileIndex`。

- [ ] **步骤 3：改造 createProjectIndexer 参数**

在 `src/core/project/projectIndexer.ts` 中把 `collectIncludeDirectivesFromFile` 和 `collectKeywordsFromFile` 的内部热路径替换为：

```typescript
const { buildFileIndex } = require('../scanner/fileIndexBuilder');

function keywordsFromFileIndex(fileIndex) {
    return fileIndex.keywordBlocks.map(block => ({
        keyword: block.keyword.slice(1),
        filePath: fileIndex.filePath,
        lineIndex: block.startLine,
    }));
}
```

`loadFileScan` 改为只调用一次 `loadFileIndex(resolvedFilePath, options)`，并返回：

```typescript
const fileIndex = await loadFileIndex(resolvedFilePath, options);
const scanResult = {
    filePath: resolvedFilePath,
    fileIndex,
    keywords: keywordsFromFileIndex(fileIndex),
    includeEntries: fileIndex.includeEntries,
    searchPaths: fileIndex.searchPaths,
};
```

- [ ] **步骤 4：缓存加入 scannerVersion 校验**

在 `src/core/cache/fileScanCacheStore.ts` 的 payload 校验中要求：

```typescript
if (parsed && parsed.scannerVersion !== undefined && parsed.scannerVersion !== scanResult.scannerVersion) {
    return null;
}
```

并把 schema version bump 到 `2`：

```typescript
const SCHEMA_VERSION = 2;
```

- [ ] **步骤 5：运行项目索引与缓存测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/project/projectIndexer.test.js test/core/cache/fileScanCacheStore.test.js`

预期：PASS。

- [ ] **步骤 6：提交项目索引改造**

```powershell
git add src/core/project/projectIndexer.ts src/core/cache/fileScanCacheStore.ts test/core/project/projectIndexer.test.js test/core/cache/fileScanCacheStore.test.js
git commit -m "refactor: index project files from unified file index"
```

## 任务 7：统一 LSP/worker 索引服务签名

**文件：**
- 修改：`src/client/services/indexClient.ts`
- 修改：`src/server/requestRouter.ts`
- 修改：`src/server/sessionManager.ts`
- 修改：`src/worker/projectIndexLoader.ts`
- 修改：`src/worker/scanWorker.ts`
- 修改：`src/extension.ts`
- 修改：`test/client/services/indexClient.test.js`
- 修改：`test/server/lspBridge.test.js`
- 修改：`test/worker/workerPool.test.js`

- [ ] **步骤 1：编写 options 透传失败测试**

在 `test/server/lspBridge.test.js` 中增加：

```javascript
it('passes index options through the language-client bridge', async () => {
    let capturedParams = null;
    const mockLanguageClient = {
        onReady: async () => undefined,
        onNotification: () => undefined,
        sendNotification: () => undefined,
        sendRequest: async (_method, params) => {
            capturedParams = params;
            return serializeProjectSnapshot({
                rootFile,
                files: [rootFile],
                graph: new ProjectGraph(),
                keywordMap: new Map(),
                missingFiles: [],
                cycles: [],
                stats: { scannedFileCount: 1, reusedFileCount: 0 },
            });
        },
    };
    const client = createIndexClient({ languageClient: mockLanguageClient });
    await client.loadProjectSnapshot(rootFile, { largeFileMode: 'skeleton' }, () => undefined);
    assert.deepEqual(capturedParams.options, { largeFileMode: 'skeleton' });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/server/lspBridge.test.js --grep "passes index options"`

预期：FAIL，当前 language client 分支只发送 `rootFile`。

- [ ] **步骤 3：修正 client 签名**

在 `src/client/services/indexClient.ts` 的 language client 分支中将签名改为：

```typescript
async loadProjectSnapshot(rootFile, options = {}, onProgress = null) {
```

发送请求改为：

```typescript
{ rootFile: resolvedRootFile, options }
```

- [ ] **步骤 4：修正 extension wrapper**

在 `src/extension.ts` 中把 wrapper 改为：

```typescript
indexClient.loadProjectSnapshot = async (rootFile, options = {}, onProgress = null) => {
    const snapshot = await originalLoadProjectSnapshot(rootFile, options, onProgress);
    projectDiagnosticStore.publish(snapshot.rootFile, collectProjectDiagnostics(snapshot));
    return snapshot;
};
```

- [ ] **步骤 5：传递 worker cache 目录**

在 `src/server/sessionManager.ts` 中创建 loader 时传入文件级缓存目录：

```typescript
this.projectIndexLoader = createProjectIndexLoader({
    fileScanCacheDirectory: globalStoragePath ? path.join(globalStoragePath, 'file-scans') : null,
});
```

- [ ] **步骤 6：运行桥接测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/services/indexClient.test.js test/server/lspBridge.test.js test/worker/workerPool.test.js`

预期：PASS。

- [ ] **步骤 7：提交服务签名统一**

```powershell
git add src/client/services/indexClient.ts src/server/requestRouter.ts src/server/sessionManager.ts src/worker/projectIndexLoader.ts src/worker/scanWorker.ts src/extension.ts test/client/services/indexClient.test.js test/server/lspBridge.test.js test/worker/workerPool.test.js
git commit -m "fix: pass index options through snapshot pipeline"
```

## 任务 8：现有 provider 消费统一索引

**文件：**
- 修改：`src/client/providers/includeTreeProvider.ts`
- 修改：`src/client/providers/keywordIndexProvider.ts`
- 修改：`src/extension.ts`
- 修改：`test/extension.test.js`
- 修改：`test/client/providers/advanced_features.test.js`

- [ ] **步骤 1：添加大文件 provider 不全文 lineAt 测试**

在 `test/extension.test.js` 中增加：

```javascript
it('does not scan every line for folding and symbols when a file index is available', async () => {
    let lineAtCalls = 0;
    const doc = {
        languageId: 'lsdyna',
        lineCount: 250000,
        version: 1,
        uri: { fsPath: '/project/huge.k', toString: () => 'file:///project/huge.k' },
        lineAt() {
            lineAtCalls++;
            throw new Error('lineAt should not be used when file index is available');
        },
    };
    const fileIndex = {
        keywordBlocks: [
            { keyword: '*KEYWORD', startLine: 0, endLine: 9, keywordStartChar: 0 },
            { keyword: '*NODE', startLine: 10, endLine: 100, keywordStartChar: 0 },
            { keyword: '*END', startLine: 101, endLine: 101, keywordStartChar: 0 },
        ],
    };
    setFileIndexForTesting(doc.uri.fsPath, fileIndex);
    assert.equal(new LsDynaFoldingProvider().provideFoldingRanges(doc).length, 2);
    assert.equal(new LsdynaKeywordSymbolProvider().provideDocumentSymbols(doc).length, 3);
    assert.equal(lineAtCalls, 0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/extension.test.js --grep "file index is available"`

预期：FAIL，当前 provider 未消费 file index。

- [ ] **步骤 3：增加 extension 内部 file index 读取口**

在 `src/extension.ts` 中加入一个仅供 provider 使用的索引读取函数：

```typescript
const activeFileIndexCache = new Map();

function getFileIndexForDocument(document) {
    const key = process.platform === 'win32'
        ? path.resolve(document.uri.fsPath).toLowerCase()
        : path.resolve(document.uri.fsPath);
    return activeFileIndexCache.get(key) || null;
}

function setFileIndexForTesting(filePath, fileIndex) {
    const key = process.platform === 'win32'
        ? path.resolve(filePath).toLowerCase()
        : path.resolve(filePath);
    activeFileIndexCache.set(key, fileIndex);
}
```

在 project snapshot 发布处把每个 `scanResult.fileIndex` 或 snapshot 中对应 file index 写入 `activeFileIndexCache`。

- [ ] **步骤 4：Folding/Symbol 优先使用 file index**

Folding provider 使用：

```typescript
const fileIndex = getFileIndexForDocument(document);
if (fileIndex && Array.isArray(fileIndex.keywordBlocks)) {
    return fileIndex.keywordBlocks
        .filter(block => block.endLine > block.startLine)
        .map(block => new vscode.FoldingRange(block.startLine, block.endLine));
}
```

Document Symbol provider 使用：

```typescript
const fileIndex = getFileIndexForDocument(document);
if (fileIndex && Array.isArray(fileIndex.keywordBlocks)) {
    return fileIndex.keywordBlocks.map(block => {
        const range = new vscode.Range(block.startLine, block.keywordStartChar || 0, block.startLine, (block.keywordStartChar || 0) + block.keyword.length);
        return new vscode.DocumentSymbol(block.keyword, '', vscode.SymbolKind.Property, range, range);
    });
}
```

- [ ] **步骤 5：Keyword Index 和 Include Tree 保持 snapshot 消费**

在 `src/client/providers/keywordIndexProvider.ts` 中确保 `_buildRootsFromSnapshot` 仍优先使用 `snapshot.keywordMap`。在 `src/client/providers/includeTreeProvider.ts` 中确保 `_buildRootFromSnapshot` 仍只消费 `snapshot.graph`，不自行触发文件扫描。

- [ ] **步骤 6：运行 provider 测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/extension.test.js test/client/providers/advanced_features.test.js`

预期：PASS。

- [ ] **步骤 7：提交 provider 接入**

```powershell
git add src/extension.ts src/client/providers/includeTreeProvider.ts src/client/providers/keywordIndexProvider.ts test/extension.test.js test/client/providers/advanced_features.test.js
git commit -m "refactor: consume file index in existing providers"
```

## 任务 9：基准测试与最终验收

**文件：**
- 创建：`test/core/scanner/scannerBenchmark.test.js`
- 修改：`package.json`
- 修改：`docs/superpowers/verification/2026-06-23-high-performance-scanning-indexing.md`

- [ ] **步骤 1：添加可控 benchmark 测试**

创建 `test/core/scanner/scannerBenchmark.test.js`：

```javascript
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');

function createGeneratedDeck(targetSizeBytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-benchmark-'));
    const filePath = path.join(dir, 'generated.k');
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, '*KEYWORD\n*NODE\n');
    let written = 15;
    let nodeId = 1;
    while (written < targetSizeBytes) {
        const line = `${nodeId},0.0,0.0,0.0\n`;
        fs.writeSync(fd, line);
        written += Buffer.byteLength(line);
        nodeId++;
        if (nodeId % 100000 === 0) {
            fs.writeSync(fd, '*ELEMENT_SHELL\n');
            written += 15;
        }
    }
    fs.writeSync(fd, '*END\n');
    fs.closeSync(fd);
    return filePath;
}

describe('scanner benchmark smoke test', function () {
    this.timeout(20000);

    it('scans a generated 10MB deck without splitting every line into strings', async () => {
        const filePath = createGeneratedDeck(10 * 1024 * 1024);
        const startedAt = Date.now();
        const blocks = await scanKeywordSkeletonFromFile(filePath);
        const durationMs = Date.now() - startedAt;
        assert.ok(blocks.length >= 3);
        assert.equal(blocks[0].keyword, '*KEYWORD');
        assert.equal(blocks[blocks.length - 1].keyword, '*END');
        assert.ok(durationMs < 20000);
    });
});
```

- [ ] **步骤 2：增加 benchmark 脚本**

在 `package.json` 的 `scripts` 中加入：

```json
"test:scanner-benchmark": "npm run compile && mocha --require test/register-out.js test/core/scanner/scannerBenchmark.test.js"
```

- [ ] **步骤 3：运行全量测试**

运行：`npm test`

预期：PASS。

- [ ] **步骤 4：运行 benchmark smoke test**

运行：`npm run test:scanner-benchmark`

预期：PASS，并记录 10MB 生成 deck 的耗时。

- [ ] **步骤 5：搜索旧头尾扫描依赖**

运行：`rg -n "locateTailWindow|fullScanLargeFiles|start: 0, end: 1024 \\* 1024|1000\\)" src test`

预期：不再有 keyword/include 项目索引热路径依赖头尾窗口扫描；兼容配置读取可以保留。

- [ ] **步骤 6：写验证记录**

创建 `docs/superpowers/verification/2026-06-23-high-performance-scanning-indexing.md`：

```markdown
# 高性能扫描与索引架构验证记录

## 命令

- `npm test`
- `npm run test:scanner-benchmark`
- `rg -n "locateTailWindow|fullScanLargeFiles|start: 0, end: 1024 \\* 1024|1000\\)" src test`

## 结果

- 全量测试通过。
- 10MB 生成 deck benchmark 通过，记录耗时。
- 项目索引热路径不再依赖大文件头尾窗口扫描。

## LS-DYNA 文本边界

- 注释行中的 keyword 未被识别。
- CRLF/LF 和最后无换行文件均可形成正确 block。
- `*NODE` 与 `*ELEMENT_*` 只记录 block，不解析数据卡。
- Include 路径解析由 include 状态机负责，scanner 不解释路径语义。
```

- [ ] **步骤 7：提交验收资产**

```powershell
git add package.json test/core/scanner/scannerBenchmark.test.js docs/superpowers/verification/2026-06-23-high-performance-scanning-indexing.md
git commit -m "test: verify high performance scanning index baseline"
```

## 完成标准

- `npm test` 通过。
- `npm run test:scanner-benchmark` 通过。
- `KeywordIndex`、`IncludeTree`、Folding、Document Symbol 可消费统一索引。
- Project indexer 对单文件只构建一次 `FileIndex`，不再分别扫描 keywords 和 includes。
- 大文件项目索引默认完整扫描 keyword skeleton，不依赖头尾窗口近似结果。
- 文件级缓存用 `scannerVersion + size + mtimeMs` 失效。
- LSP client、server、worker 对 `loadProjectSnapshot(rootFile, options, onProgress)` 签名一致。
- 基础层不解析 keyword 字段语义，不新增任何上层功能。

## 自检

- 规格覆盖度：本计划覆盖 scanner、block reader、file index、cache、project indexer、LSP/worker 签名、现有 provider 接入、benchmark 验证。
- 占位符扫描：本文不包含未确定实现、空泛错误处理或无代码的测试描述。
- 类型一致性：核心数据类型统一使用 `KeywordBlock`、`FileIndex`、`scannerVersion`、`keywordBlocks`、`includeEntries`、`searchPaths`、`scanStats`。
