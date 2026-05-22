# vscode-lsdyna 大文件方案执行记录（Phase 2：Include Tree 接入统一快照）

## 1. 本轮目标

在已经具备：

- `projectIndexer`
- `ProjectGraph`
- `ProjectGraph.toTree()`

之后，继续推进一个关键接线动作：

**让 Include Tree 的构树路径开始消费统一项目快照，而不是继续完全依赖各自递归扫描。**

---

## 2. 为什么先接 Include Tree，而不是先接 Keyword Index

两者都应该最终消费同一个项目快照，但 Include Tree 的接入成本更低，原因是：

1. `ProjectGraph.toTree()` 已经天然对应 Include Tree 的展示结构
2. Include Tree 当前的核心问题是“递归扫描路径分散”，最适合先收口
3. Keyword Index 还涉及关键字聚合视图、分组和排序，接线复杂度略高

因此本轮先把 Include Tree 接到统一快照，是一个更稳健的企业级推进顺序。

---

## 3. TDD 过程

### 3.1 先写失败测试

在 `test/extension.test.js` 的 `LsdynaIncludeTreeProvider` 测试组中，新增用例：

- **builds include tree items from a project snapshot**

测试目标很明确：

1. 给 provider 一个伪造的项目快照
2. 由 `snapshot.graph.toTree(rootFile)` 返回嵌套树
3. provider 必须能够把这棵树转换成实际的 TreeItem 结构

先运行：

```powershell
npx mocha test/extension.test.js --grep "LsdynaIncludeTreeProvider"
```

结果先失败：

- `TypeError: provider._buildRootFromSnapshot is not a function`

这说明新的行为约束先于实现存在。

### 3.2 最小实现

本轮在 `src/client/providers/includeTreeProvider.js` 中新增了两层最小能力：

1. `buildProjectIndex` 依赖注入
2. `_buildRootFromSnapshot()` / `_buildItemFromTreeNode()`，把项目快照里的树形结构转换成实际的 Include Tree Item

同时保留原有 `_buildItem()` 递归扫描路径作为回退，避免一次性切断旧逻辑。

### 3.3 再跑验证

先单跑 Include Tree 相关测试：

```powershell
npx mocha test/extension.test.js --grep "LsdynaIncludeTreeProvider"
```

再跑全量：

```powershell
npm test
```

结果：

- Include Tree provider 测试通过
- 全量测试通过

---

## 4. 实际代码改动

### 4.1 `src/client/providers/includeTreeProvider.js`

新增：

1. `buildProjectIndex` 构造注入
2. `_buildItemFromTreeNode(node)`
3. `_buildRootFromSnapshot(snapshot, rootFile)`

调整：

1. `scan()` 现在优先尝试统一快照路径
2. 如果没有注入 `buildProjectIndex`，则回退到旧的 `_buildItem()` 递归扫描

这让迁移具备两个重要特征：

- **新路径可用**
- **旧路径未被硬删除**

### 4.2 `src/extension.js`

接入：

- `buildProjectIndex`

并在构造 `LsdynaIncludeTreeProvider` 时注入：

```js
const includeTreeProvider = new LsdynaIncludeTreeProvider({
    searchFileFromPaths,
    buildProjectIndex,
});
```

这意味着实际运行时的 Include Tree 已开始消费项目级索引结果。

### 4.3 `test/extension.test.js`

新增测试覆盖：

- provider 能否从统一项目快照构造嵌套树

这样后续即使继续重构 Include Tree，只要偏离项目快照消费路径，测试就会立刻报警。

---

## 5. 设计取舍

## 5.1 保留双路径，降低切换风险

本轮没有直接删掉旧的 `_buildItem()` 递归扫描逻辑，而是先让：

- 新路径：`buildProjectIndex` -> `graph.toTree()` -> TreeItem
- 旧路径：`_buildItem()` 递归扫描文件

并存。

这是为了降低企业级演进中的切换风险。  
只有当新路径被更多真实能力覆盖后，才适合彻底删除旧路径。

## 5.2 Provider 只做“树项投影”，不做项目级聚合

当前 provider 的职责仍然是：

- 接收项目级结果
- 把项目级结果投影到 UI TreeItem

而不是重新回到“既扫描、又聚合、又渲染”的大一统角色。  
这符合此前已经建立起来的分层方向。

---

## 6. 验证结果

执行：

```powershell
npx mocha test/extension.test.js --grep "LsdynaIncludeTreeProvider"
npm test
```

结果：

- **Include Tree provider 新增用例通过**
- **全量测试：83 passing, 0 failing**

这说明新接线没有破坏现有功能，同时完成了 Include Tree 向统一项目快照的第一次落地。

---

## 7. 对总体计划的推进意义

这是一个很关键的里程碑，因为它不是单纯“再加一个底层模块”，而是第一次把**已有 UI 能力真正接到了新的项目层架构上**。

到这里，架构已经不是“只有 projectIndexer / graph 在底下准备着”，而是：

1. 项目层已经产生统一快照
2. 图模型已经可以展开为树
3. Include Tree 已开始消费这条新路径

这标志着 Phase 2 正在从“基础设施准备阶段”进入“旧功能逐步迁移到新架构”的阶段。

---

## 8. 下一步建议

下一步最自然的推进顺序是：

1. 让 Keyword Index 也开始消费统一项目快照
2. 将旧的 `collectIncludeFiles()` 路径继续收缩
3. 在此基础上再引入 `indexClient` / `worker_threads`

**一句话结论：本轮不是继续堆底层模块，而是完成了新架构对现有 UI 能力的第一次真实接线，这一步非常关键。**
