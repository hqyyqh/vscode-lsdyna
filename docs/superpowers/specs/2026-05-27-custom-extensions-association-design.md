# LS-DYNA Custom Extensions Association Design

此文档阐述了针对用户自定义后缀文件（包括默认支持的 `.asc`）无法加载语法高亮、Hover 提示、Ruler 标尺线以及 Tab 编辑对齐的问题进行自动语言绑定的设计方案。

## 需求背景
1. 默认情况下，`.asc`、`.dyna` 或是用户在设置中自定义的额外后缀文件在 VS Code 打开时不会自动与 `lsdyna` 语言模式关联。
2. 这导致这部分文件无法应用：
   - 基于 `source.lsdyna` 语法高亮
   - 基于 `[lsdyna]` configurationDefaults 的垂直辅助标尺（Rulers）
   - `lsdyna` 专属的 Hover 提示、命令和 Tab 按键绑定（在 `package.json` 中配置的 when 表达式）

## 方案设计

### 1. 动态语言绑定函数
在 `src/extension.js` 中增加 `associateLsdynaLanguages` 函数，扫描当前所有打开的文档，并将符合 `lsdyna.additionalExtensions` 设置中文件后缀的文档的语言模式修改为 `lsdyna`：

```javascript
function associateLsdynaLanguages() {
    vscode.workspace.textDocuments.forEach(doc => {
        if (isLsdynaUri(doc.uri) && doc.languageId !== 'lsdyna') {
            vscode.languages.setTextDocumentLanguage(doc, 'lsdyna').then(undefined, err => {
                console.error('[lsdyna] Failed to set text document language:', err);
            });
        }
    });
}
```

### 2. 生命周期事件监听
在 `src/extension.js` 的 `activate` 中监听以下生命周期阶段：
- **激活时**：运行 `associateLsdynaLanguages()`，自动处理在插件激活前已经打开或加载的自定义后缀文件。
- **文件打开事件**：绑定 `vscode.workspace.onDidOpenTextDocument`，在打开新文件时，若匹配 `isLsdynaUri` 且不是 `lsdyna`，自动调用 `vscode.languages.setTextDocumentLanguage(doc, 'lsdyna')`。
- **设置更改事件**：修改已有的 `vscode.workspace.onDidChangeConfiguration` 监听，增加对 `lsdyna.additionalExtensions` 配置更改的检查。如果发生改变，则触发 `associateLsdynaLanguages()`，以便重新对现有打开的文件执行语言模式评估。

## 验证计划

### 自动化单元测试
- 在 `test/client/providers/phase7_features.test.js` 中编写或修改相关测试，确保 `isLsdynaUri` 及相关的匹配函数符合用户自定义后缀关联行为。

### 手动验证
- 创建或打开一个 `.asc` 文件，在未设置 `files.associations` 时，验证其打开后语言模式被插件自动切换为 `LS-DYNA`，且高亮、hover、ruler 标尺生效，并且 Tab 对齐可以使用。
- 在 VS Code 中修改设置中的 `lsdyna.additionalExtensions` 数组，添加自定义后缀（例如 `.myext`），然后新建或打开一个 `.myext` 文件，确认插件能根据最新配置自动切换语言为 `LS-DYNA`。
