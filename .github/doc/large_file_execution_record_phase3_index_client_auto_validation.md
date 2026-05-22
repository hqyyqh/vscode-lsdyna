# vscode-lsdyna 大文件方案执行记录（Phase 3：indexClient 工程文件变更自动失效）

## 1. 本轮目标

在上一轮已经完成：

- `loadProjectSnapshot(rootFile)` 的 L1 内存缓存
- `invalidate(rootFile)` 显式失效入口
- 失效期间对 stale in-flight 结果的防污染保护

之后，继续补齐 Phase 3 更接近真实使用的一步：

**如果工程内任意已纳入快照的文件发生变化，`indexClient` 再次加载同一工程时，必须自动识别旧快照已过期并触发重建，而不是只能依赖手动 `invalidate()`。**

本轮仍然保持范围收敛：

1. 不引入 manifest
2. 不引入 `FileScanResult` 级缓存
3. 不引入 watcher
4. 只做 **ProjectIndexSnapshot 命中前的自动有效性校验**

---

## 2. 为什么这一步必须尽快补

如果只有显式 `invalidate(rootFile)`，缓存虽然能工作，但在当前扩展的真实使用方式里会留下一个 correctness gap：

1. 用户手动触发 Include Tree / Keyword Index 扫描
2. 中途修改了某个被 include 的子文件
3. 再次触发扫描时，如果上层没有显式调用 `invalidate()`，就会继续复用旧快照

这会直接导致：

- Include Tree 看起来“刷新了”，实际仍是旧工程结构
- Keyword Index 看起来“命中了缓存”，实际结果已经过期

因此在 Phase 3 中，**自动识别快照是否仍然有效** 是比 manifest、磁盘缓存更优先的 correctness 基线。

---

## 3. 设计选择

## 3.1 使用 `filePath + mtimeMs + size` 做第一版有效性校验

本轮直接沿用总体计划里的第一版思路：

- `filePath`
- `mtimeMs`
- `size`

作为已跟踪工程文件的签名。

命中缓存时，`indexClient` 会读取上一次快照里的 `snapshot.files`，对每个文件重新取当前签名并比较：

1. 全部一致 → 返回缓存快照
2. 任意文件变更 → 视为快照过期，立即重建
3. 任意文件丢失 / `stat` 失败 → 同样视为快照过期，立即重建

这一版的优点是：

1. 不需要改动 `projectIndexer` 输出形状
2. 不需要先上 watcher
3. 能覆盖“根文件未变，但 include 子文件已变”的关键场景

## 3.2 仍然保持快照级重建，不提前做文件级局部复用

虽然自动校验已经拿到了工程文件维度的信息，但本轮**没有**进一步做：

- 只重扫变更文件
- 复用未变更文件的 `FileScanResult`
- 部分聚合更新

原因是这些属于下一层能力。当前先把“旧缓存不会悄悄漏回给用户”这个边界钉住，更稳妥。

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先在 `test/client/services/indexClient.test.js` 新增两组约束：

1. **已跟踪子文件内容变化时自动重建**
   - 第一次加载得到 `snapshot v1`
   - 修改 `child.key` 的签名
   - 再次加载时必须得到 `snapshot v2`

2. **已跟踪子文件消失时自动重建**
   - 第一次加载得到带 `child.key` 的 `snapshot v1`
   - 后续读取签名时模拟 `ENOENT`
   - 再次加载时必须得到不再包含该文件的 `snapshot v2`

先执行聚焦测试：

```powershell
npx mocha test\client\services\indexClient.test.js --grep "tracked project file"
```

结果先红，且失败原因正确：

- 子文件变化后，缓存仍然返回 `version: 1`
- 子文件消失后，缓存仍然返回旧快照

### 4.2 再写最小实现

在 `src/client/services/indexClient.js` 中增加最小自动校验能力：

1. 默认用 `fs.stat()` 读取文件签名
2. 在缓存写入时记录 `snapshot.files` 对应的签名集合
3. 命中缓存时，逐个重新校验这些文件的 `mtimeMs + size`
4. 如果校验失败或文件缺失，则视为过期并触发新构建
5. 若校验过程中已有并发请求先一步替换了该缓存项，则当前请求复用新的缓存状态，不重复建新

同时保留上一轮的 generation 保护，确保：

- 自动校验触发的重建
- 手动 `invalidate()`
- in-flight promise 复用

三者之间不会相互污染。

### 4.3 验证转绿

把 `test/client/services/indexClient.test.js` 全量重新跑完后转绿，说明：

1. 根路径别名缓存命中仍然成立
2. 手动 `invalidate()` 仍然成立
3. stale in-flight 防污染仍然成立
4. 自动失效的新行为也已成立

---

## 5. 实际代码改动

### 5.1 `src/client/services/indexClient.js`

新增了几块内部能力：

1. `readFileSignature(filePath)`：基于 `fs.stat()` 读取 `mtimeMs + size`
2. `captureTrackedFiles(snapshot, getFileSignature)`：在缓存快照时记录工程文件签名
3. `isSnapshotValid(entry, getFileSignature)`：在命中缓存时逐一校验

`loadProjectSnapshot(rootFile)` 的行为现在变成：

1. 若存在 in-flight promise，优先复用
2. 若存在已完成的缓存快照，先校验工程文件签名
3. 校验通过才直接返回缓存
4. 校验失败则自动重建

### 5.2 `test/client/services/indexClient.test.js`

本轮新增两组行为测试，并补充已有虚拟路径测试的签名 stub，让这些测试样本也能走真实缓存路径。

---

## 6. 真实工程样本验证

本轮继续使用用户提供的真实工程：

- 工程目录：`D:\temp\LSDYNA\2020-nissan-rogue-v3`
- 主文件：`combine.key`
- 用于变更验证的子文件：`wall.key`

验证方式：

1. 冷加载一次 `combine.key`
2. 立即再次加载，确认命中热缓存
3. **不调用 `invalidate()`**
4. 临时向 `wall.key` 追加一行注释（验证后恢复原内容）
5. 再次加载 `combine.key`

测量结果：

| 场景 | durationMs | fileCount | keywordGroupCount |
| --- | ---: | ---: | ---: |
| 冷加载 | 2188 | 4 | 88 |
| 热加载 | 0 | 4 | 88 |
| 子文件变更后自动重建 | 2054 | 4 | 88 |

这说明当前实现已经具备下面的真实行为：

1. 同一工程未变化时，仍可直接命中热缓存
2. 被 include 的小文件一旦变化，即使不手动 `invalidate()`，也会自动放弃旧快照并重建
3. 验证结束后已将 `wall.key` 内容恢复，不留残余修改

---

## 7. 设计取舍

## 7.1 先做“命中前校验”，不做“后台预热刷新”

本轮选择的是同步命中前校验：

1. 请求来了
2. 若有缓存，先比签名
3. 过期才重建

而没有做：

- 后台定时预热
- 异步过期刷新
- stale-while-revalidate

因为当前项目还在 Phase 3 的 correctness-first 阶段，先保证“返回的一定不是明显过期快照”更重要。

## 7.2 保持 `indexClient` 为唯一失效边界

即使现在加入了自动校验，手动 `invalidate()` 也没有被绕开，而是与自动校验一起构成统一边界：

- 主动失效：外部调用 `invalidate(rootFile)`
- 被动失效：命中缓存时自动发现签名变化

后续 watcher 进来时，只需要继续调用同一个入口即可。

---

## 8. 验证结果

执行：

```powershell
npx mocha test\client\services\indexClient.test.js
npm test
git --no-pager diff --check
```

本轮提交前以上三项均通过。

---

## 9. 对总体计划的推进意义

做到这一步之后，Phase 3 的快照缓存已经不再只是“能复用”，而是开始具备最基本的**自动正确性保护**：

1. 同一工程重复扫描时可以复用
2. 工程内任意已跟踪文件变化时可以自动放弃旧快照
3. 手动失效与自动失效能共存

这使得下一步再接入：

1. 文件级 `FileScanResult` 复用
2. watcher 驱动失效
3. worker 后端执行

时，缓存边界已经更加稳定。

---

## 10. 一句话结论

**本轮完成了 Phase 3 的第二块关键基础：让 `indexClient` 在命中工程快照缓存前，能够基于 `snapshot.files` 的 `mtimeMs + size` 自动判断缓存是否过期，并已在真实 LS-DYNA 大文件工程中验证“子文件变更后无需手动 `invalidate()` 也会自动重建”。**
