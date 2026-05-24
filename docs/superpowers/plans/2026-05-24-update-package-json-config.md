# Update package.json configurations Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Update `package.json` configurations by removing `lsdyna.manualViewer` and adding `lsdyna.sumatrapdfPath`.

**架构：** Modify `package.json` by replacing `lsdyna.manualViewer` with `lsdyna.sumatrapdfPath` under the properties definition.

**技术栈：** VS Code extension configuration (JSON).

---

### 任务 1：更新 `package.json` 配置定义

**文件：**
- 修改：`package.json`

- [x] **步骤 1：使用 replace_file_content 替换配置定义**
 
  从 `package.json` 中删除 `lsdyna.manualViewer` 部分，添加 `lsdyna.sumatrapdfPath`。
 
  目标代码（修改前）：
  ```json
                  "lsdyna.manualViewer": {
                      "type": "string",
                      "default": "vscode",
                      "enum": [
                          "vscode",
                          "system"
                      ],
                      "enumDescriptions": [
                          "Open using VS Code built-in Webview PDF viewer (recycles tab and supports page navigation)",
                          "Open using system default PDF viewer (supports page parameter on Windows)"
                      ],
                      "description": "The PDF viewer to use when opening LS-DYNA manuals."
                  }
  ```
 
  替换为（修改后）：
  ```json
                  "lsdyna.sumatrapdfPath": {
                      "type": "string",
                      "default": "",
                      "description": "Custom path to SumatraPDF.exe on Windows. If left blank, the extension will use the bundled version or automatically detect it from the system."
                  }
  ```
 
- [x] **步骤 2：运行 JSON 校验检查**
 
  运行：`node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))"`
  预期：无报错，返回成功。
 
- [x] **步骤 3：Commit**

  ```bash
  git add package.json
  git commit -m "config: remove manualViewer and add sumatrapdfPath configuration"
  ```
