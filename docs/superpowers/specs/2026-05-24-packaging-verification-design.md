# Design Spec: Global Packaging and Installation Verification

## 1. Goal
Verify that the customized VS Code extension package (`package.json`, README metadata) can be correctly processed by the official packaging tool (`@vscode/vsce`) to generate a `.vsix` bundle with the correct name: `lsdyna-custom-2.0.7-hqyyqh.0.vsix`. After validation, keep the workspace clean.

## 2. Technical Approach (Option A)
1. **Packaging**: Run the packaging command in PowerShell:
   ```powershell
   npx -y @vscode/vsce package --no-git-tag-version --no-update-package-json
   ```
2. **Verification**: Verify that `lsdyna-custom-2.0.7-hqyyqh.0.vsix` exists in the project root.
3. **Cleanup**: Remove the generated `.vsix` file to maintain a clean git tree:
   ```powershell
   Remove-Item -Path "lsdyna-custom-2.0.7-hqyyqh.0.vsix" -ErrorAction SilentlyContinue
   ```
4. **Git Status Check**: Run `git status` to ensure no tracked files have modified changes (untracked specification/plan docs are fine).

## 3. Risks & Mitigations
- **Risk**: `vsce` packaging might fail due to validation errors in `package.json`.
  - *Mitigation*: The `package.json` syntax has been verified in Task 1. We will log errors if any packaging validation fails and address them.
- **Risk**: Missing dependencies or node modules warnings.
  - *Mitigation*: We are using `npx -y` which downloads and runs the latest `@vscode/vsce` on the fly. Non-fatal warnings about git or licensing can be safely ignored.
