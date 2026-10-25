# Contributing / 参与贡献

[English](#english) · [中文](#中文)

---

## English

Thank you for your interest in contributing to DynaSense! We welcome bug fixes, documentation improvements, new keyword definitions, and feature contributions.

### Quick Start
1. Fork this repository and create a branch for your feature or fix.
2. Use Node.js 24 or newer. Install dependencies:
   ```bash
   npm ci
   python -m pip install -r requirements-dev.txt
   npm run build
   ```
3. Open in VS Code and press `F5` to launch the Extension Development Host.
4. Run tests to ensure everything passes:
   ```bash
   npm test
   ```
5. Submit a Pull Request with a clear description of your changes.

If F5 reports `Could not register service worker` and Webviews stay blank, open
the repository in an isolated VS Code process, then press F5 in that window:
`code --new-window --user-data-dir .vscode-test/debug-user-data .`
Run this command from the repository root. The fixed directory keeps debug
settings between launches without clearing your regular profile. Adding
`--user-data-dir` only to the extension-host launch arguments does not isolate
the built-in host's existing VS Code process.

---

## 中文

感谢对 DynaSense 的关注与支持！欢迎提交问题修复、文档改进、关键字卡片补充以及新功能贡献。

### 参与步骤
1. Fork 本仓库并基于最新分支创建您的功能分支。
2. 使用 Node.js 24 或更新版本，安装依赖并完成初次编译：
   ```bash
   npm ci
   python -m pip install -r requirements-dev.txt
   npm run build
   ```
3. 在 VS Code 中打开本仓库，按 `F5` 启动调试窗口即可进行实时测试。
4. 运行自动化测试以确保现有功能正常：
   ```bash
   npm test
   ```
5. 提交 Pull Request，简明说明您的修改内容及使用场景即可。

如果 F5 报 `Could not register service worker` 且 Webview 空白，请在仓库根目录运行
`code --new-window --user-data-dir .vscode-test/debug-user-data .`，在新开的开发窗口
中按 F5。固定目录会保留后续调试设置，不会清除日常配置。仅在扩展宿主的启动参数中
添加 `--user-data-dir`，不能隔离内置宿主所在的现有 VS Code 进程。

## Development and data / 开发与数据

See [public source checks](docs/public-source-boundary.md) for build and verification commands, and [keyword data](keywords/README.md) before changing generated data. Do not edit generated runtime data directly.

构建与验证命令见[公开源码检查](docs/public-source-boundary.md)；修改生成数据前阅读[关键字数据说明](keywords/README.md)，不要直接编辑生成的运行时数据。

## Platform packages / 平台安装包

Before packaging, run `npm run build:native-sqlite` on the target platform, then
`npm run package`. Windows x64 builds need MSVC with the matching Spectre libraries;
Linux and macOS need their native C++ build tools. The packaged driver is verified
against its platform, binary hash and locked npm integrity. End users only install
the matching VSIX; no compiler or SQLite installation is needed.

打包前，在目标平台运行 `npm run build:native-sqlite`，再运行 `npm run package`。
Windows x64 构建需要 MSVC 及对应的 Spectre 库；Linux 和 macOS 需要本机 C++ 构建工具。
打包流程校验驱动的平台、二进制摘要及 npm 锁文件完整性。用户只需安装对应平台的
VSIX，无需安装编译器或 SQLite。

## Legacy cache settings / 旧版缓存兼容设置

Retired cache settings are no longer registered in Settings. Existing explicit values
remain honored within their previous bounds; VS Code may label these old JSON keys
as unknown. New profiles use internal defaults. Configure the shared model-index
budgets with `lsdyna.cache.entityIndexMemoryMaxMiB` and `lsdyna.cache.entityIndexDiskMaxMiB`.

退出公开设置的缓存参数不再注册到设置界面。已有明确配置仍按原有上下限生效，
VS Code 可能将这些旧 JSON 键标记为未知。新用户使用内部默认值；模型索引的统一预算
使用 `lsdyna.cache.entityIndexMemoryMaxMiB` 和 `lsdyna.cache.entityIndexDiskMaxMiB`。

These legacy keys still affect separate caches. The model-index budgets are not a
one-to-one replacement. Removing an override restores the defaults below and can
increase resource use if your previous limit was lower. Keep intentional limits;
remove a key only when you accept its default, then reload the extension window.
Check user, workspace and workspace-folder settings before removing a value.

这些旧键仍控制各自的缓存，模型索引预算不能一一替代它们。删除已有值后会恢复下列
默认值；若原有限制更低，资源占用可能增加。请保留有意设置的限制，仅在接受默认值时
移除对应键，然后重新加载扩展所在窗口。移除前请检查用户、工作区及工作区文件夹设置。

| Legacy key / 旧键 | Default / 默认值 | Accepted range / 有效范围 |
| --- | --- | --- |
| `lsdyna.cache.memoryMaxMiB` | 48 MiB | 16–64 MiB |
| `lsdyna.cache.projectSnapshotDiskMaxMiB` | 256 MiB | 32–256 MiB |
| `lsdyna.cache.fileScanDiskMaxMiB` | 256 MiB | 32–256 MiB |
| `lsdyna.cache.fileScanMemoryMaxMiB` | 16 MiB | 4–16 MiB |
| `lsdyna.cache.maxAgeDays` | 30 days / 天 | 1–30 days / 天 |
