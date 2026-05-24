# 2026-05-24 SumatraPDF Detection Engine Design Spec

## 1. Goal Description
The objective is to implement the `resolveSumatraPath(context)` asynchronous helper function in `src/extension.js`. This function will detect the location of `SumatraPDF.exe` on Windows systems using a multi-step fallback approach: user configuration, bundled binaries, registry entries, the `PATH` environment variable, and common install directories.

## 2. Detailed Design
The function `resolveSumatraPath(context)` will be defined as an asynchronous function in `src/extension.js`, positioned near the existing helper function `openManualFallback`.

### 2.1 Detection Flow
1. **User Configuration (`lsdyna.sumatrapdfPath`)**:
   - Check if `vscode.workspace.getConfiguration('lsdyna').get('sumatrapdfPath')` is configured.
   - If configured, resolve any environment variables in the path using the regex `/%([^%]+)%/g` matching `process.env`.
   - If the resulting path exists on disk, return it.
2. **Bundled Binary**:
   - Check the path resolved by `context.asAbsolutePath(path.join('bin', 'SumatraPDF.exe'))`.
   - If the file exists, return it.
3. **Registry Query**:
   - Query the Windows registry using `reg query` under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\SumatraPDF.exe` and `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\SumatraPDF.exe`.
   - Use `child_process.exec` asynchronously to query the value, parsing the stdout to extract the executable path.
   - If a valid path is found and it exists, return it.
4. **`PATH` Environment Variable**:
   - Iterate through paths listed in `process.env.PATH`, checking for `SumatraPDF.exe` in each directory.
   - If found, return it.
5. **Common Heuristic Paths**:
   - Check typical installation folders:
     - `C:\Program Files\SumatraPDF\SumatraPDF.exe`
     - `C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe`
     - `%LOCALAPPDATA%\SumatraPDF\SumatraPDF.exe`
     - `%APPDATA%\SumatraPDF\SumatraPDF.exe`
   - If found, return it.
6. **Fallback**:
   - If all detection steps fail, return `null`.

### 2.2 Integration Location
The function will be defined globally in `src/extension.js` so it is accessible within the scope of the `extension.openManual` command registration. It will be located directly above `openManualFallback`.

## 3. Verification Plan
- **Syntax and Lint Check**: Run Mocha tests via `npx mocha test --recursive --timeout 10000` to verify that modifying `src/extension.js` does not introduce syntax errors or cause extension loading failures.
- **Git Commit**: Commit the design spec first, and once implemented, commit `src/extension.js`.
