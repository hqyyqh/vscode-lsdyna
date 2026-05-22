# vscode-lsdyna 大文件方案执行记录（Phase 2：Project Indexer 起步）

## 1. 本轮目标

在已经完成 Phase 0/1（解析器抽取 + Provider 模块化）的基础上，继续推进到 Phase 2 的**第一块地基能力**：

1. 引入项目级索引器
2. 让多文件工程扫描拥有统一聚合结果
3. 先解决“项目级结果长什么样”，再推进 Worker / indexClient / Provider 接线

---

## 2. 为什么这一步先做 projectIndexer，而不是直接上 Worker

Phase 2 原方案里同时包含：

- `projectGraph`
- `projectIndexer`
- `workerPool`
- `indexClient`
- Provider 接线

如果直接上 Worker，而项目级输出结构还没稳定，就会出现两个问题：

1. Worker 的输入输出协议容易反复变动
2. Provider 后续会被迫跟着数据结构反复改

因此本轮先把**主线程里的项目级聚合模型**做出来，确认最小可用快照格式，再把它搬进后台执行器。

这一步仍然符合企业级渐进式思路：**先稳定数据边界，再切换执行边界。**

---

## 3. 本轮新增内容

### 3.1 新增项目级索引器与图模型

新增文件：

- `src/core/project/projectGraph.js`
- `src/core/project/projectIndexer.js`

当前提供的核心接口：

```js
async function buildProjectIndex(rootFile)
```

当前返回的最小快照结构：

- `rootFile`
- `files`
- `graph`
- `keywordMap`
- `missingFiles`
- `cycles`

### 3.2 当前能力范围

`buildProjectIndex(rootFile)` 已具备：

1. 从根文件开始递归扫描 include 关系
2. 聚合整个工程内所有文件的关键字使用
3. 产出统一的 `ProjectGraph`
4. 将图模型展开为稳定的嵌套树结构（`toTree()`）
5. 记录无法解析的缺失 include
6. 遇到循环引用时进行熔断而不是无限递归

这虽然还不是最终版 `ProjectIndexSnapshot`，但已经建立了**项目级统一输出**。

---

## 4. TDD 过程

### 4.1 先写失败测试

新增测试：

- `test/core/project/projectIndexer.test.js`

先覆盖两个最小行为：

1. **递归聚合**  
   多个 include 文件的关键字结果能汇总到一个项目快照中。

2. **缺失引用记录**  
   某个 include 丢失时，项目扫描不会中断，并且会留下缺失记录。

随后继续补了一条图模型行为：

3. **图结构输出**  
   项目快照必须给出正向 include 边和反向依赖边。

4. **树形输出**
   图模型必须能够按 include 顺序物化为嵌套树，供 Include Tree 后续直接消费。

在生产代码尚未存在时先运行：

```powershell
npx mocha test/core/project/projectIndexer.test.js
```

结果为红灯，错误原因明确：

- `Cannot find module '../../../src/core/project/projectIndexer'`

这说明测试确实先于实现存在。

### 4.2 再写最小实现

实现思路：

1. 复用已有 `includeScanner`
2. 复用已有 `keywordScanner`
3. 新建 `ProjectGraph`，集中维护：
   - 正向 include 边
   - 反向依赖边
   - 缺失文件
   - 循环链条
4. 给 `ProjectGraph` 增加 `toTree()`，用于稳定输出树形结构
5. 在 `projectIndexer` 中只做聚合，不重复实现词法扫描
6. 保持实现最小，不提前引入缓存、线程池、协议层

### 4.3 最后验证转绿

先单跑新增测试：

```powershell
npx mocha test/core/project/projectIndexer.test.js
```

再跑全量：

```powershell
npm test
```

结果：

- `projectIndexer` / `ProjectGraph` / `toTree()` 新增测试通过
- 全量测试通过

---

## 5. 当前实现的设计取舍

## 5.1 先返回 `Map`，不急着做最终序列化格式

当前 `keywordMap` 使用 `Map`，这是为了先让主线程内的聚合逻辑稳定下来。  
等后续进入 Worker / LSP / 缓存阶段，再决定：

- 是否转换为普通对象
- 是否序列化为更稳定的 DTO
- 是否压缩为磁盘缓存格式

## 5.2 先内建最小 resolver，不复用入口层函数

`projectIndexer` 当前在模块内部维护最小的 include 路径解析逻辑，而没有反向依赖 `src/extension.js` 里的旧入口函数。  
这样可以避免新核心模块再次绑回旧入口。

## 5.3 先建“最小图”，再建“更完整的项目状态机”

本轮已经补上了 `ProjectGraph`，但它仍然是一个**最小可用图模型**，目前重点是：

- 给 `projectIndexer` 提供统一图输出
- 稳定 include 边与反向依赖边
- 提前固化 Include Tree 未来会消费的树形结构
- 把缺失文件与循环链条收口到项目层

尚未推进的内容包括：

- 更完整的图查询接口
- 图与缓存层的序列化协议
- Provider 对图结构的直接消费与接线

---

## 6. 验证结果

执行：

```powershell
npx mocha test/core/project/projectIndexer.test.js
npm test
```

结果：

- **新增索引器 / 图模型 / 树形输出测试通过**
- **全量测试：82 passing, 0 failing**

这说明本轮新增的项目级聚合基础没有破坏 Phase 0/1 已经稳定下来的行为。

---

## 7. 对总体计划的推进意义

做完这一步之后，仓库已经具备了三层清晰边界：

1. **文件级扫描层**  
   `includeScanner` / `keywordScanner`

2. **项目级聚合层**  
   `projectIndexer` + `ProjectGraph` + `toTree()`

3. **客户端展示层**  
   `includeTreeProvider` / `keywordIndexProvider`

后续推进 Worker / indexClient 时，就不再需要一边搬执行位置、一边重新定义数据形状。

---

## 8. 下一步建议

下一批建议按这个顺序推进：

1. 将当前 `collectIncludeFiles()` 的职责迁移到项目层
2. 让 Include Tree 先开始消费 `ProjectGraph.toTree()` 结果
3. 再让 Keyword Index 消费统一项目快照
4. 再决定是否引入 `worker_threads` 与 `indexClient`
5. 为后续缓存层定义可持久化的项目快照形状

**一句话结论：本轮已经把“大文件工程级扫描”从“多个文件各扫各的”推进到了“有统一项目快照 + 最小图模型 + 可直接展开的树形输出”的阶段，这是真正接入后台扫描 MVP 之前必须完成的一步。**
