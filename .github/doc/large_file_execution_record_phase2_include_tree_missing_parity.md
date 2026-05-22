# vscode-lsdyna 大文件方案执行记录（Phase 2：Include Tree 缺失节点快照一致性修复）

## 1. 本轮目标

修复一个已经明确存在的快照路径一致性缺口：

- `projectIndexer.buildProjectIndex()` 会记录 `missingFiles`
- 旧的 Include Tree 递归 `_buildItem()` 路径会把缺失 include 渲染成 warning / `not found`
- 但新的快照路径 `loadProjectSnapshot() -> graph.toTree() -> _buildItemFromTreeNode()` 会把这些缺失 include 丢掉

本轮目标就是把这条缺口补齐，并且**只修这个缺口**，不顺手扩大范围到 cycle/diagnostic 之类的其它一致性议题。

---

## 2. 根因

根因不在 provider，而在图投影层：

1. `ProjectGraph.children` 只保存已解析成功的文件边
2. `ProjectGraph.toTree()` 只根据 `children` 递归物化树
3. 因此缺失 include 虽然进入了 `missingFiles`，却从未进入树投影

这意味着：

- 索引层知道“有缺失文件”
- 树投影层却无法表达“缺失文件仍然是一个可见节点”

所以快照路径天然比旧递归路径少了一类节点。

---

## 3. TDD 过程

### 3.1 先补失败测试

本轮先写了两个失败测试：

1. `test/core/project/projectIndexer.test.js`
   - `preserves missing includes as tree nodes in include order`
   - 证明 `snapshot.graph.toTree(rootFile)` 必须保留缺失 include，并保持 include 顺序稳定

2. `test/extension.test.js`
   - `preserves missing include nodes when building tree items from a project snapshot`
   - 证明 Include Tree provider 走快照路径时，最终仍然能看到 `not found` 节点

先跑：

```powershell
npx mocha test\core\project\projectIndexer.test.js test\extension.test.js --grep "preserves missing include"
```

结果先失败，失败点也非常直接：

- `ProjectGraph.toTree()` 结果里没有缺失节点
- provider 从快照构树后也只剩已解析节点

这说明测试确实卡住了当前缺口，而不是写成了“现状即通过”的伪测试。

### 3.2 最小实现

实现策略刻意保持最小范围：

1. 在 `ProjectGraph` 中新增独立的 `includeEntries` 顺序表
   - 已解析 include 进入 `children` + `includeEntries`
   - 缺失 include 进入 `missingFiles` + `includeEntries`

2. `ProjectGraph.toTree()` 改为基于 `includeEntries` 投影
   - 已解析节点继续递归
   - 缺失节点输出 `{ filePath, fileName, missing: true, children: [] }`

3. `buildProjectIndex()` 为缺失 include 补充一个稳定的候选 `filePath`
   - 使用首个 search path 做 `path.resolve(...)`
   - 这样 TreeItem 仍然有稳定路径/tooltip，同时不会误报为存在

4. `includeTreeProvider` 在快照路径消费 `node.missing`
   - `missing: true` 时直接按不存在节点渲染
   - 即使磁盘状态在快照之后变化，也不会把快照里的缺失节点误渲染成正常文件

### 3.3 为什么这是企业级更稳的修法

因为它没有把“缺失节点”塞进现有 resolved-only API 里硬拧语义，而是：

- 保留 `getChildren()` / `getParents()` 的既有 resolved 行为
- 新增用于树投影的顺序元数据
- 用加法方式补齐快照树表达力

这样改动面小，但语义更清楚，也更方便以后继续补其它快照一致性问题。

---

## 4. 实际改动

### 4.1 `src/core/project/projectGraph.js`

- 新增 `includeEntries`
- 新增 `addIncludeEntry()` / `getIncludeEntries()`
- `addIncludeEdge()` 现在同步登记树投影顺序
- `addMissingFile()` 现在同步登记缺失树节点元数据
- `toTree()` 改为按 `includeEntries` 物化，保留缺失节点

### 4.2 `src/core/project/projectIndexer.js`

- 缺失 include 记录里新增 `filePath`
- 该 `filePath` 作为快照树里缺失节点的稳定展示路径

### 4.3 `src/client/providers/includeTreeProvider.js`

- `_buildItemFromTreeNode()` 识别 `node.missing`
- 快照路径下的缺失节点继续显示 warning / `not found`

### 4.4 测试

- `test/core/project/projectIndexer.test.js`
- `test/extension.test.js`

新增用例覆盖：

- 快照树保留缺失节点
- 缺失节点顺序稳定
- Include Tree 快照路径渲染 `not found`

---

## 5. 验证

本轮验证顺序：

```powershell
npx mocha test\core\project\projectIndexer.test.js test\extension.test.js --grep "preserves missing include|projectIndexer|LsdynaIncludeTreeProvider"
npm test
git diff --check
```

预期结果：

- 相关 focused tests 全绿
- 全量 `npm test` 全绿
- `git diff --check` 无 whitespace / conflict marker 问题

---

## 6. 结论

本轮完成的是一个非常明确的 Phase 2 收口动作：

**统一项目快照现在不仅能表达已解析 include，也能表达“解析失败但必须可见”的缺失 include 节点。**

这让 Include Tree 的快照路径与旧递归路径在“缺失文件可视化”这一关键行为上恢复一致，同时没有扩大到其它尚未设计完成的一致性议题。

---

## 7. Reviewer follow-up：重复缺失 include 仍被折叠

独立 review 后又发现一个更细的剩余缺口：

- 同一个父文件里如果连续出现两个相同的缺失 include 指令
- 旧递归 provider 路径会按“每次指令出现”渲染两个 `not found` 节点
- 但快照路径仍然只显示一个

### 7.1 根因

第二个缺口仍然在 `ProjectGraph.addIncludeEntry()`：

1. 上一轮为 `includeEntries` 加了去重逻辑
2. 去重条件基于 `filePath + missing`
3. 因此两个相同的缺失 include 会在树投影元数据层被合并

这不是索引器漏扫，而是**树投影顺序表把“重复缺失指令”错误当成了“重复节点”**。

### 7.2 Follow-up TDD

先补两个失败测试：

1. `test/core/project/projectIndexer.test.js`
   - `preserves duplicate missing includes as separate tree nodes in stable order`
2. `test/extension.test.js`
   - `preserves duplicate missing include nodes when building tree items from a project snapshot`

先跑：

```powershell
npx mocha test\core\project\projectIndexer.test.js test\extension.test.js --grep "duplicate missing include"
```

结果先失败，说明快照树和 provider 的确都把第二个缺失节点折叠掉了。

### 7.3 最小修法

本次 follow-up 不改 resolved 边模型，只把修复限定在缺失节点：

- `entry.missing === true` 时，`addIncludeEntry()` 直接按出现顺序追加
- 非缺失节点继续维持现有去重逻辑

这样做的好处是：

- reviewer 指出的缺失节点重复折叠被修正
- resolved include 当前行为不被扩大改动
- 树顺序仍然严格按 include 指令出现顺序稳定输出

### 7.4 Follow-up 覆盖结论

修完后，快照路径现在对缺失 include 已具备两层一致性：

1. 缺失指令不会消失
2. 重复缺失指令不会被合并

这才和旧递归 Include Tree 路径在缺失节点可视化语义上真正对齐。
