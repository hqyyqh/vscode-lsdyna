# vscode-lsdyna 大文件方案执行记录（Phase 5：watcher 驱动后台自动重建）

## 1. 当前进度定位

到本轮开始时，Phase 5 已经具备：

1. workspace watcher
2. manifest 驱动的受影响根定位
3. batched invalidation

但 watcher 还只做到：

> 文件变了 → 相关根缓存失效

这意味着下一次真正访问这些根时，才会触发重建。虽然正确性已经有保障，但“**后台自动重建**”这一层还没落地。

因此本轮继续推进三件事：

1. 新增项目快照后台重建队列
2. 把 watcher 批处理失效和后台重建队列串起来
3. 给失败路径补上不中断后续根的保护

---

## 2. 本轮目标

本轮把 watcher 失效链路从：

- invalidate only

推进到：

- batched invalidate
- enqueue background refresh

具体目标：

1. 同一根重复入队时只保留一次
2. 多个根按顺序后台重建，避免并发放大
3. 某个根重建失败时，不影响后续根继续处理

本轮**不做**：

- worker 线程
- UI 自动刷新
- 后台重建进度提示
- 重建优先级策略

---

## 3. 设计选择

## 3.1 先做“顺序后台重建队列”，不做并发重建

当前最稳妥的选择不是并行重建多个工程，而是：

1. watcher 批量收集受影响根
2. 根逐个进入后台重建队列
3. 队列顺序执行

原因：

1. 当前扩展还没有 worker 隔离
2. 顺序队列更容易避免并发放大和重复工作
3. 下一阶段切到 worker 时，可以在相同边界上把队列执行器替换掉

## 3.2 失败不吞掉，但也不阻断后续根

后台重建如果某个根失败，本轮选择：

1. 记录错误（`console.error`）
2. 继续处理队列中的后续根

这样做能同时满足：

1. **不 silent fail**
2. **不因为一个根失败把整批重建卡死**

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先在 `test/extension.test.js` 新增两组约束：

1. **顺序执行 + 根去重**
   - A 入队
   - A 再次入队
   - B 入队
   - 结果必须先重建 A，再重建 B，且 A 只重建一次

2. **失败不中断**
   - A 重建报错
   - B 仍然必须继续执行
   - 错误通过 `onError(error, rootFile)` 交给调用方

先执行聚焦测试：

```powershell
npx mocha test\extension.test.js --grep "createProjectSnapshotRefreshQueue"
```

结果先红，失败原因正确：

- `createProjectSnapshotRefreshQueue` 不存在

### 4.2 再写最小实现

本轮新增：

- `createProjectSnapshotRefreshQueue(...)`

它负责：

1. 去重待处理根
2. 避免当前正在重建的根重复入队
3. 用单一调度入口顺序 drain 队列
4. 单根失败时调用 `onError(error, rootFile)`，然后继续

同时把 `activate()` 改成：

1. 先创建 `enqueueProjectSnapshotRefresh`
2. 再把 batched invalidator 的 `onInvalidatedRoots` 接到该队列

从而实现：

- 文件变化
- watcher batched invalidation
- 背景重建排队

这一整条链路。

### 4.3 验证转绿

聚焦测试转绿后，再跑 watcher 相关整组测试和全量测试，确认没有回归。

在代码审查阶段还额外暴露出一个真实并发边界：

- A 根正在后台重建
- 此时又有新的 B 根入队
- 如果队列实现允许再次 schedule 一个新的 drain，就会破坏“顺序执行”保证

因此本轮又补了一条回归测试，专门验证：

1. A 正在处理中
2. B 在处理中途入队
3. B 必须等 A 完成后才开始
4. `maxConcurrent` 始终保持为 1

实现上也据此补了 `processing` 门闩，确保：

- processing 中不再重复 schedule
- 已在运行的 drain 会自然吃完后来入队的根

---

## 5. 实际代码改动

## 5.1 `src/extension.js`

本轮新增：

- `createProjectSnapshotRefreshQueue(...)`

并调整：

- `createBatchedManifestInvalidator(...)`

支持在完成一批失效后，通过 `onInvalidatedRoots(roots)` 把这些根交给后台重建队列。

`activate()` 中则新增：

1. `enqueueProjectSnapshotRefresh`
2. watcher batch → refresh queue 的接线

## 5.2 `test/extension.test.js`

新增两组测试：

1. 顺序执行 + 去重
2. 失败不中断后续根
3. 处理中再入队时，仍然保持严格顺序执行，不启动第二个并发 drain

---

## 6. 设计取舍

## 6.1 当前仍然不自动刷新 UI

本轮后台重建只是把缓存预热到新状态，不主动触发：

- Include Tree refresh
- Keyword Index refresh

这是刻意的：

1. 先把数据层后台重建做稳
2. 再决定 UI 刷新策略

## 6.2 让 batched invalidator 只负责“失效 + 通知”

本轮没有把后台重建逻辑直接塞进 batched invalidator 内部，而是通过：

- `onInvalidatedRoots(roots)`

把后续动作解耦出来。

这样后续如果要换成：

- worker queue
- priority queue
- telemetry queue

都更容易扩展。

---

## 7. 验证结果

执行：

```powershell
npx mocha test\extension.test.js --grep "createProjectSnapshotRefreshQueue|createBatchedManifestInvalidator|createManifestDrivenInvalidator|workspace watcher"
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

---

## 8. 对总体计划的推进意义

做到这一步后，Phase 5 已经从“文件变更会让缓存失效”进一步推进到了：

1. watcher 发现变化
2. manifest 反查受影响根
3. batched invalidation
4. **后台自动重建队列**

这意味着下一步再切到：

1. `worker_threads`
2. 更强的后台调度
3. 磁盘缓存热恢复

时，扩展层事件入口已经更接近目标形态。

---

## 9. 一句话结论

**本轮把 watcher 失效链路继续推进成了“失效后顺序后台重建”的模式，并通过去重、顺序执行和失败不中断，保证了高频文件变化下的缓存恢复路径依然稳健。**
