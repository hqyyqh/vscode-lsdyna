# VS Code LS-DYNA Extension Development Guide

This guide describes how to set up the development environment, run tests, compile/package the extension, and configure local manuals.

## 1. Environment Setup

- **Node.js**: Recommended version >= 16.x.
- **VS Code**: Required for testing and local run/debug.

To install dependencies:
```bash
npm install
```

## 2. Development & Testing

### Running the Extension Locally
1. Open this project folder in VS Code.
2. Press `F5` (or go to Run and Debug -> click "Run Extension"). This will launch a new VS Code window (Extension Development Host) with the local version of this extension loaded.

### Running Unit Tests
We use the official VS Code Extension Testing library.
Run the tests:
```bash
npm test
```
*Note: This command will download a test VS Code instance if it is not already cached, and execute all tests located in the `test/` directory.*

## 3. Compilation & Packaging

To compile and package the extension into a `.vsix` file for installation:
```bash
npx -y @vscode/vsce package --no-git-tag-version --no-update-package-json
```
This generates a file named `lsdyna-custom-<version>.vsix` in the root directory.

## 4. PDF Manual & SumatraPDF Integration Configuration

For manual lookups and exact page jumps to function correctly:
1. **Manuals Directory**: Configure the absolute or workspace-relative path in VS Code settings under `lsdyna.manualsDir`.
2. **SumatraPDF.exe (Windows)**:
   - On Windows, copy `SumatraPDF.exe` directly into the manuals directory configured above.
   - The extension will read PDF manual structures, build bookmark caches, and monitor changes in this directory.
   - If `SumatraPDF.exe` is missing from the manuals directory, the extension will gracefully fall back to the system default PDF reader (without page navigation).

## 5. LS-DYNA Keyword Schema Generation

The snippet and hover schema are generated from the pydyna codegen metadata:

```bash
python keywords/generate_from_pydyna.py pydyna/codegen/kwd.json
python keywords/validate_field_data_translation.py
npm test
```

Current generation scale:

- raw kwd keywords: 3168
- manifest/codegen items: 3173
- skipped items: 23
- aliases: 21
- option-enabled keywords: 1328
- title variants: 1560
- field data entries: 4712
- snippets: 5510
- field_data.json size: about 19753 KB

`generate_from_pydyna.py` writes `snippets/lsdyna.json` and `keywords/field_data.json`, then synchronizes `keywords/field_data_zh.json` with English structural fallback while preserving existing localized help text where possible.
