# DynaSense 半自动双市场发布实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 自动发布 Open VSX 与 GitHub Release，为 VS Marketplace 人工上传创建唯一待办，并在公开版本出现后自动验证和关闭待办。

**架构：** 发布工作流只持有 `OVSX_PAT`，构建一次 VSIX 后发布 Open VSX、创建 GitHub Release 和上传 Issue。可测试的 CommonJS 模块封装 Issue 幂等逻辑与 Marketplace Gallery API 查询，独立调度工作流每 30 分钟调用它完成验证。

**技术栈：** GitHub Actions、`actions/github-script@v7`、Node.js 20、Mocha 10、Visual Studio Marketplace Gallery API、Open VSX CLI 1.0.1。

---

## 文件结构

- 创建：`.github/scripts/marketplace-release.cjs` — 生成上传 Issue、解析版本标记、查询 Gallery API、关闭已完成 Issue。
- 创建：`test/marketplaceReleaseWorkflow.test.js` — 用 GitHub API/fetch mock 验证幂等、解析、查询和关闭行为。
- 修改：`.github/workflows/release.yml` — 删除 `VSCE_PAT` 与 VS Marketplace CLI 发布，改为 Open VSX 自动发布和上传 Issue。
- 创建：`.github/workflows/verify-marketplace.yml` — 定时和手动验证 Marketplace 公开版本。
- 修改：`docs/superpowers/specs/2026-06-20-semi-automated-marketplace-release-design.md` — 仅在实现发现规格歧义时同步精确行为。

### 任务 1：为上传待办模块建立红灯测试

**文件：**
- 创建：`test/marketplaceReleaseWorkflow.test.js`
- 创建：`.github/scripts/marketplace-release.cjs`

- [ ] **步骤 1：编写版本标记与 Issue 幂等测试**

测试导入以下接口：

```javascript
const {
    extractMarketplaceVersion,
    ensureMarketplaceUploadIssue,
    verifyMarketplaceUploadIssues
} = require('../.github/scripts/marketplace-release.cjs');
```

断言：

```javascript
assert.equal(extractMarketplaceVersion('<!-- marketplace-version:3.0.6 -->'), '3.0.6');
assert.equal(extractMarketplaceVersion('no marker'), null);
```

使用内存 mock 验证 `ensureMarketplaceUploadIssue()`：相同版本已有 Issue 时不调用 `create`；不存在时创建 `marketplace-upload` 标签与包含 Release、Marketplace 管理页及机器标记的 Issue。

- [ ] **步骤 2：编写 Gallery API 与关闭行为测试**

向 `verifyMarketplaceUploadIssues()` 注入 `fetchImpl`，返回：

```javascript
{
    results: [{
        extensions: [{
            publisher: { publisherName: 'hqyyqh' },
            extensionName: 'dynasense',
            versions: [{ version: '3.0.6' }]
        }]
    }]
}
```

断言匹配版本的 Issue 被评论并以 `state: 'closed'`、`state_reason: 'completed'` 更新；未匹配版本保持开放；非 2xx 响应抛出错误。

- [ ] **步骤 3：运行测试确认红灯**

运行：

```powershell
npx mocha test/marketplaceReleaseWorkflow.test.js
```

预期：FAIL，模块或导出函数尚不存在。

### 任务 2：实现可测试的 Marketplace 协调模块

**文件：**
- 创建：`.github/scripts/marketplace-release.cjs`
- 测试：`test/marketplaceReleaseWorkflow.test.js`

- [ ] **步骤 1：实现固定格式与安全解析**

导出常量与纯函数：

```javascript
const MARKETPLACE_LABEL = 'marketplace-upload';
const EXTENSION_ID = 'hqyyqh.dynasense';
const VERSION_MARKER = /<!-- marketplace-version:(\d+\.\d+\.\d+) -->/;

function extractMarketplaceVersion(body = '') {
    return VERSION_MARKER.exec(body)?.[1] ?? null;
}
```

Issue 标题固定为 `Upload DynaSense <version> to VS Marketplace`；正文链接到 `releases/tag/v<version>`、Marketplace 管理页和公开详情页。

- [ ] **步骤 2：实现 Issue 幂等创建**

`ensureMarketplaceUploadIssue({ github, context, version })` 先确保标签存在，再列出所有带标签 Issue。精确匹配标题或机器标记时返回已有 Issue，否则调用 `github.rest.issues.create()`。

标签不存在时只捕获 `status === 404` 并创建；其他 API 错误原样抛出。

- [ ] **步骤 3：实现 Gallery API 查询与关闭**

向 `https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery` POST：

```javascript
{
    filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }],
    flags: 914
}
```

`verifyMarketplaceUploadIssues({ github, context, fetchImpl })` 只读取开放且带标签的 Issue；无 Issue 时不请求网络；有 Issue 时查询一次版本集合。匹配后添加一条公开链接评论并关闭，未匹配时不写 GitHub 状态。

- [ ] **步骤 4：运行定向测试**

```powershell
npx mocha test/marketplaceReleaseWorkflow.test.js --reporter spec
```

预期：全部 PASS。

- [ ] **步骤 5：提交协调模块**

```powershell
git add .github/scripts/marketplace-release.cjs test/marketplaceReleaseWorkflow.test.js
git commit -m "ci: add marketplace upload coordinator"
```

### 任务 3：改造发布工作流

**文件：**
- 修改：`.github/workflows/release.yml`

- [ ] **步骤 1：缩小权限和凭据检查**

加入 `issues: write`，删除所有 `VSCE_PAT` 引用与 `Publish to Visual Studio Marketplace` 步骤。凭据检查只验证 `OVSX_PAT`，且仅在 `steps.metadata.outputs.publish == 'true'` 时执行。

- [ ] **步骤 2：保留 Open VSX 与 GitHub Release**

Open VSX 继续发布同一 VSIX并使用 `--skip-duplicate`。GitHub Release 仍只在标签 push 时创建或更新。

- [ ] **步骤 3：创建人工上传 Issue**

在 Release 步骤后加入：

```yaml
- name: Create VS Marketplace upload task
  if: steps.metadata.outputs.publish == 'true'
  uses: actions/github-script@v7
  env:
    RELEASE_VERSION: ${{ steps.metadata.outputs.version }}
  with:
    script: |
      const coordinator = require('./.github/scripts/marketplace-release.cjs');
      await coordinator.ensureMarketplaceUploadIssue({
        github,
        context,
        version: process.env.RELEASE_VERSION
      });
```

手动 `publish=true` 也创建幂等 Issue，便于用已发布的 `3.0.6` 端到端验证；dry-run 不创建。

### 任务 4：新增自动验证工作流

**文件：**
- 创建：`.github/workflows/verify-marketplace.yml`

- [ ] **步骤 1：定义触发器与权限**

```yaml
name: Verify Visual Studio Marketplace

on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:

permissions:
  contents: read
  issues: write
```

- [ ] **步骤 2：调用协调模块**

工作流 checkout 后运行 `actions/github-script@v7`：

```javascript
const coordinator = require('./.github/scripts/marketplace-release.cjs');
const result = await coordinator.verifyMarketplaceUploadIssues({ github, context });
core.info(JSON.stringify(result));
```

### 任务 5：本地与远端验证

**文件：**
- 验证全部修改

- [ ] **步骤 1：运行完整本地门禁**

```powershell
npm test
npm audit --omit=dev
actionlint
git diff --check
```

预期：原有 289 项加新增测试全部通过；生产依赖 0 漏洞；工作流语义无错误；差异检查无输出。

- [ ] **步骤 2：实时验证 Gallery API**

用协调模块的查询入口读取当前公开版本，确认返回集合包含 `3.0.6`，且不传输任何凭据。

- [ ] **步骤 3：提交工作流**

```powershell
git add .github/workflows/release.yml .github/workflows/verify-marketplace.yml docs/superpowers/plans/2026-06-20-semi-automated-marketplace-release.md
git commit -m "ci: automate Open VSX and marketplace handoff"
```

- [ ] **步骤 4：合并并推送 dev/master**

先快进 `dev`、运行完整测试并推送，等待 CI 成功；再快进 `master`、运行完整测试并推送。保留 `dev`。

- [ ] **步骤 5：端到端验证**

从 `master` 手动调度 `release.yml` 且 `publish=true`。确认：Open VSX `3.0.6` 被安全跳过或验证成功；唯一上传 Issue 创建；GitHub Release 仍可访问。随后手动调度 `verify-marketplace.yml`，确认公开 `3.0.6` 被识别、Issue 获得评论并自动关闭。
