# Codebase Documentation and JSDoc Annotation Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 `src/` 下的 22 个 JavaScript 源文件系统性地添加文件头部描述和标准 JSDoc/TSDoc 注释（使用英文）。

**架构：** 按模块分类，自底向上（从 parser 到 client/extension）逐步丰富各文件的注释，每一模块更改后运行测试套件（`npm test`）确保未引入任何语法错误，再进行 Git 提交。

**技术栈：** VS Code Extension, Node.js, JSDoc/TSDoc

---

## 任务列表

### 任务 1：核心解析器 (core/parser)
为 `blockScanner.js`, `includeScanner.js`, `keywordScanner.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/core/parser/blockScanner.js`
- 修改：`src/core/parser/includeScanner.js`
- 修改：`src/core/parser/keywordScanner.js`
- 测试：`test/core/blockScanner.test.js` (或运行 `npm test` 确认)

- [ ] **步骤 1：为 blockScanner.js 添加头部及 JSDoc**
  为 `collectBlocksFromLineReader` 和 `collectBlocksFromFile` 函数添加 JSDoc，描述入参、返回值和核心逻辑。
- [ ] **步骤 2：为 includeScanner.js 添加头部及 JSDoc**
  定义 `@typedef {Object} IncludeMatch` 类型，为 `findIncludeFileLines` 和 `getSearchPath` / `searchFileFromPaths` 添加详细类型注释。
- [ ] **步骤 3：为 keywordScanner.js 添加头部及 JSDoc**
  定义 `@typedef {Object} ParameterInfo`，为 `findParameterDefinitions`、`findParameterReferences` 等函数编写 JSDoc。
- [ ] **步骤 4：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 5：Commit**
  ```bash
  git add src/core/parser/
  git commit -m "docs: document core/parser modules with standard JSDoc"
  ```

---

### 任务 2：核心缓存 (core/cache)
为 `cacheManifestStore.js`, `diskSnapshotStore.js`, `snapshotSerializer.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/core/cache/cacheManifestStore.js`
- 修改：`src/core/cache/diskSnapshotStore.js`
- 修改：`src/core/cache/snapshotSerializer.js`

- [ ] **步骤 1：为 cacheManifestStore.js 添加头部和 JSDoc**
  为 `CacheManifestStore` 类的构造函数和各个方法（`load`, `save`, `update` 等）编写 JSDoc。
- [ ] **步骤 2：为 diskSnapshotStore.js 添加头部和 JSDoc**
  为 `DiskSnapshotStore` 类和其对文件的读写、LRU 淘汰算法编写注释。
- [ ] **步骤 3：为 snapshotSerializer.js 添加头部和 JSDoc**
  为 `serializeSnapshot` 和 `deserializeSnapshot` 编写输入输出 JSDoc。
- [ ] **步骤 4：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 5：Commit**
  ```bash
  git add src/core/cache/
  git commit -m "docs: document core/cache modules with standard JSDoc"
  ```

---

### 任务 3：增量解析 (core/incremental)
为 `blockIndex.js`, `fileInvalidation.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/core/incremental/blockIndex.js`
- 修改：`src/core/incremental/fileInvalidation.js`

- [ ] **步骤 1：为 blockIndex.js 添加头部和 JSDoc**
  为 `BlockIndex` 类的增量更新及范围平移（range shifting）方法编写 JSDoc，明确参数类型。
- [ ] **步骤 2：为 fileInvalidation.js 添加头部和 JSDoc**
  为文件变化失效检测辅助函数编写 JSDoc。
- [ ] **步骤 3：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 4：Commit**
  ```bash
  git add src/core/incremental/
  git commit -m "docs: document core/incremental modules with standard JSDoc"
  ```

---

### 任务 4：项目与依赖图 (core/project)
为 `projectGraph.js`, `projectIndexer.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/core/project/projectGraph.js`
- 修改：`src/core/project/projectIndexer.js`

- [ ] **步骤 1：为 projectGraph.js 添加头部和 JSDoc**
  定义 `@typedef {Object} ProjectSnapshot` 类型，为依赖图的关系变更和循环引用检测方法编写 JSDoc。
- [ ] **步骤 2：为 projectIndexer.js 添加头部和 JSDoc**
  为项目级文件扫描和快照生成的协调类 `ProjectIndexer` 编写 JSDoc。
- [ ] **步骤 3：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 4：Commit**
  ```bash
  git add src/core/project/
  git commit -m "docs: document core/project modules with standard JSDoc"
  ```

---

### 任务 5：手册索引器 (core/manualIndexer.js)
为 `manualIndexer.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/core/manualIndexer.js`

- [ ] **步骤 1：为 manualIndexer.js 添加头部和 JSDoc**
  为 PDF 提取、书签映射、SumatraPDF 精确行/页解析逻辑编写详细注释。
- [ ] **步骤 2：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 3：Commit**
  ```bash
  git add src/core/manualIndexer.js
  git commit -m "docs: document core/manualIndexer.js with standard JSDoc"
  ```

---

### 任务 6：语言服务端 (server)
为 `server.js`, `requestRouter.js`, `sessionManager.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/server/server.js`
- 修改：`src/server/requestRouter.js`
- 修改：`src/server/sessionManager.js`

- [ ] **步骤 1：为 server.js 添加头部和 JSDoc**
  为独立的 LSP 服务端连接初始化和生命周期编写注释。
- [ ] **步骤 2：为 requestRouter.js 添加头部和 JSDoc**
  为路由处理逻辑和分发方法编写 JSDoc。
- [ ] **步骤 3：为 sessionManager.js 添加头部和 JSDoc**
  为负责多用户、多会话和活动文档管理的 SessionManager 类编写 JSDoc。
- [ ] **步骤 4：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 5：Commit**
  ```bash
  git add src/server/
  git commit -m "docs: document server modules with standard JSDoc"
  ```

---

### 任务 7：多线程 Worker (worker)
为 `projectIndexLoader.js`, `scanWorker.js`, `workerPool.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/worker/projectIndexLoader.js`
- 修改：`src/worker/scanWorker.js`
- 修改：`src/worker/workerPool.js`

- [ ] **步骤 1：为 projectIndexLoader.js 添加头部和 JSDoc**
  为加载快照以及协调 worker 后台执行的方法编写 JSDoc。
- [ ] **步骤 2：为 scanWorker.js 添加头部和 JSDoc**
  为后台 worker 子进程的数据解析主循环和消息发送编写 JSDoc。
- [ ] **步骤 3：为 workerPool.js 添加头部和 JSDoc**
  为 `WorkerPool` 线程池的调度、生命周期管理、出错重试机制编写 JSDoc。
- [ ] **步骤 4：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 5：Commit**
  ```bash
  git add src/worker/
  git commit -m "docs: document worker modules with standard JSDoc"
  ```

---

### 任务 8：共享协议 (shared)
为 `protocol.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/shared/protocol.js`

- [ ] **步骤 1：为 protocol.js 添加头部和 JSDoc**
  为客户端与服务端消息交互协议中定义的常量和请求类型编写 JSDoc。
- [ ] **步骤 2：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 3：Commit**
  ```bash
  git add src/shared/protocol.js
  git commit -m "docs: document shared/protocol.js with standard JSDoc"
  ```

---

### 任务 9：视图与客户端 (client)
为 `includeTreeProvider.js`, `keywordIndexProvider.js`, `indexClient.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`
- 修改：`src/client/providers/keywordIndexProvider.js`
- 修改：`src/client/services/indexClient.js`

- [ ] **步骤 1：为 includeTreeProvider.js 添加头部和 JSDoc**
  定义 `@typedef` 以及视图节点数据结构，为 Include Tree 侧边栏的刷新、装饰和排序逻辑编写 JSDoc。
- [ ] **步骤 2：为 keywordIndexProvider.js 添加头部和 JSDoc**
  为 Keyword Index 侧边栏及折叠分组、大文件优化逻辑编写 JSDoc。
- [ ] **步骤 3：为 indexClient.js 添加头部和 JSDoc**
  为 LanguageClient 桥接服务的客户端调用接口编写 JSDoc。
- [ ] **步骤 4：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 5：Commit**
  ```bash
  git add src/client/
  git commit -m "docs: document client modules with JSDoc"
  ```

---

### 任务 10：主入口 (extension.js)
为 `extension.js` 添加文件头部和 JSDoc。

**文件：**
- 修改：`src/extension.js`

- [ ] **步骤 1：为 extension.js 添加头部和 JSDoc**
  为插件激活（`activate`）、停用（`deactivate`）函数以及 VS Code 命令注册、文档链接提供器等编写 JSDoc。
- [ ] **步骤 2：运行测试验证**
  运行 `npm test`，预期所有用例通过。
- [ ] **步骤 3：Commit**
  ```bash
  git add src/extension.js
  git commit -m "docs: document extension.js entry file with JSDoc"
  ```
