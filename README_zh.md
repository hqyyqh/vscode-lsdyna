# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/extension-icon.png" width="120" height="120" alt="DynaSense 图标">
  <h3>面向 VS Code 的 LS-DYNA 关键字文件编辑器</h3>
  <p>为 CAE 与整车仿真工程师提供关键字和字段说明、引用文件树、定宽卡片编辑、本地手册与 PDF 跳转。</p>

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Available-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
[![Open VSX](https://img.shields.io/open-vsx/dt/hqyyqh/dynasense?label=Open%20VSX&logo=eclipse-ide)](https://open-vsx.org/extension/hqyyqh/dynasense)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

[English Version](README.md) | [中文说明](README_zh.md)

---

## 快速开始（大约一分钟）

1. **打开关键字文件** — 任意 `.k` / `.key` / `.dyna` 文件，主文件或引用文件均可。
2. **插入关键字** — 输入 `*`，从 4,700 多个关键字中选择，并插入对应的卡片格式。
3. **按列修改数据** — 在数据行用 `Tab` / `Shift+Tab` 按实际字段宽度跳转。字段保护默认开启：Delete 清空选中字段且后续字段不前移；经 Tab 选中后，输入只替换当前字段。
4. **看字段含义** — 鼠标悬停在关键字或字段上，查看说明、类型、宽度和默认值。
5. **查看整车引用关系** — 打开活动栏 **LS-DYNA** → **引用文件树**，从主文件扫描，浏览所有 `*INCLUDE`。
6. **配置手册（可选）** — 将 `lsdyna.manualsDir` 指向手册包根目录（见 [手册配置](#手册集成设置)），即可跳转 PDF 页码并使用内置手册阅读器。

> **功能预览**
>
> | 关键字补全 | 悬停说明 |
> | :---: | :---: |
> | ![关键字补全](./images/completion_keyword.gif) | ![悬停说明](./images/hover_hints.gif) |

---

## 日常能做什么

### 关键字卡片、列宽与排版

- **关键字数据**来自开源项目 [ansys/pydyna](https://github.com/ansys/pydyna)，覆盖 4,700 多个关键字。
- **代码片段**可插入已排好格式的关键字块，无需从空行开始手动搭建。
- **Tab 跳转**在 10 字符（部分 8 字符）字段间移动，可换行到下一数据行。
- **字段标题注释**：输入 `$` 或 `$#`，生成右对齐的字段名，且不保留行尾多余空格。
- **行注释**：按 `Ctrl+/` 在第 1 列切换 `$`，符合 LS-DYNA 对注释标记位置的要求。
- **格式化选区或全文**为标准定宽布局。实验性设置 `lsdyna.autoFormat` 可在光标离开当前行时自动格式化；默认关闭，因为它会自动改写卡片间距。

> **演示**
>
> | 关键字 | 引用文件路径 |
> | :---: | :---: |
> | ![关键字补全](./images/completion_keyword.gif) | ![引用文件补全](./images/completion_include.gif) |
> | **注释** | **Tab** |
> | ![注释补全](./images/completion_comment.gif) | ![Tab跳转和编辑](./images/tab_navigation.gif) |
> | **格式化** | |
> | ![自动格式化](./images/auto_format.gif) | |

### `*INCLUDE` 路径 — 浏览、补全与检查

整车模型通常拆分在多个目录中，例如 `mats/`、`assembly/` 和 `loadcases/`。插件会根据当前适用的**搜索根目录**解析引用路径，而不是只按文件名匹配。

**在 `*INCLUDE` 下补全路径（`*INCLUDE_PATH` 行不会走这套补全）：**

1. 光标放在 `*INCLUDE` 下面的**文件名行**。
2. 输入 `/` 或 `\`：按**搜索根目录**列出下一级目录和文件。搜索根目录包括当前关键字文件所在目录，以及本机实际存在的 `*INCLUDE_PATH` 和 `*INCLUDE_PATH_RELATIVE` 目录。
3. 在分隔符后继续输入（如 `/ma`）只过滤**当前层**；选中目录（以 `/` 结尾）后再输入 `/` 进入下一层。浏览结果始终目录优先，并按自然顺序排列（`1`、`2`、`10`）。
4. 也可以从不含路径分隔符的**裸文件名片段**开始输入（如 `LC_Front`）进行递归搜索；列表里会给出**完整相对路径**，避免两个不同目录下的 `mat.k` 分不清。
5. 选中后统一写入使用**正斜杠**的路径，例如 `loadcases/frontal/run.k`，便于在 Linux 求解环境中使用。

空的文件名行**不会**一次列出整个工程。可输入 `/` 开始浏览，或输入部分文件名进行搜索。日常操作**无需**按 `Ctrl+Space`。

**`*INCLUDE_PATH` 与整车习惯（祖先继承）**

- 常见做法是只在**主文件**或前置设置文件中声明 `*INCLUDE_PATH`，引用文件使用 `steel.k` 之类的短文件名，无需重复路径卡片。
- **从主文件扫描引用文件树**时，引用文件会继承祖先文件声明的搜索目录，因此无需重复路径卡片也能解析短文件名。
- 若**只打开某个引用文件**，且尚未从其主文件扫描，搜索根目录仅包括该文件所在目录及文件内的路径卡片。此时显示路径缺失，可能只是因为尚无主文件上下文，并不一定是路径写错。
- **从主文件扫描后**，文件跳转、路径状态、编辑器链接和 `*INCLUDE` 补全都会复用扫描时记录的继承搜索路径。
- 插件**不会**合并工作区中所有文件的 `*INCLUDE_PATH`，以免混入其他工况的目录，并将缺失文件误判为已解析。

**引用文件树与状态**

- 路径带有**下划线链接**：文件或目录已在本地找到，可以直接打开，不再额外显示成功勾选图标。
- 路径没有链接且末尾出现 **!**：当前本地搜索路径下找不到该文件（名称错误、PATH 不正确、文件只在服务器上或尚未同步）。
- **引用文件树**从主文件展示层级；同一材料文件被多个 `*INCLUDE` 引用时，树中可能出现多次。这表示文件被共用，本身并非循环引用。
- **循环引用**（A 包含 B、B 又包含 A，或更长的环）会在树上标出，并作为**错误**诊断，避免长作业跑到一半才发现。
- 悬停引用路径可预览文件**头部**，无需完整打开具有数百万行的网格文件。
- 引用路径超过 LS-DYNA 的三行、236 字符上限时会显示诊断，避免求解器静默截断。

**Windows 前处理 → Linux 求解**

在 Windows 上，即使关键字文件写的是 `sub/part.k`、磁盘路径实际是 `Sub/Part.k`，文件也常能打开；Linux 上的 LS-DYNA 通常要求大小写**完全一致**。`lsdyna.include.pathCaseCheck` 默认为 `crossPlatform`：本机仍可跳转，但会发出警告，并提供快速修复，将路径大小写改为与磁盘一致。提交 Linux 求解任务前，可改为 `strict` 进行强制检查。

### 手册、悬停与 PDF

- 悬停查看关键字/字段说明；配置手册包后可打开对应 **PDF 页**（依据书签）。
- **双语包**：包内有中文内容时可在阅读器中切换中英文；**纯英文包**：只有英文正文，**没有**中文切换是正常现象。
- **正文语言**取决于手册包是否提供中文内容，不只取决于 VS Code 界面语言。界面菜单等仍随插件语言设置。

### 参数、导航与“未知关键字”

- `*PARAMETER` 上方显示参数引用次数；支持可选后缀的关键字还可添加 `_TITLE` 等后缀。
- 悬停 `&参数名` 查看当前文档内解析值。
- `F2` 重命名参数；`Ctrl+Alt+Up` / `Down` 跳到上一个/下一个关键字。
- 支持 `.k`、`.key`、`.dyna`、`.cfile` 等的高亮与折叠。
- 内置关键字库可能落后于新版本求解器。确认关键字有效后，可通过悬停提示、快速修复或 DynaSense 快捷操作将其加入自定义有效列表，也可调低 `lsdyna.unknownKeywordSeverity`。

| 引用文件树 | 路径悬停 |
| :---: | :---: |
| ![引用树](./images/include_tree.gif) | ![包含文件操作](./images/open_include.png) |

![参数提示](./images/parameter_hints.png)

---

<a id="手册集成设置"></a>

## 手册配置（PDF + 内置阅读器）

由于安装包大小限制，PDF 手册**不会**包含在 `.vsix` 中。请将 `lsdyna.manualsDir` 指向**手册包根目录**：使用预构建包时，应选择包含 `manifest.json` 的目录；使用自备手册时，应选择存放 PDF 的目录，并可在 Windows 上同时放置 SumatraPDF。

### 方式 A — 预构建手册包（推荐）

手册包发布在项目 **[GitHub Releases](https://github.com/hqyyqh/vscode-lsdyna/releases)**。请优先使用**最新** Release 里的资源；旧文章里的 zip 名可能已更换。

| 包类型 | 常见目录名 | 内容 |
| --- | --- | --- |
| **双语** | `lsdyna-manual-pack-bilingual` | 中英文文档、中文搜索、句级译文悬停；有中文内容时显示语言切换 |
| **仅英文** | `lsdyna-manual-pack-en` | 英文文档与搜索，体积更小；**无**中文正文切换（属正常） |

**步骤**

1. 从最新 Release 下载对应 zip。
2. 解压到固定目录。
3. 在 VS Code 中，通过关键字悬停提示中的设置按钮、命令 **设置 LS-DYNA 手册目录**，或配置项 `lsdyna.manualsDir` 选择**解压后的包根目录**，即包含 `manifest.json` 的目录。
4. 运行 **LS-DYNA: 打开手册阅读器**，或从 LS-DYNA 活动栏的 **手册** 视图打开章节。

阅读器默认在关键字文件编辑器**旁边**分栏打开，不会覆盖正在修改的模型。

> **需要中文手册的用户：** 请安装 **双语包**。
> **只需英文手册：** 用 **en** 包即可。

若个别旧链接 404，请到最新 Release 列表重新下载。

### 方式 B — 自备 PDF

1. 从 [Ansys LS-DYNA 手册页](https://lsdyna.ansys.com/manuals-download/) 下载 PDF。
2. Windows 建议下载便携版 [SumatraPDF](https://www.sumatrapdfreader.org/free-pdf-reader)，将 `SumatraPDF.exe` 与 PDF 放在同一目录（或 `pdf/` 子目录）。
3. 将 `lsdyna.manualsDir` 指到该目录。

> **重要：** 页码跳转依赖 PDF **书签**。改文件名一般无妨；合并/编辑时去掉书签会导致无法精确定位。
> 没有 SumatraPDF 时可能用系统默认阅读器打开，但常常**忽略**页码。

---

## 常用设置（整车场景）

### 主题颜色

注释、关键字、数字、字符串、参数和路径等语法颜色通过标准 TextMate 作用域继承当前 VS Code 主题。编辑器链接、警告、文件树警告、列参考线和 Webview 也使用 VS Code 的语义主题颜色。DynaSense 只为会话变更标记以及必须生成具体 SVG/动画颜色的场景维护自定义调色板，并分别适配亮色、暗色、高对比度和高对比度亮色主题。

可以通过 `workbench.colorCustomizations` 覆盖概览标尺和缩略图中的变更标记颜色。标志边栏 SVG 使用对应的四主题回退色，因为 VS Code 不会把解析后的用户自定义颜色提供给 SVG 数据地址：

```json
{
  "workbench.colorCustomizations": {
    "lsdyna.changeMarks.unsaved": "#d18616",
    "lsdyna.changeMarks.saved": "#4caf50"
  }
}
```

| 设置项 | 默认 | 实际怎么用 |
| :--- | :--- | :--- |
| `lsdyna.manualsDir` | `"lsdyna_manual_pack"` | 手册包或 PDF 目录。解压后请改成真实包根（如 `…/lsdyna-manual-pack-bilingual`）。 |
| `lsdyna.include.pathCaseCheck` | `"crossPlatform"` | Windows 前处理时保持默认；提交 Linux 求解任务前，可用 `"strict"` 强制检查路径大小写。 |
| `lsdyna.customValidKeywords` | `["*END","*TITLE","*CASE_BEGIN","*CASE_END"]` | 厂内关键字或新版本求解器关键字，避免被报告为未知。末尾的 `*` 表示前缀匹配。 |
| `lsdyna.unknownKeywordSeverity` | `"error"` | 库滞后时可改为 `warning` / `hint` / `off`。 |
| `lsdyna.warnLowercaseKeyword` | `false` | 对小写关键字（如 `*node`）报警。LS-DYNA 大小写不敏感，仅在团队约定统一大写时开启。 |
| `lsdyna.enableTabNavigation` | `true` | Tab 跳字段；若要普通 Tab 空格则关掉。 |
| `lsdyna.enableCellEditProtect` | `true` | Delete/Backspace 使用空格清空选中字段。只有经 **Tab 选中字段后**，输入才会替换整个字段；`*` 和 `$` 始终按普通方式编辑。此设置不依赖 Tab 跳转。 |
| `lsdyna.enableFieldHover` | `true` | 鼠标停留在卡片字段上时显示说明。不希望改数时弹出说明可关闭，并从 DynaSense 快捷操作中重新开启。 |
| `lsdyna.changeMarks.enabled` | `true` | 在编辑器标志边栏显示会话变更：主题适配的琥珀色表示未保存，绿色表示打开文件后已保存；未保存状态还带有一个小圆点，因此不只依赖颜色区分。实心条表示修改，空心条表示新增，三角形表示附近有删除行。 |
| `lsdyna.changeMarks.maxLineCount` | `100000` | 超过此行数的文件不画标记（超大网格保护）。 |
| `lsdyna.changeMarks.debounceMs` | `250` | 输入后延迟多久再重算标记。 |
| `lsdyna.changeMarks.showOverviewRuler` | `true` | 同时在滚动条概览标尺上显示标记。 |
| `lsdyna.changeMarks.showLineBackground` | `true` | 标记行极淡**整行**底色；嫌花可关，只保留竖条。 |
| `lsdyna.changeMarks.showMinimap` | `true` | 在缩略图中显示橙色未保存标记和绿色已保存标记；修改、新增和删除的形状仍仅在标志边栏中区分。 |
| `lsdyna.scanner.fullScanLargeFiles` | `false` | 超大网格建议保持关闭（树/索引可能只扫首尾）。需要完整扫描且能接受变慢时再开。 |
| `lsdyna.hover.previewMaxLines` | `20` | 悬停引用路径时预览的最大行数。 |
| `lsdyna.language` | `"auto"` | 插件界面语言。手册**正文**是否有中文仍取决于手册包。 |
| `lsdyna.additionalExtensions` | `[".k",".key",".dyna",".asc"]` | 额外当作 LS-DYNA 的后缀。 |
| `lsdyna.autoFormat` | `"disabled"` | 光标离开当前行时自动格式化的实验性功能。除非接受自动改写卡片，否则保持关闭。 |
| `lsdyna.statusBar.level` | `"simple"` | 当前文件状态：`off`、`simple`（问题或关键字）或 `detail`（另加字段 `n/N` 和最近一次引用文件树扫描根目录）。单击可打开 LS-DYNA 快捷操作。 |
| `lsdyna.health.showFirstRunNotice` | `true` | 有未配置项时的一次性提示。 |
| `lsdyna.largeFile.enableRendering` | `true` | 极大文件可关以省内存。 |
| `lsdyna.codeLens.showOnAllKeywords` | `false` | 需要时在每个关键字上方显示“选中卡片”“格式化”等操作。 |
| `lsdyna.navigation.pulseOnJump` | `true` | 跳转后短暂高亮目标行。 |
| `lsdyna.ignoreFormattingKeywords` | `[]` | 不做格式化 / Tab / 注释工具的关键字。 |

> [!TIP]
> **未知关键字**
> 确认关键字有效后，可从悬停提示、快速修复、DynaSense 快捷操作或“加入当前文件的全部未知关键字”命令添加。自定义项只会关闭未知关键字诊断，不会添加字段定义。

> [!TIP]
> **自定义后缀图标**
> `"files.associations": { "*.my_ext": "lsdyna" }`，资源管理器图标与语言功能一并生效。

> [!TIP]
> **提交前短检查**
> 引用文件树中没有缺失路径 → 没有循环引用错误 → 目标为 Linux 时将 `pathCaseCheck` 设为 `strict` → 主文件中的 `*INCLUDE_PATH` 与提交目录一致。

---

## 鸣谢与贡献者

本项目由 [hqyyqh](https://github.com/hqyyqh) 在 LS-DYNA VS Code 生态上深度定制维护。

- **上游：** [osullivryan/vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) — 感谢 [osullivryan](https://github.com/osullivryan)、[DCHartlen](https://github.com/DCHartlen)、[maxiiss](https://github.com/maxiiss)、[yshl](https://github.com/yshl)。
- **关键字数据：** [ansys/pydyna](https://github.com/ansys/pydyna)。
- **亦受启发于：** [vim-lsdyna](https://github.com/gradzikb/vim-lsdyna) 及社区其它工具。

感谢所有为 LS-DYNA 编辑体验做出贡献的开发者。
