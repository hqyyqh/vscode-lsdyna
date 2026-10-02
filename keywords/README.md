# Keyword data / 关键字数据

This tree separates source identity, contributor inputs, generated runtime and
generation evidence. Build tools live in `scripts/build/keywords/` and
`scripts/build/`; their Python tests live in `test/scripts/build/keywords/`.

此目录分别保存来源身份、贡献者输入、生成的运行时数据和生成证据。构建工具位于
`scripts/build/keywords/` 与 `scripts/build/`；Python 测试位于
`test/scripts/build/keywords/`。

| Directory / 目录 | What belongs here / 内容 |
| --- | --- |
| `sources/` | Published logical checkpoints and original authoring handoffs; their manifest binds compressed and decoded SHA-256. / 已发布的逻辑检查点与原始作者交接记录，清单绑定压缩字节及解码内容的 SHA-256。 |
| `authoring/` | Chinese translations, reviewed compatibility records, explicit English help corrections and four engineering rule inputs. / 中文翻译、已审查的兼容记录、显式英文帮助修正与四个工程规则输入。 |
| `runtime/` | Generated schema, native help/readers, Input Form, references, definition registry/scanners, manual semantics, structure grammars and semantic catalogs. / 生成的模式、原生帮助与读取器、输入表单、引用、定义注册表与扫描器、手册语义、结构语法及语义目录。 |
| `provenance/` | Original source declarations and current local generation lineage. / 原始来源声明与当前本地生成记录。 |

Start with the [public data workflow](../DATA_REGENERATION.md). After installing
the locked dependencies, run the following commands from the repository root:

先阅读[公开数据流程](../DATA_REGENERATION.md)。按锁文件安装依赖后，在项目根目录运行：

```sh
npm run compile
npm run data:build
npm run data:update
npm run data:check
npm run update:source-manifest -- --write
```

`data:build` rebuilds twice into separate temporary directories and publishes a
staging tree in `out/data-build/`. It does not edit authoring inputs or tracked
runtime data. `data:update` validates the same two builds before replacing
generated artifacts and `provenance/current-data.json`; a failed replacement
restores the previous tracked files. `data:check` also compares the rebuilt
artifacts and lineage with the checkout. The source manifest updater applies only
to an exported public checkout.

`data:build` 在两个独立临时目录中重建，将暂存结果写入 `out/data-build/`，不修改
作者输入或已跟踪的运行时数据。`data:update` 验证同样的两次构建后更新生成产物及
`provenance/current-data.json`；替换失败时恢复此前的已跟踪文件。`data:check` 还将
重建产物及来源记录与当前检出内容比较。源码清单更新器只适用于导出的公开工作区。

For an English help correction, add an entry to
`authoring/field-help-corrections.json` with the exact keyword, zero-based card
index, field name, SHA-256 of the original English help and revised English text.
The compiler rejects unknown properties, duplicate fields and source drift.
This input changes help text; it does not grant layout, reference, diagnostic or
native write permission. Chinese text belongs in the three translation files.
The four engineering JSON files in `authoring/engineering/` remain explicit,
source-matched authoring rules. The compiler generates their runtime projections
under `runtime/engineering/`; the product consumes those generated resources.

Their protected approved-rule baseline is a derived logical checkpoint, not a
new PDF or EXE certificate. Whitespace and a root `notes` property are editable;
the authority-bearing records, sources, selectors and permissions must match the
reviewed baseline. A changed field width/type, reference target, source evidence
or permission fails with `requires-independent-validation` before runtime
publication. A new reviewed version must retain the previous checkpoint, record
real validation evidence and update `sources/manifest.json.engineeringAuthorityInput`
as a maintainer source import. Ordinary data or source-manifest updates do not
perform that review.

修正英文帮助时，在 `authoring/field-help-corrections.json` 中填写精确关键字、从零
开始的卡片索引、字段名、原英文帮助的 SHA-256 和修订文本。编译器拒绝未知属性、
重复字段及来源漂移。此输入只修改帮助文本，不授予布局、引用、诊断或原生写入权限。
中文文本放入三个翻译文件。`authoring/engineering/` 中的四个工程 JSON 仍是与来源
精确匹配的作者规则。编译器生成 `runtime/engineering/` 下的运行时投影；产品读取
这些生成资源。

受保护的已审批规则基线是派生逻辑检查点，不是新 PDF 或 EXE 证书。空白排版及根节点
`notes` 属性可以编辑；具有权威意义的记录、来源、选择器与权限须匹配已审查基线。
修改字段宽度或类型、引用目标、来源证据或权限时，运行时发布前以
`requires-independent-validation` 失败。新的已审查版本须保留此前检查点、记录真实
验证证据，并由维护者执行来源导入，更新 `sources/manifest.json.engineeringAuthorityInput`
选定的基线；常规数据和源码清单更新不承担该审查。

Source checkpoints preserve the content approved for their recorded source
version. Changing a compatibility layout, native rule or external source is a
separate reviewed source import with independent validation. Editing a hash or
running `data:update` cannot transfer an old approval to changed content. The
current lineage records actual input/tool/output hashes and reports external
EXE/PDF producer replay as **unverified** when it has not run.

Current rebuild evidence binds the real implementation commit, committed compiler
sources, source checkpoint identities and newly generated artifacts. It proves
the local rebuild gates that actually ran. Original native/manual approvals
remain approvals of their original content; the rebuild evidence does not renew
them, certify an external producer or transfer their permissions to edited data.

来源检查点保留其记录版本已获审批的内容。修改兼容布局、原生规则或外部来源，需要
单独审查的来源导入与独立验证。编辑摘要或运行 `data:update` 都不能将旧审批转移给
改动后的内容。当前来源记录绑定真实输入、工具和输出摘要；未执行外部 EXE/PDF
生产者重放时，该项明确为**未验证**。

当前重建证据绑定真实实现提交、已提交的编译器源码、来源检查点身份及新生成产物，
只证明实际执行的本地重建验收。原生和手册的旧审批仍只对应其原内容；重建证据不续签
这些审批，不认证外部生产者，也不将旧权限转移给修改后的数据。

The portable manual compiler retains the approved source selectors. It rechecks
that each field still binds to the same card, field index, name and type; any
different position/width computed by the current renderer is recorded as
`requires-independent-validation`. It does not silently replace approved source
geometry or issue a new certificate.

可移植手册编译器保留已审批的来源选择器，并复核字段仍对应同一卡片、字段索引、名称
与类型。当前渲染器推导的起始位置或宽度如有差异，记录为
`requires-independent-validation`；不静默替换已审批的来源几何，也不签发新证书。

Internal historical originals live in
`test/evidence/historical/9c8eaef2471b/root/` with their original relative layout
and bytes. This includes the 394 legacy templates, 29 superseded Input Form
shards and old `process_keywords.py`. They are excluded from public exports and
current build inputs. Historical replay uses that explicit snapshot and retains
the original evidence identities; current data never falls back to it. The
snapshot does not claim complete historical execution when old source/build
artifacts or external producer inputs are absent.

内部历史原件位于 `test/evidence/historical/9c8eaef2471b/root/`，保留原相对布局与
字节，包括 394 个旧模板、29 个被替代的输入表单分片及旧 `process_keywords.py`。
它们不进入公开导出或当前构建输入。历史重放使用此显式快照，保留原证据身份；当前
数据不回退读取历史结果。缺少旧源码、构建产物或外部生产者输入时，快照不声称已
完成完整历史执行。
