# vscode-lsdyna 大文件方案执行记录（Phase 3：indexClient 缓存失效与 in-flight 保护）

## 1. 本轮目标

在 Phase 2 已经把 Include Tree / Keyword Index 的快照入口统一为：

- `loadProjectSnapshot(rootFile)`

之后，开始补上 Phase 3 的第一块最小复用能力：

1. 同一工程重复加载时复用已有项目快照
2. 提供显式 `invalidate(rootFile)` 失效入口
3. 保证失效发生在旧请求 still in-flight 时，后续请求不会继续复用旧结果

本轮刻意只做 **L1 内存快照缓存 + 失效语义**，不提前引入 manifest、文件级 mtime/size 键、磁盘缓存或 watcher。

---

## 2. 为什么先做这一小步

Phase 3 的目标不是一次性把缓存体系做满，而是先把最容易影响后续架构边界的行为钉住：

1. `indexClient` 需要成为快照复用与失效的唯一入口
2. 失效语义必须先于更复杂的缓存键、后台刷新、watcher 自动失效稳定下来
3. 如果 in-flight 请求在失效后仍能污染缓存，后面接 worker / watcher 时会放大成真实一致性问题

因此本轮优先解决的是 **缓存入口契约**，不是缓存命中率极致优化。

---

## 3. TDD 过程

### 3.1 先写失败测试

本轮先在 `test/client/services/indexClient.test.js` 新增三组约束：

1. **根路径别名归一化**
   - `project\main.k`
   - `project\.\main.k`
   应命中同一条缓存记录

2. **显式失效**
   - 先加载一次快照
   - 再通过别名路径调用 `invalidate(rootFile)`
   - 下一次加载必须触发重建

3. **失效期间绕过旧 in-flight**
   - 第一个 `loadProjectSnapshot()` 还未返回
   - 中途调用 `invalidate(rootFile)`
   - 后续新请求必须发起新的构建，而不是继续复用旧 promise

先跑聚焦测试：

```powershell
npx mocha test\client\services\indexClient.test.js
```

结果先红，失败原因符合预期：

- 同一路径别名会重复触发 `buildProjectIndex`
- `client.invalidate` 不存在
- 失效后无法绕过旧 in-flight 请求

### 3.2 再写最小实现

本轮在 `src/client/services/indexClient.js` 只补了最小能力：

1. 规范化 `rootFile`，用作缓存 key
2. 首次加载后把项目快照缓存到内存
3. 若同一路径已存在 in-flight promise，则复用它
4. 暴露 `invalidate(rootFile)`，删除对应缓存并推进代次
5. 当旧 in-flight promise 在失效后完成时，只把结果返回给旧调用者，不再回写缓存

这里采用的是 **generation / epoch** 保护，而不是强行取消底层扫描：

- 当前 `buildProjectIndex()` 没有 cancellation 协议
- 直接支持“失效后绕过旧请求”已经足够稳妥
- 后续若接入 worker，可在相同边界上继续补 cancellable job

### 3.3 验证转绿

聚焦测试重新执行后转绿，说明：

1. 根路径别名已能共用缓存
2. `invalidate()` 已能驱动重建
3. 失效期间不会让旧 in-flight 结果重新污染缓存

---

## 4. 实际代码改动

### 4.1 `src/client/services/indexClient.js`

从“单纯透传 `buildProjectIndex`”升级为最小可复用 client：

- `loadProjectSnapshot(rootFile)`
- `invalidate(rootFile)`

内部增加：

1. 路径规范化
2. L1 内存快照缓存
3. in-flight promise 复用
4. generation 防回写保护

### 4.2 `test/client/services/indexClient.test.js`

新增三组面向行为的测试：

1. 规范化路径别名缓存命中
2. 别名路径失效后触发重建
3. 失效期间绕过旧 in-flight

这些测试把后续 Phase 3/5 继续演进最容易踩坑的边界先钉死了。

---

## 5. 真实工程样本测量

本轮使用用户提供的本地样本工程做手工验证：

- 工程目录：`D:\temp\LSDYNA\2020-nissan-rogue-v3`
- 主文件：`combine.key`
- 大体积 include：`rogue-v3.key`（约 398 MB）

执行脚本基于：

- `createIndexClient({ buildProjectIndex })`
- `loadProjectSnapshot(rootFile)`
- `invalidate(rootFile)`

测量结果：

| 场景 | durationMs | fileCount | keywordGroupCount | missingCount | cycleCount |
| --- | ---: | ---: | ---: | ---: | ---: |
| 冷加载 | 2357 | 4 | 88 | 0 | 0 |
| 热加载（命中 L1） | 0 | 4 | 88 | 0 | 0 |
| 失效后重载 | 2202 | 4 | 88 | 0 | 0 |

说明当前最小 L1 缓存在真实大文件样本上已经具备明确收益：**重复读取同一工程时可直接复用快照，显著避免重新扫描 398 MB 级子文件。**

---

## 6. 设计取舍

## 6.1 先缓存项目快照，不先拆文件级缓存

本轮没有直接上：

- `FileScanResult` 级缓存
- `mtimeMs + size` 失效键
- manifest

原因是当前最紧迫的是先把客户端入口语义稳定下来，保证之后不论：

- Provider 主动重扫
- watcher 自动失效
- worker 异步刷新

都走同一个 `indexClient` 失效边界。

## 6.2 先“绕过 stale in-flight”，不强求立即取消

当前更稳妥的做法是：

1. 失效后立刻让新请求走新 generation
2. 旧请求即使稍后完成，也不允许覆盖新状态

这样已经能避免最危险的一类一致性问题；真正的任务取消能力可以等 worker job 模型引入后再补。

---

## 7. 验证结果

执行：

```powershell
npx mocha test\client\services\indexClient.test.js
npm test
git --no-pager diff --check
```

本轮提交前以上三项均通过。

---

## 8. 对总体计划的推进意义

做到这一步之后，`indexClient` 已不再只是 `buildProjectIndex` 的薄包装，而是开始承担：

1. 项目快照复用
2. 显式失效入口
3. 并发请求防陈旧污染

这为下一步继续做下面几件事铺好了边界：

1. 接入 `filePath + mtimeMs + size` 级别的更细粒度失效键
2. 接入 watcher 驱动的 `invalidate()`
3. 在 `indexClient` 背后切换到 worker 执行

---

## 9. 一句话结论

**本轮完成了 Phase 3 的第一块核心基础：让 `indexClient` 具备最小 L1 快照缓存、显式失效入口，以及失效期间对 stale in-flight 请求的防污染保护，并已用真实 398 MB 级样本工程验证热加载收益。**
