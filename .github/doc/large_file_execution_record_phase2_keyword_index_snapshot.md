# vscode-lsdyna 大文件方案执行记录（Phase 2：Keyword Index 接入统一快照）

## 1. 本轮目标

在已经完成：

- `projectIndexer`
- `ProjectGraph`
- Include Tree 快照接线

之后，把递归 Keyword Index 也迁移到同一个项目级快照入口：

**让 Keyword Index 在递归模式下直接消费 `buildProjectIndex()` 返回的 `keywordMap`，不再自己先收集文件、再逐文件扫描关键字。**

---

## 2. 为什么这一步现在做

Include Tree 已经证明“统一快照 -> Provider 投影”这条路径可行。  
如果 Keyword Index 继续保留：

1. `collectIncludeFiles()`
2. `collectKeywordsFromFile()`

这条独立递归链路，就会出现两个问题：

1. 同一个工程被扫描两套递归路径
2. 项目层已经统一，但 Keyword Index 仍然绕过统一快照

因此本轮的重点不是再发明新的扫描能力，而是把现有 Keyword Index 正式接回项目层边界。

---

## 3. TDD 过程

### 3.1 先写失败测试

先在 `test/extension.test.js` 中新增两个用例：

1. `builds keyword roots from a project snapshot`
2. `uses the project snapshot during recursive scans when available`

第一条先约束 provider 必须能把 `snapshot.keywordMap` 投影成 Tree roots。  
第二条再约束递归扫描模式必须优先走 `buildProjectIndex`，而不是继续调用旧的 `collectIncludeFiles()` 路径。

随后又补了一条接线测试：

3. `injects buildProjectIndex into the keyword index provider`

先跑聚焦测试，结果先红：

- `provider._buildRootsFromSnapshot is not a function`
- `collectIncludeFiles should not be called when buildProjectIndex is available`
- `provider.buildProjectIndex` 为 `undefined`

这说明测试确实先于实现存在，而且失败原因都直接指向缺失能力。

### 3.2 再写最小实现

本轮保持最小实现：

1. 在 `keywordIndexProvider` 中新增 `buildProjectIndex` 依赖注入
2. 新增 `_buildRootsFromKeywordMap()` / `_buildRootsFromSnapshot()`
3. 让 `scan()` 在递归模式下优先消费项目快照
4. 保留旧的 `_buildRootsAsync()` 作为回退路径
5. 在 `extension.js` 中把 `buildProjectIndex` 注入到 `LsdynaKeywordIndexProvider`

### 3.3 验证转绿

先跑聚焦测试，再跑全量测试。  
结果为绿，说明：

- Keyword Index 已能从统一快照构树
- 递归模式已切换到统一项目快照
- local 模式逻辑未被改写

---

## 4. 实际代码改动

### 4.1 `src/client/providers/keywordIndexProvider.js`

新增：

- `buildProjectIndex` 构造注入
- `_buildRootsFromKeywordMap(keywordMap, rootDir)`
- `_buildRootsFromSnapshot(snapshot, rootDir)`

调整：

- `scan()` 优先走 `buildProjectIndex(rootFile)` -> `snapshot.keywordMap`
- 没有注入 `buildProjectIndex` 时，仍回退到旧的 `collectIncludeFiles()` + `_buildRootsAsync()`
- `refreshFromDocument()` 继续走本地文档扫描逻辑，local 模式行为保持不变

### 4.2 `src/extension.js`

把：

- `buildProjectIndex`

注入到：

- `LsdynaKeywordIndexProvider`

这样实际扩展运行时，递归 Keyword Index 已经和 Include Tree 一样，开始消费统一项目快照。

### 4.3 `test/extension.test.js`

新增覆盖：

1. Provider 能否直接从 `snapshot.keywordMap` 生成 roots
2. 递归扫描是否优先走项目快照路径
3. 激活阶段是否完成 `buildProjectIndex` 注入

---

## 5. 设计取舍

## 5.1 保留 local 模式原行为

本轮只迁移 **recursive** Keyword Index。  
`refreshFromDocument()` 仍直接读取当前打开文档的行内容，这是为了：

1. 保持当前文件视图的即时性
2. 避免把“工程级聚合”和“单文档即时反馈”再次耦合在一起

## 5.2 Provider 只负责投影，不再重复聚合

迁移后，Keyword Index provider 的职责更清晰：

- local 模式：投影当前文档
- recursive 模式：投影项目快照

而不是继续自己承担“递归找文件 + 递归扫关键字 + 组装 UI”三件事。

---

## 6. 验证结果

执行：

```powershell
npx mocha test/extension.test.js --grep "LsdynaKeywordIndexProvider|activate"
npx mocha test/core/project/projectIndexer.test.js
npm test
git diff --check
```

结果：

- Keyword Index 新增快照测试通过
- 项目级索引器既有测试继续通过
- 全量测试通过
- diff 格式检查通过

---

## 7. 对总体计划的推进意义

做到这一步之后，Phase 2 里两个主要递归视图都已经开始消费统一项目快照：

1. Include Tree -> `snapshot.graph.toTree()`
2. Keyword Index -> `snapshot.keywordMap`

这意味着项目层聚合边界已经真正成为 UI 层的统一输入。  
后续再把执行位置迁移到 worker / indexClient 时，就不需要为不同 Provider 维护两套递归扫描实现。

---

## 8. 一句话结论

**本轮完成的是“Keyword Index 递归路径接回统一项目快照”，不是单纯减少几行代码，而是进一步收口了工程级扫描入口，让项目层架构真正开始被多个 UI 能力共同消费。**
