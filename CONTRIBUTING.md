# Contributing / 参与贡献

[English](#english) · [中文](#中文)

---

## English

Thank you for your interest in contributing to DynaSense! We welcome bug fixes, documentation improvements, new keyword definitions, and feature contributions.

### Quick Start
1. Fork this repository and create a branch for your feature or fix.
2. Use Node.js 22 or newer. Install dependencies:
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

---

## 中文

感谢对 DynaSense 的关注与支持！欢迎提交问题修复、文档改进、关键字卡片补充以及新功能贡献。

### 参与步骤
1. Fork 本仓库并基于最新分支创建您的功能分支。
2. 使用 Node.js 22 或更新版本，安装依赖并完成初次编译：
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
