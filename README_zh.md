# VS Code LS-DYNA 扩展
[English](README.md)

> [!NOTE]
> **定制版本声明（由 hqyyqh 修改）**
> 本插件是基于 Ryan O'Sullivan 开发的原版 [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) 插件的定制分支，添加了特定的定制化功能。
> - **修改者：** hqyyqh（自 2026 年 5 月起进行修改）
> - **源码仓库：** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **开源协议：** 遵循 GNU General Public License v3.0 (GPL-3.0) 协议。我们保留并尊重原作者的所有版权与贡献声明。

![Version](https://img.shields.io/badge/version-2.0.7--hqyyqh.0-blue)

<img alt="GitHub Actions" src="https://img.shields.io/github/actions/workflow/status/osullivryan/vscode-lsdyna/master_ci.yaml?branch=master&style=for-the-badge&label=CI">

## 将 [LS-DYNA](https://www.lstc.com/) 集成到 VS Code 中。

此扩展将 LS-DYNA 格式化、关键字代码片段以及语言工具集成到了 VS Code 中。

### 示例
![](images/Example.gif)

### 功能特性

**语法与导航**
- 针对 `.k`、`.key` 和 `.dyna` 文件的语法高亮
- 关键字折叠 — 每个 `*KEYWORD` 块均可独立折叠
- 跳转到下一个/上一个关键字：`Ctrl+Alt+Down` / `Ctrl+Alt+Up`
- 通过右键上下文菜单选择当前的关键字块
- 默认关闭自动换行，以便对齐固定宽度的列
- 针对 LS-DYNA 文件提供默认的编辑器标尺（字段标记）以直观展示列宽，并配备了优化、不晃眼的专属调色板

**包含文件 (\*INCLUDE)**
- `*INCLUDE` 文件名高亮显示为绿色（已解析）或红色（缺失），支持续行文件名以及在单个 `*INCLUDE` 块下列出的多个文件
- 右键单击包含文件名 → **Open \*INCLUDE File**，或使用 Ctrl/Cmd+Click
- 支持解析 `*INCLUDE_PATH`、`*INCLUDE_PATH_RELATIVE` 以及 `../` 等相对路径
- 同目录包含路径的自动补全（支持通过斜杠 `/` 或退格键触发，自动过滤掉无效/远程路径）
- 在包含文件路径上支持悬停操作，可快速跳转或查看目标文件详情

**参数 (\*PARAMETER)**
- 针对 `&parameter` 名称的跳转到定义和查找所有引用 (Ctrl/Cmd+Click)
- 在整篇文件中对参数进行重命名 (F2)
- 内联提示 (Inlay hints) 实时显示每个 `&parameter` 引用的解析值
- 在每个参数定义上方显示“N 个引用”的 CodeLens — 点击可打开引用面板
- `*PARAMETER_EXPRESSION` 里的裸变量名高亮颜色与 `&param` 引用一致

**LS-DYNA 手册集成**
- 基于 PDF 书签的手册索引（`manualIndexer`）与本地缓存，实现即时检索
- 交互式悬停卡片：关键字和字段的 Hover 提示卡片内提供了直达 LS-DYNA PDF 手册对应页码的链接
- `openManual` 命令：轻松跳转到指定的手册页面
- 内置 SumatraPDF 支持（Windows）：支持标签页复用、单实例启动路由以及高精度的页码跳转定位

**侧边栏面板**
- **包含树 (Include Tree)** — 递归扫描所有 `*INCLUDE` 文件并以树状图展示；单个 `*INCLUDE` 块内可包含多个文件。特性：
  - 全局文件装饰器（`FileDecorationProvider`）实时追踪并标识已解析/缺失的文件
  - 现代化的视觉指示器：使用条状指示栏（`▏`, `▌`, `█`）替代了原本的 emoji
  - 格式化的文件大小：直接在节点描述和右侧徽章 (badge) 中优雅展示
- **关键字索引 (Keyword Index)** — 展示当前文件（本地模式）或完整包含树（递归模式）中使用的所有关键字。如果关键字索引量巨大（例如包含数百万个 `*NODE` 坐标），会自动按文件归类并折叠，确保列表整洁和 UI 流畅。可通过工具栏按钮切换模式。
![sidebar.png](./images/sidebar.png)

**诊断**
- 超过 80 字符的行（不含注释）会被标记为警告。
- 循环包含（Circular include）会在受影响的 `*INCLUDE` 行上直接报错。
- 缺失的包含文件会在其引入行上标记为警告。
- 诊断信息会在击键时在块级别（block-level）进行增量更新。

**性能与架构**
- **LSP 进程隔离** — 重型扫描与工作线程索引池运行在独立的 Language Server 进程中，确保 0% UI 阻塞。
- **L2 持久化磁盘缓存** — 在工作区全局存储目录中本地缓存项目快照。得益于 LRU 缓存淘汰与自动空间收缩机制，项目可实现秒级瞬间重新打开。
- **增量块级解析** — 在输入时通过快速的块扫描器和范围平移的块索引，仅解析修改过的关键字块范围，瞬间更新当前文档的关键字状态。
- **高性能二进制扫描器** — 核心扫描器基于二进制 Buffer 滑动扫描（`keywordScanner`）、二进制 Buffer 首列匹配（`blockScanner`）以及在包含块内进行的选择性按行解码（`includeScanner`）进行了极致的性能优化。
- **大文件优化** — 放宽了大文件的关键字和包含树数量限制，并加入了备用语言检测；导航时采用 `vscode.open` 替代 `openTextDocument` 以防止界面卡死。

**代码片段**
- 针对常用 LS-DYNA 关键字提供支持 Tab 键补全的代码片段

**LS-PrePost**
- 针对 `.cfile` 命令文件的语法高亮

### 设置

该扩展遵循标准的 VS Code 设置。以下是一些适用于 LS-DYNA 文件的常用设置：

| 设置项 | 默认值 | 描述 |
|---|---|---|
| `editor.hover.enabled` | `true` | 显示关键字及字段悬停提示卡片 |
| `editor.inlayHints.enabled` | `on` | 内联显示解析后的参数值 |
| `editor.codeLens` | `true` | 在参数定义上方显示“N 个引用” |
| `editor.wordWrap` | `off` | 自动换行（对齐固定宽度列时默认关闭） |
| `lsdyna.sumatrapdfPath` | `""` | SumatraPDF 的可执行文件路径（仅限 Windows），用于精确的 PDF 手册页面跳转。 |

可以通过在 `settings.json` 的 `"[lsdyna]"` 下添加这些设置，来使其仅对 LS-DYNA 文件生效：

```json
"[lsdyna]": {
    "editor.hover.enabled": false,
    "editor.inlayHints.enabled": "off"
}
```

### 关键字数据

代码片段和悬停文档基于 [pydyna](https://github.com/ansys/pydyna) 关键字数据库（`kwd.json`）生成，该数据库由 Ansys 维护，涵盖了 3168 个 LS-DYNA 关键字，包含完整的字段定义、类型、默认值和帮助文本。此数据仅在构建时使用，不打包在扩展中。

若要在更新 pydyna 后重新生成：

```bash
# 将 pydyna 克隆为该仓库的同级目录（一次性设置）
git clone https://github.com/ansys/pydyna ../pydyna

# 重新生成代码片段和悬停字段数据
python keywords/generate_from_pydyna.py
```

此操作将覆盖 `snippets/lsdyna.json` 和 `keywords/field_data.json`。

### 贡献新关键字

你可以通过以下几种方式来添加关键字或功能：

1. 向我发送电子邮件或在 GitHub 上发消息说明所需的关键字（并附带示例）。
2. 发起 Pull Request：
    1. Fork 本仓库的 master 分支。
    2. 将 [pydyna](https://github.com/ansys/pydyna) 克隆为本仓库的同级目录 (`../pydyna`)。
    3. 从仓库根目录运行 `python keywords/generate_from_pydyna.py`，从完整的 pydyna 关键字数据库（包含 3168 个关键字）重新生成 `snippets/lsdyna.json`。
    4. 创建一个新的 Pull Request，将你的分支合并到 master。

### 贡献者

- [osullivryan](https://github.com/osullivryan) (原作者)
- [hqyyqh](https://github.com/hqyyqh) (定制版维护者)
- [yshl](https://github.com/yshl)
- [maxiiss](https://github.com/maxiiss)

### 参考链接

[vim-lsdyna](https://github.com/gradzikb/vim-lsdyna)  
[DCHartlen 的 vscode 扩展](https://github.com/DCHartlen/LSDynaForVSCode)
