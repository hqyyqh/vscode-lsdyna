# DynaSense public source development

Node.js 22 and Python 3.12 or newer are required.

The public `dev` branch receives reviewed final source; `master` is the stable release branch.

公开 `dev` 分支接收经审查的最终源码，`master` 为稳定发布分支。

Run inside the candidate:

```sh
npm ci
npm run build
npm run check:contracts
npm test
npm run test:webview
npm run check:field-data-zh
npm run check:native-help-zh
npm run check:manual-semantics-zh
npm run package
```

`public-source-manifest.json` lists each included file, its SHA-256 and purpose.
The private report lists each omitted maintenance file and its reason. Public builds verify the exact
set and bytes of final data before generating field schema/help and copying the
verified Input Form runtime manifest. They do not perform native collection or
replay internal extraction. Product language, registration, geometry, runtime
permission and shard-integrity checks remain required. Internal producer replay
remains a separate gate in the complete maintenance checkout; passing a public build does not certify a new
producer or authorize a data update.

公开清单逐文件记录保留内容、SHA-256 和用途；内部报告列出省略的维护文件及原因。公开构建
先验证最终数据文件集合和字节，再生成字段 schema、帮助分片并复制已核验的表单清单。
语言、命令注册、字段位置、运行时权限和分片完整性仍须检查。内部生产者复验继续在
完整维护工作区中执行；公开构建通过不能替代生产者复验，也不授权更新数据来源。

Mixed tests must retain product behavior assertions. For standard and tail repeat
records, public fixtures preserve observed field geometry, input decks, formats
and counts; maintenance-only fixture source checks independently
compare the fixtures against verified native evidence in the complete maintenance checkout. Removing an
internal replay from a public candidate is not permission to remove reading,
editing, reopening, comment preservation or refusal-condition tests.

混合测试必须保留产品行为断言。标准重复记录和尾部重复记录的公开 fixture 保留已观察
的字段位置、输入文件、格式及记录数；内部来源测试在完整维护工作区中对照已核验的原生证据。
省略内部复验不意味着可以删除读取、修改、重新打开、注释保留或拒绝修改的测试。

Any retained extraction archive is explicitly listed in the private report;
`acceptance.unresolvedInternalEvidenceCount` records the count. The candidate remains
`unverified-boundary` until those mixed consumers are separated and revalidated.
Do not mark such a candidate ready for distribution. No commit, push, tag or
publication is performed by export.

The relaxed-model behavior fixture has a distinct public manifest identity. Export
omits only its five production-path fields, retains all sixteen shard bytes,
records, policy and population checks, and recomputes the actual manifest and
content hashes. An internal source proof validates the original fixed identity
and the inverse transformation. `acceptance.independentlyProjectedBehaviorFixtureCount`
records its seventeen files separately from collection archives. Public builds
have no implicit private sibling root. Explicit `DYNASENSE_RELAXED_MODEL_ROOT`
configuration still accepts either the original or public fixed identity tuple;
mixed hashes, changed policy or damaged shards fail closed. Neither identity
authorizes runtime semantics or editing, and callers cannot override expected hashes.

仍被混合测试依赖的提取档案逐项列在内部报告中，公开清单只记录其数量；在拆分
消费者并完成复验前，候选状态为 `unverified-boundary`，不能视为对外分发已验收。
导出不会提交、推送、打标签或发布。

relaxed-model 行为 fixture 使用独立的公开 manifest 身份。导出只省略五个生产路径字段，
保留全部十六个分片字节、记录、策略及数量校验，并真实重算 manifest 和内容摘要。
内部来源证明复验原始固定身份及逆变换；`acceptance.independentlyProjectedBehaviorFixtureCount`
单独记录其十七个文件。公开构建取消隐式私有同级目录，显式配置
`DYNASENSE_RELAXED_MODEL_ROOT` 仍可读取原始或公开的固定身份组合；摘要混配、策略变化
或分片损坏都拒绝使用。两种身份都不授权运行时语义或编辑，调用方不能覆盖预期摘要。

## Mandatory language acceptance — 信达雅

This is a blocking acceptance condition for all future user-facing changes, not
optional copy polishing. Functional tests alone cannot establish language quality.
Apply it to commands, settings, status/tooltips, diagnostics, dialogs, all four
Webviews, accessible names, generated field/option help and user documentation.
Technical identifiers, source quotations and logs have different purposes; do not
translate identifiers or silently rewrite authoritative technical content.

### 信 — faithful engineering and behavior

- Confirm each message against its caller, actual action, affected scope and state.
  Preserve conditions, negation, uncertainty, units, signs, values, defaults and
  editing restrictions. Chinese and English must convey the same commitments.
- Distinguish main deck from load case; keyword occurrence from entity reference;
  card from physical line or data record; unsupported/unverified from invalid;
  discarding unapplied drafts from Undo and restoring default values.
- Do not call a plugin check a solver guarantee. A local rule, partial scan or
  candidate match must not be described as a complete verification.
- Preserve keyword spellings, field IDs, option tokens, formulas, links, command
  IDs and numeric/named placeholders. Keep package provenance and internal rule
  metadata out of ordinary UI; retain required licenses and integrity checks.

### 达 — native, actionable language

- Write each language naturally instead of mirroring the other's word order.
  Explain errors as what happened, the relevant consequence (including whether
  edits occurred), and an available next action. Do not invent a recovery action.
- Use action verbs for controls. Name destructive actions and their scope. Use
  concise labels plus contextual explanations; do not expose runtime/planner,
  spelling, predicate, exactly-once or similar implementation terms as normal UI.
- All visible and accessible text, including initial loading and error states,
  must follow the documented locale behavior. VS Code manifest language and
  plugin runtime language are separate mechanisms; never promise otherwise.
- Check English counts at 0, 1 and many; avoid forms such as "1 fields". Check
  Chinese measure words, punctuation and accidental spaces between Chinese words.
  Use sentence case for runtime UI; match VS Code conventions for command titles.

### 雅 — restrained, consistent presentation

- Prefer precise, plain engineering language over decorative, literary or
  promotional wording. Use a consistent name for the same feature across commands,
  views, tooltips, messages, documentation and accessibility labels.
- Verify complete action labels and understandable error messages in actual DOM
  at narrow widths and enlarged text. Full names/paths may truncate only with an
  accessible way to inspect them; do not hide critical conditions or data loss.
- Preserve established industry terms from the field translation guide below.
  Product glossary additions require context review, not global text replacement.

### Product terminology baseline

| Meaning | Chinese | English | Boundary |
| --- | --- | --- | --- |
| LS-DYNA keyword | 关键字 | keyword | Do not alternate with 关键词 for the same LS-DYNA concept. |
| Complete keyword file/deck | 关键字文件 / 输入文件 | keyword deck / input deck | Use 主文件 / main deck for the selected root, not load case. |
| Include file | 引用文件 | include file | Explain project scope as 主文件及其引用文件; do not show Include 闭包. |
| Keyword occurrence | 关键字实例 / 出现位置 | keyword instance / occurrence | Does not imply that an ID references another entity. |
| Card / field | 卡片 / 字段 | card / field | 数据记录 / data record and 物理行 / physical line remain distinct. |
| Generic model entity | 对象（首次必要时：模型对象） | entity | Use 节点、单元、部件、材料、集合 when the type is known; 实体单元 means solid element. |
| Reference result | 对象引用 | entity references | Use one feature name; do not alternate Object References / Entity References. |
| Unapplied change | 未应用的修改 | unapplied changes | A draft is not necessarily an unsaved document edit. |
| Read-only state | 只读 | read-only | Say what cannot be edited and why; do not imply the file is invalid. |
| Return a draft field to its source value | 还原字段 | revert field | Not default reset or document-wide Undo. |
| Manual supporting a rule | 手册依据 / 对应手册页 | manual reference / relevant manual page | Avoid evidence or provenance jargon in the ordinary action label. |

The engineering vocabulary and protected-token rules in
[the field translation guide](docs/field-data-zh-translation-guide.md) also apply.
This baseline defines the target vocabulary; it does not certify legacy UI as
already compliant. Context-specific official terms take precedence over blind
replacement (for example, a search term can legitimately be called 关键词).

### Required acceptance evidence

For every affected feature, record the following in the change/release evidence:

- The changed surfaces/keys and paired Chinese/English copy; caller/behavior checked.
- A separate Chinese naturalness review and English naturalness review, plus the
  LS-DYNA terminology/semantic review. An AI review must not be represented as
  independent review by a native speaker or an LS-DYNA engineer.
- Locale scenarios: VS Code zh-cn/en × plugin auto/zh-cn/en, including initial
  loading, empty/error/read-only/stale/destructive states as applicable. Check
  singular/plural counts and complete accessible action names.
- Actual DOM/screenshots for changed layouts at 360/480 px (sidebar 240/320 px),
  normal/enlarged text and supported themes; preserve existing wider/functional checks.
- `npm run check:contracts` for locale keys, duplicates and numeric/named
  placeholders; relevant frontend/host regression. For help-data changes also run
  the translation/content checks in the field translation guide.
- Explicit pass/fail/unverified results and remaining issues. Structural checks do
  not prove naturalness or technical fidelity. Do not mark the affected work ready
  for acceptance with unresolved semantic ambiguity, language mismatch, truncated
  critical copy or missing verification. Do not silence checks or shrink review
  scope to obtain a pass. Unaffected legacy findings remain tracked; changes that
  touch them must resolve them, and an overall language-quality release sign-off
  requires all blocking findings to be closed.
