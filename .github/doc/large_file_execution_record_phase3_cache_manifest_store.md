# vscode-lsdyna 大文件方案执行记录（Phase 3：cache manifest store）

## 1. 当前进度定位

到本轮开始时，Phase 3 已经完成：

1. `indexClient` L1 项目快照缓存
2. 显式失效与 stale in-flight 防污染
3. 自动过期校验
4. `projectIndexer` 单文件扫描复用
5. 缓存大小统计与 LRU 逐出

但总体计划里还有一项尚未显式收口：

> **建立工程清单（manifest），记录每个工程包含哪些文件、最后访问时间、摘要大小。**

此前这些信息虽然已经散落在 `indexClient` 的缓存条目里，但还没有形成一个清晰、稳定、可复用的模块边界。

因此本轮聚焦：

**引入 `cacheManifestStore`，把项目快照缓存的工程级元数据正式建模并接入 `indexClient`。**

---

## 2. 本轮目标

本轮只做 manifest 的最小可用版：

1. 新增 `src/core/cache/cacheManifestStore.js`
2. 让 manifest 记录：
   - `rootFile`
   - `trackedFiles`
   - `trackedFileCount`
   - `byteSize`
   - `lastAccessedAt`
3. 让 `indexClient` 在以下时机维护 manifest：
   - 快照写入
   - 快照命中（更新时间戳）
   - 手动失效
   - LRU 逐出
4. 增加独立单测和联动测试

本轮**不做**：

- 磁盘持久化
- JSON/二进制序列化文件
- manifest 崩溃恢复
- watcher 自动消费 manifest

---

## 3. 设计选择

## 3.1 先做“内存 manifest store”，不提前碰磁盘

总体计划里 manifest 最终会服务于更远一点的目标：

1. L2 磁盘缓存
2. watcher 驱动失效
3. 后台服务恢复

但本轮没有直接跳到磁盘持久化，而是先建立一个**内存态、接口稳定的 manifest store**。

这样做的好处是：

1. 先把数据模型和调用边界做稳
2. 后续要不要落盘，只需要替换 store 背后的存储方式
3. 当前风险更低，不会把 Phase 3 和 Phase 4 混在一起

## 3.2 manifest 只存“工程级元数据”，不直接存快照 payload

manifest store 当前只负责记录：

- 这个工程是谁
- 它跟踪了哪些文件
- 最后访问时间是多少
- 估算大小是多少

而不负责存：

- `ProjectGraph`
- `keywordMap`
- `missingFiles`

这让 manifest 保持轻量，也更适合作为后续缓存治理、恢复和观察的辅助层。

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先新增两类测试：

#### A. `test/core/cache/cacheManifestStore.test.js`

约束 `createCacheManifestStore()` 必须：

1. 对 `rootFile` 做别名归一化
2. 读取时支持别名路径命中同一条 manifest 记录
3. `list()` 按最近访问顺序返回
4. `getStats()` 能聚合：
   - `entryCount`
   - `totalBytes`

#### B. `test/client/services/indexClient.test.js`

约束 `indexClient` 必须在以下行为中同步更新 manifest：

1. 首次缓存快照时写入 manifest
2. 再次命中缓存时刷新 `lastAccessedAt`
3. 调用 `invalidate(rootFile)` 时移除 manifest 条目

先执行聚焦测试：

```powershell
npx mocha test\core\cache\cacheManifestStore.test.js test\client\services\indexClient.test.js --grep "manifest|createCacheManifestStore"
```

结果先红，失败原因准确：

- `cacheManifestStore` 模块不存在

### 4.2 再写最小实现

本轮新增：

- `createCacheManifestStore()`

支持：

1. `upsert(...)`
2. `get(rootFile)`
3. `remove(rootFile)`
4. `list()`
5. `getStats()`

并在 `indexClient` 中接入：

1. 默认创建一个内部 manifest store
2. 允许通过 `manifestStore` 注入自定义实例，便于测试与未来扩展
3. `touchSnapshotEntry()` 更新 LRU 顺序时同步更新 manifest
4. `invalidate()` / 逐出 / 失败清理时同步删除 manifest 记录

### 4.3 验证转绿

聚焦测试转绿后，再把整组 `indexClient` 测试重新跑完，全部通过。

说明：

1. manifest 行为本身已成立
2. 旧有缓存/失效/逐出逻辑没有被带坏
3. 后续代码审查中提出的“**命中缓存校验途中被 invalidate，可能把 stale manifest 写回**”这一竞态，经补充回归测试后确认当前实现已经被 `currentEntry !== cachedEntry` 身份检查正确拦住，没有出现 stale manifest 回写

---

## 5. 实际代码改动

## 5.1 `src/core/cache/cacheManifestStore.js`

本轮新增了一个最小 manifest store，内部维护：

- 规范化 key
- 去重后的 `trackedFiles`
- 派生的 `trackedFileCount`

并且对外只暴露清晰的小接口：

1. `upsert`
2. `get`
3. `remove`
4. `list`
5. `getStats`

## 5.2 `src/client/services/indexClient.js`

本轮把 manifest 正式接入到 L1 缓存生命周期里：

1. 快照首次写入时写 manifest
2. 快照被命中时刷新 `lastAccessedAt`
3. 被逐出时清掉 manifest
4. 手动失效时清掉 manifest

从而让 manifest 真正成为缓存层的一部分，而不是一个孤立的工具模块。

## 5.3 测试文件

新增：

- `test/core/cache/cacheManifestStore.test.js`

扩展：

- `test/client/services/indexClient.test.js`

其中新增了一条并发回归测试，专门钉住：

- 缓存命中校验进行中
- 外部同时 `invalidate(rootFile)`
- 当前请求必须重建，且不能把旧 manifest 条目写回

---

## 6. 真实工程样本验证

本轮继续使用用户提供的真实工程：

- 根文件：`D:\temp\LSDYNA\2020-nissan-rogue-v3\combine.key`

通过注入自定义 `manifestStore` 后，加载一次真实工程快照，得到：

```json
{
  "manifestEntry": {
    "rootFile": "D:\\temp\\LSDYNA\\2020-nissan-rogue-v3\\combine.key",
    "trackedFiles": [
      "D:\\temp\\LSDYNA\\2020-nissan-rogue-v3\\combine.key",
      "D:\\temp\\LSDYNA\\2020-nissan-rogue-v3\\rogue-v3.key",
      "D:\\temp\\LSDYNA\\2020-nissan-rogue-v3\\set-rogue-v2.key",
      "D:\\temp\\LSDYNA\\2020-nissan-rogue-v3\\wall.key"
    ],
    "trackedFileCount": 4,
    "byteSize": 479,
    "lastAccessedAt": 1
  },
  "manifestStats": {
    "entryCount": 1,
    "totalBytes": 479
  }
}
```

这说明 manifest 已经能真实反映：

1. 该工程实际纳入快照跟踪的文件集合
2. 当前快照的估算体积
3. 当前缓存层里到底有多少工程条目

---

## 7. 设计取舍

## 7.1 `getCacheStats()` 与 `manifestStore.getStats()` 暂时并存

当前：

- `indexClient.getCacheStats()` 仍然服务于快照缓存本身
- `manifestStore.getStats()` 服务于 manifest 元数据观察

两者数据目前会高度一致，但语义层次不同。本轮没有强行合并，避免把 manifest 设计成 `indexClient` 的私有实现细节。

## 7.2 manifest 优先服务“观察与治理”，不是直接参与有效性判断

当前快照是否过期，仍然由：

- `trackedFiles + getFileSignature()`

去判断。

manifest 更多承担：

1. 观察缓存里有哪些工程
2. 记录最近访问顺序
3. 为后续落盘、恢复、逐出策略提供元数据来源

这样的职责划分更稳健。

---

## 8. 验证结果

执行：

```powershell
npx mocha test\core\cache\cacheManifestStore.test.js test\client\services\indexClient.test.js --grep "manifest|createCacheManifestStore"
npx mocha test\client\services\indexClient.test.js
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

---

## 9. 对总体计划的推进意义

做到这一步之后，Phase 3 的内存缓存层已经不仅仅是“能工作”，而且开始具备：

1. 缓存本体
2. 失效边界
3. 自动校验
4. 单文件复用
5. 大小治理
6. **工程 manifest 元数据**

这为后续几条路线都提供了稳定基础：

1. Phase 4 的磁盘缓存
2. Phase 5 的 watcher 驱动失效
3. worker / server 侧的缓存恢复与观测

---

## 10. 一句话结论

**本轮把 Phase 3 里的“工程清单（manifest）”正式落成了独立模块，并接入 `indexClient` 的缓存生命周期，使当前内存缓存不仅能复用和逐出，还能稳定记录每个工程的跟踪文件集合、访问顺序与体积元数据。**
