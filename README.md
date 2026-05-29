# VS Code LS-DYNA 扩展
[English](README_en.md)

![Version](images/version-badge.png)

此扩展将 LS-DYNA 格式化、关键字代码片段以及语言工具集成到了 VS Code 中，为您带来现代化、智能化的编写体验。

### 安装指南

请访问项目的 [Releases 页面](https://github.com/hqyyqh/vscode-lsdyna/releases) 下载最新的 `.vsix` 插件安装包，并在 VS Code 中选择“从 VSIX 安装”。具体的依赖配置与常见问题，请参考该页面的安装指南。

---

### 核心功能体验

<details open>
<summary><b>📖 LS-DYNA 手册集成与交互式查询</b> (点击展开/折叠)</summary>
<br>

- **交互式悬停卡片**：关键字和字段的 Hover 提示卡片内提供了直达 LS-DYNA PDF 手册对应页码的链接，点击即达！
- **即时检索**：基于 PDF 书签实现瞬间检索。
- **字段级提示**：悬停卡片内包含当前关键字每一个特定字段的具体说明。

![悬浮提示](images/悬浮提示.gif)

</details>

<details open>
<summary><b>⚡ 智能补全与自动化排版</b> (点击展开/折叠)</summary>
<br>

- **关键字快速补全**：针对常用 LS-DYNA 关键字提供支持 Tab 键补全的代码片段。
- **智能路径补全**：输入 `/` 即刻补全同目录包含文件，自动过滤无效路径。
- **注释自动生成**：使用 `$` 或 `#` 触发字段注释的自动生成，完美右对齐且无尾随空格。
- **智能 Tab 导航**：按下 `Tab` 键即可将字段对齐至其实际物理列宽、在当前行的各字段间循环，并平滑地自动换行。
- **自动格式化数据行**：代码时刻保持严格的网格对齐，整洁规范。

> **部分功能演示：**
> 
> | 🔑 关键字补全 | 🛤️ 路径补全 |
> | :---: | :---: |
> | ![关键字补全](images/关键字补全.gif) | ![Include文件补全](images/include文件补全.gif) |
> | **📝 快速注释** | **📐 智能 Tab 跳转与编辑** |
> | ![注释补全](images/注释补全.gif) | ![Tab跳转和编辑](images/tab跳转和编辑.gif) |
> | **✨ 自动格式化** | |
> | ![自动格式化](images/自动格式化.gif) | |

</details>

<details>
<summary><b>📂 包含文件管理与可视化侧边栏</b> (点击展开/折叠)</summary>
<br>

- **状态高亮**：`*INCLUDE` 文件名高亮显示为蓝色（已解析）或橙色（缺失），支持续行文件名以及多文件。
- **相对路径解析**：完美支持解析 `*INCLUDE_PATH`、`*INCLUDE_PATH_RELATIVE` 以及 `../` 等格式。
- **引用树侧边栏面板**：递归扫描所有包含文件，以直观的树状图展示当前文件的引用层级关系和已使用的所有关键字。
- **快速预览**：在包含文件路径上支持悬停操作，可快速跳转或查看目标文件详情。

| 引用树面板 | 悬停快速操作 |
| :---: | :---: |
| ![引用树](images/引用树.gif) | ![包含文件操作](images/打开include文件.png) |

</details>

<details>
<summary><b>🛠️ 参数解析 (*PARAMETER) 与语法导航</b> (点击展开/折叠)</summary>
<br>

- **内联提示 (Inlay hints)**：实时内联显示每个 `&parameter` 引用的最终解析值。
- **引用追踪 (CodeLens)**：在每个参数定义上方显示“N 个引用”的 CodeLens，点击即可打开引用面板。
- **全局重命名**：支持在整篇文档中通过 F2 键对参数进行安全重命名。
- **语法导航**：支持针对 `.k`、`.key`、`.dyna` 和 `.cfile` 等文件的语法高亮；支持跳转到上/下一个关键字；每个 `*KEYWORD` 块均可独立代码折叠。

![参数提示](images/参数提示.png)

</details>

---

### 插件设置

该扩展除了遵循标准的 VS Code 设置外，还提供了一些专属的配置选项。
*(可以在设置界面搜索 `lsdyna` 进行相关调整)*

![插件设置](images/设置.png)

**LS-DYNA 专属设置：**

| 设置项 | 默认值 | 描述 |
|---|---|---|
| `lsdyna.language` | `"zh-cn"` | 选择插件的界面语言和悬浮提示语言（支持 `zh-cn` 和 `en`） |
| `lsdyna.manualsDir` | `""` | 包含 LS-DYNA PDF 手册的目录路径。在 Windows 系统上，请将 `SumatraPDF.exe` 复制到该目录下以启用精确页码跳转。 |
| `lsdyna.additionalExtensions` | `[".k", ".key", ".dyna", ".asc"]` | 需要额外关联到 LS-DYNA 语言模式的文件后缀名 |

**VS Code 常用建议设置：**

| 设置项 | 默认值 | 描述 |
|---|---|---|
| `editor.hover.enabled` | `true` | 显示关键字及字段悬停提示卡片 |
| `editor.inlayHints.enabled` | `on` | 内联显示解析后的参数值 |
| `editor.codeLens` | `true` | 在参数定义上方显示“N 个引用” |
| `editor.wordWrap` | `off` | 自动换行（对齐固定宽度列时默认关闭） |

可以通过在 `settings.json` 的 `"[lsdyna]"` 下添加这些设置，来使其仅对 LS-DYNA 文件生效：

```json
"[lsdyna]": {
    "editor.hover.enabled": false,
    "editor.inlayHints.enabled": "off"
}
```

---

### 关键字数据

代码片段和悬停文档基于 [pydyna](https://github.com/ansys/pydyna) 关键字数据库（`kwd.json`）生成，该数据库由 Ansys 维护，涵盖了 3168 个 LS-DYNA 关键字，包含完整的字段定义、类型、默认值和帮助文本。此数据仅在构建时使用，不打包在扩展中。

若要在更新 pydyna 后重新生成：

```bash
git clone https://github.com/ansys/pydyna ../pydyna
python keywords/generate_from_pydyna.py
```

### 贡献与支持

你可以通过以下几种方式来添加关键字或功能：
1. 向我发送电子邮件或在 GitHub 上发消息说明所需的关键字（并附带示例）。
2. 发起 Pull Request 将你的代码合并到分支。

**贡献者：**
- [osullivryan](https://github.com/osullivryan) (原作者)
- [hqyyqh](https://github.com/hqyyqh) (定制版维护者)
- [yshl](https://github.com/yshl)
- [maxiiss](https://github.com/maxiiss)

**参考链接：**
[vim-lsdyna](https://github.com/gradzikb/vim-lsdyna) | [DCHartlen 的 vscode 扩展](https://github.com/DCHartlen/LSDynaForVSCode)

---

> [!NOTE]
> **定制版本声明（由 hqyyqh 修改）**
> 本插件是基于 Ryan O'Sullivan 开发的原版 [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) 插件的定制分支，添加了特定的定制化功能。
> - **修改者：** hqyyqh（自 2026 年 5 月起进行修改）
> - **源码仓库：** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **开源协议：** 遵循 GNU General Public License v3.0 (GPL-3.0) 协议。我们保留并尊重原作者的所有版权与贡献声明。
