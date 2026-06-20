# DynaSense 半自动双市场发布设计

**目标：** 在没有 Azure 订阅的前提下，让 Open VSX、GitHub Release 和 VSIX 产出完全自动化；Visual Studio Marketplace 只保留不可绕过的人工上传动作，并自动生成待办与验证公开结果。

## 约束与边界

- Visual Studio Marketplace 的官方自动发布只支持 Azure DevOps PAT 或 Microsoft Entra ID。当前账户无法创建所需 Azure 资源，因此不在 CI 中模拟浏览器登录或上传。
- Open VSX 使用已配置的仓库 Secret `OVSX_PAT` 自动发布。
- 任何工作流都不保存、打印或转发 Marketplace 登录信息。
- 两个市场最终使用标签构建出的同一份 VSIX。

## 发布工作流

`Release extension` 保留 `v*.*.*` 标签和手动 dry-run 入口。

正式标签发布依次执行：

1. 验证标签版本与 `package.json` 一致，并确认标签提交属于 `master`。
2. 使用锁文件安装依赖，运行完整测试和生产依赖审计。
3. 生成唯一的 `dynasense-<version>.vsix` 并上传 Actions artifact。
4. 使用 `OVSX_PAT` 将该 VSIX 发布到 Open VSX；重复版本安全跳过。
5. 创建或更新同标签的 GitHub Release，并附加同一 VSIX。
6. 幂等创建一个带 `marketplace-upload` 标签的 GitHub Issue，内容包含：
   - GitHub Release 下载链接；
   - Visual Studio Marketplace 发布者管理页；
   - 目标扩展标识和版本；
   - 人工上传与公开确认清单；
   - 机器可读版本标记，供验证工作流解析。

手动 dry-run 只执行步骤 1–3，不访问 Open VSX、不创建 Release 或 Issue。

## Marketplace 验证工作流

新增独立工作流 `Verify Visual Studio Marketplace`：

- 每 30 分钟调度一次，也支持手动触发。
- 只读取带 `marketplace-upload` 标签的开放 Issue；没有待办时立即结束。
- 从 Issue 的机器标记读取目标版本，通过 Visual Studio Marketplace 公共 Gallery API 查询 `hqyyqh.dynasense`。
- 若目标版本尚未公开，保持 Issue 开放且不重复评论。
- 若目标版本已公开，向 Issue 添加包含公开详情页链接的确认评论，并以 `completed` 原因关闭 Issue。
- API 暂时失败时让工作流失败并保留 Issue，下一次调度重试；不把网络故障误判为发布失败。

## 权限与幂等性

- 发布工作流权限：`contents: write`、`issues: write`。
- 验证工作流权限：`contents: read`、`issues: write`。
- Open VSX 使用 `--skip-duplicate`，允许安全重跑。
- GitHub Release 使用标签作为唯一键。
- 上传 Issue 使用精确标题和版本标记去重，工作流重跑不会创建多个待办。
- 验证工作流只处理开放且带指定标签的 Issue，关闭后不会再次处理。

## 验收标准

- release dry-run 继续完成测试、审计、打包和 artifact 上传，并跳过所有外部发布步骤。
- 使用现有 `3.0.6` 执行一次手动 `publish=true` 验证时，Open VSX 重复版本被安全跳过，GitHub Release 保持可用，并创建唯一 Marketplace 上传 Issue。
- 验证工作流能解析 Issue 版本；对于已公开的 `3.0.6`，它会评论并自动关闭 Issue。
- 工作流不再引用 `VSCE_PAT`，仓库只需要 `OVSX_PAT`。
