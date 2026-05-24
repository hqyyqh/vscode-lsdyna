# SumatraPDF Test Suite Refactoring Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 重构 `test/extension.test.js` 中 `extension.openManual command` 测试套件，以全面测试 Windows 上的 SumatraPDF 探测、启动及各种 Fallback 行为，并最终验证所有 180+ 测试用例通过。

**架构：** 使用 Node.js 的 mocha 和 assert，通过 mock `child_process.spawn`、`child_process.exec`、`fs.existsSync` 和 `process.platform`，来验证不同的检测优先级与异常流。

**技术栈：** VS Code Extension, Mocha, Node.js child_process, assert

---

### 任务 1：重构测试套件并运行单元测试

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：重构 `test/extension.test.js` 中的测试**
  替换旧的 `extension.openManual command` 测试套件（大概在 1716 行到文件结尾）。
  编写新测试用例，覆盖：
  1. 用户自定义路径配置优先且生效。
  2. 使用内置打包的 `bin/SumatraPDF.exe`。
  3. 通过系统注册表查询 App Paths 定位已安装的 SumatraPDF。
  4. 使用环境变量 `PATH`。
  5. 使用硬编码启发式常见路径（如 `C:\Program Files\SumatraPDF\SumatraPDF.exe`）。
  6. 在 Windows 平台上，如果找不到 SumatraPDF.exe，或者 spawn 抛出 error 事件，则优雅回退使用 `openManualFallback`（即通过 Windows 的 `start` 命令打开）。
  7. 非 Windows 平台（如 `darwin`）直接调用 `vscode.env.openExternal`。

- [ ] **步骤 2：运行单元测试**
  运行：`npx mocha test --recursive --timeout 10000`
  预期：所有测试通过（180+ tests passing）。

- [ ] **步骤 3：Commit 变更**
  ```bash
  git add test/extension.test.js docs/superpowers/specs/2026-05-24-test-refactoring-and-validation-design.md docs/superpowers/plans/2026-05-24-test-refactoring-and-validation.md
  git commit -m "test: refactor test suite for SumatraPDF integration"
  ```
