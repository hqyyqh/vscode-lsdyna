# 右置徽章长度限制修复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 Include Tree 中右置文件体积徽章空白的问题，使其能够正常渲染出体积范围大小。

**架构：** 由于 VS Code `FileDecoration.badge` 具有严格的 2 字符限制，我们将 `formatShortBytes` 工具函数重构为严格输出 <= 2 字符的缩写标识（例如 `3k`、`K`、`1M`、`M`、`G`）。同时修复测试中无法加载 `normalizePathKey` 的导入错误。

**技术栈：** VS Code Ext API, Node.js, Mocha

---

### 任务 1：重构 `formatShortBytes` 工具函数

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`
- 测试：`test/extension.test.js`

- [ ] **步骤 1：在 `src/client/providers/includeTreeProvider.js` 中修改 `formatShortBytes` 逻辑**

展示修改后的代码：
```javascript
function formatShortBytes(bytes) {
    if (bytes <= 0) return '0';
    if (bytes < 1024) {
        return '1k';
    }
    const kb = bytes / 1024;
    if (kb < 10) {
        return `${Math.round(kb)}k`;
    }
    if (kb < 1024) {
        return 'K';
    }
    const mb = kb / 1024;
    if (mb < 10) {
        return `${Math.round(mb)}M`;
    }
    if (mb < 1024) {
        return 'M';
    }
    const gb = mb / 1024;
    if (gb < 10) {
        return `${Math.round(gb)}G`;
    }
    return 'G';
}
```

---

### 任务 2：导出 `normalizePathKey` 用于单元测试

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：在 `src/extension.js` 的 `_internals` 导出块中添加 `normalizePathKey`**

在 `module.exports._internals` 块的末尾添加 `normalizePathKey`：
```javascript
module.exports._internals = {
    // ... 其他导出
    LsdynaFileDecorationProvider,
    normalizePathKey,
};
```

---

### 任务 3：更新并运行单元测试

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：在 `test/extension.test.js` 中更新 `formatShortBytes` 测试用例**

修改 `test/extension.test.js` 中对应的断言，使其符合新的不超过 2 个字符的输出格式：
```javascript
        assert.strictEqual(formatShortBytes(0), '0');
        assert.strictEqual(formatShortBytes(512), '1k');
        assert.strictEqual(formatShortBytes(1024), '1k');
        assert.strictEqual(formatShortBytes(1536), '2k');
        assert.strictEqual(formatShortBytes(1024 * 45), 'K');
        assert.strictEqual(formatShortBytes(1024 * 1024 * 1.2), '1M');
        assert.strictEqual(formatShortBytes(1024 * 1024 * 1024 * 125), 'G');
```

- [ ] **步骤 2：在 `test/extension.test.js` 中更新 `LsdynaFileDecorationProvider` 测试用例**

修改 `test/extension.test.js` 中 `LsdynaFileDecorationProvider` 测试用例中对 `badge` 的断言，将原先期待的 `'12K'` 修正为新规则下的 `'K'`：
```javascript
            resolvedPaths: new Map([
                [normalizePathKey('some/file.k'), 'K']
            ]),
```
和：
```javascript
        assert.strictEqual(resolvedDec.badge, 'K');
```

- [ ] **步骤 3：在终端中运行单元测试验证**

运行命令：
```powershell
npm test
```
预期输出：所有 154 项测试用例全部 PASS。

- [ ] **步骤 4：Commit 代码更改**

运行命令：
```powershell
git add src/extension.js src/client/providers/includeTreeProvider.js test/extension.test.js
git commit -m "fix: resolve blank decoration badges by formatting size to max 2 chars"
```
