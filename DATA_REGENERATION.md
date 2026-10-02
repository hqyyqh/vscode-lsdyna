# Data regeneration / 数据重生成

## Public data workflow / 公开数据流程

Public engineering data is maintainable from committed inputs without a native
executable, licensed manual, or private sibling checkout. The published logical
checkpoints preserve the released baseline; authoring inputs express reviewed
translations and local corrections. Current runtime artifacts are deterministic
projections of both, with their actual hashes recorded in current lineage.

公开工程数据可从已提交的输入维护，不需要原生程序、受许可约束的手册或私有同级工作区。
已发布的逻辑检查点保存发布基线，作者输入表达经审查的翻译和本地修正；当前运行时产物
由两者确定性生成，当前来源记录绑定其真实摘要。

| Directory / 目录 | Responsibility / 职责 |
| --- | --- |
| `keywords/sources/` | Versioned source checkpoints; preserve original identity / 带版本的来源检查点，保留原身份 |
| `keywords/authoring/` | Translations, compatibility rules and local correction inputs / 翻译、兼容规则与本地修正输入 |
| `keywords/runtime/` | Generated engineering runtime / 生成的工程运行时 |
| `keywords/provenance/` | Historical source declarations and current generation lineage / 历史来源声明与当前生成记录 |
| `keywords/authoring/engineering/*Corrections.json`, `keywords/authoring/engineering/keywordSpellingAliases.json` | Source-locked engineering rules / 与来源记录绑定的工程规则 |

The four engineering rule JSON files are authoring inputs. Ordinary regression
fixtures, localized package text and maintenance tools remain editable. Original
proofs and the 17-file `test/fixtures/relaxed-model-v1/` fixture retain their historical
identity; add new regression cases rather than rewriting that evidence.

四个工程规则 JSON 是作者输入。普通回归样例、本地化源码和维护工具仍可编辑。
原始证明和包含 17 个文件的 `test/fixtures/relaxed-model-v1/` 样例保留历史身份；
新增回归案例时不要覆写这些证据。

Translation and help edits use the ordinary deterministic workflow below. The four
engineering rule inputs are also reviewable, but changes to layout, type, source
matching, relations or editing permission cannot inherit an earlier native/PDF
approval. Their authority-bearing content must match the protected approved
checkpoint. A change requires an independently reviewed, versioned source import;
until then the compiler reports `requires-independent-validation` and rejects it.
Do not edit a checkpoint hash or role to bypass this check.

翻译和帮助内容修改使用下方常规确定性流程。四个工程规则输入也可提交审查，但布局、
类型、来源匹配、关联或编辑权限的变更不能沿用旧原生或 PDF 审批。涉及权限的内容必须
与受保护的已审批检查点一致；变更须经过独立审查后导入新的带版本来源。在此之前，
编译器标记 `requires-independent-validation` 并拒绝构建。不要修改检查点摘要或职责
来绕过检查。

Root `notes` in an engineering rule is editorial authoring content. It may be edited
without changing authority; the generated runtime omits it so existing correction
matching and permissions remain unchanged. JSON formatting changes also preserve
the same authority content.

工程规则根对象的 `notes` 是说明性作者内容，可在不改变权威规则的情况下修改。
生成的运行时不包含该说明，确保已有修正匹配与权限保持一致。JSON 排版修改同样
不会改变权威内容。

```bash
npm ci
python -m pip install -r requirements-dev.txt
npm run build
npm run data:build
npm run data:update
npm run data:check
npm run update:source-manifest -- --write
npm run update:source-manifest -- --check
```

In PowerShell, use `npm.cmd run update:source-manifest -- --write` and
`npm.cmd run update:source-manifest -- --check` if the npm PowerShell shim consumes
the forwarded arguments. The equivalent direct entry is
`node scripts/release/update-source-manifest.cjs --write` or `--check`.

在 PowerShell 中，若 npm 的 PowerShell 包装脚本吞掉转发参数，请使用
`npm.cmd run update:source-manifest -- --write` 或 `--check`。等价的直接入口为
`node scripts/release/update-source-manifest.cjs --write` 或 `--check`。

`data:build` creates a staging build. `data:update` publishes current generated
artifacts and their lineage after validation; it does not refresh original source
snapshots. `data:check` rebuilds in two fresh stages, compares both generations and
the committed runtime, and fails on drift. Do not hand-edit a generated artifact or
refresh a hash to hide a stale build.

`data:build` 创建暂存构建。`data:update` 在验证后更新当前生成产物及其来源记录，
不会刷新原始来源快照。`data:check` 在两个新暂存目录中重建，对比两次生成和已提交
运行时，发现偏差即失败。不要手改生成产物，也不要刷新摘要来掩盖过期构建。

The source manifest has four roles: `editable-source`, `authoring-input`,
`generated-artifact`, and `source-snapshot`. Its updater checks the public inventory,
snapshot identity and deterministic data before atomically writing current hashes.
It neither issues native-source certification nor replaces historical acceptance.
Unknown engineering data fails closed until its authoring/compiler boundary is defined.

源码清单使用四种职责：`editable-source`、`authoring-input`、
`generated-artifact` 和 `source-snapshot`。更新器先核对公开文件集合、快照身份
和确定性数据，再原子写入当前摘要；它不签发原生来源认证，也不替代历史验收。
未声明职责的工程数据必须先明确作者输入及编译边界，才能纳入项目。

A data pull request includes authoring inputs, generated outputs, lineage, and a
behavior regression case. Preserve source-record matching guards, numeric branches,
physical coordinates, tokens, formulas and safe-editing restrictions. Run the
translation/content checks and the normal public CI suite. A local correction must
identify its actual basis and must not inherit an upstream EXE/PDF verification claim.

数据拉取请求应包含作者输入、生成输出、来源记录和行为回归案例。保留来源记录匹配
条件、数值分支、物理坐标、标识、公式及安全编辑限制，并执行翻译内容检查和常规公开 CI。
本地修正须说明真实依据，不能沿用上游 EXE/PDF 已验证的声明。

A new external source version is a separate reviewed import: retain the old snapshot,
record the real source revision and redistribution permission, and import into a new
versioned location. Existing published native/manual baselines do not imply that the
private collection process is available publicly. Missing original authoring inputs
must not be reconstructed and presented as the original source. External producer replay remains a separate maintainer review.

新增外部来源版本需要单独审查导入：保留旧快照，记录真实版本及再分发许可，导入新的
带版本路径。已发布的原生或手册基线不表示私有采集流程已公开；不能从最终数据反推
缺失作者输入，再冒充原始来源。外部生产者复验另由维护者审查。

