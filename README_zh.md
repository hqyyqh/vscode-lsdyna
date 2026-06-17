# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/LS_DYNA_geo_metro.png" width="120" height="120" alt="LS-DYNA Icon">
  <h3>VS Code 平台功能丰富的 LS-DYNA 工程模型编辑器</h3>
  <p>为 CAE 工程师打造：包含智能补全、大文件预览、以及代码自动对齐等功能。</p>

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/hqyyqh.dynasense?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

[English Version](README.md) | [中文说明](README_zh.md)

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
- **自动格式化**：将数据格式化为 **10 列 / 8 列** 对齐格式，支持**保存时自动格式化**。

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

## ⚙️ 扩展配置 (Extension Settings)

在 VS Code 的 `settings.json` 中，你可以自定义以下独占配置：

| 设置项 | 默认值 | 描述 |
| :--- | :--- | :--- |
| `lsdyna.additionalExtensions` | `[".txt"]` | 动态添加你想让插件接管并高亮的自定义文件后缀名。 |
| `lsdyna.hover.previewMaxLines` | `20` | 控制鼠标悬停在包含文件上时，预览窗口所显示的行数。 |
| `lsdyna.format.enableOnSave` | `true` | 是否开启保存 (Ctrl+S) 时自动格式化当前光标所在行的数据格式。 |
| `lsdyna.index.enableIncludeTree` | `true` | 是否在侧边栏启用 `*INCLUDE` 嵌套层级树视图。 |

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

