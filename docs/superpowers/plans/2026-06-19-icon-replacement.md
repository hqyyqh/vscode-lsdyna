# DynaSense 图标替换实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将用户提供的 DynaSense 主图标和侧边栏图形规范化为 VS Code 可发布资产，并迁移仓库中的所有相关引用。

**架构：** 主图标采用无重绘的透明方形画布归一化，确保原始品牌像素不被生成式修改；Activity Bar 图标依据候选图形手工重建为 24 × 24 单色 SVG。清单引用集中更新后，通过资产契约、编译、测试、VSIX 打包和视觉缩放预览验证。

**技术栈：** PNG/ARGB、SVG、PowerShell `System.Drawing`、VS Code extension manifest、npm、TypeScript、Mocha、`@vscode/vsce`

---

## 文件结构

- 创建 `images/extension-icon.png`：方形透明扩展主图标。
- 创建 `images/activitybar-icon.svg`：24 × 24 单色 Activity Bar 图标。
- 修改 `package.json`：迁移主图标和 View Container 图标引用。
- 修改 `README.md`：迁移英文 README 顶部图标引用。
- 修改 `README_zh.md`：迁移中文 README 顶部图标引用。
- 修改 `.vscodeignore`：迁移打包白名单。
- 删除 `images/LS_DYNA_geo_metro.png`：移除已替代主图标。
- 删除 `images/lsdyna.png`：移除已替代侧边栏图标。

### 任务 1：建立资产契约基线

**文件：**
- 检查：`package.json`
- 检查：`.vscodeignore`
- 检查：`README.md`
- 检查：`README_zh.md`

- [ ] **步骤 1：运行新资产契约并验证当前状态失败**

运行：

```powershell
@('images/extension-icon.png','images/activitybar-icon.svg') | ForEach-Object {
  if (-not (Test-Path -LiteralPath $_)) { throw "Missing asset: $_" }
}
$manifest = Get-Content -Raw package.json | ConvertFrom-Json
if ($manifest.icon -ne 'images/extension-icon.png') { throw 'Manifest icon reference is stale' }
if ($manifest.contributes.viewsContainers.activitybar[0].icon -ne 'images/activitybar-icon.svg') { throw 'Activity Bar icon reference is stale' }
```

预期：FAIL，首先报告 `Missing asset: images/extension-icon.png`。

### 任务 2：创建规范化图标资产

**文件：**
- 创建：`images/extension-icon.png`
- 创建：`images/activitybar-icon.svg`

- [ ] **步骤 1：无重绘地生成透明方形主图标**

使用 `System.Drawing.Bitmap` 创建边长为原图最大边长的 ARGB 画布，将 `C:\Users\qyang\Downloads\主图标 (1)_看图王.png` 按原像素居中绘制并保存为 `images/extension-icon.png`。不得缩放、裁剪、锐化或生成式重绘；预期输出为 1066 × 1066，左右各 53 像素透明边距。

- [ ] **步骤 2：创建 24 × 24 单色侧边栏 SVG**

写入以下完整结构，使用单一不透明颜色和透明负空间：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <g fill="none" stroke="#000" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.5 17.5V5.2C3.5 3.9 4.5 3 5.8 3h8.1c3.6 0 6.6 2.9 6.6 6.5v3.1"/>
    <path d="M3.5 7.1 8 3m-4.5 8.5L8 7.1 12.2 3M3.5 16l4.5-4.5L3.5 7.1M8 7.1l4.2 4.4L8 16m0-8.9 4.2-4.1 4.2 4.1-4.2 4.4M16.4 7.1l4.1 2.4-4.1 3.1-4.2-1.1"/>
    <rect x="13.1" y="13" width="8" height="8" rx="1.1"/>
    <path d="m15.1 16 2 2m0-2-2 2m3.2 1h1.2"/>
  </g>
  <g fill="#000">
    <circle cx="3.5" cy="5.2" r="1"/><circle cx="3.5" cy="11.5" r="1"/><circle cx="3.5" cy="17.5" r="1"/>
    <circle cx="8" cy="3" r="1"/><circle cx="8" cy="7.1" r="1"/><circle cx="8" cy="16" r="1"/>
    <circle cx="12.2" cy="3" r="1"/><circle cx="12.2" cy="11.5" r="1"/>
    <circle cx="16.4" cy="7.1" r="1"/><circle cx="20.5" cy="9.5" r="1"/>
  </g>
</svg>
```

- [ ] **步骤 3：验证资产结构**

运行 PowerShell 检查 PNG 宽高、ARGB 像素格式、四角透明度，以及 SVG 的 `viewBox="0 0 24 24"`、单色值和无 `<image>` 元素。预期：PNG 为 1066 × 1066 且四角 alpha 为 0；SVG 检查全部通过。

- [ ] **步骤 4：提交资产**

```powershell
git add -- images/extension-icon.png images/activitybar-icon.svg
git commit -m "assets: add DynaSense extension icons"
```

### 任务 3：迁移引用并清理旧资产

**文件：**
- 修改：`package.json:13`
- 修改：`package.json:49`
- 修改：`README.md:4`
- 修改：`README_zh.md:4`
- 修改：`.vscodeignore:22-24`
- 删除：`images/LS_DYNA_geo_metro.png`
- 删除：`images/lsdyna.png`

- [ ] **步骤 1：更新所有清单与 README 引用**

将主图标引用统一改为 `images/extension-icon.png`，将 View Container 图标引用改为 `images/activitybar-icon.svg`，并在 `.vscodeignore` 中白名单这两个新文件；保留 `images/ls.svg` 白名单。

- [ ] **步骤 2：删除已替代图标**

删除 `images/LS_DYNA_geo_metro.png` 与 `images/lsdyna.png`。不得删除 `images/ls.svg`。

- [ ] **步骤 3：运行资产契约验证通过**

重新运行任务 1 的 PowerShell 契约，并补充：

```powershell
$stale = rg -n 'LS_DYNA_geo_metro\.png|images/lsdyna\.png' package.json README.md README_zh.md .vscodeignore
if ($LASTEXITCODE -eq 0) { throw "Stale icon references found:`n$stale" }
```

预期：PASS，没有旧文件引用。

- [ ] **步骤 4：提交引用迁移**

```powershell
git add -- package.json README.md README_zh.md .vscodeignore images/LS_DYNA_geo_metro.png images/lsdyna.png
git commit -m "chore: switch to new DynaSense icons"
```

### 任务 4：完整验证与视觉检查

**文件：**
- 检查：`images/extension-icon.png`
- 检查：`images/activitybar-icon.svg`
- 检查：生成的 `dynasense-*.vsix`

- [ ] **步骤 1：运行编译与测试**

运行：`npm test`

预期：TypeScript 编译成功，Mocha 测试零失败。

- [ ] **步骤 2：打包 VSIX**

运行：`npm run package`

预期：命令退出码为 0，生成 `dynasense-3.0.5.vsix`，且无图标相关错误。

- [ ] **步骤 3：检查 VSIX 文件清单**

运行：

```powershell
npx vsce ls | Select-String 'images/(extension-icon\.png|activitybar-icon\.svg|ls\.svg)'
```

预期：三个运行时图标均出现；旧图标不出现。

- [ ] **步骤 4：检查缩放与主题可见性**

在浏览器对比页中展示主图标 128、64、32 像素预览，以及 Activity Bar SVG 在浅色和深色背景上的 32、24 像素预览。确认无遮挡、无锯齿断裂、主体居中，且单色轮廓在两种主题模拟中清晰。

- [ ] **步骤 5：检查工作树与提交历史**

运行：

```powershell
git status --short
git log -3 --oneline
```

预期：除视觉伴侣会话目录外无未提交的图标实现文件；最新提交依次包含引用迁移、图标资产和实现计划。
