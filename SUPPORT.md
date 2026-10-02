# Supported workflows / 功能支持范围

[English](#english) · [中文](#中文)

## English

DynaSense 3.2.0 requires VS Code 1.100.0 or later. This page describes what the extension can display and edit; it does not certify every LS-DYNA keyword or solver version. A value may be available to read even when the extension cannot safely edit it.

### File formats and editing

#### Standard fixed-width, LONG, I10

- **Read and display:** Show fields for supported card layouts, preserving their positions in the file.
- **Navigate:** Supported entity types, with a clear choice of main deck.
- **Edit:** Only layouts and card conditions that have been verified for editing.

#### Comma-separated

- **Read and display:** Show fields where supported; otherwise show the original text.
- **Navigate:** Subject to entity and parameter support.
- **Edit:** Verified NODE and CURVE cases are supported. Unverified comma-separated material layouts remain read-only.

#### Conditional cards and repeated records

- **Read and display:** Determine applicable cards and record counts where the controlling values can be resolved.
- **Navigate:** Unresolved conditions remain uncertain.
- **Edit:** Only verified conditions, counts and field positions.

#### Unknown or inconsistent layout

- **Read and display:** Show original text and available help.
- **Navigate:** Only definitions identified independently of the unknown layout.
- **Edit:** No automatic edits. This does not by itself mean that the input is invalid for LS-DYNA.

#### `*COMMENT` region

- **Read and display:** Preserve the original text.
- **Navigate:** Keywords and include paths inside the region are not treated as active model data.
- **Edit:** No keyword-aware editing inside the region.

#### Large-file viewer

- **Read and display:** Read-only browsing, line navigation and literal text search; field views for supported small blocks.
- **Navigate:** Paged keyword index and supported ID queries.
- **Edit:** Always read-only.

### Review and apply changes

The Keyword Manager keeps proposed changes separate from the file until you choose **View changes**, review the proposed edits and select **Apply changes**. **Discard changes** removes unapplied changes; it does not undo edits already applied to the file. Use the editor’s normal Undo, Save and reopen commands for those edits.

A draft stays with the file shown in the manager when you switch to another editor. DynaSense will not apply it if that file is read-only, has changed, has been closed or replaced, or if the proposed values or layout cannot be safely written. Refresh and review the current file before trying again. Ordinary text editing follows VS Code’s own behavior.

Fields can share positions in the file. The preview shows all linked field changes so that you can review their effects together. Unverified conditional-card edits in comma-separated files remain read-only. Opening a supporting manual page does not make an otherwise unsupported layout editable.

Extra rows do not become editable merely because their columns resemble the preceding card. Verified `*DEFINE_CURVE` point sequences and other supported repeated records remain editable; records whose layout cannot be confirmed remain read-only. For CONTACT cards with supported A–G controls, the manager can add optional cards or remove empty optional cards while preserving comments.

Standard-format repeated-record editing is also supported for `*LOAD_POINT_UVW`, `*LOAD_POINT_UVW_SET`, `*INTERFACE_COMPENSATION_3D_FLANGE`, `*ELEMENT_SEATBELT` and `*ELEMENT_TSHELL`. These five rules do not support LONG, I10 or comma-separated records.

### References and large files

Project queries use the selected main deck and its include files. If a file belongs to several models, use **Choose Main Deck** before interpreting inherited parameters and references. Multiple candidates, incomplete scans and unresolved conditions are not the same as a confirmed missing definition. Read the result’s notice before relying on it; refresh edited results and rescan the main deck when needed.

Keyword Index and Entity References start with cursor following off on every extension launch. Following works only while the relevant view is visible. Without following, the visible keyword index can update its list but does not select or scroll to the current keyword. Entity References retains the last query until you search, refresh, change scope or enable following; edited results are marked for refresh.

In the large-file viewer, NODE/ELEMENT blocks and blocks larger than 2 MiB show original text without a field view. You can still browse the file and use supported explicit ID queries. Reload after an external file change; outdated search responses are discarded. The viewer does not modify the file.

### Structural check limits

**Check Current Keyword Structure** reports confirmed, unambiguous structural errors in **Problems**. Automatic checks are limited to:

| Limit | Maximum |
| --- | --- |
| Document lines | 20,000 |
| Keyword blocks | 200 |
| Document text | 2,097,152 characters (2 Mi characters) |
| Characters on one line | 65,536 |
| Physical lines analyzed in one block | 256 |

Larger documents can be checked one keyword at a time with the manual command; the 256-line block limit still applies. Unresolved parameters, ambiguous conditions, unsupported formats and unverified rules are not reported as confirmed errors. Editing or closing the file clears obsolete results. Changes to the loaded manual data trigger a new check.

An empty Problems list does not show that skipped or unsupported blocks passed validation. DynaSense checks are editing aids, not a guarantee that the model will run correctly in LS-DYNA.

### Manuals and platforms

| Platform | Manual viewing |
| --- | --- |
| Windows | Built-in reader and local PDF viewing. Opening a specific PDF page depends on the configured viewer. |
| Linux / macOS | Built-in reader and core extension workflows. The system PDF application may ignore the requested page number. |

Full manuals are installed separately. Without a manual pack, basic editing and bundled help remain available. A different manual edition may still be readable, but cannot enable edits that require verification against a particular edition. If transcribed text, translations or summaries differ from the original official PDF, follow the PDF.

Release test results are recorded separately. A platform or external input that was unavailable for testing is **unverified**, not passed.

## 中文

DynaSense 3.2.0 要求 VS Code 1.100.0 或更新版本。本页说明插件能够显示和修改哪些内容，不代表所有 LS-DYNA 关键字或求解器版本都已验证。能够读取某个字段，并不意味着插件能够安全地修改它。

### 文件格式与编辑范围

#### 标准定宽、LONG、I10 格式

- **读取与显示：** 按支持的卡片格式显示字段，保留字段在文件中的位置。
- **定位与跳转：** 支持的对象类型，并且已明确使用哪个主文件。
- **编辑：** 仅限已验证可编辑的卡片格式及适用条件。

#### 逗号分隔格式

- **读取与显示：** 支持时按字段显示，否则显示原文。
- **定位与跳转：** 取决于对象类型和参数是否受支持。
- **编辑：** 支持已验证的 NODE、CURVE 情形；尚未验证的逗号分隔材料卡片保持只读。

#### 条件卡片与重复记录

- **读取与显示：** 能确定控制值时，判断适用卡片及记录数量。
- **定位与跳转：** 无法确定的条件仍标为不确定。
- **编辑：** 仅限已验证的条件、数量和字段位置。

#### 未知或不一致的卡片格式

- **读取与显示：** 显示原文及可用说明。
- **定位与跳转：** 仅能跳转到不依赖该未知格式即可确认的定义。
- **编辑：** 不自动修改；这本身不表示 LS-DYNA 会将输入判为无效。

#### `*COMMENT` 注释区间

- **读取与显示：** 保留原文。
- **定位与跳转：** 区间内的关键字和引用路径不作为有效模型数据处理。
- **编辑：** 不在区间内进行按关键字识别的编辑。

#### 大文件视图

- **读取与显示：** 只读浏览、行定位和文字搜索；受支持的小块可按字段查看。
- **定位与跳转：** 分页关键字索引及支持的 ID 查询。
- **编辑：** 始终只读。

### 核对并应用修改

关键字管理器中的修改不会立即写入文件。请先点击**查看修改**，核对变化后再点击**应用修改**。**取消修改**只放弃尚未应用的内容，不会撤销已经写入文件的修改；后者使用编辑器通常的撤销、保存和关闭重开操作。

切换到其他编辑器后，尚未应用的修改仍属于管理器中显示的文件。如果该文件只读、内容已变化、已关闭或被替换，或者新值和卡片格式无法安全写入，管理器就不会应用这些修改。请刷新并核对当前文件后再操作。普通文本编辑仍遵循 VS Code 自身行为。

有些字段占用文件中相同的位置。修改预览会列出全部联动字段，便于一起核对。尚未验证的条件卡片逗号格式保持只读；打开对应手册页不会使原本不支持的格式变为可编辑。

额外行的列位置与上一张卡片相似，并不意味着它可以作为重复记录编辑。已验证的 `*DEFINE_CURVE` 曲线点序列及其他受支持的重复记录可以编辑；格式无法确认的记录保持只读。对于支持 A–G 控制选项的 CONTACT 卡片，管理器可添加可选卡片，或删除其中的空卡片，并保留用户注释。

以下五类关键字还支持标准定宽格式的重复记录编辑：`*LOAD_POINT_UVW`、`*LOAD_POINT_UVW_SET`、`*INTERFACE_COMPENSATION_3D_FLANGE`、`*ELEMENT_SEATBELT`、`*ELEMENT_TSHELL`。这五项规则不支持 LONG、I10 或逗号分隔记录。

### 对象引用与大文件

项目查询使用选定的主文件及其引用文件。一个文件属于多个模型时，请先使用**选择主文件**，再查看继承参数和对象引用。有多个候选、扫描不完整或条件无法确定，都不等于已经确认“定义缺失”。请先阅读结果提示；文件修改后按需刷新结果，必要时重新扫描主文件。

关键字索引和对象引用的“跟随光标”在每次启动扩展时均关闭，只在对应视图可见时跟随。跟随关闭时，可见的关键字索引仍会更新列表，但不会自动选中或滚动到当前关键字。对象引用保留上次查询，直到主动搜索、刷新、切换范围或开启跟随；相关文件修改后会提示刷新。

大文件视图中的 NODE/ELEMENT 块，以及超过 2 MiB 的块，只显示原文，不提供按字段查看；仍可浏览文件并执行受支持的 ID 查询。文件在外部修改后需要重新加载，过期的搜索结果不会显示。大文件视图不会修改文件内容。

### 结构检查范围

**检查当前关键字结构**会把已确认且无歧义的结构错误列入“问题”面板。自动检查的上限如下：

| 检查范围 | 上限 |
| --- | --- |
| 文档行数 | 20,000 行 |
| 关键字块数量 | 200 个 |
| 文档字符数 | 2,097,152 个字符（2 Mi 字符） |
| 单行字符数 | 65,536 个字符 |
| 单个关键字块参与分析的物理行数 | 256 行 |

较大文档可以使用手动命令逐个关键字检查，但单块 256 行的限制仍然适用。依赖未解析参数、存在歧义、格式不支持或检查规则尚未验证的结果，不会作为确定错误列出。修改或关闭文件会清除旧结果；已加载的手册数据变化后会重新检查。

“问题”面板为空，不表示被跳过或不受支持的内容已通过验证。插件检查用于辅助编辑，不能保证模型在 LS-DYNA 中正确运行。

### 手册与操作系统

| 操作系统 | 手册阅读 |
| --- | --- |
| Windows | 支持内置阅读器和本地 PDF 阅读；能否跳转到指定 PDF 页码取决于所配置的阅读器。 |
| Linux / macOS | 支持内置阅读器及扩展的核心功能；系统 PDF 阅读器可能忽略指定页码。 |

完整手册需单独安装。未安装手册包时，基础编辑和内置说明仍可使用。其他版本的手册可能仍可阅读，但不能据此启用需要特定版本验证的编辑操作。转录文字、译文或摘要与原始官方 PDF 不一致时，以 PDF 为准。

发布测试结果另行记录。缺少测试平台或外部资料的项目标为**未验证**，不会计作通过。
