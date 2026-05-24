# 2026-05-24 Update package.json Configuration Design Spec

## 1. Goal Description
The objective is to update the configuration settings in `package.json` for the LS-DYNA VS Code extension. This involves removing the deprecated `lsdyna.manualViewer` configuration option and adding the new `lsdyna.sumatrapdfPath` option, which allows users on Windows to customize the path to the SumatraPDF.exe executable.

## 2. Changes to `package.json`
The setting `lsdyna.manualViewer` will be deleted entirely from the `contributes.configuration.properties` block.
The setting `lsdyna.sumatrapdfPath` will be added to the `contributes.configuration.properties` block:
```json
"lsdyna.sumatrapdfPath": {
    "type": "string",
    "default": "",
    "description": "Custom path to SumatraPDF.exe on Windows. If left blank, the extension will use the bundled version or automatically detect it from the system."
}
```

## 3. Verification Plan
- **Syntax Validation**: Ensure the modified `package.json` is valid JSON and compiles without issues.
- **Indentation Check**: Maintain the 4-space indentation matching the rest of `package.json`.
