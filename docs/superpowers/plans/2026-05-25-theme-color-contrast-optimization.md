# 包含树与关键字索引主题颜色与可读性优化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化已解析及缺失的 include 文件引用在 VS Code 侧边栏和编辑器中的颜色，并通过高对比度 Emoji 前缀增强侧边栏的可读性，防止用户看错或点错。

**架构：**
1. 将 `LsdynaFileDecorationProvider`（文件装饰器）中的颜色修改为 VS Code 树/列表的推荐主题前景色（已解析使用 `gitDecoration.untrackedResourceForeground`，缺失使用 `list.warningForeground`）（已完成）。
2. 在编辑器内，修改行内文本和 `✓`/`⚠` 徽标装饰类型定义，同样使用对应的高对比度自适应 ThemeColor（已完成）。
3. 修改 `IncludeItem` 的警告节点图标颜色，统一使用 `list.warningForeground`（已完成）。
4. 在 Include Tree 节点的文本前缀添加高对比度 Emoji（`📄`、`⚠️`、`🔄`）。
5. 在 Keyword Index 节点（关键字类别及文件引用）的文本前缀添加高对比度 Emoji（`🏷️`、`📄`）。
6. 更新对应的单元测试断言以匹配带 Emoji 的节点标签。

**技术栈：** VS Code Ext API (`ThemeColor`, `ThemeIcon`, `TreeItem`, `FileDecorationProvider`)

---

### 任务 1：优化侧边栏文件装饰器 `LsdynaFileDecorationProvider` 的颜色配置（已完成）

---

### 任务 2：优化编辑器内 include 路径装饰颜色（已完成）

---

### 任务 3：优化 Include Tree 的警告图标颜色与 Emoji 前缀

**文件：**
- 修改：`src/client/providers/includeTreeProvider.js`

- [ ] **步骤 1：修改 `IncludeItem` 构造函数和节点生成逻辑中的图标颜色与文字前缀**

在 `src/client/providers/includeTreeProvider.js` 中：
1. 修改 `IncludeItem` 构造函数，增加 `📄 ` 或 `⚠️ ` 前缀：
```javascript
class IncludeItem extends vscode.TreeItem {
    constructor(filePath, exists) {
        const baseName = path.basename(filePath);
        const prefix = exists ? '📄 ' : '⚠️ ';
        super(`${prefix}${baseName}`, vscode.TreeItemCollapsibleState.Collapsed);
        this.filePath = filePath;
        // ... 其他保持不变
```
2. 修改 `_buildItemFromTreeNode` 方法：
```javascript
    _buildItemFromTreeNode(node, rootPath) {
        const exists = !node.missing && fs.existsSync(node.filePath);
        const item = new IncludeItem(node.filePath, exists);
        if (node.cycle) {
            item.description = 'circular';
            item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            item.label = `🔄 ${path.basename(node.filePath)}`;
        } else if (node.missing) {
            item.description = 'missing';
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            item.label = `⚠️ ${path.basename(node.filePath)}`;
        } else {
            // ... 保持不变
```
3. 修改 `_buildItem` 方法中 `visited` 循环依赖时的 label：
```javascript
        if (!exists || visited.has(filePath)) {
            if (visited.has(filePath)) {
                item.description = 'circular';
                item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
                item.label = `🔄 ${path.basename(filePath)}`;
            }
            // ... 保持不变
```

- [ ] **步骤 2：运行单元测试**

运行：`npm test`
预期输出：`183 passing`

- [ ] **步骤 3：Commit**

```bash
git add src/client/providers/includeTreeProvider.js
git commit -m "style: add emoji prefixes and adjust warning colors in Include Tree"
```

---

### 任务 4：为 Keyword Index 节点添加 Emoji 前缀

**文件：**
- 修改：`src/client/providers/keywordIndexProvider.js`

- [ ] **步骤 1：修改 `KeywordItem`、`KeywordUsageItem` 和 `AggregatedKeywordUsageItem` 的构造函数**

在 `src/client/providers/keywordIndexProvider.js` 中：
1. 修改 `KeywordItem` 构造函数，加上 `🏷️ ` 前缀：
```javascript
class KeywordItem extends vscode.TreeItem {
    constructor(keyword) {
        super(`🏷️ ${keyword}`, vscode.TreeItemCollapsibleState.Collapsed);
        this.children = [];
        this.iconPath = new vscode.ThemeIcon('symbol-keyword');
    }
}
```
2. 修改 `KeywordUsageItem` 构造函数，加上 `📄 ` 前缀：
```javascript
class KeywordUsageItem extends vscode.TreeItem {
    constructor(filePath, lineIndex, rootDir) {
        super(`📄 ${path.basename(filePath)}`, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(filePath);
        // ... 其他保持不变
```
3. 修改 `AggregatedKeywordUsageItem` 构造函数，加上 `📄 ` 前缀：
```javascript
class AggregatedKeywordUsageItem extends vscode.TreeItem {
    constructor(filePath, count, firstLineIndex, rootDir) {
        super(`📄 ${path.basename(filePath)}`, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(filePath);
        // ... 其他保持不变
```

- [ ] **步骤 2：运行单元测试确认有因 label 变化导致的测试失败**

运行：`npm test`
预期输出：存在测试失败，失败点位于 LsdynaKeywordIndexProvider 标签匹配断言上。

- [ ] **步骤 3：Commit**

```bash
git add src/client/providers/keywordIndexProvider.js
git commit -m "style: add emoji prefixes to keyword index tree nodes"
```

---

### 任务 5：更新单元测试断言以支持 Emoji 前缀

**文件：**
- 修改：`test/extension.test.js`

- [ ] **步骤 1：修改 `test/extension.test.js` 中匹配 KeywordItem 标签的断言**

在 `test/extension.test.js` 中：
1. 修改第 650 行断言，添加 `🏷️ ` 前缀：
```javascript
        assert.deepEqual(roots.map(item => item.label), ['🏷️ MAT_ELASTIC', '🏷️ PART']);
```
2. 修改第 693 行断言，添加 `🏷️ ` 前缀：
```javascript
            assert.deepEqual(provider.roots.map(item => item.label), ['🏷️ PART']);
```

- [ ] **步骤 2：重新运行单元测试验证全部通过**

运行：`npm test`
预期输出：`183 passing`

- [ ] **步骤 3：Commit**

```bash
git add test/extension.test.js
git commit -m "test: update keyword index provider assertions for emoji prefixes"
```
