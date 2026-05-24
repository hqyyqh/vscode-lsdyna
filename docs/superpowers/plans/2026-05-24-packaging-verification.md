# VS Code LS-DYNA Extension Packaging Verification Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 运行 VS Code 官方打包命令验证插件能成功打包生成 vsix 文件，并在此之后清理工作区。

**架构：** 使用 `npx -y @vscode/vsce package` 命令，在临时验证后直接通过 PowerShell `Remove-Item` 删除生成的 vsix，最后检查 `git status`。

**技术栈：** PowerShell, VS Code Extension (`@vscode/vsce`), Git

---

### 任务 1：全局打包和验证

**文件：**
- 修改：无
- 验证：`lsdyna-custom-2.0.7-hqyyqh.0.vsix`

- [ ] **步骤 1：试运行 vsce package 命令验证打包**
  
  运行：`npx -y @vscode/vsce package --no-git-tag-version --no-update-package-json`
  预期：打包成功结束，并有输出显示已生成打包文件。

- [ ] **步骤 2：验证生成的 vsix 文件存在**

  运行：`Test-Path "lsdyna-custom-2.0.7-hqyyqh.0.vsix"`
  预期：返回 `True`。

- [ ] **步骤 3：清理打包生成的 vsix 文件**

  运行：`Remove-Item -Path "lsdyna-custom-2.0.7-hqyyqh.0.vsix" -ErrorAction SilentlyContinue`
  预期：文件被成功删除，且 `Test-Path "lsdyna-custom-2.0.7-hqyyqh.0.vsix"` 返回 `False`。

- [ ] **步骤 4：Commit**

  运行：
  ```powershell
  git add docs/superpowers/plans/2026-05-24-packaging-verification.md
  git commit -m "docs: add packaging verification plan"
  ```
  预期：运行成功。

- [ ] **步骤 5：最终 Git Status 检查**

  运行：`git status`
  预期：除未跟踪的文件外（如设计和计划文档），没有任何未 committed 的受跟踪修改，工作区是干净的。
