# README_zh.md Customization Update 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在中文 README_zh.md 中添加定制版本声明并更新贡献者部分，与英文 README.md 保持完全同步。

**架构：** 直接编辑 `README_zh.md` 相关行，然后运行 git 诊断命令并 commit 更改。

**技术栈：** Markdown, Git, PowerShell

---

### 任务 1：更新 README_zh.md 头部定制声明

**文件：**
- 修改：`d:/Project/vscode-lsdyna/README_zh.md`

- [ ] **步骤 1：插入定制版本声明**

修改 `d:/Project/vscode-lsdyna/README_zh.md`，在第 2 行 `[English](README.md)` 下方插入定制版本与致谢声明。

原代码块（第 1-3 行）：
```markdown
# VS Code LS-DYNA 扩展
[English](README.md)

```

修改后的代码块：
```markdown
# VS Code LS-DYNA 扩展
[English](README.md)

> [!NOTE]
> **定制版本声明（由 hqyyqh 修改）**
> 本插件是基于 Ryan O'Sullivan 开发的原版 [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) 插件的定制分支，添加了特定的定制化功能。
> - **修改者：** hqyyqh（自 2026 年 5 月起进行修改）
> - **源码仓库：** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **开源协议：** 遵循 GNU General Public License v3.0 (GPL-3.0) 协议。我们保留并尊重原作者的所有版权与贡献声明。
```

- [ ] **步骤 2：验证插入是否正确**

查看 `d:/Project/vscode-lsdyna/README_zh.md` 头部内容，确认声明位置和空白行正确。

---

### 任务 2：更新 README_zh.md 贡献者部分

**文件：**
- 修改：`d:/Project/vscode-lsdyna/README_zh.md`

- [ ] **步骤 1：修改贡献者列表**

修改 `d:/Project/vscode-lsdyna/README_zh.md`，在 `### 贡献者` 列表中加入 `- [hqyyqh](https://github.com/hqyyqh) (定制版维护者)`，并将 `- [osullivryan](https://github.com/osullivryan)` 改为 `- [osullivryan](https://github.com/osullivryan) (原作者)`。

原代码块（约第 120-125 行）：
```markdown
### 贡献者

- [osullivryan](https://github.com/osullivryan)
- [yshl](https://github.com/yshl)
- [maxiiss](https://github.com/maxiiss)
```

修改后的代码块：
```markdown
### 贡献者

- [osullivryan](https://github.com/osullivryan) (原作者)
- [hqyyqh](https://github.com/hqyyqh) (定制版维护者)
- [yshl](https://github.com/yshl)
- [maxiiss](https://github.com/maxiiss)
```

- [ ] **步骤 2：验证修改是否正确**

查看 `d:/Project/vscode-lsdyna/README_zh.md` 贡献者列表部分，确认格式和英文版一致。

---

### 任务 3：提交更新

- [ ] **步骤 1：暂存和提交更改**

运行：
```powershell
git add README_zh.md
git commit -m "docs: add customization notice and update contributors in README_zh.md"
```

预期：提交成功，生成对应 commit。
