# vscode-lsdyna 大文件方案执行记录（Phase 5：workspace watcher 驱动缓存失效）

## 1. 当前进度定位

到本轮开始时，Phase 3 的缓存主干已经基本完成：

1. 项目快照缓存
2. 自动/手动失效
3. 单文件扫描复用
4. LRU 逐出
5. cache manifest store

但总体计划里的下一大块 —— **“文件系统变更可自动使缓存失效”** —— 还没有落地。

也就是说，即使当前缓存已经能自动校验工程文件是否变化，扩展层仍然没有一个**工作区文件变化入口**，去在文件发生 create/change/delete 时主动让受影响工程根失效。

因此本轮推进两件事：

1. 新增纯函数模块，负责把“变化文件”映射到“受影响工程根”
2. 在 `activate()` 里接入 `workspace.createFileSystemWatcher(...)`

---

## 2. 本轮目标

本轮只做第一版、企业级稳健优先的 watcher 失效路径：

1. 新增 `src/core/incremental/fileInvalidation.js`
2. 提供：
   - `findAffectedProjectRoots(changedFilePath, manifestEntries)`
3. 新增扩展层辅助：
   - `createManifestDrivenInvalidator({ indexClient, findAffectedRoots })`
4. 在 `activate()` 中注册：
   - `**/*.{k,key,dyna}` watcher
5. watcher 在以下事件触发时使受影响根缓存失效：
   - change
   - create
   - delete

本轮**不做**：

- 自动重扫并刷新 UI
- watcher debounce / 批处理
- 文档内实时编辑增量
- worker 后台刷新

---

## 3. 设计选择

## 3.1 先“失效”，不直接“自动重建”

本轮 watcher 收到文件变化后，只做一件事：

> 找到受影响工程根并调用 `indexClient.invalidate(rootFile)`

而不立即：

- 重建项目快照
- 刷新 Include Tree
- 刷新 Keyword Index

原因是当前阶段先保证**缓存正确性**更重要：

1. 文件变了，旧缓存不能继续被命中
2. 至于何时重建，可以继续由用户触发扫描或后续 worker/watcher 批处理机制决定

这样更稳健，也避免把 Phase 5 一次性做得过重。

## 3.2 用 manifest 做“变化文件 -> 工程根”反查

既然上一轮已经把 `cacheManifestStore` 建成了正式边界，本轮就直接复用 manifest：

1. watcher 拿到变化文件路径
2. `indexClient.getManifestEntries()` 提供当前工程清单
3. `findAffectedProjectRoots(...)` 根据 `trackedFiles` 找出所有受影响根
4. 对这些根逐个 `invalidate()`

这让 watcher 不需要自己维护反向依赖表，逻辑更聚焦，也更容易测试。

---

## 4. TDD 过程

### 4.1 先写失败测试

本轮先新增三组约束：

#### A. `test/core/incremental/fileInvalidation.test.js`

验证：

1. 同一个变化文件可匹配多个工程根
2. Windows 风格路径别名 / 大小写差异能够正确归一化命中

#### B. `test/extension.test.js`

验证：

1. `activate()` 必须注册 `**/*.{k,key,dyna}` watcher
2. `createManifestDrivenInvalidator(...)` 必须对受影响根逐个 `invalidate()`
3. 未被 manifest 跟踪的文件变化必须被忽略

先执行聚焦测试：

```powershell
npx mocha test\core\incremental\fileInvalidation.test.js test\extension.test.js --grep "findAffectedProjectRoots|workspace watcher|createManifestDrivenInvalidator"
```

结果先红，失败原因符合预期：

- `fileInvalidation` 模块不存在
- `createManifestDrivenInvalidator` 不存在
- `activate()` 还没有注册 watcher

### 4.2 再写最小实现

本轮实现顺序：

1. 新增 `src/core/incremental/fileInvalidation.js`
2. 新增 `findAffectedProjectRoots(...)`
3. 给 `indexClient` 增加：
   - `getManifestEntries()`
4. 在 `src/extension.js` 中新增：
   - `createManifestDrivenInvalidator(...)`
5. 在 `activate()` 中注册 workspace watcher，并把 change/create/delete 都接到该 invalidator

### 4.3 验证转绿

聚焦测试转绿后，再跑全量测试，确保 watcher 接线没有破坏现有激活、快照、provider 等路径。

---

## 5. 实际代码改动

## 5.1 `src/core/incremental/fileInvalidation.js`

本轮新增了第一版文件失效辅助模块。

职责非常明确：

1. 输入：变化文件路径 + 当前 manifest 条目
2. 输出：受影响工程根列表

模块内部做了：

- 路径规范化
- Windows 下大小写归一化
- 重复根去重

## 5.2 `src/client/services/indexClient.js`

新增：

- `getManifestEntries()`

使扩展层可以读取当前 manifest 条目，而不用直接依赖 manifest store 内部实现。

## 5.3 `src/extension.js`

新增：

- `createManifestDrivenInvalidator(...)`

并在 `activate()` 中正式注册：

- `workspace.createFileSystemWatcher('**/*.{k,key,dyna}')`

让工作区文件变化能够自动把相关工程缓存置为失效状态。

## 5.4 测试桩

`test/vscode-mock.js` 补了最小 watcher mock，避免激活路径在测试环境下缺失 API。

---

## 6. 设计取舍

## 6.1 先支持多根失效，而不是只失效当前活动工程

同一个子文件可能被多个工程根复用。因此本轮设计不是“只失效活动文档对应工程”，而是：

- manifest 中凡是跟踪了该文件的根，全部失效

这更符合企业级稳健性，也能避免交叉工程污染缓存。

## 6.2 先让 watcher 成为缓存边界的一部分

本轮 watcher 只做缓存边界治理，不直接触发 UI 行为变化。这样后续要加：

- debounce
- batching
- worker refresh

都可以在现有边界上逐步演进。

---

## 7. 验证结果

执行：

```powershell
npx mocha test\core\incremental\fileInvalidation.test.js test\extension.test.js --grep "findAffectedProjectRoots|workspace watcher|createManifestDrivenInvalidator"
npm test
git --no-pager diff --check
```

本轮提交前以上检查均通过。

另外，使用用户提供的真实工程：

- 根文件：`D:\temp\LSDYNA\2020-nissan-rogue-v3\combine.key`
- 变化文件：`D:\temp\LSDYNA\2020-nissan-rogue-v3\wall.key`

在真实 manifest 上执行：

```json
{
  "affectedRoots": [
    "D:\\temp\\LSDYNA\\2020-nissan-rogue-v3\\combine.key"
  ]
}
```

说明 watcher 失效链路在真实样本上已经能够把子文件变化正确反查回主工程根。

---

## 8. 对总体计划的推进意义

做到这一步后，缓存层已经不只是“等下次访问时才发现过期”，而是开始具备：

1. **工作区文件变化入口**
2. **基于 manifest 的受影响工程根反查**
3. **主动失效路径**

这意味着总体计划里的：

> 文件系统变更可自动使缓存失效

已经开始进入可运行状态。后续下一层更自然的能力就是：

1. watcher debounce / batching
2. 自动后台重建
3. worker / server 侧调度

---

## 9. 一句话结论

**本轮把工作区文件 watcher 正式接到了缓存失效链路上：文件一旦发生 create/change/delete，扩展就能基于 manifest 找到受影响工程根并主动使其快照缓存失效。**
