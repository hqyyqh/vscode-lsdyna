# vscode-lsdyna 大文件方案执行记录（Phase 0 + Phase 1 首批落地）

## 1. 记录元信息

- **执行日期**：2026-05-22
- **执行分支**：`large-file-phase0-1`
- **执行工作区**：`D:\Project\vscode-lsdyna\.worktrees\large-file-phase0-1`
- **基线提交**：`539b7b4`（`chore: ignore worktree directory` 之后创建 worktree）
- **对应方案文档**：`.github\doc\large_file_rollout_plan.md`
- **本轮目标**：
  1. 清理基线阻塞，建立可验证起点
  2. 完成大文件改造的第一批可复用模块抽取
  3. 将入口文件从“承担全部实现”往“装配入口”方向推进
  4. 保留现有行为，不引入功能性回退

---

## 2. 本轮执行结论

本轮已经完成了企业级渐进式改造中的**首个可落地批次**：

1. **先修复基线失败用例**，确保后续每次回归都能明确归因。
2. **抽取了可复用的流式解析核心**：
   - `src/core/parser/includeScanner.js`
   - `src/core/parser/keywordScanner.js`
3. **将两个 Tree Provider 从入口文件中拆出**：
   - `src/client/providers/includeTreeProvider.js`
   - `src/client/providers/keywordIndexProvider.js`
4. **让 `src/extension.js` 回到“装配与注册”角色**，不再承载全部 Include Tree / Keyword Index 具体实现。
5. **补齐新模块测试**，并恢复全量测试为绿色。

这意味着：当前仓库已经从“单文件承载大量扫描逻辑”的状态，进入了“核心扫描器 + 客户端 provider + 入口装配”的可持续演进结构。

---

## 3. 为什么实际执行顺序与原计划有轻微调整

原计划中 Phase 0 是先拆 Provider，Phase 1 再抽扫描核心。  
本轮执行时做了一个更稳妥的顺序调整：

1. **先修基线**
2. **先抽扫描器**
3. **再拆 Provider**

原因如下：

1. 当前 `LsdynaIncludeTreeProvider` 和 `LsdynaKeywordIndexProvider` 严重依赖入口文件中的扫描细节。  
   如果直接先搬 Provider，只会把大量耦合原封不动搬到新文件里，形成新的脆弱边界。

2. 先抽 `includeScanner` / `keywordScanner` 后，Provider 模块可以直接依赖稳定的扫描接口，拆分就更干净。

3. 这是一次**工程顺序调整**，不是设计目标变更：最终方向仍然与 `large_file_rollout_plan.md` 一致。

---

## 4. 基线问题与处理过程

## 4.1 worktree 目录未被忽略

### 现象

仓库中不存在 `.worktrees/` 或 `worktrees/`，且 `.gitignore` 未忽略 `.worktrees/`。

### 处理

在主工作区先完成以下修正：

- 修改：`D:\Project\vscode-lsdyna\.gitignore`
- 新增忽略项：`.worktrees/`
- 提交：`539b7b4 chore: ignore worktree directory`

### 结果

之后基于该提交创建隔离工作区：

- `D:\Project\vscode-lsdyna\.worktrees\large-file-phase0-1`

这一步保证后续执行在独立分支中进行，不污染原始工作区。

## 4.2 基线测试存在预先失败

### 现象

刚创建好 worktree 后，`npm test` 存在 1 个失败用例：

- `LsdynaFieldHoverProvider preserves embedded help newlines as markdown hard breaks`

### 根因

当前实现读取的是 `keywords/field_data.json`，而测试期望的内容来自带中文扩展说明的 `keywords/field_data_zh.json`。

### 修正

修改：

- `src/extension.js`

处理方式：

1. `getFieldData()` 优先读取 `field_data_zh.json`
2. 如果不存在，再回退到 `field_data.json`

### 结果

基线恢复为全绿，后续所有回归都具备可靠的比较基准。

---

## 5. 本轮实际代码改动

## 5.1 抽取 Include 流式扫描器

新增：

- `src/core/parser/includeScanner.js`

沉淀出的能力：

1. `collectIncludeDirectivesFromLineReader()`
2. `collectIncludeDirectivesFromFile()`
3. `includeEntryContainsLine()`
4. `getIncludeEntryRanges()`

说明：

- 该模块直接承接原来入口文件中的 include 解析逻辑。
- 保留了当前的流式扫描思路，不回退到全量读文件。
- 这样后续无论是 Worker、LSP 还是缓存层，都可以复用同一份 include 解析代码。

## 5.2 抽取 Keyword 流式扫描器

新增：

- `src/core/parser/keywordScanner.js`

沉淀出的能力：

1. `collectKeywordsFromLineReader()`
2. `collectKeywordsFromFile()`

说明：

- 单文件关键字提取不再内嵌在 `LsdynaKeywordIndexProvider` 里。
- 这为下一步做项目级索引聚合、缓存和后台调度打下了可复用输入层。

## 5.3 Provider 模块化

新增：

- `src/client/providers/includeTreeProvider.js`
- `src/client/providers/keywordIndexProvider.js`

处理方式：

1. 将两个 Provider 的类实现迁移出 `src/extension.js`
2. 改为通过构造参数注入依赖：
   - `searchFileFromPaths`
   - `collectIncludeFiles`
   - `shouldSkipAutomaticDocumentScan`

这样做的价值：

1. Provider 不再需要知道整个入口文件的所有细节
2. 后续把后台实现从 Extension Host 切到 Worker / LSP 时，Provider 无需重写
3. 入口文件开始具备“依赖装配器”的形态

## 5.4 入口文件瘦身

修改：

- `src/extension.js`

变化点：

1. 删除了原先内嵌的 Provider 类实现
2. 改为引入新模块并在 `activate()` 中装配依赖
3. `_internals` 额外导出：
   - `collectIncludeFiles`
   - `shouldSkipAutomaticDocumentScan`

结果：

- `src/extension.js` 不再同时承担：
  - UI 注册
  - Provider 细节实现
  - 扫描器全部实现

虽然它仍然偏大，但已经迈出“从巨型入口文件拆开职责”的第一步。

## 5.5 测试补充与调整

新增：

- `test/core/parser/includeScanner.test.js`
- `test/core/parser/keywordScanner.test.js`

修改：

- `test/extension.test.js`

测试策略：

1. 先新增失败用例，再抽解析器模块
2. 再让 Provider 相关测试改为从新模块导入
3. 最后把入口接到新模块实现

这保证了每一步都是：

- 先红
- 再绿
- 再重构

---

## 6. 关键问题与现场修复

## 6.1 抽取 keywordScanner 后，协作式让步次数回退

### 现象

在把关键字扫描逻辑抽到 `keywordScanner.js` 后，全量测试出现失败：

- `LsdynaKeywordIndexProvider yields during large single-file keyword scans`

### 根因

原来的 `_buildRootsAsync()` 除了在循环内按阈值 `setImmediate()` 让步，还会在单文件扫描结束后再做一次让步。  
迁移到 `keywordScanner.js` 时，循环外的那次让步漏掉了。

### 修正

在 `collectKeywordsFromFile()` 返回前补回：

```js
await new Promise(r => setImmediate(r));
```

### 结果

原有的“长扫描期间主动让出事件循环”行为保持不变，回归测试恢复绿色。

## 6.2 Provider 模块化后的依赖边界

### 现象

Provider 拆出后，如果继续直接依赖入口文件内部函数，会造成新的隐式耦合。

### 处理

改为**构造注入**：

- IncludeTree Provider 注入 `searchFileFromPaths`
- KeywordIndex Provider 注入 `collectIncludeFiles` 与 `shouldSkipAutomaticDocumentScan`

### 结果

这一步虽然不是最终的 IOC 容器式设计，但足以为后续 Worker/LSP 迁移预留边界。

---

## 7. 本轮验证结果

最终执行：

```powershell
Set-Location 'D:\Project\vscode-lsdyna\.worktrees\large-file-phase0-1'
npm test
```

结果：

- **78 passing**
- **0 failing**

说明：

1. 新增的解析器测试已纳入总回归
2. 原有 Include Tree / Keyword Index / 大文件 guard 行为未被破坏
3. 基线失败已经消除

---

## 8. 当前成果对应到总体计划的映射

| 总体计划阶段 | 本轮进度 | 说明 |
| --- | --- | --- |
| Phase 0：拆分准备 | 已完成核心部分 | Provider 已拆出，入口开始瘦身 |
| Phase 1：抽取统一流式扫描内核 | 已完成第一批核心抽取 | include / keyword 扫描器已独立 |
| Phase 2：项目级索引与后台扫描 MVP | 未开始 | 下一轮重点 |
| Phase 3：缓存复用 | 未开始 | 下一轮之后推进 |
| Phase 4+：磁盘缓存 / LSP / 块级增量 | 未开始 | 仍按原计划后移 |

---

## 9. 下一轮建议执行项

建议下一批实现直接进入 **Phase 2：项目级索引与后台扫描 MVP**，重点做下面几件事：

1. 新建 `src/core/project/projectGraph.js`
2. 新建 `src/core/project/projectIndexer.js`
3. 把 `collectIncludeFiles()` 从入口文件迁出，交给项目级索引层
4. 让 Include Tree 与 Keyword Index 都消费同一个项目级扫描结果
5. 为 Worker 入口预留统一 `scan job` 输入输出模型

这样下一轮改造就能从“模块拆分”进入“真正的后台工程级扫描架构”。

---

## 10. 追溯要点总结

本轮最重要的三条经验：

1. **先把基线修绿，再谈架构演进**  
   否则无法判断新增问题是否由本轮改造引入。

2. **先抽扫描器，再拆 Provider，更稳**  
   在当前仓库结构下，这个顺序比直接搬类更可控。

3. **保留现有行为比追求一次性“大重写”更重要**  
   本轮所有改造都围绕“抽可复用核心 + 保留旧行为”展开，这正是企业级渐进式方案的核心。

**结论：首批落地已经成功完成，仓库结构已具备继续推进到项目级后台扫描与缓存层的基础。**
