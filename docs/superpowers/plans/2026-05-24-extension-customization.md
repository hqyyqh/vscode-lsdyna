# VS Code LS-DYNA Extension Customization Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 VS Code LS-DYNA 扩展的元数据和文档修改为 hqyyqh 的定制版，防范应用市场覆盖冲突，并确保合规。

**架构：** 修改 package.json 中的插件名称、显示名称、发布者、作者及仓库，并在中英文 README 文件头部添加符合 GPLv3 要求的修改及致谢声明。

**技术栈：** VS Code Extension (package.json), Markdown (README.md, README_zh.md), Git

---

### 任务 1：修改 package.json 元数据

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：修改关键元数据**
  编辑 `package.json`，将 `name` 改为 `"lsdyna-custom"`，`displayName` 改为 `"LS-DYNA (Customized by hqyyqh)"`，`publisher` 改为 `"hqyyqh"`，`author` 改为 `"hqyyqh"`，`repository.url` 改为 `"https://github.com/hqyyqh/vscode-lsdyna"`，`version` 改为 `"2.0.7-hqyyqh.0"`。
  具体需要替换的块为：
  ```json
      "name": "lsdyna",
      "displayName": "LS-DYNA",
      "description": "Syntax Highlighting and Snippets for LS-Dyna Deck Creation and Editing",
      "publisher": "RyanOSullivan",
      "license": "SEE LICENSE IN LICENSE",
      "private": true,
      "repository": {
          "type": "git",
          "url": "https://github.com/osullivryan/vscode-lsdyna"
      },
      "icon": "images/LS_DYNA_geo_metro.png",
      "version": "2.0.7",
  ```
  替换为：
  ```json
      "name": "lsdyna-custom",
      "displayName": "LS-DYNA (Customized by hqyyqh)",
      "description": "Syntax Highlighting and Snippets for LS-Dyna Deck Creation and Editing",
      "publisher": "hqyyqh",
      "author": "hqyyqh",
      "license": "SEE LICENSE IN LICENSE",
      "private": true,
      "repository": {
          "type": "git",
          "url": "https://github.com/hqyyqh/vscode-lsdyna"
      },
      "icon": "images/LS_DYNA_geo_metro.png",
      "version": "2.0.7-hqyyqh.0",
  ```

- [ ] **步骤 2：验证 package.json 语法**
  运行：`node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))"`
  预期：运行成功无报错。

- [ ] **步骤 3：Commit**
  运行：
  ```powershell
  git add package.json
  git commit -m "chore: customize extension metadata in package.json"
  ```

---

### 任务 2：更新英文文档 README.md

**文件：**
- 修改：`README.md`

- [ ] **步骤 1：在头部添加定制版本声明**
  编辑 `README.md`，在第 2 行 `[简体中文](README_zh.md)` 下方插入定制版本与致谢声明：
  ```markdown
  > [!NOTE]
  > **Customized Version Notice (Modified by hqyyqh)**
  > This extension is a customized version based on the original [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) developed by Ryan O'Sullivan ([osullivryan](https://github.com/osullivryan)).
  > - **Modifier:** hqyyqh (Modified starting May 2026)
  > - **Source Code:** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
  > - **License:** Distributed under the GNU General Public License v3.0 (GPL-3.0). All original licenses and credits are preserved.
  ```

- [ ] **步骤 2：在 Contributors 部分中添加 hqyyqh**
  编辑 `README.md`，在 `### Contributors` 列表中加入 `- [hqyyqh](https://github.com/hqyyqh)`。
  修改前的块：
  ```markdown
  ### Contributors
  
  - [osullivryan](https://github.com/osullivryan)
  - [yshl](https://github.com/yshl)
  - [maxiiss](https://github.com/maxiiss)
  ```
  修改后的块：
  ```markdown
  ### Contributors
  
  - [osullivryan](https://github.com/osullivryan) (Original Author)
  - [hqyyqh](https://github.com/hqyyqh) (Customized Version Maintainer)
  - [yshl](https://github.com/yshl)
  - [maxiiss](https://github.com/maxiiss)
  ```

- [ ] **步骤 3：Commit**
  运行：
  ```powershell
  git add README.md
  git commit -m "docs: add customization notice and update contributors in README.md"
  ```

---

### 任务 3：更新中文文档 README_zh.md

**文件：**
- 修改：`README_zh.md`

- [ ] **步骤 1：在头部添加定制版本声明**
  编辑 `README_zh.md`，在第 2 行 `[English](README.md)` 下方插入定制版本与致谢声明：
  ```markdown
  > [!NOTE]
  > **定制版本声明（由 hqyyqh 修改）**
  > 本插件是基于 Ryan O'Sullivan 开发的原版 [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) 插件的定制分支，添加了特定的定制化功能。
  > - **修改者：** hqyyqh（自 2026 年 5 月起进行修改）
  > - **源码仓库：** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
  > - **开源协议：** 遵循 GNU General Public License v3.0 (GPL-3.0) 协议。我们保留并尊重原作者的所有版权与贡献声明。
  ```

- [ ] **步骤 2：在贡献者部分中添加 hqyyqh**
  编辑 `README_zh.md`，在 `### 贡献者` 列表中加入 `- [hqyyqh](https://github.com/hqyyqh)`。
  修改前的块：
  ```markdown
  ### 贡献者
  
  - [osullivryan](https://github.com/osullivryan)
  - [yshl](https://github.com/yshl)
  - [maxiiss](https://github.com/maxiiss)
  ```
  修改后的块：
  ```markdown
  ### 贡献者
  
  - [osullivryan](https://github.com/osullivryan) (原作者)
  - [hqyyqh](https://github.com/hqyyqh) (定制版维护者)
  - [yshl](https://github.com/yshl)
  - [maxiiss](https://github.com/maxiiss)
  ```

- [ ] **步骤 3：Commit**
  运行：
  ```powershell
  git add README_zh.md
  git commit -m "docs: add customization notice and update contributors in README_zh.md"
  ```

---

### 任务 4：全局打包和安装验证

- [ ] **步骤 1：使用 npx 试运行 vsce package 命令验证打包**
  运行：`npx -y @vscode/vsce package --no-git-tag-version --no-update-package-json`
  预期：打包成功生成 `lsdyna-custom-2.0.7-hqyyqh.0.vsix` 文件。

- [ ] **步骤 2：清理打包生成的 vsix 文件（或保留分发）**
  （根据需要保留或清理临时生成的 `.vsix` 文件）

- [ ] **步骤 3：Commit**
  运行：
  ```powershell
  git status
  ```
  预期：工作区干净（除未跟踪或忽略的生成文件外），所有修改均已 commit。
