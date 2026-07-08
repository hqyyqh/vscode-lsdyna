# 首次启动自检面板实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 UX-001 首次启动自检面板，让用户在打开 LS-DYNA 文件后通过状态栏 Dashboard 查看语言、workspace、手册、PDF、书签索引、SumatraPDF、关键字数据库和项目工具状态，并在首次异常时收到一次轻量提示。

**架构：** 新增 `src/client/services/healthService.ts` 作为轻量状态聚合层，返回结构化 health items，不做重扫描。现有 `src/client/statusBar/dashboard.ts` 增加“Environment Status”入口和 health Quick Pick 展示；`src/extension.ts` 负责注入 VS Code API、i18n 文案、命令动作和首次提示状态。

**技术栈：** VS Code Extension API、CommonJS TypeScript、Mocha 单元测试、现有 i18n 和状态栏 Dashboard。

---

## 文件结构

- 创建：`src/client/services/healthService.ts`
  - 职责：轻量计算 health report，解析手册目录候选、PDF/Sumatra 状态、关键字数据库状态、项目工具可用性；提供缓存和首次提示判断。
- 创建：`test/client/services/healthService.test.js`
  - 职责：TDD 覆盖 health item、issue count、缓存、首次提示判断。
- 修改：`src/client/statusBar/dashboard.ts`
  - 职责：Dashboard 菜单新增 `showHealth` 项，支持展示 health report 的 Quick Pick。
- 修改：`test/client/statusBarDashboard.test.js`
  - 职责：覆盖菜单顺序和 `showHealth` 动作分发。
- 修改：`src/extension.ts`
  - 职责：创建 HealthService，注册 `extension.showHealthStatus` 命令，把 health 状态接入状态栏文字、Dashboard、首次异常提示。
- 修改：`src/core/i18n.ts`
  - 职责：新增中英文 health 文案，采用自然工程工具口吻。
- 修改：`package.json`、`package.nls.json`、`package.nls.zh-cn.json`
  - 职责：新增命令、激活事件、配置 `lsdyna.health.showFirstRunNotice`。
- 修改：`README.md`、`README_zh.md`
  - 职责：补充新配置，满足项目契约。
- 修改：`test/vscode-mock.js`
  - 职责：补充 `globalState`、通知/命令 mock 所需 API。

## 任务 1：HealthService 红灯测试

**文件：**
- 创建：`test/client/services/healthService.test.js`

- [ ] **步骤 1：写失败测试**

覆盖：

```javascript
const report = service.getReport({
  document: { languageId: 'lsdyna', uri: { fsPath: '/ws/main.k' } },
  workspaceFolders: [{ uri: { fsPath: '/ws' } }],
});
assert.equal(report.items.length, 8);
assert.equal(report.issueCount, 0);
assert.equal(report.ready, true);
```

以及手册目录缺失时 `manualsDir`、`pdfFiles`、`manualIndex` 为 warning，`issueCount > 0`。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/services/healthService.test.js`

预期：失败，原因是 `healthService` 模块不存在。

## 任务 2：实现 HealthService

**文件：**
- 创建：`src/client/services/healthService.ts`

- [ ] **步骤 1：实现结构化模型**

Health item 字段：`id`、`state`、`labelKey`、`descriptionKey`、`detailKey`、`actionId`、`metadata`。

状态只用三类：`ready`、`warning`、`info`。

- [ ] **步骤 2：实现轻量检查**

检查项：

1. `language`
2. `workspace`
3. `manualsDir`
4. `pdfFiles`
5. `manualIndex`
6. `sumatra`
7. `keywordDatabase`
8. `projectTools`

不触发 Include Tree 扫描，不解析 PDF。

- [ ] **步骤 3：实现缓存与失效**

`getReport(input)` 基于配置和活动文件缓存；`invalidate()` 清空缓存。手册配置变化、语言变化或手册重新初始化后由外部调用失效。

- [ ] **步骤 4：实现首次提示判断**

`shouldShowHealthNotice` 在 `showFirstRunNotice=true`、当前是 LS-DYNA 文件、存在 warning，且首次或异常签名变化时返回 true。

## 任务 3：Dashboard 接入

**文件：**
- 修改：`src/client/statusBar/dashboard.ts`
- 修改：`test/client/statusBarDashboard.test.js`

- [ ] **步骤 1：写失败测试**

断言 Dashboard 第一项为 `showHealth`，且选择后调用 `actions.showHealth`。

- [ ] **步骤 2：实现菜单项**

`showHealth` 放在第一项。描述用 `Ready` 或 `{0} setup items`，detail 告诉用户“Check manuals, PDF index, SumatraPDF, language mode, and project tools.”

## 任务 4：扩展接入与首次提示

**文件：**
- 修改：`src/extension.ts`

- [ ] **步骤 1：创建 HealthService**

注入：`fs`、`path`、workspace folders、manualsDir、manualIndexer count、Sumatra resolver、field data loader、命令可用性。

- [ ] **步骤 2：注册命令**

命令：`extension.showHealthStatus`。展示 Quick Pick health report。选择异常项时执行对应动作：配置手册、扫描 Include、扫描 Keyword Index、打开日志。

- [ ] **步骤 3：首次异常提示**

打开 LS-DYNA 文件后，如果 `shouldShowHealthNotice` 返回 true，用 `showInformationMessage` 轻提示一次，按钮为“View Status”和“Later”。选择 View Status 打开 health report。

## 任务 5：文案、配置、文档

**文件：**
- 修改：`src/core/i18n.ts`
- 修改：`package.json`
- 修改：`package.nls.json`
- 修改：`package.nls.zh-cn.json`
- 修改：`README.md`
- 修改：`README_zh.md`

- [ ] **步骤 1：中英文运行时文案**

英文避免中式表达，例如 “Manual setup needed” 而非 “Manual not configured”; 中文避免夹杂英文说明，例如“需要配置手册”而非“Manual setup”。

- [ ] **步骤 2：新增配置**

`lsdyna.health.showFirstRunNotice`，默认 `true`。

## 任务 6：验证

- [ ] **步骤 1：专项测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/services/healthService.test.js test/client/statusBarDashboard.test.js`

- [ ] **步骤 2：项目契约**

运行：`npm run compile && npx mocha --require test/register-out.js test/projectContracts.test.js`

- [ ] **步骤 3：全量测试**

运行：`npm test`
