# vscode-lsdyna 大文件方案执行记录（Phase 5：watcher 失效批处理）

## 1. 当前进度定位

上一轮已经完成：

1. `workspace.createFileSystemWatcher('**/*.{k,key,dyna}')`
2. 基于 manifest 的“变化文件 -> 受影响工程根”反查
3. 工作区文件 create/change/delete 时主动调用 `indexClient.invalidate(rootFile)`

但仍然有一个明显的企业级稳健性缺口：

> **高频保存或短时间内多个文件事件，仍可能导致同一工程根被重复失效多次。**

虽然当前 `invalidate()` 的成本不高，但这条链路后面还会继续接：

- watcher 驱动的后台重建
- worker 调度
- 更重的缓存恢复逻辑

因此现在就应该把 watcher 路径做成**批处理去抖**，避免后续放大成真正的排队风暴。

---

## 2. 本轮目标

本轮聚焦一个很小但很关键的质量增强：

1. 为 manifest 驱动的 watcher 失效增加 batching / debounce
2. 确保同一批次里同一根只失效一次
3. 确保不同文件事件命中的多个根可以合并到同一批次统一失效

本轮**不做**：

- 自动后台重建
- worker job batching
- 文件事件优先级
- watcher telemetry

---

## 3. 设计选择

## 3.1 保持“批处理失效”而不是“批处理重建”

本轮仍然只对 watcher 事件做：

- 收集
- 去重
- 延迟一次性 `invalidate()`

而不直接批量重建。

这样更稳妥，因为当前阶段先解决的是：

1. 重复失效
2. 同根多次命中
3. 高频保存时的稳定性

真正的后台重建可以在下一层 worker 设计里继续做。

## 3.2 在扩展层做最小调度，不下沉到核心缓存模块

这一版 batching 发生在 watcher 使用点附近，而不是直接塞到 `indexClient` 或 `fileInvalidation` 核心模块里。

原因是：

1. batching 是“事件调度策略”，不是缓存核心语义
2. `indexClient.invalidate()` 继续保持同步、直接、可预测
3. 后续如果要换成更复杂的调度器，可以只替换扩展层

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先在 `test/extension.test.js` 新增两条约束：

1. **同一根被快速重复命中时，只失效一次**
2. **同一批次内不同文件命中多个根时，能够合并失效**

先执行聚焦测试：

```powershell
npx mocha test\extension.test.js --grep "createBatchedManifestInvalidator"
```

结果先红，失败原因正确：

- `createBatchedManifestInvalidator` 不存在

### 4.2 再写最小实现

本轮新增：

- `createBatchedManifestInvalidator(...)`

核心逻辑：

1. 复用已有 `createManifestDrivenInvalidator(...)` 的受影响根定位语义
2. 用 `Map` 累积待失效根
3. 每次新文件事件到来时重置 timer
4. timer 到期后一次性逐根调用 `invalidate()`

并在 `activate()` 中把 watcher 事件入口从：

- 立即失效

切换为：

- batched invalidation

### 4.3 验证转绿

聚焦测试转绿后，再跑全量测试，确认现有激活路径和 watcher 集成没有退化。

在代码审查阶段还额外暴露出一个真实边界：

- 若一个已跟踪文件事件已经把某些根排进批处理队列
- 随后又来了一个**未被任何 manifest 跟踪**的文件事件
- 这个无关事件不应该取消并重置已有 timer

为此又补了一条专门的回归测试，并把实现改为：

1. 先计算 `affectedRoots`
2. 如果本次事件命中 0 个根，立即返回
3. 只有真正命中至少一个根时，才会重置 timer

---

## 5. 实际代码改动

## 5.1 `src/extension.js`

本轮新增：

- `createBatchedManifestInvalidator(...)`

并让 `activate()` 里的 watcher 改用该 batched invalidator。

实现细节保持很小：

1. `delayMs` 默认 100ms
2. `schedule/cancel` 可注入，便于测试
3. 根去重时做了跨平台 key 处理

## 5.2 `test/extension.test.js`

新增两条行为测试：

1. 高频同根事件合并
2. 多根事件合并
3. 无关文件事件不会把已排队的 timer 重新延期

---

## 6. 验证结果

执行：

```powershell
npx mocha test\extension.test.js --grep "createBatchedManifestInvalidator"
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

---

## 7. 对总体计划的推进意义

做到这一步后，Phase 5 的 watcher 路径已经不仅仅是“能失效”，而是更进一步具备：

1. manifest 驱动失效
2. 同根去重
3. 高频事件批处理

这让下一步接：

1. 后台自动重建
2. worker 调度
3. 更复杂的刷新策略

时，底层事件入口更稳定，也更接近企业级使用要求。

---

## 8. 一句话结论

**本轮把 watcher 驱动的缓存失效从“立即逐次执行”提升为了“批处理去抖执行”，让高频文件事件下的缓存失效路径更稳、更可扩展。**
