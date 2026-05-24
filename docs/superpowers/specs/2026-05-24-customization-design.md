# VS Code LS-DYNA Extension Customization and Attribution Design

This design document outlines the metadata and documentation changes required to package the `dev` branch of the VS Code LS-DYNA extension as a customized fork for personal and internal team distribution. The modifications aim to prevent VS Code from automatically overwriting customized features with official marketplace updates, while complying fully with GNU General Public License v3.0 (GPL-3.0) Section 5 attribution requirements.

## 1. Context and Goals
- **Upstream Repository**: [osullivryan/vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna)
- **Customized Repository**: [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
- **Modifier**: hqyyqh
- **Target Audience**: Internal team and personal use.
- **Constraints**: 
  - Prevent VS Code marketplace auto-update from overwriting the extension.
  - Respect upstream author rights and satisfy GPL-3.0 copyleft requirements (clearly mark modified code).

---

## 2. Proposed Changes

### 2.1 Extension Metadata (`package.json`)
We will modify the identifier (`publisher` + `name`) to create a separate namespace.

```json
{
  "name": "lsdyna-custom",
  "displayName": "LS-DYNA (Customized by hqyyqh)",
  "publisher": "hqyyqh",
  "author": "hqyyqh",
  "version": "2.0.7-hqyyqh.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/hqyyqh/vscode-lsdyna"
  }
}
```

*Rationale*:
- Changing `publisher` and `name` changes the unique extension ID from `RyanOSullivan.lsdyna` to `hqyyqh.lsdyna-custom`. VS Code will view these as entirely separate extensions, disabling any automatic upgrade path from the official marketplace.
- Setting `author` to `hqyyqh` clarifies who is packaging this version.
- Version `2.0.7-hqyyqh.0` designates that this version is built on top of upstream version `2.0.7`.

### 2.2 Documentation changes (`README.md` and `README_zh.md`)
We will add a prominent alert at the very beginning of both README files, below the title and language links.

#### `README.md` Addition:
```markdown
> [!NOTE]
> **Customized Version Notice (Modified by hqyyqh)**
> This extension is a customized version based on the original [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) developed by Ryan O'Sullivan ([osullivryan](https://github.com/osullivryan)).
> - **Modifier:** hqyyqh (Modified starting May 2026)
> - **Source Code:** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **License:** Distributed under the GNU General Public License v3.0 (GPL-3.0). All original licenses and credits are preserved.
```

#### `README_zh.md` Addition:
```markdown
> [!NOTE]
> **定制版本声明（由 hqyyqh 修改）**
> 本插件是基于 Ryan O'Sullivan 开发的原版 [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) 插件的定制分支，添加了特定的定制化功能。
> - **修改者：** hqyyqh（自 2026 年 5 月起进行修改）
> - **源码仓库：** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **开源协议：** 遵循 GNU General Public License v3.0 (GPL-3.0) 协议。我们保留并尊重原作者的所有版权与贡献声明。
```

---

## 3. Verification Plan
- **Packaging Verification**: Run `vsix` packaging command locally to ensure the `.vsix` file is generated with correct publisher, name, and version, and installs correctly in VS Code.
- **Documentation Verification**: Preview the README files to verify markdown formatting and rendering.
