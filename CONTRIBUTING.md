# Contributing / 参与贡献

Code, documentation, translations, engineering rules and regression fixtures are
open to contributions. Read [DEVELOPMENT.md](DEVELOPMENT.md) and its mandatory
language acceptance requirements before starting. Report private security or
conduct concerns using [SECURITY.md](SECURITY.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

欢迎贡献代码、文档、翻译、工程规则和回归测试样例。开始前请阅读
[DEVELOPMENT.md](DEVELOPMENT.md)，并遵守其中的“信达雅”语言验收要求。
私密安全或行为报告请使用 [SECURITY.md](SECURITY.md) 和
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 中的渠道。

## Start / 开始

Use Node.js 22 and Python 3.12 or newer. Fork the public repository, create a branch
from public `dev`, and install the locked dependencies:

使用 Node.js 22 和 Python 3.12 或更新版本。Fork 公开仓库，从公开 `dev`
创建贡献分支，然后按锁文件安装依赖：

```bash
npm ci
python -m pip install -r requirements-dev.txt
npm run build
```

Open the folder in VS Code and press F5 using “DynaSense: Extension Development Host”.
The pre-launch task builds the extension and all four Webviews. F5 runs a development
checkout; package acceptance separately installs and verifies the actual VSIX.

在 VS Code 中打开目录，选择“DynaSense: Extension Development Host”后按 F5。
启动前任务会构建扩展和全部四个 Webview。F5 调试开发源码；包验收另外安装并核验
真实 VSIX。

## Code and data / 代码与数据

Keep changes focused and add a regression fixture or behavior test when appropriate.
Ordinary fixtures and localization source files can be edited. Engineering data
follows the public workflow in [DATA_REGENERATION.md](DATA_REGENERATION.md): edit
`keywords/authoring/`, run `npm run data:update`, then `npm run data:check`. Submit the authoring
inputs and generated runtime changes together. An original source snapshot update
must preserve the previous version and explain its actual origin and redistribution
permission. A local correction is not a new native-source certification.

保持变更聚焦，在适用时添加回归样例或行为测试。普通测试样例和本地化源码可编辑。
工程数据遵循 [DATA_REGENERATION.md](DATA_REGENERATION.md) 中的公开流程：
编辑 `keywords/authoring/`，运行 `npm run data:update`，再运行 `npm run data:check`，
同时提交作者输入和生成的运行时变更。更新原始来源快照时，必须保留旧版本，并说明
真实出处及再分发许可。本地修正不构成新的原生来源认证。

Engineering layout, type, relation and editing-permission changes require an
independently reviewed source version before the build can accept them. Keep the
previous approved checkpoint; ordinary translation and help changes do not refresh
that approval. See the protected engineering-input rules in DATA_REGENERATION.md.

工程布局、类型、关联及编辑权限的变更须先完成独立来源版本审查，构建才能接受。
保留先前已审批检查点；普通翻译和帮助修改不会刷新该审批。具体规则见
DATA_REGENERATION.md 中受保护工程输入的说明。

After adding, removing, or changing public files, refresh the inventory only after
data checks pass:

增加、删除或修改公开文件后，先通过数据检查，再刷新文件清单：

```bash
npm run update:source-manifest -- --write
npm run update:source-manifest -- --check
npm run check:contracts
npm test
npm run test:webview
python -m unittest discover -s test/scripts/build/keywords -p "test_*.py" -v
npm run check:field-data-zh
npm run check:native-help-zh
npm run check:manual-semantics-zh
npm audit
npm run check:package-contents
```

In Windows PowerShell, use `npm.cmd` when forwarding CLI options, for example:

```powershell
npm.cmd run update:source-manifest -- --write
npm.cmd run update:source-manifest -- --check
```

在 Windows PowerShell 中，传递 CLI 选项时请使用 `npm.cmd`，例如上述清单命令，确保 `--write` 和 `--check` 传到实际工具。

The manifest records current bytes and file roles. Refreshing it does not authorize
changes to upstream provenance, authority locks, or historical acceptance evidence.
See the CI workflow for the installed-package matrix. Missing UI/host environments
must be recorded as unverified, not passed. Automated translation checks do not
replace actual English and Chinese UI review.

清单记录当前文件字节和职责。刷新清单不授权改写上游来源记录、权威锁或历史验收证据。
真实安装包的宿主矩阵见 CI 工作流。缺少界面或宿主环境时应记录“未验证”，不能记作通过。
自动翻译检查不能代替中英文实际界面审查。

## Pull requests / 拉取请求

Target public `dev`. Explain the problem, resulting behavior, data lineage changes,
and commands actually run. Use synthetic examples without licensed manuals,
customer decks or private paths. Public CI checks the same candidate VSIX on three
operating systems and both supported matrix versions. Maintainer review is required;
opening a pull request does not authorize a release, tag, or merge to `master`.

向公开 `dev` 提交拉取请求，说明问题、修改后的行为、来源记录变更和实际执行的命令。
使用合成示例，不提交受许可约束的手册、客户模型或私密路径。公开 CI 在三个操作系统
和两个矩阵版本上检查同一份候选 VSIX。合并需要维护者审查；创建拉取请求不授权发布、
打标签或合并到 `master`。

