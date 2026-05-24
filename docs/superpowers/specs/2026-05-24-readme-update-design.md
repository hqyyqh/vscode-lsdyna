# Specification: README.md Customization Update

## 1. Context & Purpose
The `vscode-lsdyna` extension is being customized by user `hqyyqh`. According to the GPLv3 license terms, any modification must be clearly notice-marked, acknowledging the original author while indicating this is a customized fork.

## 2. Requirements & Changes
Two major modifications will be applied to `d:/Project/vscode-lsdyna/README.md`:

### 2.1 Customized Version Notice
- **Location**: Line 2, immediately following `[简体中文](README_zh.md)`.
- **Formatting**: Separate with blank lines before and after to ensure proper Markdown block quote rendering.
- **Content**:
```markdown
> [!NOTE]
> **Customized Version Notice (Modified by hqyyqh)**
> This extension is a customized version based on the original [vscode-lsdyna](https://github.com/osullivryan/vscode-lsdyna) developed by Ryan O'Sullivan ([osullivryan](https://github.com/osullivryan)).
> - **Modifier:** hqyyqh (Modified starting May 2026)
> - **Source Code:** [hqyyqh/vscode-lsdyna](https://github.com/hqyyqh/vscode-lsdyna)
> - **License:** Distributed under the GNU General Public License v3.0 (GPL-3.0). All original licenses and credits are preserved.
```

### 2.2 Contributors Update
- **Location**: Under the `### Contributors` header.
- **Content**: Add `hqyyqh` as Customized Version Maintainer, and note `osullivryan` as Original Author.
- **Result Block**:
```markdown
### Contributors

- [osullivryan](https://github.com/osullivryan) (Original Author)
- [hqyyqh](https://github.com/hqyyqh) (Customized Version Maintainer)
- [yshl](https://github.com/yshl)
- [maxiiss](https://github.com/maxiiss)
```

## 3. Implementation Plan
1. Apply changes in `README.md` using `multi_replace_file_content`.
2. Verify visual rendering and structure of `README.md`.
3. Commit both the design specification and the updated `README.md`.
