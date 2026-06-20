# LS-DYNA PDF Manual Search & SumatraPDF Path Optimization Design

This spec outlines changes to the VS Code LS-DYNA extension's PDF manuals integration. It aims to eliminate copyright issues and large package sizes by removing bundled manuals and SumatraPDF.exe, prompting the user for local folder selection, and automatically indexing any PDF manual in the chosen directory.

## 1. Context and Goals
- **Goal**: Prevent large binaries (`SumatraPDF.exe`) and official PDF manuals from being packaged in the extension.
- **Goal**: Provide a seamless, automated configuration path using a folder picker.
- **Goal**: Auto-update indexed bookmark caches when PDF manual files inside the folder are added, updated, or removed.
- **Constraint**: Strictly limit `SumatraPDF.exe` lookup to the selected manuals directory on Windows. Disable automatic system-wide fallback search if the binary is missing in that specific folder (with graceful fallback to default OS PDF viewer).

---

## 2. Proposed Changes

### 2.1 Configuration (`package.json`)
- Remove `lsdyna.sumatrapdfPath` setting.
- Set default value of `lsdyna.manualsDir` to `""`.
- Register the `extension.configureManualsDir` command in `contributes.commands`.

### 2.2 SumatraPDF Path Resolution (`src/extension.js`)
- Refactor `resolveSumatraPath(context)` to resolve `SumatraPDF.exe` strictly relative to the resolved `lsdyna.manualsDir` path. Return `null` if not found in that folder.

### 2.3 Directory Selection Dialog (`src/extension.js`)
- Implement `extension.configureManualsDir` which calls `vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false })`.
- Write the selected path to the config (Workspace or Global).
- Run warning alert check on Windows if `SumatraPDF.exe` is missing in that folder.
- Re-run `manualIndexer.initialize(context)`.

### 2.4 Hover Card Enhancements (`src/extension.js`)
- Modify `appendManualLinks(md, kwName)`:
  - If `manualsDir` is empty/not configured, show a helper card with link to choose the folder:
    `[⚙️ 设置手册文件�?(Configure Folder)](command:extension.configureManualsDir)`
  - If manuals are configured and loaded, render bookmark links, and append an edit button:
    `[$(edit) 修改手册路径 (Change Path)](command:extension.configureManualsDir)`
- In `provideHover`, enable hover triggers on keyword lines even if they have no pre-defined card fields (allowing the user to open manuals for unknown keywords).

### 2.5 Active File Watcher and Re-indexing (`src/core/manualIndexer.js`)
- Expose `getManualFilesCount()` from `manualIndexer` to check if manuals are loaded.
- In `initialize(context)`, set up a directory watcher using `fs.watch` on the configured manual directory.
- Watch for `.pdf` file additions, removals, or updates. Debounce directory changes with a 1-second delay before triggering re-initialization.

---

## 3. Verification Plan
- **Manual Verification**:
  1. Clear the manuals setting (`manualsDir` = `""`) and verify that hovering on keywords shows the "LS-DYNA Manuals not configured" alert.
  2. Click the configuration button in the hover card, select a manuals folder (without SumatraPDF.exe on Windows), verify the warning shows, and check if it fallbacks to opening PDFs via the default system browser.
  3. Copy `SumatraPDF.exe` into that manuals folder and verify precise page-level jumps work.
  4. Drop a new PDF file into the folder and verify that the file watcher automatically parses it and registers new keyword mappings.
