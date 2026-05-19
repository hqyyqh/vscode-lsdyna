# Include Tree 问题分析记录

日期：2026-05-18

## 背景

本次针对 VS Code LS-DYNA 扩展的 Include Tree 做了两项深度分析与修复：

1. 精确 `*INCLUDE` 关键字下，合法的多文件列表只识别第一项。
2. 在大型工程中执行 `extension.scanIncludeTree` 时，可能抛出 `Cannot create a string longer than 0x1fffffe8 characters`。

## 复现输入

### 问题 1：多文件 `*INCLUDE`

```text
*INCLUDE
a.key
b.key
c.key
```

修复前只会识别 `a.key`。

### 问题 2：大型工程扫描

当 Include Tree 递归扫描大量 deck 文件，或者某些 deck 文件本身非常大时，命令会因为整文件读入并拼接字符串而失败。

## 根因

### 根因 1：`*INCLUDE` 解析规则过窄

在 [src/extension.js](../../src/extension.js) 中，原始 `findIncludeFileLines()` 将精确 `*INCLUDE` 固定为“只读取第一张数据卡”。这会导致同一 `*INCLUDE` 块中的后续文件名全部被忽略。

同时，原始续行逻辑会直接把下一物理行拼到文件名后面，没有跳过注释行，因此像下面这样的合法内容会被错误拼接：

```text
*INCLUDE
part_a +
$ skip me
part_b.key
```

### 根因 2：Include Tree 递归扫描采用整文件字符串读入

在 Include Tree 构建和共享 include 遍历中，原始逻辑对每个 deck 文件执行 `fs.readFileSync(filePath, 'utf8')`，然后再 `split('\n')` 做解析。对大型工程或超大 deck 文件，这会把整文件内容放进单个 JavaScript 字符串，触发运行时字符串长度上限。

## 解决方案

### 已实施

1. 新增共享的 include 指令状态机解析器。
2. 将精确 `*INCLUDE` 改为支持块内多个文件项。
3. 续行解析现在会跳过注释与空行，直到收集到完整逻辑文件名。
4. `getSearchPath()` 改为复用同一套解析状态机，避免文档侧规则分叉。
5. Include Tree 的磁盘扫描改为基于 `fs.createReadStream()` + `readline` 的增量解析，不再对 deck 文件执行整文件 `readFileSync(..., 'utf8')`。
6. Include Tree 扫描失败时会降级为树节点提示，而不是直接让命令抛出未处理异常。

### 明确不扩面的部分

1. 其他 `*INCLUDE_*` 变体仍按原有固定卡位规则解析，没有无依据地扩展为“块内多文件列表”。
2. `Keyword Index` 的递归建索引仍会在 `_buildRoots()` 中读取文件全文做关键字扫描。本次任务没有把关键字索引也一起流式化。

## 验证

### 新增定向测试

在 [test/extension.test.js](../../test/extension.test.js) 中新增并通过了以下回归测试：

1. 一个精确 `*INCLUDE` 块内包含多个文件名时，应返回全部文件。
2. 续行中穿插注释行时，文件名应被正确拼接。
3. `getFilenameFromKeyword()` 在续行场景下应返回完整文件名。
4. `getFilenameFromKeyword()` 在多文件 `*INCLUDE` 块中应返回当前选中项。
5. `LsdynaIncludeTreeProvider._buildItem()` 在扫描 deck 文件时不应依赖 `readFileSync()`。

### 验证命令

定向验证：

```powershell
npx mocha test/extension.test.js --grep "multiple filenames under a single \*INCLUDE block|comment lines inside include continuations|combines continued filenames inside \*INCLUDE blocks|selected filename inside a multi-file \*INCLUDE block|builds include trees without readFileSync on scanned files"
```

后续应再执行一次完整：

```powershell
npm test
```

## 风险与后续建议

1. 如果后续用户也反馈 `Scan Full Tree` 在超大工程中变慢或出错，应继续处理关键字索引路径，把 `_buildRoots()` 也改为增量扫描。
2. 如果确认某些 `*INCLUDE_*` 扩展关键字也允许块内多文件列表，应在独立补丁中逐项扩展，并为每种关键字补夹具与回归测试。
3. 目前的实现重点是“Include Tree 不再因整文件字符串读入而崩溃”，并不承诺把所有下游功能一次性流式化。