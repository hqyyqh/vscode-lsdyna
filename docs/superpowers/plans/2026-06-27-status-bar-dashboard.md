# 状态栏统一入口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 DynaSense 增加只在 LS-DYNA 文件中显示的状态栏统一入口，展示短状态并通过 Quick Pick 聚合高频命令、设置和诊断。

**架构：** 新增 `src/client/statusBar/dashboard.ts` 作为薄控制器，负责状态栏生命周期、事件刷新和 Quick Pick 分发。可测试的文字格式化、配置归一化和菜单项构建放在同一模块导出，`src/extension.ts` 只注入现有命令、诊断、手册和 Tab Navigation 状态。

**技术栈：** VS Code Extension API、CommonJS TypeScript、Mocha 单元测试、现有 `test/vscode-mock.js`。

---

## 文件结构

- 创建：`src/client/statusBar/dashboard.ts`
  - 负责创建 `StatusBarItem`、监听上下文刷新、展示 Quick Pick、执行动作。
  - 导出纯函数 `normalizeStatusBarLevel`、`formatDashboardText`、`buildDashboardItems` 供测试覆盖。
- 修改：`src/extension.ts`
  - 在 `activate` 中创建 dashboard，注入 include/keyword/manual/log/diagnostics/tab actions。
  - 暴露当前关键字、字段位置、手册状态、诊断数量和配置状态读取函数。
- 修改：`package.json`
  - 增加 `extension.lsdynaStatusDashboard` 命令。
  - 增加配置 `lsdyna.statusBar.level`，取值 `off/simple/detail`，默认 `simple`。
- 修改：`package.nls.json`、`package.nls.zh-cn.json`、`src/core/i18n.ts`
  - 增加配置说明、Quick Pick 文案、状态短文案。
- 创建：`test/client/statusBarDashboard.test.js`
  - 覆盖配置归一化、显示隐藏、文字格式化、菜单项构建和动作分发。

## 任务 1：写失败测试

**文件：**
- 创建：`test/client/statusBarDashboard.test.js`

- [ ] **步骤 1：编写失败测试**

测试应断言：

```javascript
assert.strictEqual(normalizeStatusBarLevel('weird'), 'simple');
assert.strictEqual(normalizeStatusBarLevel('off'), 'off');

assert.strictEqual(formatDashboardText({
  level: 'simple',
  keyword: '*PART',
  fieldIndex: 3,
  fieldCount: 8,
  manualReady: true,
  warningCount: 0,
}), 'DynaSense: *PART');

assert.strictEqual(formatDashboardText({
  level: 'detail',
  keyword: '*PART',
  fieldIndex: 3,
  fieldCount: 8,
  manualReady: true,
  warningCount: 0,
}), 'DynaSense: *PART · F3/8 · Manual OK');

assert.strictEqual(formatDashboardText({
  level: 'detail',
  keyword: '*PART',
  fieldIndex: 3,
  fieldCount: 8,
  manualReady: true,
  warningCount: 2,
}), 'DynaSense: 2 warnings');
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/statusBarDashboard.test.js`

预期：编译或测试失败，原因是 `src/client/statusBar/dashboard.ts` 尚不存在。

## 任务 2：实现状态栏纯逻辑

**文件：**
- 创建：`src/client/statusBar/dashboard.ts`
- 测试：`test/client/statusBarDashboard.test.js`

- [ ] **步骤 1：实现 `normalizeStatusBarLevel`**

有效输入为 `off/simple/detail`；其他值返回 `simple`。

- [ ] **步骤 2：实现 `formatDashboardText`**

优先级：
1. `level === 'off'` 返回空字符串。
2. `warningCount > 0` 返回 `DynaSense: 1 warning` 或 `DynaSense: N warnings`。
3. `simple` 返回 `DynaSense: <keyword>`，没有关键字时返回 `DynaSense`。
4. `detail` 拼接关键字、字段 `F<index>/<count>`、`Manual OK` 或 `Manual setup`。

- [ ] **步骤 3：运行测试验证通过**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/statusBarDashboard.test.js`

预期：新增纯逻辑测试通过。

## 任务 3：实现 Quick Pick 菜单与动作分发

**文件：**
- 修改：`src/client/statusBar/dashboard.ts`
- 修改：`test/client/statusBarDashboard.test.js`

- [ ] **步骤 1：补充失败测试**

覆盖菜单项顺序：

```javascript
const items = buildDashboardItems({ tabNavigationEnabled: true, warningCount: 2, manualReady: false });
assert.deepStrictEqual(items.map(item => item.id), [
  'scanIncludes',
  'scanKeywordIndex',
  'configureManuals',
  'showOutput',
  'copyDiagnostics',
  'toggleTabNavigation',
]);
```

- [ ] **步骤 2：实现 `buildDashboardItems`**

第一屏前三项为扫描 Include、扫描 Keyword Index、配置手册；底部为打开日志、复制诊断信息、切换 Tab Navigation。每个 item 包含 `label`、`description`、`detail`、`id`。

- [ ] **步骤 3：实现 `LsdynaStatusBarDashboard.showMenu`**

`showQuickPick` 返回 item 后，根据 `id` 调用注入的动作函数；用户取消时不执行动作。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/statusBarDashboard.test.js`

预期：菜单构建与动作分发测试通过。

## 任务 4：接入 VS Code 状态栏生命周期

**文件：**
- 修改：`src/client/statusBar/dashboard.ts`
- 修改：`src/extension.ts`
- 修改：`package.json`

- [ ] **步骤 1：注册命令与 StatusBarItem**

命令名：`extension.lsdynaStatusDashboard`。状态栏使用 `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)`，命令绑定到 dashboard 菜单。

- [ ] **步骤 2：监听刷新事件**

监听 `onDidChangeActiveTextEditor`、`onDidChangeTextEditorSelection`、`onDidChangeConfiguration`、`onDidChangeDiagnostics`。刷新节流为 100ms，避免光标移动时闪烁。

- [ ] **步骤 3：实现显示隐藏规则**

`level=off` 或非 LS-DYNA 文件隐藏；LS-DYNA 文件显示。读取 `lsdyna.statusBar.level`、`lsdyna.enableTabNavigation`、`lsdyna.manualsDir` 和当前诊断数量。

- [ ] **步骤 4：运行编译**

运行：`npm run compile`

预期：TypeScript 编译通过。

## 任务 5：补齐文案与诊断复制

**文件：**
- 修改：`src/core/i18n.ts`
- 修改：`package.nls.json`
- 修改：`package.nls.zh-cn.json`
- 修改：`src/extension.ts`

- [ ] **步骤 1：增加配置和菜单文案**

增加英文与中文文案：状态栏级别配置、扫描 Include、扫描 Keyword Index、配置手册、打开日志、复制诊断信息、切换 Tab Navigation。

- [ ] **步骤 2：实现诊断复制**

从当前活动 LS-DYNA 文档读取 `vscode.languages.getDiagnostics(uri)`，输出文件名、诊断数量、severity、line、message，并写入剪贴板；没有诊断时复制包含 `No diagnostics` 的摘要。

- [ ] **步骤 3：实现 Tab Navigation 切换**

读取 `lsdyna.enableTabNavigation`，更新到 `ConfigurationTarget.Global`，并刷新状态栏。

## 任务 6：最终验证

**文件：**
- 所有相关文件

- [ ] **步骤 1：运行针对性测试**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/statusBarDashboard.test.js`

预期：状态栏相关测试全部通过。

- [ ] **步骤 2：运行全量测试**

运行：`npm test`

预期：全量测试通过。

- [ ] **步骤 3：检查变更范围**

运行：`git diff --stat` 与 `git diff -- src/client/statusBar/dashboard.ts src/extension.ts package.json package.nls.json package.nls.zh-cn.json src/core/i18n.ts test/client/statusBarDashboard.test.js`

预期：变更聚焦于状态栏入口、文案、配置和测试。
