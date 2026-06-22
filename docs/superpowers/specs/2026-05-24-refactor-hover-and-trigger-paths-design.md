# 规格说明：重构 Hover 渲染逻辑及增加触发路径

## 1. 目标与背景

为了提升 LS-DYNA VS Code 插件中 PDF 帮助文档的可用性与可配置性，我们需要：
1. 重构 Hover 卡片底部的 `appendManualLinks` 排布，支持美化后的图标布局，并在未配置手册路径时展示引导配置的链接。
2. 调整 `provideHover` 中对关键字行（以 `*` 开头）的拦截条件，使得即使用户没有卡片字段数据，但只要有手册匹配或未配置手册路径时，依然能触发 Hover 展示，从而引导用户配置路径或查看文档。

---

## 2. 详细设计

### 2.1 `appendManualLinks` 逻辑重构

编辑 `src/extension.js` 中的 `appendManualLinks(md, kwName)`。
- **未配置路径或文件数为0**：
  追加 "📚 帮助文档 (Manuals)" 的未设置手册路径提示，并附带 `command:extension.configureManualsDir` 的配置链接。
- **已配置且有匹配手册**：
  展示每个匹配到的 PDF 手册的打开链接，采用 `$(book)` 图标，并展示 PDF 文件名及匹配页码。并在卡片最下方附带 `$(edit) 修改手册路径` 的配置链接。
- **已配置但没有匹配手册**：
  仅追加 `$(edit) 修改手册路径` 链接。

### 2.2 `provideHover` 拦截逻辑调整

编辑 `src/extension.js` 中 `LsdynaFieldHoverProvider.provideHover` 内处理关键字行的逻辑（即以 `*` 开头）：
1. 提取关键字名并大写化。
2. 调用 `lookupKeyword(kwName)` 查找对应的卡片字段。
3. 若 **未找到** 卡片字段 `entry`：
   - 获取 `manualIndexer` 中的匹配结果、配置状态及文件总数。
   - 若有匹配手册 **或** 未配置手册路径，则创建一个仅展示关键字加粗名称的 Hover，并调用 `appendManualLinks` 追加文档链接或配置链接。
   - 否则返回 `null`。
4. 若 **找到** 卡片字段 `entry`：
   - 像往常一样生成关键字字段 Markdown，并通过 `appendManualLinks` 追加文档链接或配置链接。

---

## 3. 规格自检

1. **占位符扫描**：无任何 TODO、待定或未完成内容。
2. **内部一致性**：逻辑与 VS Code Markdown 样式一致，使用已注册的 VS Code 命令 `extension.configureManualsDir` 和 `extension.openManual`。
3. **范围检查**：修改仅限于 `src/extension.js` 的 `appendManualLinks` 与 `provideHover` 方法，不涉及其他文件，范围精确。
4. **模糊性检查**：已明确了在未匹配到关键字时，只要手册未配置（`notConfigured` 为 true）就会展示 Hover 提示，以此引导配置。

---

## 4. 验证计划

- **静态检查**：确保没有 JavaScript 语法错误，变量名如 `manualsDir`、`fileCount`、`hasManuals`、`notConfigured` 引用正确。
- **测试覆盖**：
  1. 未配置手册路径时，鼠标悬停于任何关键字（如 `*NODE`）应弹出带有“未设置手册路径”和“设置手册文件夹”链接的 Hover 卡片。
  2. 已配置手册路径且有匹配文档时，悬停于对应关键字应展示对应的手册 PDF 打开链接。
