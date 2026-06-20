# DynaSense Entra 双商店自动发布与验收实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 使用 GitHub OIDC 自动发布 Visual Studio Marketplace，保留 Open VSX 自动发布，并用每版本一个 Issue 验收两个商店的公开结果。

**架构：** 发布工作流只构建一个 VSIX，并分别交给 Entra 身份下的 `vsce` 与 `OVSX_PAT` 下的 `ovsx`。CommonJS 协调模块负责幂等创建版本验收 Issue、查询两个公开 API，并在两边版本都可见时评论和关闭 Issue。

**技术栈：** GitHub Actions、Azure OIDC、`azure/login@v3`、`@vscode/vsce` 3.9、`ovsx` 1.0、Node.js 22、Mocha 10。

---

## 文件结构

- 修改：`test/marketplaceReleaseWorkflow.test.js` — 先定义双商店验收与工作流配置契约。
- 修改：`.github/scripts/marketplace-release.cjs` — 实现版本 Issue、Visual Studio Marketplace 查询、Open VSX 查询和双边关闭逻辑。
- 修改：`.github/workflows/release.yml` — 加入 Entra OIDC、VS Marketplace 发布与验收 Issue 创建。
- 修改：`.github/workflows/verify-marketplace.yml` — 调用双商店验收入口。
- 删除：`.github/workflows/entra-bootstrap.yml` — 移除已完成使命的临时身份探测工作流。

### 任务 1：建立双商店协调器红灯测试

**文件：**
- 修改：`test/marketplaceReleaseWorkflow.test.js`
- 测试：`test/marketplaceReleaseWorkflow.test.js`

- [ ] **步骤 1：把 Issue 契约改为发布验收**

测试应导入 `RELEASE_LABEL`、`ensureMarketplaceReleaseIssue`、`fetchVisualStudioMarketplaceVersions`、`fetchOpenVsxVersions` 和 `verifyMarketplaceReleaseIssues`，并断言：

```javascript
assert.equal(RELEASE_LABEL, 'marketplace-release');
assert.equal(createdIssue.title, 'Verify DynaSense 3.0.7 marketplace release');
assert.ok(createdIssue.body.includes('open-vsx.org/extension/hqyyqh/dynasense'));
assert.ok(createdIssue.body.includes('marketplace-version:3.0.7'));
```

- [ ] **步骤 2：加入双商店状态测试**

注入一个按 URL 返回 Gallery API 和 Open VSX `allVersions` 的 `fetchImpl`。断言两边都有 `3.0.7` 时评论一次并关闭；只有一边存在时不评论、不关闭；任一响应非成功时拒绝并保持 GitHub 写操作为零。

- [ ] **步骤 3：加入工作流静态契约测试**

读取 `.github/workflows/release.yml`，断言包含：

```javascript
assert.match(releaseWorkflow, /id-token: write/);
assert.match(releaseWorkflow, /environment: release/);
assert.match(releaseWorkflow, /uses: azure\/login@v3/);
assert.match(releaseWorkflow, /vsce publish --azure-credential/);
assert.doesNotMatch(releaseWorkflow, /Create VS Marketplace upload task/);
```

同时断言验证工作流调用 `verifyMarketplaceReleaseIssues`，且临时引导工作流不存在。

- [ ] **步骤 4：运行测试验证红灯**

运行：

```powershell
npx mocha test/marketplaceReleaseWorkflow.test.js --reporter spec
```

预期：FAIL，原因是新导出函数、双商店行为和正式工作流配置尚不存在。

### 任务 2：实现双商店协调器

**文件：**
- 修改：`.github/scripts/marketplace-release.cjs`
- 测试：`test/marketplaceReleaseWorkflow.test.js`

- [ ] **步骤 1：实现验收 Issue 常量与幂等创建**

使用：

```javascript
const RELEASE_LABEL = 'marketplace-release';
const EXTENSION_ID = 'hqyyqh.dynasense';
const OPEN_VSX_API_URL = 'https://open-vsx.org/api/hqyyqh/dynasense';
```

`ensureMarketplaceReleaseIssue({ github, context, version })` 确保新标签存在，在所有带标签 Issue 中按标题或机器标记复用已有项，否则创建包含两个详情页链接的 Issue。

- [ ] **步骤 2：实现两个版本查询函数**

`fetchVisualStudioMarketplaceVersions(fetchImpl)` 延续现有 Gallery API 请求；`fetchOpenVsxVersions(fetchImpl)` GET Open VSX API，并将 `Object.keys(payload.allVersions)` 转为版本集合、排除 `latest`。两个函数遇到非成功响应都抛出包含商店名称和状态码的错误。

- [ ] **步骤 3：实现双边验收**

`verifyMarketplaceReleaseIssues({ github, context, fetchImpl })` 在有开放验收 Issue 时各查询一次商店版本集合；只有两个集合都包含目标版本才评论并关闭，返回：

```javascript
{
    checked: releaseIssues.length,
    closed,
    visualStudioMarketplaceVersions: visualStudioVersions.size,
    openVsxVersions: openVsxVersions.size
}
```

- [ ] **步骤 4：运行定向测试验证绿灯**

运行：

```powershell
npx mocha test/marketplaceReleaseWorkflow.test.js --reporter spec
```

预期：协调器行为测试通过；工作流静态契约仍因配置未改而失败。

### 任务 3：改造正式发布和验证工作流

**文件：**
- 修改：`.github/workflows/release.yml`
- 修改：`.github/workflows/verify-marketplace.yml`
- 删除：`.github/workflows/entra-bootstrap.yml`
- 测试：`test/marketplaceReleaseWorkflow.test.js`

- [ ] **步骤 1：配置发布 job 的 Entra 权限与环境**

在顶层权限加入 `id-token: write`，在 `release` job 加入 `environment: release`，更新手动输入说明为发布到两个商店。

- [ ] **步骤 2：加入 OIDC 登录和 VS Marketplace 发布**

在打包后、Open VSX 发布前加入：

```yaml
- name: Sign in to Azure with GitHub OIDC
  if: steps.metadata.outputs.publish == 'true'
  uses: azure/login@v3
  with:
    client-id: ${{ vars.AZURE_CLIENT_ID }}
    tenant-id: ${{ vars.AZURE_TENANT_ID }}
    subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

- name: Publish to Visual Studio Marketplace
  if: steps.metadata.outputs.publish == 'true'
  run: npx --no-install vsce publish --azure-credential --packagePath "${{ steps.metadata.outputs.vsix }}" --skip-duplicate
```

- [ ] **步骤 3：把人工上传任务替换为验收 Issue**

调用：

```javascript
await coordinator.ensureMarketplaceReleaseIssue({
  github,
  context,
  version: process.env.RELEASE_VERSION
});
```

该步骤放在两个商店发布步骤之后。

- [ ] **步骤 4：更新验证工作流并删除引导工作流**

验证工作流改调 `verifyMarketplaceReleaseIssues`；删除 `.github/workflows/entra-bootstrap.yml`。

- [ ] **步骤 5：运行定向测试验证全部绿灯**

运行：

```powershell
npx mocha test/marketplaceReleaseWorkflow.test.js --reporter spec
```

预期：所有协调器与工作流契约测试通过。

### 任务 4：完整本地验证并提交 dev

**文件：**
- 验证并提交上述全部变更

- [ ] **步骤 1：运行完整门禁**

运行：

```powershell
npm test
npm audit --omit=dev
actionlint .github/workflows/*.yml
git diff --check
```

预期：测试零失败；生产依赖审计零漏洞；工作流零错误；差异检查无输出。

- [ ] **步骤 2：提交并推送 dev**

```powershell
git add .github test docs/superpowers/plans/2026-06-20-entra-dual-marketplace-release.md
git commit -m "ci: publish and verify both extension marketplaces"
git push origin dev
```

- [ ] **步骤 3：等待 dev CI**

使用 `gh run list` 找到该提交的 CI，等待退出状态为成功；失败则读取日志并按根因修复。

### 任务 5：合并 master 并端到端验收

**文件：**
- 无新增文件

- [ ] **步骤 1：将 dev 合并到 master**

```powershell
git switch master
git merge --ff-only dev
npm test
git push origin master
```

保留本地和远端 `dev` 分支。

- [ ] **步骤 2：运行正式重复版本发布**

```powershell
gh workflow run release.yml --ref master -f publish=true
```

等待运行成功，确认 OIDC 登录、Visual Studio Marketplace、Open VSX 和验收 Issue 步骤均成功。

- [ ] **步骤 3：运行双商店验收**

```powershell
gh workflow run verify-marketplace.yml --ref master
```

等待运行成功，确认当前版本 Issue 被评论一次并以 `completed` 关闭。

- [ ] **步骤 4：最终核对并返回 dev**

核对远端 `dev`、`master` 均包含实现提交，公开 API 均返回当前版本，工作区干净；最后执行 `git switch dev` 保留后续开发入口。
