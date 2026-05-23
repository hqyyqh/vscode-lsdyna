# vscode-lsdyna 大文件方案执行记录（Phase 6：worker_threads 执行边界）

## 1. 当前进度定位

到本轮开始时，扩展已经完成：

1. 项目快照缓存
2. manifest
3. watcher 失效
4. watcher batching
5. 后台自动重建队列

但有一个核心问题仍然存在：

> **`buildProjectIndex(rootFile)` 依然在 Extension Host 进程里执行。**

即使现在已经有缓存和后台队列，真正重的工程级扫描一旦发生，依然会占用扩展宿主线程。

因此本轮的目标非常明确：

**把项目快照构建正式切到 `worker_threads` 执行边界。**

---

## 2. 本轮目标

本轮一次性完成四件事：

1. 让 `ProjectGraph` 可序列化 / 反序列化
2. 新增 worker 入口 `src/worker/scanWorker.js`
3. 新增主线程客户端 `src/worker/workerPool.js`
4. 在 `src/extension.js` 里引入 lazy `createProjectIndexLoader(...)`，让激活时不立刻起 worker，而是在第一次真正需要项目快照时才创建 worker pool

本轮**不做**：

- 多 worker 并行池
- worker 优先级调度
- worker 共享缓存
- worker telemetry

---

## 3. 设计选择

## 3.1 先做单 worker 边界，不做并行 worker pool

本轮没有急着上多 worker 并发，而是只做一个 worker 边界。

原因很直接：

1. 当前最重要的是把**重构建从 Extension Host 拿出去**
2. 单 worker 已经能验证：
   - 协议形状
   - 生命周期
   - 错误传播
   - snapshot 序列化/反序列化
3. 多 worker 调度可以在这个边界稳定后再演进

## 3.2 不直接跨线程传 `ProjectGraph` 实例，而是显式序列化

`ProjectGraph` 原本是带方法的类实例，`keywordMap` 也是 `Map`。如果不做显式 DTO 处理，worker round-trip 后会丢失：

- `graph.toTree()`
- `keywordMap.entries()`

因此本轮明确做了：

1. `ProjectGraph.toJSON()`
2. `ProjectGraph.fromJSON()`
3. worker 侧把 `keywordMap` 显式转成数组对
4. 主线程侧把 `keywordMap` 再 hydrate 成 `Map`

并在主线程重建后重新绑定：

- `snapshot.missingFiles = snapshot.graph.missingFiles`
- `snapshot.cycles = snapshot.graph.cycles`

保持和原主线程版本一致的 snapshot 形状。

## 3.3 worker pool 必须 reject pending，而不是让请求悬挂

本轮特别注意了 worker 生命周期的企业级稳健性：

1. `worker.on('error')` 时 reject 所有 pending request
2. `worker.on('exit')` 时 reject 所有 pending request
3. `dispose()` 时先 reject pending，再 terminate worker

这样不会出现“worker 已死，但调用方 promise 永远悬挂”的隐患。

## 3.4 lazy loader 必须在 worker 崩溃后自恢复

在实现完第一版后，review 又补抓到一个真实边界：

1. `createProjectIndexLoader()` 会缓存 `workerPool`
2. 如果底层 worker 已经 crash / exit，对应 pool 会进入 disposed 状态
3. 如果 loader 不识别这一状态，后续请求会一直命中一个已经失效的 pool

因此本轮又补了一层恢复逻辑：

1. `workerPool.isDisposed()` 对外暴露生命周期状态
2. `createProjectIndexLoader()` 在取池时会先检查 disposed 状态
3. 如果一次构建请求因 fatal worker failure 失败，loader 会清空失效 pool，后续请求自动重建新 pool

这样就避免了“worker 只要死一次，整个会话后续索引都永久损坏”的问题。

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先新增三类测试：

#### A. `test/worker/workerPool.test.js`

1. **真实 worker round-trip**
   - 临时工程文件
   - worker 返回 snapshot
   - 主线程侧要求：
     - `snapshot.keywordMap instanceof Map`
     - `snapshot.graph.toTree()` 仍可用
     - `snapshot.missingFiles` / `snapshot.cycles` 继续和 `graph` 内部数组同引用

2. **worker error 必须 reject pending**
   - 用 fake worker 注入
   - 挂起一个请求
   - 主动触发 `error`
   - 断言 promise 必须 reject，而不是悬挂

#### B. `test/extension.test.js`

1. `createProjectIndexLoader(...)` 必须：
   - 首次调用前不创建 worker pool
   - 第一次真正 `buildProjectIndex()` 时才创建
   - `dispose()` 能把 worker pool 收掉
2. `createProjectIndexLoader(...)` 还必须：
   - 在 fatal worker failure 后识别已失效 pool
   - 后续请求自动重建 pool，而不是把整个会话打坏

先执行聚焦测试：

```powershell
npx mocha test\worker\workerPool.test.js test\extension.test.js --grep "createWorkerPool|createProjectIndexLoader"
```

结果先红，失败原因符合预期：

- `workerPool` 模块不存在
- `createProjectIndexLoader` 不存在

### 4.2 再写最小实现

本轮依次补上：

1. `ProjectGraph.toJSON()/fromJSON()`
2. `scanWorker.js`
3. `workerPool.js`
4. `createProjectIndexLoader(...)`
5. `activate()` 中改为通过 lazy loader 把项目快照请求路由给 worker pool

### 4.3 验证转绿

聚焦测试转绿后，再跑全量测试，确保：

1. 扩展激活路径未退化
2. worker 边界未破坏现有 Include Tree / Keyword Index / 缓存链路

---

## 5. 实际代码改动

## 5.1 `src/core/project/projectGraph.js`

新增：

- `toJSON()`
- `fromJSON()`

用于跨 worker 传输图状态，同时保留类行为。

## 5.2 `src/worker/scanWorker.js`

新增 worker 入口，负责：

1. 接收 `buildProjectIndex(rootFile)` 请求
2. 执行项目快照构建
3. 返回序列化后的 snapshot
4. 返回序列化错误

## 5.3 `src/worker/workerPool.js`

新增主线程 worker 客户端，负责：

1. 创建 worker
2. requestId 协议
3. main-thread hydration
4. error / exit / dispose 时 reject pending

## 5.4 `src/extension.js`

新增：

- `createProjectIndexLoader(...)`

并让 `indexClient` 改为依赖：

- `projectIndexLoader.buildProjectIndex`

同时把 loader 本身放进 `context.subscriptions`，保证扩展释放时 worker 能一起回收。

另外，loader 现在还负责：

1. 识别已 disposed 的 worker pool
2. 在 fatal worker failure 后清空失效缓存
3. 让后续请求可以自动拉起新 pool

---

## 6. 真实工程样本验证

本轮继续使用用户提供的真实工程：

- 根文件：`D:\temp\LSDYNA\2020-nissan-rogue-v3\combine.key`

通过 `workerPool.buildProjectIndex(rootFile)` 实测得到：

```json
{
  "fileCount": 4,
  "keywordGroupCount": 88,
  "rootChildren": 3,
  "reusedFileCount": 0
}
```

说明 worker 边界下：

1. snapshot 能正常返回
2. `keywordMap` hydration 正常
3. `graph.toTree()` 可正常工作
4. 当前真实工程结构能被完整 round-trip

---

## 7. 验证结果

执行：

```powershell
npx mocha test\worker\workerPool.test.js test\extension.test.js --grep "createWorkerPool|createProjectIndexLoader"
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

---

## 8. 对总体计划的推进意义

做到这一步之后，整体架构终于从：

- “主线程里做重工程扫描”

推进到了：

- “Extension Host 发起请求”
- “worker 线程执行项目快照构建”
- “主线程 hydration 并继续走现有 cache/provider 链路”

这意味着剩下的主要工作已经进一步收敛为：

1. worker 调度增强（如果需要）
2. Phase 4 磁盘缓存 / L2 治理

---

## 9. 一句话结论

**本轮正式把项目快照构建切到了 `worker_threads` 执行边界，并通过显式 snapshot hydration 保持了 `ProjectGraph` / `keywordMap` / provider 行为兼容，完成了“重扫描脱离 Extension Host 主线程”的关键一步。**
