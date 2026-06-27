# Localization Copy Polish 实现计划

> **面向 AI 代理的工作者：** 使用现有 i18n 与 NLS 结构完成，不扩大到 README/CHANGELOG/脚本文案。

**目标：** 对插件运行时和 VS Code contribution 用户可见文案做中英双语审查与母语化润色，避免硬翻、夹生英文和过于抽象的提示。

**架构：** 保持 `src/core/i18n.ts` 作为运行时文案入口，保持 `package.nls*.json` 作为 VS Code 静态贡献入口。新增测试锁定高风险文案模式。

## 文件

- 修改：`src/core/i18n.ts`
- 修改：`package.nls.json`
- 修改：`package.nls.zh-cn.json`
- 修改：`test/extension.test.js`
- 修改：`test/projectContracts.test.js`

## 任务

- [x] 添加文案质量测试，覆盖中英文运行时文案和静态 NLS 的已知问题短语。
- [x] 润色运行时中英词条，包括手册配置、扫描进度、Hover、CodeLens、字段补全、跳转错误、诊断和引用关系文案。
- [x] 润色 `package.nls*.json` 中视图欢迎语、命令标题和配置说明。
- [x] 运行目标测试，确认测试先能捕捉旧文案、再通过新文案。
- [x] 运行 `npm test`、`npm run compile` 和残留短语扫描。
- [x] 提交改动并汇总结果。
