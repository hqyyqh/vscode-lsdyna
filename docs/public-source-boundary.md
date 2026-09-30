# Public source development / 对外源码开发

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
