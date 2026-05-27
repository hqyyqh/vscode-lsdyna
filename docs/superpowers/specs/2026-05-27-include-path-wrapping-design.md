# LS-DYNA Include Path Auto-Wrapping Design

此文档阐述了如何在 `*INCLUDE_PATH` 和 `*INCLUDE_PATH_RELATIVE` 指令下实现长路径的自动折行格式化（即长度超过 80 字符时，自动在下一行以空格加 `+` 形式继续输入），以保证与 LS-PrePost 输出的格式完全兼容。

## 方案设计

### 1. 范围定位与识别 (`getPathEntryRange`)
对路径编辑结束失去焦点或保存时，寻找该路径的上下范围（防止破坏同一块下的其他路径定义）：
- 向上扫描到不以 ` +` 结尾的行或关键字/注释行为止。
- 向下扫描到当前行不以 ` +` 结尾，或者下一行为关键字/注释为止。

### 2. 拼接、校验与拆分 (`formatPathEntryIfNeeded`)
- 合并范围内所有行文本并去除末尾的 ` +`。
- 如果合并后的完整路径长度 > 80，以每段最多 78 个字符的长度进行切分，非最后一段添加 ` +`。
- 如果完整路径长度 <= 80，合并为单行展示。
- 使用 `vscode.WorkspaceEdit` 或 `editor.edit` 进行局部范围的文字替换。

### 3. 清理遗留问题
- 彻底移去已经失效且会引发 `ReferenceError` 的 `alignCardFields(e)` 监听器。

## 验证计划

### 自动化单元测试
- 添加 `test/extension.format.test.js` 或在 `test/extension.test.js` 中新增针对路径自动折行格式化的测试用例。
- 验证包含多行、单行、长路径及短路径的解析与格式化回写行为。

### 手动验证
- 新建或打开 `.k` 文件，在 `*INCLUDE_PATH` 关键字下输入超过 80 字符的长路径，切换光标到其他行，确认其自动进行了折行排版。
