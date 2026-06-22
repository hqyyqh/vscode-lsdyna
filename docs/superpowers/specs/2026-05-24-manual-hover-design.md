# LS-DYNA Keyword Manual Hover and Opener Design Spec

## 1. Goal

Provide an integrated hover action and document opening utility for LS-DYNA keyword manuals inside the VS Code editor:
1. Parse the PDF outline bookmarks dynamically during extension startup and map keywords to files and 1-based page numbers.
2. Render an inline PDF manual link at the bottom of the keyword hover card and field hover cards: `[$(book) 打开帮助文档 - Vol I (第 20 页)](command:extension.openManual?...)`.
3. Support opening the PDF at the precise page number in either the default OS-level PDF viewer/browser (with page parameter support on Windows) or via VS Code's built-in PDF viewer.

## 2. Proposed Design

### A. Manual Indexer
We will add a new file [manualIndexer.js](file:///d:/Project/vscode-lsdyna/src/core/manualIndexer.js) responsible for:
- Scanning the configured `lsdyna.manualsDir` directory.
- Resolving all `.pdf` files.
- Reading cached bookmark indexes from `context.workspaceState` to achieve instant startup.
- If a PDF's modification time (`mtimeMs`) has changed, or cache is missing:
  - Dynamically parsing the PDF outline (first locating `/Type/Catalog`, traversing `/Pages` tree to map Page objects to index numbers, and traversing `/Title` outline items).
  - Extracting bookmarks starting with `*` and mapping to page numbers.
  - Updating the cache in `workspaceState`.
- Generating an in-memory map of `keywordName` to `Array<{ file: string, page: number }>`.
- Indexing rules for keywords:
  - Split bookmark titles by `/` to handle combinations (e.g. `*EOS_001/*EOS_LINEAR_POLYNOMIAL`).
  - Clean keyword name: Trim spaces, strip `_TITLE` suffix, convert to uppercase, keep if it starts with `*`.

### B. Hover Provider Integration
In `LsdynaFieldHoverProvider.provideHover` in [extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js):
- Look up the hovered keyword (cleaned by stripping `_TITLE` suffix) in the manual index.
- If a match is found, append `\n\n---\n` followed by a list of markdown command links (one for each matched manual/volume):
  - Link text format: `$(book) 打开帮助文档 - [Volume Name] (第 [Page] 页)`
  - Link target: `command:extension.openManual` with parameters: `[fullPdfPath, pageNum]`
- Set `md.isTrusted = true` and `md.supportThemeIcons = true` on the returned Hover MarkdownString.

### C. Open Command
Register the command `extension.openManual` in [extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js):
- Checks user setting `lsdyna.manualViewer`.
- If `"vscode"`: Exec `vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdfPath))`.
- If `"system"`:
  - On Windows: Run `cmd.exe /c start "" "file:///absolute/path/to/manual.pdf#page=pageNum"` to open using default system viewer with page navigation.
  - On other platforms: Use `vscode.env.openExternal(vscode.Uri.file(pdfPath))`.

### D. Settings Defaults
Add configuration options in `package.json`:
- `lsdyna.manualsDir`: path to manuals, defaulting to `"LS-DYNA Manuals"`.
- `lsdyna.manualViewer`: defaults to `"system"` (choices: `"system"`, `"vscode"`).

---

## 3. Verification Plan

### Automated Tests
Add test cases in `test/extension.test.js`:
- Extracting bookmarks correctly from a small test PDF or mocked PDF data.
- Hover provider returns the command links with proper arguments when a keyword is queried.
- Manual link contains correct parameters.

### Manual Verification
- Verify PDF opening functionality on Windows to confirm Edge/Chrome/Acrobat opens the PDF at the correct page.
