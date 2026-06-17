# DynaSense (LS-DYNA Studio)

<div align="center">
  <img src="images/ls.svg" width="120" height="120" alt="LS-DYNA Icon">
  <h3>VS Code 平台最强大的 LS-DYNA 工程模型编辑器</h3>
  <p>为真正的 CAE 工程师打造：海量智能补全、大文件极速预览、拯救强迫症的自动对齐。</p>

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/hqyyqh.dynasense?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

[English Version](README_en.md) | [中文说明](README.md)

---

## 🌟 核心特性 (Core Features)

### 1. 🧠 极致的智能感知与补全 (Intelligent Autocomplete)
* **全量关键字覆盖**：数据深度提取自官方 [ansys/pydyna](https://github.com/ansys/pydyna) 数据库，支持超过 **3100+** 个 LS-DYNA 关键字的语法树解析。
* **智能字段补全**：不仅能补全关键字，还能在输入时智能弹出带有详尽注释（长度、类型、默认值）的字段 Snippets 模板。

### 2. ⚡️ 大文件极速透视 (O(1) Hover Preview)
* 告别打开几百兆 `.k` 文件时的卡顿！
* 将鼠标悬停在 `*INCLUDE` 或 `*INCLUDE_PATH` 后的文件路径上，即可**瞬间预览**包含文件的头部内容。
* 内部采用 O(1) 异步文件块流式读取技术，无论被包含的文件有几 GB，都能在毫秒级弹出预览。
* *可在设置中自定义预览行数。*

### 3. 🎨 强迫症福音：自动排版对齐 (Code Formatting)
* 一键将错乱的字段数据格式化为极其工整的 **10 列 / 8 列** 经典 LS-DYNA 标准对齐格式。
* 支持快捷键触发（`Ctrl+Shift+F` 或右键格式化），更支持 **保存时自动格式化光标所在行**。
* `*INCLUDE` 路径支持自动扩展至 512 列以防路径截断。

### 4. 💡 智能交互代码透镜 (CodeLens)
* 在代码上方动态渲染可点击的动作按钮（CodeLens）。
* 一键快速切换关键字的可选卡片（例如：一键为 `*PART` 附加 `_TITLE` 后缀）。
* 一键精准格式化当前所属的整个关键字块（Block）。

### 5. 🗺️ 全局项目导航图 (Project Outline)
* **包含树解析 (Include Tree)**：在侧边栏清晰呈现主模型与所有子 Include 文件的嵌套层级树。
* **关键字大纲 (Keyword Index)**：提供当前文件中所有关键字的概览，点击即可极速跳转。

### 6. 🚀 沉浸式快捷编辑
* **智能 Tab 跳转**：在按标准的 10 字符宽度分布的字段（Cell）间，使用 `Tab` 和 `Shift+Tab` 进行完美跳跃编辑。
* **关键字穿梭**：使用 `Ctrl+Alt+Up` / `Ctrl+Alt+Down` 在成百上千行的文本中直接跳转到上一个/下一个关键字开头。

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

