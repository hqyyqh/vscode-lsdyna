# Curve/Table 字段 Hover 可视化验证记录

**日期：** 2026-06-24

## 验证范围

验证 curve/table 字段引用 JSON 索引、`*DEFINE_CURVE*` / `*DEFINE_TABLE*` 定义扫描、FileIndex/ProjectSnapshot 缓存、Hover Markdown/SVG 预览、当前文件降级预览、目录树扫描提示和定义跳转链接。

## 验证结果

- `npm test`：退出码 0，361 passing。
- `npm run test:scanner-benchmark`：退出码 0，1 passing；10MB deck skeleton benchmark 1378ms。
- `npx mocha --require test/register-out.js test/core/references/*.test.js`：退出码 0，15 passing。
- 慢路径搜索：`rg -n "readFileSync\\(|createReadStream\\(|scanKeywordSkeletonFromFile\\(|buildProjectIndex\\(" src/core/references src/extension.ts` 只命中 `src/extension.ts` 的 snippet 读取；引用 Hover 路径没有 `buildProjectIndex()`、`scanKeywordSkeletonFromFile()` 或项目级磁盘扫描。

## 字段引用索引

- `keywords/field_reference_index.json` 由 `scripts/generate-field-reference-index.cjs` 从 `keywords/field_data.json` 和 `keywords/field_reference_overrides.json` 生成。
- 生成结果覆盖 1490 个 keyword 的 curve/table 字段引用。
- `MAT_PIECEWISE_LINEAR_PLASTICITY` card 2 的 `LCSS` 显式识别为 `curve/table`，`MID` 不进入引用索引。
- 负整数引用默认按 signed switch 处理，Hover 用绝对值查找定义并保留原始负号提示。

## DEFINE_CURVE/TABLE 关键字分级

已扫描 schema 中 50 个 `DEFINE_CURVE*` / `DEFINE_TABLE*` 关键字。

可绘制或可展示：

- `DEFINE_CURVE`
- `DEFINE_CURVE_FUNCTION`
- `DEFINE_CURVE_FUNCTION_TITLE`
- `DEFINE_CURVE_TITLE`
- `DEFINE_TABLE`
- `DEFINE_TABLE_2D`
- `DEFINE_TABLE_2D_TITLE`
- `DEFINE_TABLE_3D`
- `DEFINE_TABLE_3D_TITLE`
- `DEFINE_TABLE_TITLE`

仅索引位置、暂不保证绘制：

- `DEFINE_CURVE_3858`
- `DEFINE_CURVE_3858_TITLE`
- `DEFINE_CURVE_5434A`
- `DEFINE_CURVE_5434A_TITLE`
- `DEFINE_CURVE_BOX_ADAPTIVITY`
- `DEFINE_CURVE_BOX_ADAPTIVITY_TITLE`
- `DEFINE_CURVE_COMPENSATION_CONSTRAINT_BEGIN`
- `DEFINE_CURVE_COMPENSATION_CONSTRAINT_BEGIN_TITLE`
- `DEFINE_CURVE_COMPENSATION_CONSTRAINT_END`
- `DEFINE_CURVE_COMPENSATION_CONSTRAINT_END_TITLE`
- `DEFINE_CURVE_DRAWBEAD`
- `DEFINE_CURVE_DRAWBEAD_TITLE`
- `DEFINE_CURVE_DUPLICATE`
- `DEFINE_CURVE_DUPLICATE_TITLE`
- `DEFINE_CURVE_ENTITY`
- `DEFINE_CURVE_ENTITY_TITLE`
- `DEFINE_CURVE_FEEDBACK`
- `DEFINE_CURVE_FEEDBACK_TITLE`
- `DEFINE_CURVE_FLC`
- `DEFINE_CURVE_FLC_TITLE`
- `DEFINE_CURVE_FLD_FROM_TRIAXIAL_LIMIT`
- `DEFINE_CURVE_FLD_FROM_TRIAXIAL_LIMIT_TITLE`
- `DEFINE_CURVE_SMOOTH`
- `DEFINE_CURVE_SMOOTH_TITLE`
- `DEFINE_CURVE_STRESS`
- `DEFINE_CURVE_STRESS_TITLE`
- `DEFINE_CURVE_TRIAXIAL_LIMIT_FROM_FLD`
- `DEFINE_CURVE_TRIAXIAL_LIMIT_FROM_FLD_TITLE`
- `DEFINE_CURVE_TRIM`
- `DEFINE_CURVE_TRIM_2D`
- `DEFINE_CURVE_TRIM_2D_TITLE`
- `DEFINE_CURVE_TRIM_3D`
- `DEFINE_CURVE_TRIM_3D_TITLE`
- `DEFINE_CURVE_TRIM_NEW`
- `DEFINE_CURVE_TRIM_NEW_TITLE`
- `DEFINE_CURVE_TRIM_TITLE`
- `DEFINE_TABLE_COMPACT`
- `DEFINE_TABLE_COMPACT_TITLE`
- `DEFINE_TABLE_MATRIX`
- `DEFINE_TABLE_MATRIX_TITLE`

## LS-DYNA 语义样例

- 当前文件 FileIndex 中已有 `*DEFINE_CURVE` ID 时，Hover 可直接展示曲线预览，不要求目录树扫描完成。
- 跨文件定义来自手动目录树/关键字扫描后的 `ProjectSnapshot.fileIndexes`，Hover 只查询内存 Map。
- `*DEFINE_TABLE_2D` Hover 展示 `value -> curve ID` 表格，并在子 curve 已解析时提供 child definition 链接。
