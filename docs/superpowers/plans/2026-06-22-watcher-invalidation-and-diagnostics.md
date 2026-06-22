# Watcher、失效传播与诊断生命周期实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 动态监听所有有效 LS-DYNA 扩展名，使缺失 Include 后续创建能刷新索引，并可靠清除旧诊断。

**架构：** watcher manager 管理扩展名和生命周期；manifest 用独立 `missingDependencyPaths` 做反向映射；诊断按项目根保存后合并发布。

**技术栈：** TypeScript、VS Code FileSystemWatcher/DiagnosticCollection、项目索引与缓存 manifest、Mocha

---

## 文件结构

- 创建：`src/client/services/workspaceWatcherManager.ts` 与对应测试。
- 修改：`src/core/project/projectGraph.ts`、`projectIndexer.ts` — 缺失候选路径。
- 修改：`src/core/cache/cacheManifestStore.ts`、`snapshotSerializer.ts` — manifest 新字段。
- 修改：`src/client/services/indexClient.ts`、`src/core/incremental/fileInvalidation.ts`。
- 创建：`src/client/services/projectDiagnosticStore.ts` 与对应测试。
- 修改：`src/extension.ts`、`test/extension.test.js`。

### 任务 1：动态 watcher manager

**文件：**
- 创建：`src/client/services/workspaceWatcherManager.ts`
- 创建：`test/client/services/workspaceWatcherManager.test.js`
- 修改：`src/extension.ts`

- [ ] **步骤 1：编写扩展名规范化和生命周期失败测试**

断言内置扩展始终存在；`['dat', '.DAT', '../bad', '.x*y']` 只新增 `.dat`；每个扩展创建一个 `**/*.ext` watcher；重建时新 watcher 先创建、旧 watcher 后 dispose；manager dispose 释放当前集合。

- [ ] **步骤 2：实现 manager API**

```typescript
function createWorkspaceWatcherManager({ createWatcher, onFileEvent, logWarning }) {
    return {
        rebuild(configuredExtensions: unknown[]): string[],
        dispose(): void,
    };
}
```

合法扩展正则为 `/^\.[a-z0-9][a-z0-9._-]*$/i`，显式禁止 `/`、`\\`、`*`、`?`、`[`、`]`、`{`、`}`。

- [ ] **步骤 3：替换固定 watcher**

`activate` 创建 manager，事件统一进入 `invalidateChangedProjectRoots`；`lsdyna.additionalExtensions` 变化时调用 `rebuild`；manager 加入 subscriptions。

- [ ] **步骤 4：运行测试并提交**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/services/workspaceWatcherManager.test.js test/extension.test.js --grep "watcher"`。

```powershell
git add src/client/services/workspaceWatcherManager.ts src/extension.ts test/client/services/workspaceWatcherManager.test.js test/extension.test.js
git commit -m "fix: rebuild workspace watchers from configured extensions"
```

### 任务 2：记录缺失 Include 候选路径

**文件：**
- 修改：`src/core/project/projectGraph.ts`
- 修改：`src/core/project/projectIndexer.ts`
- 修改：`test/core/project/projectIndexer.test.js`

- [ ] **步骤 1：编写候选路径失败测试**

根文件声明 `missing.key`，并配置两个搜索目录；断言 missing record 的 `candidatePaths` 按搜索顺序包含两个绝对路径并去重。

- [ ] **步骤 2：扩展异步解析结果**

`resolveIncludeFromSearchPathsAsync` 内部构建所有 `path.resolve(searchPath, fileName)` 候选；找到文件时返回 resolved path，找不到时向调用方提供候选列表。保持公开兼容函数返回字符串/null，新增内部 `resolveIncludeWithCandidatesAsync`。

- [ ] **步骤 3：写入 graph missing record**

`MissingFileRecord` 新增 `candidatePaths: string[]`，projectIndexer 在 `graph.addMissingFile` 时传入。

- [ ] **步骤 4：运行 projectIndexer 测试并提交**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/project/projectIndexer.test.js`。

```powershell
git add src/core/project/projectGraph.ts src/core/project/projectIndexer.ts test/core/project/projectIndexer.test.js
git commit -m "feat: track unresolved include candidate paths"
```

### 任务 3：manifest 传播缺失依赖并触发失效

**文件：**
- 修改：`src/core/cache/cacheManifestStore.ts`
- 修改：`src/core/cache/snapshotSerializer.ts`
- 修改：`src/client/services/indexClient.ts`
- 修改：`src/core/incremental/fileInvalidation.ts`
- 修改：对应 cache、indexClient、fileInvalidation 测试。

- [ ] **步骤 1：编写失败测试**

断言 manifest entry 保存 `missingDependencyPaths`；序列化往返保留字段；`findAffectedProjectRoots` 在新建路径匹配 missing dependency 时返回根项目；旧 manifest 缺字段时按空数组处理。

- [ ] **步骤 2：扩展 manifest entry**

```typescript
type ManifestEntry = {
    rootFile: string;
    trackedFiles: string[];
    missingDependencyPaths: string[];
    byteSize: number;
    lastAccessedAt: number;
};
```

`indexClient.touchSnapshotEntry` 从 `snapshot.missingFiles.flatMap(record => record.candidatePaths || [])` 生成去重列表。磁盘 cache 的签名仍只覆盖存在的 tracked files。

- [ ] **步骤 3：扩展失效匹配**

`findAffectedProjectRoots` 同时比较 `trackedFiles` 和 `missingDependencyPaths`。创建 missing 文件后，batched invalidator 必须失效并刷新根项目。

- [ ] **步骤 4：运行缓存与失效测试并提交**

运行：`npm run compile && npx mocha --require test/register-out.js test/core/cache/*.test.js test/core/incremental/fileInvalidation.test.js test/client/services/indexClient.test.js`。

```powershell
git add src/core/cache src/client/services/indexClient.ts src/core/incremental/fileInvalidation.ts test/core/cache test/core/incremental test/client/services/indexClient.test.js
git commit -m "fix: invalidate projects when missing includes appear"
```

### 任务 4：按项目根管理诊断生命周期

**文件：**
- 创建：`src/client/services/projectDiagnosticStore.ts`
- 创建：`test/client/services/projectDiagnosticStore.test.js`
- 修改：`src/extension.ts`
- 修改：`test/extension.test.js`

- [ ] **步骤 1：编写多根共享文件失败测试**

根 A、B 都对 shared.k 产生诊断；刷新 A 清空其诊断后，shared.k 仍保留 B 的诊断；刷新 B 清空后 collection.delete 被调用。根 A 删除旧 child 文件后，child 上旧诊断被删除。

- [ ] **步骤 2：实现 store**

```typescript
function createProjectDiagnosticStore(collection) {
    return {
        publish(rootFile: string, diagnosticsByUri: Map<string, any[]>): void,
        clear(rootFile: string): void,
        dispose(): void,
    };
}
```

内部保存 `Map<rootKey, Map<uriKey, Diagnostic[]>>`；每次 publish 对旧、新 URI 并集重算所有根的贡献。

- [ ] **步骤 3：拆分诊断生成与发布**

把 `publishProjectDiagnostics(snapshot, collection)` 改成纯生成 `collectProjectDiagnostics(snapshot)`，由 store 发布。保持 `_internals` 导出，更新现有测试。

- [ ] **步骤 4：运行测试并提交**

运行：`npm run compile && npx mocha --require test/register-out.js test/client/services/projectDiagnosticStore.test.js test/extension.test.js --grep "Diagnostic|diagnostic"`。

运行：`npm test`，预期全部通过。

```powershell
git add src/client/services/projectDiagnosticStore.ts src/extension.ts test/client/services/projectDiagnosticStore.test.js test/extension.test.js
git commit -m "fix: scope project diagnostics by root"
```
