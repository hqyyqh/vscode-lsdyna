# vscode-lsdyna 大文件解析改造可行性评估与落地计划

> **结论先行：** 方案在本项目中**可行**，但不适合一次性把 `large_file_plan.md` 中的全部能力直接落进当前代码。更稳妥的方式是：**先模块化现有扫描逻辑，再引入后台扫描与缓存，最后按性能数据决定是否全面切到 LSP 架构。**

## 1. 可行性结论

### 1.1 为什么说“可行”

当前项目已经具备继续演进到大文件架构的几个关键前提：

1. **已有流式扫描基础**  
   `src/extension.js` 中的 `collectIncludeDirectivesFromFile()` 和 `LsdynaKeywordIndexProvider._buildRootsAsync()` 已经在使用 `fs.createReadStream` + `readline` 做流式扫描，而不是一次性把整个文件读进一个巨型字符串。

2. **已有大文件保护机制**  
   `LARGE_DOCUMENT_LINE_THRESHOLD` 已经让自动诊断、自动装饰、自动符号、自动 hover 等能力在超大文档上主动降级，说明当前项目已经接受“超大文件需要特化路径”的设计方向。

3. **已有异步让步（yield）意识**  
   `STREAM_SCAN_YIELD_INTERVAL` 与 `setImmediate()` 已经体现出“长扫描过程中主动让出事件循环”的思路，这对后续迁移到 Worker / Server 侧是很好的过渡基础。

4. **已有 Include Tree / Keyword Index 的业务闭环**  
   当前插件已经能生成 Include Tree、递归收集关键字，并有一套单测覆盖。这意味着后续改造重点是**性能与架构升级**，不是从零定义业务行为。

### 1.2 为什么不能直接照搬原方案

`large_file_plan.md` 里的目标架构非常强，但当前项目与该架构之间还有明显落差：

1. **当前实现高度集中在一个文件**  
   `src/extension.js` 约 1300 行，UI 注册、扫描逻辑、缓存、解析辅助函数、TreeView Provider 全都在一起。  
   这会让“一步切 LSP + Worker + 增量 AST + 磁盘缓存”的改造风险过高。

2. **当前项目是纯 JS 扩展，工程体系偏轻量**  
   `package.json` 目前没有构建流程，也没有 LSP、缓存数据库、worker 封装等依赖。  
   如果直接引入完整架构，会同时叠加目录重构、依赖升级、运行模型变化三种风险。

3. **现阶段业务目标仍聚焦两件事**  
   当前插件的大文件核心诉求，本质上还是：
   - 高性能生成 Include Tree
   - 高性能生成 Keyword Index  
   因此第一阶段应优先围绕这两项能力建立稳定架构，而不是一开始就做完整语义服务器。

### 1.3 推荐判断

| 能力项 | 可行性 | 建议 |
| --- | --- | --- |
| 流式扫描继续深化 | 高 | 立即落地 |
| 将重扫描迁移到后台 Worker | 高 | 第一阶段落地 |
| 建立项目级索引与文件摘要缓存 | 高 | 第一阶段落地 |
| 文件级增量更新 | 中高 | 第二阶段落地 |
| LSP 进程隔离 | 中高 | 在模块拆分稳定后落地 |
| SharedArrayBuffer 零拷贝 | 中 | 先不做，留作性能兜底 |
| SQLite 持久缓存 | 中 | 建议第二阶段再引入 |
| FlatBuffers / 二进制序列化 | 中低 | 不是 MVP 必需项 |
| AST + Interval Tree 精细补丁 | 中 | 先做块级/文件级增量，再逐步细化 |

**最终建议：采用“分阶段落地、每阶段可独立上线”的路线。**

---

## 2. 落地边界与目标

## 2.1 本轮改造的目标

1. 超大 `.k/.key` 文件和包含大量子文件的工程，能够在**不阻塞 UI** 的前提下生成 Include Tree 与 Keyword Index。
2. 扫描结果可以复用，避免对未变更文件重复解析。
3. 对于激活文档与工程文件变更，支持至少**文件级**增量更新。
4. 保留现有中小文件体验，不因大文件改造破坏已有功能。
5. 为后续 LSP 化保留清晰边界，而不是把复杂度继续堆进 `src/extension.js`。

## 2.2 本轮改造不做的事

1. 不在第一阶段实现完整的 LS-DYNA 语义分析器。
2. 不在第一阶段实现 `*INCLUDE_TRANSFORM` 的 ID 映射语义索引。
3. 不在第一阶段实现 SharedArrayBuffer / Atomics 级别的极限优化。
4. 不在第一阶段把所有现有编辑器能力都迁移到后台服务；优先迁移**重扫描能力**。

## 2.3 验收指标

建议把以下指标写入后续开发验收：

1. 打开超大工程后，手动触发 Include Tree / Keyword Index 扫描时，VS Code 不出现明显卡顿。
2. 冷启动首次扫描可完成，热启动命中缓存后明显快于冷启动。
3. 单个 include 文件变更后，仅重建受影响的文件索引与工程聚合结果。
4. 缓存有明确大小上限、失效规则和清理策略。
5. 现有测试不退化，并补齐大文件 / 多文件工程 / 缓存 / 增量更新覆盖。

---

## 3. 目标架构（适配本项目后的版本）

### 3.1 架构原则

1. **Extension Host 只保留轻逻辑**：命令注册、TreeView 更新、用户提示、配置读取。
2. **重扫描逻辑独立成核心模块**：可先由 Worker 承载，后续平滑迁移到 LSP Server。
3. **先做文件级索引，再做块级增量**：不要一开始就引入过于复杂的 AST 修补。
4. **缓存先解决“复用”，再解决“极致压缩”**：先有稳定命中与失效，再谈 SQLite / FlatBuffers。

### 3.2 推荐架构分层

```text
VS Code Extension Host
  ├─ src/extension.js                  # 激活入口，逐步瘦身
  ├─ src/client/commands/*             # 命令注册
  ├─ src/client/providers/*            # TreeView / UI Provider
  └─ src/client/services/indexClient.js

Shared Core
  ├─ src/core/parser/*                 # 流式扫描器
  ├─ src/core/project/*                # 项目图、聚合索引
  ├─ src/core/cache/*                  # L1 / L2 缓存
  ├─ src/core/incremental/*            # 文件级/块级增量
  └─ src/core/model/*                  # DTO / 索引结构

Background Engine
  ├─ src/worker/scanWorker.js          # 第一阶段
  ├─ src/worker/workerPool.js
  └─ src/server/*                      # 第二阶段：LSP 化
```

### 3.3 数据模型建议

后续不要直接在 UI Provider 中拼装原始扫描结果，统一引入以下几个中间模型：

1. **FileScanResult**  
   单文件扫描结果，只存：
   - `filePath`
   - `mtimeMs`
   - `size`
   - `hash`（可后补）
   - `includes[]`
   - `keywords[]`
   - `stats`

2. **ProjectGraph**  
   负责表示文件之间的 include 关系、缺失引用、循环引用、反向依赖。

3. **ProjectIndexSnapshot**  
   负责表示整个工程当前可直接渲染到 UI 的聚合结果：
   - Include Tree 根节点
   - Keyword Index 聚合表
   - 缺失文件列表
   - 循环引用列表

4. **CacheRecord**  
   用于缓存层统一管理：
   - key
   - version
   - lastAccess
   - byteSize
   - payloadPath / payload

---

## 4. 建议修改的目录与文件

以下路径是结合当前项目结构后，推荐新增或改造的文件布局。

### 4.1 必改文件

- Modify: `package.json`
- Modify: `src/extension.js`
- Modify: `README.md`
- Modify: `test/extension.test.js`

### 4.2 第一阶段新增文件

- Create: `src/client/providers/includeTreeProvider.js`
- Create: `src/client/providers/keywordIndexProvider.js`
- Create: `src/client/services/indexClient.js`
- Create: `src/core/model/fileScanResult.js`
- Create: `src/core/model/projectIndexSnapshot.js`
- Create: `src/core/parser/includeScanner.js`
- Create: `src/core/parser/keywordScanner.js`
- Create: `src/core/parser/blockScanner.js`
- Create: `src/core/project/projectGraph.js`
- Create: `src/core/project/projectIndexer.js`
- Create: `src/core/cache/memoryCache.js`
- Create: `src/core/cache/cacheKeys.js`
- Create: `src/core/cache/cacheManifestStore.js`
- Create: `src/core/incremental/fileInvalidation.js`
- Create: `src/worker/scanWorker.js`
- Create: `src/worker/workerPool.js`

### 4.3 第二阶段新增文件

- Create: `src/server/server.js`
- Create: `src/server/sessionManager.js`
- Create: `src/server/fileWatcher.js`
- Create: `src/server/requestRouter.js`
- Create: `src/shared/protocol.js`
- Create: `src/core/cache/sqliteCacheStore.js`
- Create: `src/core/incremental/blockIndex.js`

### 4.4 测试目录建议

- Create: `test/core/parser/includeScanner.test.js`
- Create: `test/core/parser/keywordScanner.test.js`
- Create: `test/core/project/projectIndexer.test.js`
- Create: `test/core/cache/cacheManifestStore.test.js`
- Create: `test/core/incremental/fileInvalidation.test.js`
- Create: `test/worker/workerPool.test.js`
- Create: `test/fixtures/large-project/`

---

## 5. 分阶段详细落地计划

## Phase 0：基线冻结与拆分准备

**目标：** 在不改变行为的前提下，把现有单文件实现拆出边界，为后续性能改造降风险。

**涉及文件：**
- Modify: `src/extension.js`
- Modify: `test/extension.test.js`
- Create: `src/client/providers/includeTreeProvider.js`
- Create: `src/client/providers/keywordIndexProvider.js`

- [ ] 将 `LsdynaIncludeTreeProvider` 从 `src/extension.js` 抽出到 `src/client/providers/includeTreeProvider.js`
- [ ] 将 `LsdynaKeywordIndexProvider` 从 `src/extension.js` 抽出到 `src/client/providers/keywordIndexProvider.js`
- [ ] 让 `src/extension.js` 只保留激活入口、命令注册、Provider 装配
- [ ] 保持 CommonJS 风格，不在此阶段引入 TypeScript，避免同时叠加语言迁移风险
- [ ] 先不改动现有用户可见行为，确保本阶段是“纯重构”

**阶段产物：**
- Extension 入口瘦身
- Provider 与扫描逻辑边界初步分离
- 后续 Worker / LSP 能接入统一 client 层

**阶段验收：**
- 现有 Include Tree / Keyword Index 功能行为不变
- 现有大文件 guard 逻辑不变
- 现有测试通过范围不缩小

## Phase 1：抽取统一流式扫描内核

**目标：** 把 Include / Keyword 的扫描统一沉淀到 `src/core/parser`，让“从文件扫描出结构摘要”成为可复用能力。

**涉及文件：**
- Create: `src/core/parser/includeScanner.js`
- Create: `src/core/parser/keywordScanner.js`
- Create: `src/core/parser/blockScanner.js`
- Create: `src/core/model/fileScanResult.js`
- Modify: `src/client/providers/includeTreeProvider.js`
- Modify: `src/client/providers/keywordIndexProvider.js`
- Create: `test/core/parser/includeScanner.test.js`
- Create: `test/core/parser/keywordScanner.test.js`

- [ ] 将当前 `collectIncludeDirectivesFromFile()` 的逻辑迁移为独立的 `includeScanner`
- [ ] 将当前 `_buildRootsAsync()` 中的关键字扫描迁移为独立的 `keywordScanner`
- [ ] 提供统一的 `scanFile(filePath, options)` 接口，返回 `FileScanResult`
- [ ] `FileScanResult` 至少包含：includes、keywords、lineStats、warnings
- [ ] 保留当前的 `fs.createReadStream` 流式路径，不退回全量字符串解析
- [ ] 在扫描器中加入“只提取结构摘要，不保留无关数据行”的约束，控制内存

**阶段产物：**
- 单文件扫描结果结构化
- Include 与 Keyword 两类逻辑不再散落在 UI Provider 内
- 为缓存、增量更新、后台并行打下统一输入输出格式

**阶段验收：**
- 同一文件同时可产出 include 信息与 keyword 摘要
- 流式扫描路径仍能处理大文件
- 核心扫描逻辑有独立单测

## Phase 2：建立项目级索引与后台扫描 MVP

**目标：** 让工程级扫描不再由 UI Provider 直接递归驱动，而由统一的后台执行器负责。

**涉及文件：**
- Create: `src/core/project/projectGraph.js`
- Create: `src/core/project/projectIndexer.js`
- Create: `src/worker/scanWorker.js`
- Create: `src/worker/workerPool.js`
- Create: `src/client/services/indexClient.js`
- Modify: `src/client/providers/includeTreeProvider.js`
- Modify: `src/client/providers/keywordIndexProvider.js`
- Create: `test/core/project/projectIndexer.test.js`
- Create: `test/worker/workerPool.test.js`

- [ ] 引入 `ProjectGraph`，统一维护：
  - include 边
  - 缺失文件
  - 循环依赖
  - 反向依赖
- [ ] 引入 `projectIndexer`，负责将多个 `FileScanResult` 聚合为 `ProjectIndexSnapshot`
- [ ] 用 `worker_threads` 建立最小可用 `workerPool`
- [ ] Worker 只负责扫描文件并返回 `FileScanResult`，聚合逻辑仍在主线程
- [ ] 将当前 `collectIncludeFiles()` 的职责迁移到 `projectIndexer`
- [ ] 把 Include Tree 与 Keyword Index 的“扫描触发”改为调用 `indexClient`

**阶段产物：**
- 工程级扫描与 UI 解耦
- 可并行扫描多个 include 文件
- 缺失文件与循环引用有统一建模

**阶段验收：**
- 手动扫描 Include Tree / Keyword Index 时，UI 线程不承担递归全扫描
- 多文件工程能输出单一 `ProjectIndexSnapshot`
- 循环 include 不会导致无限递归

## Phase 3：引入 L1 缓存与工程快照复用

**目标：** 避免对未变化文件重复解析，先解决“复用”，再追求“极致持久化”。

**涉及文件：**
- Create: `src/core/cache/memoryCache.js`
- Create: `src/core/cache/cacheKeys.js`
- Create: `src/core/cache/cacheManifestStore.js`
- Create: `src/core/incremental/fileInvalidation.js`
- Modify: `src/core/project/projectIndexer.js`
- Modify: `src/client/services/indexClient.js`
- Create: `test/core/cache/cacheManifestStore.test.js`
- Create: `test/core/incremental/fileInvalidation.test.js`

- [ ] 内存层缓存 `FileScanResult` 与 `ProjectIndexSnapshot`
- [ ] 以 `filePath + mtimeMs + size` 作为第一版失效键
- [ ] 建立工程清单（manifest），记录每个工程包含哪些文件、最后访问时间、摘要大小
- [ ] 允许项目级扫描时只重扫变更文件，复用未变更文件结果
- [ ] 为缓存增加大小统计与逐出逻辑
- [ ] 在配置中预留缓存上限设置项，但第一版可以先用固定默认值

**阶段产物：**
- 冷启动和热启动路径分离
- 文件级缓存命中
- 工程级索引具备复用能力

**阶段验收：**
- 同一工程重复扫描时明显少于首次扫描的文件数
- 修改一个 include 文件后，不会触发全工程所有文件重扫
- 缓存淘汰后系统仍可自动回退到完整扫描

## Phase 4：磁盘缓存与空间治理

**目标：** 在 `globalStorageUri` 下建立受控的 L2 缓存，同时解决磁盘膨胀问题。

**涉及文件：**
- Create: `src/core/cache/sqliteCacheStore.js`
- Modify: `src/core/cache/cacheManifestStore.js`
- Modify: `package.json`
- Modify: `README.md`

- [ ] 第一优先级是定义缓存目录结构、配额、清理机制
- [ ] 若保持轻量，可先使用“manifest + 二进制/JSON 快照文件”方案
- [ ] 若热启动性能和检索能力不足，再接入 `better-sqlite3`
- [ ] 无论是否使用 SQLite，都必须具备：
  - 最大缓存空间上限
  - 最近最少使用（LRU）逐出
  - TTL 清理
  - 崩溃后可恢复的清单文件
- [ ] 若引入 SQLite，再补齐：
  - schema version
  - `auto_vacuum`
  - vacuum 触发策略
  - 损坏数据库回退机制

**阶段产物：**
- 工程关闭再打开时可热启动
- 缓存空间可控
- 缓存损坏不影响主功能

**阶段验收：**
- 在缓存命中情况下，可直接恢复工程级索引
- 缓存超过阈值时，会自动逐出旧工程数据
- 删除缓存后系统仍可正常重建

## Phase 5：文件级增量更新与 Watcher 驱动刷新

**目标：** 将“只重扫变化文件”从手动触发扩展到工作区文件变更与激活文档编辑。

**涉及文件：**
- Create: `src/server/fileWatcher.js`（若此阶段尚未上 LSP，可先放 `src/core/incremental`）
- Create: `src/core/incremental/blockIndex.js`
- Modify: `src/core/project/projectIndexer.js`
- Modify: `src/client/services/indexClient.js`
- Modify: `src/extension.js`

- [ ] 接入 `workspace.createFileSystemWatcher` 监听 `.k/.key/.dyna`
- [ ] 为每个文件记录反向依赖，文件变化时只刷新受影响分支
- [ ] 激活文档变更时，先做 debounce，再决定是否触发局部重扫
- [ ] 第一版增量更新做到“文件级”即可
- [ ] 对于超大已打开文档，优先保证“后台重建索引”，不要在主线程做复杂实时语义
- [ ] `blockIndex` 作为下一步块级增量的预埋结构，先记录关键字块的行区间

**阶段产物：**
- 文件系统变更可自动使缓存失效
- 项目索引具备反向依赖驱动刷新
- 为后续 Interval Tree / 块级补丁保留数据入口

**阶段验收：**
- 被 include 的子文件变化后，上层工程索引会自动刷新
- 未受影响的文件结果继续复用
- 高频保存不会导致重复排队扫描失控

## Phase 6：LSP 化迁移（重扫描与索引服务下沉）

**目标：** 当 Worker MVP 稳定后，将重能力迁移到独立 Server 进程，彻底隔离 Extension Host。

**涉及文件：**
- Create: `src/server/server.js`
- Create: `src/server/sessionManager.js`
- Create: `src/server/requestRouter.js`
- Create: `src/shared/protocol.js`
- Modify: `package.json`
- Modify: `src/client/services/indexClient.js`
- Modify: `src/extension.js`

- [ ] 引入 `vscode-languageclient` 与 `vscode-languageserver`
- [ ] 将扫描请求、缓存请求、索引请求定义为明确协议
- [ ] 客户端只保留命令/UI/状态同步
- [ ] 服务端承载：
  - 工程级索引状态
  - Worker 调度
  - 磁盘缓存访问
  - 文件变更响应
- [ ] 先迁移 Include Tree / Keyword Index
- [ ] hover、diagnostics、rename 等当前轻能力可暂时留在 Extension Host，避免迁移面过大

**阶段产物：**
- Extension Host 基本不做重扫描
- 后台服务可独立维护工程索引生命周期
- 后续继续迁移语义能力时边界清晰

**阶段验收：**
- 大工程扫描时，Extension Host 不再承担 CPU 密集型递归逻辑
- 重启扩展或重新打开工作区时，服务端能恢复缓存状态
- 客户端与服务端协议版本不一致时有明确失败提示

## Phase 7：块级增量、聚合渲染与最终收口

**目标：** 在前述架构稳定后，补齐 `large_file_plan.md` 中真正有价值、且已被数据证明值得实现的高级能力。

**涉及文件：**
- Modify: `src/core/incremental/blockIndex.js`
- Modify: `src/core/parser/blockScanner.js`
- Modify: `src/core/project/projectIndexer.js`
- Modify: `src/client/providers/keywordIndexProvider.js`
- Modify: `README.md`

- [ ] 把关键字块区间正式建模，支持局部块失效
- [ ] 针对大规模 `*NODE` / `*ELEMENT` 类块增加聚合展示
- [ ] 对极端大结果集的 Keyword Index 做阈值折叠
- [ ] 为循环引用、缺失引用输出更明确的 UI 状态与诊断
- [ ] 仅在性能瓶颈真实存在时，再评估 SharedArrayBuffer 或更激进的二进制序列化

**阶段产物：**
- 真正意义上的块级增量雏形
- 大规模索引结果不再把侧边栏“撑爆”
- 架构性能优化进入按数据精修阶段

**阶段验收：**
- 修改局部关键字块时，不需要重建整个文件摘要
- 超大索引结果在 UI 中仍可操作
- 性能优化建立在 profiling 数据上，而非纯猜测

---

## 6. 测试与验证计划

## 6.1 单元测试

优先给以下模块补充独立单测：

1. `includeScanner`
2. `keywordScanner`
3. `projectIndexer`
4. `memoryCache`
5. `cacheManifestStore`
6. `fileInvalidation`
7. `workerPool`

## 6.2 集成测试

需要准备一套专用夹具工程：

- `test/fixtures/large-project/root.key`
- 多层 include
- 缺失文件
- 循环引用
- 大量重复关键字
- 超大数值块占位样本

重点验证：

1. 工程级扫描结果是否正确
2. 修改一个子文件后是否只刷新必要节点
3. 缓存命中/失效是否正确
4. Worker 异常退出后是否能恢复

## 6.3 性能回归

建议加一个轻量性能基准脚本，不要求进入正式 CI，但至少要能本地复跑：

1. 冷启动扫描耗时
2. 热启动扫描耗时
3. 单文件变更后增量刷新耗时
4. 关键词数量极大时的聚合耗时

## 6.4 手工验证

至少验证以下真实使用路径：

1. 打开超大主文件，手动扫描 Include Tree
2. 扫描完成后切换编辑、滚动、搜索，确认无明显卡顿
3. 修改某个 include 子文件并保存，确认树和索引更新
4. 重启 VS Code 后重新打开同工程，确认缓存命中

---

## 7. 主要风险与应对

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 单文件重构过大 | `src/extension.js` 当前职责过多 | 先做 Phase 0，禁止一步到位重写 |
| native 依赖打包复杂 | `better-sqlite3` 会增加发布复杂度 | 磁盘缓存先做轻量版本，再决定是否上 SQLite |
| Worker 数量失控 | 大工程可能触发过多并发文件扫描 | 线程池固定上限，队列化调度 |
| 缓存失效错误 | 旧结果污染新索引 | 第一版采用保守失效策略，宁可多扫、不要错扫 |
| UI 结果过大 | Keyword Index 可能返回海量节点 | 加聚合阈值与懒加载 |
| LSP 迁移范围过大 | 一次迁移所有语言特性风险高 | 先迁移重扫描能力，轻能力延后 |

---

## 8. 推荐实施顺序

如果资源有限，建议严格按下面顺序推进：

1. **必做：Phase 0 + Phase 1 + Phase 2**  
   先把扫描内核抽出来，并让工程级扫描进入后台执行。

2. **高优先级：Phase 3 + Phase 5**  
   先拿到“缓存复用 + 文件级增量刷新”两项核心收益。

3. **按收益决定：Phase 4 或 Phase 6**  
   - 如果痛点主要是重复扫描慢，优先做磁盘缓存。  
   - 如果痛点主要是扩展宿主压力大，优先做 LSP 化。

4. **最后精修：Phase 7**  
   在真实 profiling 数据证明有必要后，再投入更细粒度的块级增量和极限优化。

---

## 9. 最终建议

对本项目而言，`large_file_plan.md` 的方向是正确的，但**必须做工程化裁剪**：

1. **保留的核心思想**
   - 流式扫描
   - 后台执行
   - 增量更新
   - 多级缓存
   - 大结果集聚合显示

2. **需要延后落地的部分**
   - SharedArrayBuffer
   - 完整 LSP 语义迁移
   - SQLite + 二进制序列化的极限版本
   - 真正细粒度的 AST/Interval Tree 修补

3. **最适合本仓库的落地策略**
   - 先拆模块
   - 再做 Worker 扫描 MVP
   - 再做缓存与增量
   - 最后按指标升级到 LSP

**一句话总结：这个方案能做，而且值得做；但最优落地方式不是“一次性大重写”，而是“围绕当前 Include Tree / Keyword Index 能力做渐进式架构升级”。**
