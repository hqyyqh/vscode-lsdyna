# Windows 外部调用安全与交付实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除 Windows shell 字符串拼接，完成风险说明、CHANGELOG、生产依赖审计和 VSIX 验证。

**架构：** 独立进程适配器只接受参数数组并强制 `shell:false`；资源管理器定位使用 VS Code API；最终通过需求逐项审计证明整个规格完成。

**技术栈：** Node.js child_process.spawn、VS Code API、Mocha、vsce、npm audit

---

## 文件结构

- 创建：`src/platform/externalProcess.ts` 与测试。
- 修改：`src/extension.ts`、`test/extension.test.js`。
- 修改：`README.md`、`README_zh.md`、`CHANGELOG.md`。
- 创建：`docs/superpowers/verification/2026-06-22-risk-tiered-technical-debt.md`。

### 任务 1：参数化 SumatraPDF 启动

**文件：**
- 创建：`src/platform/externalProcess.ts`
- 创建：`test/platform/externalProcess.test.js`
- 修改：`src/extension.ts`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：编写失败测试**

使用注入的 `spawnProcess`，对 `C:\手册 (2026) & data\SumatraPDF.exe` 和 `C:\模型 100%!\manual.pdf` 断言：exe/path 原样传入；args 为 `['-reuse-instance','-page','12',pdfPath]`；options 精确包含 `shell:false, detached:true, stdio:'ignore', windowsHide:false`；child.unref 被调用。

- [ ] **步骤 2：实现 `launchDetached` 与 `openPdfWithSumatra`**

```typescript
function launchDetached(executable, args, spawnProcess = childProcess.spawn) {
    const child = spawnProcess(executable, args, {
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
    });
    child.unref();
    return child;
}
```

`openPdfWithSumatra` 注册一次 `error` listener 并调用注入的 fallback；同步异常也调用同一 fallback，保证 fallback 最多一次。

- [ ] **步骤 3：替换 openManual**

删除路径特殊字符拒绝列表、`cmdArgs`、`start` 和 `openManualFallback` 的 shell 实现。Windows 有 Sumatra 时调用适配器；无 Sumatra 或启动失败时调用 `vscode.env.openExternal(vscode.Uri.file(pdfPath).with({ fragment: pageNum ? 'page='+pageNum : '' }))`。

- [ ] **步骤 4：运行安全测试并提交**

运行：`npm run compile && npx mocha --require test/register-out.js test/platform/externalProcess.test.js test/extension.test.js --grep "openManual|external process"`。

```powershell
git add src/platform/externalProcess.ts src/extension.ts test/platform/externalProcess.test.js test/extension.test.js
git commit -m "fix: launch PDF viewer without a shell"
```

### 任务 2：移除资源管理器 shell 调用

**文件：**
- 修改：`src/extension.ts`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：编写命令测试**

对 `extension.openIncludeFolder` 和 `extension.revealInExplorer` 触发包含中文、括号和 `&` 的路径，断言只调用：

```javascript
vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
```

并断言 `child_process.exec` 从未调用。

- [ ] **步骤 2：替换两个 Windows 分支**

删除 `process.platform` 判断，两条命令统一使用 `revealFileInOS`。保留现有用户可见错误消息。

- [ ] **步骤 3：搜索并验证无 shell 拼接**

运行：`rg -n "child_process\.exec|cmd\.exe|explorer\.exe|start \"\"" src`
预期：无匹配。

运行：`npm test`
预期：全部通过。

- [ ] **步骤 4：Commit**

```powershell
git add src/extension.ts test/extension.test.js
git commit -m "fix: reveal files through VS Code API"
```

### 任务 3：更新用户说明、CHANGELOG 与验证记录

**文件：**
- 修改：`README.md`
- 修改：`README_zh.md`
- 修改：`CHANGELOG.md`
- 创建：`docs/superpowers/verification/2026-06-22-risk-tiered-technical-debt.md`

- [ ] **步骤 1：记录行为变化**

README 说明 SumatraPDF 可精确跳页；fallback 由系统默认阅读器处理，可能忽略 `#page=`。CHANGELOG 分别记录配置契约、解析兼容性、路径上限、动态 watcher、诊断清理、UTF-8 门禁和 Windows 安全调用。

- [ ] **步骤 2：创建需求证据矩阵**

验证记录用 10 行表格对应设计规格的 10 项要求，每行包含修改文件、测试名、验证命令和结果。只记录实际输出，不写计划性措辞。

- [ ] **步骤 3：运行契约与全量测试**

运行：`npm run check:contracts`
预期：PASS。

运行：`npm test`
预期：全部通过且测试数大于 299。

- [ ] **步骤 4：Commit 文档**

```powershell
git add README.md README_zh.md CHANGELOG.md docs/superpowers/verification/2026-06-22-risk-tiered-technical-debt.md
git commit -m "docs: record technical debt remediation"
```

### 任务 4：最终审计与 VSIX 验证

**文件：**
- 修改：`docs/superpowers/verification/2026-06-22-risk-tiered-technical-debt.md`

- [ ] **步骤 1：运行编译与全量测试**

运行：`npm run compile`，预期退出 0。
运行：`npm test`，预期退出 0。

- [ ] **步骤 2：运行生产依赖审计**

运行：`npm audit --omit=dev`
预期：退出 0；若生产依赖存在漏洞，升级最小兼容版本并重新运行 compile/test/audit，不使用 `--force`。

- [ ] **步骤 3：打包 VSIX**

运行：

```powershell
New-Item -ItemType Directory -Force dist | Out-Null
npx --no-install vsce package --out dist/technical-debt-verification.vsix
```

预期：退出 0，产物存在且大小大于 0。

- [ ] **步骤 4：执行完成标准搜索**

```powershell
rg -n "9999999|child_process\.exec|lsdyna\.format\.enableOnSave|lsdyna\.index\.enableIncludeTree" src test README.md README_zh.md package.json
```

预期：无匹配。

- [ ] **步骤 5：更新验证记录并 Commit**

把命令、退出码、测试数量、audit 结果和 VSIX 大小写入验证记录。

```powershell
git add docs/superpowers/verification/2026-06-22-risk-tiered-technical-debt.md
git commit -m "test: record remediation verification evidence"
```
