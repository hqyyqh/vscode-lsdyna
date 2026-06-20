# DynaSense 双市场自动发布设计

**目标：** 将 DynaSense 的持续集成与发布职责拆开；日常提交只验证代码，正式版本由语义化 Git 标签触发，并把同一份 VSIX 发布到 Visual Studio Marketplace、Open VSX 和 GitHub Release。

## 触发模型

- `dev` 和 `master` 的 push、面向这两个分支的 pull request 运行 CI，不产生外部发布副作用。
- `v*.*.*` 标签触发正式发布。标签去掉 `v` 后必须与 `package.json` 的版本完全一致。
- 发布工作流同时提供 `workflow_dispatch`：默认只做 dry-run；显式勾选发布时才访问商店凭据。
- GitHub Actions 使用 release concurrency group，避免同一标签重复并发发布。

## 构建与发布

1. 使用 Node.js 20 和 `npm ci` 恢复锁定依赖。
2. 运行完整测试与生产依赖审计。
3. 使用项目锁定的 `vsce` 生成 `dynasense-<version>.vsix`。
4. 上传 VSIX 为 Actions artifact。
5. 正式发布时先检查 `VSCE_PAT` 与 `OVSX_PAT` 是否存在，但绝不输出值。
6. `vsce` 与 `ovsx` 发布同一文件，并启用重复版本跳过，使失败后的重跑具有幂等性。
7. 标签触发时创建或更新对应 GitHub Release，并附加同一 VSIX。

## 凭据边界

- Visual Studio Marketplace 凭据保存在仓库 Secret `VSCE_PAT`。
- Open VSX 凭据保存在仓库 Secret `OVSX_PAT`。
- 令牌只通过 GitHub Actions 环境变量注入；不写入仓库、日志、命令参数记录或聊天。
- 已在聊天中出现过的令牌一律视为失效，不允许重新使用。

## 分支策略

- `dev` 保留为后续开发分支。
- 本次自动化配置先在隔离分支验证，再合并到 `dev`。
- `master` 随后快进或普通合并到 `dev` 的同一发布自动化提交，成为稳定分支。
- 后续版本流程为：在 `dev` 完成开发与版本提升，合并到 `master`，确认 CI 后从 `master` 创建并推送 `vX.Y.Z` 标签。

## 验收标准

- CI 实际运行 `npm ci`、`npm test` 与 `npm audit --omit=dev`。
- release dry-run 能完成版本读取、测试、审计、VSIX 打包和 artifact 上传，不访问商店。
- 正式标签发布只接受与 `package.json` 匹配的版本。
- 两个市场与 GitHub Release 使用同一个 VSIX 文件。
- `dev` 与 `master` 均保留在远端，并包含自动化配置。
