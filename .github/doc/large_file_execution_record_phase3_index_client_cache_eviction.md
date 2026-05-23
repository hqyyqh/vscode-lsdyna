# vscode-lsdyna 大文件方案执行记录（Phase 3：indexClient 缓存大小统计与 LRU 逐出）

## 1. 当前进度定位

到本轮开始时，Phase 3 已经完成：

1. 项目快照 L1 缓存
2. `invalidate(rootFile)` 显式失效
3. stale in-flight 防污染
4. 基于 `snapshot.files` 的自动过期校验
5. `projectIndexer` 单文件扫描复用

但还有一个明显缺口：

> **L1 快照缓存没有容量边界，长期运行会无限增长。**

这与总体计划里“为缓存增加大小统计与逐出逻辑”的目标还不一致。

因此本轮聚焦：

**为 `indexClient` 的项目快照缓存补上大小统计与 LRU 逐出。**

---

## 2. 本轮目标

本轮只做最小、可验证的缓存治理能力：

1. 为每个已缓存 `ProjectIndexSnapshot` 记录估算大小
2. 暴露最小缓存统计：
   - `cachedSnapshotCount`
   - `totalSnapshotBytes`
3. 为 L1 快照缓存加入固定上限
4. 当上限超出时，按 **LRU** 逐出最久未访问的已完成快照

本轮**不做**：

- 磁盘缓存
- manifest 持久化
- 用户配置项
- TTL
- 分层缓存配额联动

---

## 3. 设计选择

## 3.1 只治理“项目快照缓存”，不碰 in-flight promise

`indexClient` 里同时存在两类缓存对象：

1. 已完成快照
2. 正在构建的 in-flight promise

本轮只对**已完成快照**做大小统计与逐出，不对 in-flight promise 做逐出，原因是：

1. promise 还没有稳定的快照体积
2. 强行取消 in-flight 任务会引入额外的取消协议
3. 现阶段更稳妥的做法是：只治理“已经真正占住内存的完成态快照”

## 3.2 用估算函数而不是提前绑定真实序列化格式

本轮没有提前引入 manifest / 二进制序列化，而是让 `indexClient` 接收：

- `estimateSnapshotSize(snapshot)`

默认实现采用：

- `Buffer.byteLength(JSON.stringify(snapshot), 'utf8')`

这样做的好处是：

1. 不依赖未来最终采用什么磁盘格式
2. 当前实现足够简单可测
3. 后续若要改成更准确的 payload 估算，只需替换估算函数

## 3.3 使用 LRU，而不是随机或 FIFO

快照缓存本质上服务于“最近访问的工程”。因此第一版逐出策略选用 LRU：

1. 命中缓存时更新访问序
2. 新快照写入后若超限，则优先逐出最久未访问的快照

这和扩展的实际交互模式最一致，也最符合企业级稳健性的直觉预期。

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先在 `test/client/services/indexClient.test.js` 增加两条约束：

1. **超过缓存大小上限时，逐出最久未访问的快照**
   - 加载 A / B
   - 再访问一次 A，使 B 变成最旧
   - 加载 C，触发逐出
   - 再次加载 B 时必须重建

2. **失效后缓存统计必须同步下降**
   - 先缓存两个快照
   - 读取统计应为 2 条记录 / 累计 24 bytes
   - `invalidate(rootA)` 后应变成 1 条记录 / 12 bytes

先执行聚焦测试：

```powershell
npx mocha test\client\services\indexClient.test.js --grep "evicts the least recently used|updates snapshot cache stats"
```

结果先红，失败原因符合预期：

- `client.getCacheStats` 不存在

### 4.2 再写最小实现

在 `src/client/services/indexClient.js` 中补了以下最小能力：

1. `estimateSnapshotSize(snapshot)` 默认估算函数
2. `getSnapshotCacheStats(snapshots)` 统计辅助
3. `maxSnapshotBytes` 固定上限
4. `lastAccessedAt` 访问序号
5. `evictSnapshotsIfNeeded(protectedRootCacheKey)`：写入后按 LRU 逐出
6. `getCacheStats()`：返回当前缓存统计

并保持现有语义不变：

1. 别名归一化仍然成立
2. 自动过期校验仍然成立
3. stale in-flight 防污染仍然成立
4. `loadProjectSnapshot(rootFile)` API 不变

### 4.3 验证转绿

新增两条测试转绿后，再把整个 `indexClient` 测试面重跑，全部通过。

这说明：

1. 新增的逐出逻辑生效
2. 旧缓存/失效行为没有被带坏

---

## 5. 实际代码改动

## 5.1 `src/client/services/indexClient.js`

本轮新增：

1. `estimateSnapshotSize(snapshot)`
2. `getSnapshotCacheStats(snapshots)`
3. `getCacheStats()`
4. `maxSnapshotBytes`
5. `lastAccessedAt`
6. `evictSnapshotsIfNeeded(...)`

缓存命中时现在还会更新 LRU 访问顺序；快照写入成功后，如果总大小超过上限，则会优先逐出最久未访问的其它快照。

## 5.2 `test/client/services/indexClient.test.js`

新增两组行为测试：

1. LRU 逐出
2. 统计同步更新

测试使用可注入的：

- `estimateSnapshotSize`
- `maxSnapshotBytes`

确保逐出与统计的行为可以稳定、精确地验证。

---

## 6. 验证样本

为了验证逐出后的统计结果，本轮执行了一个最小样本脚本：

1. 加载 A / B 两个快照
2. 再访问 A，使 B 成为最久未使用
3. 加载 C，触发逐出

脚本输出：

```json
{
  "cachedSnapshotCount": 2,
  "totalSnapshotBytes": 20
}
```

这与测试配置完全一致：

- 每个快照估算 10 bytes
- 总上限 20 bytes
- 最终只保留 2 个快照

---

## 7. 设计取舍

## 7.1 允许保护当前刚写入的快照

本轮逐出时会优先保护“刚刚成功写入的当前快照”，只逐出其它更旧的完成态快照。

这样做更符合用户预期：刚刚请求得到的新快照，不应该在同一轮写入后马上被自己挤掉。

## 7.2 统计按实时 Map 扫描计算

本轮没有额外维护一套复杂的增量计数器，而是每次通过当前缓存 Map 实时计算：

- `cachedSnapshotCount`
- `totalSnapshotBytes`

在当前规模下，这种做法更简单、更不容易出现增删不一致。

---

## 8. 验证结果

执行：

```powershell
npx mocha test\client\services\indexClient.test.js
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

---

## 9. 对总体计划的推进意义

做到这一步之后，Phase 3 的 L1 快照缓存已经同时具备：

1. 可复用
2. 可显式失效
3. 可自动过期
4. 可局部重扫复用
5. **可统计**
6. **可逐出**

这意味着“先把内存层缓存做稳”的 Phase 3 主干已经更完整了。后续更自然的下一步就是：

1. manifest
2. watcher 驱动失效
3. worker / 后台执行边界

---

## 10. 一句话结论

**本轮为 `indexClient` 的 L1 项目快照缓存补上了大小统计和 LRU 逐出能力，解决了缓存无限增长的问题，同时保持了既有的失效、自动校验和快照复用语义。**
