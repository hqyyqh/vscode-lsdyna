# 风险分级技术债治理验证记录

**日期：** 2026-06-22

## 需求证据矩阵

| # | 治理要求 | 修改证据 | 自动化证据 | 已执行验证 | 结果 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 配置、NLS、命令与激活契约 | `package.json`、两份 README、`scripts/validate-project-contracts.cjs` | `test/projectContracts.test.js` | `npm run check:contracts` | 通过 |
| 2 | 损坏文档可追溯恢复 | `scripts/recover-superpowers-docs.cjs`、`docs/superpowers/archive/README.md` | `test/recoverSuperpowersDocs.test.js` | `npm test` | 61/61 恢复，0 份原始字节归档 |
| 3 | 关键字识别语义统一 | `src/core/parser/keywordLine.ts` 及四类扫描/编辑器调用方 | `test/core/parser/keywordLine.test.js`、scanner 与参数/导航测试 | `npm test` | 通过 |
| 4 | 大文件尾部使用真实行号 | `src/core/parser/tailLineLocator.ts` | `test/core/parser/tailLineLocator.test.js` | `npm test` | 通过；无虚拟行号 |
| 5 | Include 三行/236 字符上限 | `src/extension.ts` | `advanced_features.test.js` 的 80/81/156/157/236/237 边界测试 | `npm test` | 通过 |
| 6 | watcher 动态扩展与生命周期 | `src/client/services/workspaceWatcherManager.ts` | `workspaceWatcherManager.test.js`、激活测试 | `npm test` | 通过 |
| 7 | 缺失 Include 创建后触发失效 | project graph/indexer、manifest、invalidation | projectIndexer、cache、fileInvalidation、indexClient 测试 | `npm test` | 通过 |
| 8 | 多根项目诊断合并与清理 | `src/client/services/projectDiagnosticStore.ts` | `projectDiagnosticStore.test.js`、`updateDocumentDiagnostics` 测试 | `npm test` | 通过 |
| 9 | Windows 外部调用不经过 shell | `src/platform/externalProcess.ts`、资源定位命令 | `externalProcess.test.js`、特殊字符路径与 reveal 命令测试 | `npm test` | `shell: false`，fallback 最多一次 |
| 10 | CI 与交付门禁 | `.github/workflows/ci.yml`、`CHANGELOG.md` | 契约测试与完整测试套件 | `npm test`、`npm run check:contracts` | 330 项测试通过；契约通过 |

## 当前验证结果

- `npm run compile`：退出码 0。
- `npm test`：退出码 0，330 项通过。
- `npm run check:contracts`：退出码 0。
- `npm audit --omit=dev`：退出码 0，`found 0 vulnerabilities`。
- `npx --no-install vsce package --out dist/technical-debt-verification.vsix`：退出码 0；产物 8,011,830 字节，共 353 个文件。
- 禁止模式搜索：`9999999`、`child_process.exec`、`cmd.exe`、`explorer.exe` 在 `src` 中均无匹配。
- 完成标准搜索：`9999999`、`child_process.exec`、`lsdyna.format.enableOnSave`、`lsdyna.index.enableIncludeTree` 在 `src`、`test`、两份 README 和 `package.json` 中均无匹配。
