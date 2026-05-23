# vscode-lsdyna 大文件方案执行记录（Phase 3：projectIndexer 单文件扫描复用）

## 1. 当前进度定位

截至本轮开始前，整体进度已经推进到：

- **Phase 2 已基本打通**
  - parser 抽取完成
  - `projectIndexer` / `ProjectGraph` 已落地
  - Include Tree / Keyword Index 已接入统一项目快照
  - `indexClient` 已成为共享 client 边界

- **Phase 3 已完成前两步**
  1. `indexClient` L1 项目快照缓存
  2. `invalidate(rootFile)` + stale in-flight 防污染
  3. 基于 `snapshot.files` 的自动过期校验

但还有一个明显未完成点：

> **快照虽然会在文件变化后正确失效，但失效后的重建仍然会全工程重扫。**

这与总体计划里“修改一个 include 文件后，不会触发全工程所有文件重扫”的目标还有差距。

因此本轮聚焦到 Phase 3 的下一块核心能力：

**让 `projectIndexer` 在跨次构建之间复用未变化文件的扫描结果。**

---

## 2. 本轮目标

本轮只做最小但高价值的复用能力：

1. 把 `projectIndexer` 从纯无状态函数演进为一个可持有内存缓存的 factory
2. 为每个文件缓存最小 `FileScanResult`
   - `keywords`
   - `includeEntries`
   - `searchPaths`
3. 用 `filePath + mtimeMs + size` 判断单文件扫描结果是否仍可复用
4. 保持 `buildProjectIndex(rootFile)` 对外 API 兼容
5. 给快照增加最小统计：
   - `stats.scannedFileCount`
   - `stats.reusedFileCount`

本轮**不做**：

- manifest
- LRU / 配额逐出
- watcher
- worker_threads
- 块级增量

---

## 3. 设计选择

## 3.1 让“文件扫描缓存”下沉到 `projectIndexer`

前两轮缓存都放在 `indexClient`：

- 项目快照缓存
- 项目快照自动失效

但“未变化文件的扫描结果复用”更适合放到 `projectIndexer`，因为它最了解：

1. 单文件扫描结果包含哪些字段
2. 哪些字段可复用、哪些字段需要重新聚合
3. 项目图和关键字聚合应如何基于这些结果重建

因此本轮做法是：

- `indexClient` 继续负责**项目快照级**缓存边界
- `projectIndexer` 新增**单文件扫描级**缓存边界

两层职责分离，不把文件级缓存逻辑继续堆到 client 层。

## 3.2 保持图聚合仍然是“每次重建”

本轮没有尝试直接复用：

- `ProjectGraph`
- `keywordMap`
- 最终 `ProjectIndexSnapshot`

而是保持：

1. 每次 `buildProjectIndex(rootFile)` 仍然重新聚合工程图
2. 只是它读取输入时，优先复用未变化文件的扫描结果

这样更稳健，因为：

- 图聚合逻辑仍然是一次性、确定性的
- 不需要处理复杂的“图局部补丁”
- 先把收益最大的重复文件扫描收掉即可

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先在 `test/core/project/projectIndexer.test.js` 增加一条新约束：

**当只有一个子文件发生变化时，第二次构建应只重扫该子文件，其余文件应从缓存复用。**

测试样本使用：

- `main.k` include `a.key` / `b.key`
- 首次构建后缓存三份文件扫描结果
- 第二次仅修改 `b.key` 的签名与关键字结果

期望：

1. 第二次构建的 `stats` 为：
   - `scannedFileCount: 1`
   - `reusedFileCount: 2`
2. `PART` 仍来自 `a.key`
3. `MAT_ELASTIC` 被新的 `SECTION` 替代
4. `main.k` 和 `a.key` 的 include / keyword 扫描函数不再重复调用

先执行聚焦测试：

```powershell
npx mocha test\core\project\projectIndexer.test.js --grep "reuses unchanged file scans"
```

第一次先红，失败原因正确：

- `createProjectIndexer` 还不存在

随后把测试样本修正为“真实存在的临时文件路径”，避免 include 解析被文件不存在提前短路后，再次执行聚焦测试，仍然要求新能力本身来决定是否转绿。

### 4.2 再写最小实现

`src/core/project/projectIndexer.js` 本轮改为：

1. 导出 `createProjectIndexer(...)`
2. 模块内仍保留一个默认 singleton：
   - `buildProjectIndex = defaultProjectIndexer.buildProjectIndex`
3. factory 内维护 `fileScanCache`
4. 每次访问文件时先取：
   - 当前文件签名
   - 缓存中的上次签名
5. 若签名一致，则直接复用缓存里的：
   - `keywords`
   - `includeEntries`
   - `searchPaths`
6. 若签名变化，则重新调用：
   - `collectKeywordsFromFile`
   - `collectIncludeDirectivesFromFile`

并把统计结果累加到：

- `stats.scannedFileCount`
- `stats.reusedFileCount`

### 4.3 验证转绿

聚焦测试转绿后，再执行整组 `projectIndexer` 测试，全部通过。

这说明：

1. 原有图聚合、缺失 include、循环保护行为未退化
2. 新增的文件级扫描复用已成立

---

## 5. 实际代码改动

## 5.1 `src/core/project/projectIndexer.js`

本轮新增：

1. `createProjectIndexer(...)`
2. `readFileSignature(filePath)`
3. `fileScanCache`
4. 单文件签名比较与缓存复用逻辑

并保持：

1. `buildProjectIndex(rootFile)` 仍然可直接导入使用
2. `ProjectGraph` 聚合方式不变
3. `snapshot.files / graph / keywordMap / missingFiles / cycles` 结构不变

仅额外增加：

```js
snapshot.stats = {
  scannedFileCount,
  reusedFileCount,
};
```

## 5.2 `test/core/project/projectIndexer.test.js`

新增针对“子文件变化后局部重扫”的行为测试，用真实的临时文件路径驱动 include 解析，以防测试只验证 stub 而不验证真实访问路径。

---

## 6. 真实工程样本验证

本轮继续使用用户提供的工程：

- 工程目录：`D:\temp\LSDYNA\2020-nissan-rogue-v3`
- 主文件：`combine.key`
- 修改验证文件：`wall.key`

验证方式：

1. 第一次冷加载 `combine.key`
2. 手动 `invalidate(rootFile)` 后再次加载，验证**全量文件扫描结果是否都来自复用**
3. 临时修改 `wall.key`（验证后恢复）
4. 不手动 `invalidate()`，再次加载 `combine.key`
5. 直接读取 `snapshot.stats`

实测结果：

| 场景 | durationMs | scannedFileCount | reusedFileCount | fileCount | keywordGroupCount |
| --- | ---: | ---: | ---: | ---: | ---: |
| 冷加载 | 2547 | 4 | 0 | 4 | 88 |
| 手动失效后热重建 | 4 | 0 | 4 | 4 | 88 |
| 子文件变化后自动重建 | 5 | 1 | 3 | 4 | 88 |

这组数据说明三件事已经同时成立：

1. `indexClient` 的项目快照失效边界仍然有效
2. `projectIndexer` 已能在重建时完全复用未变化文件
3. 当只改一个 include 子文件时，已经不再需要全工程重扫

并且验证结束后已将 `wall.key` 恢复原始内容。

---

## 7. 设计取舍

## 7.1 先缓存最小扫描摘要，不缓存聚合图

本轮缓存的是“单文件扫描结果”，而不是更高层的图结构。这样做的原因是：

1. 单文件扫描结果天然以文件为边界，失效判断最简单
2. 图与关键字聚合保持确定性重建，更稳
3. 未来要接入 worker / manifest / watcher 时，更容易复用同一层缓存

## 7.2 先用 singleton `buildProjectIndex` 保持现有注入方式不变

当前扩展和 `indexClient` 仍然直接依赖：

- `buildProjectIndex(rootFile)`

为了不在这一轮同时改动调用层，本轮保留默认 singleton 导出，同时额外开放：

- `createProjectIndexer()`

这样：

1. 生产代码不用跟着改一圈
2. 新能力已经能在默认导出路径生效
3. 单测仍可用 factory 做隔离测试

---

## 8. 验证结果

执行：

```powershell
npx mocha test\core\project\projectIndexer.test.js --grep "reuses unchanged file scans"
npx mocha test\core\project\projectIndexer.test.js
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

---

## 9. 对总体计划的推进意义

做到这一步后，Phase 3 已经不只是“项目快照可复用”，而是进一步具备了：

1. **项目快照级复用**：同一工程未变时直接命中快照
2. **自动正确性校验**：文件变了会自动放弃旧快照
3. **文件扫描级复用**：重建时只重扫变化文件，其余文件继续复用

这使得 Phase 3 的核心目标基本开始落地：

> 修改一个 include 文件后，不再触发全工程所有文件重扫。

后续下一批更自然的方向就是：

1. manifest / 大小统计 / 逐出
2. watcher 驱动失效
3. worker 后端执行

---

## 10. 一句话结论

**本轮把 `projectIndexer` 从“每次全量扫描”推进到了“重建时复用未变化文件扫描结果”，并已在真实 LS-DYNA 工程中验证：手动失效后可 0 扫描重建，单个子文件变化后只需重扫 1 个文件。**
