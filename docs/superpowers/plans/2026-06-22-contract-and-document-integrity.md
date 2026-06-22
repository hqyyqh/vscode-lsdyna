# 契约与文档完整性实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 manifest、README、NLS、命令激活和开发文档编码形成可自动验证的单一契约。

**架构：** 新增无第三方依赖的 Node 契约检查脚本，并由 Mocha 和 CI 同时调用。`package.json` 是配置真源；损坏文档优先从 Git 历史恢复，不可恢复内容保留原始字节和清单。

**技术栈：** Node.js 22、Mocha、VS Code extension manifest、GitHub Actions

---

## 文件结构

- 创建：`scripts/validate-project-contracts.cjs` — 可复用的契约与 UTF-8 检查器。
- 创建：`scripts/recover-superpowers-docs.cjs` — 从 Git blob 恢复最近合法 UTF-8 版本并输出清单。
- 创建：`test/projectContracts.test.js` — 契约回归测试。
- 创建：`docs/superpowers/archive/README.md` — 损坏文档恢复与归档清单。
- 修改：`package.json` — 补齐 activationEvents 与检查脚本。
- 修改：`package.nls.json`、`package.nls.zh-cn.json` — 删除重复键。
- 修改：`README.md`、`README_zh.md` — 完整、真实的配置说明和手册链接。
- 修改：`.github/workflows/ci.yml` — 显式运行契约检查。

### 任务 1：建立会失败的项目契约测试

**文件：**
- 创建：`scripts/validate-project-contracts.cjs`
- 创建：`test/projectContracts.test.js`
- 修改：`package.json`

- [ ] **步骤 1：创建最小导出并编写失败测试**

`scripts/validate-project-contracts.cjs` 先导出尚未实现的接口：

```javascript
'use strict';

function validateProjectContracts() {
    throw new Error('project contract validation has not been implemented');
}

module.exports = { validateProjectContracts };

if (require.main === module) {
    const errors = validateProjectContracts(process.cwd());
    if (errors.length) {
        console.error(errors.join('\n'));
        process.exitCode = 1;
    }
}
```

`test/projectContracts.test.js`：

```javascript
'use strict';

const assert = require('assert');
const path = require('path');
const { validateProjectContracts } = require('../scripts/validate-project-contracts.cjs');

describe('project contracts', () => {
    it('keeps manifest, documentation, localization, activation, and UTF-8 contracts valid', () => {
        const errors = validateProjectContracts(path.resolve(__dirname, '..'));
        assert.deepEqual(errors, []);
    });
});
```

- [ ] **步骤 2：在 `package.json` 添加脚本并确认测试失败**

```json
"check:contracts": "node scripts/validate-project-contracts.cjs"
```

运行：`npx mocha test/projectContracts.test.js`
预期：FAIL，错误为 `project contract validation has not been implemented`。

- [ ] **步骤 3：实现严格 UTF-8、重复键和 NLS 集合检查**

实现以下核心函数并从同一模块导出：

```javascript
function decodeUtf8Strict(filePath) {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filePath));
}

function flatJsonKeysWithoutDuplicates(filePath) {
    const text = decodeUtf8Strict(filePath);
    const keys = [...text.matchAll(/^\s*"([^"]+)"\s*:/gm)].map(match => match[1]);
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    return { keys: new Set(keys), duplicates: [...new Set(duplicates)] };
}
```

扫描 `README*.md`、`AGENTS.md`、`.github/**/*.md`、`docs/**/*.md`；任何严格解码失败均加入错误列表。比较两个 NLS 键集合，并检查 `package.json` 中 `%key%` 引用。

- [ ] **步骤 4：实现配置、命令和 activation 契约**

读取 manifest 的 11 个 `contributes.configuration.properties`。解析 README 的设置表，要求两个 README 的设置名集合与 manifest 完全一致，默认值使用 `JSON.stringify(property.default)` 比较。

从 `src/**/*.ts` 提取 `registerCommand('id'`；贡献命令必须已注册且存在 `onCommand:id`。以下内部命令使用显式 allowlist：

```javascript
const INTERNAL_COMMANDS = new Set([
    'extension.goToKeywordUsage',
    'extension.openIncludeFolder',
    'extension.openIncludeNewTab',
    'extension.openIncludeSplit',
]);
```

- [ ] **步骤 5：运行测试确认按真实缺陷失败**

运行：`npx mocha test/projectContracts.test.js`
预期：FAIL，错误至少包含 README 配置不一致、NLS 重复键、缺失 activationEvents 和非法 UTF-8 文档。

- [ ] **步骤 6：Commit 测试与检查器**

```powershell
git add scripts/validate-project-contracts.cjs test/projectContracts.test.js package.json
git commit -m "test: add project contract validation"
```

### 任务 2：修复 manifest、NLS 和 README 契约

**文件：**
- 修改：`package.json`
- 修改：`package.nls.json`
- 修改：`package.nls.zh-cn.json`
- 修改：`README.md`
- 修改：`README_zh.md`
- 修改：`src/extension.ts`

- [ ] **步骤 1：为所有 16 个贡献命令补齐激活事件**

从 `contributes.commands[*].command` 生成并写入对应 `onCommand:<id>`；保留两个 `onLanguage`。不得提高 `engines.vscode`。

- [ ] **步骤 2：删除 NLS 原始文本中的重复键**

英文删除第二个 `config.additionalExtensions.description`；中文分别只保留一个 `config.additionalExtensions.description` 和 `config.scanner.fullScanLargeFiles.markdownDescription`。

- [ ] **步骤 3：重写两个 README 的设置表**

表格必须逐项列出 manifest 的 11 个设置，默认值使用代码格式；删除 `lsdyna.format.enableOnSave` 和 `lsdyna.index.enableIncludeTree`。把功能描述中的“保存时自动格式化”改为实验性 `lsdyna.autoFormat = onBlur`。

- [ ] **步骤 4：修复手册帮助链接**

在 README 中添加稳定锚点 `manual-integration-setup` / `手册集成设置`，并在 `appendManualLinks` 中根据当前语言链接到 `README.md#manual-integration-setup` 或 `README_zh.md#手册集成设置`。

- [ ] **步骤 5：运行契约与全量测试**

运行：`npm run check:contracts`
预期：仅剩历史 Markdown UTF-8 错误。

运行：`npm test`
预期：全部通过。

- [ ] **步骤 6：Commit manifest 与用户文档修复**

```powershell
git add package.json package.nls.json package.nls.zh-cn.json README.md README_zh.md src/extension.ts
git commit -m "fix: align extension manifest and user documentation"
```

### 任务 3：恢复并归档损坏的 Superpowers 文档

**文件：**
- 创建：`scripts/recover-superpowers-docs.cjs`
- 创建：`docs/superpowers/archive/README.md`
- 修改或归档：严格 UTF-8 检查失败的 `docs/superpowers/**/*.md`

- [ ] **步骤 1：实现只读恢复分析**

脚本使用 `git log --format=%H -- <path>` 和 `git show <commit>:<path>`，对每个 blob 用 fatal `TextDecoder` 检查；输出 JSON 记录：

```javascript
{
  path,
  currentBlob,
  recoveredFrom: validCommit || null,
  status: validCommit ? 'recovered' : 'unrecoverable'
}
```

默认 `--dry-run`；只有传入 `--apply` 才写文件。

- [ ] **步骤 2：运行 dry-run 并保存证据**

运行：`node scripts/recover-superpowers-docs.cjs --dry-run`
预期：列出全部非法 UTF-8 路径及可恢复 commit，不修改工作树。

- [ ] **步骤 3：恢复最近合法 blob**

运行：`node scripts/recover-superpowers-docs.cjs --apply`。对不可恢复文档，将原始 bytes 写为 `docs/superpowers/archive/raw/<relative-path>.bin`，删除非法 `.md`，并在 archive README 记录 SHA-256、原路径和对应实现提交。仍具当前价值的设计根据 Git 提交和测试重建为 UTF-8 摘要，标题明确标记“恢复摘要”。

- [ ] **步骤 4：验证仓库 Markdown 全部为合法 UTF-8**

运行：`npm run check:contracts`
预期：PASS，0 个错误。

- [ ] **步骤 5：Commit 文档恢复与门禁**

```powershell
git add scripts/recover-superpowers-docs.cjs docs/superpowers
git commit -m "docs: recover corrupted superpowers records"
```

### 任务 4：把契约检查接入 CI

**文件：**
- 修改：`.github/workflows/ci.yml`

- [ ] **步骤 1：在测试前增加契约步骤**

```yaml
      - name: Validate project contracts
        run: npm run check:contracts
```

- [ ] **步骤 2：运行本地等价命令**

运行：`npm run check:contracts && npm test`
预期：两个命令均退出 0。

- [ ] **步骤 3：Commit CI 门禁**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: enforce project contracts"
```
