# JS 到 TypeScript 迁移计划报告

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将当前 VS Code LS-DYNA 扩展从纯 JavaScript 逐步迁移到 TypeScript，同时保持现有扩展行为、测试覆盖和发布包可用。

**架构：** 推荐采用“TypeScript 源码 + CommonJS 运行产物”的渐进式迁移。源码逐步从 `src/**/*.js` 转为 `src/**/*.ts`，编译输出放到 `out/`，`package.json` 的 `main` 最终指向 `./out/extension.js`，LSP Server 与 Worker 入口同步走编译产物。

**技术栈：** VS Code Extension、Node.js、CommonJS、TypeScript、Mocha、vscode-languageclient、vscode-languageserver、vsce。

---

## 0. 执行进度更新（2026-06-04）

本计划已在新分支 `codex/ts-migration` 启动实施，当前完成到 Phase 3 的首批低耦合核心模块迁移。

已完成内容：

- Phase 0：修复测试基线中暴露的 VS Code mock、配置读取、Extension Context、Tab 对齐、Keyword 扫描 yield、LSP notification mock 等问题。
- Phase 1-2：引入 TypeScript 编译链，新增 `tsconfig.json`，将扩展入口切换到 `./out/extension.js`，并让测试覆盖编译后的 `out/` 产物。
- Phase 3：已迁移 `src/shared/protocol.ts`、`src/core/keywordUtils.ts`、`src/core/parser/blockScanner.ts`、`src/core/parser/keywordScanner.ts`、`src/core/parser/includeScanner.ts`、`src/core/project/projectGraph.ts`、`src/core/cache/snapshotSerializer.ts`。
- 打包策略：`.vscodeignore` 排除源码和 sourcemap，保留 `out/`；`.gitignore` 忽略本地编译产物 `out/`。

已验证结果：

- `npm run compile` 通过。
- `npm test` 通过，结果为 `242 passing`。
- `npx @vscode/vsce package --no-git-tag-version --no-update-package-json` 通过，生成 `lsdyna-custom-2.0.7-hqyyqh.7.vsix`，包含 `out/` 产物。
- `npm audit --omit=dev` 结果为 `found 0 vulnerabilities`。

剩余注意事项：

- 完整 `npm audit` 仍报告 dev dependency 链上的 `mocha -> serialize-javascript` 漏洞：`2 vulnerabilities (1 moderate, 1 high)`；`npm audit fix --force` 会引入破坏性变更，当前未执行。
- 后续建议继续按 Phase 4 迁移缓存、项目索引与增量模块，并保持每批迁移后执行 `npm run compile`、`npm test`、VSIX 打包验证。

---

## 1. 结论先行

迁移到 TypeScript **可行，且值得做**。当前项目已经从早期大单文件状态演进出 `client/core/server/worker/shared` 分层，核心扫描、项目索引、缓存、增量更新、LSP 桥接和 Worker 边界都已拆出独立模块，这为 TS 类型建模提供了清晰入口。

但不建议一次性全量改为 TS。当前测试基线不干净，构建链路也没有编译步骤；如果直接批量改后缀，会把旧测试失败、路径变更、类型错误、打包配置问题混在一起。推荐路线是：

1. 先修复测试和本地 npm 基线。
2. 先引入 TS 编译链，但保持源码 JS 不变。
3. 先让扩展从 `out/` 运行，验证发布包结构。
4. 再按依赖方向逐层迁移源码。
5. 最后打开更严格的 TS 规则。

## 2. 当前项目现状

### 2.1 工程链路

- `package.json` 的扩展入口是 `./src/extension.js`。
- 当前脚本只有 `test: mocha test/**/*.test.js` 和 `package: vsce package`。
- 运行依赖只有 `vscode-languageclient`、`vscode-languageserver`。
- 开发依赖只有 `mocha`，没有 `typescript`、`@types/node`、`@types/vscode`、`@types/mocha`。
- `.vscode/launch.json` 的调试 `outFiles` 指向 `${workspaceFolder}/src/**/*.js`。
- `.vscodeignore` 尚未围绕 `out/` 产物设计，当前没有排除 `src/**/*.ts` 或明确包含编译产物的策略。
- CI 中 `master_ci.yaml` 使用 Node.js 20 并运行 `npm test`；`feature_ci.yaml` 目前只安装依赖，没有运行测试。

### 2.2 源码规模

当前 `src` 和 `test` 里共有约 51 个 JS 文件。规模最大的文件包括：

| 文件 | 行数约数 | 迁移风险 |
| --- | ---: | --- |
| `src/extension.js` | 2841 | 最高，入口、命令、Provider、Hover、Completion、测试导出集中在一起 |
| `test/extension.test.js` | 1865 | 高，依赖 `_internals` 和 `vscode` mock |
| `src/core/manualIndexer.js` | 563 | 中高，涉及 VS Code 配置、PDF 解析、缓存、文件 watcher |
| `src/client/providers/includeTreeProvider.js` | 556 | 中高，涉及 TreeView、路径归一化、快照加载 |
| `src/client/providers/keywordIndexProvider.js` | 516 | 中高，涉及递归扫描、局部刷新、异步 yield |
| `src/core/parser/includeScanner.js` | 487 | 中，纯逻辑较多，适合较早迁移 |
| `src/core/cache/diskSnapshotStore.js` | 475 | 中高，涉及序列化、文件系统和淘汰策略 |

### 2.3 模块边界

项目已经形成较好的分层：

- `src/shared/protocol.js`：LSP 自定义协议常量。
- `src/core/parser/*`：Include、Keyword、Block 扫描。
- `src/core/project/*`：项目图和项目索引。
- `src/core/cache/*`：内存/磁盘快照缓存和序列化。
- `src/core/incremental/*`：文件失效、块索引、图更新。
- `src/client/providers/*`：TreeView 和 Keyword Index UI Provider。
- `src/client/services/indexClient.js`：客户端快照缓存与 LSP/Worker 结果复用。
- `src/server/*`：LSP Server 会话和路由。
- `src/worker/*`：Worker Pool 和扫描 Worker。

这些边界非常适合分批迁移。尤其是 `shared`、`parser`、`project`、`cache` 可以先 TS 化，最后再处理 `extension.js`。

## 3. 测试与环境基线

### 3.1 已验证结果

在当前本地环境中，`npm test` 无法启动，原因是本地 `npm` shim 指向缺失路径：

```text
Cannot find module 'C:\Users\qyang\AppData\Roaming\npm\node_modules\npm\bin\npm-cli.js'
Node.js v22.16.0
```

绕过 npm 后，直接运行仓库内 Mocha：

```powershell
node .\node_modules\mocha\bin\mocha "test/**/*.test.js"
```

可以启动测试，但当前有大量失败。主要模式包括：

- `vscode.workspace.getConfiguration(...).get is not a function`
- 激活扩展时 `context.extensionPath` 缺失，导致 `path.join(context.extensionPath, ...)` 报错
- `createDiskSnapshotStore` 的 LRU 淘汰断言失败
- Keyword Index 大文件扫描 yield 次数断言失败
- Tab 对齐相关断言失败

### 3.2 对 TS 迁移的影响

这是迁移前的硬前置条件。必须先把现有 JS 基线修到可验证，否则迁移后无法判断失败来自旧问题还是 TS 引入的问题。

建议迁移前至少达到：

- `npm test` 可正常启动。
- 直接 Mocha 和 `npm test` 结果一致。
- 当前所有非 TS 相关测试通过，或形成明确的已知失败清单。
- `feature_ci.yaml` 补上测试步骤，避免非 master 分支无法提前暴露问题。

## 4. 推荐方案

### 4.1 推荐：渐进式 TS + CommonJS 输出

这是首选方案。

核心做法：

- 新增 `tsconfig.json`。
- 先启用 `allowJs: true`，让现有 JS 可以编译到 `out/`。
- `module` 使用 `commonjs`，避免 ESM 迁移和 VS Code Extension Host 加载方式叠加风险。
- `rootDir` 使用 `src`，`outDir` 使用 `out`。
- `package.json` 最终将 `main` 改为 `./out/extension.js`。
- LSP Server 和 Worker 保持相对 `__dirname` 查找，编译后自然指向 `out/server/server.js` 和 `out/worker/scanWorker.js`。
- 源码逐批重命名为 `.ts`，测试随迁移调整到编译产物或统一测试入口。

优点：

- 运行模型变化小，仍是 CommonJS。
- 不引入 bundler，发布包结构可读、可调试。
- 迁移失败时容易回退到上一批文件。
- 适配当前 `require(...)` 和 `module.exports` 生态。

代价：

- 前期要处理 `src` 到 `out` 的入口切换。
- 测试引用路径需要统一策略。
- `.vscodeignore`、调试配置、打包脚本必须同步改。

### 4.2 不推荐：一次性全量 TS 化

不建议一次性把 `src/**/*.js` 和 `test/**/*.js` 全部改为 TS。

原因：

- `src/extension.js` 太大，单次改动风险高。
- 测试基线当前不干净，无法定位迁移引入的问题。
- LSP、Worker、打包入口、测试 mock 会同时变化。
- 类型错误可能暴露大量真实边界问题，但一次性处理会失去优先级。

### 4.3 暂不推荐：直接引入 bundler

esbuild 或 webpack 能减少发布体积，但不是第一阶段必需项。

当前项目有以下路径敏感逻辑：

- `context.extensionPath`
- `context.globalStorageUri`
- `path.join(__dirname, 'server', 'server.js')`
- `path.join(__dirname, 'scanWorker.js')`
- PDF 手册目录、snippets、images、keywords JSON

第一阶段使用 `tsc` 保留目录结构更稳。等 TS 迁移稳定后，再评估是否需要 bundler。

## 5. 实施阶段

### Phase 0：迁移前基线修复

目标：让“现在的 JS 项目”自身可稳定验证。

- [ ] 修复本地 npm 启动问题，确保 `npm --version` 和 `npm test` 正常。
- [ ] 修复或隔离当前 Mocha 失败，重点是 `vscode` mock、`context.extensionPath`、LRU 淘汰和 yield 断言。
- [ ] 在 `feature_ci.yaml` 增加 `npm test`。
- [ ] 记录一份绿色基线：`npm test` 通过，`vsce package` 可生成 `.vsix`。

### Phase 1：引入 TypeScript 工具链，不改业务行为

目标：先让项目具备 TS 编译能力，但不急着改 `.ts`。

- [ ] 安装开发依赖：`typescript`、`@types/node`、`@types/vscode`、必要时加入 `@types/mocha`。
- [ ] 新增 `tsconfig.json`，初始建议：

```json
{
  "compilerOptions": {
    "target": "ES2019",
    "module": "commonjs",
    "rootDir": "src",
    "outDir": "out",
    "allowJs": true,
    "checkJs": false,
    "sourceMap": true,
    "strict": false,
    "noImplicitAny": false,
    "esModuleInterop": false,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node", "vscode"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "out", "test"]
}
```

- [ ] 修改 `package.json` 脚本：

```json
{
  "scripts": {
    "compile": "tsc -p .",
    "watch": "tsc -watch -p .",
    "test": "npm run compile && mocha test/**/*.test.js",
    "package": "npm run compile && vsce package"
  }
}
```

- [ ] 暂时保持 `main: ./src/extension.js`，先验证 `out/` 能完整生成。
- [ ] 验证命令：`npm run compile`、`npm test`。

### Phase 2：切换运行产物到 `out/`

目标：让 VS Code 和发布包运行编译产物，而不是源码目录。

- [ ] 将 `package.json` 的 `main` 改为 `./out/extension.js`。
- [ ] 将 `.vscode/launch.json` 的 `outFiles` 改为 `${workspaceFolder}/out/**/*.js`。
- [ ] 调整 `.vscodeignore`，建议排除 `src/**/*.ts`、`src/**/*.map`、`test`、`docs`，保留 `out/**`、`syntaxes/**`、`snippets/**`、必要图片、`package.nls*.json`、语言配置 JSON。
- [ ] 确认 `startLanguageServer()` 编译后仍能定位 `out/server/server.js`。
- [ ] 确认 `createProjectIndexLoader()` 编译后默认 `workerPath` 指向 `out/worker/scanWorker.js`。
- [ ] 增加最小 smoke test：编译后可以 `require('./out/extension')`，且 `activate`、`deactivate` 存在。
- [ ] 验证命令：`npm run compile`、`npm test`、`npx @vscode/vsce package --no-git-tag-version --no-update-package-json`。

### Phase 3：迁移低耦合核心模块

目标：优先迁移纯逻辑和低 VS Code 依赖文件。

建议顺序：

1. `src/shared/protocol.js` → `protocol.ts`
2. `src/core/keywordUtils.js` → `keywordUtils.ts`
3. `src/core/parser/blockScanner.js` → `blockScanner.ts`
4. `src/core/parser/keywordScanner.js` → `keywordScanner.ts`
5. `src/core/parser/includeScanner.js` → `includeScanner.ts`
6. `src/core/project/projectGraph.js` → `projectGraph.ts`
7. `src/core/cache/snapshotSerializer.js` → `snapshotSerializer.ts`

每迁移 1-2 个文件就运行：

```powershell
npm run compile
npm test
```

迁移原则：

- 使用 `export` 编译到 CommonJS，不急着改为 ESM。
- 先保留现有函数名和导出形状，确保 `require(...).functionName` 不破坏。
- DTO、扫描结果、ProjectGraph 节点优先补接口。
- 暂不追求 `strict: true`，先让边界清晰。

### Phase 4：迁移缓存、项目索引、增量模块

目标：把最有类型收益的数据结构模块迁移到 TS。

建议顺序：

1. `src/core/cache/cacheManifestStore.js`
2. `src/core/cache/fileScanCacheStore.js`
3. `src/core/cache/diskSnapshotStore.js`
4. `src/core/project/projectIndexer.js`
5. `src/core/incremental/fileInvalidation.js`
6. `src/core/incremental/blockIndex.js`
7. `src/core/incremental/graphUpdater.js`

重点类型：

- `FileSignature`
- `TrackedFileEntry`
- `ManifestEntry`
- `ProjectIndexResult`
- `IncludeEntry`
- `ScannedKeyword`
- `GraphTreeNode`
- `MissingFileRecord`
- `CycleRecord`

风险点：

- Map/Set 序列化与反序列化。
- Windows 路径大小写归一化。
- 磁盘缓存淘汰策略。
- async 并发限制器的泛型返回值。

### Phase 5：迁移 Worker 与 LSP Server 边界

目标：确保跨进程、跨线程消息类型明确。

建议顺序：

1. `src/worker/workerPool.js`
2. `src/worker/projectIndexLoader.js`
3. `src/worker/scanWorker.js`
4. `src/server/sessionManager.js`
5. `src/server/requestRouter.js`
6. `src/server/server.js`
7. `src/client/services/indexClient.js`

重点：

- 为 Worker message 定义 discriminated union。
- 为 LSP custom request params/result 定义接口。
- Worker 入口必须是编译后的 `.js` 文件。
- `worker_threads` 的 `workerData` 要显式建模。
- `LanguageClient` 的 serverModule 路径必须在 Extension Host 运行时正确。

### Phase 6：迁移 VS Code Client Provider 与 manualIndexer

目标：迁移 VS Code API 密集模块。

建议顺序：

1. `src/core/i18n.js`
2. `src/core/parser/keywordValidator.js`
3. `src/core/manualIndexer.js`
4. `src/client/providers/includeTreeProvider.js`
5. `src/client/providers/keywordIndexProvider.js`

重点：

- `vscode.Uri`、`TextDocument`、`TreeItem`、`CancellationToken` 等类型必须来自 `vscode`。
- 当前 tests 中的 `vscode-mock.js` 需要补齐类型或保持 JS mock。
- `manualIndexer` 的配置读取和文件 watcher 需要避免测试间污染。
- Provider 对 `loadProjectSnapshot` 的依赖应显式定义接口。

### Phase 7：迁移 `extension.js`

目标：最后处理主入口，避免早期把所有风险集中到最大文件。

建议：

- 先将 `extension.js` 重命名为 `extension.ts`，不做大重构。
- 保持 `_internals` 导出结构，避免测试大面积破裂。
- 给核心 Provider、Command、Hover、Completion、Diagnostics 函数补类型。
- 把 `activate(context)` 中的装配参数建模。
- 对 `context.extensionPath`、`context.globalStorageUri`、`workspaceState` 等测试 mock 依赖建立最小上下文工厂。

完成后再考虑是否继续拆分 `extension.ts`。不建议在本阶段同时进行大拆分。

### Phase 8：测试体系和严格模式

目标：让 TS 迁移变成长期维护收益，而不是只换后缀。

- [ ] 决定测试是否继续 JS，或迁移为 TS。
- [ ] 如果测试继续 JS，统一让测试覆盖编译后的 `out` 产物。
- [ ] 如果测试迁移 TS，引入 `ts-node/register` 或单独的测试 tsconfig；推荐仍测试编译产物，减少“测试运行方式”和“扩展运行方式”不一致。
- [ ] 逐步启用 `checkJs: true` 或 `strict: true`。
- [ ] 分阶段打开 `noImplicitAny`、`strictNullChecks`。
- [ ] 为 `src/core` 先开严格模式，再推广到 `client` 和 `extension`。

## 6. 主要风险

| 风险 | 严重度 | 表现 | 缓解措施 |
| --- | --- | --- | --- |
| 旧测试基线不干净 | 高 | 迁移后无法判断失败来源 | Phase 0 先修测试 |
| 本地 npm 损坏 | 高 | `npm test`、`npm install`、CI 模拟都不可用 | 先修 Node/npm 环境或固定使用可用 npm |
| `main` 切到 `out` 后资源路径错误 | 高 | 扩展能激活但找不到 server、worker、snippets、manuals | 使用 `context.extensionPath` 访问资源，`__dirname` 只用于编译产物内模块 |
| VS Code API 类型版本不匹配 | 中高 | `@types/vscode` 暴露比 `engines.vscode` 更新的 API | `@types/vscode` 版本与 `engines.vscode` 对齐，或明确升级 `engines.vscode` |
| CommonJS/ESM 混用 | 中高 | `require` 结果形状变化，测试和运行时导入失败 | 第一阶段固定 `module: commonjs` |
| Worker/LSP 编译入口错误 | 中高 | Worker 或 LSP Server 启动失败 | 单独增加 server/worker smoke test |
| 打包漏文件或多打源码 | 中 | `.vsix` 缺少 `out` 或包含无用 TS 源码 | 更新 `.vscodeignore` 并检查 `.vsix` 内容 |
| 类型收紧暴露大量隐性问题 | 中 | 大量 `any`、null、可选字段错误 | 先 `strict: false`，按模块收紧 |
| 测试 mock 与真实 VS Code API 偏离 | 中 | TS 后测试失败集中在 mock 类型/行为 | 抽 `test/createMockExtensionContext` 和配置 mock 工厂 |

## 7. 可能存在的问题

1. **`package.json` 中存在重复 `configurationDefaults` 键。** JSON 解析时后者会覆盖前者，TS 迁移不会解决这个问题，但编译/配置梳理时应顺手检查。
2. **`feature_ci.yaml` 目前没有跑测试。** 迁移 TS 后，如果只在 master 跑测试，会推迟发现构建错误。
3. **`package` 脚本使用 `vsce package`，但 `vsce` 不是 devDependency。** 建议固定 `@vscode/vsce`，或脚本改为 `npx @vscode/vsce package`。
4. **测试大量依赖 `_internals`。** 这对 TS 迁移是双刃剑：覆盖面高，但入口文件导出形状稍变就会造成大面积失败。
5. **当前 `vscode-mock.js` 是运行时 mock，不是类型 mock。** TS 后如果测试也转 TS，需要额外类型声明或保持测试为 JS。
6. **`src/extension.js` 过大。** 迁移时不要同时重构，否则会把行为变化和语言迁移混在一起。
7. **`engines.vscode` 仍是 `^1.50.0`。** 如果保持这个兼容范围，TS target 和 `@types/vscode` 版本要保守；如果升级兼容范围，需要作为独立产品决策处理。

## 8. 建议验收标准

每个迁移阶段都应满足：

- `npm run compile` 通过。
- `npm test` 通过。
- `node .\node_modules\mocha\bin\mocha "test/**/*.test.js"` 在本地可作为 npm 失效时的等价验证。
- VS Code Extension Development Host 可正常启动。
- Include Tree、Keyword Index、Hover、Completion、Manual 打开、LSP/Worker 索引至少做一次手动 smoke test。
- `npx @vscode/vsce package --no-git-tag-version --no-update-package-json` 可生成 `.vsix`。
- 检查 `.vsix` 内容：入口为 `out/extension.js`，包含 `out/server/server.js`、`out/worker/scanWorker.js`、语言配置、语法文件、snippets、必要图片和 NLS 文件。

## 9. 推荐时间预估

| 阶段 | 预估 |
| --- | ---: |
| Phase 0：测试与 npm 基线 | 0.5-1.5 天 |
| Phase 1-2：TS 工具链与 `out` 运行产物 | 1 天 |
| Phase 3：低耦合核心模块 | 1-2 天 |
| Phase 4：缓存、项目索引、增量模块 | 1.5-3 天 |
| Phase 5：Worker 与 LSP Server | 1-2 天 |
| Phase 6：Provider 与 manualIndexer | 1-2 天 |
| Phase 7：主入口 `extension.ts` | 2-4 天 |
| Phase 8：测试体系与严格模式 | 1-3 天 |

总计约 8-16 个工作日。若只做到“可编译、可发布、核心模块 TS 化”，约 4-7 个工作日可完成；若追求严格类型和测试体系同步完善，需要更长时间。

## 10. 最终建议

建议启动 TS 迁移，但不要把它做成一次性大重写。最稳妥的路线是：

1. **先修基线。** 当前测试和 npm 环境问题必须先处理。
2. **先切编译产物。** 让项目先从 `out/` 运行，建立 TS 工程骨架。
3. **从纯逻辑模块开始。** `shared`、`parser`、`project`、`cache` 的收益最高、风险较低。
4. **中期处理跨进程边界。** Worker 和 LSP 类型化后，项目维护收益会明显提升。
5. **最后迁移主入口。** `extension.js` 是最大风险点，应在前面模块稳定后再处理。
6. **严格模式分阶段打开。** 一开始追求 `strict: true` 会拖慢迁移；先迁移，再收紧。

总体判断：**可行性高，工程收益明确，主要风险来自测试基线、入口路径、打包产物和 VS Code API 版本。** 按上述阶段推进，风险可控。
