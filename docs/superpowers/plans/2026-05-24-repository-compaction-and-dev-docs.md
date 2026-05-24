# Repository Compaction and Development Documentation Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 清除仓库中 `LS-DYNA Manuals` 和 `bin` 两个目录的所有历史记录以减小仓库体积，并添加 `DEVELOPMENT.md` 开发指南文档。

**架构：** 
1. 新建 `feature/cleanup-and-docs` 分支。
2. 编写并提交 `DEVELOPMENT.md`，微调 `.vscodeignore`。
3. 对所有分支执行 `git filter-branch` 清除指定目录的历史。
4. 清除 `refs/original/` 备份引用并运行 aggressive GC 压缩 `.git` 库。

**技术栈：** Git, Node.js

---

### 任务 1：新建分支与文档编写

**文件：**
- 创建：`DEVELOPMENT.md`
- 修改：`.vscodeignore`

- [ ] **步骤 1：新建开发分支**

运行：
```powershell
git checkout -b feature/cleanup-and-docs
```
预期：切换到新分支 `feature/cleanup-and-docs`。

- [ ] **步骤 2：创建 DEVELOPMENT.md**

创建 `DEVELOPMENT.md` 并写入以下内容：
```markdown
# VS Code LS-DYNA Extension Development Guide

This guide describes how to set up the development environment, run tests, compile/package the extension, and configure local manuals.

## 1. Environment Setup

- **Node.js**: Recommended version >= 16.x.
- **VS Code**: Required for testing and local run/debug.

To install dependencies:
```bash
npm install
```

## 2. Development & Testing

### Running the Extension Locally
1. Open this project folder in VS Code.
2. Press `F5` (or go to Run and Debug -> click "Run Extension"). This will launch a new VS Code window (Extension Development Host) with the local version of this extension loaded.

### Running Unit Tests
We use the official VS Code Extension Testing library.
Run the tests:
```bash
npm test
```
*Note: This command will download a test VS Code instance if it is not already cached, and execute all tests located in the `test/` directory.*

## 3. Compilation & Packaging

To compile and package the extension into a `.vsix` file for installation:
```bash
npx -y @vscode/vsce package --no-git-tag-version --no-update-package-json
```
This generates a file named `lsdyna-custom-<version>.vsix` in the root directory.

## 4. PDF Manual & SumatraPDF Integration Configuration

For manual lookups and exact page jumps to function correctly:
1. **Manuals Directory**: Configure the absolute or workspace-relative path in VS Code settings under `lsdyna.manualsDir`.
2. **SumatraPDF.exe (Windows)**:
   - On Windows, copy `SumatraPDF.exe` directly into the manuals directory configured above.
   - The extension will read PDF manual structures, build bookmark caches, and monitor changes in this directory.
   - If `SumatraPDF.exe` is missing from the manuals directory, the extension will gracefully fall back to the system default PDF reader (without page navigation).
```

- [ ] **步骤 3：修改 .vscodeignore**

将 `.vscodeignore` 中的 `bin` 规则简化。
修改前的第 14-15 行：
```
bin/**
!bin/SumatraPDF.exe
```
修改为：
```
bin
```

- [ ] **步骤 4：本地验证与提交**

运行 `git status` 确保修改正确，然后执行：
```powershell
git add DEVELOPMENT.md .vscodeignore
git commit -m "docs: add DEVELOPMENT.md and update vscodeignore for manuals config"
```
预期：提交成功。

---

### 任务 2：执行 Git 历史清理与仓库压缩

- [ ] **步骤 1：运行 git filter-branch 清理历史**

对所有分支的历史记录进行重写，剔除 `LS-DYNA Manuals` 和 `bin` 两个目录：
```powershell
git filter-branch --force --index-filter "git rm -rf --cached --ignore-unmatch 'LS-DYNA Manuals' bin" --prune-empty --tag-name-filter cat -- --all
```
预期：命令运行并重写所有分支（包含 `master`, `dev`, `feature/cleanup-and-docs` 等）的 commit。

- [ ] **步骤 2：删除 refs/original/ 备份**

删除 filter-branch 生成的备份引用：
```powershell
git for-each-ref --format="%(refname)" refs/original/ | foreach { git update-ref -d $_ }
```
预期：无输出，原备份 ref 被清理。

- [ ] **步骤 3：清理 Reflog 并运行 aggressive 垃圾回收**

运行：
```powershell
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```
预期：运行成功，且控制台输出垃圾回收及对象打包压缩进度。

- [ ] **步骤 4：体积验证**

运行：
```powershell
Get-ChildItem .git -Recurse | Measure-Object -Property Length -Sum
```
预期：`.git` 目录的总大小（Sum）从之前的 ~300MB 缩减至几兆字节（通常在 10MB 以下）。

- [ ] **步骤 5：验证本地目录状态**

由于历史中已经移除了 `LS-DYNA Manuals` 和 `bin` 目录，检查本地工作区：
- `LS-DYNA Manuals` 和 `bin` 如果还存在于当前未受 Git 跟踪的文件中，若不需要，应手动删除它们，保持工作树完全干净。
运行：
```powershell
git status
```
预期：没有未 commit 的修改，工作树干净。如果显示有未跟踪的 `LS-DYNA Manuals` 和 `bin` 目录，可以手动使用 `Remove-Item -Recurse -Force 'LS-DYNA Manuals', bin` 彻底移除本地副本。
