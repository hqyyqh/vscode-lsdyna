# LS-DYNA 关键字完整生成实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `snippets/lsdyna.json` 和 `keywords/field_data.json` 覆盖 pydyna `kwd.json`、`manifest.json`、`additional-cards.json` 共同定义的关键字、别名、标题类 option、可选卡片和重复卡片语义，并让 hover、字段补全、格式化和关键字校验消费同一份增强数据。

**架构：** 生成端复用 pydyna `keyword_generation` 的 loader + handler pipeline，先得到经过 wildcard、alias、insert-card、replace-card、add-option、series/table/card-set/cascading 等规则处理后的结构化 schema，再序列化成本扩展可用的紧凑 JSON。运行端保持 `field_data.json` 的现有 `c`/`r` 兼容格式，同时新增 option/alias/variant 元数据，用一个统一的 card sequence resolver 替换当前散落的 `_TITLE` 特判。

**技术栈：** Python 生成脚本、pydyna `codegen/keyword_generation`、VS Code Extension API、TypeScript/CommonJS、Mocha 单测。

---

## 可行性结论

可行，但应分两层实现：

- **完全可生成：** 基础关键字、manifest-only `source-keyword` 关键字、显式 alias、自动 hyphen/underscore alias、`TITLE`/`HEADING`/`ID`/`ID_TITLE`/`ID_HEADING` 这类 title-order option、insert/replace/add-field/reorder/skip 后的最终卡片结构。
- **需要运行时解析：** CONTACT A-G 这种关键字名称不变、只在主卡片后追加 optional cards 的情况。生成端应保存 option 元数据；hover/completion/formatting 根据关键字行、已激活 title options、当前块非注释数据行数推导当前行属于 base card 还是 optional card。
- **可做但不建议伪装成行号点击：** VS Code 对“行号左侧栏目点击弹出选择”支持有限。推荐组合是 gutter decoration 作被动提示、CodeLens 或 hover command 作主动入口、右键菜单/Code Action 作辅助入口。hover 文档和 hover command 可以共存，因为当前 hover 已经使用 trusted Markdown command links。

已核对的当前缺口：

- `keywords/generate_from_pydyna.py` 目前只从 `kwd.json` 生成 3168 个 `field_data` entry，只从 `manifest.json` 读取重复卡片标记。
- 当前 `snippets/lsdyna.json` 有 3180 个 snippet，`field_data.json` 有 3168 个 entry。
- `MAT_001_TITLE`、`CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_A/F/ID`、`SET_NODE` 目前都没有显式 snippet/field_data entry。
- pydyna 生成结果中，`MAT_001` 通过 `OptionSpec("TITLE", "pre/1", 1)` 表示 `*MAT_001_TITLE`，CONTACT 通过 `OptionSpec("A"..."G", "post/N", 0)` 表示不改关键字名的追加卡片。

## 关键设计决策

1. **生成端不重新解释 pydyna manifest。**
   直接调用或移植 pydyna `keyword_generation` 的数据模型和 handler pipeline。这样 `insert-card` 的 label-based 定位、wildcard 合并、`type: multiple` 归一化、`card-set` 引用语义、`series-card` 和 `table-card-group` 不会和 pydyna 结果偏离。

2. **`field_data.json` 继续兼容现有格式。**
   原有消费者仍能读取 `entry.c` 和 `entry.r`。新增紧凑字段：

   ```json
   {
     "c": [[{ "n": "MID", "p": 0, "w": 10, "h": "...", "t": "integer" }]],
     "r": 1,
     "o": [
       { "n": "TITLE", "co": "pre/1", "to": 1, "c": [[{ "n": "TITLE", "p": 0, "w": 80, "h": "Additional title line", "t": "string" }]] },
       { "n": "A", "co": "post/1", "to": 0, "c": [[{ "n": "SOFT", "p": 0, "w": 10, "h": "...", "t": "integer" }]] }
     ],
     "a": ["SET_NODE"],
     "v": {
       "MAT_001_TITLE": { "active": ["TITLE"] }
     }
   }
   ```

   `o` 是 option groups，`co` 是 card-order，`to` 是 title-order，`a` 是 aliases，`v` 是显式 title variant 到 active options 的映射。

3. **snippet 分两类生成。**
   真实关键字名 snippets 保持为 `*KEYWORD`。对 title-order option 生成真实关键字变体，例如 `*MAT_001_TITLE`，body 中包含 TITLE 行及 base cards。对 CONTACT A-G 生成“选择型 snippet”，label/detail 可以显示 `CONTACT... optional cards A-F`，body 仍插入真实关键字 `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE` 并追加 A-F 卡片。

4. **hover 行匹配改为 schema-driven。**
   当前 `hasTitleSuffix()` 会跳过 TITLE 行，无法满足“TITLE 行也能 hover help”。新逻辑应先解析当前关键字的 active title options，再生成实际渲染 card sequence。TITLE/ID/MPP 等 pre options 是普通 card，可以 hover 字段帮助；CONTACT A-G post options 按块内行数匹配。

5. **option 更新命令必须保守。**
   增加 option 时可以插入注释行和空数据行。减少 option 时只有在目标行为空、全空白或由本扩展生成的注释/空模板时自动删除；遇到非空用户数据，展示选择并让用户决定，避免破坏 deck。

## 文件结构

- 修改：`keywords/generate_from_pydyna.py`
  作为 CLI 入口，负责加载 pydyna 输入、调用新 adapter、写 `snippets/lsdyna.json` 和 `keywords/field_data.json`。
- 创建：`keywords/pydyna_schema_adapter.py`
  封装 pydyna loader、wildcard 合并、alias 注册、handler pipeline 调用、`KeywordData` 到 compact schema 的序列化。
- 创建：`keywords/schema_model.md`
  记录 `field_data.json` 增强字段协议，方便 hover/completion 和翻译脚本保持一致。
- 修改：`keywords/field_data_zh.json`
  由增强后的 `field_data.json` 同步结构，仅翻译 `h`/documentation 类文本。
- 修改：`src/core/keywordUtils.ts`
  移除或降级手写 suffix/alias 特判，改为读 schema 中的 aliases/options。
- 创建：`src/core/keywordSchema.ts`
  统一加载、查询、解析关键字 options、生成 rendered card sequence。
- 修改：`src/extension.ts`
  hover、字段补全、格式化、Tab 对齐、关键字补全、CodeLens/命令注册改用 `keywordSchema.ts`。
- 修改：`src/core/parser/keywordValidator.ts`
  使用 schema 的 canonical/alias/variant 集合做校验。
- 修改：`package.json`、`package.nls*.json`
  增加 option 选择命令、右键菜单项和本地化文案。
- 创建或修改测试：`test/core/keywordSchema.test.js`、`test/core/keywordDefaults.test.js`、`test/client/providers/phase7_features.test.js`、`test/extension.test.js`、`keywords/tests/test_pydyna_schema_adapter.py`。

## 任务 1：生成端接入 pydyna handler pipeline

**文件：**
- 修改：`keywords/generate_from_pydyna.py`
- 创建：`keywords/pydyna_schema_adapter.py`
- 创建：`keywords/tests/test_pydyna_schema_adapter.py`

- [x] **步骤 1：编写 adapter 单测**

  覆盖以下样例：

  - `MAT_001` 有 base card 1 张，option `TITLE` 为 `pre/1`、`title-order=1`，variant 包含 `MAT_001_TITLE`。
  - `CONTACT_AUTOMATIC_SURFACE_TO_SURFACE` 有 base cards 3 张，options 包含 `ID`、`MPP`、`A` 到 `G`。
  - `SET_NODE_LIST` 生成 alias `SET_NODE`，alias 能指向同一 schema。
  - `CONTROL_TIMESTEP` alias 到 `CONTROL_TIME_STEP`，并保留 cascading-card 元数据或最终 conditional/card active 信息。

  运行：`python -m pytest keywords/tests/test_pydyna_schema_adapter.py -v`
  预期：先失败，原因是 adapter 不存在。

- [x] **步骤 2：实现 `pydyna_schema_adapter.py` 的加载入口**

  入口函数建议：

  ```python
  def build_schema(codegen_dir: Path, kwd_file: Path | None = None) -> tuple[dict, dict]:
      """Return (field_data, snippets) generated from pydyna codegen inputs."""
  ```

  实现要点：

  - `sys.path.insert(0, str(codegen_dir))` 后导入 `keyword_generation.data_model` 和 `keyword_generation.generators.class_generator._get_keyword_data`。
  - 不导入 pydyna `generate.py` 入口，避免本地缺 `beartype` 时失败。
  - 复用 `keyword_generation.keyword_data_model.ManifestLoader` 已有的 `type: multiple` 归一化。
  - 手动实现 `WILDCARDS` prefix/exact 匹配、exclusions、`merge_options()`、labels 合并。
  - 注册 manifest alias，并补充 hyphen/underscore 定义完全一致时的自动 alias。
  - 对每个 keyword 调 `_get_keyword_data(keyword_name, source_keyword, generation_options, initial_labels=labels)`，得到已处理的 `KeywordData`。

  运行：`python -m pytest keywords/tests/test_pydyna_schema_adapter.py -v`
  预期：样例 schema 可生成。

- [x] **步骤 3：序列化 card、field、option、alias**

  字段序列化：

  - `n`：保留大写原字段名或 pydyna normalize 后字段名的大写显示名。
  - `p`、`w`：position/width。
  - `h`：help。
  - `t`：type。
  - `d`：default，仅当 default 不为 null 时输出。
  - `e`：field enum/options，仅当 options 非空时输出。
  - `active`：卡片存在 active/func 时输出，用于 hover 显示“条件卡片”提示。

  option 序列化：

  - `n`：option name。
  - `co`：card_order，如 `pre/1`、`post/6`、`main/2`。
  - `to`：title_order。
  - `c`：option cards。

  运行：`python keywords/generate_from_pydyna.py pydyna/codegen/kwd.json`
  预期：`field_data.json` 中 `MAT_001.o`、`CONTACT_AUTOMATIC_SURFACE_TO_SURFACE.o`、`SET_NODE` alias 信息可见。

- [x] **步骤 4：生成 title variants 和 alias entries**

  规则：

  - 对 `title_order > 0` 的 options 按 `title_order` 排序生成显式 variants。
  - 单 option：`MAT_001_TITLE`。
  - 多 option：按 title order 组合，例如 CONTACT 的 `ID`、`MPP` 可产生 `..._ID`、`..._MPP`、`..._ID_MPP`。组合数上限 32，超限时只写 `v` 元数据，不写全部显式 entries。
  - alias entry 直接复用 canonical schema，但 `description`/`prefix` 使用 alias 名。

  运行：`node -e "const f=require('./keywords/field_data.json'); console.log(!!f.MAT_001_TITLE, !!f.SET_NODE)"`
  预期：输出 `true true`。

## 任务 2：生成完整 snippets

**文件：**
- 修改：`keywords/generate_from_pydyna.py`
- 修改：`snippets/lsdyna.json`
- 测试：`keywords/tests/test_pydyna_schema_adapter.py`

- [x] **步骤 1：为 base keyword 继续生成现有 snippet body**

  保持当前行为：

  - 第一行是真实 `*KEYWORD`。
  - 普通 card 生成 `$#` 注释行和数据行。
  - 单个宽字段 card 生成宽文本占位。
  - 结尾保留 `$0`。

- [x] **步骤 2：为 title variants 生成真实 snippet**

  `*MAT_001_TITLE` 的 body 应是：

  ```text
  *MAT_001_TITLE
  ${1:TITLE}
  $#       MID        RO         E        PR        DA        DB
  ...
  $0
  ```

  TITLE 行不是无文档的特殊行，后续 hover 应能映射到 `TITLE` 字段 help。

- [x] **步骤 3：为 CONTACT post options 生成选择型 snippet**

  对 `post/N` 且 option name 为连续 A-G 的 options：

  - 保留基础 `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE` snippet。
  - 增加 completion label/detail：`*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE + Optional Cards A-F`。
  - prefix 可包含 `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F` 和 `CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F`，但 body 第一行必须是真实关键字 `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE`。
  - 选择 F 时，body 追加 A、B、C、D、E、F 的 comment/data cards。

  运行：`node -e "const s=require('./snippets/lsdyna.json'); console.log(Object.keys(s).filter(k=>k.includes('CONTACT_AUTOMATIC_SURFACE_TO_SURFACE')&&k.includes('OPTION')).length)"`
  预期：CONTACT 选择型 snippets 存在，且不会改变真实关键字行。

- [x] **步骤 4：更新生成验证**

  添加生成后断言：

  - `snippets/lsdyna.json` 包含 `*MAT_001_TITLE`。
  - `snippets/lsdyna.json` 包含 `*SET_NODE`。
  - `snippets/lsdyna.json` 包含 CONTACT A-G 选择型 completion。
  - `keywords/field_data.json` 包含 `MAT_001_TITLE`、`SET_NODE`，并在 CONTACT entry 上包含 `o`。

## 任务 3：统一运行时 keyword schema resolver

**文件：**
- 创建：`src/core/keywordSchema.ts`
- 修改：`src/core/keywordUtils.ts`
- 测试：`test/core/keywordSchema.test.js`

- [x] **步骤 1：编写 resolver 单测**

  覆盖：

  - `lookupKeywordSchema('MAT_001_TITLE')` 返回 canonical `MAT_001`、active option `TITLE`、rendered cards 第一张是 TITLE。
  - `lookupKeywordSchema('SET_NODE')` 返回 `SET_NODE_LIST` 的 cards。
  - `resolveCardForLine()` 在 `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE` 下第 4 张数据 card 匹配 optional A，第 9 张数据 card 匹配 optional F。
  - title line hover 不返回 null，而是返回 `TITLE` 字段。

- [x] **步骤 2：实现 schema 加载和缓存**

  `keywordSchema.ts` 提供：

  ```ts
  type KeywordLookup = {
      inputName: string;
      canonicalName: string;
      entry: KeywordEntry;
      activeOptions: string[];
  };
  ```

  函数：

  - `loadKeywordSchema(getLanguage: () => string)`：按语言加载 `field_data_zh.json` 或 `field_data.json`。
  - `lookupKeywordSchema(name: string)`：精确、variant、alias、sub-token fallback。
  - `getRenderedCards(entry, activeOptions, observedDataLineCount?)`：返回当前块可见 card sequence。
  - `getCardForDocumentLine(document, lineNum)`：替代 `getCardFieldsForLine()` 内部逻辑。

- [x] **步骤 3：兼容旧字段**

  `entry.c` 和 `entry.r` 没有新增 `o` 时仍按旧逻辑工作，避免老 `field_data_zh.json` 失配导致功能全断。

  运行：`npm test -- --grep keywordSchema`
  预期：resolver 单测通过。

## 任务 4：更新 hover、字段补全、格式化和校验

**文件：**
- 修改：`src/extension.ts`
- 修改：`src/core/parser/keywordValidator.ts`
- 修改：`src/core/keywordUtils.ts`
- 测试：`test/extension.test.js`、`test/client/providers/phase7_features.test.js`、`test/core/keywordDefaults.test.js`

- [x] **步骤 1：hover 改用 rendered card sequence**

  删除 hover 中 `_TITLE` 手动跳过逻辑。行为变更：

  - `*MAT_001_TITLE` 下一行 TITLE 文本 hover 显示 `TITLE` 字段 help。
  - `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE` 第 base+F 行 hover 显示 Optional Card F 字段 help。
  - keyword line hover 列出 base cards 和可用 options，并保留 manual links。

- [x] **步骤 2：字段补全和 `$#` 注释生成改用 resolver**

  `LsdynaFieldCompletionProvider`、`generateCommentLine()` 调用点继续接收 card fields，但 card 由 resolver 提供。CONTACT optional line 上输入 `$` 应补对应 Optional Card A-F 的字段注释。

- [x] **步骤 3：format/tab 对齐改用 resolver**

  `formatLineIfNeeded()`、`handleTabAlignment()`、`handleSelectionChange()` 不再直接依赖旧 `getCardFieldsForLine()` 的 title suffix 特判。

- [x] **步骤 4：关键字校验改用 schema keyword set**

  `keywordValidator.init()` 接收：

  - canonical names。
  - generated title variants。
  - aliases。
  - 自定义 valid keywords。

  验收：

  - `*MAT_001_TITLE` 不报未知关键字。
  - `*SET_NODE` 不报未知关键字。
  - CONTACT `_F` 如果只是选择型 snippet prefix 而非真实关键字，不应被当作合法关键字，除非 schema 中明确生成了真实 title variant。

  运行：`npm test -- --grep "LsdynaFieldHoverProvider|LsdynaFieldCompletionProvider|keyword aliases"`
  预期：相关测试通过。

## 任务 5：option 选择和更新交互

**文件：**
- 修改：`src/extension.ts`
- 修改：`package.json`
- 修改：`package.nls.json`
- 修改：`package.nls.zh-cn.json`
- 测试：`test/extension.test.js`

- [x] **步骤 1：新增命令**

  命令：`extension.lsdynaChooseKeywordOptions`

  行为：

  - 如果光标所在 keyword 没有 `entry.o`，显示无可用 options 的信息。
  - 对 title-order options 显示 checkbox-like QuickPick：`TITLE`、`ID`、`MPP`。
  - 对连续 post options 显示 range choices：`None`、`A`、`A-B`、`A-C` ... `A-G`。
  - Apply 后更新 keyword 行 suffix，并插入或调整 option card skeleton。

- [x] **步骤 2：hover 中加入命令链接**

  keyword hover 底部加入：

  ```markdown
  [$(list-selection) 选择关键字选项](command:extension.lsdynaChooseKeywordOptions?... )
  ```

  manual links 仍保留在同一个 hover Markdown 中。字段 hover 不默认插入 option 操作，避免遮挡字段文档；只在 keyword hover 提供入口。

- [x] **步骤 3：CodeLens 或 gutter 提示**

  推荐先做 CodeLens：

  - 在有 options 的 keyword line 上方显示 `LS-DYNA options: TITLE, ID, A-G`。
  - 点击打开 `extension.lsdynaChooseKeywordOptions`。

  可选做 gutter decoration：

  - 对有 options 的 keyword line 放轻量 icon。
  - decoration 只作提示，不依赖点击事件。

- [x] **步骤 4：右键菜单**

  `package.json` 的 `menus.editor/context` 添加命令，条件为 `editorLangId == 'lsdyna'`。命令内部自行判断当前行是否在 keyword block 下，避免复杂 context key 同步。

- [x] **步骤 5：保守编辑策略测试**

  覆盖：

  - `MAT_001` 选择 TITLE 后 keyword line 改为 `*MAT_001_TITLE` 并插入 TITLE 行。
  - `MAT_001_TITLE` 去掉 TITLE 时，如果 TITLE 行非空，弹出选择，不自动删除用户内容。
  - CONTACT 选择 F 后插入 A-F cards。
  - CONTACT 从 F 改为 C 时，D-F 非空则不自动删。

## 任务 6：中文 field_data 同步和翻译保护

**文件：**
- 修改：`keywords/field_data_zh.json`
- 创建：`keywords/validate_field_data_translation.py`
- 测试：`keywords/tests/test_field_data_translation.py`

- [x] **步骤 1：定义同步规则**

  `field_data_zh.json` 必须和 `field_data.json` 拥有完全相同的 key、card 数、option 数、field `n/p/w/t/d/e`。只允许 `h`、keyword/option 描述类文本不同。

- [x] **步骤 2：增加结构校验脚本**

  运行：`python keywords/validate_field_data_translation.py`
  预期：结构一致时 PASS；缺 key、缺 option、field 数不同时报错。

- [x] **步骤 3：生成 fallback**

  当新增英文 help 尚未翻译时，`field_data_zh.json` 先复制英文 `h`，保证 hover 不缺字段。翻译可以增量覆盖，不阻塞完整覆盖。

## 任务 7：性能、体积和回归验证

**文件：**
- 修改：`test/extension.test.js`
- 修改：`test/client/providers/phase7_features.test.js`
- 修改：`DEVELOPMENT.md` 或 `keywords/schema_model.md`

- [x] **步骤 1：记录生成规模**

  生成脚本输出：

  - raw kwd keyword count。
  - manifest-only keyword count。
  - alias count。
  - title variant count。
  - option-enabled keyword count。
  - snippets count。
  - field_data size。

- [x] **步骤 2：大文件保护回归**

  现有 `shouldSkipAutomaticDocumentScan()` 大文件跳过行为必须保持。resolver 不应在 hover/selection 高频路径重复 parse JSON。

- [x] **步骤 3：完整验证命令**

  ```bash
  python keywords/generate_from_pydyna.py pydyna/codegen/kwd.json
  python keywords/validate_field_data_translation.py
  npm test
  ```

  预期：全部通过。

## 验收样例

必须通过这些手工或自动检查：

- `*MAT_001_TITLE` 在关键字补全中出现，插入后包含 TITLE 行和 MAT_001 base card。
- 鼠标 hover `*MAT_001_TITLE` 的 TITLE 行，显示 `Additional title line`。
- `*SET_NODE` 通过校验、关键字 hover、字段 hover，内容等价于 `SET_NODE_LIST`。
- `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE` 的关键字 hover 显示 ID、MPP、A-G options。
- CONTACT 块中 base cards 后第 1 到第 6 张 optional data card 分别匹配 A 到 F；选择 F 的 snippet 自动包含 A-E。
- hover 中的 manual links 和 option command links 同时存在。
- `keywords/field_data_zh.json` 与 `field_data.json` 结构完全一致。

## 风险与处理

- **pydyna codegen 依赖不完整：** 本地直接 import `generate.py` 会因为缺 `beartype` 失败。实现 adapter 时只导入 `keyword_generation` 子模块；若 CI 需要完整 pydyna codegen，再补 dev dependency。
- **title variants 组合膨胀：** 只对 `title_order > 0` 生成组合，并设置组合上限。CONTACT A-G 这种 `title_order=0` 不生成真实关键字变体。
- **CONTACT 行数推断歧义：** 空白行、注释行不计为数据 card；当前光标在空行时按“将要填写的下一张 card”解析，保证补全可用。
- **删除 option card 的破坏性：** 自动删除只作用于空行或扩展生成的空模板；非空用户数据必须保留或由用户显式确认。
- **旧 `field_data_zh.json` 失配：** 加结构校验和英文 fallback，避免中文版本落后导致 hover 崩溃。

## 后缀清理评估

完成基于 pydyna `TITLE`、`HEADING`、`ID`、`ID_TITLE` 等 title-order option 的真实关键字变体生成后，编辑器运行时不应再依赖“先去掉 `_TITLE` 之类后缀再回退到 base keyword”的特判逻辑。原因是这些后缀现在已经是 schema 可理解的结构语义：

- **关键字拼写检测：** 不需要 stripping。validator 应直接检查生成后的 schema key、alias key 和自定义白名单；`*MAT_001_TITLE` 这类真实变体应被精确接受，而 `*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F` 这类仅用于 snippet 选择的伪后缀不应因为剥离成 base keyword 而误判合法。
- **关键字 hover：** 不需要 stripping。keyword hover 应调用 `lookupKeywordSchema()`，由 schema resolver 返回 canonical keyword 和 active options，再渲染当前变体的 card sequence。找不到 schema 时，只能进入 manual-link fallback，不应把未知后缀静默解释成 base keyword。
- **field 区域检测、补全、格式化和 Tab 对齐：** 不需要 stripping。`getCardForDocumentLine()` 应根据 keyword 行、active title options 和已观察到的数据行数生成实际 card sequence；TITLE 行、ID/HEADING 行以及 CONTACT optional cards 都是普通 card，不再是需要跳过或手动偏移的特殊行。
- **手册书签匹配：** 仍可保留 stripping。PDF bookmark 往往只索引 base keyword 或旧式 `_TITLE` bookmark，`manualIndexer.cleanKeyword()` 中的 `stripTitleSuffix()` 属于外部手册索引归一化，不参与 schema/field/validation 判定。若以后要移除它，需要先用 schema canonicalization 替代，并保留 manual bookmark fallback 测试。

因此当前推荐状态是：`hasTitleSuffix()` 可视为历史遗留的候选删除项；`stripTitleSuffix()` 暂时保留给 manual indexer 使用，但不要重新引入到 keyword validation、hover schema lookup 或 field card resolver 中。

## 推荐执行顺序

1. 先完成任务 1 和任务 2，只改变生成产物和生成测试。
2. 再完成任务 3，把运行时查询统一起来，但保持 UI 行为不变。
3. 完成任务 4，使 hover/completion/format/validation 真正使用增强 schema。
4. 最后完成任务 5 的 option 更新 UI，因为它依赖前面 resolver 稳定。
5. 任务 6 和任务 7 跟随每个阶段持续运行，避免生成产物结构漂移。
