# 高性能扫描与索引架构验证记录

**日期：** 2026-06-23

## 验证范围

本记录只覆盖“高性能扫描与索引架构”本身，不包含新增业务功能。验证目标是确认 LS-DYNA 输入文件的关键字扫描、关键字块索引、include 解析、项目快照缓存和大文件编辑器消费路径已经统一到一次 skeleton 扫描产物，并确认旧的大文件头尾抽样扫描不再位于索引主路径。

## 架构证据矩阵

| # | 架构要求 | 修改证据 | 自动化证据 | 已执行验证 | 结果 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 文件级扫描先产出轻量 keyword skeleton | `src/core/scanner/keywordSkeletonScanner.ts`、`src/core/scanner/scannerContracts.ts` | `test/core/scanner/keywordSkeletonScanner.test.js` | `npm test` | 通过；支持缩进、大小写、CRLF、chunk 边界和 EOF 无换行 |
| 2 | keyword block 按字节范围延迟读取 | `src/core/scanner/blockReader.ts` | `test/core/scanner/blockReader.test.js` | `npm test` | 通过；只读取指定 LS-DYNA 关键字块范围 |
| 3 | FileIndex 一次扫描同时服务关键字与 include | `src/core/scanner/fileIndexBuilder.ts` | `test/core/scanner/fileIndexBuilder.test.js`、`test/core/project/projectIndexer.test.js` | `npm test` | 通过；项目索引每个文件只加载一次 FileIndex |
| 4 | 旧 keyword/block/include 文件扫描 API 兼容但不再头尾抽样 | `src/core/parser/keywordScanner.ts`、`src/core/parser/blockScanner.ts`、`src/core/parser/includeScanner.ts` | `test/core/parser/keywordScanner.test.js`、`blockScanner.test.js`、`includeScanner.test.js` | `npm test` | 通过；大文件中部关键字和中部 `*INCLUDE` 均不漏扫 |
| 5 | Project snapshot 携带并序列化 fileIndexes | `src/core/cache/snapshotSerializer.ts`、`src/core/project/projectIndexer.ts` | `test/core/cache/snapshotSerializer.test.js` | `npm test` | 通过；`fileIndexes` 可 JSON 往返并恢复为 `Map` |
| 6 | File scan cache 对 scanner version 失效 | `src/core/cache/fileScanCacheStore.ts` | `test/core/cache/fileScanCacheStore.test.js` | `npm test` | 通过；旧 scanner version 缓存会返回 null |
| 7 | LSP/worker 和客户端保留扫描选项传递 | `src/client/services/indexClient.ts`、`src/server/sessionManager.ts` | `test/server/lspBridge.test.js` | `npm test` | 通过；LSP 模式发送 `{ rootFile, options }` |
| 8 | 大文件 folding/symbols 消费 FileIndex 而非 VS Code 文档逐行扫描 | `src/extension.ts` | `test/extension.test.js` | `npm test` | 通过；测试中 provider 不调用 `lineAt` 仍能产出 folding/symbol |
| 9 | 10MB 生成 deck 扫描性能有基础门禁 | `test/core/scanner/scannerBenchmark.test.js`、`package.json` | `npm run test:scanner-benchmark` | `npm run test:scanner-benchmark` | 通过；10MB deck skeleton 扫描 1557ms |

## 当前验证结果

- `npm test`：退出码 0，341 项通过。
- `npm run test:scanner-benchmark`：退出码 0，1 项通过；10MB 生成 deck skeleton 扫描耗时 1557ms。
- `rg -n "locateTailWindow|fullScanLargeFiles|start: 0, end: 1024 \* 1024|1000\)" src test`：旧头尾抽样扫描不再出现在 `keywordScanner`、`blockScanner`、`includeScanner` 或项目索引主路径中。
- 上述搜索的剩余匹配仅为：`fullScanLargeFiles` 兼容配置/参数传递、防回归测试、独立 `tailLineLocator` 模块及其测试、以及 `manualIndexer` 中无关的 UI 延时。

## LS-DYNA 语法关注点

- Keyword 识别只接受行首空白后的 `*`，跳过 `$` 注释行，符合 LS-DYNA keyword deck 的基本块边界规则。
- `*INCLUDE`、`*INCLUDE_PATH`、`*INCLUDE_PATH_RELATIVE` 的文件名/路径卡仍由原 include 状态机解析，保留续行、注释跳过、相对路径解析和多文件卡语义。
- 大文件中部 `*INCLUDE` 防回归测试使用真实关键字块结构：`*INCLUDE` 文件名卡之后进入 `*NODE`，避免把后续数值卡错误构造成同一个 include 块。
