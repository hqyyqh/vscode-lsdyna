# 2026-05-24 Integrate SumatraPDF Design Spec

## 1. Goal Description
The objective is to integrate SumatraPDF.exe into the VS Code LS-DYNA extension on Windows platforms, replacing the current Webview-based pdf.js viewer and generic system default viewer configuration options. This will provide a native, high-performance, and lag-free PDF viewing experience on Windows, while gracefully falling back to system-default external PDF opening on non-Windows platforms.

## 2. Configuration Changes (`package.json`)
- Remove `"lsdyna.manualViewer"` setting (which supported `"vscode"` and `"system"` values).
- Add `"lsdyna.sumatrapdfPath"` setting:
  ```json
  "lsdyna.sumatrapdfPath": {
      "type": "string",
      "default": "",
      "description": "Custom path to SumatraPDF.exe on Windows. If left blank, the extension will use the bundled version or automatically detect it from the system."
  }
  ```

## 3. Binary Placement
- Create a directory `bin/` under the workspace root.
- Place `SumatraPDF.exe` (sourced from the user's download directory `C:\Users\qyang\Downloads\SumatraPDF.exe`) into `bin/SumatraPDF.exe`.
- Update `.vscodeignore` to ensure the `bin/SumatraPDF.exe` is packaged for Windows, but exclude files or handle target-specific packaging if needed. (Note: For local verification, the binary must exist at `<workspace>/bin/SumatraPDF.exe`).

## 4. Execution Engine (`src/extension.js`)
We will implement an async function `resolveSumatraPath(context)` to locate the SumatraPDF executable.

### 4.1 Path Resolution Priority (`resolveSumatraPath`)
1. **User Custom Path**: Retrieve `lsdyna.sumatrapdfPath` config. If set and verified via `fs.existsSync`, return it.
2. **Bundled Binary**: Check `context.asAbsolutePath(path.join('bin', 'SumatraPDF.exe'))`. If exists, return it.
3. **Registry Query**: Run asynchronous `reg query` queries using `child_process.exec` to fetch the path registered under Windows App Paths:
   - `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\SumatraPDF.exe`
   - `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\SumatraPDF.exe`
   Parse stdout for `REG_SZ` path strings, expand environment variables, and check if it exists using `fs.existsSync`.
4. **Environment PATH Search**: Split `process.env.PATH` and check each directory for `SumatraPDF.exe`.
5. **Heuristic Search**: Search typical system path locations:
   - `C:\Program Files\SumatraPDF\SumatraPDF.exe`
   - `C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe`
   - `%LOCALAPPDATA%\SumatraPDF\SumatraPDF.exe`
   - `%APPDATA%\SumatraPDF\SumatraPDF.exe`

### 4.2 Spawning SumatraPDF
When opening a manual, if `process.platform === 'win32'`:
- Resolve path using `resolveSumatraPath(context)`.
- If found, spawn SumatraPDF using:
  ```javascript
  const child = child_process.spawn(exePath, args, {
      detached: true,
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: 'ignore'
  });
  child.unref();
  ```
- Command Arguments `args`:
  - `['-reuse-instance']` to reuse the existing SumatraPDF instance.
  - If `pageNum` is specified: `['-page', String(pageNum)]`.
  - The quoted PDF path: `['"' + pdfPath + '"']`.
- If spawning throws an error or no path is resolved, fall back to `openManualFallback(pdfPath, pageNum)`.

## 5. Fallback Mechanisms
- **Non-Windows Platforms**: Directly invoke `vscode.env.openExternal(vscode.Uri.file(pdfPath))`.
- **Windows Fallback (`openManualFallback`)**: Try opening using `cmd.exe /c start "" "${fileUrl}"` (which handles page parameter via standard default browser/viewer if it supports it), or fallback to `vscode.env.openExternal(vscode.Uri.file(pdfPath))` if that fails.

## 6. Licensing & Compliance
- SumatraPDF is GPLv3 licensed.
- Integrating it as an external binary launched purely via command line arguments constitutes "mere aggregation" under the GPL. The extension's own codebase does not link with or inherit the GPLv3 license.
- We must include SumatraPDF's license info and credits in the extension's documentation/README if necessary.
