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

### 3.1 新增项目级索引器

新增文件：

- `src/core/project/projectIndexer.js`

当前提供的核心接口：

```js
async function buildProjectIndex(rootFile)
```

当前返回的最小快照结构：

- `rootFile`
- `files`
- `keywordMap`
- `missingFiles`
- `cycles`

### 3.2 当前能力范围

`buildProjectIndex(rootFile)` 已具备：

1. 从根文件开始递归扫描 include 关系
2. 聚合整个工程内所有文件的关键字使用
3. 记录无法解析的缺失 include
4. 遇到循环引用时进行熔断而不是无限递归

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
3. 在 `projectIndexer` 中只做聚合，不重复实现词法扫描
4. 保持实现最小，不提前引入缓存、线程池、协议层

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

- `projectIndexer` 新增测试通过
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

## 5.3 先建“快照”，后建“图”

虽然 Phase 2 计划里包含 `projectGraph.js`，但本轮先把**最小项目快照**做出来。  
下一步再把 include 边、反向依赖、循环链条整理进更正式的图模型中。

---

## 6. 验证结果

执行：

```powershell
npx mocha test/core/project/projectIndexer.test.js
npm test
```

结果：

- **新增索引器测试通过**
- **全量测试：80 passing, 0 failing**

这说明本轮新增的项目级聚合基础没有破坏 Phase 0/1 已经稳定下来的行为。

---

## 7. 对总体计划的推进意义

做完这一步之后，仓库已经具备了三层清晰边界：

1. **文件级扫描层**  
   `includeScanner` / `keywordScanner`

2. **项目级聚合层**  
   `projectIndexer`

3. **客户端展示层**  
   `includeTreeProvider` / `keywordIndexProvider`

后续推进 Worker / indexClient 时，就不再需要一边搬执行位置、一边重新定义数据形状。

---

## 8. 下一步建议

下一批建议按这个顺序推进：

1. 新建 `src/core/project/projectGraph.js`
2. 把 include 边、缺失文件、循环链条、反向依赖显式建模
3. 将当前 `collectIncludeFiles()` 的职责迁移到项目层
4. 再决定是否引入 `worker_threads` 与 `indexClient`

**一句话结论：本轮已经把“大文件工程级扫描”从“多个文件各扫各的”推进到了“有统一项目快照的聚合模型”，这是进入后台扫描 MVP 之前必须完成的一步。**
