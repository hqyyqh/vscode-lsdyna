# DynaSense 3.0.6 双市场发布实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复当前测试基线、从当前 `dev` 源码生成 `hqyyqh.dynasense@3.0.6` 的唯一 VSIX，并将同一文件发布到 Visual Studio Marketplace 与 Open VSX。

**架构：** 产品实现保持不变；先同步测试基础设施与近期已提交的异步/显示行为，再用路径无关的缓存预算测试消除工作区差异。版本、Git 标签、VSIX 哈希和两个市场的公开版本保持一一对应。

**技术栈：** TypeScript 6、Node.js 22、Mocha 10、`@vscode/vsce` 3.9、Open VSX `ovsx` CLI、Visual Studio Marketplace/Open VSX 公开 API。

---

## 文件结构

- 修改：`test/vscode-mock.js` — 补齐扩展激活需要的格式化提供器 API。
- 修改：`test/client/providers/phase7_features.test.js` — 同步字段注释补全契约。
- 修改：`test/extension.test.js` — 等待异步悬浮结果并同步 CodeLens/托管注释断言。
- 修改：`test/core/cache/diskSnapshotStore.test.js` — 消除 LRU 测试对绝对路径长度的依赖。
- 修改：`package.json`、`package-lock.json` — 版本同步为 `3.0.6`。
- 创建：`dynasense-3.0.6.vsix` — 两个市场共用且不提交 Git 的发布制品。

### 任务 1：恢复扩展激活测试桩

**文件：**
- 修改：`test/vscode-mock.js:182`
- 测试：`test/client/providers/phase7_features.test.js`
- 测试：`test/extension.test.js`

- [ ] **步骤 1：验证红灯**

运行：

```powershell
npx mocha --require test/register-out.js test/client/providers/phase7_features.test.js test/extension.test.js --grep "registers document links|change document language|configureManualsDir" --reporter dot
```

预期：FAIL，错误包含 `registerDocumentFormattingEditProvider is not a function`。

- [ ] **步骤 2：加入最小桩**

在 `vscodeMock.languages` 中加入：

```javascript
registerDocumentFormattingEditProvider: () => ({ dispose() {} }),
registerDocumentRangeFormattingEditProvider: () => ({ dispose() {} }),
```

- [ ] **步骤 3：重跑步骤 1**

预期：相关测试 PASS，不再提前退出并污染共享 mock。

### 任务 2：同步字段注释补全契约

**文件：**
- 修改：`test/client/providers/phase7_features.test.js:265-333`

- [ ] **步骤 1：验证红灯**

```powershell
npx mocha --require test/register-out.js test/client/providers/phase7_features.test.js --grep "generateCommentLine|comment completion|completion item with documentation" --reporter spec
```

预期：3 个断言因旧的大写字段名与旧标签 `$#` 失败。

- [ ] **步骤 2：同步到已提交的显示行为**

使用以下断言：

```javascript
assert.strictEqual(result, '$#   secid       mid    elform');
assert.strictEqual(item.label, item.insertText.trimEnd());
assert.ok(item.label.includes('secid'));
assert.strictEqual(items[0].label, items[0].insertText.trimEnd());
assert.ok(items[0].label.includes('pstiff'));
assert.ok(items[0].documentation.value.includes('pstiff'));
```

- [ ] **步骤 3：重跑步骤 1**

预期：相关测试全部 PASS；原有整行替换范围断言继续通过。

### 任务 3：同步异步悬浮契约

**文件：**
- 修改：`test/extension.test.js:1336-1875`

- [ ] **步骤 1：验证红灯**

```powershell
npx mocha --require test/register-out.js test/extension.test.js --grep "skips hover work|LsdynaFieldHoverProvider" --reporter dot
```

预期：旧测试收到 `Promise` 而非同步 `Hover|null`。

- [ ] **步骤 2：显式等待所有悬浮结果**

把大文件悬浮测试及 `describe('LsdynaFieldHoverProvider')` 内调用悬浮提供器的测试回调改为 `async`，将每个结果读取改为：

```javascript
const hover = await provider.provideHover(doc, position);
```

`titleHover`、`commentHover`、`dataHover`、`kwHover`、`fieldHover` 均使用显式 `await`；空结果仍严格断言 `null`。

- [ ] **步骤 3：重跑步骤 1**

预期：相关测试全部 PASS，无未处理 Promise rejection。

### 任务 4：同步 CodeLens 与托管注释断言

**文件：**
- 修改：`test/extension.test.js:1885-2140`

- [ ] **步骤 1：验证红灯**

```powershell
npx mocha --require test/register-out.js test/extension.test.js --grep "CodeLens entries|managed TITLE|orphan strict|localizes keyword option" --reporter spec
```

预期：旧断言期待 1 个 CodeLens、右对齐宽字段注释和旧长标题。

- [ ] **步骤 2：按命令身份断言三个 CodeLens**

```javascript
assert.equal(lenses.length, 3);
assert.ok(lenses.some(lens => lens.command.command === 'extension.lsdynaChooseKeywordOptions'));
assert.ok(lenses.some(lens => lens.command.command === 'extension.selectKeyword'));
assert.ok(lenses.some(lens => lens.command.command === 'extension.lsdynaFormatSelection'));
```

本地化测试查找 `extension.lsdynaChooseKeywordOptions` 对应项，再断言标题包含 `选项`。

- [ ] **步骤 3：同步宽字段托管注释夹具**

使用当前生成器的左对齐形式：

```javascript
'$# title                                                                        '
'$# cid                                                               heading'
```

输入与期望同时更新，以继续验证添加、识别、删除托管注释。

- [ ] **步骤 4：重跑步骤 1**

预期：相关测试全部 PASS。

### 任务 5：消除缓存预算测试的路径依赖

**文件：**
- 修改：`test/core/cache/diskSnapshotStore.test.js:170-206`

- [ ] **步骤 1：验证红灯**

```powershell
npx mocha --require test/register-out.js test/core/cache/diskSnapshotStore.test.js --grep "evicts least recently used" --reporter spec
```

预期：固定 `2500` 字节在长路径工作区只能保留 C，旧断言期待 C、B。

- [ ] **步骤 2：按实际载荷校准预算**

在独立临时目录以无限预算持久化相同三份快照，读取 `byteSize` 后计算：

```javascript
const sizes = calibrationStore.listEntries().map(entry => entry.byteSize);
const maxCacheBytes = Math.max(
    sizes[0] + sizes[1],
    sizes[0] + sizes[2],
    sizes[1] + sizes[2]
);
```

用该预算创建被测 store；任意两项可共存、三项必超限。`finally` 删除校准目录和被测目录。

- [ ] **步骤 3：重跑步骤 1**

预期：PASS，条目顺序为 C、B，总字节数不超过校准预算。

### 任务 6：提交测试基线修复

**文件：**
- 修改：上述四个测试文件

- [ ] **步骤 1：完整验证**

```powershell
npm test
git diff --check
```

预期：289 passing、0 failing；空白检查无输出。

- [ ] **步骤 2：提交**

```powershell
git add test/vscode-mock.js test/client/providers/phase7_features.test.js test/extension.test.js test/core/cache/diskSnapshotStore.test.js
git commit -m "test: restore release verification baseline"
```

### 任务 7：版本、审计与唯一 VSIX

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`dynasense-3.0.6.vsix`

- [ ] **步骤 1：提升版本**

```powershell
npm version 3.0.6 --no-git-tag-version
```

预期：两个版本文件的根包版本均为 `3.0.6`。

- [ ] **步骤 2：验证与生产依赖审计**

```powershell
npm test
npm audit --omit=dev
```

预期：289 passing；生产依赖无 high/critical 漏洞。开发依赖告警单独记录。

- [ ] **步骤 3：打包与哈希**

```powershell
npx vsce package --out dynasense-3.0.6.vsix
Get-FileHash dynasense-3.0.6.vsix -Algorithm SHA256
tar -tf dynasense-3.0.6.vsix
```

确认标识 `hqyyqh.dynasense@3.0.6`，包内有入口、许可证、三个图标和两个字段数据 JSON；无 `src/`、`test/`、`.git/`、`.github/`、`docs/`、旧 VSIX 或令牌。

- [ ] **步骤 4：提交并打标签**

```powershell
git add package.json package-lock.json
git commit -m "chore: release 3.0.6"
git tag -a v3.0.6 -m "DynaSense 3.0.6"
```

### 任务 8：集成并推送发布源

**文件：**
- 无新增文件

- [ ] **步骤 1：快进主工作区**

```powershell
git -C D:\Project\vscode-lsdyna merge --ff-only codex/publish-3.0.6
```

- [ ] **步骤 2：最终本地验证**

```powershell
git status --short --branch
git rev-parse HEAD
git rev-list -n 1 v3.0.6
npm test
```

预期：主工作树干净、HEAD 与标签一致、289 passing。

- [ ] **步骤 3：推送分支和标签**

```powershell
git push origin dev
git push origin v3.0.6
```

预期：远端 `dev` 与 `v3.0.6` 指向发布提交。

### 任务 9：Visual Studio Marketplace 发布

**文件：**
- 发布：`D:\Project\vscode-lsdyna\.worktrees\publish-3.0.6\dynasense-3.0.6.vsix`

- [ ] **步骤 1：在 <https://marketplace.visualstudio.com/manage> 登录并创建或选择发布者 `hqyyqh`。**

- [ ] **步骤 2：选择 “New extension → Visual Studio Code”，上传唯一 VSIX 并确认发布。**

预期：管理页显示 `DynaSense 3.0.6`；验证码或账户授权由用户本人完成。

- [ ] **步骤 3：轮询 Gallery API 并打开详情页。**

<https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense>

通过标准：公开数据为 `publisher=hqyyqh`、`name=dynasense`、`version=3.0.6`。

### 任务 10：Open VSX 发布

**文件：**
- 发布：同一份 `dynasense-3.0.6.vsix`

- [ ] **步骤 1：在 <https://open-vsx.org/user-settings/profile> 登录、关联 Eclipse 账户并接受 Publisher Agreement。**

- [ ] **步骤 2：在 <https://open-vsx.org/user-settings/tokens> 创建本机发布令牌。**

- [ ] **步骤 3：在不记录令牌的交互式 PowerShell 中设置进程级 `OVSX_PAT` 并执行：**

```powershell
npx --yes ovsx create-namespace hqyyqh
npx --yes ovsx publish D:\Project\vscode-lsdyna\.worktrees\publish-3.0.6\dynasense-3.0.6.vsix
Remove-Item Env:OVSX_PAT -ErrorAction SilentlyContinue
```

- [ ] **步骤 4：轮询 API 并打开详情页。**

<https://open-vsx.org/api/hqyyqh/dynasense>

<https://open-vsx.org/extension/hqyyqh/dynasense>

通过标准：公开数据为 `namespace=hqyyqh`、`name=dynasense`、`version=3.0.6`。

### 任务 11：持续监控与交付

**文件：**
- 无新增文件

- [ ] **步骤 1：若公开索引延迟，创建 5 分钟间隔的当前线程心跳；两个市场均公开后停止。**

- [ ] **步骤 2：记录并交付两个公开链接、Git 标签 `v3.0.6`、VSIX SHA-256 和最终验证时间。**

只有两个市场都公开可访问且版本一致，才声明发布完成。
