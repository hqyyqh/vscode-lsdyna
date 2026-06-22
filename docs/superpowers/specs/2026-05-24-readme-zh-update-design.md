# Specification: README_zh.md Customization Update

## 1. Context & Purpose
The `vscode-lsdyna` extension is being customized by user `hqyyqh`. According to the GPLv3 license terms, any modification must be clearly notice-marked. The Chinese README file `README_zh.md` needs to be updated to match the English version's customization notice and updated contributors section.

## 2. Requirements & Changes
Two major modifications will be applied to `d:/Project/vscode-lsdyna/README_zh.md`:

### 2.1 Customized Version Notice
- **Location**: Line 2, immediately following `[English](README.md)`.
- **Formatting**: Separate with blank lines before and after to ensure proper Markdown block quote rendering.
- **Content**:
```markdown
> [!NOTE]
> **定制版本声明（由 hqyyqh 修改）**
> 本插件是基于 Ryan O'Sullivan 开发的原版 [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) 插件 of the 定制分支，添加了特定的定制化功能。
> - **修改者：** hqyyqh（自 2026 年 5 月起进行修改）
> - **源码仓库：** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **开源协议：** 遵循 GNU General Public License v3.0 (GPL-3.0) 协议。我们保留并尊重原作者的所有版权与贡献声明。
```

### 2.2 Contributors Update
- **Location**: Under the `### 贡献者` header.
- **Content**: Add `hqyyqh` as `(定制版维护者)` and update `osullivryan` to include `(原作者)`.
- **Result Block**:
```markdown
### 贡献者

- [osullivryan](https://github.com/osullivryan) (原作者)
- [hqyyqh](https://github.com/hqyyqh) (定制版维护者)
- [yshl](https://github.com/yshl)
- [maxiiss](https://github.com/maxiiss)
```

## 3. Implementation Plan
1. Apply changes in `README_zh.md` using `multi_replace_file_content` or `replace_file_content`.
2. Verify visual rendering and structure of `README_zh.md`.
3. Commit both the design specification and the updated `README_zh.md`.
