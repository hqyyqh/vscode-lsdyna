# LS-DYNA 垂直标尺配色优化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 package.json 中配置优化的垂直标尺配色默认设置（每 10 列 alpha 透明灰线，第 80 列紫罗兰警示线）。

**架构：** 在 `package.json` 的 `configurationDefaults` 中，重写 `[lsdyna]` 语言的 `editor.rulers` 数组，使用对象形式精细控制各标尺线的颜色。

**技术栈：** VS Code Extension Manifest, JSON

---

### 任务 1：配置 package.json 标尺参数

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：修改 package.json 中的 configurationDefaults 标尺设置**

在 [package.json](file:///d:/Project/vscode-lsdyna/package.json) 中，找到 `configurationDefaults` 的 `[lsdyna]` 语言块，修改 `editor.rulers` 内容为透明灰色（10-70列）和紫罗兰色（80列）。

修改代码如下：
```json
        "configurationDefaults": {
            "[lsdyna]": {
                "editor.wordWrap": "off",
                "editor.rulers": [
                    { "column": 10, "color": "rgba(128, 128, 128, 0.15)" },
                    { "column": 20, "color": "rgba(128, 128, 128, 0.15)" },
                    { "column": 30, "color": "rgba(128, 128, 128, 0.15)" },
                    { "column": 40, "color": "rgba(128, 128, 128, 0.15)" },
                    { "column": 50, "color": "rgba(128, 128, 128, 0.15)" },
                    { "column": 60, "color": "rgba(128, 128, 128, 0.15)" },
                    { "column": 70, "color": "rgba(128, 128, 128, 0.15)" },
                    {
                        "column": 80,
                        "color": "#8a5cf5"
                    }
                ]
            }
        },
```

---

### 任务 2：验证并运行测试

**文件：**
- 测试：`test/extension.test.js`

- [ ] **步骤 1：运行 npm test 验证现有测试集无 regression**

运行：`npm test`
预期：所有 158 个测试成功通过。

---

### 任务 3：提交修改

- [ ] **步骤 1：将修改内容 stage 并 commit**

运行：
```bash
git add package.json
git commit -m "feat: optimize default editor rulers color palette for lsdyna"
```
预期：Commit 成功，working tree clean。
