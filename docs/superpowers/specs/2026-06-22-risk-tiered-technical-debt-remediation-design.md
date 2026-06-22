# DynaSense 风险分级技术债治理设计

**日期：** 2026-06-22
**状态：** 已获用户批准，待实施计划
**适用仓库：** `D:\Project\vscode-lsdyna`

## 1. 背景与目标

DynaSense 已具备 TypeScript 构建、LSP、worker、增量索引、磁盘缓存和 299 项通过的自动化测试，但配置、文档、扫描器、监听器与 Windows 外部调用之间仍有若干不一致。这些问题目前没有被基线测试发现，说明现有测试更偏向局部功能，缺少跨文件契约和边界行为验证。

本治理工作的目标是：在不进行无关大重构的前提下，修复已经核实的正确性、安全性与文档完整性问题；为这些约束建立自动化门禁；保持现有功能、性能策略和对 VS Code 1.50 及以上版本的兼容性。

## 2. 已核实的现状

1. `README.md` 与 `README_zh.md` 只列出 4 个设置，其中 `lsdyna.additionalExtensions` 默认值错误，另有 2 个不存在的设置；`package.json` 实际声明 11 个设置。
2. `package.nls.json` 有 1 个重复键，`package.nls.zh-cn.json` 有 2 个重复键。重复值目前相同，运行风险较低，但会掩盖未来翻译覆盖错误。
3. `package.json` 的 `engines.vscode` 为 `^1.50.0`。VS Code 仅从 1.74 起自动为扩展贡献的命令生成激活条件，因此 1.50–1.73 仍需要完整的 `onCommand` 激活事件。
4. 工作区 watcher 固定为 `**/*.{k,key,dyna}`，未覆盖 `.asc` 和用户自定义扩展名，配置变化时也不会重建。
5. Include、Block、Keyword、参数和编辑器辅助路径使用了不同的关键字识别规则；其中 Include 的内存和流式快速路径对前导空白及小写尤其敏感。
6. `includeScanner` 和 `keywordScanner` 的大文件尾部扫描使用 `9999999` 作为虚拟行号，会污染导航及诊断位置。
7. Include 路径的现有格式化最多生成三行，但长度超过 236 字符时第三行会超过 80 列。用户已依据 LS-DYNA 文档确认：路径最多三行，前两行各为 78 个路径字符加 ` +`，最后一行最多 80 个字符。
8. Windows 上打开 PDF、fallback 和资源管理器定位仍通过 `child_process.exec` 拼接 shell 字符串。
9. 设计开始前，`docs/superpowers` 下 83 个 Markdown 中有 61 个无法被严格 UTF-8 解码。
10. manifest 只关联已存在的 tracked files。原本缺失的 Include 文件稍后被创建时，文件事件会被视为“未跟踪”并忽略。

基线验证为 `npm test` 全部通过，共 299 项；开始设计时 Git 工作树干净。

## 3. 方案选择

### 3.1 采用方案

采用“总规格 + 四个独立实施阶段”：

1. 契约与文档完整性；
2. 解析器正确性与路径边界；
3. watcher、失效传播与诊断生命周期；
4. Windows 外部调用安全与最终回归。

每个阶段必须独立产出可运行、可测试的软件状态，并以独立提交收尾。后续实施计划可以进一步拆成多个任务，但不得跨阶段混入无关重构。

### 3.2 未采用方案

- **单次大改：** 容易把文档、解析、缓存和平台问题耦合在一起，回归定位成本高。
- **只修运行时、文档后置：** 会继续让用户和 AI 依据损坏或过时资料工作，无法完成本目标的契约治理要求。

## 4. 总体架构

本次只抽取与治理目标直接相关的小型边界模块：

- 项目契约检查器：验证 manifest、README、NLS、命令和 UTF-8。
- 关键字行分类器：提供文本与字节扫描共用的规范化语义。
- 大文件尾部定位器：计算完整尾部行边界和真实行号。
- watcher manager：管理扩展名集合和监听器生命周期。
- 项目诊断发布器：按项目根记录和合并诊断贡献。
- 外部进程适配器：封装无 shell 的 Windows 启动行为。

不拆分整个 `src/extension.ts`，不迁移命令命名空间，不在本轮启用 TypeScript strict，也不调整与这些缺陷无关的 UI 或索引架构。

## 5. 阶段一：契约与文档完整性

### 5.1 配置文档

`package.json` 的 `contributes.configuration.properties` 是唯一配置真源。两个 README 必须完整记录以下设置及真实默认值：

- `lsdyna.manualsDir`
- `lsdyna.enableTabNavigation`
- `lsdyna.largeFile.enableRendering`
- `lsdyna.codeLens.showOnAllKeywords`
- `lsdyna.hover.previewMaxLines`
- `lsdyna.autoFormat`
- `lsdyna.language`
- `lsdyna.additionalExtensions`
- `lsdyna.scanner.fullScanLargeFiles`
- `lsdyna.ignoreFormattingKeywords`
- `lsdyna.customValidKeywords`

README 不再声明不存在的 `lsdyna.format.enableOnSave` 与 `lsdyna.index.enableIncludeTree`。功能介绍中的“保存时自动格式化”也必须改成当前真实行为：实验性的 `onBlur` 或关闭。

手册配置链接必须指向稳定、存在的 README 章节；中英文界面分别指向对应语言文档，不再使用已失效的中文锚点指向英文 README。

### 5.2 NLS 与命令契约

清理两个 NLS 文件中的重复键。新增契约检查，保证：

- NLS 原始文本不存在重复顶层键；
- 中英文键集合一致；
- `package.json` 引用的 `%key%` 在两种语言中都存在；
- 每个 `contributes.commands` 命令都有注册实现；
- 每个贡献命令都有兼容 VS Code 1.50–1.73 所需的 `onCommand:<id>`；
- 内部命令允许不出现在 `contributes.commands`，但必须在测试中的显式 allowlist 中说明用途。

本轮保留 `engines.vscode: ^1.50.0`，因此选择补齐激活事件，而不是提高最低 VS Code 版本。

### 5.3 UTF-8 恢复策略

对 61 个损坏文档逐个处理：

1. 沿 Git 历史从新到旧读取同一路径的 blob；
2. 选择最近一个可被严格 UTF-8 解码的版本恢复；
3. 若所有历史版本均损坏，不猜测缺失字符；
4. 对仍有现实参考价值的文档，根据对应提交、当前代码和测试重建简短的 UTF-8 摘要；
5. 对已过时文档，将原始字节改为非 Markdown 归档文件，并在 UTF-8 归档清单记录原路径、blob 哈希、恢复状态和替代资料；
6. CI 对仓库内所有文本型开发文档执行严格 UTF-8 解码，禁止新的损坏文件进入仓库。

原始损坏内容必须可追溯，不允许静默使用替换字符覆盖后假装恢复成功。

## 6. 阶段二：解析器正确性与路径边界

### 6.1 统一关键字识别

新增共享关键字行分类器。文本接口至少返回：

- 是否为关键字行；
- 前导缩进宽度；
- 保留原始大小写的关键字文本；
- 用于比较的规范化大写名称；
- 是否包含小写字符。

Include、Block、Keyword、参数、关键字导航、格式化上下文和编辑器辅助功能使用同一语义。前导空格和 Tab 不得阻止识别；小写关键字参与正常解析，同时保留现有 warning 诊断。

流式扫描继续先在字节层跳过空格、Tab 和 CR，只对候选 `*` 行解码。Include 的快速预检改为 ASCII 大小写无关，并允许行首空白；普通网格数据行不得被批量转成字符串。

### 6.2 大文件尾部真实行号

尾部扫描流程为：

1. 根据文件大小选取尾部字节窗口；
2. 将起点推进到第一个完整换行之后，避免从半行开始解析；
3. 使用固定大小 Buffer 统计起点之前的换行字节，得到真实起始行号；
4. 以真实行号扫描尾部；
5. 按文件路径、大小和 mtime 缓存尾部起始行号，文件签名变化时失效。

该过程是 O(n) 字节读取、O(1) 额外内存，不解码非候选行。相比当前只读取头尾窗口会增加顺序 I/O，但这是产生真实行号所必需的最小成本；不得退回全文字符串解析。

### 6.3 三行路径上限

路径格式器改为返回结构化结果：

- `unchanged`：无需改变；
- `formatted`：可安全格式化，并携带 1–3 行结果；
- `tooLong`：超过 236 字符，不产生编辑结果，并携带诊断范围和消息。

折行规则固定为：第一、二段最多 78 个路径字符并追加 ` +`；最后一段最多 80 个字符。适用于 `*INCLUDE` 文件名卡和 `*INCLUDE_PATH`/`*INCLUDE_PATH_RELATIVE` 路径卡。已有合法多行路径缩短后仍可合并为单行。

必须覆盖 80、81、156、157、236、237 字符，以及合法多行回并、注释间隔和 CRLF 输入。

## 7. 阶段三：watcher、失效传播与诊断生命周期

### 7.1 watcher manager

扩展名集合由内置 `.k`、`.key`、`.dyna`、`.asc` 与 `lsdyna.additionalExtensions` 的并集构成。配置值统一补全前导点、转为小写、去重，并拒绝包含 glob 元字符或路径分隔符的非法值。

每个扩展名单独创建 watcher，避免动态 brace glob 的转义问题。配置变化时先建立新 watcher 集合，再原子替换并释放旧集合；扩展停用时统一释放。

### 7.2 缺失 Include 候选依赖

索引器在解析失败时记录所有可能的候选绝对路径，而不只记录原始文件名。manifest 新增与现有 `trackedFiles` 分离的 `missingDependencyPaths`：

- 已存在文件仍通过签名参与缓存有效性检查；
- 不存在的候选路径只用于 watcher 事件到项目根的反向映射；
- 某候选文件被创建时，对应项目根立即失效并排队重建；
- 重建成功后，该路径从 missing dependency 转为普通 tracked file。

这避免对不存在文件执行 `stat`，也不会把所有工作区文件变化都升级为全项目重扫。

### 7.3 诊断生命周期

项目诊断按 `rootFile` 保存为 `Map<uri, Diagnostic[]>`。刷新某个根时：

1. 记录该根旧诊断涉及的 URI；
2. 用新 snapshot 生成该根的新诊断；
3. 对旧、新 URI 的并集重新合并所有项目根贡献；
4. URI 无任何贡献时从 DiagnosticCollection 删除。

这样既能清除旧项目、旧子文件上的残留诊断，也不会误删另一个项目根对共享文件产生的诊断。

## 8. 阶段四：Windows 外部调用安全

资源管理器定位统一调用 VS Code 的 `revealFileInOS`，删除 Windows 专用 `explorer.exe` shell 拼接。

SumatraPDF 使用参数化启动：

```text
spawn(exePath, args, {
  shell: false,
  detached: true,
  stdio: 'ignore',
  windowsHide: false
})
```

参数数组中的路径不手工添加引号。子进程成功创建后 `unref()`；同步抛错或 `error` 事件均进入 `vscode.env.openExternal` fallback。fallback 不再调用 `cmd.exe /c start`。系统默认 PDF 阅读器可能忽略 page fragment，此行为需在 README 中明确，而不能为保留跳页能力重新引入 shell。

测试覆盖空格、中文、括号、`&`、`|`、`;`、`^`、`%`、`!` 等路径字符，并断言 `shell` 永远为 `false`。

## 9. 错误处理与兼容性

- 非法自定义扩展名被忽略并写入扩展日志，不导致激活失败。
- 文档恢复失败必须进入归档清单，不能阻塞运行时代码治理。
- 大文件行号计算失败时回退为完整流式扫描，而不是重新使用虚拟行号。
- 外部进程失败必须走 VS Code API fallback，并向用户保留现有可理解的错误体验。
- 新 snapshot/manifest 字段必须提供向后兼容默认值，使旧磁盘缓存安全失效或升级，不能反序列化崩溃。

## 10. 测试与 CI

每个实现任务遵循红—绿—重构循环。测试至少包括：

1. 配置、README、NLS、命令激活及 UTF-8 契约测试；
2. 关键字分类器的大小写、空格、Tab、CRLF 单元测试；
3. Include、Block、Keyword、参数在内存与流式扫描中的一致性测试；
4. 大文件头尾 fixture 的真实行号、导航与诊断测试；
5. 三行路径全部边界值测试；
6. watcher 重建、释放、自定义扩展和缺失文件创建测试；
7. 多项目共享文件的诊断合并与清理测试；
8. Windows 无 shell 调用及特殊字符路径测试；
9. UTF-8 恢复清单与 CI 校验测试。

最终验证命令包括：

```text
npm run compile
npm test
npm audit --omit=dev
npx --no-install vsce package --out dist/technical-debt-verification.vsix
```

CI 必须运行与本地相同的契约检查、测试和打包步骤。最终交付更新 `CHANGELOG.md`，记录配置文档修正、解析兼容性、三行路径诊断、watcher 行为和 Windows 启动安全变化。

## 11. 实施顺序与提交边界

1. 先建立会失败的契约测试，再修 README、NLS、activationEvents 和 UTF-8 文档。
2. 建立解析边界测试，再实现分类器、真实尾部行号和路径限制。
3. 建立 watcher/失效/诊断生命周期测试，再修改 manifest 与扩展激活逻辑。
4. 建立无 shell 测试，再替换 Windows 调用。
5. 运行全量验证、打包并更新 CHANGELOG。

后续 writing-plans 阶段应为四个阶段分别生成独立、可执行的实现计划。任一阶段不得以当前 299 项测试通过作为完成证据；必须证明新增测试覆盖了对应需求。

## 12. 完成标准

只有同时满足以下条件才算完成：

- 本设计列出的 10 项治理要求均有代码或文档证据；
- 所有新增边界和契约均由自动化测试覆盖；
- `9999999`、相关 shell 字符串拼接和失效 README 设置不再存在；
- 仓库文本型开发文档全部通过严格 UTF-8 校验，损坏历史内容可追溯；
- compile、测试、生产依赖审计和 VSIX 打包全部成功；
- CHANGELOG、风险说明和迁移说明完整；
- 未夹带命令命名空间迁移、全量 strict TypeScript 或 `extension.ts` 全面拆分等无关重构。
