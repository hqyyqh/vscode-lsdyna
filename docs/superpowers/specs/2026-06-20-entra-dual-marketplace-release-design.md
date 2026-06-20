# DynaSense Entra 双商店自动发布与验收设计

## 目标

使用 GitHub Actions OIDC 和 Azure 用户分配托管标识自动发布 Visual Studio Marketplace，继续使用仓库 Secret `OVSX_PAT` 自动发布 Open VSX。每次正式发布创建一个版本级验收 Issue，只有两个商店都公开目标版本后才自动关闭。

## 发布架构

- 正式发布沿用 `.github/workflows/release.yml`，构建一次 `dynasense-<version>.vsix`，两个商店发布同一文件。
- Visual Studio Marketplace 发布前由 `azure/login@v3` 使用仓库 Variables `AZURE_CLIENT_ID`、`AZURE_TENANT_ID`、`AZURE_SUBSCRIPTION_ID` 获取 OIDC 身份，再执行 `vsce publish --azure-credential --packagePath <vsix> --skip-duplicate`。
- Open VSX 使用 Secret `OVSX_PAT` 执行 `ovsx publish <vsix> --skip-duplicate`。
- 发布 job 绑定 GitHub Environment `release`，权限为 `contents: write`、`issues: write`、`id-token: write`。
- dry-run 仍执行安装、测试、审计、打包和 artifact 上传，但不登录 Azure、不发布商店、不创建验收 Issue。

## 版本级验收 Issue

- 每个正式发布版本幂等创建一个 Issue，标题为 `Verify DynaSense <version> marketplace release`，标签为 `marketplace-release`。
- Issue 正文包含机器可读版本标记、两个公开详情页链接和验收说明；相同版本重跑不得创建重复 Issue。
- Issue 是发布结果追踪器，不再要求人工上传 VSIX。
- 创建 Issue 的动作排在两个发布命令之后；命令失败时工作流失败，不创建误导性的验收单。

## 双商店验证

`.github/workflows/verify-marketplace.yml` 每 30 分钟运行，也支持手动触发。协调模块只读取开放且带 `marketplace-release` 标签的 Issue：

1. 从机器标记解析目标语义化版本。
2. 通过 Visual Studio Marketplace Gallery API 查询 `hqyyqh.dynasense` 的公开版本集合。
3. 通过 `https://open-vsx.org/api/hqyyqh/dynasense` 查询 `allVersions`。
4. 在单次验证中汇总两个商店的状态。
5. 两个商店都包含目标版本时，添加一条包含两边链接的成功评论，并以 `completed` 原因关闭 Issue。
6. 只有一个商店可用时保持 Issue 开放，不重复发送“仍在等待”评论，避免定时任务刷屏。

## 错误处理与幂等性

- `vsce` 和 `ovsx` 都启用重复版本跳过，允许安全重跑同一版本。
- 任一公开 API 返回非成功响应、响应结构无效或网络失败时，验证工作流失败且不修改 Issue，等待下次调度重试。
- 无待验收 Issue 时不访问任何商店 API。
- 多个开放版本在一次运行中共享各商店的一次版本查询，避免重复请求。
- 旧标签 `marketplace-upload` 和旧人工上传 Issue 不参与新流程，也不自动删除或修改。

## 文件范围

- 修改 `.github/workflows/release.yml`：加入 Entra OIDC 发布、保留 Open VSX 发布、创建版本验收 Issue。
- 修改 `.github/workflows/verify-marketplace.yml`：从单商店人工上传验证改为双商店自动发布验证。
- 修改 `.github/scripts/marketplace-release.cjs`：将人工上传协调器改为双商店验收协调器。
- 修改 `test/marketplaceReleaseWorkflow.test.js`：覆盖 Issue 幂等、双 API 状态、部分成功、全部成功和 API 故障。
- 删除 `.github/workflows/entra-bootstrap.yml`：正式工作流验证完成后移除临时身份探测入口。

## 验收标准

- 本地测试、TypeScript 编译、生产依赖审计、actionlint 和差异检查全部通过。
- `dev` CI 通过后合并到 `master`，远端保留两个分支。
- 从 `master` 手动执行 `publish=true` 时，GitHub OIDC 登录、VS Marketplace 重复版本跳过、Open VSX 重复版本跳过均成功，并创建唯一的版本验收 Issue。
- 手动执行验证工作流后，公开 API 同时识别当前版本，Issue 获得一次成功评论并自动关闭。
- 仓库不需要 `VSCE_PAT`，不记录或输出任何令牌。
