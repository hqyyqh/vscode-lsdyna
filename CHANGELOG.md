# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed / 改进

- Reduce public settings from 38 to 29 and organize them into 12 everyday options and 17 advanced options. Retain existing cache-limit overrides, use a fixed change-mark update delay, and replace the setup-notice setting with a persistent dismissal action. The developer-only unaudited-catalog override now uses its existing environment variable instead of a user setting.
- 将公开设置从 38 项精简为 29 项，分为 12 项日常选项和 17 项高级选项。保留已有缓存限制配置，统一变更标记更新延迟，并以持久化的“不再提醒”操作替代配置提示开关。仅供开发使用的未审核数据入口改为沿用现有环境变量，不再通过用户设置启用。

- Remove the obsolete large-file full-scan switch and its outdated first/last-line description. Keyword and include discovery already scans through the file; cancellation and scan-budget safeguards remain in place. Document the defaults and consequences of removing legacy cache overrides.
- 移除已失效的大文件全量扫描开关及“仅扫描首尾”的过时说明。关键字和引用指令发现本就读取整个文件，保留取消操作和扫描预算保护；补充旧缓存配置的默认值及删除配置后的影响。

## [3.2.2] - 2026-10-25

### Added / 新增

- Add commands to fold or unfold keyword blocks in batches, fold the block at the cursor, and compare two files using project-aware file selection.
- 新增关键字块批量折叠／展开、折叠光标所在关键字块及双文件比较命令；文件选择优先使用当前工程相关目录。
- Support copying selected text, fields and lines in the large-file viewer, and reuse Keyword Manager field help for consistent descriptions and manual links.
- 大文件查看器支持复制选中文本、字段和行，并复用关键字管理器的字段帮助，统一字段说明与手册链接。
- Provide explicit optional-card controls for keywords with verified native support, including supported DATABASE binary output keywords and ALE_INJECTION; retain previews and confirmation before discarding populated fields.
- 为已核验原生支持的关键字提供可选卡片控件，包括支持的 DATABASE 二进制输出关键字及 ALE_INJECTION；移除已填写字段前保留预览与确认。

### Changed / 改进

- Simplify Entity References controls and use the same scope picker as Keyword Index; move cursor following to the view menu.
- 精简对象引用控件，查询范围沿用关键字索引的选择方式，并将光标跟随移入视图菜单。
- Show the selected keyword option directly in Keyword Manager without repeating the group label; retain the original Apply and Discard controls.
- 关键字管理器直接显示选中的关键字选项，不再重复显示选项组名称；保留原有的应用与放弃控件。
- Make column guides configurable with `lsdyna.columnGuides.enabled`, showing them only at verified fixed-width field boundaries; expose field-value selection and the guide toggle in the status dashboard.
- 通过 `lsdyna.columnGuides.enabled` 配置列辅助线，仅在已确认的固定宽度字段边界显示；在状态面板中提供字段取值选择和辅助线开关。
- Show scan progress and cancellation in the relevant project view; retain confirmed results as partial after cancellation and reduce duplicate routine notifications.
- 在对应工程视图中显示扫描进度与取消入口；取消后保留已确认的结果并标明不完整，减少重复的常规通知。
- Size the entity index memory budget automatically at startup while preserving explicit numeric settings; explain low-memory query restrictions and distinguish index limits from result limits.
- 启动时自动确定对象索引内存预算，同时保留用户明确设置的数值；说明内存不足时的查询限制，并区分索引上限与结果上限。
- Improve narrow-panel and enlarged-text layouts, sidebar search and Chinese/English wording; avoid preparing project-wide reference data for local field help when it is not needed.
- 改进窄面板及放大文字时的布局、侧边栏搜索与中英文文案；本地字段帮助无需工程引用数据时，不再提前准备全工程数据。

### Fixed / 修复

- Preserve case-sensitive parameter names in completion, expression evaluation, navigation and reference queries.
- 在参数补全、表达式求值、跳转和引用查询中保留参数名称的大小写区别。
- Refresh the current-file keyword index when the active tab or large-file contents change, and retain valid fuzzy-search matches.
- 活动标签页或大文件内容变化时刷新当前文件关键字索引，并保留有效的模糊搜索匹配结果。
- Correct conditional reference roles and Include parameter contexts; scope incomplete results to the affected query and reconcile edits during indexing without unnecessarily cancelling queries.
- 修正条件引用角色及引用文件中的参数上下文；按受影响的查询判断结果是否完整，并在索引期间协调文档修改，避免不必要地取消查询。
- Align recognized keyword spellings, manager entries and selector choices with verified native behavior; preserve format-specific write restrictions and include shared-record drafts when determining whether changes can be applied.
- 使关键字识别、管理器入口及选项与已核验的原生行为一致；保留各输入格式的写入限制，并将共享数据记录的草稿纳入可应用修改的判断。
- Fix project-session initialization when the automatic memory budget is too low to allow indexing.
- 修复自动内存预算不足以建立索引时的工程会话初始化问题。
- Include the optional-card control data required by the runtime in VSIX packages.
- 将运行时所需的可选卡片控制数据纳入 VSIX 安装包。
- Validate optional-card source and descriptor identities consistently in public source builds so that exported data remains usable without weakening integrity checks.
- 公开源码构建统一校验可选卡片的来源与描述符身份，使导出数据可正常使用，同时保留完整性检查。

## [3.2.1] - 2026-10-18

### Changed / 改进

- Complete visible parameters in supported numeric fields and navigate definitions and usages across the scanned main deck and its included files, respecting parameter scope and incomplete results.
- 在支持的数值字段中补全当前可见的参数，并在已扫描主文件及其引用文件间定位定义和使用位置，保留参数作用域与扫描不完整的提示。
- Improve large-file browsing and hand off supported field edits to the text editor while preserving unsaved content and stale-position checks.
- 改进大文件浏览，将支持的字段编辑交给文本编辑器处理，并保留未保存内容与过期位置检查。
- Let automatic manual reading follow the UI language while retaining explicit reading-language choices; English-only packs remain in English.
- 手册阅读的自动语言跟随界面语言，并保留用户明确选择的阅读语言；英文手册包仍使用英文。

### Fixed / 修复

- Preserve the scanned main deck context for curve previews in included files, and use a refresh icon for reloading a keyword instance.
- 保留已扫描主文件的上下文，使引用文件中的曲线悬停预览正常显示；关键字实例重新读取按钮改用刷新图标。

### Documentation / 文档

- Add a product website link and record the manual-pack update date in both READMEs.
- 在中英文 README 中添加产品介绍链接，并注明手册包更新日期。

## [3.2.0] - 2026-10-13

### Added / 新增

- **Manual reading:** Bilingual reading mode displays paired Chinese and English content when the manual pack supports it. The manual action remains available in Hover before setup; the setup picker offers bilingual/English downloads in Chinese and an English-pack download in English.
- **手册阅读：** 手册包支持时，可使用中英对照模式阅读。未配置手册时，悬停卡片仍保留手册入口；中文引导提供双语版和英文版下载，英文引导直接提供英文包下载。
- **Keyword maintenance:** Actions for checking keyword card structure and updating field comments help maintain a deck after keyword-header changes. Keyword Manager supports separate drafts, previews and explicit application, with checks for unsupported layouts and stale documents.
- **关键字维护：** 新增卡片结构检查及字段注释更新入口，方便修改关键字头后维护卡片。关键字管理器支持独立草稿、预览及显式应用，并检查不支持的布局和已变化的文档。
- **Persistent object indexes:** On-demand indexes reuse queries and file facts, persist reusable data in SQLite and return reference results in pages from the background worker. SQLite is bundled with the platform-specific extension; no separate database installation is needed.
- **持久化对象索引：** 按需建立索引，复用查询成果和文件数据，通过 SQLite 持久化可复用数据，并由后台进程分页返回引用结果。平台专用插件包自带 SQLite，无需另行安装数据库。

### Changed / 改进

- **Large-file viewer:** Improved buffered scrolling, syntax colors, line and search-target highlighting, and keyword match counts. A compact search bar switches between keyword and full-text search; keyword search is the default.
- **大文件视图：** 改进滚动缓冲、语法着色、行跳转与搜索目标高亮，增加关键字匹配计数。紧凑搜索栏可切换关键字与全文查找，默认使用关键字搜索。
- **Entity references and sidebars:** Prioritized common entity types and remembered selections. Scope/follow icons reflect their state; cursor following starts off, and hidden views defer work. Empty result groups and passive query warnings no longer occupy the results area; stale-position navigation guards and explicit action-failure feedback remain.
- **对象引用与侧边栏：** 优先排列常用对象类型并记忆选择；范围及跟随图标反映当前状态。启动时默认关闭光标跟随，隐藏视图延后处理。空结果分组及被动查询警告不再占用结果区，仍保留过期位置跳转保护和主动操作失败反馈。
- **Hover and controls:** Restored complete keyword card layouts with aligned, unbolded fields. Compact Codicon actions replace repeated labels; redundant curve data, candidate descriptions and saved/modified notices are removed from Hover.
- **悬停卡片与控件：** 恢复完整关键字卡片结构，字段规整对齐且不再加粗。使用紧凑的 Codicon 操作入口，移除重复曲线数据、候选说明及已保存／已修改提示。
- **Package and loading:** Compress static resources, share form rules and load reference-rule shards on demand. Retain the complete editing data while excluding unused build inputs from the VSIX. F5 reuses verified runtime data to reduce repeated build work.
- **安装包与加载：** 压缩静态资源、共享表单规则并按需加载引用规则分片；保留完整编辑数据，排除无运行时用途的构建文件。F5 复用已验证的运行时数据，减少重复构建。
- **Editing responsiveness:** Prepare field data asynchronously and compare change marks within edited regions. Extensive rewrites may use approximate line marks; file contents, Save and Undo are unchanged.
- **编辑响应：** 异步准备字段数据，修改标记优先比较编辑区域；大范围改写时可能采用近似行标记，不改变文件内容、保存或撤销行为。

### Fixed / 修复

- Unified schema-backed keyword recognition across modules, including composed CONTACT variants such as `*CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP_ID` and `*CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET`.
- 统一各模块基于规则数据的关键字识别，修复上述 CONTACT 等组合选项关键字被误报为未知关键字的问题。
- Preserve fixed-field alignment when renaming parameter references; resolve the source deck when scanning the Include Tree from Keyword Manager or a field form.
- 参数引用重命名时保持定宽字段对齐；从关键字管理器或字段表单扫描引用文件树时，正确确定源文件。
- Corrected scope switching, cancellation sharing, stale query results and asynchronous scan identity. Strengthened edit guards for read-only files, closed/replaced documents, invalid drafts and unsupported card layouts.
- 修复范围切换、共享请求取消、过期查询结果及异步扫描身份问题；加强只读文件、关闭或替换的文档、无效草稿和不支持卡片布局的编辑保护。
- Improved COMMENT boundaries and standard/LONG/I10 handling. Verified repeated-record editing is available for `*LOAD_POINT_UVW`, `*LOAD_POINT_UVW_SET`, `*INTERFACE_COMPENSATION_3D_FLANGE`, `*ELEMENT_SEATBELT` and `*ELEMENT_TSHELL` in standard format; this does not extend those rules to LONG, I10 or comma formats.
- 改进 COMMENT 边界及标准／LONG／I10 格式处理。上述五类关键字已验证的重复记录编辑限于标准格式，不扩展至 LONG、I10 或逗号分隔格式。
- Aligned automated platform packaging and acceptance with the current runtime, updated release/manual download guidance, and excluded internal maintenance documents from public exports.
- 自动化平台打包及验收与当前运行时保持一致，更新发布及手册下载说明，并从公开导出中排除内部维护文档。

### Upgrade and release notes / 升级与发布说明

- Requires VS Code **1.100.0 or later**. Install the VSIX matching your operating system and architecture, then reload the window.
- 需要 VS Code **1.100.0 或更新版本**；安装与系统及架构匹配的 VSIX 后重新加载窗口。
- Compatible schema-v1 manual packs and existing PDF directories remain supported. A compatible bilingual pack with alignment data is required for paired reading; an English-only pack does not gain Chinese content through an extension update.
- 继续支持兼容的 schema-v1 手册包及已有 PDF 目录。中英对照阅读需要含对齐数据的兼容双语包；更新插件不会为英文包自动补充中文内容。
- Index caches may be rebuilt when their format or rule identity changes. Source model files do not require migration. Performance depends on the model and cache state; no fixed speed-up factor is promised.
- 索引格式或规则身份变化时，缓存可能需要重建，源模型无需迁移。实际性能取决于模型及缓存状态，不承诺固定提速倍数。
- **3.2.0** was published on 2026-10-13. See the [GitHub release](https://github.com/hqyyqh/vscode-lsdyna/releases/tag/v3.2.0) for its release assets.
- **3.2.0** 已于 2026-10-13 发布，安装包见 [GitHub Release](https://github.com/hqyyqh/vscode-lsdyna/releases/tag/v3.2.0)。

## [3.1.5] - 2026-08-06

### Added
- **Change-mark color schemes:** Session marks now offer one adaptive theme-aware default plus orange/blue, red/blue, high-contrast, and custom choices. Presets switch automatically across light, dark, high-contrast, and high-contrast-light themes; custom colors are applied consistently to gutter shapes, line tints, the overview ruler, and the minimap.

### Fixed
- **Keyword-schema CI:** Linux CI and release jobs now install the frozen PyDYNA code-generation dependencies before running schema-adapter tests.
- **Release packaging:** Local temporary worktree administration and scratch-worktree directories are excluded from VSIX contents and enforced by the package contract.
- **Chinese field help:** Published the reviewed Chinese field-help set with exact English-source binding, protected LS-DYNA identifiers and numeric branches, and the reviewed legacy `*MAT_ADD_EROSION` compatibility descriptions.
- **Session change marks after Save As:** A copied deck now inherits the source editing baseline, so only the lines actually changed since the source was opened become saved-green. Unrelated same-content files are not linked, and uncertain lifecycle cases fall back to a clean target instead of marking the whole file as inserted.
- **Include paths and change-mark indicators:** Every schema-backed Include filename/path card—including structured variants such as `*INCLUDE_TRANSFORM`, `*INCLUDE_STAMPED_PART`, and `*INCLUDE_MULTISCALE`—now keeps numeric prefixes, underscores, separators, and extensions in one path-string highlight without recoloring later numeric cards. Resolved includes rely on their native clickable link underline, while unresolved includes show one trailing warning-triangle icon. Include status no longer occupies the editor glyph margin or hides line change marks.
- **Reference Hover:** Known current-file curve, table, and generic-definition candidates can be inspected before a project scan while the binding remains explicitly uncertain. Candidate links and previews no longer imply a unique resolved definition.
- **Table references:** Child curve/table rows retain exact, ambiguous, uncertain, or missing state. Ambiguous and uncertain children are never selected implicitly or used to build a combined 3D preview.
- **Parameter Hover:** Current-file source definitions are labeled separately from occurrence-aware effective values in the selected or unique main-deck context.

### Changed
- **Theme-aware visual system:** Syntax highlighting remains controlled by standard TextMate scopes, editor/tree warnings now use VS Code semantic theme colors, rulers inherit `editorRuler.foreground`, and SVG/animated fallbacks share one audited palette for light, dark, high-contrast, and high-contrast-light themes. Change marks also use a non-color unsaved status dot.
- **Include status clarity:** Existing include paths rely on their native underlined document link; missing paths use a trailing theme-aware exclamation indicator. Resolved files no longer borrow Git untracked colors in the Include Tree.
- **Keyword data:** Regenerated snippets, field help, and reference metadata from the frozen PyDYNA source recorded in `keywords/pydyna-source.json`. The reproducible build retains reviewed legacy `*MAT_ADD_EROSION` fields used by older solver decks.
- **Chinese field help packaging:** The full localized schema remains the review source but is compiled into a hash-bound runtime delta. The extension now loads one authoritative English schema and applies Chinese help lazily, reducing package size and avoiding a second complete schema in memory.
- **Keyword actions:** Select Cards, Format, and (when supported) Configure Options now live in the keyword Hover action area instead of occupying editor lines by default. `lsdyna.codeLens.showOnAllKeywords` remains available for users who want these CodeLens actions above every keyword.
- **English and Chinese copy:** Revised commands, settings, status messages, manual-reader controls, and README terminology for clearer LS-DYNA workflows. Added localization contracts for manifest text, locale keys, and placeholders.
- **Manual setup documentation:** Updated both READMEs with the current English-original and bilingual manual-pack downloads, the Windows-only SumatraPDF requirement, and the notice that only the bundled PDF manuals are the official authoritative reference.
- **Release page guidance:** Automated GitHub releases now append maintained English and Chinese instructions for VSIX installation, window reloads, and manual-pack setup instead of the obsolete manual-pack text.

## [3.1.1] - 2026-07-24

### Added
- **Session change marks (no Git):** **Orange** = unsaved, **green** = saved since open. Shapes live only in the **glyph margin** (**solid** = modified, **hollow** = inserted, **triangle** = deleted on a neighbor line) — no left text border. Optional **whole-line** tint (`showLineBackground`) and a separate **minimap / overview** layer (`showMinimap`, dual-color). Theme colors via `lsdyna.changeMarks.unsaved` / `.saved`. Commands: next/previous mark (`Alt+F5` / `Shift+Alt+F5`), reset baseline, and diff vs opened / unsaved.
- **Field help quiet switch:** Card field hover help can be turned off for this session or permanently from the hover card footer, and turned back on from the DynaSense status bar menu (or command palette). Setting `lsdyna.enableFieldHover` (default on). Include path / parameter / keyword hovers stay available when field help is off.
- **Card field cell edit protect:** On fixed-width card data lines, Delete/Backspace (while a field is selected) clears the **cell** with space padding so later fields do not shift left. Independent setting `lsdyna.enableCellEditProtect` (default on). **Typing is not intercepted** (keywords `*…`, comments `$…`, free text use the normal editor).
- **Include path completion:** Path suggestions only fire on the **filename card** of multi-card keywords (for example `*INCLUDE_TRANSFORM` offset/scale lines no longer open path completion). On an `*INCLUDE` filename line, typing a name fragment opens suggestions automatically (no Ctrl+Space). Matches show the full relative path so duplicate names in different folders stay clear.
- **Ancestor `*INCLUDE_PATH` inheritance (project index / Include Tree):** When indexing from a main job, child decks inherit PATH cards declared on include ancestors (nearest first). Short names in children resolve without copying PATH into every file. Opening a child alone still uses file-local paths only (no workspace-wide PATH union).

### Fixed
- **Include path completion:** Typing a name after `/`, `\`, `./`, or `.\` now stays in one-level folder browsing instead of unexpectedly switching to recursive filename search. Browse suggestions keep folders before files and use natural alphanumeric ordering (`1`, `2`, `10`).
- **Tab on card lines:** Daily Tab no longer token-repacks a free-format or collapsed line (that was re-pinning values into the wrong columns after a clear). Explicit format commands still re-rack by tokens/commas.
- **Cell Backspace/Delete:** Deletes to the left within the owned field; empty-row delete and exclusive caret boundaries no longer clear the wrong field.
- **Tab after finishing a field:** Caret at a full field’s exclusive end (same column as the next field start) no longer skips the next field; empty previous fields still advance normally. Shift+Tab stays geometric so it does not skip backward.
- **Cell type-over strict scope:** Typing rewrites a field **only after Tab/SelectCell** marks the cell (A then short Ap for multi-digit). Without Tab, or when typing `*` / `$`, input is normal editor text (no R1 pad). Delete/Backspace cell clear remains.
- **Tab free-format align restored:** Free-format / collapsed card lines (e.g. `1 2 3 4`) again token-rack into fixed columns on Tab. Intact grids still use in-place R1 only (empty cells kept).

### Changed
- **Status bar (deck context HUD):** Main text prioritizes **current-file** deck errors/warnings, then the **current keyword** — not environment “setup items”. Detail shows field `n/N` without a permanent Manual OK badge; after Include Tree scan, detail also shows the **scan root short name** (tooltip always states scanned vs not). Click menu is **LS-DYNA quick actions**: problems and Include scan first; environment & manuals check sunk (manuals CTA still rises when unconfigured).
- **Include path completion (how it feels when editing):** Under `*INCLUDE`, `/` and `\` walk one folder level at a time (search roots = deck directory + valid `*INCLUDE_PATH` entries). Suggestions insert the **full relative path** with `/` (for example `mats/steel/mat.k`), not only a bare file name.
- **Docs:** README (EN/中文) rewritten for CAE users—manual pack flavors, include workflow, Linux path-case checklist, and plain-language path completion steps.
- **Docs:** README explains ancestor `*INCLUDE_PATH` inheritance when scanning from the main deck vs file-local search when a child is opened alone.

### Behavior notes
- Empty `*INCLUDE` lines no longer dump the entire file list; start with `/` to browse or type a name to search.
- Accepting a completion always writes `/` separators (helpful when the same deck will run on Linux).
- Include Tree from main: PATH on main/setup applies to nested short includes.
- After a main-job scan, editor jump / DocumentLink / path color / `*INCLUDE` completion / path-case checks on child decks use the same ancestor-aware search roots as the tree (cached from the project snapshot). Opening a child alone without a scan still stays file-local.
- Incremental graph updates resolve includes with snapshot effective paths; changing `*INCLUDE_PATH` cards flags a full root rebuild (`requiresFullRebuild`).

## [3.1.0] - 2026-07-21

### Added
- **Manual packs:** Two install flavors — **English-only** and **bilingual** (EN + 中文). If Chinese indexes are missing, the reader skips them safely instead of breaking.
- **Manual PDFs:** Opens the PDF file named in the pack manifest (including versioned or Chinese-only file names), with a fallback to the older `title.pdf` layout.

### Changed
- **Manual Reader:** Whether you can switch the document to Chinese depends on **what the pack contains**, not only on VS Code’s display language. Menus/toolbars still follow the extension UI language.
- **Manual Reader:** “Open PDF” uses the **page numbers from this pack’s index** for the PDF that ships in the pack (so bilingual dual-text PDFs stay aligned after merge).
- **Config / docs:** Point `lsdyna.manualsDir` at a pack root such as `lsdyna-manual-pack-en` or `lsdyna-manual-pack-bilingual`.

### Fixed
- **Hover:** Clearer actions when a keyword is unknown (status bar and info icons).
- **Manual Reader:** Wider Variable column; full-width panel and font scaling from later 3.0.x work are included in this minor.

## [3.0.13] - 2026-07-08

### Added
- **Status Bar**: Added an in-editor diagnostic details view from the DynaSense status dashboard.

### Changed
- **Status Bar**: Refined dashboard action names and ordering, moving DynaSense output to the end and placing healthy environment status after primary workflow actions.
- **i18n**: The extension language now follows VS Code display language changes at runtime when `lsdyna.language` is set to `auto`.
- **Formatter**: Restored `*INCLUDE_PATH` wrapping through both document formatting and the CodeLens formatting command.

### Fixed
- **Keywords**: Accepted numbered `*CASE_BEGIN_<n>` and `*CASE_END_<n>` variants as valid custom case boundary keywords.

## [3.0.12] - 2026-06-25

### Fixed
- **i18n**: Added missing Chinese translations for field data.

### Changed
- **Build**: Excluded `scripts` folder from the extension package.

## [3.0.11] - 2026-06-25

- Triggered clean release.

## [3.0.10] - 2026-06-25

### Fixed
- **Hover**: Added support for referencing curve/table definitions from real number fields.
- **Hover**: Removed keyword option entry.
- **Snippets**: Synchronized `MAT_ADD_EROSION` damage field annotations.
- **Keywords**: Restored `MAT_ADD_EROSION` damage field descriptions.

### Changed
- **References**: Refactored to remove field reference override files.

## [3.0.9] - 2026-06-24

### Added
- **Hover**: Added graphical 1D and 3D Curve/Table definition previews with dynamic SVG plots on field hovers, with automatic theme adaptation.
- **Index**: Implemented project-level reference index cache across Include hierarchies for multi-file curve/table definition resolution.
- **Data**: Upgraded PyDyna keyword schema mapping to accurately capture LCID/TBID field references.

## [3.0.8] - 2026-06-22

### Added
- **Quality**: Added CI-enforced contracts for manifest settings, activation events, localization parity, README defaults, command registration, and strict UTF-8 documentation.
- **Diagnostics**: Added an explicit `include-path-too-long` diagnostic for LS-DYNA Include paths beyond the confirmed three-line/236-character limit.

### Changed
- **Parser**: Unified indented and mixed-case keyword recognition across Include, block, keyword, parameter, and navigation paths; large-file tail scans now report real line numbers.
- **Workspace**: Watchers now include `.asc` and valid configured extensions, rebuild on configuration changes, and refresh projects when previously missing Include files appear.
- **Diagnostics**: Project diagnostics are merged by project root, so refreshing one root no longer removes another root's shared-file diagnostics; stale document diagnostics are cleared.
- **Docs**: Restored 61 corrupted Superpowers records from strict UTF-8 Git history and aligned both READMEs with all 11 manifest settings.

### Security
- **Windows**: Replaced shell-built PDF and Explorer commands with parameterized `spawn` (`shell: false`) and VS Code's `revealFileInOS`/`openExternal` APIs.

## [3.0.7] - 2026-06-20
### Added
- **Features**: Added i18n support and a setup guide dialogue for configuring the PDF manual directory (`configureManualsDir`).
- **Features**: Enhanced keyword hover messages with a direct setup guide link for the PDF manual.
- **CI/CD**: Auto-tagging and streamlined dual marketplace releases (Open VSX and VS Code Marketplace).
- **CI/CD**: Upgraded GitHub Actions runtime to Node 24.
- **Docs**: Added PDF manual setup instructions and Open VSX marketplace badges to README.

### Changed
- **Tests**: Renamed `phase7_features.test.js` to `advanced_features.test.js` and updated related references.

## [3.0.6] - 2026-06-20
### Added
- **Assets**: Switched to brand new DynaSense extension icons and refined the activity bar icon.

### Fixed
- **Editor**: Added a custom tooltip to `*INCLUDE_PATH` DocumentLinks to override the default confusing "Execute Command" tooltip.

## [3.0.5] - 2026-06-18
### Changed
- **Enhancement**: Continuous improvements and bug fixes for LS-DYNA syntax parsing and language features.

## [3.0.4] - 2026-06-17
### Changed
- **Enhancement**: Core IntelliSense engine updates and stability improvements.

*(Older versions are not listed here but can be found in the git commit history.)*
