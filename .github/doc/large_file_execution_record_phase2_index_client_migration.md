# vscode-lsdyna 大文件方案执行记录（Phase 2：引入共享 indexClient）

## 1. 本轮目标

在已经完成：

- `projectIndexer`
- Include Tree 快照接线
- Keyword Index 快照接线

之后，再补上客户端层的共享入口：

**引入 `src/client/services/indexClient.js`，让 Include Tree 与 Keyword Index 都通过统一的 `loadProjectSnapshot()` 访问项目快照，而不是各自直接注入 `buildProjectIndex`。**

---

## 2. 为什么这一步现在做

前两轮已经把两个递归视图都接回统一项目快照，但它们仍然直接依赖核心层的：

- `buildProjectIndex(rootFile)`

这会留下一个边界问题：

1. Provider 仍然知道“如何构建项目快照”
2. 后续如果把执行位置迁到 worker / LSP，需要同时改多个 Provider 注入口

因此本轮不是改变快照内容，而是把**客户端调用边界**先稳定成：

- `indexClient.loadProjectSnapshot(rootFile)`

这样后续即使底层从主线程切到 worker，Provider 也不需要再知道细节。

---

## 3. TDD 过程

### 3.1 先写失败测试

本轮先新增/改写三组最小测试约束：

1. `createIndexClient` 必须暴露 `loadProjectSnapshot`
2. Include Tree 扫描时必须优先走 `loadProjectSnapshot`
3. `activate()` 必须给两个 Tree Provider 注入同一个共享快照加载入口

先运行聚焦测试：

```powershell
npx mocha test\client\services\indexClient.test.js test\extension.test.js --grep "createIndexClient|LsdynaIncludeTreeProvider|LsdynaKeywordIndexProvider|activate"
```

结果先红，失败原因直接指向缺失能力：

- `createIndexClient` 不存在
- Include Tree 还没有消费 `loadProjectSnapshot`
- Keyword Index 仍然走旧的 `collectIncludeFiles()` 回退路径
- `activate()` 没有给两个 Provider 注入共享 loader

### 3.2 再写最小实现

本轮保持最小改动：

1. 新增 `src/client/services/indexClient.js`
2. `createIndexClient({ buildProjectIndex })` 只暴露 `loadProjectSnapshot(rootFile)`
3. `LsdynaIncludeTreeProvider` 改为依赖 `loadProjectSnapshot`
4. `LsdynaKeywordIndexProvider` 改为依赖 `loadProjectSnapshot`
5. `extension.js` 只创建一次 `indexClient`，并把同一个 `loadProjectSnapshot` 注入到两个 Provider

本轮**没有**提前加入缓存、后台线程、协议层转换，保持行为与数据形状不变。

### 3.3 验证转绿

先跑聚焦测试，再跑全量测试，最后跑 diff 格式检查。

结果为绿，说明：

- 共享 client 入口已经存在
- 两个 Provider 都已切换到统一的客户端快照加载边界
- 旧的快照内容和 UI 投影行为未被改写

---

## 4. 实际代码改动

### 4.1 `src/client/services/indexClient.js`

新增最小客户端层：

- `createIndexClient({ buildProjectIndex })`
- `loadProjectSnapshot(rootFile)`

当前职责非常单一：

1. 接收核心层的项目索引构建函数
2. 对客户端暴露统一快照加载入口

### 4.2 `src/client/providers/includeTreeProvider.js`

调整为：

- 构造时注入 `loadProjectSnapshot`
- `scan()` 优先消费共享快照 loader

保留原有 `_buildItem()` 回退路径，降低迁移风险。

### 4.3 `src/client/providers/keywordIndexProvider.js`

调整为：

- 构造时注入 `loadProjectSnapshot`
- recursive 模式优先通过共享 loader 获取 `snapshot.keywordMap`

local 模式与文档即时扫描逻辑保持不变。

### 4.4 `src/extension.js`

新增：

```js
const indexClient = createIndexClient({ buildProjectIndex });
```

并把同一个：

- `indexClient.loadProjectSnapshot`

注入到：

- `LsdynaIncludeTreeProvider`
- `LsdynaKeywordIndexProvider`

这样扩展激活时只构造一次客户端服务，Provider 只依赖共享客户端边界。

### 4.5 `test/client/services/indexClient.test.js`

新增对最小 client API 的直接测试，确保：

- 共享入口名称固定为 `loadProjectSnapshot`
- 调用会透传到 `buildProjectIndex`

---

## 5. 设计取舍

## 5.1 先稳定客户端边界，不提前切执行边界

本轮的重点是把 Provider 对项目快照的依赖收口到 client 层。  
先稳定：

- `loadProjectSnapshot(rootFile)`

再决定它最终是：

- 主线程直调
- worker 代理
- 语言服务代理

这是更稳健的企业级推进顺序。

## 5.2 只暴露一个最小入口

当前 `indexClient` 没有暴露额外能力，例如：

- 缓存失效
- 订阅更新
- 后台任务状态

原因是这些能力当前没有测试约束，也还不是当前迁移所必需。  
先把最小入口做对，后续再按真实需求扩展。

---

## 6. 验证结果

执行：

```powershell
npx mocha test\client\services\indexClient.test.js test\extension.test.js --grep "createIndexClient|LsdynaIncludeTreeProvider|LsdynaKeywordIndexProvider|activate"
npm test
git diff --check
```

结果：

- 聚焦测试通过
- 全量测试通过
- diff 格式检查通过

---

## 7. 对总体计划的推进意义

做到这一步之后，Phase 2 的输入边界已经进一步收口为：

1. 核心层：`buildProjectIndex(rootFile)`
2. 客户端层：`loadProjectSnapshot(rootFile)`
3. UI 层：只消费 snapshot，不再直接依赖核心构建函数

这意味着后续如果切到 worker / LSP，变化点主要会落在 `indexClient` 内部，而不是再分散到多个 Provider。

---

## 8. 一句话结论

**本轮完成的是“把共享项目快照入口正式下沉到 client 层”，让 Include Tree 和 Keyword Index 的客户端依赖边界统一为 `loadProjectSnapshot()`，为后续 worker/LSP 迁移提前收口。**
