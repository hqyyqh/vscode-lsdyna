# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/extension-icon.png" width="120" height="120" alt="DynaSense 图标">
  <h3>VS Code 平台功能丰富的 LS-DYNA 工程模型编辑器</h3>
  <p>为 CAE 工程师打造：包含智能补全、大文件预览、以及代码自动对齐等功能。</p>

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Available-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
[![Open VSX](https://img.shields.io/open-vsx/dt/hqyyqh/dynasense?label=Open%20VSX&logo=eclipse-ide)](https://open-vsx.org/extension/hqyyqh/dynasense)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

[English Version](README.md) | [中文说明](README_zh.md)

---

## 🚀 快速开始 (30秒上手)

1. **唤醒智能**：打开任意 `.k` 或 `.key` 文件，输入 `*` 即可立即体验 3100+ 关键字智能补全。
2. **列宽对齐**：在数据行按下 `Tab` 键，光标将自动在 10 字符列宽间精准跳跃。
3. **查看释义**：将鼠标悬停在任意关键字或字段上，即可查看详细说明和默认值。
4. **配置手册**：点击悬停卡片右上角的 ⚙️ 齿轮（或查看底部状态栏的 DynaSense 仪表盘），一键关联本地 LS-DYNA PDF 手册，实现精准跳转。

> **功能预览：**
> 
> | 💡 唤醒智能 | 📖 查看释义 |
> | :---: | :---: |
> | ![Keyword Completion](./images/completion_keyword.gif) | ![Hover Hints](./images/hover_hints.gif) |

---

## 🌟 核心特性 (Core Features)

<details open>
<summary><b>📖 LS-DYNA 手册集成与交互式查询</b> (点击展开/折叠)</summary>
<br>

- **交互式悬停卡片**：关键字和字段的 Hover 提示卡片内提供了直达 LS-DYNA PDF 手册对应页码的链接。
- **快速检索**：基于高性能二进制 PDF 书签引擎实现解析与检索。
- **字段级提示**：悬停卡片内包含当前关键字的说明，以及每个特定字段的类型、长度及默认值。

![悬浮提示](./images/hover_hints.gif)

</details>

<details open>
<summary><b>⚡ 智能补全与排版</b> (点击展开/折叠)</summary>
<br>

- **关键字覆盖**：数据提取自官方 [ansys/pydyna](https://github.com/ansys/pydyna) 数据库，支持超过 **3100+** 个关键字。
- **关键字快速补全**：提供丰富的带格式代码片段 Snippets 模板补全。
- **路径补全**：输入 `/` 补全同目录包含文件，自动过滤无效路径。
- **注释自动生成**：使用 `$` 或 `#` 触发字段注释的自动生成，自动右对齐且无尾随空格。
- **Tab 跳转**：按下 `Tab` 键可在 10 字符宽度分布的字段间实现跳转编辑，并支持自动换行。
- **自动格式化**：将数据格式化为 **10 列 / 8 列** 对齐格式；可通过实验性 `lsdyna.autoFormat` 启用光标离开行时的自动格式化，默认关闭。

> **部分功能演示：**
> 
> | 🔑 关键字补全 | 🛤️ 路径补全 |
> | :---: | :---: |
> | ![关键字补全](./images/completion_keyword.gif) | ![Include文件补全](./images/completion_include.gif) |
> | **📝 快速注释** | **📐 Tab 跳转与编辑** |
> | ![注释补全](./images/completion_comment.gif) | ![Tab跳转和编辑](./images/tab_navigation.gif) |
> | **✨ 自动格式化** | |
> | ![自动格式化](./images/auto_format.gif) | |

</details>

<details open>
<summary><b>📂 包含文件大纲与悬停预览</b> (点击展开/折叠)</summary>
<br>

- **状态高亮与相对路径**：`*INCLUDE` 路径高亮显示为蓝色（已解析）或橙色（缺失），支持解析 `*INCLUDE_PATH` 以及 `../` 等相对格式。
- **大文件快速预览**：鼠标悬停包含文件路径时，内部采用 O(1) 异步流式读取技术弹出头部预览。
- **项目导航树**：在侧边栏呈现主模型与所有子 Include 文件的嵌套**引用层级树** (Include Tree)。
- **关键字大纲视图**：侧边栏内提供当前文件中已使用所有**关键字的概览树** (Keyword Index)，支持快速跳转。

| 引用树与大纲面板 | 悬停文件预览 |
| :---: | :---: |
| ![引用树](./images/include_tree.gif) | ![包含文件操作](./images/open_include.png) |

</details>

<details open>
<summary><b>🛠️ 语法导航与参数追踪 (*PARAMETER)</b> (点击展开/折叠)</summary>
<br>

- **交互代码透镜 (CodeLens)**：
  - 在参数定义上方渲染**“N 个引用”**的代码透镜，点击即打开所有引用列表。
  - 针对关键字提供格式化及后缀切换功能（例如为 `*PART` 附加 `_TITLE`）。
- **参数解析**：鼠标悬停在 `&parameter` 变量上时，解析其最终值。
- **全局重命名**：支持在整篇文档中通过 F2 键对参数进行全局重命名。
- **快捷跳转**：使用 `Ctrl+Alt+Up` / `Ctrl+Alt+Down` 跳转到上一个/下一个关键字开头；支持 `.k`, `.key`, `.dyna`, `.cfile` 等文件的语法高亮及代码折叠。

![参数提示](./images/parameter_hints.png)

</details>

---

<a id="手册集成设置"></a>

## 📖 附加功能：PDF 手册集成配置指南

> **说明**: 由于体积原因，离线的 PDF 手册文件并没有直接打包在 `.vsix` 扩展插件中。您可以通过以下两种方式轻松完成配置。

#### 🚀 方式一：一键下载整合包（推荐）
我们为您准备了带有便携版 SumatraPDF 的即插即用压缩包。

- **含中文翻译的手册包**: [Download lsdyna_manual_pack.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna_manual_pack.zip)

**使用方法**:
将下载的压缩包解压到您电脑上的任意位置，然后在 VS Code 的悬停提示卡片 (Hover) 中点击 **齿轮图标 (⚙️)**，将路径指定为您解压后的文件夹即可。

#### 🛠️ 方式二：手动配置
如果您想使用自己平时习惯的 PDF 版本，可以按如下步骤操作：
1. 从 [Ansys LS-DYNA 官网](https://lsdyna.ansys.com/manuals-download/) 下载您需要的帮助手册 PDF。
2. 从 [SumatraPDF 官网](https://www.sumatrapdfreader.org/free-pdf-reader) 下载一个**便携版 (Portable)** 的 SumatraPDF 阅读器。
3. 将下载的所有 PDF 文件和 `SumatraPDF.exe` 放入同一个文件夹中。
4. 同样在悬停卡片上点击**齿轮图标 (⚙️)**，或者在设置中搜索 `lsdyna.manualsDir` 来指向该文件夹。

> ⚠️ **重要提示**
> 插件检索 PDF 页码完全基于 **PDF 的内置书签 (Bookmarks)**，因此文件的名称并不重要。但请注意，如果您对 PDF 文件进行了修改或合并，**一定要保留原有的 PDF 书签**，否则无法实现精确跳转。

在 Windows 下，将 `SumatraPDF.exe` 放入手册目录可实现精确页码跳转。如果 SumatraPDF 不存在或启动失败，DynaSense 会安全地交由系统默认 PDF 阅读器打开；默认阅读器可能忽略请求中的 `#page=` 页码片段。

---

## ⚙️ 扩展配置 (Extension Settings)

在 VS Code 的 `settings.json` 中，你可以自定义以下独占配置：

| 设置项 | 默认值 | 描述 |
| :--- | :--- | :--- |
| `lsdyna.manualsDir` | `"lsdyna_manual_pack"` | 包含 LS-DYNA PDF 手册的目录；Windows 下可同时放置 `SumatraPDF.exe`。 |
| `lsdyna.enableTabNavigation` | `true` | 启用 Tab/Shift+Tab 智能字段跳转。 |
| `lsdyna.statusBar.level` | `"simple"` | 控制 DynaSense 状态栏入口：`off`、`simple` 或 `detail`。 |
| `lsdyna.health.showFirstRunNotice` | `true` | 打开 LS-DYNA 文件且存在需要配置的项目时，显示一次环境状态提示。 |
| `lsdyna.largeFile.enableRendering` | `true` | 为超大 LS-DYNA 文件启用编辑器渲染功能。 |
| `lsdyna.codeLens.showOnAllKeywords` | `false` | 在所有支持的关键字上显示选项 CodeLens。 |
| `lsdyna.hover.previewMaxLines` | `20` | 控制鼠标悬停在包含文件上时，预览窗口所显示的行数。 |
| `lsdyna.autoFormat` | `"disabled"` | 实验性自动格式化模式：`onBlur` 或 `disabled`。 |
| `lsdyna.language` | `"auto"` | 插件界面和悬停语言：跟随 VS Code、简体中文或英文。 |
| `lsdyna.additionalExtensions` | `[".k",".key",".dyna",".asc"]` | 额外关联到 LS-DYNA 语言环境的文件后缀名。 |
| `lsdyna.scanner.fullScanLargeFiles` | `false` | 对大文件执行完整扫描，而非优化后的首尾扫描。 |
| `lsdyna.ignoreFormattingKeywords` | `[]` | 不进行格式化、Tab 对齐和注释补全的关键字或前缀。 |
| `lsdyna.customValidKeywords` | `["*END","*TITLE","*CASE_BEGIN","*CASE_END"]` | 关键字校验额外接受的名称；末尾 `*` 表示前缀通配。 |

> [!TIP]
> **文件关联与图标**
> 本插件默认接管 `.k`, `.key`, `.dyna`, `.asc` 等文件。如果你希望你的自定义文件不仅能被高亮，还能在文件管理器中**显示 LS-DYNA 的专属蓝色工程图标**，请在全局设置中使用：
> `"files.associations": { "*.my_ext": "lsdyna" }`

---

## 鸣谢与贡献者 (Credits & Contributors)

本项目是由 [hqyyqh](https://github.com/hqyyqh) 维护的深度定制重构版本。
特别鸣谢以下极其重要的上游开源项目及原作者，没有他们的杰出工作就没有本项目的诞生：

- **上游原项目：** 本项目 Fork 自 [osullivryan/vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna)。向原作者及其代码库的核心贡献者致敬：
  - [osullivryan](https://github.com/osullivryan) (原项目发起人与核心作者)
  - [DCHartlen](https://github.com/DCHartlen) (核心贡献者)
  - [maxiiss](https://github.com/maxiiss) (核心贡献者)
  - [yshl](https://github.com/yshl) (贡献者)
- **数据库来源：** 插件强大的关键字与字段智能补全数据，大量参考并提取自官方开源项目 [ansys/pydyna](https://github.com/ansys/pydyna)。
- **其他参考：** [vim-lsdyna](https://github.com/gradzikb/vim-lsdyna) 等生态优秀作品。

感谢所有对 LS-DYNA 编辑器生态做出贡献的开发者！

