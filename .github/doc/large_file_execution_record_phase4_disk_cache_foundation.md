# vscode-lsdyna 大文件方案执行记录（Phase 4：磁盘缓存基础设施 / Batch 1）

## 1. 当前进度定位

到本轮开始时，项目已经具备：

1. `projectIndexer` 工程级快照构建
2. `indexClient` L1 内存快照缓存
3. manifest / 自动校验 / LRU 逐出
4. watcher 失效 / batching / 后台重建
5. worker 线程执行边界

但还有一个明显空档：

> **扩展重启后，L1 内容全部丢失，缺少受控的 L2 磁盘缓存基础设施。**

因此本轮不直接把“磁盘读路径”一次性切进热路径，而是先完成更稳妥的第一批：

1. 抽取共享快照序列化模块
2. 建立轻量磁盘快照 store
3. 让 `indexClient` 在 fresh build 成功后执行 write-through 落盘
4. 让扩展入口按 `globalStorageUri` 安全接线

---

## 2. 本轮目标

本轮只做 **Phase 4 Batch 1**：

1. 新增 `snapshotSerializer`
2. 新增 `diskSnapshotStore`
3. 让 worker 与未来 L2 共用同一套 snapshot DTO
4. 让 `indexClient` 成功构建后 best-effort 写入磁盘缓存
5. 让 `activate()` 在有 `globalStorageUri` 时创建磁盘缓存实例

本轮**刻意不做**：

- L2 read-through 恢复
- 启动即热恢复
- SQLite
- 压缩
- 跨进程并发读写协调

---

## 3. 设计选择

## 3.1 先抽共享 serializer，避免 worker / disk cache 各写一套 DTO

在 worker 边界落地时，序列化逻辑实际上已经存在，只是分散在：

1. `src/worker/scanWorker.js`
2. `src/worker/workerPool.js`

如果 Phase 4 再复制一套 disk payload 序列化逻辑，后续极易出现：

- worker 能 hydrate
- disk cache 不能 hydrate
- 两边 payload shape 漂移

因此本轮先抽到：

- `src/core/cache/snapshotSerializer.js`

统一负责：

1. `ProjectGraph.toJSON()/fromJSON()`
2. `keywordMap` 的 `Map <-> entries[]`
3. `missingFiles/cycles` 与 graph 内部数组重新挂接

## 3.2 磁盘缓存先做“轻量 JSON payload + index”方案，不引入 SQLite

这一步主要是验证：

1. 持久化边界
2. 目录结构
3. 配额治理
4. 损坏隔离

因此本轮不引入 `better-sqlite3`，而是采用：

1. `index.json`
2. `payloads/*.json`

先把正确性、生命周期和恢复语义做稳。

## 3.3 index / payload 都必须原子写

磁盘缓存最危险的问题不是“读不到”，而是：

> **崩溃时写到一半，把整份缓存元数据写坏。**

因此本轮所有 index / payload 写入都采用：

1. 先写临时文件
2. 再 rename 覆盖目标文件

避免直接覆盖式写入带来的半写 JSON。

## 3.4 index 损坏时直接清空整个 L2 目录，不让主流程受影响

第一批实现里，为了保持简单和稳健，本轮明确采用：

- **index 损坏 = 清空磁盘缓存目录并回退为空 store**

而不是尝试做复杂的 payload 扫描重建。

这样虽然保守，但满足两个核心原则：

1. 主功能不能被磁盘缓存拖死
2. 损坏缓存必须可自愈

## 3.5 write-through 失败必须静默降级，不能反向拖垮 fresh build

磁盘缓存只是 L2 加速层，不是主数据源。

所以本轮在 `indexClient` 里明确采用：

- `persistentCache.persist(...)` **best-effort**

即：

1. fresh build 成功后尝试落盘
2. 落盘通过 fire-and-forget 方式异步执行，不阻塞主返回值
3. 落盘失败时吞掉异常
4. L1 和主返回值继续成功

这样磁盘权限、损坏或偶发 I/O 异常都不会破坏主索引能力。

## 3.6 生产接线必须默认带配额，不能把无限缓存只留在测试里

为了避免“测试里验证了 LRU，但真实扩展接线却默认无限容量”的落差，
本轮在扩展侧给 `createProjectSnapshotPersistentCache(...)` 明确配置了默认配额：

- **256 MB**

这样生产环境从第一天开始就具备基础空间治理，而不是把上限控制留到未来再补。

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先新增四组测试：

#### A. `test/core/cache/snapshotSerializer.test.js`

要求：

1. snapshot 序列化后还能正确 hydrate
2. `ProjectGraph` 行为不丢
3. `keywordMap` 重新变回 `Map`
4. `missingFiles/cycles` 继续与 graph 内部数组绑定

#### B. `test/core/cache/diskSnapshotStore.test.js`

要求：

1. persist / restore 正常 round-trip
2. tracked file signature 变化时返回 `null` 并移除 stale entry
3. 单个 payload 损坏时只影响该 entry，不影响其它 entry
4. `index.json` 损坏后可自动恢复为空 store，并允许后续再次 persist
5. 超过磁盘配额时按 LRU 逐出旧 entry

#### C. `test/client/services/indexClient.test.js`

要求：

1. fresh build 成功后会 write-through 到 `persistentCache`
2. 落盘失败不会影响主返回值，也不会破坏 L1 命中

#### D. `test/extension.test.js`

要求：

1. 没有 `globalStorageUri` 时不启用磁盘缓存
2. 有 `globalStorageUri` 时，缓存目录必须组装到：
   - `<globalStorageUri.fsPath>\project-snapshots`

先跑聚焦测试，确认红灯原因准确：

- `snapshotSerializer` 模块不存在
- `diskSnapshotStore` 模块不存在
- `indexClient` 尚未触发 write-through
- `createProjectSnapshotPersistentCache` 尚未存在

### 4.2 再写最小实现

本轮新增：

1. `src/core/cache/snapshotSerializer.js`
2. `src/core/cache/diskSnapshotStore.js`

并修改：

1. `src/worker/scanWorker.js`
2. `src/worker/workerPool.js`
3. `src/client/services/indexClient.js`
4. `src/extension.js`

### 4.3 过程中额外修正的一处边界

初版磁盘配额测试暴露了一个真实问题：

> 单条 payload 本身就可能大于拍脑袋预估的阈值。

因此本轮顺手补齐了更严格的配额语义：

1. 优先逐出旧 entry
2. 如果只剩“本次新写入的 protected entry”且仍然超额，则直接放弃保留它

从而保证：

- `totalBytes` 不会长期大于预算上限

---

## 5. 实际代码改动

## 5.1 `src/core/cache/snapshotSerializer.js`

本轮正式把 worker 与 L2 共用的 DTO 边界收口为：

1. `serializeProjectSnapshot(snapshot)`
2. `hydrateProjectSnapshot(snapshot)`

这样后续无论是：

- worker message
- disk payload
- 未来 server/client protocol

都可以复用同一套 shape。

## 5.2 `src/core/cache/diskSnapshotStore.js`

新增轻量 L2 store，支持：

1. `persist({ snapshot, trackedFiles })`
2. `restore(rootFile)`
3. `listEntries()`
4. `getStats()`

并具备以下特性：

1. 原子写 payload
2. 原子写 index
3. tracked file signature 校验
4. stale entry 自动移除
5. payload 损坏隔离
6. index 损坏自动清空恢复
7. 磁盘字节预算 + LRU 逐出

## 5.3 `src/client/services/indexClient.js`

新增可选依赖：

- `persistentCache`

当 fresh build 成功并拿到 tracked file signatures 后：

1. 先稳定写回 L1
2. 再 best-effort 调用 `persistentCache.persist(...)`

这样即使磁盘缓存失败，也不会影响主快照结果。

## 5.4 `src/extension.js`

新增：

- `createProjectSnapshotPersistentCache(...)`

作用：

1. 读取 `context.globalStorageUri`
2. 组装 `<storage>\project-snapshots`
3. 以默认 256 MB 配额创建 disk snapshot store
4. 若初始化失败，打印 warning 并回退到无 L2 模式

---

## 6. 真实样本验证

本轮继续使用用户提供的真实工程：

- 根文件：`D:\temp\LSDYNA\2020-nissan-rogue-v3\combine.key`

验证方式：

1. 使用真实工程构建 snapshot
2. 持久化到临时磁盘缓存目录
3. 再通过 `restore(rootFile)` 恢复
4. 核对文件数、关键字组数与 include tree 根子节点数

这一轮验证的重点不再是冷/热速度，而是：

- **真实工程在 L2 payload 里是否能完整 round-trip**

实测得到：

```json
{
  "fileCount": 4,
  "keywordGroupCount": 88,
  "rootChildren": 3,
  "diskEntryCount": 1,
  "diskTotalBytes": 2170481
}
```

说明当前轻量 JSON L2 payload 已经可以承载这套真实工程的完整项目快照。

---

## 7. 验证结果

执行：

```powershell
npx mocha test\core\cache\snapshotSerializer.test.js test\core\cache\diskSnapshotStore.test.js test\client\services\indexClient.test.js test\extension.test.js --grep "snapshotSerializer|createDiskSnapshotStore|persists successful fresh snapshots|ignores disk cache persistence failures|createProjectSnapshotPersistentCache"
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

---

## 8. 这一步的意义

做到这里之后，项目第一次具备了真正的 L2 磁盘缓存基础设施：

1. 快照有稳定的跨进程 / 跨介质 DTO
2. 扩展已经能把 fresh snapshot 持久化到 `globalStorageUri`
3. 配额、损坏、自愈、原子写这些“企业级稳健性”问题已经先被收口

而下一轮就可以在这个基础上继续推进：

1. `indexClient` 的 read-through 磁盘恢复
2. L1 miss 直接走 L2 restore
3. 扩展重启后的工程热恢复

---

## 9. 一句话结论

**本轮完成了 Phase 4 的第一批基础设施：共享 snapshot serializer、受控的 L2 磁盘快照 store、`indexClient` write-through 落盘，以及基于 `globalStorageUri` 的安全接线，为下一轮 read-through 热恢复打下了稳定边界。**
