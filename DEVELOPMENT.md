# DynaSense public source development / 公开源码开发

Node.js 22 and Python 3.12 or newer are required. / 需要 Node.js 22 和 Python 3.12 或更新版本。

The public `dev` branch accepts reviewed contributions; `master` is the stable release branch.

公开 `dev` 分支接收经审查的贡献，`master` 为稳定发布分支。

## Public contribution workflow / 公开贡献流程

Read [CONTRIBUTING.md](CONTRIBUTING.md) for public setup, F5 debugging and pull
request checks. Contributions branch from public `dev`. Shared `.vscode/` tasks build
all four Webviews and the extension before launching the Extension Development Host.
Public data authoring, deterministic generation and source inventory maintenance are
documented in [DATA_REGENERATION.md](DATA_REGENERATION.md#public-data-workflow--公开数据流程).

公开安装、F5 调试和拉取请求检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。贡献分支
从公开 `dev` 创建；共享 `.vscode/` 任务在启动扩展开发宿主前构建全部四个 Webview
和扩展。公开作者数据、确定性生成与源码清单维护见 [DATA_REGENERATION.md](DATA_REGENERATION.md)。

The public CI builds and inspects one candidate VSIX, then installs that same package
on Windows, Linux and macOS with VS Code 1.100.0 and 1.139.1. Its manual renderer
case uses an original synthetic fixture, not an official licensed manual. Installed
package checks record actual identity and behavior; an existing or copied package
cannot certify a new source build. Missing environments and independent bilingual
review remain unverified even when automated CI passes.

公开 CI 构建并检查一份候选 VSIX，再将同一份包安装到 Windows、Linux 和 macOS，
分别使用 VS Code 1.100.0 与 1.139.1。手册渲染检查使用原创合成样例，不代表对
受许可约束的官方手册完成验收。安装包检查记录实际身份和行为；已有包或复制的包
不能认证新的源码构建。即使自动 CI 通过，缺少环境或独立双语审查的项目仍为未验证。



Run inside the candidate:

```sh
npm ci
python -m pip install -r requirements-dev.txt
npm run build
npm run data:check
npm run update:source-manifest -- --check
npm run check:contracts
npm test
npm run test:webview
python -m unittest discover -s test/scripts/build/keywords -p "test_*.py" -v
npm run check:field-data-zh
npm run check:native-help-zh
npm run check:manual-semantics-zh
npm audit
npm run package
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for F5 and review requirements, and
[DATA_REGENERATION.md](DATA_REGENERATION.md) for editable engineering data.
The four-role manifest records the complete public inventory and actual bytes.
Its updater can accept source changes, local authoring changes and verified
deterministic output; it cannot change an original snapshot or manufacture new
native-source certification. Boundary checks scan current files, including newly
added source not yet listed in the manifest.

F5 与审查要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，工程数据维护见
[DATA_REGENERATION.md](DATA_REGENERATION.md)。四职责清单记录完整公开文件集合
及真实字节。更新器可接收源码、本地作者数据和经确定性重建核验的输出，但不能改写
原快照或制造新的原生来源认证。边界检查扫描当前文件，包括尚未写入清单的新增源码。

A public projection has its own real content identity. Source quotations, required
licenses, engineering behavior, permission limits and old source identities remain
truthful. Original protected evidence is retained internally; the private inverse
ledger proves the transformation. The relaxed-model public fixture retains all 16
shard bytes and has a distinct, statically pinned manifest identity. The 17-file
fixture is preserved as evidence; ordinary regression fixtures remain editable.

公开投影具有独立且真实的内容身份。来源引文、必要许可、工程行为、权限限制及原来源
身份必须保持真实。受保护的原始证据在内部完整保留，私密逆向记录验证转换。
relaxed-model 公开行为样例保留全部 16 个分片字节，使用独立且静态绑定的清单身份。
包含 17 个文件的样例作为证据保留；普通回归样例仍可编辑。

Source export records `requires-independent-validation` until the candidate is
independently built and checked. CI packages one real candidate and exercises that
same VSIX on the three-platform, two-version host matrix. The manual renderer uses
an original synthetic fixture; it does not certify an official manual. Record
actual passed, failed and unverified results. Export, package creation, local
validation and pull requests do not perform or authorize a push, stable merge,
tag or release.

在独立构建和验证前，导出记录 `requires-independent-validation`。CI 打包真实候选，
在三个平台及两个版本的宿主矩阵中使用同一份 VSIX。手册渲染使用原创合成样例，不认证
官方手册。应记录实际通过、失败和未验证结果。导出、打包、本地验证和拉取请求不执行
或授权推送、稳定分支合并、打标签或发布。


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
