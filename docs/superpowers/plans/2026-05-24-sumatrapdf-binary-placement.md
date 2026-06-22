# SumatraPDF 二进制文件放置与配置实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将宿主系统中的 `SumatraPDF.exe` 复制到项目 `bin` 目录，并更新配置以实现稳健的代码管理与打包。

**架构：**
1. 创建 `bin` 文件夹，并将 `C:\Users\qyang\Downloads\SumatraPDF.exe` 复制到 `bin/SumatraPDF.exe`。
2. 更新 `.gitignore` 与 `.vscodeignore` 配置文件以显式包含 `bin/SumatraPDF.exe`（Option 2：显式排除忽略/显式包含规则）。
3. 验证文件存在性并提交 commit。

**技术栈：** Shell 命令 (Windows cmd / PowerShell), Git.

---

### 任务 1：创建 bin 文件夹并复制 SumatraPDF.exe

**文件：**
- 创建：`bin/SumatraPDF.exe` (复制自 `C:\Users\qyang\Downloads\SumatraPDF.exe`)

- [ ] **步骤 1：创建 bin 文件夹并复制二进制文件**
  在 Windows 命令行下运行命令，创建 `bin` 文件夹并将 `C:\Users\qyang\Downloads\SumatraPDF.exe` 复制到 `d:\Project\vscode-lsdyna\bin\SumatraPDF.exe`。

  运行：
  ```powershell
  New-Item -ItemType Directory -Force -Path d:\Project\vscode-lsdyna\bin
  Copy-Item -Path "C:\Users\qyang\Downloads\SumatraPDF.exe" -Destination "d:\Project\vscode-lsdyna\bin\SumatraPDF.exe" -Force
  ```
  预期：命令执行成功且无报错。

---

### 任务 2：更新 gitignore 与 vscodeignore

**文件：**
- 修改：`.gitignore`
- 修改：`.vscodeignore`

- [ ] **步骤 1：修改 .gitignore**
  在 `.gitignore` 末尾追加显式不忽略 `bin/SumatraPDF.exe` 的配置。

  修改内容：
  ```gitignore
  # Ensure bundled SumatraPDF binary is tracked
  !bin/SumatraPDF.exe
  ```

- [ ] **步骤 2：修改 .vscodeignore**
  在 `.vscodeignore` 末尾追加配置确保 `bin/SumatraPDF.exe` 不被打包忽略。

  修改内容：
  ```vscodeignore
  # Ensure bundled SumatraPDF binary is packaged in the extension
  !bin/SumatraPDF.exe
  ```

---

### 任务 3：验证二进制文件与配置

- [ ] **步骤 1：在 PowerShell 中验证可执行文件是否存在**
  运行：
  ```powershell
  Test-Path bin/SumatraPDF.exe
  ```
  预期输出：`True`

- [ ] **步骤 2：验证 Git 追踪状态**
  运行：
  ```bash
  git status
  ```
  预期输出：显示 `bin/SumatraPDF.exe`、`.gitignore`、`.vscodeignore` 均处于已修改或未追踪状态，且没有被 `.gitignore` 过滤。

---

### 任务 4：Git 提交修改

- [ ] **步骤 1：添加并提交文件**
  运行：
  ```bash
  git add bin/SumatraPDF.exe .gitignore .vscodeignore docs/superpowers/specs/2026-05-24-sumatrapdf-binary-placement-design.md docs/superpowers/plans/2026-05-24-sumatrapdf-binary-placement.md
  git commit -m "feat: add bundled SumatraPDF binary and config files"
  ```
  预期：提交成功，生成对应 commit。
